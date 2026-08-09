/**
 * Owns idb_companion processes: one per simulator, spawned by us, in our own
 * directory, and reaped by us.
 *
 * Two boundaries here are load-bearing. The companions we talk to are ones we
 * spawned and recorded, and our sockets live in our own directory — we never
 * read, write or enumerate /tmp/idb, which brew's companion and the Python idb
 * client share deliberately. A user's own idb keeps working alongside this.
 *
 * This must be a process-level singleton. HTTP mode builds a fresh McpServer per
 * request, so anything hung off the server instance would spawn a new companion
 * per request and leak every one of them.
 */

import { ChildProcess, spawn } from "child_process";
import * as grpc from "@grpc/grpc-js";
import fs from "fs";
import path from "path";
import { IdbClient, IdbError } from "./client";
import { resolveCompanion } from "./companionBinary";

/** Companions take ~0.5s to bind; a cold simulator can take considerably longer. */
const READY_TIMEOUT_MS = 30_000;

/** Kept only to make a spawn failure diagnosable. */
const STDERR_KEEP_LINES = 20;

/** sockaddr_un.sun_path is 104 bytes on macOS, including the terminator. */
const SUN_PATH_MAX = 104;

/**
 * How long a companion may sit idle before shutting itself down. Long enough
 * not to churn during a working session, short enough that a companion orphaned
 * by a hard kill does not live forever.
 */
const IDLE_SHUTDOWN_SECONDS = 3600;

/**
 * Where log lines about acquiring the companion go. stdout is the MCP transport
 * in stdio mode, so this must never write there.
 */
function log(message: string): void {
  process.stderr.write(`[ios-simulator-mcp] ${message}\n`);
}

/**
 * Our socket directory, created 0700 and confirmed to be ours.
 *
 * /tmp is world-writable, so a pre-created directory or a symlink pointing
 * somewhere else must never be adopted. Sockets live here rather than under the
 * cache dir because a cache path plus a 36-char udid overruns sun_path.
 */
function socketDir(): string {
  const dir = `/tmp/imsm-${process.getuid?.() ?? 0}`;
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });

  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new IdbError(`${dir} exists but is not a directory we can trust`);
  }
  if (st.uid !== (process.getuid?.() ?? 0)) {
    throw new IdbError(`${dir} is owned by uid ${st.uid}, not by us`);
  }
  if (st.mode & 0o077) fs.chmodSync(dir, 0o700);
  return dir;
}

type Companion = {
  udid: string;
  child: ChildProcess;
  client: IdbClient;
  socketPath: string;
  /** Set the moment the child exits, so a stale entry is never handed out. */
  exited: boolean;
  stderrTail: string[];
};

export type WithClientOptions = {
  /**
   * Serializes this call against other exclusive calls for the same simulator.
   * Input events and recording control need it: two interleaved hid streams
   * scramble a swipe, and two clients can otherwise race record start/stop.
   * Reads are left concurrent so a held-open stream can't block them.
   */
  exclusive?: boolean;
};

export class CompanionManager {
  private companions = new Map<string, Companion>();
  /** In-flight spawns, so concurrent callers for a cold udid share one. */
  private spawning = new Map<string, Promise<Companion>>();
  /** Tail of the exclusive-call chain per udid. */
  private locks = new Map<string, Promise<unknown>>();
  private exitHookInstalled = false;

  /**
   * Runs `fn` against a live companion for `udid`, spawning one if needed.
   *
   * A companion can go away underneath us at any time: --idle-shutdown-time is
   * meant to reap it, and an agent that pauses between calls hits that as the
   * normal path rather than an edge case. So a dead channel is recovered by
   * respawning and retrying once, rather than surfaced to the caller.
   */
  async withClient<T>(
    udid: string,
    fn: (client: IdbClient) => Promise<T>,
    options: WithClientOptions = {}
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const client = await this.clientFor(udid);
      try {
        return await fn(client);
      } catch (error) {
        if (!this.isDeadChannel(udid, error)) throw error;
        await this.shutdown(udid);
        const revived = await this.clientFor(udid);
        return await fn(revived);
      }
    };
    return options.exclusive ? this.exclusively(udid, run) : run();
  }

  /** Live client for `udid`, spawning or replacing a dead companion as needed. */
  private async clientFor(udid: string): Promise<IdbClient> {
    const existing = this.companions.get(udid);
    if (existing && !existing.exited && existing.child.exitCode === null) {
      return existing.client;
    }
    if (existing) await this.shutdown(udid);

    const inFlight = this.spawning.get(udid);
    if (inFlight) return (await inFlight).client;

    const pending = this.spawn(udid).finally(() => this.spawning.delete(udid));
    this.spawning.set(udid, pending);
    return (await pending).client;
  }

  /**
   * True when the failure means the companion is gone rather than the request
   * being bad — the retry-worthy case.
   */
  private isDeadChannel(udid: string, error: unknown): boolean {
    const companion = this.companions.get(udid);
    if (companion?.exited || companion?.child.exitCode !== null) return true;
    const code = (error as IdbError)?.code;
    return (
      code === grpc.status.UNAVAILABLE || code === grpc.status.DEADLINE_EXCEEDED
    );
  }

  /** Chains `fn` after any other exclusive work for this simulator. */
  private exclusively<T>(udid: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(udid) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    // Keep the chain alive on failure, and drop it once this is the tail.
    this.locks.set(
      udid,
      next.catch(() => undefined)
    );
    void next.catch(() => undefined).then(() => {
      if (this.locks.get(udid) === next) this.locks.delete(udid);
    });
    return next;
  }

  private async spawn(udid: string): Promise<Companion> {
    this.installExitHook();

    const dir = socketDir();
    // The pid keeps two of our own processes serving the same simulator from
    // colliding on one socket.
    const socketPath = path.join(dir, `${udid}.${process.pid}.sock`);
    if (Buffer.byteLength(socketPath) >= SUN_PATH_MAX) {
      throw new IdbError(
        `Socket path is ${Buffer.byteLength(socketPath)} bytes, over the ${SUN_PATH_MAX}-byte limit: ${socketPath}`
      );
    }
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Nothing there, which is the normal case.
    }

    // Lazily acquired: the download happens on the first call that actually
    // needs a companion, not at startup.
    const binary = await resolveCompanion(log);
    const child = spawn(
      binary,
      [
        "--udid",
        udid,
        "--grpc-domain-sock",
        socketPath,
        // A backstop against leaking companions if we are killed without our
        // exit hook running. Only newer companions implement it; brew's 1.1.8
        // parses argv leniently and ignores it, so it is safe to always pass.
        // We respawn on a dead channel, so an idle shutdown is invisible.
        "--idle-shutdown-time",
        String(IDLE_SHUTDOWN_SECONDS),
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    const stderrTail: string[] = [];
    const companion: Companion = {
      udid,
      child,
      client: undefined as unknown as IdbClient,
      socketPath,
      exited: false,
      stderrTail,
    };

    // Both pipes must be drained for the child's whole life. An unread pipe
    // fills at 64KB and blocks the companion mid-write, which shows up much
    // later as an unexplained hang.
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        stderrTail.push(line);
        if (stderrTail.length > STDERR_KEEP_LINES) stderrTail.shift();
      }
    });

    const grpcPath = await this.awaitReadiness(companion, binary);

    companion.client = new IdbClient(grpcPath);
    child.on("exit", () => {
      companion.exited = true;
      // Only drop it if it is still the current entry; a respawn may have
      // already replaced it.
      if (this.companions.get(udid) === companion) this.companions.delete(udid);
      try {
        companion.client?.close();
      } catch {
        // Closing a channel to a dead process is not interesting.
      }
    });

    this.companions.set(udid, companion);
    await companion.client.waitForReady();
    return companion;
  }

  /**
   * Resolves the socket path the companion reports on stdout once it is bound.
   * Waiting for that line rather than polling the socket removes the bind race.
   */
  private awaitReadiness(
    companion: Companion,
    binary: string
  ): Promise<string> {
    const { child, udid, stderrTail } = companion;
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let buffer = "";

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const fail = (reason: string) =>
        finish(() => {
          child.kill("SIGKILL");
          const detail = stderrTail.length
            ? `\nLast companion output:\n  ${stderrTail.slice(-5).join("\n  ")}`
            : "";
          reject(
            new IdbError(
              `Could not start ${binary} for simulator ${udid}: ${reason}${detail}`
            )
          );
        });

      const timer = setTimeout(
        () => fail(`no socket reported within ${READY_TIMEOUT_MS}ms`),
        READY_TIMEOUT_MS
      );

      child.stdout?.setEncoding("utf-8");
      child.stdout?.on("data", (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          // The readiness report is not guaranteed to be the first line.
          let reported: unknown;
          try {
            reported = JSON.parse(line);
          } catch {
            continue;
          }
          const grpcPath = (reported as { grpc_path?: string })?.grpc_path;
          if (grpcPath) {
            finish(() => resolve(grpcPath));
            return;
          }
        }
      });

      child.on("error", (error) =>
        fail(
          error.message.includes("ENOENT")
            ? `${binary} could not be executed. If it was removed from the cache, ` +
              `deleting the cache directory forces a fresh download; otherwise ` +
              `point IOS_SIMULATOR_MCP_COMPANION_PATH at a companion binary.`
            : error.message
        )
      );
      child.on("exit", (code, signal) =>
        fail(`it exited with ${signal ?? `code ${code}`} before binding`)
      );
    });
  }

  /** Stops the companion for `udid`, if we started one. */
  async shutdown(udid: string): Promise<void> {
    const companion = this.companions.get(udid);
    if (!companion) return;
    this.companions.delete(udid);

    try {
      companion.client?.close();
    } catch {
      // Best effort: we are tearing this down anyway.
    }

    if (companion.child.exitCode === null && !companion.exited) {
      companion.child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          companion.child.kill("SIGKILL");
          resolve();
        }, 3000);
        companion.child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    try {
      fs.unlinkSync(companion.socketPath);
    } catch {
      // The companion unlinks its own socket on a clean exit.
    }
  }

  async shutdownAll(): Promise<void> {
    await Promise.all([...this.companions.keys()].map((u) => this.shutdown(u)));
  }

  /** Companions we currently have running. Diagnostics only. */
  running(): string[] {
    return [...this.companions.keys()];
  }

  /**
   * Kills our companions if the process goes down. Synchronous, because an
   * 'exit' handler cannot await — anything asynchronous here would not run.
   */
  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;

    const killAll = () => {
      for (const companion of this.companions.values()) {
        try {
          if (!companion.exited) companion.child.kill("SIGKILL");
          fs.unlinkSync(companion.socketPath);
        } catch {
          // Exiting anyway.
        }
      }
    };

    process.on("exit", killAll);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(signal, () => {
        killAll();
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    }
  }
}

/**
 * The one manager for this process. Import this, never construct your own:
 * a second instance would spawn a second companion per simulator and leak it.
 */
export const companions = new CompanionManager();
