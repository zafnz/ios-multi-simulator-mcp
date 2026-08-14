import test from "node:test";
import assert from "node:assert/strict";

import type { Orientation } from "../src/ax/orientation.ts";
import {
  candidateOrientations,
  getEffectiveOrientation,
  transformPointToPortrait,
} from "../src/ax/orientation.ts";

// An iPhone 17 Pro on its side, in logical coordinates: this is what
// describe_all reports and what a caller's coordinates are in. Portrait space —
// what the companion accepts — is the same screen 402 wide by 874 tall.
const W = 874;
const H = 402;

test("getEffectiveOrientation", async (t) => {
  await t.test("a detected orientation is used as given", () => {
    for (const o of ["portrait", "upside_down", "landscape_left", "landscape_right"] as const) {
      assert.equal(getEffectiveOrientation(o, W, H), o);
    }
  });

  // "auto" can only read the shape of the screen, which is why detect_rotation
  // exists: it cannot tell left from right, or portrait from upside down.
  await t.test("auto guesses from the shape of the screen", () => {
    assert.equal(getEffectiveOrientation("auto", 874, 402), "landscape_right");
    assert.equal(getEffectiveOrientation("auto", 402, 874), "portrait");
  });

  await t.test("a square screen is treated as portrait", () => {
    assert.equal(getEffectiveOrientation("auto", 500, 500), "portrait");
  });
});

test("transformPointToPortrait", async (t) => {
  await t.test("portrait and auto pass the point straight through", () => {
    assert.deepEqual(transformPointToPortrait(10, 20, "portrait", 402, 874), { x: 10, y: 20 });
    assert.deepEqual(transformPointToPortrait(10, 20, "auto", 402, 874), { x: 10, y: 20 });
  });

  await t.test("upside down reflects both axes", () => {
    assert.deepEqual(transformPointToPortrait(10, 20, "upside_down", 402, 874), {
      x: 392,
      y: 854,
    });
  });

  await t.test("the landscapes rotate opposite ways", () => {
    // Same logical point, one quarter turn apart.
    assert.deepEqual(transformPointToPortrait(100, 50, "landscape_right", W, H), {
      x: 50,
      y: 774,
    });
    assert.deepEqual(transformPointToPortrait(100, 50, "landscape_left", W, H), {
      x: 352,
      y: 100,
    });
  });

  // The property that matters more than any single point: a rotation maps the
  // screen onto the screen. If a transform ever sent a corner outside portrait
  // space, taps near that edge would land off-screen or on the wrong control.
  await t.test("every corner of the screen lands on a corner of portrait space", () => {
    const corners = [
      { x: 0, y: 0 },
      { x: W, y: 0 },
      { x: 0, y: H },
      { x: W, y: H },
    ];

    for (const orientation of ["landscape_left", "landscape_right"] as const) {
      const mapped = corners.map((c) =>
        transformPointToPortrait(c.x, c.y, orientation, W, H)
      );
      // Portrait space is H wide and W tall — the logical dimensions swapped.
      assert.deepEqual(
        new Set(mapped.map((p) => `${p.x},${p.y}`)),
        new Set([`0,0`, `${H},0`, `0,${W}`, `${H},${W}`]),
        `${orientation} should map the four corners onto the four corners`
      );
    }
  });

  await t.test("the centre of the screen stays the centre", () => {
    for (const orientation of [
      "portrait",
      "upside_down",
      "landscape_left",
      "landscape_right",
    ] as const) {
      const centre = transformPointToPortrait(W / 2, H / 2, orientation, W, H);
      const expected =
        orientation === "portrait" || orientation === "upside_down"
          ? { x: W / 2, y: H / 2 }
          : { x: H / 2, y: W / 2 };
      assert.deepEqual(centre, expected, `${orientation} moved the centre`);
    }
  });

  // detect_rotation reads a label back from the point it computed, so a
  // transform that is not injective would make two orientations answer alike.
  await t.test("distinct points stay distinct", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: W, y: H },
    ];
    for (const orientation of [
      "portrait",
      "upside_down",
      "landscape_left",
      "landscape_right",
    ] as const) {
      const mapped = points.map((p) =>
        JSON.stringify(transformPointToPortrait(p.x, p.y, orientation, W, H))
      );
      assert.equal(new Set(mapped).size, points.length, `${orientation} collapsed two points`);
    }
  });
});

test("candidateOrientations", async (t) => {
  await t.test("offers the two the screen shape cannot tell apart", () => {
    assert.deepEqual(candidateOrientations(true), ["landscape_right", "landscape_left"]);
    assert.deepEqual(candidateOrientations(false), ["portrait", "upside_down"]);
  });

  // detect_rotation returns the first candidate when probing settles nothing,
  // so this order has to agree with what "auto" would have guessed.
  await t.test("the first candidate is what auto would have said", () => {
    const shapes: { isLandscape: boolean; w: number; h: number }[] = [
      { isLandscape: true, w: 874, h: 402 },
      { isLandscape: false, w: 402, h: 874 },
    ];
    for (const { isLandscape, w, h } of shapes) {
      const fallback: Orientation = candidateOrientations(isLandscape)[0];
      assert.equal(fallback, getEffectiveOrientation("auto", w, h));
    }
  });
});
