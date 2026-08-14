import test from "node:test";
import assert from "node:assert/strict";

import { isWedgeError, shouldRecover } from "../src/ax/recovery.ts";

// The message idb actually raises, in full. Its wording blames coordinates and
// a dialog; neither is ever the cause.
const WEDGED =
  "INTERNAL: No translation object returned for simulator. This means you have " +
  "likely specified a point onscreen that is invalid or invisible due to a " +
  "fullscreen dialog";

const decision = (over: Partial<Parameters<typeof shouldRecover>[0]> = {}) => ({
  answered: true,
  message: WEDGED,
  msSinceLastAttempt: Number.POSITIVE_INFINITY,
  cooldownMs: 60_000,
  ...over,
});

test("isWedgeError", async (t) => {
  await t.test("matches the real message", () => {
    assert.equal(isWedgeError(WEDGED), true);
  });

  await t.test("matches however the message is cased or wrapped", () => {
    assert.equal(isWedgeError("no translation object"), true);
    assert.equal(
      isWedgeError("Error tapping on the screen: NO TRANSLATION OBJECT returned"),
      true
    );
  });

  // The message is ambiguous and this predicate deliberately does not resolve
  // it: idb says exactly this when a point read finds nothing, which is an
  // ordinary answer. `describePoint` separates the two before asking.
  await t.test("matches the empty-point case too — resolved by the caller", () => {
    assert.equal(
      isWedgeError(
        "INTERNAL: No translation object returned for simulator. This means you " +
          "have likely specified a point onscreen that is invalid"
      ),
      true
    );
  });

  // Restarting a service cures none of these, and doing it anyway would cost
  // the caller five seconds and a disrupted guest for nothing.
  await t.test("does not match unrelated failures", () => {
    for (const message of [
      "found no element matching label 'Continue'",
      "Unable to connect to idb_companion",
      "Invalid device: no such udid",
      "axbridge could not resolve the frontmost application's pid",
      "",
    ]) {
      assert.equal(isWedgeError(message), false, `should not match: ${message}`);
    }
  });
});

test("shouldRecover", async (t) => {
  await t.test("recovers a simulator that worked and then stopped", () => {
    assert.equal(shouldRecover(decision()), true);
  });

  // The distinction the whole gate exists for. A fresh simulator raises exactly
  // this error for its first ~40 seconds, and the boot wait is already holding
  // its own budget for the same cure -- restarting the bridge underneath it
  // would fight it for a device that is doing nothing wrong.
  await t.test("never recovers a simulator that has not answered yet", () => {
    assert.equal(shouldRecover(decision({ answered: false })), false);
  });

  await t.test("ignores errors a restart cannot cure", () => {
    assert.equal(
      shouldRecover(decision({ message: "found no element" })),
      false
    );
  });

  await t.test("holds off inside the cooldown", () => {
    assert.equal(shouldRecover(decision({ msSinceLastAttempt: 0 })), false);
    assert.equal(shouldRecover(decision({ msSinceLastAttempt: 59_999 })), false);
  });

  await t.test("tries again once the cooldown has passed", () => {
    assert.equal(shouldRecover(decision({ msSinceLastAttempt: 60_000 })), true);
    assert.equal(shouldRecover(decision({ msSinceLastAttempt: 120_000 })), true);
  });

  // A simulator that has never been recovered must not be treated as one that
  // was recovered a moment ago, which is what a 0 default would have meant.
  await t.test("a first failure is not inside any cooldown", () => {
    assert.equal(
      shouldRecover(decision({ msSinceLastAttempt: Number.POSITIVE_INFINITY })),
      true
    );
  });

  await t.test("every gate is independently sufficient to refuse", () => {
    assert.equal(
      shouldRecover(
        decision({ answered: false, message: "boom", msSinceLastAttempt: 0 })
      ),
      false
    );
  });
});
