/**
 * When to reach for the cure, as a decision.
 *
 * The cure itself — stopping the guest's `com.apple.CoreSimulator.bridge` so
 * launchd brings up a fresh one — is three lines of `simctl` in `index.ts`.
 * What is not simple is deciding *when*, and getting that wrong is expensive
 * in both directions: too eager and every simulator that is merely slow to boot
 * gets its bridge restarted out from under the boot wait; too shy and a wedged
 * session stays dead for the rest of its life. Both failures cost a simulator
 * boot to observe, which is why the rule lives here where a test can reach it.
 *
 * Pure and dependency-free, like its siblings in this directory; the state it
 * reasons about is held in `index.ts` and passed in.
 */

/**
 * The error every accessibility read raises once the bridge has wedged.
 *
 * idb's wording blames coordinates and a fullscreen dialog — "you have likely
 * specified a point onscreen that is invalid or invisible due to a fullscreen
 * dialog" — which is why this matches on the one part of the message that
 * actually identifies the condition.
 *
 * **This error is ambiguous, and this function does not resolve it.** idb
 * raises the same message for a point read that found nothing, which is an
 * ordinary answer on a perfectly healthy simulator. Only a point read can mean
 * that, so `describePoint` tells the two apart — by asking for the whole screen,
 * which has no such ambiguity — before anything here is consulted. Treating
 * every instance of this message as a wedge would have a caller's simulator
 * restarted for the crime of tapping an empty patch of screen.
 */
export function isWedgeError(message: string): boolean {
  return /no translation object/i.test(message);
}

export interface RecoveryDecision {
  /** Has this simulator ever served a usable accessibility read? */
  answered: boolean;
  /** The failure being considered. */
  message: string;
  /** Milliseconds since the last restart of this simulator's bridge. */
  msSinceLastAttempt: number;
  /** Shortest interval allowed between two attempts. */
  cooldownMs: number;
}

/**
 * Whether a failed accessibility read is worth restarting the bridge for.
 *
 * Three questions, in the order that makes each cheap:
 *
 *  - **Is this the wedge?** Only one error means the bridge is not answering.
 *    Anything else — a bad argument, a dead companion, a simulator that has
 *    been deleted — is not cured by restarting a service.
 *  - **Has this simulator ever worked?** A device that has never answered is
 *    booting, not broken; the boot wait owns that case and has its own budget
 *    for the same cure. Without this, every fresh simulator would have its
 *    bridge restarted within a second of the first tool call.
 *  - **Was this just tried?** A wedged simulator under an agent produces a
 *    failure every few hundred milliseconds, and restarting under each one
 *    leaves it permanently mid-restart, which looks exactly like the fault it
 *    is meant to fix.
 */
export function shouldRecover({
  answered,
  message,
  msSinceLastAttempt,
  cooldownMs,
}: RecoveryDecision): boolean {
  if (!isWedgeError(message)) return false;
  if (!answered) return false;
  return msSinceLastAttempt >= cooldownMs;
}
