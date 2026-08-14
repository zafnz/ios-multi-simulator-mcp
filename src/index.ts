#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import path from "path";
import os from "os";
import fs from "fs";
import http from "http";
import { companions } from "./idb/companionManager";
import { Backend, Format, SearchableKey } from "./idb/client";
import {
  AXElement,
  DESCRIBE_KEYS,
  canonicalise,
  centreOf,
  collectProbeCandidates,
  isDegenerateTree,
  matchInTree,
  pruneTree,
  uniquelyLabelled,
} from "./ax/tree";
import {
  Orientation,
  candidateOrientations,
  getEffectiveOrientation,
  transformPointToPortrait,
} from "./ax/orientation";
import { isWedgeError, shouldRecover } from "./ax/recovery";

const execFileAsync = promisify(execFile);

const PACKAGE_VERSION: string = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8")
).version;

const TMP_ROOT_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "ios-simulator-mcp-")
);

/**
 * Runs a command with arguments and returns the stdout and stderr
 * @param cmd - The command to run
 * @param args - The arguments to pass to the command
 * @returns The stdout and stderr of the command
 */
async function run(
  cmd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(cmd, args, { shell: false });
  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

// The Python `idb` CLI is gone: we speak gRPC to idb_companion directly. This
// variable used to point at that CLI, so it now silently does nothing — better
// to say so than to let someone believe a custom idb is in use.
if (process.env.IOS_SIMULATOR_MCP_IDB_PATH) {
  throw new Error(
    "IOS_SIMULATOR_MCP_IDB_PATH is no longer supported: this server talks to " +
      "idb_companion directly and never runs the `idb` CLI. Unset it, or use " +
      "IOS_SIMULATOR_MCP_COMPANION_PATH to point at a specific idb_companion binary."
  );
}

/**
 * The accessibility tree for the whole screen, in the same nested shape the
 * `idb` CLI used to print.
 *
 * A companion that has been up for a while can wedge into serving a 0x0 tree
 * for a simulator that is perfectly healthy — a freshly spawned companion
 * serves the same simulator correctly at the same moment. Since we own the
 * companion, the cure is to restart it and ask again, which the caller never
 * sees. That used to require recreating the simulator and losing its apps.
 *
 * An empty tree that survives that restart is the *guest* side of the same
 * symptom, and the cure there is to restart the simulator's bridge — so both
 * are tried before anyone sees a failure. `withAccessibilityRecovery` covers
 * the third shape, where the read throws instead of returning nothing.
 */
async function describeAll(udid: string): Promise<AXElement[]> {
  const read = () =>
    companions.withClient(udid, async (client) => {
      const info = await client.accessibilityInfo({ format: Format.NESTED });
      // An empty read comes back as JSON null, which must not become [null] --
      // that reads as a one-element tree and would be returned as a success.
      if (info == null) return [] as AXElement[];
      return (Array.isArray(info) ? info : [info]) as AXElement[];
    });

  const usable = (elements: AXElement[]) => {
    if (isDegenerateTree(elements)) return false;
    markAccessibilityAnswered(udid);
    return true;
  };

  return withAccessibilityRecovery(udid, async () => {
    let elements = await read();
    if (usable(elements)) return elements;

    await companions.shutdown(udid);
    elements = await read();
    if (usable(elements)) return elements;

    // Only for a simulator that has answered before; a fresh one is booting.
    if (
      hasAnsweredAccessibility.has(udid) &&
      (await recoverWedgedAccessibility(udid))
    ) {
      elements = await read();
      usable(elements);
    }
    return elements;
  });
}

/**
 * The screen as a caller should see it: the complete tree, pruned.
 *
 * Separate from `describeAll` because the two want opposite things. Callers
 * that only need the root frame — orientation, screen dimensions, ui_view —
 * are served by the cheap read in ~13ms, and making them pay for this one
 * would be a sixfold regression for a rectangle they already had.
 *
 * AXBridge, because the default backend does not return a usable screen: tab
 * bars, nav bars and toolbars arrive as containers with no children, so their
 * controls are absent from the tree entirely even though they are on screen
 * and tappable. That is worth ~300ms and a larger payload, because the cheaper
 * answer is wrong in a way a caller cannot detect.
 */
async function describeScreen(udid: string): Promise<AXElement[]> {
  const elements = await withAccessibilityRecovery(udid, () =>
    companions.withClient(udid, async (client) => {
      const read = async (backend?: Backend, keys?: string[]) => {
        const info = await client.accessibilityInfo({
          format: Format.NESTED,
          backend,
          keys,
        });
        if (info == null) return [] as AXElement[];
        return (Array.isArray(info) ? info : [info]) as AXElement[];
      };

      try {
        return await read(Backend.AXBRIDGE, DESCRIBE_KEYS);
      } catch {
        // A companion older than the one this server pins cannot start AXBridge.
        // An incomplete tree beats no tree, so fall back rather than fail.
        return await read();
      }
    })
  );

  if (!isDegenerateTree(elements)) markAccessibilityAnswered(udid);
  return pruneTree(elements);
}

/**
 * Resolves a single element by the text a caller knows it by.
 *
 * Cheap path first: the companion matches a marker server-side and returns just
 * that element, roughly half a kilobyte against several for a whole tree, in
 * ~13ms. Most lookups end there.
 *
 * When it misses, the fallback reads the screen and matches here. That covers
 * three separate failures the marker query cannot:
 *
 *  - Apple's translator omits whole containers, so a control in a tab bar, nav
 *    bar or toolbar is absent from the tree the marker query searches even
 *    though it carries the label and hit-tests fine. `describeScreen` reads the
 *    app's real view hierarchy instead.
 *  - The match is on `AXLabel` only, but a control's visible text is not always
 *    its label — search fields in particular have a null label and their text
 *    in `AXValue`, making them unnameable.
 *  - The match is exact, so a caller's ASCII apostrophe never finds iOS's
 *    typographic one.
 *
 * One fallback rather than a chain of marker retries: it is a single round trip
 * (~350ms against ~300ms for another marker query), and matching here means the
 * comparison is ours to fix rather than the companion's to be exact about.
 *
 * Label matches beat value matches, so naming a control by its label does not
 * lose to some other element that happens to contain the same text.
 */
async function findByLabel(
  udid: string,
  label: string
): Promise<AXElement | null> {
  const marker = await withAccessibilityRecovery(udid, () =>
    companions.withClient(udid, async (client) => {
      try {
        const found = (await client.accessibilityInfo({
          marker: label,
          matchKey: SearchableKey.LABEL,
          keys: DESCRIBE_KEYS,
        })) as { elements?: AXElement } | null;
        markAccessibilityAnswered(udid);
        const element = found?.elements;
        if (!element) return null;

        // `canonicalise` also drops the subtree the match arrives with. On the
        // home screen that is nothing, but a match inside an app can drag ten
        // kilobytes of descendants along with it, which would defeat the point of
        // asking for one element. Callers wanting structure have ui_describe_all.
        return canonicalise(element);
      } catch (error) {
        // "found no element" is how the companion reports an empty result, and is
        // not a failure. Anything else is — including the wedge, which the
        // wrapper above cures and retries. A search that reached the tree at all
        // is proof the bridge is alive.
        if (/found no element/i.test((error as Error).message)) {
          markAccessibilityAnswered(udid);
          return null;
        }
        throw error;
      }
    })
  );
  if (marker) return marker;

  let tree: AXElement[];
  try {
    tree = await describeScreen(udid);
  } catch {
    // The fallback is best-effort: if the screen cannot be read, the honest
    // answer is still "not found" rather than an error about a backend the
    // caller did not ask for.
    return null;
  }

  return matchInTree(tree, label);
}

/**
 * The accessibility element at a point, in portrait coordinates.
 *
 * LEGACY, not NESTED, to match what `idb ui describe-point` sent: the Python
 * client only asked for NESTED when given --nested, which describe-point never
 * passed. Asking for NESTED here returns the element's whole subtree instead of
 * the single element callers expect.
 *
 * Same key set as every other read, so one element looks the same however a
 * caller arrived at it. Left to the companion's defaults, the backends disagree
 * about their own output: the AX backend calls a tab `role: "AXRadioButton"`
 * with populated `traits`, and axbridge calls the same element `role: "Button"`
 * with `traits: null`. Asking for the fields both agree on retires the problem
 * rather than papering over it, and `type` carries what `role` was for.
 */
async function describePoint(
  udid: string,
  x: number,
  y: number
): Promise<AXElement> {
  return withAccessibilityRecovery(udid, async () => {
    try {
      return await companions.withClient(udid, async (client) => {
        const element = (await client.accessibilityInfo({
          point: { x: Math.round(x), y: Math.round(y) },
          format: Format.LEGACY,
          keys: DESCRIBE_KEYS,
        })) as AXElement;
        // A real frame, not merely a reply: a booting simulator answers a point
        // read with an empty 0x0 element before its bridge is up.
        if (element?.frame && (element.frame.width || element.frame.height)) {
          markAccessibilityAnswered(udid);
        }
        return canonicalise(element);
      });
    } catch (error) {
      // idb raises one error for two unrelated things: a bridge that is not
      // answering, and a point with nothing on it. Only a point read can mean
      // the second, so this is the one place that has to tell them apart — and
      // it must, because the caller who taps an empty patch of screen would
      // otherwise have the simulator's bridge restarted underneath them.
      if (
        isWedgeError(toError(error).message) &&
        (await accessibilityIsAnswering(udid))
      ) {
        markAccessibilityAnswered(udid);
        throw new Error(
          `No accessibility element at (${Math.round(x)}, ${Math.round(y)}). ` +
            `The simulator is answering normally, so that point is empty or ` +
            `covered — check the coordinates against ui_describe_all.`
        );
      }
      throw error;
    }
  });
}

// Read filtered tools from environment variable
const FILTERED_TOOLS =
  process.env.IOS_SIMULATOR_MCP_FILTERED_TOOLS?.split(",").map((tool) =>
    tool.trim()
  ) || [];

// Function to check if a tool is filtered
function isToolFiltered(toolName: string): boolean {
  return FILTERED_TOOLS.includes(toolName);
}

// --- Simulator lifecycle management ---

type SimSession = { udid: string; name: string; owned: boolean; orientation: Orientation; screenDims: { width: number; height: number } | null };

/** Tracks managed simulators by session id */
const managedSimulators = new Map<string, SimSession>();

/** Tracks active recording processes by session id */
const activeRecordings = new Map<string, import("child_process").ChildProcess>();

/**
 * Session ids that are mid-creation. Reserved synchronously in start_simulator
 * before any `await`, so two concurrent start_simulator calls for the same new
 * id can't both create a simulator (which would leak one).
 */
const startingSessions = new Set<string>();

/**
 * Looks up a simulator device by UDID via simctl. Returns its name and state
 * ("Booted", "Shutdown", ...) or null if no such device exists.
 */
async function findDevice(
  udid: string
): Promise<{ name: string; state: string } | null> {
  const { stdout } = await run("xcrun", ["simctl", "list", "devices", "-j"]);
  const data = JSON.parse(stdout);
  for (const runtime of Object.values(data.devices) as any[]) {
    for (const device of runtime) {
      if (device.udid === udid) {
        return { name: device.name, state: device.state };
      }
    }
  }
  return null;
}

/** Zod schema for the session id parameter, reused across all tools */
const sessionIdSchema = z
  .string()
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/, "Session ID must contain only alphanumeric characters, hyphens, and underscores")
  .describe("Unique identifier for your session");

/**
 * Returns the managed simulator session for the given session id.
 * Throws if no simulator exists for that session.
 */
function getManagedSim(id: string): SimSession {
  const sim = managedSimulators.get(id);
  if (!sim) {
    throw new Error(
      `No simulator is running for session "${id}". Call start_simulator first.`
    );
  }
  return sim;
}

/**
 * Finds a device type identifier matching the given keyword.
 * Returns the first (newest) match since simctl lists newest devices first.
 */
async function findDeviceType(
  keyword: string
): Promise<{ identifier: string; name: string }> {
  const { stdout } = await run("xcrun", [
    "simctl",
    "list",
    "devicetypes",
    "-j",
  ]);
  const data = JSON.parse(stdout);
  const deviceTypes: { name: string; identifier: string }[] = data.devicetypes;
  const lowerKeyword = keyword.toLowerCase();
  const matches = deviceTypes.filter((dt) =>
    dt.name.toLowerCase().includes(lowerKeyword)
  );

  if (matches.length === 0) {
    throw new Error(
      `No device type found matching "${keyword}". Available types: ${deviceTypes.map((dt) => dt.name).join(", ")}`
    );
  }

  // Return the first match (newest model, since simctl lists newest first)
  return matches[0];
}

/**
 * Finds the latest available iOS runtime.
 */
async function findLatestRuntime(): Promise<string> {
  const { stdout } = await run("xcrun", [
    "simctl",
    "list",
    "runtimes",
    "-j",
  ]);
  const data = JSON.parse(stdout);
  const runtimes: { name: string; identifier: string; isAvailable: boolean }[] =
    data.runtimes;
  const iosRuntimes = runtimes.filter(
    (r) => r.isAvailable && r.name.startsWith("iOS")
  );

  if (iosRuntimes.length === 0) {
    throw new Error("No available iOS runtimes found. Install one via Xcode.");
  }

  return iosRuntimes[iosRuntimes.length - 1].identifier;
}

/**
 * Cleans up all managed simulators (shutdown + delete). Ignores errors.
 */
async function cleanupAllSimulators(): Promise<void> {
  await Promise.allSettled(
    [...managedSimulators.values()]
      .filter(({ owned }) => owned)
      .map(async ({ udid }) => {
        try { await run("xcrun", ["simctl", "shutdown", udid]); } catch { /* may already be shut down */ }
        try { await run("xcrun", ["simctl", "delete", udid]); } catch { /* ignore cleanup errors */ }
        forgetSimulator(udid);
      })
  );
  managedSimulators.clear();
}

// --- Coordinate transformation ---

/**
 * Probes the simulator to auto-detect the exact rotation by cross-referencing
 * describe_all (rotated logical coords) with describe_point (portrait coord input).
 *
 * Algorithm:
 * 1. Collect all labeled elements from describe_all
 * 2. Filter to elements with unique labels (avoid ambiguous matches)
 * 3. For each candidate element, transform its centre into portrait space under
 *    both possible orientations, then call describe_point at each position
 * 4. If the element is found at exactly one position, that's our orientation
 * 5. If found at both or neither, try the next element
 *
 * Returns a safe default on any failure — detection is best-effort.
 */
async function detectOrientation(udid: string): Promise<Orientation> {
  try {
    const elements = await describeAll(udid);
    const rootFrame = elements[0]?.frame;
    if (!rootFrame || !rootFrame.width || !rootFrame.height) {
      return "portrait"; // still booting or degenerate frame
    }

    const screenW: number = rootFrame.width;
    const screenH: number = rootFrame.height;
    const candidates = candidateOrientations(screenW > screenH);

    const probes = uniquelyLabelled(
      collectProbeCandidates(elements, screenW, screenH)
    );

    for (const probe of probes) {
      const centre = centreOf({ frame: probe.frame });
      if (!centre) continue;

      const matches: Orientation[] = [];
      for (const orientation of candidates) {
        // Where this element would be in the portrait space describe_point
        // accepts, if the screen were in this orientation. Deliberately the
        // same transform tap and swipe use, so detection cannot drift from the
        // behaviour it is detecting for.
        const point = transformPointToPortrait(
          centre.x,
          centre.y,
          orientation,
          screenW,
          screenH
        );
        try {
          const pointElement = await describePoint(udid, point.x, point.y);
          if (pointElement.AXLabel === probe.label) matches.push(orientation);
        } catch {
          // probe failed, skip this position
        }
      }

      // Exactly one match = definitive answer
      if (matches.length === 1) {
        return matches[0];
      }
      // Both or neither matched — ambiguous, try next element
    }

    // No element settled it, so the shape of the screen is all we know.
    return candidates[0];
  } catch {
    // Detection is best-effort; degrade gracefully
    return "portrait";
  }
}

/**
 * Gets the logical screen dimensions, using the cached value from the session
 * if available (populated by ui_describe_all / detect_rotation), otherwise
 * falls back to a fresh describe-all call and caches the result.
 */
async function getScreenDimensions(
  sim: SimSession
): Promise<{ width: number; height: number } | null> {
  if (sim.screenDims) return sim.screenDims;

  const elements = await describeAll(sim.udid);
  const frame = elements[0]?.frame;
  if (!frame || !frame.width || !frame.height) return null;
  sim.screenDims = { width: frame.width, height: frame.height };
  return sim.screenDims;
}

/**
 * Extracts and caches screen dimensions from a parsed describe-all root frame.
 */
function cacheScreenDims(sim: SimSession, frame: { width: number; height: number }): void {
  if (frame.width && frame.height) {
    sim.screenDims = { width: frame.width, height: frame.height };
  }
}

/**
 * Builds the error message for a `describe-all` that still yields a degenerate
 * root (0x0 frame, no children) after the companion has been restarted.
 *
 * Both cures have already been tried before anyone reaches here: `describeAll`
 * restarts our companion and retries, then restarts the simulator's bridge and
 * retries again. What is left is either a simulator that has not finished
 * booting, or one whose accessibility server is broken in a way neither fixes.
 *
 * We tell those apart by probing `describe-point`: on a booted-but-broken sim a
 * point query still returns a real frame, whereas a still-booting sim returns
 * nothing usable.
 */
async function diagnoseEmptyAccessibilityTree(udid: string): Promise<string> {
  // describe-point has a warm-up quirk: the first call after boot can return an
  // empty 0x0 element even on a booted sim, then subsequent calls succeed. So
  // probe a few times and treat any real frame as "booted".
  let booted = false;
  for (let attempt = 0; attempt < 3 && !booted; attempt++) {
    booted = await accessibilityPointAnswers(udid);
  }

  if (booted) {
    // A point query answering while the tree stays empty is the wedge; the
    // cheap cure keeps the device and its apps, where recreating the simulator
    // — what this used to recommend — costs every installed app for the same
    // result. The cooldown means this is usually a no-op saying it was already
    // tried moments ago.
    if (await recoverWedgedAccessibility(udid)) {
      return (
        "The simulator's accessibility service had wedged. It was recovered by " +
        "restarting the simulator bridge — retry the call that failed."
      );
    }

    return (
      "The simulator is booted and answers point queries, but its accessibility " +
      "tree is empty, and restarting both idb_companion and the simulator bridge " +
      "failed to recover it. That is not expected: the bridge restart fixes this " +
      "in every case seen so far. Please ask the user to file a bug at " +
      "https://github.com/zafnz/ios-multi-simulator-mcp/issues with the simulator " +
      "UDID and this message. To carry on meanwhile, call destroy_simulator then " +
      "start_simulator — this creates a fresh simulator, so any installed app must " +
      "be reinstalled."
    );
  }

  return "Simulator is still booting. Wait a few seconds and try again.";
}

// --- Server setup ---

/**
 * Sent to every client at handshake, so it is the only guidance most agents
 * ever get. Kept dense: it costs tokens in every session.
 */
const SERVER_INSTRUCTIONS =
  "iOS Simulator MCP server. Every tool takes an `id` identifying your session, which owns one simulator. " +
  "Choose a distinctive id for yourself (e.g. \"qa-login-flow\", not \"test\") and reuse it for every call — other agents may be driving their own simulators on this same server, and sharing an id means taking over each other's. Calling start_simulator again with the same id resumes your existing simulator. Call destroy_simulator when finished.\n" +
  "Do not use `xcrun simctl`, `idb`, or other shell commands to control simulators; this server owns their lifecycle and cannot see changes made behind its back.\n" +
  "Navigation: if you know what you want, tap it by name — ui_tap {label} resolves the element on the simulator and taps its centre, costing a few hundred bytes and no coordinate handling. ui_find {label} locates an element, or reports it absent as a normal answer. Only use ui_describe_all when you do not know what is on screen: it returns the whole tree and is several kilobytes. Labels match by case-sensitive substring, against an element's label or its visible text, and curly quotes, apostrophes and dashes are treated as their plain equivalents — ask for what you see on screen.\n" +
  "start_simulator does not return until the simulator answers, so you can use it immediately; it says so if it gave up waiting.\n" +
  "ui_describe_all reads the app's real view hierarchy, so it includes controls in tab bars, nav bars and toolbars, and is pruned to elements you can act on. It and a failed ui_find each cost ~300ms, so do not poll either in a tight loop.\n" +
  "Coordinates are logical screen space. ui_describe_all frames feed directly into ui_tap, ui_swipe and ui_describe_point.\n" +
  "Visual checks: if asked whether something looks right — layout, colour, alignment, anything about appearance — call ui_view and look at the screenshot. The accessibility tree shows what exists, not how it renders; an element can be present and correctly labelled while looking completely wrong. Do not derive tap coordinates from a screenshot: those are pixel space and stop matching logical space once the device is rotated.";

function toError(input: unknown): Error {
  if (input instanceof Error) return input;

  if (
    typeof input === "object" &&
    input &&
    "message" in input &&
    typeof input.message === "string"
  )
    return new Error(input.message);

  return new Error(JSON.stringify(input));
}

function troubleshootingLink(): string {
  return "[Troubleshooting Guide](https://github.com/zafnz/ios-multi-simulator-mcp/blob/main/TROUBLESHOOTING.md) | [Plain Text Guide for LLMs](https://raw.githubusercontent.com/zafnz/ios-multi-simulator-mcp/refs/heads/main/TROUBLESHOOTING.md)";
}

function errorWithTroubleshooting(message: string): string {
  return `${message}\n\nFor help, see the ${troubleshootingLink()}`;
}

/**
 * Rewrites idb errors whose text describes a cause they are not usually about.
 *
 * `No translation object` is raised for any read the accessibility bridge cannot
 * serve, and its wording blames coordinates and a fullscreen dialog. The
 * overwhelmingly common cause is neither: the simulator is still coming up.
 * Callers who take the message at face value go looking for a dialog that is not
 * there, which is a documented way to lose an afternoon.
 */
function clarify(message: string): string {
  if (isWedgeError(message)) {
    return (
      "The simulator is not answering accessibility requests. It is usually " +
      "still booting — wait a few seconds and try again; a fresh simulator can " +
      "take up to 90 seconds. If the simulator was working a moment ago, its " +
      "accessibility service has wedged; restarting it was already attempted " +
      "and did not help, so retrying immediately is unlikely to either.\n\n" +
      `Original error: ${message}`
    );
  }
  return message;
}

async function handleToolError(
  errorPrefix: string,
  fn: () => Promise<any>
) {
  try {
    return await fn();
  } catch (error) {
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: errorWithTroubleshooting(`${errorPrefix}: ${clarify(toError(error).message)}`) }],
    };
  }
}

/**
 * Total budget for `start_simulator` to return, ready or not.
 *
 * Bounded by the *caller's* patience rather than the simulator's: an MCP client
 * cancels a tool call that takes too long, and a cancelled call tells the caller
 * nothing at all -- not the UDID, not that a simulator was even created, not
 * what to do next. That is strictly worse than returning honestly at 55s with a
 * UDID and an instruction to poll, which is why this is a fraction of the 180s
 * it used to be. A healthy simulator is ready in ~40s including the boot wait;
 * anything past this is not going to be rescued by waiting a little longer.
 */
const BOOT_READY_TIMEOUT_MS = 55_000;

/**
 * How long to leave a freshly booted simulator alone before speaking to it.
 * See `waitUntilDriveable`. Well under the ~30s a healthy device takes to
 * become driveable, so it is not on the critical path.
 */
const BOOT_SETTLE_MS = 8_000;

/**
 * The guest service that owns the accessibility bridge, and the one to restart
 * when it wedges. Restarting it is what `remediateSpringBoard` does inside idb.
 */
const BRIDGE_SERVICE = "com.apple.CoreSimulator.bridge";

/**
 * Budget for the recovery attempt and the probes after it, carved out of the
 * end of the boot wait so the attempt is always made and always has room to
 * take effect. A recovered simulator answered within ~5s in testing.
 */
const RECOVERY_TAIL_MS = 12_000;

/**
 * Never call a device wedged before this much unsuccessful polling, however
 * little budget is left. A healthy device answers within ~5s of boot completing,
 * so this only guards against restarting the bridge on one that is merely slow.
 */
const BRIDGE_RECOVERY_MIN_POLL_MS = 8_000;

/**
 * Cap on waiting for `simctl bootstatus`, which blocks until the device
 * finishes booting and has been measured from 26s to 54s under load. Past this
 * the poll below is a better use of the remaining budget than more waiting.
 */
const BOOTSTATUS_CAP_MS = 30_000;

/**
 * Restarts the guest's CoreSimulator bridge, recovering a simulator whose
 * accessibility service never came up.
 *
 * A simulator can render its home screen, answer taps and serve `describe`
 * while every accessibility read fails with "no translation object" — and it
 * never recovers on its own. Stopping the bridge makes launchd bring a fresh
 * one up, and the device answers within a few seconds. Verified on a wedged
 * simulator: bridge pid changed, and describe/find/tap all worked immediately
 * afterwards, with the device and its installed apps untouched.
 *
 * idb has this same cure — `remediateSpringBoard` runs exactly this stop — but
 * only reaches for it when the root element has a zero frame *and* its owning
 * pid is dead ("SpringBoard has crashed"). Our shape is a nil translation with
 * SpringBoard alive, which that predicate excludes, so the fix never fires.
 */
async function restartSimulatorBridge(udid: string): Promise<void> {
  await run("xcrun", ["simctl", "spawn", udid, "launchctl", "stop", BRIDGE_SERVICE]);
}

/**
 * How long to keep asking a restarted bridge whether it is back.
 *
 * Poll rather than settle-and-check, because the settle time is not knowable.
 * Measured on a deliberately stopped bridge: `simctl spawn ... launchctl stop`
 * took ~5s to return, and the device answered ~11s after the restart was
 * ordered. A single probe at 4s — what this did first — declared the recovery
 * failed on a simulator that was serving reads 1.6s later, which is the worst
 * possible answer: the cure worked and the caller was told it had not.
 */
const RECOVERY_PROBE_TIMEOUT_MS = 20_000;

/** How often to ask, inside that window. */
const RECOVERY_PROBE_INTERVAL_MS = 1_000;

/**
 * Attempts at the caller's read once the bridge is answering again.
 *
 * More than one because a bridge answers the recovery probe slightly before it
 * answers reliably: measured on a restarted bridge, the probe succeeded, the
 * read immediately after it failed with the same wedge error, and the next call
 * 21ms later succeeded. Handing back a failure the cure had already fixed is
 * the one outcome worth spending an extra second to avoid.
 */
const POST_RECOVERY_READ_ATTEMPTS = 3;

/** Pause between those attempts. */
const POST_RECOVERY_READ_DELAY_MS = 500;

/**
 * Shortest interval between two recovery attempts for one simulator.
 *
 * A wedged simulator being driven by an agent produces a failed read every few
 * hundred milliseconds, and restarting the bridge under each one would leave it
 * permanently mid-restart. Once the cure has been tried and the reads are still
 * failing, the cause is something a restart does not fix, and the caller is
 * better served by the error than by another minute of retries.
 */
const RECOVERY_COOLDOWN_MS = 60_000;

/**
 * Simulators that have served at least one accessibility read.
 *
 * This is what separates "wedged" from "still booting", and both look identical
 * in the error text. A simulator that has never answered is simply not up yet —
 * `waitUntilDriveable` owns that case and has its own, budgeted recovery — so
 * restarting its bridge on the first failed read would fight the boot path for
 * a device that is doing nothing wrong. One successful read is proof that the
 * bridge worked, which makes a later failure a regression rather than a wait.
 */
const hasAnsweredAccessibility = new Set<string>();

/**
 * Records that a simulator served a *usable* read.
 *
 * Deliberately not "the call did not throw": a simulator that is still booting
 * answers with a 0x0 root frame rather than an error, and treating that as
 * proof of a working bridge would arm recovery against every device that is
 * merely slow — the boot path's job, with its own budget.
 */
function markAccessibilityAnswered(udid: string): void {
  hasAnsweredAccessibility.add(udid);
}

/** In-flight recovery per simulator, so concurrent failures share one attempt. */
const recoveryInFlight = new Map<string, Promise<boolean>>();

/** When each simulator's bridge was last restarted, for the cooldown above. */
const lastRecoveryAt = new Map<string, number>();

/** Forgets a simulator's recovery state. Called when its session ends. */
function forgetSimulator(udid: string): void {
  hasAnsweredAccessibility.delete(udid);
  lastRecoveryAt.delete(udid);
}

/**
 * Whether the simulator's accessibility service is answering at all.
 *
 * A whole-screen read rather than a point read, because a point read cannot
 * answer this question: idb raises the *same* `no translation object` error for
 * a dead bridge and for a point with nothing on it. Asking for the screen has
 * no such ambiguity — a bridge that is up returns a tree.
 *
 * Never triggers recovery, being what recovery uses to judge itself, so it
 * cannot recurse into the code that calls it.
 */
async function accessibilityIsAnswering(udid: string): Promise<boolean> {
  try {
    const frame = await companions.withClient(udid, async (client) => {
      const info = (await client.accessibilityInfo({
        format: Format.NESTED,
      })) as AXElement[] | AXElement | null;
      if (info == null) return null;
      const root = Array.isArray(info) ? info[0] : info;
      return root?.frame ?? null;
    });
    return !!frame && !!(frame.width && frame.height);
  } catch {
    return false;
  }
}

/**
 * Whether a *point* read answers, which is a different question.
 *
 * Used only to tell a simulator that is still booting from one whose tree has
 * gone empty: the second answers point queries while returning nothing for the
 * screen, and the first answers neither.
 */
async function accessibilityPointAnswers(udid: string): Promise<boolean> {
  try {
    const element = (await companions.withClient(udid, (client) =>
      client.accessibilityInfo({
        point: { x: 100, y: 100 },
        format: Format.LEGACY,
        keys: DESCRIBE_KEYS,
      })
    )) as AXElement | null;
    return !!element?.frame && !!(element.frame.width || element.frame.height);
  } catch {
    return false;
  }
}

/** Milliseconds since this simulator's bridge was last restarted. */
function msSinceRecovery(udid: string): number {
  const last = lastRecoveryAt.get(udid);
  return last === undefined ? Number.POSITIVE_INFINITY : Date.now() - last;
}

/**
 * Restarts the wedged bridge and reports whether the simulator answers again.
 *
 * Deduplicated and rate-limited per simulator: several tools failing at once —
 * which is what a wedge looks like from the outside — share a single restart
 * rather than each ordering their own.
 */
async function recoverWedgedAccessibility(udid: string): Promise<boolean> {
  const inFlight = recoveryInFlight.get(udid);
  if (inFlight) return inFlight;

  const since = msSinceRecovery(udid);
  if (since < RECOVERY_COOLDOWN_MS) {
    vlog(
      `simulator ${udid} still not answering ${Math.round(since / 1000)}s after ` +
        `a bridge restart; not restarting again`
    );
    return false;
  }

  const attempt = (async () => {
    vlog(`simulator ${udid} stopped answering accessibility; restarting ${BRIDGE_SERVICE}`);
    try {
      await restartSimulatorBridge(udid);
    } catch (error) {
      vlog(`bridge restart for ${udid} failed: ${toError(error).message}`);
      return false;
    }
    const started = Date.now();
    const deadline = started + RECOVERY_PROBE_TIMEOUT_MS;
    let recovered = false;
    do {
      await new Promise((resolve) =>
        setTimeout(resolve, RECOVERY_PROBE_INTERVAL_MS)
      );
      recovered = await accessibilityIsAnswering(udid);
    } while (!recovered && Date.now() < deadline);

    const took = Math.round((Date.now() - started) / 1000);
    vlog(
      recovered
        ? `simulator ${udid} recovered ${took}s after restarting ${BRIDGE_SERVICE}`
        : `simulator ${udid} did not recover within ${took}s of restarting ${BRIDGE_SERVICE}`
    );
    return recovered;
  })();

  lastRecoveryAt.set(udid, Date.now());
  recoveryInFlight.set(udid, attempt);
  try {
    return await attempt;
  } finally {
    recoveryInFlight.delete(udid);
    // Time the cooldown from when the attempt finished, not from when it
    // started, so the ~5s restart itself is not counted against it.
    lastRecoveryAt.set(udid, Date.now());
  }
}

/**
 * Runs an accessibility read, curing a wedged bridge underneath it.
 *
 * The wedge — a simulator that renders, taps and answers `describe` while every
 * accessibility read fails forever — was previously only recovered during boot,
 * and only `ui_describe_all` and `ui_view` did anything about it afterwards.
 * Everything else returned a better-worded error and left the session dead:
 * `ui_tap`, `ui_find`, `ui_type`, `ui_swipe` and `ui_describe_point` all failed
 * with advice to call a *different* tool. Wrapping the reads themselves means
 * every tool is recovered by the same code, and none of them has to know.
 *
 * Only for a simulator that has answered before, and only for the one error
 * that a restart cures — see `shouldRecover` for why both gates matter. Cure
 * once, then a handful of attempts at the caller's read; a wedge that outlives
 * that is reported rather than retried around.
 */
async function withAccessibilityRecovery<T>(
  udid: string,
  read: () => Promise<T>
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const decided = shouldRecover({
      answered: hasAnsweredAccessibility.has(udid),
      message: toError(error).message,
      msSinceLastAttempt: msSinceRecovery(udid),
      cooldownMs: RECOVERY_COOLDOWN_MS,
    });
    if (!decided) throw error;
    if (!(await recoverWedgedAccessibility(udid))) throw error;

    let lastError = error;
    for (let attempt = 0; attempt < POST_RECOVERY_READ_ATTEMPTS; attempt++) {
      await new Promise((resolve) =>
        setTimeout(resolve, POST_RECOVERY_READ_DELAY_MS)
      );
      try {
        return await read();
      } catch (retryError) {
        lastError = retryError;
        // Anything other than the wedge is a real answer to the caller's
        // request, and waiting longer will not change it.
        if (!isWedgeError(toError(retryError).message)) throw retryError;
      }
    }
    throw lastError;
  }
}

/**
 * Blocks until CoreSimulator reports the device has finished booting.
 *
 * A real signal instead of a guess: `simctl bootstatus` is documented to
 * "monitor the specified device and print boot status information until the
 * device finishes booting". It says nothing about the accessibility service,
 * which comes up later still — hence the settle and the polling after it — but
 * it replaces the part that was previously a fixed sleep and would not have
 * stretched under load.
 *
 * Failures are swallowed: this is a way to wait well, not a precondition.
 */
async function waitForBootStatus(udid: string, capMs: number): Promise<void> {
  const child = execFile("xcrun", ["simctl", "bootstatus", udid, "-b"], {
    shell: false,
  });
  try {
    await Promise.race([
      new Promise<void>((resolve) => child.on("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, capMs)),
    ]);
  } catch {
    // Older Xcode, or a device that finished before we asked. The poll is the
    // actual readiness test either way.
  } finally {
    // Nothing downstream needs this process once we have stopped waiting on it,
    // and leaving it attached would outlive the call that started it.
    if (child.exitCode === null) child.kill();
  }
}

/**
 * Resolves once the simulator can actually be driven, or when the wait runs out.
 *
 * `simctl boot` returning, and the device reporting "Booted", both happen well
 * before the accessibility bridge will answer anything — a gap of a minute or
 * more. Reporting success at that point hands the caller a simulator where every
 * UI tool fails, with an error that blames a fullscreen dialog.
 *
 * The probe is an accessibility read rather than `describe`, because that is
 * what the tools actually need: `describe` answers from target metadata and
 * starts succeeding while the bridge is still silent, so it would report ready
 * too early. A zero-sized root frame counts as not ready for the same reason.
 *
 * Returns whether it became ready, rather than throwing: the simulator exists
 * either way, and the session is already registered, so a timeout is something
 * to report rather than a failure to create.
 */
async function waitUntilDriveable(
  udid: string,
  timeoutMs: number = BOOT_READY_TIMEOUT_MS
): Promise<{ ready: boolean; waitedMs: number; recovered: boolean; recoveryTried: boolean }> {
  const started = Date.now();

  // Wait on CoreSimulator's own signal first, then leave the device alone for a
  // moment before speaking to it. The settle is belt-and-braces: it is cheap
  // (a healthy device is not driveable for ~30s regardless) and there is some
  // evidence that very early contact is implicated in the bridge wedge, but
  // that evidence is weak — 20 boots with it and 10 without were both clean,
  // and the failures come in bursts rather than at a steady rate. It is kept
  // because it costs nothing, not because it is known to help.
  await waitForBootStatus(udid, BOOTSTATUS_CAP_MS);
  await new Promise((resolve) => setTimeout(resolve, BOOT_SETTLE_MS));

  const pollingStarted = Date.now();
  let recoveryTried = false;

  while (Date.now() - started < timeoutMs) {
    try {
      const frame = await companions.withClient(udid, async (client) => {
        const info = (await client.accessibilityInfo({
          format: Format.NESTED,
        })) as AXElement[] | AXElement | null;
        if (info == null) return null;
        const root = Array.isArray(info) ? info[0] : info;
        return root?.frame ?? null;
      });
      if (frame && frame.width && frame.height) {
        // From here on, a failed read is a regression rather than a wait, so
        // the shared recovery path is allowed to act on it.
        markAccessibilityAnswered(udid);
        return {
          ready: true,
          waitedMs: Date.now() - started,
          recovered: recoveryTried,
          recoveryTried,
        };
      }
    } catch {
      // Expected while booting. Only the deadline, or a successful read, ends
      // this loop.
    }

    // Past the point where a healthy device would have answered, stop waiting
    // and treat it as the wedge: restart the bridge once, then keep polling.
    // Doing this here rather than only reporting it means the common failure
    // costs a caller seconds instead of a destroyed simulator.
    // Recover when the budget is nearly gone rather than at a fixed age, so the
    // attempt always gets made and always gets a window to work in. A fixed
    // threshold cannot promise either: `bootstatus` alone has taken anywhere
    // from 26s to 54s, so a threshold small enough to fire on a fast machine
    // fires immediately on a slow one, and one large enough to be safe there is
    // never reached before the deadline.
    const remaining = timeoutMs - (Date.now() - started);
    if (
      !recoveryTried &&
      remaining <= RECOVERY_TAIL_MS &&
      Date.now() - pollingStarted > BRIDGE_RECOVERY_MIN_POLL_MS
    ) {
      recoveryTried = true;
      vlog(
        `simulator ${udid} has not answered accessibility for ` +
          `${Math.round((Date.now() - pollingStarted) / 1000)}s after boot completed ` +
          `(${Math.round((Date.now() - started) / 1000)}s total); restarting ${BRIDGE_SERVICE} to recover`
      );
      try {
        await restartSimulatorBridge(udid);
      } catch (error) {
        vlog(`bridge restart for ${udid} failed: ${toError(error).message}`);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  return {
    ready: false,
    waitedMs: Date.now() - started,
    recovered: false,
    recoveryTried,
  };
}

// --- Tool registrations ---

/**
 * Registers all MCP tools on the given server instance. Called once per server
 * instance. In HTTP mode a fresh server is created per request, but all durable
 * state (managedSimulators, activeRecordings) lives in module-global maps that
 * are shared across every server instance in this process.
 */
function registerTools(server: McpServer) {
if (!isToolFiltered("start_simulator")) {
  server.tool(
    "start_simulator",
    "Creates, boots, and opens an iOS simulator for the given session. Each session can have one simulator — call destroy_simulator first to switch types.",
    {
      id: sessionIdSchema,
      type: z
        .string()
        .optional()
        .describe(
          'Device type keyword (e.g. "iPhone", "iPad", "iPhone 16 Pro"). Defaults to the latest iPhone.'
        ),
    },
    { title: "Start Simulator", readOnlyHint: false, openWorldHint: true },
    async ({ id, type }) =>
      handleToolError("Error starting simulator", async () => {
        // Reconnect/resume: if this session already has a simulator that is
        // still booted, reuse it. This lets an agent that disconnected and came
        // back (same id) pick up exactly where it left off.
        const existing = managedSimulators.get(id);
        if (existing) {
          const device = await findDevice(existing.udid);
          if (device && device.state === "Booted") {
            // Make sure the window is visible again for the returning agent.
            await run("open", ["-a", "Simulator.app"]);
            return {
              isError: false,
              content: [
                {
                  type: "text",
                  text: `Resumed existing simulator for session "${id}": "${existing.name}" (${existing.udid})`,
                },
              ],
            };
          }
          // Stale entry — the simulator is gone or shut down. Drop it and
          // recreate below.
          managedSimulators.delete(id);
        }

        // Concurrency guard: reserve the id synchronously before any await so a
        // second concurrent call for the same new id doesn't create a duplicate.
        if (startingSessions.has(id)) {
          throw new Error(
            `A simulator is already being created for session "${id}". Wait for it to finish.`
          );
        }
        startingSessions.add(id);

        try {
          const keyword = type || "iPhone";
          const deviceType = await findDeviceType(keyword);
          const runtime = await findLatestRuntime();

          // Build device name: <SIM_NAME>_<id>_<type_keyword>
          const deviceName = `${id}_${keyword.toLowerCase().replace(/\s+/g, "-")}`;

          // Create the simulator
          const { stdout: udid } = await run("xcrun", [
            "simctl",
            "create",
            deviceName,
            deviceType.identifier,
            runtime,
          ]);

          // Boot the simulator
          await run("xcrun", ["simctl", "boot", udid]);

          // Ensure Simulator.app is open
          await run("open", ["-a", "Simulator.app"]);

          // A previous destroy_simulator may have blocked this udid; a freshly
          // created one is fair game again.
          companions.reopen(udid);

          managedSimulators.set(id, {
            udid,
            name: deviceName,
            owned: true,
            orientation: "auto",
            screenDims: null,
          });

          // Do not return until the simulator can actually be driven. `simctl
          // boot` completes a minute or more before the accessibility bridge
          // answers, and a caller that trusts this tool's success will spend
          // that minute collecting errors that blame a fullscreen dialog.
          const { ready, waitedMs, recovered, recoveryTried } =
            await waitUntilDriveable(udid);
          const seconds = Math.round(waitedMs / 1000);

          if (ready) {
            vlog(
              `simulator ${udid} ready after ${seconds}s` +
                (recovered ? " (recovered by restarting the bridge)" : "")
            );
          }

          return {
            isError: false,
            content: [
              {
                type: "text",
                text: ready
                  ? `Simulator started: "${deviceName}" (${deviceType.name}, ${udid}). Ready after ${seconds}s.` +
                    (recovered
                      ? " Its accessibility service had to be recovered by restarting the simulator bridge."
                      : "")
                  : `Simulator created and booting: "${deviceName}" (${deviceType.name}, ${udid}), but it has not ` +
                    `answered an accessibility read after ${seconds}s. ` +
                    (recoveryTried
                      ? `Restarting the simulator bridge did not recover it, which is not expected: that fixes this ` +
                        `in every case seen so far. Please ask the user to file a bug at ` +
                        `https://github.com/zafnz/ios-multi-simulator-mcp/issues with the simulator UDID and this message. ` +
                        `Meanwhile, poll ui_view in case it recovers, or call destroy_simulator and start_simulator to ` +
                        `start over.`
                      : `Poll ui_view until it returns a screenshot.`),
              },
            ],
          };
        } finally {
          startingSessions.delete(id);
        }
      })
  );
}

if (!isToolFiltered("destroy_simulator")) {
  server.tool(
    "destroy_simulator",
    "Shuts down and deletes the simulator for the given session. Call start_simulator afterwards to create a new one.",
    {
      id: sessionIdSchema,
    },
    { title: "Destroy Simulator", readOnlyHint: false, openWorldHint: true },
    async ({ id }) =>
      handleToolError("Error destroying simulator", async () => {
        const { name, udid, owned } = getManagedSim(id);

        // Stop our companion and keep it stopped. simctl shutdown/delete takes
        // seconds, and without the block a concurrent call for this simulator
        // would see its channel die and spawn a replacement for a simulator
        // that is about to be deleted.
        await companions.close(udid);

        if (owned) {
          try { await run("xcrun", ["simctl", "shutdown", udid]); } catch { /* may already be shut down */ }
          await run("xcrun", ["simctl", "delete", udid]);
        }

        managedSimulators.delete(id);
        forgetSimulator(udid);

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: owned
                ? `Simulator destroyed: "${name}" (${udid})`
                : `Detached from simulator: "${name}" (${udid})`,
            },
          ],
        };
      })
  );
}

if (!isToolFiltered("attach_simulator")) {
  server.tool(
    "attach_simulator",
    "Attaches to an existing, already-booted iOS simulator by UDID. Use this instead of start_simulator when you want to control a simulator that was created externally.",
    {
      id: sessionIdSchema,
      udid: z
        .string()
        .regex(
          /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/
        )
        .describe("UDID of the simulator to attach to"),
    },
    { title: "Attach Simulator", readOnlyHint: false, openWorldHint: true },
    async ({ id, udid }) =>
      handleToolError("Error attaching to simulator", async () => {
        const existing = managedSimulators.get(id);
        if (existing) {
          throw new Error(
            `Session "${id}" is already attached to simulator "${existing.name}" (${existing.udid}). Call destroy_simulator first.`
          );
        }

        // Verify the simulator exists and is booted
        const found = await findDevice(udid);

        if (!found) {
          throw new Error(`No simulator found with UDID "${udid}".`);
        }

        if (found.state !== "Booted") {
          throw new Error(
            `Simulator "${found.name}" (${udid}) is not booted (state: ${found.state}).`
          );
        }

        // Re-attaching to a udid a previous session detached from must clear
        // any block left by that detach.
        companions.reopen(udid);

        managedSimulators.set(id, {
          udid,
          name: found.name,
          owned: false,
          orientation: "auto",
          screenDims: null,
        });

        // "Booted" is reported well before the accessibility bridge answers, so
        // attaching to a simulator that has only just come up has the same
        // problem as creating one. Costs nothing when it is already up.
        const { ready, waitedMs, recoveryTried } = await waitUntilDriveable(udid);
        const seconds = Math.round(waitedMs / 1000);

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: ready
                ? `Attached to simulator: "${found.name}" (${udid})`
                : `Attached to simulator: "${found.name}" (${udid}), but it has not answered an ` +
                  `accessibility read after ${seconds}s. ` +
                  (recoveryTried
                    ? `Restarting the simulator bridge did not recover it, which is not expected. Please ask the ` +
                      `user to file a bug at https://github.com/zafnz/ios-multi-simulator-mcp/issues with the ` +
                      `simulator UDID and this message.`
                    : `Poll ui_view until it returns a screenshot.`),
            },
          ],
        };
      })
  );
}

if (!isToolFiltered("detect_rotation")) {
  server.tool(
    "detect_rotation",
    "Detects the current device rotation by probing the simulator's accessibility tree. Call this after the device has been rotated to update the coordinate mapping. Returns the detected orientation (portrait, landscape_right, landscape_left, or upside_down).",
    {
      id: sessionIdSchema,
    },
    {
      title: "Detect Rotation",
      readOnlyHint: true,
      openWorldHint: false,
    },
    async ({ id }) =>
      handleToolError("Error detecting rotation", async () => {
        const sim = getManagedSim(id);
        sim.screenDims = null; // invalidate — rotation changes logical dimensions
        const detected = await detectOrientation(sim.udid);
        sim.orientation = detected;

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Detected orientation: "${detected}" for session "${id}".`,
            },
          ],
        };
      })
  );
}

if (!isToolFiltered("ui_describe_all")) {
  server.tool(
    "ui_describe_all",
    "Describes accessibility information for the entire screen in the iOS Simulator",
    {
      id: sessionIdSchema,
    },
    { title: "Describe All UI Elements", readOnlyHint: true, openWorldHint: true },
    async ({ id }) =>
      handleToolError("Error describing all of the ui", async () => {
        const sim = getManagedSim(id);

        let elements = await describeScreen(sim.udid);
        if (isDegenerateTree(elements)) {
          // `describeAll` carries the whole ladder of cures — restart our
          // companion, then the simulator's bridge — so run it, and ask again
          // if it brings the screen back. Returning the screen beats returning
          // an error that tells the caller to retry the call themselves.
          if (!isDegenerateTree(await describeAll(sim.udid))) {
            elements = await describeScreen(sim.udid);
          }
          if (isDegenerateTree(elements)) {
            throw new Error(await diagnoseEmptyAccessibilityTree(sim.udid));
          }
        }

        // Cache screen dimensions so subsequent tap/swipe/describe_point avoid an extra call
        const screenFrame = elements[0]?.frame;
        if (screenFrame) {
          cacheScreenDims(sim, screenFrame);
        }

        // Already in logical screen space
        return {
          isError: false,
          content: [{ type: "text", text: JSON.stringify(elements) }],
        };
      })
  );
}

if (!isToolFiltered("ui_find")) {
  server.tool(
    "ui_find",
    "Find a single UI element by its accessibility label, without fetching the whole screen. Matches any element whose label contains the given text. Much cheaper than ui_describe_all when you already know what you are looking for.",
    {
      id: sessionIdSchema,
      label: z
        .string()
        .min(1)
        .max(200)
        .describe("Label text to look for (substring match, case sensitive)"),
    },
    { title: "Find UI Element", readOnlyHint: true, openWorldHint: true },
    async ({ id, label }) =>
      handleToolError(`Error finding element labelled "${label}"`, async () => {
        const sim = getManagedSim(id);
        const element = await findByLabel(sim.udid, label);

        if (!element) {
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: `No element found whose label contains "${label}". Use ui_describe_all to see what is on screen.`,
              },
            ],
          };
        }

        return {
          isError: false,
          content: [{ type: "text", text: JSON.stringify(element) }],
        };
      })
  );
}

if (!isToolFiltered("ui_tap")) {
  server.tool(
    "ui_tap",
    "Tap on the screen in the iOS Simulator. Give either a label to tap the element with that accessibility label, or explicit x and y coordinates.",
    {
      id: sessionIdSchema,
      duration: z
        .string()
        .regex(/^\d+(\.\d+)?$/)
        .optional()
        .describe("Press duration"),
      label: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "Accessibility label of the element to tap (substring match). Resolves to the centre of that element. Use instead of x and y."
        ),
      x: z.number().optional().describe("The x-coordinate (omit if using label)"),
      y: z.number().optional().describe("The y-coordinate (omit if using label)"),
      count: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .default(1)
        .describe("Number of taps to perform (default 1). Use 2 for double-tap."),
    },
    { title: "UI Tap", readOnlyHint: false, openWorldHint: true },
    async ({ id, duration, x, y, count, label }) =>
      handleToolError("Error tapping on the screen", async () => {
        const sim = getManagedSim(id);

        // A label resolves to the centre of that element, in the same logical
        // space as explicit coordinates, so both paths share the transform below.
        if (label !== undefined) {
          const element = await findByLabel(sim.udid, label);
          if (!element) {
            throw new Error(
              `No element found whose label contains "${label}". Use ui_describe_all to see what is on screen.`
            );
          }
          const centre = centreOf(element);
          if (!centre) {
            throw new Error(
              `Found an element labelled "${label}", but it has no usable frame to tap.`
            );
          }
          x = centre.x;
          y = centre.y;
        }

        if (x === undefined || y === undefined) {
          throw new Error(
            "ui_tap needs either a label, or both x and y coordinates."
          );
        }

        // Transform logical coords to portrait space for the companion
        const dims = await getScreenDimensions(sim);
        if (dims) {
          const orientation = getEffectiveOrientation(
            sim.orientation,
            dims.width,
            dims.height
          );
          const pt = transformPointToPortrait(
            x,
            y,
            orientation,
            dims.width,
            dims.height
          );
          x = pt.x;
          y = pt.y;
        }

        // Bound outside the closure so the narrowing above survives into it.
        const tapX = Math.round(x);
        const tapY = Math.round(y);

        // Exclusive: interleaving another session's input with a multi-tap
        // would turn a double-tap into two unrelated single taps.
        await companions.withClient(
          sim.udid,
          async (client) => {
            for (let i = 0; i < count; i++) {
              if (i > 0) await new Promise((r) => setTimeout(r, 50));
              await client.tap(
                tapX,
                tapY,
                duration ? Number(duration) : undefined
              );
            }
          },
          { exclusive: true }
        );

        return {
          isError: false,
          content: [{ type: "text", text: count > 1 ? `Tapped ${count} times successfully` : "Tapped successfully" }],
        };
      })
  );
}

if (!isToolFiltered("ui_type")) {
  server.tool(
    "ui_type",
    "Input text into the iOS Simulator",
    {
      id: sessionIdSchema,
      text: z
        .string()
        .max(500)
        .regex(/^[\x20-\x7E]+$/)
        .describe("Text to input"),
    },
    { title: "UI Type", readOnlyHint: false, openWorldHint: true },
    async ({ id, text }) =>
      handleToolError("Error typing text into the iOS Simulator", async () => {
        const udid = getManagedSim(id).udid;

        // Exclusive so another session's taps cannot land mid-string.
        await companions.withClient(
          udid,
          (client) => client.typeText(text),
          { exclusive: true }
        );

        return {
          isError: false,
          content: [{ type: "text", text: "Typed successfully" }],
        };
      })
  );
}

if (!isToolFiltered("ui_swipe")) {
  server.tool(
    "ui_swipe",
    "Swipe on the screen in the iOS Simulator",
    {
      id: sessionIdSchema,
      duration: z
        .string()
        .regex(/^\d+(\.\d+)?$/)
        .optional()
        .default("1")
        .describe("Swipe duration in seconds. Longer duration is a more controlled swipe."),
      x_start: z.number().describe("The starting x-coordinate"),
      y_start: z.number().describe("The starting y-coordinate"),
      x_end: z.number().describe("The ending x-coordinate"),
      y_end: z.number().describe("The ending y-coordinate"),
      delta: z
        .number()
        .optional()
        .describe("The size of each step in the swipe (default is 1)")
        .default(1),
    },
    { title: "UI Swipe", readOnlyHint: false, openWorldHint: true },
    async ({ id, duration, x_start, y_start, x_end, y_end, delta }) =>
      handleToolError("Error swiping on the screen", async () => {
        const sim = getManagedSim(id);

        // Transform logical coords to portrait space for the companion
        const dims = await getScreenDimensions(sim);
        if (dims) {
          const orientation = getEffectiveOrientation(
            sim.orientation,
            dims.width,
            dims.height
          );
          const ptStart = transformPointToPortrait(
            x_start,
            y_start,
            orientation,
            dims.width,
            dims.height
          );
          const ptEnd = transformPointToPortrait(
            x_end,
            y_end,
            orientation,
            dims.width,
            dims.height
          );
          x_start = ptStart.x;
          y_start = ptStart.y;
          x_end = ptEnd.x;
          y_end = ptEnd.y;
        }

        // Exclusive: a swipe is a stream of events, and another session's input
        // landing between them scrambles the gesture.
        await companions.withClient(
          sim.udid,
          (client) =>
            client.swipe(
              { x: Math.round(x_start), y: Math.round(y_start) },
              { x: Math.round(x_end), y: Math.round(y_end) },
              {
                delta: delta || undefined,
                duration: duration ? Number(duration) : undefined,
              }
            ),
          { exclusive: true }
        );

        return {
          isError: false,
          content: [{ type: "text", text: "Swiped successfully" }],
        };
      })
  );
}

if (!isToolFiltered("ui_describe_point")) {
  server.tool(
    "ui_describe_point",
    "Returns the accessibility element at given co-ordinates on the iOS Simulator's screen",
    {
      id: sessionIdSchema,
      x: z.number().describe("The x-coordinate"),
      y: z.number().describe("The y-coordinate"),
    },
    { title: "Describe UI Point", readOnlyHint: true, openWorldHint: true },
    async ({ id, x, y }) =>
      handleToolError(`Error describing point (${x}, ${y})`, async () => {
        const sim = getManagedSim(id);

        // Transform logical coords to portrait space for the companion
        const dims = await getScreenDimensions(sim);
        let portraitX = x;
        let portraitY = y;
        if (dims) {
          const orientation = getEffectiveOrientation(
            sim.orientation,
            dims.width,
            dims.height
          );
          const pt = transformPointToPortrait(
            x,
            y,
            orientation,
            dims.width,
            dims.height
          );
          portraitX = pt.x;
          portraitY = pt.y;
        }

        const element = await describePoint(sim.udid, portraitX, portraitY);

        // Already in logical screen space
        return {
          isError: false,
          content: [{ type: "text", text: JSON.stringify(element) }],
        };
      })
  );
}

if (!isToolFiltered("ui_view")) {
  server.tool(
    "ui_view",
    "Get the image content of a compressed screenshot of the current simulator view",
    {
      id: sessionIdSchema,
    },
    { title: "View Screenshot", readOnlyHint: true, openWorldHint: true },
    async ({ id }) =>
      handleToolError("Error capturing screenshot", async () => {
        const sim = getManagedSim(id);

        // Get screen dimensions in points from the accessibility tree
        const uiData = await describeAll(sim.udid);
        const screenFrame = uiData[0]?.frame;
        if (!screenFrame) {
          throw new Error("Could not determine screen dimensions");
        }

        // Always use portrait dimensions for initial resize (screenshot is in portrait pixel orientation)
        const pointWidth = Math.min(screenFrame.width, screenFrame.height);
        const pointHeight = Math.max(screenFrame.width, screenFrame.height);

        if (!pointWidth || !pointHeight) {
          throw new Error(await diagnoseEmptyAccessibilityTree(sim.udid));
        }

        cacheScreenDims(sim, screenFrame);

        const orientation = getEffectiveOrientation(
          sim.orientation,
          screenFrame.width,
          screenFrame.height
        );

        // Generate unique file names with timestamp
        const ts = Date.now();
        const tmpFiles = [
          path.join(TMP_ROOT_DIR, `ui-view-${ts}-raw.png`),
          path.join(TMP_ROOT_DIR, `ui-view-${ts}-resized.jpg`),
          path.join(TMP_ROOT_DIR, `ui-view-${ts}-rotated.jpg`),
        ];
        const [rawPng, resizedJpg, rotatedJpg] = tmpFiles;

        try {
          // Capture screenshot as PNG (always in physical portrait pixel orientation)
          await run("xcrun", [
            "simctl",
            "io",
            sim.udid,
            "screenshot",
            "--type=png",
            "--",
            rawPng,
          ]);

          // Resize to portrait point dimensions and compress to JPEG
          await run("sips", [
            "-z",
            String(pointHeight),
            String(pointWidth),
            "-s",
            "format",
            "jpeg",
            "-s",
            "formatOptions",
            "80", // 80% quality
            rawPng,
            "--out",
            resizedJpg,
          ]);

          // Rotate to match logical orientation.
          // sips --rotate turns the image clockwise by the given angle. The
          // mapping below is correct and consistent with
          // transformPointToPortrait; an earlier comment here said
          // counter-clockwise, which was wrong about sips, not about the code.
          let rotateDegrees: number | null = null;
          switch (orientation) {
            case "landscape_right":
              rotateDegrees = 90;
              break;
            case "landscape_left":
              rotateDegrees = 270;
              break;
            case "upside_down":
              rotateDegrees = 180;
              break;
          }

          let finalFile = resizedJpg;
          if (rotateDegrees !== null) {
            await run("sips", [
              "--rotate",
              String(rotateDegrees),
              resizedJpg,
              "--out",
              rotatedJpg,
            ]);
            finalFile = rotatedJpg;
          }

          // Read and encode the final image
          const imageData = fs.readFileSync(finalFile);
          const base64Data = imageData.toString("base64");

          return {
            isError: false,
            content: [
              {
                type: "image",
                data: base64Data,
                mimeType: "image/jpeg",
              },
              {
                type: "text",
                text: "Screenshot captured",
              },
            ],
          };
        } finally {
          // Clean up temp files
          for (const f of tmpFiles) {
            try { fs.unlinkSync(f); } catch { /* may not exist */ }
          }
        }
      })
  );
}

function ensureAbsolutePath(filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  // Handle ~/something paths in the provided filePath
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  // Determine the default directory from env var or fallback to ~/Downloads
  let defaultDir = path.join(os.homedir(), "Downloads");
  const customDefaultDir = process.env.IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR;

  if (customDefaultDir) {
    // also expand tilde for the custom directory path
    if (customDefaultDir.startsWith("~/")) {
      defaultDir = path.join(os.homedir(), customDefaultDir.slice(2));
    } else {
      defaultDir = customDefaultDir;
    }
  }

  // Join the relative filePath with the resolved default directory
  return path.join(defaultDir, filePath);
}

if (!isToolFiltered("screenshot")) {
  server.tool(
    "screenshot",
    "Takes a screenshot of the iOS Simulator",
    {
      id: sessionIdSchema,
      output_path: z
        .string()
        .max(1024)
        .describe(
          "File path where the screenshot will be saved. If relative, it uses the directory specified by the `IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR` env var, or `~/Downloads` if not set."
        ),
      type: z
        .enum(["png", "tiff", "bmp", "gif", "jpeg"])
        .optional()
        .describe(
          "Image format (png, tiff, bmp, gif, or jpeg). Default is png."
        ),
      display: z
        .enum(["internal", "external"])
        .optional()
        .describe(
          "Display to capture (internal or external). Default depends on device type."
        ),
      mask: z
        .enum(["ignored", "alpha", "black"])
        .optional()
        .describe(
          "For non-rectangular displays, handle the mask by policy (ignored, alpha, or black)"
        ),
    },
    { title: "Take Screenshot", readOnlyHint: false, openWorldHint: true },
    async ({ id, output_path, type, display, mask }) =>
      handleToolError("Error taking screenshot", async () => {
        const udid = getManagedSim(id).udid;
        const absolutePath = ensureAbsolutePath(output_path);

        // command is weird, it responds with stderr on success and stdout is blank
        const { stderr: stdout } = await run("xcrun", [
          "simctl",
          "io",
          udid,
          "screenshot",
          ...(type ? [`--type=${type}`] : []),
          ...(display ? [`--display=${display}`] : []),
          ...(mask ? [`--mask=${mask}`] : []),
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          absolutePath,
        ]);

        // throw if we don't get the expected success message
        if (stdout && !stdout.includes("Wrote screenshot to")) {
          throw new Error(stdout);
        }

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: stdout,
            },
          ],
        };
      })
  );
}

if (!isToolFiltered("record_video")) {
  server.tool(
    "record_video",
    "Records a video of the iOS Simulator using simctl directly",
    {
      id: sessionIdSchema,
      output_path: z
        .string()
        .max(1024)
        .optional()
        .describe(
          `Optional output path. If not provided, a default name will be used. The file will be saved in the directory specified by \`IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR\` or in \`~/Downloads\` if the environment variable is not set.`
        ),
      codec: z
        .enum(["h264", "hevc"])
        .optional()
        .describe(
          'Specifies the codec type: "h264" or "hevc". Default is "hevc".'
        ),
      display: z
        .enum(["internal", "external"])
        .optional()
        .describe(
          'Display to capture: "internal" or "external". Default depends on device type.'
        ),
      mask: z
        .enum(["ignored", "alpha", "black"])
        .optional()
        .describe(
          'For non-rectangular displays, handle the mask by policy: "ignored", "alpha", or "black".'
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          "Force the output file to be written to, even if the file already exists."
        ),
    },
    { title: "Record Video", readOnlyHint: false, openWorldHint: true },
    async ({ id, output_path, codec, display, mask, force }) =>
      handleToolError("Error starting recording", async () => {
        const udid = getManagedSim(id).udid;

        if (activeRecordings.has(id)) {
          throw new Error(
            `A recording is already in progress for session "${id}". Call stop_recording first.`
          );
        }

        const defaultFileName = `simulator_recording_${Date.now()}.mp4`;
        const outputFile = ensureAbsolutePath(output_path ?? defaultFileName);

        const recordingProcess = spawn("xcrun", [
          "simctl",
          "io",
          udid,
          "recordVideo",
          ...(codec ? [`--codec=${codec}`] : []),
          ...(display ? [`--display=${display}`] : []),
          ...(mask ? [`--mask=${mask}`] : []),
          ...(force ? ["--force"] : []),
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          outputFile,
        ]);

        // Wait for recording to start or fail
        await new Promise<void>((resolve, reject) => {
          let errorOutput = "";
          let settled = false;

          const settle = (fn: () => void) => {
            if (!settled) {
              settled = true;
              fn();
            }
          };

          recordingProcess.stderr.on("data", (data) => {
            const message = data.toString();
            if (message.includes("Recording started")) {
              settle(() => resolve());
            } else {
              errorOutput += message;
            }
          });

          recordingProcess.on("close", (code) => {
            settle(() =>
              reject(
                new Error(
                  errorOutput.trim() ||
                    `Recording process exited with code ${code}`
                )
              )
            );
          });

          recordingProcess.on("error", (err) => {
            settle(() => reject(err));
          });

          setTimeout(() => {
            settle(() => {
              if (recordingProcess.exitCode !== null) {
                reject(
                  new Error(
                    errorOutput.trim() || "Recording process exited unexpectedly"
                  )
                );
              } else {
                // Process is still running but never emitted "Recording started" — assume it's working
                resolve();
              }
            });
          }, 3000);
        });

        activeRecordings.set(id, recordingProcess);

        // Clean up map entry when process exits
        recordingProcess.on("close", () => {
          activeRecordings.delete(id);
        });

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Recording started. The video will be saved to: ${outputFile}\nTo stop recording, use the stop_recording command.`,
            },
          ],
        };
      })
  );
}

if (!isToolFiltered("stop_recording")) {
  server.tool(
    "stop_recording",
    "Stops the simulator video recording",
    {
      id: sessionIdSchema,
    },
    { title: "Stop Recording", readOnlyHint: false, openWorldHint: true },
    async ({ id }) =>
      handleToolError("Error stopping recording", async () => {
        getManagedSim(id); // validates session exists

        const proc = activeRecordings.get(id);
        if (!proc) {
          throw new Error(
            `No active recording for session "${id}".`
          );
        }

        // Send SIGINT to gracefully stop simctl recordVideo (lets it finalize the file)
        proc.kill("SIGINT");

        // Wait a moment for the video to finalize
        await new Promise((resolve) => setTimeout(resolve, 1000));

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: "Recording stopped successfully.",
            },
          ],
        };
      })
  );
}

if (!isToolFiltered("install_app")) {
  server.tool(
    "install_app",
    "Installs an app bundle (.app or .ipa) on the iOS Simulator",
    {
      id: sessionIdSchema,
      app_path: z
        .string()
        .max(1024)
        .describe(
          "Path to the app bundle (.app directory or .ipa file) to install"
        ),
    },
    { title: "Install App", readOnlyHint: false, openWorldHint: true },
    async ({ id, app_path }) =>
      handleToolError("Error installing app", async () => {
        const udid = getManagedSim(id).udid;
        const absolutePath = path.isAbsolute(app_path)
          ? app_path
          : path.resolve(app_path);

        // Check if the app bundle exists
        if (!fs.existsSync(absolutePath)) {
          throw new Error(`App bundle not found at: ${absolutePath}`);
        }

        // run() will throw if the command fails (non-zero exit code)
        // Note: simctl doesn't support -- as an option terminator; path is validated above via existsSync
        await run("xcrun", ["simctl", "install", udid, absolutePath]);

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `App installed successfully from: ${absolutePath}`,
            },
          ],
        };
      })
  );
}

if (!isToolFiltered("launch_app")) {
  server.tool(
    "launch_app",
    "Launches an app on the iOS Simulator by bundle identifier",
    {
      id: sessionIdSchema,
      bundle_id: z
        .string()
        .max(256)
        .describe(
          "Bundle identifier of the app to launch (e.g., com.apple.mobilesafari)"
        ),
      terminate_running: z
        .boolean()
        .optional()
        .describe(
          "Terminate the app if it is already running before launching"
        ),
    },
    { title: "Launch App", readOnlyHint: false, openWorldHint: true },
    async ({ id, bundle_id, terminate_running }) =>
      handleToolError("Error launching app", async () => {
        const udid = getManagedSim(id).udid;

        // run() will throw if the command fails (non-zero exit code)
        // Note: simctl doesn't support -- as an option terminator
        const { stdout } = await run("xcrun", [
          "simctl",
          "launch",
          ...(terminate_running ? ["--terminate-running-process"] : []),
          udid,
          bundle_id,
        ]);

        // Extract PID from output if available
        // simctl launch outputs the PID as the first token in stdout
        const pidMatch = stdout.match(/^(\d+)/);
        const pid = pidMatch ? pidMatch[1] : null;

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: pid
                ? `App ${bundle_id} launched successfully with PID: ${pid}`
                : `App ${bundle_id} launched successfully`,
            },
          ],
        };
      })
  );
}
} // end registerTools

/**
 * Builds a fully-configured McpServer instance with all tools registered.
 * In stdio mode this is called once; in HTTP mode once per request.
 */
function createServer(): McpServer {
  const server = new McpServer(
    { name: "ios-simulator", version: PACKAGE_VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );
  registerTools(server);
  return server;
}

// --- Transports ---

/**
 * Parses CLI flags. Supported (CLI takes precedence over env vars):
 *   --http | --stdio            select transport (http is the default)
 *   --transport <stdio|http>    select transport
 *   --host <addr>               HTTP bind address
 *   --port <n>                  HTTP port
 *   --verbose | -v              log client connections and calls (http mode)
 * Each value flag also accepts the `--flag=value` form.
 */
function parseArgs(argv: string[]): {
  transport?: string;
  host?: string;
  port?: string;
  verbose?: boolean;
} {
  const out: {
    transport?: string;
    host?: string;
    port?: string;
    verbose?: boolean;
  } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg : arg.slice(0, eq);
    // Value is either after `=` or the next argument.
    const value = () =>
      eq === -1 ? argv[++i] : arg.slice(eq + 1);

    switch (key) {
      case "--http":
        out.transport = "http";
        break;
      case "--stdio":
        out.transport = "stdio";
        break;
      case "--transport":
        out.transport = value();
        break;
      case "--host":
        out.host = value();
        break;
      case "--port":
        out.port = value();
        break;
      case "--verbose":
      case "-v":
        out.verbose = true;
        break;
    }
  }
  return out;
}

const cliArgs = parseArgs(process.argv.slice(2));

const envTruthy = (v: string | undefined) =>
  ["1", "true", "yes"].includes((v ?? "").toLowerCase());

/**
 * Resolved transport config: CLI flag > env var > default.
 *
 * HTTP is the default as of 2.0.0. Sessions live in the server process, so
 * stdio — where every client spawns its own private server — cannot share a
 * simulator between agents, which is the point of this fork. stdio remains
 * available via --stdio for a single client that wants to own its own server.
 */
const config = {
  transport: (
    cliArgs.transport ||
    process.env.IOS_SIMULATOR_MCP_TRANSPORT ||
    "http"
  ).toLowerCase(),
  host: cliArgs.host || process.env.IOS_SIMULATOR_MCP_HTTP_HOST || "127.0.0.1",
  port: Number(cliArgs.port || process.env.IOS_SIMULATOR_MCP_HTTP_PORT || "8008"),
  verbose:
    cliArgs.verbose || envTruthy(process.env.IOS_SIMULATOR_MCP_VERBOSE),
};

/**
 * Logs a human-readable line to stderr when verbose mode is enabled. Used in
 * HTTP mode to surface client connections and tool calls. stderr never carries
 * MCP protocol traffic, so this is safe in any transport.
 */
function vlog(message: string): void {
  if (!config.verbose) return;
  console.error(`[${new Date().toISOString()}] ${message}`);
}

/**
 * Produces a short, human-readable summary of a JSON-RPC request body for
 * verbose logging, e.g. `session "qa-a" ui_tap`, `initialize`, `tools/list`.
 */
function summarizeRpc(body: unknown): string {
  const one = (msg: any): string => {
    if (!msg || typeof msg !== "object") return "?";
    if (msg.method === "tools/call") {
      const name = msg.params?.name ?? "?";
      const sid = msg.params?.arguments?.id;
      return sid ? `session "${sid}" ${name}` : name;
    }
    return msg.method ?? "response";
  };
  return Array.isArray(body) ? body.map(one).join(", ") : one(body);
}

/** Whether owned simulators are destroyed when the server process shuts down. */
const CLEANUP_ON_EXIT =
  (process.env.IOS_SIMULATOR_MCP_CLEANUP_ON_EXIT ?? "true").toLowerCase() !==
  "false";

async function runStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // In stdio mode the client owns the process lifecycle: when stdin closes the
  // client has gone away, so shut down (and clean up owned sims).
  process.stdin.on("close", shutdown);
}

/**
 * Reads the full request body and parses it as JSON. Returns undefined for an
 * empty body (e.g. GET requests).
 */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Host header values a legitimate client would send, for DNS rebinding
 * protection.
 *
 * A real client connects to the address we bound and sends it verbatim in Host.
 * A rebound request arrives naming the attacker's domain instead, so matching on
 * this list rejects it while leaving normal use untouched.
 *
 * Set IOS_SIMULATOR_MCP_ALLOWED_HOSTS (comma separated, `host:port`) when
 * fronting the server with a proxy or reaching it by another name on purpose.
 */
function allowedHostHeaders(host: string, port: number): string[] {
  const names = new Set(["127.0.0.1", "localhost", "[::1]"]);
  // A wildcard bind tells us nothing about the name clients will use, so only
  // add an explicit address.
  if (host && host !== "0.0.0.0" && host !== "::") names.add(host);

  const allowed = [...names].map((name) => `${name}:${port}`);

  const extra = process.env.IOS_SIMULATOR_MCP_ALLOWED_HOSTS;
  if (extra) {
    for (const entry of extra.split(",").map((s) => s.trim()).filter(Boolean)) {
      allowed.push(entry);
    }
  }
  return allowed;
}

async function runHttp() {
  const { host, port } = config;

  const httpServer = http.createServer(async (req, res) => {
    const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
    // Route: only POST /mcp is served. Stateless mode has no server-push (GET)
    // or session teardown (DELETE), so those return 405.
    const url = (req.url || "").split("?")[0];
    if (url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed" },
          id: null,
        })
      );
      return;
    }

    // Stateless: a fresh server + transport per request. Durable simulator state
    // lives in module-global maps, so it is shared across all requests and
    // survives client disconnects/reconnects.
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // Binding to loopback is not by itself a boundary. A web page the user
      // visits can point a hostname it controls at 127.0.0.1 (DNS rebinding);
      // its fetch is then same-origin, so no CORS preflight applies, and it can
      // drive every tool here — read screenshots, write files at chosen paths.
      // The rebound request still carries the attacker's name in Host, so an
      // allowlist of the addresses we actually serve rejects it.
      enableDnsRebindingProtection: true,
      allowedHosts: allowedHostHeaders(host, port),
      // Deliberately no allowedOrigins: the SDK rejects a request that has no
      // Origin header once that list is set, and non-browser MCP clients do not
      // send one. Host alone is what defeats rebinding.
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      const body = await readJsonBody(req);
      vlog(`${peer} ${summarizeRpc(body)}`);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: toError(err).message },
            id: null,
          })
        );
      }
    }
  });

  // Verbose: surface raw TCP connect/disconnect so client comings-and-goings
  // are visible even between requests.
  httpServer.on("connection", (socket) => {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    vlog(`client ${peer} connected`);
    socket.on("close", () => vlog(`client ${peer} disconnected`));
  });

  // Without a listener, a failure to bind is an unhandled 'error' event: the
  // process dies on a raw stack trace. EADDRINUSE is likely now that http is
  // the default and a second server may be started by habit.
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `Port ${port} on ${host} is already in use. Another ios-multi-simulator-mcp ` +
          `is probably already running — point your client at it, or choose another ` +
          `port with --port.`
      );
    } else {
      console.error(`HTTP server error: ${err.message}`);
    }
    process.exit(1);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, resolve);
  });
  console.error(
    `iOS Simulator MCP server listening on http://${host}:${port}/mcp${
      config.verbose ? " (verbose)" : ""
    }`
  );
}

async function runServer() {
  if (config.transport === "http") {
    await runHttp();
  } else {
    await runStdio();
  }
}

runServer().catch(console.error);

let cleaningUp = false;
async function shutdown() {
  if (cleaningUp) return;
  cleaningUp = true;
  // Kill any active recordings so their processes don't outlive us
  for (const proc of activeRecordings.values()) {
    try { proc.kill("SIGINT"); } catch { /* ignore */ }
  }
  // Same for our companions. CompanionManager also installs its own exit hook,
  // which covers the paths that never reach this function.
  try { await companions.shutdownAll(); } catch { /* ignore */ }
  if (CLEANUP_ON_EXIT) {
    await cleanupAllSimulators();
  }
  try {
    fs.rmSync(TMP_ROOT_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

process.on("SIGINT", async () => { await shutdown(); process.exit(0); });
process.on("SIGTERM", async () => { await shutdown(); process.exit(0); });
