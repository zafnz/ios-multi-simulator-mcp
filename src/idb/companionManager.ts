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
  /**
   * Identifies this particular companion instance, not just its simulator.
   *
   * Without it a caller recovering from a dead channel can only say "shut down
   * the companion for this udid", which may by then be a healthy replacement
   * someone else just started — killing it mid-call.
   */
  generation: number;
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
  /**
   * Simulators that are being torn down. Recovery must not spawn a companion
   * for a simulator that is about to be deleted: the spawn can win the race
   * against `simctl delete` and leave a companion attached to nothing.
   */
  private closed = new Set<string>();
  /** Monotonic, so every spawned companion is distinguishable from every other. */
  private nextGeneration = 1;
  private exitHookInstalled = false;

  /**
   * Runs `fn` against a live companion for `udid`, spawning one if needed.
   *
   * A companion can go away underneath us at any time: --idle-shutdown-time is
   * meant to reap it, and an agent that pauses between calls hits that as the
   * normal path rather than an edge case. So for a read, a dead channel is
   * recovered by respawning and retrying once rather than surfaced.
   *
   * Exclusive calls are NOT retried. They are the input paths, and `fn` there
   * is not idempotent: a `hid` stream that dies after delivering half its
   * events would, on replay, deliver those events a second time — typing
   * "hello wohello world", or turning a two-tap into five taps. A failed write
   * is reported so the caller can decide, rather than silently doubled.
   */
  async withClient<T>(
    udid: string,
    fn: (client: IdbClient) => Promise<T>,
    options: WithClientOptions = {}
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const companion = await this.companionFor(udid);
      try {
        return await fn(companion.client);
      } catch (error) {
        if (options.exclusive) throw error;
        if (!this.isDeadChannel(companion, error)) throw error;
        // Retire only the instance that failed. Naming the udid here would let
        // two concurrent recoveries execute each other's fresh companion, and
        // the second retry would then fail for real.
        await this.retire(companion);
        const revived = await this.companionFor(udid);
        return await fn(revived.client);
      }
    };
    return options.exclusive ? this.exclusively(udid, run) : run();
  }

  /** Live companion for `udid`, spawning or replacing a dead one as needed. */
  private async companionFor(udid: string): Promise<Companion> {
    if (this.closed.has(udid)) {
      throw new IdbError(
        `Simulator ${udid} is being shut down, so no companion will be started for it.`
      );
    }

    const existing = this.companions.get(udid);
    if (existing && !existing.exited && existing.child.exitCode === null) {
      return existing;
    }
    if (existing) await this.retire(existing);

    const inFlight = this.spawning.get(udid);
    if (inFlight) return await inFlight;

    const pending = this.spawn(udid).finally(() => this.spawning.delete(udid));
    this.spawning.set(udid, pending);
    return await pending;
  }

  /**
   * True when the failure means the companion is gone rather than the request
   * being bad — the retry-worthy case.
   */
  private isDeadChannel(companion: Companion, error: unknown): boolean {
    // Asks about the instance the call actually used, not whatever is currently
    // registered for the udid — which may already be a replacement.
    if (companion.exited || companion.child.exitCode !== null) return true;
    const code = (error as IdbError)?.code;
    return (
      code === grpc.status.UNAVAILABLE || code === grpc.status.DEADLINE_EXCEEDED
    );
  }

  /** Chains `fn` after any other exclusive work for this simulator. */
  private exclusively<T>(udid: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(udid) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    // The chain must survive a rejection, or one failed call would poison every
    // later one. Store the swallowed form, and compare against that same
    // reference when dropping the tail — comparing against `next` never matches,
    // which would retain one entry per udid forever.
    const tail = next.catch(() => undefined);
    this.locks.set(udid, tail);
    void tail.then(() => {
      if (this.locks.get(udid) === tail) this.locks.delete(udid);
    });
    return next;
  }

  private async spawn(udid: string): Promise<Companion> {
    this.installExitHook();

    const generation = this.nextGeneration++;

    const dir = socketDir();
    // The pid separates two of our own processes; the generation separates one
    // spawn from the next. Without the generation every respawn reuses one
    // path, and a companion that is still dying unlinks the socket its
    // replacement has just bound.
    const socketPath = path.join(
      dir,
      `${udid}.${process.pid}.${generation}.sock`
    );
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
      generation,
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
      // A companion killed from outside never goes through retire(), so this is
      // the only place its socket gets cleaned up. Without it the directory
      // accumulates one dead socket per respawn. Safe because the path is
      // unique to this instance.
      try {
        fs.unlinkSync(companion.socketPath);
      } catch {
        // Already gone, which is the normal case for a clean exit.
      }
    });

    try {
      await companion.client.waitForReady();
    } catch (error) {
      // Publishing before this point would leave a running, registered
      // companion that never connected: clientFor would hand it out again
      // (it has not exited), and nothing would ever kill it.
      companion.client.close();
      child.kill("SIGKILL");
      throw error;
    }

    this.companions.set(udid, companion);
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
          // The companion can emit single lines thousands of characters long
          // (it dumps every known target on a resolution failure). Truncate
          // per line, or this error becomes a wall of text in the client.
          const detail = stderrTail.length
            ? `\nLast companion output:\n  ${stderrTail
                .slice(-5)
                .map((line) =>
                  line.length > 300 ? `${line.slice(0, 300)}… (truncated)` : line
                )
                .join("\n  ")}`
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

  /**
   * Stops one specific companion.
   *
   * Deregisters it only if it is still the current one for its simulator, so a
   * late retirement cannot evict a replacement that has taken its place. Its
   * socket path is unique to this instance, so unlinking cannot disturb one.
   */
  private async retire(companion: Companion): Promise<void> {
    if (this.companions.get(companion.udid) === companion) {
      this.companions.delete(companion.udid);
    }

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

  /** Stops whatever companion is currently running for `udid`, if any. */
  async shutdown(udid: string): Promise<void> {
    // A spawn in flight has not registered yet, so shutting down without
    // waiting for it would be a no-op that leaves an orphan moments later --
    // and would silently skip the restart in the empty-tree recovery.
    const inFlight = this.spawning.get(udid);
    if (inFlight) {
      await inFlight.catch(() => undefined);
    }

    const companion = this.companions.get(udid);
    if (!companion) return;
    await this.retire(companion);
  }

  /**
   * Stops the companion and refuses to start another until `reopen`.
   *
   * `destroy_simulator` needs this: it shuts the companion down and then spends
   * seconds in `simctl shutdown`/`delete`, and a concurrent call for the same
   * simulator would otherwise see its channel die and helpfully spawn a
   * replacement attached to a simulator that is about to stop existing.
   */
  async close(udid: string): Promise<void> {
    this.closed.add(udid);
    await this.shutdown(udid);
  }

  /** Allows companions for `udid` again, after a `close`. */
  reopen(udid: string): void {
    this.closed.delete(udid);
  }

  async shutdownAll(): Promise<void> {
    await Promise.all([...this.companions.keys()].map((u) => this.shutdown(u)));
  }

  /** Companions we currently have running. Diagnostics only. */
  running(): string[] {
    return [...this.companions.keys()];
  }

  /**
   * Last-resort reaping if the process goes down without `shutdownAll`.
   *
   * Only the 'exit' hook, deliberately. It is tempting to also catch SIGINT and
   * SIGTERM here, but the server installs its own async handlers for those to
   * delete the simulators it created; a second handler calling process.exit()
   * would run while that one was suspended at its first await and kill it
   * mid-flight, leaking every simulator instead. 'exit' fires after those
   * handlers complete, and covers the paths that never reach them.
   *
   * Synchronous, because an 'exit' handler cannot await.
   */
  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;

    process.on("exit", () => {
      for (const companion of this.companions.values()) {
        try {
          if (!companion.exited) companion.child.kill("SIGKILL");
          fs.unlinkSync(companion.socketPath);
        } catch {
          // Exiting anyway.
        }
      }
    });
  }
}

/**
 * The one manager for this process. Import this, never construct your own:
 * a second instance would spawn a second companion per simulator and leak it.
 */
export const companions = new CompanionManager();
