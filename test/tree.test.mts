import test from "node:test";
import assert from "node:assert/strict";

import type { AXElement } from "../src/ax/tree.ts";
import {
  canonicalise,
  centreOf,
  collectProbeCandidates,
  isDegenerateTree,
  isInteresting,
  matchInTree,
  normaliseForMatch,
  pruneTree,
  reconcileType,
  uniquelyLabelled,
} from "../src/ax/tree.ts";

// A screen shaped like the ones these rules were written against: a root that
// is nothing but a rectangle, system chrome nested in anonymous groups, and a
// control whose visible text lives in its value rather than its label.
const screen = (): AXElement[] => [
  {
    type: "Application",
    frame: { x: 0, y: 0, width: 402, height: 874 },
    children: [
      {
        type: "Group",
        AXUniqueId: "PX-Layout-Group",
        frame: { x: 0, y: 0, width: 402, height: 788 },
        children: [
          {
            type: "Button",
            AXLabel: "Plain Button",
            frame: { x: 20, y: 100, width: 100, height: 44 },
          },
        ],
      },
      {
        type: "Group",
        AXLabel: "Toolbar",
        frame: { x: 0, y: 788, width: 402, height: 86 },
        children: [
          {
            type: "SearchField",
            AXLabel: null,
            AXValue: "Search",
            frame: { x: 33, y: 803, width: 336, height: 38 },
          },
        ],
      },
    ],
  },
];

test("isDegenerateTree", async (t) => {
  await t.test("an empty read carried no tree", () => {
    assert.equal(isDegenerateTree([]), true);
  });

  await t.test("a 0x0 root is the wedged-companion signature", () => {
    assert.equal(
      isDegenerateTree([{ frame: { x: 0, y: 0, width: 0, height: 0 } }]),
      true
    );
  });

  await t.test("a real root is usable", () => {
    assert.equal(isDegenerateTree(screen()), false);
  });

  // Only the frame decides. An element with no frame at all is some other
  // problem, and calling it degenerate would send `describeAll` into a
  // companion restart that cannot fix it.
  await t.test("a root without a frame is not degenerate", () => {
    assert.equal(isDegenerateTree([{ AXLabel: "root" }]), false);
  });
});

test("canonicalise", async (t) => {
  await t.test("keeps the agreed fields and drops the rest", () => {
    const out = canonicalise({
      AXLabel: "Continue",
      frame: { x: 1, y: 2, width: 3, height: 4 },
      AXValue: "on",
      AXUniqueId: "continueButton",
      type: "Button",
      enabled: true,
      // Everything below is either backend-dependent or near-constant.
      role: "AXButton",
      traits: 8,
      pid: 62065,
      AXFrame: "{{1, 2}, {3, 4}}",
    });

    assert.deepEqual(Object.keys(out).sort(), [
      "AXLabel",
      "AXUniqueId",
      "AXValue",
      "enabled",
      "frame",
      "type",
    ]);
  });

  await t.test("drops null, undefined and empty values", () => {
    const out = canonicalise({
      AXLabel: "Continue",
      AXValue: null,
      AXUniqueId: "",
      type: undefined,
    });
    assert.deepEqual(out, { AXLabel: "Continue" });
  });

  // ui_find returns one element; a match inside an app can otherwise drag ten
  // kilobytes of descendants along with it.
  await t.test("drops the subtree", () => {
    const out = canonicalise({
      AXLabel: "Toolbar",
      children: [{ AXLabel: "Search" }],
    });
    assert.equal(out.children, undefined);
  });

  await t.test("false and 0 survive — they are answers, not absences", () => {
    const out = canonicalise({ enabled: false, type: "Button" });
    assert.deepEqual(out, { type: "Button", enabled: false });
  });
});

// Every pair below was read off a live screen: the same element described by
// ui_describe_all and then by ui_describe_point, with identical frames.
test("reconcileType", async (t) => {
  await t.test("promotes a search field, which needs the subrole", () => {
    assert.equal(reconcileType("TextField", "AXSearchField"), "SearchField");
  });

  // The reason a type-only mapping cannot work: this backend calls both of
  // these `TextField`, so mapping on the type alone would promote every text
  // field on the screen to a search field.
  await t.test("leaves a plain text field alone", () => {
    assert.equal(reconcileType("TextField", null), "TextField");
    assert.equal(reconcileType("TextField", undefined), "TextField");
  });

  await t.test("renames the controls the two backends disagree about", () => {
    assert.equal(reconcileType("CheckBox", "AXSwitch"), "Switch");
    assert.equal(reconcileType("RadioButton", "AXTabButton"), "Button");
  });

  await t.test("flattens Heading, which the tree does not have", () => {
    assert.equal(reconcileType("Heading", null), "StaticText");
  });

  await t.test("passes through what both backends already agree on", () => {
    for (const type of ["Button", "StaticText", "Slider", "Image", "Other"]) {
      assert.equal(reconcileType(type, null), type);
    }
  });

  // The subrole is evidence, not an instruction: one we have no mapping for
  // must not disturb the type that came with it.
  await t.test("ignores a subrole it has no rule for", () => {
    assert.equal(reconcileType("Button", "AXSomethingNew"), "Button");
  });

  await t.test("survives a missing type", () => {
    assert.equal(reconcileType(undefined, "AXSwitch"), undefined);
    assert.equal(reconcileType(null, null), undefined);
  });
});

test("isInteresting", async (t) => {
  await t.test("a label or a value is enough", () => {
    assert.equal(isInteresting({ type: "Group", AXLabel: "Toolbar" }), true);
    assert.equal(isInteresting({ type: "Group", AXValue: "Search" }), true);
  });

  await t.test("whitespace is not a label", () => {
    assert.equal(isInteresting({ type: "Group", AXLabel: "   " }), false);
  });

  await t.test("an actionable type needs no name", () => {
    assert.equal(isInteresting({ type: "Button" }), true);
    assert.equal(isInteresting({ type: "SearchField" }), true);
  });

  // The rule that was twice too lenient: UIKit gives its internal layout
  // groups identifiers too, and letting an identifier alone keep a container
  // put a five-deep `PX*-Group` chain back into the tree.
  await t.test("an identifier does not rescue an anonymous container", () => {
    for (const type of ["Any", "Group", "Other", "Unknown"]) {
      assert.equal(
        isInteresting({ type, AXUniqueId: "PX-Layout-Group" }),
        false,
        `${type} with an identifier should be dropped`
      );
    }
  });

  await t.test("an identifier does keep a real thing", () => {
    assert.equal(isInteresting({ type: "Image", AXUniqueId: "hero" }), true);
  });

  await t.test("an anonymous container is noise", () => {
    assert.equal(isInteresting({ type: "Group" }), false);
    assert.equal(isInteresting({}), false);
  });
});

test("pruneTree", async (t) => {
  await t.test("keeps the root even though it is not interesting", () => {
    const [root] = pruneTree(screen());
    assert.deepEqual(root.frame, { x: 0, y: 0, width: 402, height: 874 });
  });

  // The whole point of pruning: dropping a container must never lose the
  // control inside it, only shorten the path to it.
  await t.test("hoists a dropped container's children to the root", () => {
    const [root] = pruneTree(screen());
    const kids = root.children ?? [];
    assert.deepEqual(
      kids.map((k) => k.AXLabel ?? k.AXValue),
      ["Plain Button", "Toolbar"]
    );
    assert.equal(kids[0].type, "Button");
  });

  await t.test("keeps a named container with its children beneath it", () => {
    const [root] = pruneTree(screen());
    const toolbar = (root.children ?? []).find((k) => k.AXLabel === "Toolbar");
    assert.equal(toolbar?.children?.length, 1);
    assert.equal(toolbar?.children?.[0].AXValue, "Search");
  });

  await t.test("hoists through several dropped levels at once", () => {
    const [root] = pruneTree([
      {
        frame: { x: 0, y: 0, width: 10, height: 10 },
        children: [
          {
            type: "Group",
            children: [
              { type: "Other", children: [{ type: "Button", AXLabel: "Deep" }] },
            ],
          },
        ],
      },
    ]);
    assert.equal(root.children?.length, 1);
    assert.equal(root.children?.[0].AXLabel, "Deep");
  });

  await t.test("omits children entirely rather than reporting []", () => {
    const [root] = pruneTree([
      {
        frame: { x: 0, y: 0, width: 10, height: 10 },
        children: [{ type: "Group" }],
      },
    ]);
    assert.equal("children" in root, false);
  });

  await t.test("every kept node is canonicalised", () => {
    const [root] = pruneTree([
      {
        frame: { x: 0, y: 0, width: 10, height: 10 },
        children: [{ type: "Button", AXLabel: "Go", traits: 8, pid: 1 }],
      },
    ]);
    assert.deepEqual(root.children?.[0], { AXLabel: "Go", type: "Button" });
  });
});

test("normaliseForMatch", async (t) => {
  await t.test("folds the apostrophe iOS actually renders", () => {
    assert.equal(normaliseForMatch("Don’t Allow"), "Don't Allow");
  });

  await t.test("folds smart quotes and dashes", () => {
    assert.equal(normaliseForMatch("“Photos”"), '"Photos"');
    assert.equal(normaliseForMatch("A—B"), "A-B");
    assert.equal(normaliseForMatch("A–B"), "A-B");
    assert.equal(normaliseForMatch("A−B"), "A-B");
  });

  await t.test("folds non-breaking spaces and collapses runs", () => {
    assert.equal(normaliseForMatch("Add Contact"), "Add Contact");
    assert.equal(normaliseForMatch("  Add   Contact  "), "Add Contact");
  });

  // Matching is documented as case-sensitive; this erases typography, it does
  // not widen what matches.
  await t.test("leaves case alone", () => {
    assert.equal(normaliseForMatch("Add Contact"), "Add Contact");
    assert.notEqual(normaliseForMatch("ADD"), "add");
  });
});

test("matchInTree", async (t) => {
  await t.test("finds a control by a substring of its label", () => {
    const hit = matchInTree(screen(), "Plain");
    assert.equal(hit?.AXLabel, "Plain Button");
  });

  // The search-field case: null label, visible text in AXValue. Unnameable
  // until the fallback learned to match on value.
  await t.test("finds a control by its visible text", () => {
    const hit = matchInTree(screen(), "Search");
    assert.equal(hit?.AXValue, "Search");
    assert.equal(hit?.type, "SearchField");
  });

  await t.test("matches across typography in either direction", () => {
    const tree: AXElement[] = [{ AXLabel: "Don’t Allow" }];
    assert.equal(matchInTree(tree, "Don't Allow")?.AXLabel, "Don’t Allow");
    assert.equal(matchInTree([{ AXLabel: "Don't Allow" }], "Don’t")?.AXLabel, "Don't Allow");
  });

  // A label match wins wherever it sits, so naming a control by its label does
  // not lose to something else that happens to carry the same text as a value.
  await t.test("a label match beats an earlier value match", () => {
    const tree: AXElement[] = [
      {
        children: [
          { type: "TextField", AXValue: "Settings", AXUniqueId: "field" },
          { type: "Button", AXLabel: "Settings", AXUniqueId: "button" },
        ],
      },
    ];
    assert.equal(matchInTree(tree, "Settings")?.AXUniqueId, "button");
  });

  await t.test("otherwise the first in document order wins", () => {
    const tree: AXElement[] = [
      {
        AXLabel: "Search results",
        children: [
          { type: "Cell", AXLabel: "Search 1", AXUniqueId: "first" },
          { type: "Cell", AXLabel: "Search 2", AXUniqueId: "second" },
        ],
      },
    ];
    assert.equal(matchInTree(tree, "Search 2")?.AXUniqueId, "second");
    assert.equal(matchInTree(tree, "Search")?.AXLabel, "Search results");
  });

  await t.test("returns one canonical element, not a subtree", () => {
    const hit = matchInTree(screen(), "Toolbar");
    assert.equal(hit?.children, undefined);
    assert.deepEqual(Object.keys(hit ?? {}).sort(), ["AXLabel", "frame", "type"]);
  });

  await t.test("absent is a null, not a throw", () => {
    assert.equal(matchInTree(screen(), "ZZZnope"), null);
    assert.equal(matchInTree([], "anything"), null);
  });
});

test("centreOf", async (t) => {
  await t.test("is the middle of the frame", () => {
    assert.deepEqual(
      centreOf({ frame: { x: 33, y: 803, width: 336, height: 38 } }),
      { x: 201, y: 822 }
    );
  });

  await t.test("declines to guess without a usable frame", () => {
    assert.equal(centreOf({}), null);
    assert.equal(centreOf({ frame: { x: 5, y: 5, width: 0, height: 0 } }), null);
  });

  // A zero-width divider still has a position worth tapping.
  await t.test("one non-zero dimension is enough", () => {
    assert.deepEqual(centreOf({ frame: { x: 0, y: 10, width: 0, height: 4 } }), {
      x: 0,
      y: 12,
    });
  });
});

test("collectProbeCandidates", async (t) => {
  const candidates = collectProbeCandidates(screen(), 402, 874);

  await t.test("collects labelled elements at any depth, in document order", () => {
    assert.deepEqual(
      candidates.map((c) => c.label),
      ["Plain Button", "Toolbar"]
    );
    assert.deepEqual(candidates[0].frame, { x: 20, y: 100, width: 100, height: 44 });
  });

  // A full-screen element is where every orientation's probe lands, so it can
  // never tell two orientations apart.
  await t.test("skips an element covering the whole screen", () => {
    const full = collectProbeCandidates(
      [{ AXLabel: "Backdrop", frame: { x: 0, y: 0, width: 402, height: 874 } }],
      402,
      874
    );
    assert.deepEqual(full, []);
  });

  await t.test("skips unlabelled and zero-sized elements", () => {
    const none = collectProbeCandidates(
      [
        { frame: { x: 1, y: 1, width: 10, height: 10 } },
        { AXLabel: "Invisible", frame: { x: 1, y: 1, width: 0, height: 0 } },
      ],
      402,
      874
    );
    assert.deepEqual(none, []);
  });
});

test("uniquelyLabelled", async (t) => {
  // Both copies go: a repeated label can answer yes to both probes, which is
  // exactly the ambiguity detection has to avoid.
  await t.test("drops every copy of a repeated label", () => {
    const out = uniquelyLabelled([
      { label: "Cancel" },
      { label: "Photo" },
      { label: "Photo" },
    ]);
    assert.deepEqual(out, [{ label: "Cancel" }]);
  });

  await t.test("keeps order and identity of what survives", () => {
    const a = { label: "a", n: 1 };
    const b = { label: "b", n: 2 };
    assert.deepEqual(uniquelyLabelled([a, b]), [a, b]);
  });
});
