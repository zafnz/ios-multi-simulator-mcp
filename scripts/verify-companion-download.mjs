#!/usr/bin/env node
/**
 * End-to-end check that a published companion works on a machine that did not
 * build it.
 *
 * This is the one thing that cannot be proven on the build machine: whether a
 * downloaded, ad-hoc-signed binary actually runs elsewhere, and whether macOS
 * quarantines it. Run this on a second Mac.
 *
 *   npm run build
 *   node scripts/verify-companion-download.mjs            # needs a booted simulator
 *   node scripts/verify-companion-download.mjs --keep-cache
 *
 * By default it clears this project's companion cache first, so the download
 * path is genuinely exercised rather than served from an earlier run. It only
 * ever removes the cache directory this project owns.
 */
import { createRequire } from "module";
import { execFileSync, execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keepCache = process.argv.includes("--keep-cache");

let failures = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};
const info = (msg) => console.log(`    ${msg}`);

function buildDirPresent() {
  return fs.existsSync(path.join(REPO, "build", "idb", "companionBinary.js"));
}

async function main() {
  console.log("Companion download verification\n");

  if (!buildDirPresent()) {
    console.error("build/ is missing — run `npm run build` first.");
    process.exit(1);
  }

  // 1. Establish that this machine did not build the companion.
  console.log("1. machine");
  const arch = execFileSync("uname", ["-m"], { encoding: "utf-8" }).trim();
  const model = execFileSync("sysctl", ["-n", "hw.model"], { encoding: "utf-8" }).trim();
  info(`${model}, ${arch}, ${os.release()}`);
  ok(arch === "arm64", `architecture is ${arch}`);
  const localBuild = path.join(REPO, "vendor/idb/Build/Distribution/idb_companion");
  ok(
    !fs.existsSync(localBuild),
    fs.existsSync(localBuild)
      ? "a local companion build EXISTS here — this machine may have built it, so the download path will be skipped. Move vendor/idb/Build aside to test properly."
      : "no local companion build present, so the download path will be used"
  );
  ok(
    !process.env.IOS_SIMULATOR_MCP_COMPANION_PATH,
    process.env.IOS_SIMULATOR_MCP_COMPANION_PATH
      ? "IOS_SIMULATOR_MCP_COMPANION_PATH is set — unset it, or the download is bypassed"
      : "IOS_SIMULATOR_MCP_COMPANION_PATH is not set"
  );

  // 2. The lock file must be present and readable.
  console.log("\n2. companion.lock.json");
  const lockPath = path.join(REPO, "companion.lock.json");
  ok(fs.existsSync(lockPath), `present at ${path.relative(REPO, lockPath)}`);
  if (!fs.existsSync(lockPath)) {
    console.log("\nNo lock file, so there is nothing to download. Stopping.");
    process.exit(1);
  }
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
  info(`idb ${lock.idbSha.slice(0, 7)} · ${lock.arch} · ${(lock.bytes / 1e6).toFixed(1)} MB`);
  info(lock.url);

  // 3. Clear the cache so the download really happens.
  const { cacheRoot, resolveCompanion } = require(path.join(REPO, "build/idb/companionBinary.js"));
  const root = cacheRoot();
  const installed = path.join(root, "companion", lock.sha256);
  if (!keepCache) {
    console.log("\n3. clearing cache to force a real download");
    fs.rmSync(path.join(root, "companion"), { recursive: true, force: true });
    fs.rmSync(path.join(root, "tmp"), { recursive: true, force: true });
    ok(!fs.existsSync(installed), `cleared ${root}/companion`);
  } else {
    console.log("\n3. keeping existing cache (--keep-cache)");
  }

  // 4. Download, verify, extract, smoke test.
  console.log("\n4. download and verify");
  const started = Date.now();
  let binary;
  try {
    binary = await resolveCompanion((m) => info(m));
  } catch (error) {
    ok(false, `resolveCompanion failed: ${error.message}`);
    console.log("\nVERIFICATION FAILED");
    process.exit(1);
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  ok(fs.existsSync(binary), `resolved in ${elapsed}s to ${binary.replace(os.homedir(), "~")}`);
  ok(binary.includes(lock.sha256), "cached under its content hash (so the sha256 matched)");

  // 5. Gatekeeper: the real question on a machine that did not build it.
  console.log("\n5. macOS quarantine and signature");
  let xattrs = "";
  try {
    xattrs = execFileSync("xattr", ["-l", binary], { encoding: "utf-8" });
  } catch {
    /* no xattrs at all */
  }
  const quarantined = /com\.apple\.quarantine/.test(xattrs);
  ok(!quarantined, quarantined
    ? "com.apple.quarantine IS set — Gatekeeper will block it. Clear with: xattr -dr com.apple.quarantine " + binary
    : "no com.apple.quarantine attribute");
  if (xattrs.trim()) info(`attributes: ${xattrs.trim().split("\n").join(", ")}`);
  try {
    const sig = execFileSync("codesign", ["-dv", binary], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    info(sig.trim().split("\n")[0]);
  } catch (e) {
    const out = (e.stderr || "").toString().trim().split("\n").find((l) => /Signature|adhoc|linker/.test(l));
    if (out) info(out);
  }

  // 6. It actually executes here.
  console.log("\n6. the downloaded binary runs on this machine");
  try {
    const version = execFileSync(binary, ["--version"], { encoding: "utf-8" }).trim().split("\n").pop();
    ok(/build_date/.test(version), `--version: ${version}`);
  } catch (error) {
    ok(false, `could not execute: ${error.message}`);
  }

  // 7. Drive the real MCP server against a booted simulator.
  console.log("\n7. end to end through the MCP server");
  let udid;
  try {
    const booted = execFileSync("xcrun", ["simctl", "list", "devices", "booted", "-j"], { encoding: "utf-8" });
    const devices = Object.values(JSON.parse(booted).devices).flat();
    udid = devices[0]?.udid;
    if (udid) info(`using booted simulator ${devices[0].name} (${udid})`);
  } catch {
    /* fall through */
  }
  if (!udid) {
    console.log("    no booted simulator — skipping. Boot one and re-run to complete the check.");
  } else {
    const { Client } = await import(`${REPO}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js`);
    const { StdioClientTransport } = await import(`${REPO}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js`);
    const transport = new StdioClientTransport({
      command: "node", args: [path.join(REPO, "build/index.js")], stderr: "pipe",
    });
    const client = new Client({ name: "verify", version: "1" }, { capabilities: {} });
    await client.connect(transport);
    transport.stderr?.resume();
    const call = async (name, args) => {
      const res = await client.callTool({ name, arguments: args });
      const text = res.content.map((c) => c.text ?? "").join("");
      if (res.isError) throw new Error(text);
      return text;
    };
    try {
      await call("attach_simulator", { id: "verify", udid });
      const tree = JSON.parse(await call("ui_describe_all", { id: "verify" }));
      ok(tree[0]?.frame?.width > 0, `ui_describe_all: ${tree[0]?.frame?.width}x${tree[0]?.frame?.height}, ${tree[0]?.children?.length ?? 0} children`);
      const label = (tree[0]?.children ?? []).map((c) => c.AXLabel).find(Boolean);
      if (label) {
        const found = JSON.parse(await call("ui_find", { id: "verify", label }));
        ok(found.AXLabel?.includes(label), `ui_find "${label}" resolved server-side in ${JSON.stringify(found).length} B`);
      }
      await call("destroy_simulator", { id: "verify" });
    } catch (error) {
      ok(false, `MCP call failed: ${error.message}`);
    } finally {
      await client.close();
    }
  }

  console.log(failures === 0
    ? "\nVERIFICATION PASSED — the published companion downloads, verifies and runs here."
    : `\nVERIFICATION FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
