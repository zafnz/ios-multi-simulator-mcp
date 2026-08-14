/**
 * The accessibility tree, as data.
 *
 * Everything here is a pure function of its arguments: no simulator, no
 * companion, no network, no clock. That is the whole reason the module exists
 * separately from `src/index.ts`, which starts a server on import and so cannot
 * be loaded by a test.
 *
 * The rules below are not obvious and are not cheap to check by hand — which
 * elements survive pruning, how a dropped container's children are rehomed, what
 * counts as the same text when iOS renders a curly apostrophe. Verifying one
 * revision of the keep/drop rules against a real device cost four simulator
 * boots at ~3 minutes each, and a rule that was too lenient survived the first
 * two of them. Here they cost milliseconds; see `test/tree.test.ts`.
 *
 * Deliberately dependency-free, including on other modules in this repository:
 * that is what lets the test run the TypeScript directly under `node --test`
 * with nothing to build first.
 */

/** An accessibility element as the companion reports it. */
export type AXElement = {
  frame?: { x: number; y: number; width: number; height: number };
  AXLabel?: string | null;
  children?: AXElement[];
  [key: string]: unknown;
};

/** A rectangle in the tree's logical coordinate space. */
export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * True when the read carried no usable tree: either a 0x0 root, or no document
 * at all (the companion serializes an empty read as JSON `null`).
 */
export function isDegenerateTree(elements: AXElement[]): boolean {
  const root = elements[0];
  if (!root) return true;
  const frame = root.frame;
  return !!frame && !frame.width && !frame.height;
}

/**
 * The keys a rich screen read asks for.
 *
 * Deliberately not the companion's default set, which is both wider and
 * narrower than callers need. `frame` is the dictionary form and is what this
 * server computes with everywhere; `AXFrame` is the same rectangle rendered as
 * a string, so asking for both would pay twice for one fact. `AXValue` earns
 * its place because a control's visible text is not always its label — search
 * fields in particular come back with a null `AXLabel` and their text in
 * `AXValue`, and would be unidentifiable without it.
 *
 * Left out: `pid`, `help`, `title`, `subrole`, `content_required`,
 * `custom_actions`, `role_description` and `traits`. They are near-constant or
 * near-null across a screen, and this payload is read by a model on every call.
 */
export const DESCRIBE_KEYS = [
  "AXLabel",
  "frame",
  "AXValue",
  "AXUniqueId",
  "type",
  "enabled",
];

/**
 * Reduces an element to the one shape every tool returns.
 *
 * Enforced here rather than by asking the companion, because asking does not
 * work everywhere: `keys` is honoured for point and whole-screen reads and
 * ignored for marker queries, so `ui_find` came back with sixteen fields where
 * `ui_describe_point` came back with six, for the same element. The backends
 * also disagree with each other — the AX backend calls a tab
 * `role: "AXRadioButton"` with populated `traits`, axbridge calls it
 * `role: "Button"` with `traits: null` — so a caller keying off those fields saw
 * different data depending on which path answered. Picking the fields they agree
 * on, in one place, retires both problems; `type` carries what `role` was for.
 *
 * Null and empty values are dropped: a screen's worth of `"AXValue": null` is
 * noise, and their absence is as informative as their emptiness.
 */
export function canonicalise(element: AXElement): AXElement {
  const out: AXElement = {};
  for (const key of DESCRIBE_KEYS) {
    const value = element[key];
    if (value === null || value === undefined || value === "") continue;
    out[key] = value;
  }
  return out;
}

/** Roles that are worth reporting even with no label or identifier. */
const ACTIONABLE_TYPES = new Set([
  "Button",
  "Cell",
  "CheckBox",
  "ComboBox",
  "Link",
  "PopUpButton",
  "RadioButton",
  "ScrollBar",
  "SearchField",
  "SecureTextField",
  "Slider",
  "Stepper",
  "Switch",
  "TabButton",
  "TextArea",
  "TextField",
]);

/**
 * Types that mean nothing on their own — the boxes a layout is built out of.
 * A named one is still worth keeping; it is an anonymous one that is noise.
 */
const CONTAINER_TYPES = new Set(["Any", "Group", "Other", "Unknown"]);

/** An element a caller could plausibly act on or reason about. */
export function isInteresting(element: AXElement): boolean {
  const label = element.AXLabel;
  if (typeof label === "string" && label.trim()) return true;
  const value = element.AXValue;
  if (typeof value === "string" && value.trim()) return true;

  const type = String(element.type);
  if (ACTIONABLE_TYPES.has(type)) return true;

  // An identifier alone does not make an element worth reporting: UIKit gives
  // its internal layout groups identifiers too, and on a photo grid that is a
  // five-deep chain of anonymous `PX*-Group` nodes between the scroll view and
  // the images. Keep an identified element only where its type says it is a
  // real thing rather than a box.
  const id = element.AXUniqueId;
  return typeof id === "string" && !!id && !CONTAINER_TYPES.has(type);
}

/**
 * Drops the structural scaffolding from a tree, keeping what a caller can act
 * on. A dropped node's kept descendants are hoisted to its nearest kept
 * ancestor, so pruning never orphans a control — it only shortens the path to
 * it.
 *
 * This exists because the filter belongs on the companion and is not reachable
 * from here: idb has exactly this rule as
 * `FBAccessibilityElementFilter.interactable`, but the gRPC surface never sets
 * it, so every read arrives unfiltered. Doing it client-side costs a tree walk
 * we have already paid to receive, and saves the model reading the half of the
 * tree that is anonymous group containers.
 *
 * Each kept node is reduced to the shape every tool returns; see `canonicalise`.
 */
export function pruneTree(elements: AXElement[]): AXElement[] {
  const visit = (element: AXElement): AXElement[] => {
    const kept = (element.children ?? []).flatMap(visit);

    if (!isInteresting(element)) return kept;

    const out = canonicalise(element);
    if (kept.length) out.children = kept;
    return [out];
  };

  // The root is the screen itself and carries the frame callers measure
  // against, so it is kept whether or not it is interesting in its own right.
  return elements.flatMap((root) => {
    const children = (root.children ?? []).flatMap(visit);
    const out = canonicalise(root);
    if (children.length) out.children = children;
    return [out];
  });
}

/**
 * Folds away the differences between what a caller types and what iOS renders.
 *
 * A caller asking for "Don't Allow" types an ASCII apostrophe; iOS labels that
 * button `Don’t Allow` with U+2019, and the companion's substring match is
 * exact, so the lookup fails on a button that is plainly on screen. The same
 * goes for the quotes iOS puts around app names in permission dialogs, its en
 * and em dashes, and the non-breaking spaces that appear in laid-out text.
 *
 * Case is deliberately preserved: matching is documented as case-sensitive, and
 * this is meant to erase typography, not to widen what matches.
 */
export function normaliseForMatch(text: string): string {
  return text
    .replace(/[‘’‛ʼ]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[    ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Finds the element a caller means by `label`, matching typography-insensitively
 * against an element's label and its visible text.
 *
 * Label matches beat value matches wherever they appear in the tree, so naming
 * a control by its label does not lose to some other element that happens to
 * contain the same text in its value. Within one kind, the first in document
 * order wins.
 */
export function matchInTree(
  elements: AXElement[],
  label: string
): AXElement | null {
  const needle = normaliseForMatch(label);
  const labelHits: AXElement[] = [];
  const valueHits: AXElement[] = [];

  const visit = (element: AXElement) => {
    const [elementLabel, elementValue] = [
      element.AXLabel,
      element.AXValue,
    ].map((v) => (typeof v === "string" ? normaliseForMatch(v) : ""));

    if (elementLabel && elementLabel.includes(needle)) labelHits.push(element);
    else if (elementValue && elementValue.includes(needle))
      valueHits.push(element);

    for (const child of element.children ?? []) visit(child);
  };
  elements.forEach(visit);

  const hit = labelHits[0] ?? valueHits[0];
  return hit ? canonicalise(hit) : null;
}

/** The centre of an element's frame, in the tree's logical coordinate space. */
export function centreOf(
  element: AXElement
): { x: number; y: number } | null {
  const frame = element.frame;
  if (!frame || (!frame.width && !frame.height)) return null;
  return {
    x: frame.x + frame.width / 2,
    y: frame.y + frame.height / 2,
  };
}

/**
 * Collects all labeled, non-full-screen elements from the accessibility tree.
 */
export function collectProbeCandidates(
  els: AXElement[],
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
 * The candidates from `collectProbeCandidates` whose label appears exactly once
 * on the screen.
 *
 * Orientation detection works by asking "is this element where portrait would
 * put it, or where landscape would?", which only answers anything if the label
 * coming back identifies one element. A label that appears twice can answer yes
 * to both probes and would be read as ambiguous every time.
 */
export function uniquelyLabelled<T extends { label: string }>(
  candidates: T[]
): T[] {
  const counts = new Map<string, number>();
  for (const c of candidates) counts.set(c.label, (counts.get(c.label) || 0) + 1);
  return candidates.filter((c) => counts.get(c.label) === 1);
}
