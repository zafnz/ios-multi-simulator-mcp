# The boot wedge: a simulator that renders, taps, and has no accessibility

Investigated 2026-08-13. **Cause unknown. Cure known and verified.**

A simulator boots, draws its home screen, responds to real taps, and answers
`describe` — while every accessibility read fails with:

```
INTERNAL: No translation object returned for simulator. This means you have likely
specified a point onscreen that is invalid or invisible due to a fullscreen dialog
```

It never recovers on its own. One was left for fifteen minutes and was still
dead. The error text is misleading in every particular: there is no fullscreen
dialog and no bad coordinate.

Roughly **1 in 4 to 1 in 5** freshly created simulators, in bursts rather than at
a steady rate.

## What it is not

Each of these was tested, not reasoned about.

| Suspect | Verdict | Evidence |
|---|---|---|
| Wedged `idb_companion` | **No** | A freshly spawned companion against the same device fails identically. |
| The companion bump `7c90442` → `da0f89a` | **No** | Old companion: 3 failures in 10. New: 3 in 12. Same fault, same rate. |
| The simulator being broken generally | **No** | It renders, it responds to taps, and `describe` returns state, OS and screen dimensions. |
| Polling accessibility during boot | **Probably not** | A controlled A/B — poll every 2s from boot vs leave alone 90s — came back 3/3 and 3/3. |
| Companion spawned too early | **Unresolved** — see below | |

Two of those were confidently asserted before being tested, and both were wrong.
The first draft of this investigation blamed a wedged companion on the strength
of a code comment written against the 2022 companion; the second blamed
boot-time polling. Neither survived contact with an experiment.

## What actually happens, in idb's terms

Reading `vendor/idb` at our pinned sha:

- The error is `noTranslationObject`, thrown at
  [FBAXTranslationDispatcher.swift:60](vendor/idb/FBSimulatorControl/Commands/FBAXTranslationDispatcher.swift:60)
  when `request.perform(withTranslator:)` returns nil. No element is produced at
  all.
- [FBSimulatorAccessibilityCommands.swift:150](vendor/idb/FBSimulatorControl/Commands/FBSimulatorAccessibilityCommands.swift:150)
  catches it, checks whether SpringBoard is a running launchd service, and — since
  ours *is* running — rethrows unchanged. **No remediation is attempted.**
- idb has the cure. `remediateSpringBoard` stops `com.apple.CoreSimulator.bridge`.
  But `remediationRequired` only reaches for it when the root element has a zero
  frame **and** its owning pid is dead ("SpringBoard has crashed"). Our shape —
  nil translation, SpringBoard alive — is excluded.

Confirmed on a wedged device: `SpringBoard` alive (pid 88904), and
`com.apple.CoreSimulator.bridge` alive (pid 88783).

Worth noting this predicate gap probably *does* explain a different symptom — a
0x0 tree returned as a successful read on a healthy device — which is a separate
bug with a separate history. The two are easy to conflate and are not the same.

## The cure

```bash
xcrun simctl spawn <udid> launchctl stop com.apple.CoreSimulator.bridge
```

Verified end to end on a wedged simulator: bridge pid moved 88783 → 89967, and
within ~5 seconds `ui_view`, `ui_find` and `ui_tap` all worked. The device and
its installed apps were untouched — no erase, no recreate.

This is strictly better than the previous advice, which was to destroy and
recreate the simulator at the cost of every installed app.

## Still unresolved

**Why the bridge wedges.** Everything below is mitigation, not a fix.

**Whether early contact is implicated.** This is the one hypothesis neither
confirmed nor killed, and the evidence genuinely points both ways:

| Condition | Result |
|---|---|
| No settle, via MCP | 3 failures / 12 |
| No settle, old companion, via MCP | 3 failures / 10 |
| 8s settle, via MCP | 0 failures / 20 |
| Settle removed again, via MCP | 0 failures / 10, then a failure on the 11th |
| Harness spawning a companion immediately, polling from t=0 | **2 failures / 4** |

Twenty clean boots with the settle looked conclusive until ten clean boots
without it did not. The arithmetic that made 20/20 look like a 0.3% coincidence
assumed a stable base rate; the rate is plainly bursty, which makes that
reasoning worthless. The most aggressive harness — companion spawned instantly,
polled from t=0 — did produce the worst rate seen, which is why the mitigation
is kept.

**Whether concurrency matters.** Failures clustered as booted simulators
accumulated, and boot times climbed with them (29–41s with one at a time, 48s
with four). But the first failure in that run happened with nothing else booted,
so concurrency is not necessary.

**Why `simctl erase` was previously recorded as the cure while a reboot was not.**
That note predates this investigation and describes the 0x0 symptom, not this
one. Untested here.

## Mitigations in place

1. **Auto-recovery.** When a simulator has not answered accessibility and the
   boot budget is nearly spent, the bridge is restarted once and polling
   continues. Logged in verbose mode.
2. **`simctl bootstatus -b`** replaces a fixed sleep with CoreSimulator's own
   signal. Measured to return **3.7s and 5.5s before** accessibility is ready, so
   gating on it does not overshoot. Capped at 30s, because it has been measured
   from 26s to 54s under load.
3. **An 8-second settle** before first contact. Kept because it is nearly free,
   *not* because it is proven — see above.
4. **A bounded return.** `start_simulator` now returns within 55s whatever
   happens. It previously waited up to 180s, which exceeded the MCP client's
   patience: the call was cancelled, and the caller got no UDID, no session, and
   no idea a simulator existed. Returning honestly at 55s with a UDID and an
   instruction to poll is strictly more useful.
5. **`diagnoseEmptyAccessibilityTree` attempts the bridge restart** before
   suggesting anything expensive.
6. **A bug-report prompt.** If recovery fails, the message tells the agent to ask
   the user to file an issue, because that has not yet been observed.
7. **Recovery mid-session, not only at boot.** Every accessibility read —
   whole-screen, marker lookup, point read, and so every tool built on them —
   goes through one wrapper that restarts the bridge and retries once when a
   read fails with `no translation object`. Recovery is deliberately refused for
   a simulator that has never answered a read, because that is a device still
   booting and item 1 already owns it; and it is refused for 60s after an
   attempt, because a wedged simulator under an agent fails every few hundred
   milliseconds and restarting under each failure would leave the bridge
   permanently mid-restart. The rules are a pure function, `shouldRecover` in
   [src/ax/recovery.ts](src/ax/recovery.ts), and are unit tested.

   The boot wedge is what this file is about, but nothing says the bridge can
   only wedge at boot; before this, a session that wedged mid-run got a clearer
   error and no cure from any tool except `ui_describe_all` and `ui_view`.

   **`no translation object` does not mean the bridge is wedged.** idb raises
   the same error for a point read that found nothing, which is an ordinary
   answer on a healthy simulator, so `describePoint` tells the two apart by
   asking for the whole screen before anything is restarted. Worth knowing when
   reading logs from a session: a burst of this error from point reads alone is
   usually a caller with bad coordinates, not a sick simulator.

**Still not reproducible on demand.** `launchctl stop` on a healthy bridge does
not produce this fault: launchd brings the service straight back and the next
read waits ~700ms and succeeds. The wedge is a bridge that is running and not
translating, which stopping a working one does not simulate. That is why the
recovery decision is unit tested and the cure is verified against real
occurrences rather than an induced one.

## Worth reporting upstream

`remediationRequired` gates idb's own working cure behind a predicate that
excludes the case it would fix. A retry on zero-frame-with-live-pid, or
attempting remediation for `noTranslationObject` when SpringBoard is alive, would
let idb self-heal without any of the above.

## If you hit this

Verbose mode logs it:

```
simulator <udid> has not answered accessibility for 40s after boot completed
(74s total); restarting com.apple.CoreSimulator.bridge to recover
```

If recovery does not work, that is new. Capture the UDID, whether `describe`
succeeds, and whether SpringBoard and the bridge are alive:

```bash
xcrun simctl spawn <udid> launchctl list | grep -E "SpringBoard|CoreSimulator.bridge"
```
