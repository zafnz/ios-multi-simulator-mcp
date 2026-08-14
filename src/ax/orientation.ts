/**
 * Rotation, as arithmetic.
 *
 * Pure like `tree.ts`, and split out for the same reason: this is the code that
 * decides where a tap lands, it is wrong in a way no type checker can see, and
 * checking it against a device costs a simulator boot per revision.
 *
 * The one thing to hold on to while reading: callers work in **logical**
 * coordinates — what an agent sees on screen, and what `ui_describe_all`
 * reports — while the companion accepts input in **portrait** coordinates
 * whatever the device is doing. Everything here exists to cross that gap in one
 * place. See the note in CLAUDE.md and `transformPointToPortrait` below.
 */

export type Orientation =
  | "auto"
  | "portrait"
  | "landscape_right"
  | "upside_down"
  | "landscape_left";

/**
 * Determines the effective orientation for a session given the screen dimensions.
 * Uses the cached detected orientation if available, otherwise falls back to
 * simple width/height comparison (which can't distinguish landscape_right from
 * landscape_left, or portrait from upside_down).
 */
export function getEffectiveOrientation(
  orientation: Orientation,
  screenWidth: number,
  screenHeight: number
): Orientation {
  if (orientation !== "auto") return orientation;
  return screenWidth > screenHeight ? "landscape_right" : "portrait";
}

/**
 * Transforms a logical-space point (x, y) to portrait space for companion input.
 * screenW/screenH are the logical dimensions from describe_all (e.g. 1376x1032 for landscape).
 */
export function transformPointToPortrait(
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
 * The two orientations a screen of this shape could be in.
 *
 * A root frame wider than it is tall settles that the device is on its side,
 * but not which side; the two candidates are what `detectOrientation` then
 * tells apart by probing. Ordered so the more common of each pair is tried
 * first, which is also the answer returned when probing proves nothing.
 */
export function candidateOrientations(isLandscape: boolean): Orientation[] {
  return isLandscape
    ? ["landscape_right", "landscape_left"]
    : ["portrait", "upside_down"];
}
