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
import { Format, SearchableKey } from "./idb/client";

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

/** An accessibility element as the companion reports it. */
type AXElement = {
  frame?: { x: number; y: number; width: number; height: number };
  AXLabel?: string | null;
  children?: AXElement[];
  [key: string]: unknown;
};

/**
 * True when the read carried no usable tree: either a 0x0 root, or no document
 * at all (the companion serializes an empty read as JSON `null`).
 */
function isDegenerateTree(elements: AXElement[]): boolean {
  const root = elements[0];
  if (!root) return true;
  const frame = root.frame;
  return !!frame && !frame.width && !frame.height;
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

  const elements = await read();
  if (!isDegenerateTree(elements)) return elements;

  await companions.shutdown(udid);
  return read();
}

/**
 * Resolves a single element by its accessibility label, server-side.
 *
 * The companion walks the tree and returns just the match — roughly half a
 * kilobyte, against several for a whole tree — so "tap the thing called X"
 * costs one small call instead of dumping the screen for the model to scan.
 * Returns null when nothing matches, which the companion reports as an error
 * rather than an empty result.
 */
async function findByLabel(
  udid: string,
  label: string
): Promise<AXElement | null> {
  return companions.withClient(udid, async (client) => {
    try {
      const found = (await client.accessibilityInfo({
        marker: label,
        matchKey: SearchableKey.LABEL,
      })) as { elements?: AXElement } | null;
      const element = found?.elements;
      if (!element) return null;

      // The match arrives with its whole subtree attached. On the home screen
      // that is nothing, but a match inside an app can drag ten kilobytes of
      // descendants along with it — which would defeat the point of asking for
      // one element. Callers wanting structure have ui_describe_all.
      const { children, ...withoutSubtree } = element;
      return withoutSubtree as AXElement;
    } catch (error) {
      if (/found no element/i.test((error as Error).message)) return null;
      throw error;
    }
  });
}

/** The centre of an element's frame, in the tree's logical coordinate space. */
function centreOf(element: AXElement): { x: number; y: number } | null {
  const frame = element.frame;
  if (!frame || (!frame.width && !frame.height)) return null;
  return {
    x: frame.x + frame.width / 2,
    y: frame.y + frame.height / 2,
  };
}

/**
 * The accessibility element at a point, in portrait coordinates.
 *
 * LEGACY, not NESTED, to match what `idb ui describe-point` sent: the Python
 * client only asked for NESTED when given --nested, which describe-point never
 * passed. Asking for NESTED here returns the element's whole subtree instead of
 * the single element callers expect.
 */
async function describePoint(
  udid: string,
  x: number,
  y: number
): Promise<AXElement> {
  return companions.withClient(
    udid,
    async (client) =>
      (await client.accessibilityInfo({
        point: { x: Math.round(x), y: Math.round(y) },
        format: Format.LEGACY,
      })) as AXElement
  );
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

type Orientation =
  | "auto"
  | "portrait"
  | "landscape_right"
  | "upside_down"
  | "landscape_left";

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
      })
  );
  managedSimulators.clear();
}

// --- Coordinate transformation ---

interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Determines the effective orientation for a session given the screen dimensions.
 * Uses the cached detected orientation if available, otherwise falls back to
 * simple width/height comparison (which can't distinguish landscape_right from
 * landscape_left, or portrait from upside_down).
 */
function getEffectiveOrientation(
  orientation: Orientation,
  screenWidth: number,
  screenHeight: number
): Orientation {
  if (orientation !== "auto") return orientation;
  return screenWidth > screenHeight ? "landscape_right" : "portrait";
}

/**
 * Collects all labeled, non-full-screen elements from the accessibility tree.
 */
function collectProbeCandidates(
  els: any[],
  screenW: number,
  screenH: number
): { frame: Frame; label: string }[] {
  const results: { frame: Frame; label: string }[] = [];
  for (const el of els) {
    if (el.frame && el.frame.width && el.frame.height && el.AXLabel) {
      // Skip full-screen elements
      if (
        !(
          el.frame.x === 0 &&
          el.frame.y === 0 &&
          el.frame.width === screenW &&
          el.frame.height === screenH
        )
      ) {
        results.push({ frame: el.frame, label: el.AXLabel });
      }
    }
    if (el.children && Array.isArray(el.children)) {
      results.push(...collectProbeCandidates(el.children, screenW, screenH));
    }
  }
  return results;
}

/**
 * Probes the simulator to auto-detect the exact rotation by cross-referencing
 * describe_all (rotated logical coords) with describe_point (portrait coord input).
 *
 * Algorithm:
 * 1. Collect all labeled elements from describe_all
 * 2. Filter to elements with unique labels (avoid ambiguous matches)
 * 3. For each candidate element, compute its portrait-space center under both
 *    possible orientations, then call describe_point at each position
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
    const isLandscape = screenW > screenH;

    // Collect all candidate elements and filter to unique labels
    const allCandidates = collectProbeCandidates(elements, screenW, screenH);
    const labelCounts = new Map<string, number>();
    for (const c of allCandidates) {
      labelCounts.set(c.label, (labelCounts.get(c.label) || 0) + 1);
    }
    const uniqueCandidates = allCandidates.filter(
      (c) => labelCounts.get(c.label) === 1
    );

    // Try each unique element as a probe
    for (const probe of uniqueCandidates) {
      const centerX = probe.frame.x + probe.frame.width / 2;
      const centerY = probe.frame.y + probe.frame.height / 2;

      // Compute portrait-space coordinates for each candidate orientation
      const orientations: { orientation: Orientation; x: number; y: number }[] =
        isLandscape
          ? [
              {
                orientation: "landscape_right",
                x: centerY,
                y: screenW - centerX,
              },
              {
                orientation: "landscape_left",
                x: screenH - centerY,
                y: centerX,
              },
            ]
          : [
              {
                orientation: "portrait",
                x: centerX,
                y: centerY,
              },
              {
                orientation: "upside_down",
                x: screenW - centerX,
                y: screenH - centerY,
              },
            ];

      // Probe both positions
      const matches: Orientation[] = [];
      for (const candidate of orientations) {
        try {
          const pointElement = await describePoint(
            udid,
            candidate.x,
            candidate.y
          );
          if (pointElement.AXLabel === probe.label) {
            matches.push(candidate.orientation);
          }
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

    // Fallback if no element gave a definitive answer
    return isLandscape ? "landscape_right" : "portrait";
  } catch {
    // Detection is best-effort; degrade gracefully
    return "portrait";
  }
}

/**
 * Transforms a logical-space point (x, y) to portrait space for companion input.
 * screenW/screenH are the logical dimensions from describe_all (e.g. 1376x1032 for landscape).
 */
function transformPointToPortrait(
  x: number,
  y: number,
  orientation: Orientation,
  screenW: number,
  screenH: number
): { x: number; y: number } {
  switch (orientation) {
    case "portrait":
    case "auto":
      return { x, y };
    case "landscape_right":
      return { x: y, y: screenW - x };
    case "landscape_left":
      return { x: screenH - y, y: x };
    case "upside_down":
      return { x: screenW - x, y: screenH - y };
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
 * The common cause is already handled before anyone reaches here: a companion
 * that has been up a while can wedge into serving an empty tree, and
 * `describeAll` restarts ours and retries. What is left is either a simulator
 * that has not finished booting, or one whose accessibility server is genuinely
 * broken.
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
    try {
      const el = await describePoint(udid, 100, 100);
      if (el?.frame && (el.frame.width || el.frame.height)) {
        booted = true;
      }
    } catch {
      // Point probe failed — try again, then fall through to "still booting".
    }
  }

  if (booted) {
    return (
      "The simulator is booted and answers point queries, but its accessibility " +
      "tree is empty even after restarting idb_companion. Recover by calling " +
      "destroy_simulator then start_simulator (this creates a fresh simulator; " +
      "any installed app must be reinstalled). Before recreating, please gather " +
      'diagnostics as described in the Troubleshooting guide under "Empty ' +
      'accessibility tree" so the trigger can be identified.'
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
  "Navigation: if you know what you want, tap it by name — ui_tap {label} resolves the element on the simulator and taps its centre, costing a few hundred bytes and no coordinate handling. ui_find {label} locates an element, or reports it absent as a normal answer, so it is safe to poll while waiting for a screen. Only use ui_describe_all when you do not know what is on screen: it returns the whole tree and is several kilobytes. Labels match by case-sensitive substring.\n" +
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

async function handleToolError(
  errorPrefix: string,
  fn: () => Promise<any>
) {
  try {
    return await fn();
  } catch (error) {
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: errorWithTroubleshooting(`${errorPrefix}: ${toError(error).message}`) }],
    };
  }
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

          return {
            isError: false,
            content: [
              {
                type: "text",
                text: `Simulator started: "${deviceName}" (${deviceType.name}, ${udid})`,
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

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Attached to simulator: "${found.name}" (${udid})`,
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

        // describeAll already restarts a wedged companion and retries; a
        // degenerate tree here means something it cannot fix.
        const elements = await describeAll(sim.udid);
        const screenFrame = elements[0]?.frame;
        if (isDegenerateTree(elements)) {
          throw new Error(await diagnoseEmptyAccessibilityTree(sim.udid));
        }

        // Cache screen dimensions so subsequent tap/swipe/describe_point avoid an extra call
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

          // Rotate to match logical orientation
          // sips --rotate rotates counter-clockwise
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
