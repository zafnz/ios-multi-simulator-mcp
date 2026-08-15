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
 * The keys a point read asks for: the shared set, plus `subrole`.
 *
 * `subrole` is never returned to a caller — `canonicalise` drops it, being
 * outside `DESCRIBE_KEYS` — and is asked for solely as evidence for
 * `reconcileType`. It costs nothing worth counting: a point read returns one
 * element, not a tree.
 */
export const POINT_KEYS = [...DESCRIBE_KEYS, "subrole"];

/**
 * Translates the point read's `type` into the vocabulary the tree uses.
 *
 * The two reads are served by different accessibility backends, and they name
 * the same element differently — the tree calls a search field `SearchField`
 * where a point read calls it `TextField`, a switch `Switch` against
 * `CheckBox`, a segment `Button` against `RadioButton`. An agent branching on
 * `type` would behave differently depending on which tool it happened to call,
 * which is exactly the inconsistency `canonicalise` was meant to end: that fix
 * settled which keys are present, not that their values agree.
 *
 * **`type` alone cannot be mapped**, which is why this takes the subrole too.
 * The point read calls a plain field and a search field both `TextField`, so
 * `TextField -> SearchField` would promote every text field on the screen. The
 * subrole is what separates them, and it is exact: `AXSearchField` appears on
 * the search field and on nothing else.
 *
 * Direction is deliberate. The tree's vocabulary wins because that is the read
 * agents navigate by; the point read is the outlier, and it is also the one
 * carrying the evidence to translate itself. The one thing lost is `Heading`,
 * which the point read knows and the tree does not — spending a real
 * distinction to buy consistency, because two tools disagreeing about one
 * element is worse than both being slightly coarse.
 */
export function reconcileType(
  type: unknown,
  subrole: unknown
): string | undefined {
  if (typeof type !== "string") return undefined;
  if (typeof subrole === "string") {
    const bySubrole: Record<string, string> = {
      AXSearchField: "SearchField",
      AXSwitch: "Switch",
      // A tab or segment: the tree calls both plain `Button`.
      AXTabButton: "Button",
    };
    const mapped = bySubrole[subrole];
    if (mapped) return mapped;
  }
  // No subrole to go on: the tree has no `Heading`, calling such text plain
  // `StaticText`.
  return type === "Heading" ? "StaticText" : type;
}

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
 * The element type that marks the boundary into a remote view's own coordinate
 * space.
 *
 * It is a bare number because it has no name: `type` is the normalised role,
 * and this role falls outside the vocabulary idb maps, so it arrives
 * stringified. Undocumented, and matched here anyway because it is the only
 * signal in the tree — `is_remote` is never emitted by the AXBridge backend,
 * and every node in a tree containing one of these still reports the host
 * application's `pid`. See `translateRemoteSubtrees`.
 */
const REMOTE_HOST_TYPE = "83";

/**
 * Rebases the contents of remote-hosted views into screen coordinates.
 *
 * iOS draws some UI — the "Use Strong Password?" autofill sheet, photo and
 * document pickers, share sheets — from a separate process, hosted inside the
 * app's window. Their elements arrive in one tree with the app's own, with
 * nothing distinguishing them, but their frames are measured from the hosting
 * window's origin rather than the screen's. One tree, two coordinate spaces.
 *
 * Untranslated, this is not a cosmetic error: `ui_tap {label}` resolves the
 * label to such a frame, taps its centre, and reports success while the touch
 * lands 476 points away on whatever the app has there — in the fixture, the
 * autofill sheet's "Fill Strong Password" tapped "Login Submit". The caller is
 * told it worked, and the tree that would contradict it is the same tree that
 * was wrong.
 *
 * The offset is not lost, though: at the boundary node the subtree restarts at
 * a local origin while the node's parent still describes that same region in
 * screen space. Both rectangles are the same size — they are the same region,
 * named twice — so the difference between their origins is exactly the
 * translation the subtree needs, and it costs a tree walk we have already paid
 * to receive rather than the round of hit-test probing it would otherwise take
 * to recover.
 *
 * That matching size is also the guard: the type alone is an undocumented
 * number, so it is required to agree with the geometry before anything moves.
 * A boundary node whose size does not match its parent's is left alone, as is a
 * root one, which has no parent to be measured against. When the hosting window
 * sits at the screen's origin the offset comes out zero and the walk is a no-op
 * — the common case for a full-screen picker, and the reason this cannot be
 * written as "sheets are wrong, shift them".
 *
 * Must run on the raw tree, before `pruneTree`: pruning drops anonymous
 * containers and hoists their children, which discards the very parent whose
 * origin this reads.
 */
export function translateRemoteSubtrees(elements: AXElement[]): AXElement[] {
  const shift = (frame: Frame, dx: number, dy: number): Frame => ({
    ...frame,
    x: frame.x + dx,
    y: frame.y + dy,
  });

  // Same rectangle to within the sub-point noise the tree is full of: frames
  // arrive as thirds of a point (44.333…), so an exact comparison would reject
  // rectangles that are equal in every sense that matters here.
  const sameSize = (a: Frame, b: Frame): boolean =>
    Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;

  const visit = (
    element: AXElement,
    dx: number,
    dy: number,
    parent: Frame | null
  ): AXElement => {
    const frame = element.frame;

    // A new local space starts here, so the inherited offset is replaced rather
    // than added to. `parent` is already in screen space, having been shifted
    // on the way down, which is what makes nested hosts fall out of the same
    // arithmetic instead of needing a special case.
    if (
      element.type === REMOTE_HOST_TYPE &&
      frame &&
      parent &&
      sameSize(frame, parent)
    ) {
      dx = parent.x - frame.x;
      dy = parent.y - frame.y;
    }

    const moved = frame ? shift(frame, dx, dy) : undefined;
    const out: AXElement = moved ? { ...element, frame: moved } : { ...element };
    if (element.children?.length) {
      out.children = element.children.map((child) =>
        visit(child, dx, dy, moved ?? parent)
      );
    }
    return out;
  };

  return elements.map((root) => visit(root, 0, 0, null));
}

/**
 * Whether an element is a toggle — something with an on/off state that a tap is
 * meant to flip.
 *
 * Keyed on what iOS says the element *is*, not on what produced it. A Settings
 * row and a bare `UISwitch` are built completely differently and both arrive
 * here as a switch; an app that ships its own toggle with the right traits does
 * too. The `AXValue` requirement is what keeps a plain button out: a button is
 * pressed, a toggle is switched, and only the second has a state to report back.
 *
 * `type` alone is not enough because the two backends name this differently —
 * the tree says `Switch`, a point read says `CheckBox` (see `reconcileType`) —
 * and a caller can hand us either.
 */
export function isToggle(element: AXElement): boolean {
  const type = typeof element.type === "string" ? element.type : "";
  if (type !== "Switch" && type !== "CheckBox" && type !== "Toggle") {
    return false;
  }
  const value = element.AXValue;
  return typeof value === "string" || typeof value === "number";
}

/** True when the point falls inside the frame, edges included. */
export function frameContains(frame: Frame, x: number, y: number): boolean {
  return (
    x >= frame.x &&
    x <= frame.x + frame.width &&
    y >= frame.y &&
    y <= frame.y + frame.height
  );
}

/**
 * How far outside its frame a point lies, along whichever axis misses by most.
 * Zero when the point is inside.
 */
export function distanceOutsideFrame(
  frame: Frame,
  x: number,
  y: number
): number {
  const dx = Math.max(frame.x - x, x - (frame.x + frame.width), 0);
  const dy = Math.max(frame.y - y, y - (frame.y + frame.height), 0);
  return Math.max(dx, dy);
}

/**
 * How far a hit-test may legitimately land outside the frame it reports.
 *
 * A control's touchable region is routinely larger than its accessibility
 * frame — Apple's own guidance is a 44pt minimum target, so a smaller control
 * can be hit up to ~22pt beyond each edge. Measured on the home screen: a point
 * at x=200 hit-tests to the Health icon, whose frame ends at x=188.67.
 *
 * This is a ceiling on ordinary overshoot, not a measurement of it, which is
 * why it is the full 44 rather than half. See `isRemotelyHosted`.
 */
export const HIT_SLOP = 44;

/**
 * Whether a point read's answer looks like it came from a remote-hosted view —
 * the same element, described in a coordinate space that is not the screen's.
 *
 * Distance is the whole test, and the margin is what makes it usable. "The
 * frame does not cover the point" alone is not evidence of anything: it is true
 * of any control whose touch target is bigger than its frame, which on the home
 * screen is every icon, and treating it as the signal made a ~10ms point read
 * cost ~310ms by sending it to look up an element that was never mislaid.
 *
 * A coordinate-space error is not a near miss. The autofill sheet's button is
 * reported 476 points from where it was touched; ordinary overshoot is a dozen.
 *
 * A frame with no size is not evidence either — it carries no position to be
 * wrong about, and offscreen elements have one.
 */
export function isRemotelyHosted(frame: Frame, x: number, y: number): boolean {
  if (!frame.width && !frame.height) return false;
  return distanceOutsideFrame(frame, x, y) > HIT_SLOP;
}

/**
 * Finds the corrected frame for an element a point read has located but
 * mislaid.
 *
 * A point read hit-tests, so it names the right element wherever it lives — but
 * it returns one element and no ancestry, and the ancestry is where the
 * translation in `translateRemoteSubtrees` comes from. For a control inside a
 * remote-hosted view it therefore answers with the local frame, which is how
 * this bug was first measured: a read at the button's true position returned
 * the button, still claiming to be 476 points higher up.
 *
 * The tree has the corrected frame, so the two are matched here. Identity comes
 * from the identifier or the label — not position, which is the thing in
 * dispute — and the candidate must also be the right size and actually cover
 * the point that was asked about. That last condition is what makes a wrong
 * answer fail closed: a screen with two identically-named buttons resolves to
 * the one under the caller's finger, or to neither.
 *
 * Returns null when nothing matches, leaving the caller to report the element
 * as the point read described it.
 */
export function locateInTree(
  elements: AXElement[],
  element: AXElement,
  x: number,
  y: number
): Frame | null {
  const wanted = element.frame;
  if (!wanted) return null;

  const id = element.AXUniqueId;
  const label = element.AXLabel;
  const identifies = (candidate: AXElement): boolean =>
    id != null && id !== ""
      ? candidate.AXUniqueId === id
      : label != null && label !== "" && candidate.AXLabel === label;

  let found: Frame | null = null;
  const visit = (candidate: AXElement): void => {
    if (found) return;
    const frame = candidate.frame;
    if (
      frame &&
      identifies(candidate) &&
      Math.abs(frame.width - wanted.width) < 1 &&
      Math.abs(frame.height - wanted.height) < 1 &&
      frameContains(frame, x, y)
    ) {
      found = frame;
      return;
    }
    for (const child of candidate.children ?? []) visit(child);
  };
  for (const root of elements) visit(root);
  return found;
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
  const idHits: AXElement[] = [];

  const visit = (element: AXElement) => {
    const [elementLabel, elementValue] = [
      element.AXLabel,
      element.AXValue,
    ].map((v) => (typeof v === "string" ? normaliseForMatch(v) : ""));

    if (elementLabel && elementLabel.includes(needle)) labelHits.push(element);
    else if (elementValue && elementValue.includes(needle))
      valueHits.push(element);
    // Last, because an identifier is a developer's name for a thing rather than
    // anything a user sees — but the tree publishes it, so a caller can quite
    // reasonably hand one back, and the marker query that would have caught it
    // cannot see the elements only this backend reaches.
    else if (element.AXUniqueId === label) idHits.push(element);

    for (const child of element.children ?? []) visit(child);
  };
  elements.forEach(visit);

  const hit =
    best(labelHits, needle) ?? best(valueHits, needle) ?? idHits[0];
  return hit ? canonicalise(hit) : null;
}

/**
 * Picks the likeliest of several elements matching the same text.
 *
 * Matching is substring, so a screen routinely offers more than one answer and
 * document order decides which — badly. Every instance of this so far has been
 * the same shape: a *description* of a control outranking the control. A status
 * line reading "Settings Switch = on" beat the switch it was describing; a
 * permission alert's sentence beat the Photos icon; a wizard's body text beat
 * the Collections tab. In each case the wanted element was named exactly and
 * the impostor merely contained the words.
 *
 * So: an exact name beats a partial one, and a control beats prose. Order
 * breaks the remaining ties, which keeps this predictable when nothing
 * distinguishes the candidates.
 *
 * Only reachable on the tree path. The companion resolves a marker query with
 * `elements.first`, server-side, and returns one element with no sign that
 * others matched — so on the fast path there is nothing here to choose between.
 */
function best(candidates: AXElement[], needle: string): AXElement | undefined {
  if (candidates.length < 2) return candidates[0];

  const score = (element: AXElement): number => {
    const text = [element.AXLabel, element.AXValue]
      .map((v) => (typeof v === "string" ? normaliseForMatch(v) : ""))
      .find((t) => t.includes(needle));
    let points = 0;
    if (text === needle) points += 2;
    if (ACTIONABLE_TYPES.has(String(element.type))) points += 1;
    return points;
  };

  return candidates.reduce((chosen, candidate) =>
    score(candidate) > score(chosen) ? candidate : chosen
  );
}

/**
 * Whether a hit-test landed on the element that was resolved by name.
 *
 * Deliberately lenient, because the two reads describe the same screen from
 * different angles and disagree in harmless ways: a point read returns the
 * deepest element under the point, which for a button resolved by its label may
 * be that button's own text. Identity first, then containment either way, which
 * covers the ancestor-and-descendant case without needing the tree to prove it.
 *
 * The case it must catch is the one it was written for: an element whose frame
 * is real but sits under a toolbar or below the fold, where the centre belongs
 * to something else entirely and the tap silently operates that instead.
 */
export function sameElement(a: AXElement, b: AXElement): boolean {
  const idA = a.AXUniqueId;
  const idB = b.AXUniqueId;
  if (typeof idA === "string" && idA && typeof idB === "string" && idB) {
    if (idA === idB) return true;
  }

  const labelA = typeof a.AXLabel === "string" ? normaliseForMatch(a.AXLabel) : "";
  const labelB = typeof b.AXLabel === "string" ? normaliseForMatch(b.AXLabel) : "";
  if (labelA && labelB && labelA === labelB) return true;

  const fa = a.frame;
  const fb = b.frame;
  if (!fa || !fb) return false;
  const encloses = (outer: Frame, inner: Frame) =>
    inner.x >= outer.x - 1 &&
    inner.y >= outer.y - 1 &&
    inner.x + inner.width <= outer.x + outer.width + 1 &&
    inner.y + inner.height <= outer.y + outer.height + 1;
  return encloses(fa, fb) || encloses(fb, fa);
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
