import test from "node:test";
import assert from "node:assert/strict";

import type { AXElement } from "../src/ax/tree.ts";
import {
  canonicalise,
  centreOf,
  collectProbeCandidates,
  distanceOutsideFrame,
  frameContains,
  isDegenerateTree,
  isInteresting,
  isRemotelyHosted,
  isToggle,
  locateInTree,
  matchInTree,
  normaliseForMatch,
  pruneTree,
  reconcileType,
  sameElement,
  translateRemoteSubtrees,
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

// The geometry here is transcribed from real reads, not invented: an iPhone 17
// Pro (402x874) showing the fixture's login screen with iOS's "Use Strong
// Password?" sheet up, and the same device showing the photo picker. The two
// differ in the one way that matters — the autofill sheet's window sits at
// y=476, the picker's at the screen origin — so together they pin down both
// that the translation happens and that it is not applied blindly.
const autofillSheet = (): AXElement[] => [
  {
    type: "Application",
    frame: { x: 0, y: 0, width: 402, height: 874 },
    children: [
      {
        type: "Button",
        AXLabel: "Login Submit",
        frame: { x: 61, y: 256, width: 280, height: 30 },
      },
      {
        // The hosting window, in screen space.
        type: "Any",
        frame: { x: 0, y: 476, width: 402, height: 340 },
        children: [
          {
            // The boundary: same rectangle, named again from its own origin.
            type: "83",
            frame: { x: 0, y: 0, width: 402, height: 340 },
            children: [
              {
                type: "Button",
                AXLabel: "Close",
                AXUniqueId: "xmark",
                frame: { x: 350.67, y: 16, width: 29.33, height: 29.33 },
              },
              {
                type: "Button",
                AXLabel: "Fill Strong Password",
                AXUniqueId: "GenerateStrongPasswordButton",
                frame: { x: 36, y: 239.33, width: 330, height: 44 },
              },
            ],
          },
        ],
      },
    ],
  },
];

const find = (elements: AXElement[], label: string): AXElement | undefined => {
  for (const element of elements) {
    if (element.AXLabel === label) return element;
    const hit = find(element.children ?? [], label);
    if (hit) return hit;
  }
  return undefined;
};

test("translateRemoteSubtrees", async (t) => {
  // The bug this exists for, in one assertion: 239.33 + 22 = 261 is what the
  // tree said and where the tap landed (on "Login Submit"); 715.33 + 22 = 737
  // is where the button actually is.
  await t.test("rebases a hosted sheet's contents into screen space", () => {
    const button = find(
      translateRemoteSubtrees(autofillSheet()),
      "Fill Strong Password"
    );
    assert.deepEqual(button?.frame, {
      x: 36,
      y: 715.33,
      width: 330,
      height: 44,
    });
  });

  await t.test("moves every element of the subtree by the same offset", () => {
    const close = find(translateRemoteSubtrees(autofillSheet()), "Close");
    assert.equal(close?.frame?.y, 492);
    assert.equal(close?.frame?.x, 350.67); // x is untouched: the window is at x=0
  });

  await t.test("leaves the app's own elements alone", () => {
    const submit = find(translateRemoteSubtrees(autofillSheet()), "Login Submit");
    assert.deepEqual(submit?.frame, { x: 61, y: 256, width: 280, height: 30 });
  });

  // A full-screen picker is hosted exactly the same way, and its frames are
  // already correct. If this became a shift, every picker would break.
  await t.test("is a no-op when the hosting window is at the origin", () => {
    const tree: AXElement[] = [
      {
        type: "Application",
        frame: { x: 0, y: 0, width: 402, height: 874 },
        children: [
          {
            type: "Any",
            frame: { x: 0, y: 0, width: 402, height: 874 },
            children: [
              {
                type: "83",
                frame: { x: 0, y: 0, width: 402, height: 874 },
                children: [
                  {
                    type: "Button",
                    AXLabel: "Collections",
                    frame: { x: 201, y: 86, width: 95, height: 48 },
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    const collections = find(translateRemoteSubtrees(tree), "Collections");
    assert.deepEqual(collections?.frame, {
      x: 201,
      y: 86,
      width: 95,
      height: 48,
    });
  });

  // Real trees carry these next to the live one. Without the size guard each
  // would drag its subtree by its parent's whole origin.
  await t.test("ignores a boundary node that does not match its parent", () => {
    const tree: AXElement[] = [
      {
        type: "Any",
        frame: { x: 0, y: 476, width: 402, height: 340 },
        children: [
          {
            type: "83",
            frame: { x: 0, y: 0, width: 0, height: 0 },
            children: [
              {
                type: "Button",
                AXLabel: "Ghost",
                frame: { x: 10, y: 10, width: 40, height: 40 },
              },
            ],
          },
        ],
      },
    ];
    const ghost = find(translateRemoteSubtrees(tree), "Ghost");
    assert.deepEqual(ghost?.frame, { x: 10, y: 10, width: 40, height: 40 });
  });

  await t.test("leaves a boundary node with no parent alone", () => {
    const tree: AXElement[] = [
      {
        type: "83",
        frame: { x: 0, y: 0, width: 402, height: 874 },
        children: [
          {
            type: "Button",
            AXLabel: "Root child",
            frame: { x: 5, y: 5, width: 10, height: 10 },
          },
        ],
      },
    ];
    const child = find(translateRemoteSubtrees(tree), "Root child");
    assert.deepEqual(child?.frame, { x: 5, y: 5, width: 10, height: 10 });
  });

  // A host inside a host: the inner offset is measured against the outer one's
  // already-corrected parent, so the two compose instead of stacking.
  await t.test("composes nested hosts rather than accumulating them", () => {
    const tree: AXElement[] = [
      {
        type: "Any",
        frame: { x: 0, y: 100, width: 200, height: 200 },
        children: [
          {
            type: "83",
            frame: { x: 0, y: 0, width: 200, height: 200 },
            children: [
              {
                // Sits at y=50 inside the outer host, so y=150 on screen.
                type: "Any",
                frame: { x: 0, y: 50, width: 200, height: 150 },
                children: [
                  {
                    type: "83",
                    frame: { x: 0, y: 0, width: 200, height: 150 },
                    children: [
                      {
                        type: "Button",
                        AXLabel: "Inner",
                        frame: { x: 10, y: 20, width: 30, height: 30 },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    const inner = find(translateRemoteSubtrees(tree), "Inner");
    // 20 inside the inner host, which starts at 150 on screen.
    assert.equal(inner?.frame?.y, 170);
  });

  await t.test("does not mutate the tree it is given", () => {
    const original = autofillSheet();
    translateRemoteSubtrees(original);
    assert.equal(find(original, "Fill Strong Password")?.frame?.y, 239.33);
  });
});

test("locateInTree", async (t) => {
  // The corrected tree, as `translateRemoteSubtrees` leaves it.
  const corrected = () => translateRemoteSubtrees(autofillSheet());

  // What a point read at the button's true position returns: the right
  // element, carrying the frame it has 476 points further up the screen.
  const asPointRead = (): AXElement => ({
    type: "Button",
    AXLabel: "Fill Strong Password",
    AXUniqueId: "GenerateStrongPasswordButton",
    frame: { x: 36, y: 239.33, width: 330, height: 44 },
  });

  await t.test("recovers the screen-space frame by identifier", () => {
    const frame = locateInTree(corrected(), asPointRead(), 201, 737);
    assert.equal(frame?.y, 715.33);
  });

  await t.test("matches on label when there is no identifier", () => {
    const element = { ...asPointRead(), AXUniqueId: undefined };
    const frame = locateInTree(corrected(), element, 201, 737);
    assert.equal(frame?.y, 715.33);
  });

  // Fail closed: a candidate that does not cover the point is not the element
  // the caller hit, whatever it is called.
  await t.test("rejects a match that does not cover the point", () => {
    assert.equal(locateInTree(corrected(), asPointRead(), 201, 100), null);
  });

  await t.test("rejects a match of the wrong size", () => {
    const element = {
      ...asPointRead(),
      frame: { x: 36, y: 239.33, width: 100, height: 44 },
    };
    assert.equal(locateInTree(corrected(), element, 201, 737), null);
  });

  await t.test("returns null when the element is not in the tree", () => {
    const element = { ...asPointRead(), AXUniqueId: "NotOnScreen" };
    assert.equal(locateInTree(corrected(), element, 201, 737), null);
  });

  await t.test("declines to guess without a frame to match against", () => {
    const element = { ...asPointRead(), frame: undefined };
    assert.equal(locateInTree(corrected(), element, 201, 737), null);
  });
});

// Every case here is transcribed from a real incident, because the ranking
// exists to settle a specific recurring collision rather than in the abstract.
test("matchInTree ranking", async (t) => {
  // The one that started it: the fixture's status line, describing the switch
  // it had just flipped, outranked the switch itself.
  await t.test("an exact name beats a sentence containing it", () => {
    const hit = matchInTree(
      [
        {
          type: "Application",
          frame: { x: 0, y: 0, width: 402, height: 874 },
          children: [
            {
              type: "StaticText",
              AXLabel: "status: Settings Switch = on",
              frame: { x: 61, y: 252, width: 280, height: 20 },
            },
            {
              type: "Switch",
              AXLabel: "Settings Switch",
              AXValue: "1",
              AXUniqueId: "SettingsSwitch",
              frame: { x: 61, y: 427, width: 280, height: 40 },
            },
          ],
        },
      ],
      "Settings Switch"
    );
    assert.equal(hit?.AXUniqueId, "SettingsSwitch");
  });

  // Photos: `ui_find "Photo"` matched the notification alert's prose, which
  // appears earlier in the tree than the icon.
  await t.test("a control beats prose when neither is exact", () => {
    const hit = matchInTree(
      [
        {
          type: "Application",
          frame: { x: 0, y: 0, width: 402, height: 874 },
          children: [
            {
              type: "StaticText",
              AXLabel: '"Photos" Would Like to Send You Notifications',
              frame: { x: 20, y: 100, width: 360, height: 40 },
            },
            {
              type: "Button",
              AXLabel: "Photos",
              AXUniqueId: "Photos",
              frame: { x: 120, y: 288, width: 68, height: 90 },
            },
          ],
        },
      ],
      "Photo"
    );
    assert.equal(hit?.AXUniqueId, "Photos");
  });

  // Predictability matters more than cleverness once nothing separates them.
  await t.test("document order still breaks a genuine tie", () => {
    const hit = matchInTree(
      [
        {
          type: "Application",
          frame: { x: 0, y: 0, width: 402, height: 874 },
          children: [
            { type: "Button", AXLabel: "Go", AXUniqueId: "first", frame: { x: 0, y: 0, width: 10, height: 10 } },
            { type: "Button", AXLabel: "Go", AXUniqueId: "second", frame: { x: 0, y: 20, width: 10, height: 10 } },
          ],
        },
      ],
      "Go"
    );
    assert.equal(hit?.AXUniqueId, "first");
  });

  await t.test("a label still beats a value", () => {
    const hit = matchInTree(
      [
        {
          type: "Application",
          frame: { x: 0, y: 0, width: 402, height: 874 },
          children: [
            { type: "TextField", AXValue: "Search", frame: { x: 0, y: 0, width: 10, height: 10 } },
            { type: "StaticText", AXLabel: "Search", frame: { x: 0, y: 20, width: 10, height: 10 } },
          ],
        },
      ],
      "Search"
    );
    assert.equal(hit?.type, "StaticText");
  });

  // An identifier is a developer's name, so it is the last resort — but the
  // tree publishes it, and a caller handing one back should not get "not found".
  await t.test("falls back to an exact identifier", () => {
    const hit = matchInTree(
      [
        {
          type: "Application",
          frame: { x: 0, y: 0, width: 402, height: 874 },
          children: [
            {
              type: "Button",
              AXLabel: "Plain Stepper, Increment",
              AXUniqueId: "PlainStepper-Increment",
              frame: { x: 201, y: 793, width: 140, height: 32 },
            },
          ],
        },
      ],
      "PlainStepper-Increment"
    );
    assert.equal(hit?.AXLabel, "Plain Stepper, Increment");
  });
});

test("sameElement", async (t) => {
  const stepper = {
    type: "Button",
    AXLabel: "Plain Stepper, Increment",
    AXUniqueId: "PlainStepper-Increment",
    frame: { x: 201, y: 793, width: 140, height: 32 },
  };

  await t.test("an identifier settles it", () => {
    assert.equal(
      sameElement(stepper, { ...stepper, frame: { x: 0, y: 0, width: 1, height: 1 } }),
      true
    );
  });

  await t.test("so does a label, when there is no identifier", () => {
    assert.equal(
      sameElement(
        { type: "Button", AXLabel: "Nav Button", frame: { x: 271, y: 66, width: 111, height: 36 } },
        { type: "Button", AXLabel: "Nav Button", frame: { x: 271, y: 66, width: 111, height: 36 } }
      ),
      true
    );
  });

  // The common harmless disagreement: a point read returns the deepest element,
  // which for a button resolved by name is often that button's own text.
  await t.test("a descendant counts as the same element", () => {
    const button = { type: "Button", frame: { x: 61, y: 206, width: 280, height: 30 } };
    const innerText = { type: "StaticText", frame: { x: 159, y: 212, width: 83, height: 18 } };
    assert.equal(sameElement(button, innerText), true);
    assert.equal(sameElement(innerText, button), true);
  });

  // The case it exists for: the stepper's frame is real, but the toolbar's
  // search field is what is actually drawn over its centre.
  await t.test("a different element elsewhere does not", () => {
    const toolbarField = {
      type: "TextField",
      AXValue: "Toolbar Search",
      AXUniqueId: "ToolbarField",
      frame: { x: 226, y: 805, width: 142, height: 34 },
    };
    assert.equal(sameElement(stepper, toolbarField), false);
  });

  await t.test("no frames and no names is not a match", () => {
    assert.equal(sameElement({ type: "Any" }, { type: "Any" }), false);
  });
});

test("isToggle", async (t) => {
  // The two names the backends give the same control: the tree says Switch, a
  // point read says CheckBox, and a caller can hand us either.
  await t.test("recognises a switch from either backend's vocabulary", () => {
    assert.equal(isToggle({ type: "Switch", AXValue: "1" }), true);
    assert.equal(isToggle({ type: "CheckBox", AXValue: "0" }), true);
  });

  await t.test("accepts a numeric value", () => {
    assert.equal(isToggle({ type: "Switch", AXValue: 0 }), true);
  });

  // A button is pressed, not switched, and has no state to report back.
  await t.test("a button is not a toggle", () => {
    assert.equal(isToggle({ type: "Button", AXLabel: "Plain Button" }), false);
  });

  // The Split Switch case: the name resolves to the label, not the control.
  await t.test("static text is not a toggle", () => {
    assert.equal(isToggle({ type: "StaticText", AXLabel: "Split Switch" }), false);
  });

  await t.test("a switch with no value is not treated as one", () => {
    assert.equal(isToggle({ type: "Switch" }), false);
    assert.equal(isToggle({ type: "Switch", AXValue: null }), false);
  });

  await t.test("survives an element with no type at all", () => {
    assert.equal(isToggle({}), false);
  });
});

test("isRemotelyHosted", async (t) => {
  // The regression this exists for, measured on the home screen: a point at
  // x=200 hit-tests to the Health icon, whose frame ends at x=188.67. Treating
  // that as a coordinate-space error sent every such read on a ~300ms detour.
  await t.test("ordinary hit-slop is not a coordinate-space error", () => {
    const health = { x: 120.67, y: 389, width: 68, height: 90.67 };
    assert.equal(isRemotelyHosted(health, 200, 400), false);
  });

  // The autofill sheet's button, as the point read describes it, against the
  // point it was actually touched at.
  await t.test("a displaced frame is", () => {
    const local = { x: 36, y: 239.33, width: 330, height: 44 };
    assert.equal(isRemotelyHosted(local, 201, 737), true);
  });

  await t.test("a frame covering the point never is", () => {
    const frame = { x: 0, y: 0, width: 100, height: 100 };
    assert.equal(isRemotelyHosted(frame, 50, 50), false);
  });

  // A frame with no size carries no position to be wrong about, and offscreen
  // home-screen icons have one.
  await t.test("a zero-sized frame is not evidence", () => {
    const frame = { x: 0, y: 0, width: 0, height: 0 };
    assert.equal(isRemotelyHosted(frame, 200, 400), false);
  });

  await t.test("the boundary is the slop allowance", () => {
    const frame = { x: 0, y: 0, width: 10, height: 10 };
    assert.equal(isRemotelyHosted(frame, 10 + 44, 5), false);
    assert.equal(isRemotelyHosted(frame, 10 + 45, 5), true);
  });
});

test("distanceOutsideFrame", async (t) => {
  const frame = { x: 10, y: 20, width: 100, height: 50 };

  await t.test("is zero inside", () => {
    assert.equal(distanceOutsideFrame(frame, 50, 40), 0);
  });

  await t.test("measures the axis that misses by most", () => {
    assert.equal(distanceOutsideFrame(frame, 130, 40), 20);
    assert.equal(distanceOutsideFrame(frame, 50, 100), 30);
    assert.equal(distanceOutsideFrame(frame, 130, 100), 30);
  });

  await t.test("measures misses below and left too", () => {
    assert.equal(distanceOutsideFrame(frame, 0, 40), 10);
    assert.equal(distanceOutsideFrame(frame, 50, 0), 20);
  });
});

test("frameContains", async (t) => {
  const frame = { x: 10, y: 20, width: 100, height: 50 };

  await t.test("a point inside", () => {
    assert.equal(frameContains(frame, 50, 40), true);
  });

  await t.test("edges count as inside", () => {
    assert.equal(frameContains(frame, 10, 20), true);
    assert.equal(frameContains(frame, 110, 70), true);
  });

  await t.test("a point outside", () => {
    assert.equal(frameContains(frame, 9, 40), false);
    assert.equal(frameContains(frame, 50, 71), false);
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

  // This used to assert that the container won, on document order alone. It
  // now loses to the cell, and that is the intended change: a caller naming
  // something is going to act on it, an enclosing "Search results" group is not
  // somewhere to tap, and the container being first is an accident of nesting
  // rather than a reason. Document order still decides between equals — see the
  // ranking tests above.
  await t.test("a control beats the container that encloses it", () => {
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
    assert.equal(matchInTree(tree, "Search")?.AXUniqueId, "first");
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
