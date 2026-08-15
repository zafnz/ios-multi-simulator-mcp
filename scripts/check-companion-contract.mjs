#!/usr/bin/env node
/**
 * Checks the things this server assumes idb_companion does.
 *
 * Not a test of our code — `npm test` covers that, and cannot reach a
 * companion. These are behavioural contracts with somebody else's binary, each
 * one load-bearing for a decision in `src/`, and none of them is written down
 * anywhere upstream promises to keep. idb is under active development; a change
 * to any of them would leave this server quietly doing the wrong thing rather
 * than failing, because every one of these assumptions is invisible when it
 * holds.
 *
 * Run it after bumping `companion.lock.json` or the submodule, and before
 * trusting a new companion:
 *
 *   npm run build
 *   testapp/build.sh
 *   # install and launch the fixture on a booted simulator, main screen
 *   node scripts/check-companion-contract.mjs <udid>
 *
 * It spawns its own companion for that udid, which is fine alongside the
 * server's — that is how every probe in this project has been run — and it only
 * reads, apart from one switch it toggles and toggles back.
 */
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { companions } = require(path.join(REPO, "build/idb/companionManager.js"));
const idb = require(path.join(REPO, "build/idb/generated/idb.js"));

const Format = idb.AccessibilityInfoRequest_Format;
const Backend = idb.AccessibilityInfoRequest_Backend;
const Key = idb.AccessibilityActionRequest_SearchableKey;

const udid = process.argv[2];
// The remote-host assumption needs a screen the others cannot run on: a sheet
// or picker has to be up, which covers the fixture the rest are phrased
// against. So it is its own mode rather than a check that quietly skips.
const remoteOnly = process.argv.includes("--remote");
if (!udid) {
  console.error(
    "usage: node scripts/check-companion-contract.mjs <udid> [--remote]\n" +
      "  default:  the fixture (testapp) must be showing its main screen\n" +
      "  --remote: a remote-hosted view must be up — the photo picker, or the\n" +
      "            autofill sheet from TESTING_TOOLS.md Part 3"
  );
  process.exit(2);
}

let failures = 0;
const record = (pass, name, detail) => {
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`        ${detail}`);
};

/** Every element in a tree, in the order the companion serialised them. */
function flatten(node, out = []) {
  if (!node || typeof node !== "object") return out;
  out.push(node);
  for (const child of node.children ?? []) flatten(child, out);
  return out;
}

const marker = (client, value, key = Key.LABEL, backend) =>
  client.accessibilityInfo({ marker: value, matchKey: key, backend });

await companions.withClient(udid, async (client) => {
  const bridgeTree = async () => {
    const t = await client.accessibilityInfo({
      format: Format.NESTED,
      backend: Backend.AXBRIDGE,
    });
    return (Array.isArray(t) ? t : [t]).flatMap((r) => flatten(r));
  };

  // --- The remote-host boundary, which needs a screen of its own. ----------
  // `translateRemoteSubtrees` keys on this node type to rebase a hosted view's
  // contents into screen coordinates. If the type changes, the translation
  // silently stops happening and taps inside sheets go back to landing
  // hundreds of points away — the bug that started all of this.
  if (remoteOnly) {
    const boundaries = (await bridgeTree()).filter((e) => e.type === "83");
    record(
      boundaries.length > 0,
      'a remote-hosted view restarts its coordinate space at a node of type "83"',
      boundaries.length
        ? `${boundaries.length} boundary node(s) found`
        : `none found — either no remote view is on screen (open the picker or the ` +
          `autofill sheet), or the type has changed and translateRemoteSubtrees ` +
          `no longer recognises it`
    );
    return;
  }

  // --- The fixture is what every check below is phrased against. -----------
  const screen = await client.accessibilityInfo({ format: Format.NESTED });
  const roots = Array.isArray(screen) ? screen : [screen];
  const all = roots.flatMap((r) => flatten(r));
  const labelled = (text) =>
    all.filter((e) => typeof e.AXLabel === "string" && e.AXLabel.includes(text));

  if (!labelled("Plain Button").length) {
    console.error(
      "The fixture is not on screen: no element labelled 'Plain Button'.\n" +
        "Install testapp and launch it on its main screen first, or pass\n" +
        "--remote to check the remote-hosted-view assumption instead."
    );
    process.exit(2);
  }

  // --- 1. Matching is substring, not exact. --------------------------------
  // `ui_find` and `ui_tap {label}` are documented as substring matches, and the
  // tool descriptions tell agents to "ask for what you see on screen". If this
  // became exact, every partial name an agent uses would stop resolving.
  {
    const hit = await marker(client, "Plain Butt");
    const found = hit?.elements?.AXLabel;
    record(
      found === "Plain Button",
      "a marker matches a substring, not just an exact label",
      `marker "Plain Butt" -> ${JSON.stringify(found ?? null)}`
    );
  }

  // --- 2. A marker resolves to the FIRST match, in serialisation order. -----
  // This is why ambiguity cannot be detected on the fast path, and therefore
  // why `matchInTree` ranks candidates only on the fallback and why `ui_tap`
  // names what it tapped. If upstream ever ranked, or returned all matches,
  // both of those could be reconsidered — see TODO #64b/#64c.
  {
    const matches = labelled("Plain");
    const hit = await marker(client, "Plain");
    const got = hit?.elements?.AXLabel;
    const first = matches[0]?.AXLabel;
    record(
      matches.length > 1 && got === first,
      "a marker returns the first match in tree order",
      `${matches.length} elements contain "Plain"; first is ${JSON.stringify(first)}, marker returned ${JSON.stringify(got ?? null)}`
    );
  }

  // --- 3. A marker returns one element, never a collection. -----------------
  // `findByLabel` reads `found.elements` as a single element. An array here
  // would be silently mis-parsed rather than rejected.
  {
    const hit = await marker(client, "Plain");
    const element = hit?.elements;
    record(
      element != null && !Array.isArray(element),
      "a marker returns a single element, not a list",
      `typeof elements = ${Array.isArray(element) ? "array" : typeof element}`
    );
  }

  // --- 4. The default backend cannot see system chrome; AXBridge can. -------
  // The entire reason `findByLabel` has a fallback, and that it costs ~300ms
  // only on a miss. If the default backend ever gained this, the fallback
  // becomes dead weight; if AXBridge lost it, toolbars go unreachable again.
  {
    let axSaw = true;
    try {
      const hit = await marker(client, "Toolbar Button");
      axSaw = !!hit?.elements;
    } catch {
      axSaw = false;
    }
    let bridgeSaw = false;
    try {
      const hit = await marker(client, "Toolbar Button", Key.LABEL, Backend.AXBRIDGE);
      bridgeSaw = !!hit?.elements;
    } catch {
      bridgeSaw = false;
    }
    record(
      !axSaw && bridgeSaw,
      "the default backend misses toolbar contents that AXBridge finds",
      `default backend: ${axSaw ? "found it" : "missed it"}; axbridge: ${bridgeSaw ? "found it" : "missed it"}`
    );
  }

  // --- 5. A point read hit-tests, and is cheap. ----------------------------
  // `ui_describe_point` is documented as fast, and `ui_tap {label}` now spends
  // one of these verifying every tap. At AXBridge prices (~300ms) that check
  // would not be affordable and would have to be reconsidered.
  {
    const button = labelled("Plain Button").find((e) => e.frame?.width);
    const f = button.frame;
    const started = Date.now();
    const at = await client.accessibilityInfo({
      point: { x: Math.round(f.x + f.width / 2), y: Math.round(f.y + f.height / 2) },
      format: Format.LEGACY,
    });
    const ms = Date.now() - started;
    record(
      at?.AXLabel === "Plain Button" && ms < 100,
      "a point read hit-tests, and costs well under 100ms",
      `${ms}ms -> ${JSON.stringify(at?.AXLabel ?? null)}`
    );
  }

  // --- 6. accessibility_action's tap activates without a touch. ------------
  // `ui_tap {label}` on a toggle depends on this entirely: a switch's frame
  // spans its whole row, so there is no coordinate to aim at. Toggled back
  // afterwards, so the fixture is left as it was found.
  {
    const readSwitch = async () => {
      const hit = await marker(client, "Plain Switch");
      return hit?.elements?.AXValue;
    };
    const before = await readSwitch();
    const press = () =>
      new Promise((resolve, reject) => {
        client.client.accessibilityAction(
          idb.AccessibilityActionRequest.fromPartial({
            marker: "Plain Switch",
            matchKey: Key.LABEL,
            depth: 50,
            tap: {},
          }),
          (err, res) => (err ? reject(err) : resolve(res))
        );
      });
    let after = before;
    let error = null;
    try {
      await press();
      await new Promise((r) => setTimeout(r, 600));
      after = await readSwitch();
      if (after !== before) {
        await press();
        await new Promise((r) => setTimeout(r, 600));
      }
    } catch (e) {
      error = e.message.slice(0, 120);
    }
    record(
      !error && after !== before,
      "accessibility_action activates a switch without a touch",
      error ? `error: ${error}` : `AXValue ${JSON.stringify(before)} -> ${JSON.stringify(after)} (restored)`
    );
  }

  console.log(
    `\nThe remote-hosted-view assumption is not checked here — it needs a sheet on\n` +
      `screen. Open the picker (Show Picker) and re-run with --remote.`
  );
});

console.log(
  failures
    ? `\n${failures} assumption(s) no longer hold. Each one is load-bearing — see the\n` +
      `comment above the failing check for what depends on it.`
    : `\nAll assumptions hold.`
);
process.exit(failures ? 1 : 0);
