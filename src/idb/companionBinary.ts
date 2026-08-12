/**
 * Resolves the `idb_companion` binary this server runs.
 *
 * The companion is downloaded once from a URL and hash pinned in
 * `companion.lock.json`, then cached. There is deliberately no discovery: no
 * GitHub API call, no version negotiation, no `$PATH` lookup. A pinned URL and
 * a pinned hash cannot drift, rate-limit, or quietly hand us a different build.
 *
 * Falling back to a companion on `$PATH` would be worse than failing. Protobuf
 * compatibility means an older companion does not reject fields it does not
 * understand — it ignores them and answers anyway. A `marker` lookup against
 * the 2022 build returns the whole tree instead of the element asked for, and
 * `keys` returns everything. The result is wrong but entirely plausible, which
 * is the failure mode this design exists to avoid.
 */

import { execFile, spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import https from "https";
import http from "http";
import os from "os";
import path from "path";
import { promisify } from "util";
import { IdbError } from "./client";

const execFileAsync = promisify(execFile);

export type CompanionLock = {
  idbSha: string;
  xcode: string;
  swift: string;
  arch: string;
  url: string;
  sha256: string;
  bytes: number;
  builtAt: string;
};

/** Redirect hops to follow. Release URLs bounce to a storage host. */
const MAX_REDIRECTS = 5;

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * True on Apple Silicon, including an x64 Node running under Rosetta.
 *
 * `process.arch` describes the Node build, not the machine: it reads "x64"
 * under Rosetta on a machine that runs arm64 binaries perfectly well. Gating on
 * it would refuse working Macs.
 */
function isAppleSilicon(): boolean {
  if (process.platform !== "darwin") return false;
  const probe = spawnSync("sysctl", ["-n", "hw.optional.arm64"], {
    encoding: "utf-8",
  });
  return probe.status === 0 && probe.stdout.trim() === "1";
}

/** Where downloaded companions live. Ours alone; never `/usr/local/bin`. */
export function cacheRoot(): string {
  const override = process.env.IOS_SIMULATOR_MCP_COMPANION_CACHE;
  if (override) return expandTilde(override);
  if (process.env.XDG_CACHE_HOME) {
    return path.join(process.env.XDG_CACHE_HOME, "ios-multi-simulator-mcp");
  }
  return path.join(os.homedir(), "Library", "Caches", "ios-multi-simulator-mcp");
}

function expandTilde(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/** The package root, from the compiled build/idb/companionBinary.js. */
function packageRoot(): string {
  return path.join(__dirname, "..", "..");
}

/**
 * A companion built from the vendored submodule, if there is one.
 *
 * This is the developer path: `cd vendor/idb && ./build.sh build` leaves its
 * output here, and it is exactly the sha the submodule is pinned to, so it is
 * the same binary the lock file would fetch. Absent in an installed package,
 * which has no vendor directory.
 */
function locallyBuiltCompanion(): string | undefined {
  const built = path.join(
    packageRoot(),
    "vendor",
    "idb",
    "Build",
    "Distribution",
    "idb_companion"
  );
  return isUsable(built) ? built : undefined;
}

/** Reads the lock file shipped alongside the compiled server. */
export function readLock(): CompanionLock {
  const lockPath = path.join(packageRoot(), "companion.lock.json");
  if (!fs.existsSync(lockPath)) {
    throw new IdbError(
      `No companion.lock.json found at ${lockPath}, so there is no pinned ` +
        `idb_companion to download. Point IOS_SIMULATOR_MCP_COMPANION_PATH at ` +
        `an idb_companion binary, or build one with the build-companion workflow.`
    );
  }
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf-8")) as CompanionLock;
  } catch (error) {
    throw new IdbError(
      `companion.lock.json at ${lockPath} is not readable JSON: ${(error as Error).message}`
    );
  }
}

/** In-flight resolution, so concurrent callers share one download. */
let pending: Promise<string> | undefined;

/**
 * Absolute path to a usable `idb_companion`, downloading it if necessary.
 *
 * Call this lazily, on the first request that actually needs a companion —
 * never at startup — so listing tools or driving simctl never pays for a
 * download.
 */
export function resolveCompanion(
  log: (message: string) => void = () => {}
): Promise<string> {
  if (!pending) {
    pending = resolveOnce(log).catch((error) => {
      // Don't cache a failure: a transient network error should not poison the
      // process for its whole life.
      pending = undefined;
      throw error;
    });
  }
  // Nor should a success outlive the file it points at. Clearing the cache is
  // advice we give in an error message, so a long-running server must notice
  // the binary has gone and fetch it again rather than handing out a path that
  // no longer exists until it is restarted.
  return pending.then((binary) => {
    if (isUsable(binary)) return binary;
    pending = undefined;
    return resolveCompanion(log);
  });
}

async function resolveOnce(log: (message: string) => void): Promise<string> {
  const override = process.env.IOS_SIMULATOR_MCP_COMPANION_PATH;
  if (override) {
    const expanded = expandTilde(override);
    if (!fs.existsSync(expanded)) {
      throw new IdbError(
        `IOS_SIMULATOR_MCP_COMPANION_PATH points at a file that does not exist: ${expanded}`
      );
    }
    return expanded;
  }

  if (!isAppleSilicon()) {
    throw new IdbError(
      `The bundled idb_companion is built for Apple Silicon (arm64) only, and ` +
        `this machine is not. Intel Macs are not supported: build idb_companion ` +
        `yourself and point IOS_SIMULATOR_MCP_COMPANION_PATH at it.`
    );
  }

  // Prefer a companion built from the pinned submodule over downloading one.
  // It is the same sha, so this is not a compatibility compromise -- it just
  // saves a developer who has already built it from fetching it again.
  const local = locallyBuiltCompanion();
  if (local) {
    log(`Using locally built idb_companion from ${path.relative(packageRoot(), local)}`);
    return local;
  }

  const lock = readLock();
  // Keyed by content hash, not version, so a changed lock is simply a different
  // directory. Rollback and multi-version coexistence come free, and a
  // half-written tree can never be mistaken for a complete one.
  const installDir = path.join(cacheRoot(), "companion", lock.sha256);
  const binary = path.join(installDir, "idb_companion");

  if (isUsable(binary)) return binary;

  await download(lock, installDir, log);

  if (!isUsable(binary)) {
    throw new IdbError(
      `Downloaded companion is missing or not executable at ${binary}.`
    );
  }
  return binary;
}

function isUsable(binary: string): boolean {
  try {
    fs.accessSync(binary, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function download(
  lock: CompanionLock,
  installDir: string,
  log: (message: string) => void
): Promise<void> {
  const tmpRoot = path.join(cacheRoot(), "tmp");
  fs.mkdirSync(tmpRoot, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(tmpRoot, "companion-"));
  const tarball = path.join(scratch, "companion.tar.gz");

  const megabytes = (lock.bytes / 1_000_000).toFixed(0);
  log(
    `Downloading idb_companion (${megabytes} MB, idb ${lock.idbSha.slice(0, 7)}). ` +
      `This happens once; it is cached afterwards.`
  );

  try {
    const actualSha = await fetchToFile(lock.url, tarball);
    if (actualSha !== lock.sha256) {
      throw new IdbError(
        `Checksum mismatch for ${lock.url}\n` +
          `  expected ${lock.sha256}\n` +
          `  actual   ${actualSha}\n` +
          `Refusing to run it. The download was corrupted, or the published ` +
          `artifact does not match companion.lock.json.`
      );
    }

    const extracted = path.join(scratch, "tree");
    fs.mkdirSync(extracted, { recursive: true });
    await execFileAsync("tar", ["xzf", tarball, "-C", extracted]);
    fs.unlinkSync(tarball);

    const binary = path.join(extracted, "idb_companion");
    if (!fs.existsSync(binary)) {
      throw new IdbError(
        `The archive at ${lock.url} does not contain idb_companion at its root.`
      );
    }
    fs.chmodSync(binary, 0o755);

    // Prove it runs before letting anything else find it in the cache. A
    // companion that cannot start should fail here, once, with a clear message
    // rather than on every later call.
    await smokeTest(binary);

    fs.mkdirSync(path.dirname(installDir), { recursive: true });
    try {
      // Atomic: nothing ever observes a partially extracted tree under
      // installDir. Two processes may race here; one wins the rename and the
      // loser finds a complete, verified tree already in place.
      fs.renameSync(extracted, installDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const lostRace = code === "ENOTEMPTY" || code === "EEXIST";
      if (!lostRace || !isUsable(path.join(installDir, "idb_companion"))) {
        throw error;
      }
    }
    log(`idb_companion ready at ${installDir}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function smokeTest(binary: string): Promise<void> {
  try {
    await execFileAsync(binary, ["--version"], { timeout: 30_000 });
  } catch (error) {
    const detail = (error as Error).message;
    throw new IdbError(
      `The downloaded idb_companion could not run: ${detail}\n` +
        `If macOS blocked it, check for a quarantine attribute with ` +
        `\`xattr -l ${binary}\`; \`xattr -dr com.apple.quarantine ${binary}\` clears it.`
    );
  }
}

/** Streams `url` to `destination`, following redirects. Returns its sha256. */
function fetchToFile(url: string, destination: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const file = fs.createWriteStream(destination);
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      file.destroy();
      reject(error instanceof IdbError ? error : new IdbError(error.message));
    };

    const get = (target: string, redirectsLeft: number) => {
      // A malformed Location, or one with a protocol we cannot speak, must
      // reject rather than throw: this runs inside a response handler, where an
      // exception escapes the promise entirely and takes the process with it.
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        fail(new IdbError(`Not a valid URL: ${target}`));
        return;
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        fail(
          new IdbError(
            `Refusing to fetch ${target}: only http and https are supported.`
          )
        );
        return;
      }

      const client = parsed.protocol === "http:" ? http : https;
      const request = client.get(
        target,
        { headers: { "user-agent": "ios-multi-simulator-mcp" } },
        (response) => {
          const status = response.statusCode ?? 0;

          if (status >= 300 && status < 400 && response.headers.location) {
            response.resume();
            if (redirectsLeft === 0) {
              fail(new IdbError(`Too many redirects fetching ${url}`));
              return;
            }
            let next: string;
            try {
              next = new URL(response.headers.location, target).toString();
            } catch {
              fail(
                new IdbError(
                  `Server redirected ${target} to an unusable location: ${response.headers.location}`
                )
              );
              return;
            }
            get(next, redirectsLeft - 1);
            return;
          }

          if (status !== 200) {
            response.resume();
            fail(
              new IdbError(
                `Downloading ${url} failed with HTTP ${status}. The release asset ` +
                  `named in companion.lock.json may have been moved or deleted.`
              )
            );
            return;
          }

          response.on("data", (chunk: Buffer) => hash.update(chunk));
          response.pipe(file);
          response.on("error", fail);
          file.on("error", fail);
          file.on("finish", () => {
            if (settled) return;
            settled = true;
            resolve(hash.digest("hex"));
          });
        }
      );

      request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
        request.destroy();
        fail(new IdbError(`Timed out downloading ${url}`));
      });
      request.on("error", fail);
    };

    get(url, MAX_REDIRECTS);
  });
}
