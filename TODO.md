# TODO — Code Review Findings

## Bugs

- [x] **#1** `record_video` promise silently swallows failures — fixed: track process in `activeRecordings`, properly reject on close/error, prevent duplicates, `stop_recording` uses tracked handle
- [x] **#2** `ui_view` temp files never cleaned up — fixed: `finally` block cleans up all temp files; eliminated unnecessary portrait `copyFileSync`
- [x] **#3** Troubleshooting link points to wrong repo — fixed: `joshuayoes/` → `zafnz/`
- [x] **#4** ~~No `--` separator in `launch_app` and `install_app`~~ — Not a bug: simctl doesn't support `--` as an option terminator (treats it as a literal argument)
- [x] **#5** No signal handling — fixed: shared `shutdown()` wired to SIGINT/SIGTERM/stdin close, also kills active recordings

## Code Smell / Anti-patterns

- [x] **#6** Massive boilerplate repetition — fixed: extracted `handleToolError` wrapper, all 15 handlers use it
- [x] **#7** Inconsistent simulator lookup — fixed: renamed `getManagedSimulatorId` → `getManagedSim` returning full `SimSession` object, all inline `.get()` + null checks replaced
- [x] **#8** `getScreenDimensions` duplicates `describe-all` IDB call on every tap/swipe/describe_point — fixed: cached `screenDims` in `SimSession`, populated by `ui_describe_all`/`ui_view`/`getScreenDimensions`, invalidated on `detect_rotation`
- [x] **#9** `getIdbPath()` does `fs.existsSync` on every call — fixed: resolved once at startup as `idbPath` constant
- [x] **#10** Typo: `collectProbeCandiates` → `collectProbeCandidates` — fixed
- [x] **#11** `require("../package.json")` for version — fixed: read via `fs.readFileSync` at startup
- [x] **#12** Session ID allows dangerous characters — fixed: regex restricted to `[a-zA-Z0-9_-]+`
- [x] **#13** `ui_view` copies file unnecessarily in portrait — fixed as part of #2
- [x] **#14** `cleanupAllSimulators` runs sequentially — fixed: uses `Promise.allSettled` to shutdown/delete all owned sims in parallel
- [x] **#15** Recording processes not tracked — fixed as part of #1

## Minor

- [x] **#16** ~~`run()` always trims output~~ — Won't fix: all callers expect trimmed output (JSON parsing, UDID extraction, etc.); no current use case where trailing whitespace matters
- [x] **#17** ~~`open -a Simulator.app` on every start~~ — Won't fix: `open -a` is idempotent (brings to front if already running), cost is one lightweight subprocess; removing it would risk the simulator window not being visible after create+boot

# TODO — Observed 2026-08-12

Found while exercising the running server end-to-end (start → describe → view → destroy), not by reading source.

## Boot race

- [ ] **#18** `start_simulator` returns before the simulator is actually usable. It reported success for an iPhone 17 Pro, but `ui_describe_all` and `ui_view` both failed for ~40s afterwards; once booted, both worked first try. Either poll for readiness inside `start_simulator` before returning, or make the return value say plainly that the sim is not yet ready.
- [ ] **#19** The error surfaced during that window is misleading: idb's `INTERNAL: No translation object returned for simulator. This means you have likely specified a point onscreen that is invalid or invisible due to a fullscreen dialog`. It blames invalid coordinates and a fullscreen dialog, neither of which is the cause. An agent hitting it will chase the wrong problem. Map this idb error to a "simulator still booting, retry" message.
  - Related but distinct symptom: the `describe-all` empty-tree case (0x0 root frame), where the fix is `simctl erase`. Worth distinguishing the two in whatever error mapping gets added.

## Schema accuracy

Both cosmetic — the server behaves correctly, the advertised schema just under-describes it.

- [ ] **#20** `ui_tap` marks only `id` as required, with `label`, `x` and `y` all optional, so "label **or** coordinates" is enforced only at runtime. A client validating against the schema alone would think a bare `{id}` tap is valid. Consider expressing the choice in the schema (oneOf / two variants).
- [ ] **#21** Inconsistent param types for the same concept: `ui_swipe.duration` and `ui_tap.duration` are strings with a numeric pattern (`^\d+(\.\d+)?$`) while `ui_swipe.delta` is a plain number. Easy to get wrong on first use.

# TODO — TESTING.md run, 2026-08-12

Found while working through TESTING.md step-by-step on an iPhone 17 Pro (root frame 402x874).

## Product bugs

- [ ] **#22** **`ui_describe_all` returns an incomplete tree.** On the Settings screen it reports the bottom `Toolbar` group at `{{0, 788}, {402, 86}}` with `"children": []`, but `ui_describe_point(200, 821)` resolves a real `AXTextField` / subrole `AXSearchField` at `{{33, 803}, {336, 38}}`, `AXValue: "Search"`. The two tools disagree about the same screen.
  - Fails **silently** — an empty `children` array is indistinguishable from a legitimately empty container, so an agent concludes the element does not exist.
  - The server's own tool instructions direct agents to `ui_describe_all` when they don't know what's on screen, so this undermines the documented navigation path.
  - Label-based fallback does not help here: the field's `AXLabel` is `null` (the word "Search" is its `AXValue`), so `ui_find` / `ui_tap {label}` have nothing to match. Worse, `ui_find "Search"` resolves to the *Settings menu row* at y=692 — a different element — so an agent can tap the wrong thing and not notice.
  - **Reproduced in a second app (Contacts).** Same shape: `Toolbar` at `{{0, 788}, {402, 86}}` with `"children": []`, while `ui_describe_point(170, 822)` returns an `AXSearchField` at `{{33, 803}, {276, 38}}`. The visible "+" (add contact) button in that same toolbar is likewise absent from the tree. So this is systematic, not a Settings quirk — the bottom toolbar's contents are consistently missing.
  - **Unresolved:** not yet known whether the omission originates in this server's tree handling or in idb's `accessibility_info` response. Needs a source-level look. The fact that it is specifically the bottom `Toolbar` group in both apps is the strongest available clue.
- [ ] **#29** **Far worse case of #22: an entire screen can come back empty.** In Contacts, with the search field focused and "Kate" typed (results visibly on screen), `ui_describe_all` returns the *whole app* as two childless groups:
  ```
  Group "Search results" {{0, 0}, {402, 874}}  children: []
  Group "Toolbar"        {{0, 788}, {402, 86}} children: []
  ```
  Everything visible — the "Top Name Matches" header, the "Kate Bell" row, the search field, the clear/cancel buttons — is absent. Meanwhile `ui_describe_point(100, 130)` cleanly returns `AXStaticText` "Kate Bell" at `{{2, 100}, {384, 60}}`.
  - Whatever causes #22 is not limited to toolbars: any container can come back childless, and here it swallowed the entire content area. Severity is higher than #22 as originally written.
  - **The error message actively misleads.** `ui_tap {label: "Kate Bell"}` fails with *"No element found whose label contains 'Kate Bell'. Use ui_describe_all to see what is on screen."* — but `ui_describe_all` shows nothing either. The recovery advice leads into a dead end, and an agent following it would reasonably conclude the app is empty or broken.
  - Suggests the bug may relate to freshly-presented / transient UI (a search-results overlay that has just appeared), rather than to a specific control type. Worth testing whether a delay or a re-query returns a populated tree.
- [ ] **#23** Consider whether `ui_find` should match on `AXValue` as well as `AXLabel`, or at least report when an element matched by value was skipped. Related to #22 — several real controls carry their visible text in `AXValue` with a null `AXLabel`.

## TESTING.md defects

> **All of the below were fixed in TESTING.md on 2026-08-12.** Part 1 was re-based onto Contacts (page 2 of the home screen, reached by the swipe test, and free of first-run wizards); the search-results swipe was removed; Part 2 gained step #24.5 to dismiss the two Photos wizards and was retargeted at "Collections" and the overflow menu. Part 1 was renumbered to still end at #22 so Part 2 keeps its original #23–#34 numbering. Kept here as a record of what was wrong.

- [ ] **#24** "Wait ~10 seconds for the simulator to fully boot" (steps #1, #20, #23) is wrong — observed ~40s on this machine. Stale in three places. If #18 is fixed by making `start_simulator` block until ready, these should be deleted rather than re-timed.
- [ ] **#25** Step #7 says to tap "the search field" in Settings, which is ambiguous: Settings has both a search text field in the bottom toolbar and a "Search" settings row. Name the target precisely.
- [ ] **#26** Step #26 is a manual step ("Hardware > Rotate Left") that an agent cannot perform — no rotation tool is exposed by the server, and driving the Simulator app directly is forbidden by CLAUDE.md. All of Part 2 (#27–#33, the entire landscape coordinate verification) depends on it. Either the plan documents it as human-in-the-loop, or a rotation tool needs to exist.
- [ ] **#27** Steps #16/#17 have no fixture: `install_app` takes "`<path to a .app bundle>`" and `launch_app` "`<bundle id of installed app>`", but the plan never names one and the repo does not appear to ship one. Not runnable as written.
- [ ] **#28** `ui_find` is not covered anywhere in TESTING.md — the plan's own coverage table lists 15 tools, the server advertises 16.
- [ ] **#30** Steps #9–#11 are flaky by construction. #9 asserts that searching "General" in Settings shows "filtered search results", but Settings search depends on a background index that is not built on a freshly-created simulator — observed **No Results for "General"** on a sim a few minutes old. #10 then swipes "to scroll the results" and #11 asserts the list scrolled, both of which are unverifiable against an empty state. Retarget the swipe at something reliably scrollable (the Settings root list, or the home screen) instead of search results.
  - Aside worth knowing: tapping the Settings search field suggests "Apps", "Developer" etc., yet searching for those also returns nothing until the index builds. The suggestions are not backed by the same index.
- [ ] **#31** Step #7 does not account for the first-run **QuickPath keyboard overlay** ("Speed up your typing by sliding your finger…" + Continue), which covers the keyboard on a fresh simulator. It turned out to be harmless — `ui_type` still delivered text and the overlay dismissed itself — but the step's stated expectation ("the keyboard appears") does not match what a tester actually sees.
- [ ] **#32** Step #17 says `launch_app` output "includes PID". It does not — actual output is `App com.apple.mobileslideshow launched successfully`. Either the message regressed or the doc was written against an older version.
- [ ] **#33** Part 2 assumes Photos opens straight into its browsing UI, but on a fresh simulator it opens a **"What's New in Photos"** onboarding screen with a Continue button. Step #25 ("Screenshot shows the Photos app in portrait") passes only in the most literal sense, and step #29's suggested targets ("a tab bar button like 'Albums' or 'For You'") do not exist on that screen — and may no longer match this iOS version's Photos layout even after dismissal. Part 2 needs re-basing on a current, wizard-free app; **Contacts** worked well for Part 1 and supports landscape.

- [ ] **#34** Further instances of #22/#29 in Photos (landscape), and the sharpest evidence yet of what the bug is:
  - `Tab Bar` group `{{0, 338}, {874, 64}}` → `"children": []`, hiding the Library/Collections tabs.
  - `Nav bar` group `{{0, 24}, {874, 54}}` → `"children": []`, hiding the title and the `...` overflow button.
  - **`ui_find(label: "Collections")` returned "No element found" for an element whose `AXLabel` is literally `"Collections"`** — `ui_describe_point(205, 360)` returns it as `AXRadioButton` / `AXTabButton`, `AXUniqueId: "CollectionsTab"`, `AXLabel: "Collections"`. So the defect is not about elements lacking labels; the tree walk simply never descends into these containers. Any label-based navigation silently fails for anything inside one.
  - Pattern so far: the affected containers are the system chrome groups — `Toolbar`, `Tab Bar`, `Nav bar` — plus freshly-presented views (#29). A plausible shared cause is that these are hosted in separate UI scenes/windows that the tree walk does not recurse into.

## Root cause of #22 / #29 / #34 — investigated 2026-08-12

**Diagnosis: the elements are missing a parent→child edge in Apple's AX translation graph. They are not hidden, not truncated, and not dropped by idb or by us.**

Evidence, all gathered by probing the companion's `accessibility_info` directly (bypassing the MCP) on the Photos Library screen:

| Question | Answer | Evidence |
|---|---|---|
| Is the tree truncated? | **No** | `format: COMPLETE` reports `truncated=false`, `modal=null`, `backend="ax"`. `FBAXTranslationRequest.swift:351` — the AX path "walks the live element tree with no depth or node" bound. `FBAXReadLimits` (50/3000) applies only to the axbridge/XCUI backends. |
| Is it the `depth` gotcha from DESIGN.md §5c? | **No** | Already handled: `MARKER_DEFAULT_DEPTH = 50` in [client.ts:70](src/idb/client.ts:70). Explicit `depth: 50` still fails. |
| Is idb dropping the children? | **No** | `axChildren()` is a straight pass-through to Apple's `accessibilityChildren()` ([FBAXPlatformElement.swift:106](vendor/idb/FBSimulatorControl/Commands/FBAXPlatformElement.swift:106)), and the recursion in `FBAXNodeSerializer` applies no bound. |
| Does asking the container directly help? | **No** | `accessibility_info(point: <tab bar>, format: NESTED)` — which returns an element *with its whole subtree* — returns `Group "Tab Bar"` with `kids=0`. The children are unreachable from any entry point. |
| Is it a regression from our newer companion? | **No** | The **2022 brew companion 1.1.8** returns a byte-identical tree on the same simulator and screen: same 8 children, same childless `Tab Bar`, same hit-test results. |
| Is Apple deliberately hiding it? | **No** | The elements are *fully* exposed via hit-test, with labels **and** stable automation identifiers — `RadioButton "Library"` `uid=LibraryTab`, `"Collections"` `uid=CollectionsTab`, `"Search"` `uid=SearchTab`, `Button "Sort and Filter"` `uid=sortFilterButton` — all in the **same pid** as the app. Nothing is obfuscated or withheld; there is simply no edge from the container to them. |

What the whole-screen read actually returns for Photos Library — 9 nodes, `maxDepth=1`:

```
Application "Photos" pid=62065 kids=8
  Group ""         {0,62  402x54} kids=0   <- nav bar: title, "6 Photos", Sort and Filter, Select all missing
  Image "Photo" x6 {...}          kids=0
  Group "Tab Bar"  {0,791 402x83} kids=0   <- Library / Collections / Search all missing
```

Hit-testing that same screen finds every one of the missing controls, same pid, fully labelled. So the tree is not a view of a simpler screen — it is a graph with edges missing.

- [ ] **#35** Mitigation available now: **fall back to a grid hit-test when a marker query misses.** idb already does exactly this for *other* processes (`discoverRemoteElements` in `FBAXTranslationRequest.swift`, grid-stepped `translator.object(at:)`), but it skips `hitPid == frontmostPid`, so it never covers this same-pid case — and the option is not on the wire anyway. Doing it client-side in `findByLabel` would make `ui_find` / `ui_tap {label}` work for tab bars, nav bars and toolbars. Cost is one RPC per probed point, so step coarsely and only on miss.
  - A coverage-grid subtlety to avoid repeating: the childless container *claims* its whole frame, so any "skip points already covered" optimisation would skip exactly the region that needs probing.
- [ ] **#36** The real fix is the **AXBRIDGE backend**, which walks the app's real view hierarchy (DESIGN.md §5c: 280 nodes / 43 labelled, vs 14 / 14 for AX). **It currently cannot start in our build**: every request fails with `axbridge could not resolve the frontmost application's pid`. `Resources/SimulatorFrameworkBridge` *is* present in the cached distribution, so it is not the packaging gap DESIGN.md warned about. Setting `ApplicationAccessibilityEnabled` and relaunching the app — the remedy the error itself prescribes — did **not** help, nor did posting `com.apple.accessibility.cache.ax` / `.app.ax`. Unresolved; needs the guest-side service investigated.
- [ ] **#36a** **Upstream has already fixed the #36 blocker — 2 days after our pinned sha.** Checked 2026-08-12; our submodule is at `7c90442`, upstream `main` is `da0f89a`, **140 commits ahead**.
  - **`39025e9` "Resolve the frontmost application, not the owner of the centre pixel"** (Aug 11) is exactly our failure. The old code hit-tested the screen centre and took whatever owned that pixel; it now asks the window server which application is frontmost. The commit names our case outright: *"Nothing at the anchor and the read fails outright, though the frontmost application is perfectly nameable. A screen mid-transition, **an app whose accessibility tree is not up yet**, or a layout whose centre falls between elements all produce a read that could have succeeded."* Applies to the `AXBRIDGE` and `AXBRIDGE_PERSISTENT` gRPC backends. `--frontmost-method center-point` keeps the old behaviour.
  - **`e0ad2bf` "Recommend ApplicationAccessibilityEnabled only where it is the cause"** explains the wild goose chase: that remediation was appended to unrelated failures, and upstream notes *"its being wrong two times in three is what taught people to skip it on the one where it is right."* We followed it; it was never our cause.
  - **`49a4514` / `9392228`** raise the guest's failure kind and reason as typed errors, so the specific `failureReason` stops being flattened into one generic string — which was going to be step 2 of the guest-side investigation.
  - Also in those 140 commits: tap/scroll/set-value **writes** over axbridge, element frames over axbridge, and frame-coverage reporting on every backend.
  - **Toolchain is unchanged**, so the bump is low-risk: `IDBAPI.swiftinterface` pins Swift 6.3.3 at both our sha and upstream HEAD, `.xcode-version` says 26.6, and Xcode 26.6 / Swift 6.3.3 is what is installed.
  - **Next step:** bump the submodule to `da0f89a` (or anything ≥ `39025e9`), rebuild the companion (~20–30 min), re-run the probe. If AXBRIDGE then resolves the frontmost app, #22/#29/#34 are fixed by switching `ui_describe_all` / `ui_find` to that backend.
- [x] **#36c RESOLVED.** `companion.lock.json` now pins `da0f89a`, committed by CI. Release `companion-da0f89a-xcode26.6` is published; the tarball downloads, its sha256 matches the lock exactly (`bb10bd54…`), and it contains `Resources/SimulatorFrameworkBridge` — without which a downloaded companion loses AXBridge silently and everything above stops working. Users without a local build now get the fix.
- [ ] **#48** `npm run verify:download` cannot verify the download on a machine that has built the companion locally. `resolveOnce` prefers `vendor/idb/Build/Distribution` over the lock, so the script resolves to the local build, never fetches the URL, and then fails its own "cached under its content hash" assertion — reporting VERIFICATION FAILED for a lock that is perfectly correct. The one machine most likely to run the check is the one where it cannot work. Either have the script set `IOS_SIMULATOR_MCP_COMPANION_PATH= ` and temporarily ignore the local build, or teach it to skip that assertion and say why.
- [x] **#36c-orig** ~~`companion.lock.json` goes stale the moment the submodule is bumped.~~ [companionBinary.ts:170](src/idb/companionBinary.ts:170) prefers a locally built companion over the download, and its comment justifies that with *"It is the same sha, so this is not a compatibility compromise"* — which stops being true after a bump. With the submodule at `da0f89a` and the lock still pinning the old build, a developer who has built locally and a user who has not are running **different companions**, and only the former gets the fix. Regenerate and republish the lock (and update that comment) once the axbridge fix is confirmed.
- [ ] **#36b** **Upstream issue [facebook/idb#892](https://github.com/facebook/idb/issues/892) "Searchbar is missing from UI description"** — open since 2025-10-24, no replies. Same symptom, independently reported: a `.searchable` bar in a nav bar, and the posted JSON shows `role_description: "Nav bar"` with `"children": []`, exactly like ours.
  - **This refines the conclusion in the table above.** The reporter shows the field *is* visible in Apple's own **Accessibility Inspector**. So the element is present in Apple's accessibility hierarchy — it is specifically the `AXPTranslator` parent→child traversal idb uses that fails to surface it, not the hierarchy itself. Still not deliberate concealment and still not idb discarding it, but more tractable than "Apple will not give it to us": a different traversal (axbridge) should reach it.
  - Worth adding our findings to #892 once axbridge is confirmed — it is the same bug and currently has no response.
- [ ] **#37** Not a bug, but worth documenting: when a **system modal** is up (e.g. the notifications permission alert), the frontmost application *is the alert's process*, so `ui_describe_all` correctly returns only the alert's tree (pid 59695) and the app underneath vanishes entirely. That tree is fully populated. Agents should expect the app to disappear from the tree while a permission dialog is showing, rather than read it as the tree bug.
- [ ] **#38** `ui_find` / `ui_tap {label}` do exact substring matching, so **typographic characters bite**: the permission button is labelled `Don’t Allow` with U+2019, and an ASCII `Don't Allow` finds nothing. Consider normalising curly quotes/apostrophes and dashes on both sides of the comparison. Fixed in TESTING.md; the tool behaviour is unchanged.

## CONFIRMED FIX — submodule bumped and companion rebuilt, 2026-08-12

Submodule moved `7c90442` → `da0f89a` (includes `39025e9`). `./build.sh generate-proto` then `npm run build:companion`: **BUILD SUCCEEDED, zero patches**, on Xcode 26.6 / Swift 6.3.3. Distribution assembled with `Resources/SimulatorFrameworkBridge`. Verified by spawning the new companion directly against a booted simulator (Photos, Library tab, portrait) — no MCP restart needed to test.

**AXBRIDGE now works, and it sees everything the AX backend cannot:**

| read | bytes | ms | nodes | depth | "Collections" |
|---|---|---|---|---|---|
| `AX` NESTED (what `ui_describe_all` sends today) | 3 763 | 63 | 9 | 1 | **ABSENT** |
| `AXBRIDGE` COMPLETE, full | 23 459 | 311 | 80 | 18 | **FOUND** `{113,795 96x54}` |
| `AXBRIDGE` COMPLETE, `keys:[AXLabel,AXFrame]` | 7 561 | 304 | — | — | FOUND |
| `AXBRIDGE` NESTED, `keys:[AXLabel,AXFrame]` | **6 378** | 298 | — | — | FOUND |

Marker lookups over AXBRIDGE — every control that `ui_find` could not previously see:

```
Collections      OK  410B 303ms      Sort and Filter  OK  382B 287ms
Library          OK  464B 294ms      Select           OK  391B 289ms
Search           OK  338B 292ms      ZZZnope          clean "found no element" error
```

The frames match the hit-test results exactly, so the coordinates are directly usable.

### Benchmarked properly, 5 runs each, Photos Library portrait (warm figures)

**Earlier figures in this file were wrong and are corrected here.** The "~60ms" quoted for `ui_find` was a *describe-all*, not a marker query; and "+70%" for describe-all only holds for a two-key read.

| operation | AX | AXBRIDGE | AXBRIDGE_PERSISTENT |
|---|---|---|---|
| marker hit (element AX can see) | **15 ms** / 352 B | 304 ms / 325 B | 304 ms / 325 B |
| marker miss (element AX cannot see) | 40 ms / **wrong answer** | **304 ms / correct** | 301 ms / correct |
| describe-all, full | 49 ms / 3 763 B | 307 ms / 28 379 B | 302 ms / 28 379 B |
| describe-all, `keys[AXLabel,AXFrame]` | — | — | 299 ms / 6 378 B |
| describe-all, `keys[6]` | — | — | 305 ms / 11 641 B |
| describe-all, `keys[8]` | — | — | 307 ms / 13 961 B |
| point read (`ui_describe_point`) | **8 ms** / 447 B | — | 242 ms / 397 B |

Two results that change the plan:

- **`AXBRIDGE_PERSISTENT` buys nothing.** Identical to `AXBRIDGE` on every measurement — the ~300 ms is per-read work, not per-connection setup, so there is no warm-up to amortise. Do not reach for it expecting a speedup.
- **`ui_describe_point` must stay on AX.** 8 ms vs 242 ms — 30× faster — *and* it already resolves the elements the tree walk misses, because it hit-tests. Switching it would be a pure 30× regression for no gain.

- [x] **#39 IMPLEMENTED** in `findByLabel` ([index.ts:100](src/index.ts:100)) — AX first, AXBRIDGE only on miss, and any AXBridge failure degrades to "not found" rather than surfacing an axbridge error (which matters while `companion.lock.json` still ships a companion that cannot start the backend — see #36c). Builds clean.
  - **Verified end-to-end, clean.** On a settled Photos Library screen (both wizards dismissed), `ui_find "Collections"` now returns the real tab-bar button — `AXUniqueId: "CollectionsTab"`, frame `{112.67, 795, 95.67, 54}` — where it previously returned "No element found", and `ui_tap {label: "Collections"}` navigated to the Collections view. The exact case that started this investigation.
  - Test-harness lesson worth keeping: scripted setup against Photos is unreliable because the What's New sheet and the notifications alert race, and substring matching produces false positives while they are up (`"Photo"` matches *"Photos" Would Like to Send You Notifications*; `"Collections"` matches the wizard's own body text). Assert on the frontmost application, not on a label.
- [ ] **#43** **The ~285 ms AXBridge cost is a per-call guest process spawn, and cannot be amortised from our side.** Measured on a settled screen, medians over 6 runs: AX hit **13 ms**; AX miss 41–69 ms; AXBRIDGE **291 ms on a hit and 289 ms on a miss** — flat, so it is fixed overhead rather than tree-walking work. `AXBRIDGE_PERSISTENT` is no better (279–282 ms).
  - **Why persistent does not persist:** `uiAutomation(backend:)` constructs a **fresh transport per call** ([FBUIAutomation.swift:248](vendor/idb/FBSimulatorControl/Commands/FBUIAutomation.swift:248)), so `FBAXBridgePersistentTransport`'s "spawn the guest once (`accessibility serve <socket>`)" is once per gRPC request. Nothing the client can set changes this.
  - The earlier "470 ms" was load noise from a concurrent build; steady state is **~330 ms for a miss** (41 + 289) and ~360 ms for an AXBridge hit.
  - Upstream fix would be to cache the transport per simulator, which would drop the fallback to roughly a socket round-trip. Deferred with #42 — no upstream patching for now.
- [x] **#44 DECIDED: leave the fallback automatic and unconditional.** Rationale: the tools are driven by an agent that knows only what the tool descriptions say, so the default must be the one most likely to give a correct answer; ~300 ms is an acceptable price for that. No flag, no per-tool asymmetry, nothing for the caller to get wrong.
  - Consequence handled: `SERVER_INSTRUCTIONS` claimed `ui_find` was "safe to poll while waiting for a screen", which is no longer true at ~330 ms a miss. Replaced with an accurate note that also warns about the trap that actually bites a naive agent — `ui_describe_all` omitting whole containers, so "not in the tree" does not mean "not on screen".
- [ ] **#44-orig** ~~Decide where the miss cost is acceptable.~~ The only regression is the *absent-label* case: 41 ms → ~330 ms. That matters because the server's own tool description advertises `ui_find` as cheap enough "to poll while waiting for a screen" — polling is exactly the absent case, so a poll loop is now ~8x more expensive. An AX hit is unchanged at 13 ms, and an AXBridge hit was previously impossible, so neither of those regressed. Options:
  - leave it (simple; polling gets slower),
  - add `deep?: boolean` so a caller polling can opt out — but the default then decides whether the original bug is back,
  - or fall back automatically for `ui_tap` (where a miss blocks the agent) and make it opt-in for `ui_find` (where "absent" is a normal answer).
- [ ] **#45** Backend shape difference worth knowing: an AXBridge match returns `role: "Button"`, `traits: null`, `role_description: null`, where the AX backend returns `role: "AXRadioButton"`, populated `traits` and `role_description` for the same element. Callers keying off `role`/`traits` will see different values depending on which backend answered.
- [ ] **#39-orig** **`ui_find` / `ui_tap {label}`: try AX first, fall back to AXBRIDGE on miss** — *not* the blanket switch previously written here. A blanket switch costs 15 ms → 304 ms (**20×**) on every lookup that already worked. The fallback keeps the common case at 15 ms and pays ~344 ms (40 ms miss + 304 ms) only where the answer is currently *wrong*:
  - AX-visible element: 15 ms, unchanged.
  - AX-invisible element: ~344 ms and correct, versus 40 ms and "No element found".
  - Residual risk to note in the code: if AX returns a *different* element that also substring-matches, the fallback never runs and the wrong element is tapped. Substring matching makes that plausible (`"Search"` matched two different things during testing).
- [x] **#40 IMPLEMENTED — and it costs almost nothing.** New `describeScreen()` ([index.ts](src/index.ts)) serves `ui_describe_all` from AXBRIDGE with a restricted key set, then prunes client-side. Measured like-for-like on the Photos Library screen:

  | | bytes | nodes | depth | complete |
  |---|---|---|---|---|
  | AX (previous) | 3 763 | 9 | 1 | **no** |
  | AXBRIDGE + keys + pruned | **3 906** | **25** | 3 | **yes** |

  **+4% payload for 2.8x the nodes and a tree that is actually complete** — the client-side pruning paid for essentially the whole AXBridge overhead. ~350 ms. Verified against a screenshot taken in the same moment: tree and screen agree exactly, and `Collections`, `Library`, `Search`, `Select` and `Sort and Filter` are all present where they were previously absent.

  Three things made it cheap:
  - **`keys`** — dropped `pid`, `help`, `title`, `subrole`, `content_required`, `custom_actions`, `role_description`, `traits`, and crucially `AXFrame`, which is the same rectangle as `frame` rendered as a string. Every node was carrying both.
  - **Client-side pruning** (`pruneTree`) — idb's own `.interactable` rule, reimplemented here because #42 is not reachable over gRPC: keep an element with a label, a value, an actionable type, or a *non-container* identifier; hoist a dropped node's kept descendants so nothing is orphaned.
  - **Dropping null/empty fields** — a screen's worth of `"AXValue": null` is pure noise.

  An identifier alone deliberately does not rescue a generic container: UIKit gives its internal layout groups identifiers too, and on the photo grid that was a five-deep `PX*-Group` chain between the scroll view and the images. Excluding `Any`/`Group`/`Other`/`Unknown` took the tree from depth 7 to depth 3.

  Internal callers (`detectOrientation`, `getScreenDimensions`, `ui_view`) deliberately still use the cheap AX `describeAll` — they only read `elements[0].frame`, and making them pay ~300 ms for a rectangle they already had would be a pointless regression.

  Falls back to the AX read if AXBridge cannot start, so a companion older than the pinned one still works (see #36c).
- [ ] **#46** One observation worth watching, not yet explained: on a run where the What's New sheet had just been dismissed, its elements (`"What's New in Photos"`, `Continue`) were still present in the AXBridge tree alongside the Collections content. A later clean run showed no such residue and matched its screenshot exactly, so this looks like a transient during sheet teardown rather than AXBridge reporting invisible views — but it is one observation either way. If agents start tapping controls that are not on screen, start here.
- [ ] **#40-orig** **`ui_describe_all`: AXBRIDGE + `keys`, behind a flag.** The honest cost is bigger than first stated — a realistic key set is **3–3.7× today's payload**, not +70%:
  - `keys[AXLabel,AXFrame]` → 6 378 B (1.7×), but too thin for the current tool output.
  - `keys[6]` (`+AXUniqueId, role, type, enabled`) → 11 641 B (3.1×).
  - `keys[8]` (`+traits, AXValue`) → 13 961 B (3.7×) — closest to what `src/index.ts` consumes today.
  - Full tree → 28 379 B (7.5×). Never the default.
  - `keys` is a strict allowlist and an unrecognised key is a hard `INVALID_ARGUMENT`, so the set must be derived from real usage in `src/index.ts`, not guessed.
  - Suggested shape: keep AX as the default, and expose the rich read as an explicit opt-in — either an env flag or a `deep: true` parameter — so an agent reaches for it when the cheap tree does not contain the target.
- [ ] **#42** **The optimisation we actually want is not on the wire: `FBAccessibilityElementFilter.interactable`.** It keeps only elements with a label, an identifier, or an actionable role, drops unlabelled structural containers, and in nested output hoists a dropped container's matching descendants ([FBAccessibilityRequestOptions.swift:42](vendor/idb/FBControlCore/Commands/FBAccessibilityRequestOptions.swift:42)). That is precisely the filter that would make an AXBRIDGE tree cheap enough to be the default.
  - **It is CLI-only.** `AccessibilityInfoRequestTranslation.options(from:)` builds `FBAccessibilityRequestOptions` without `filter:`, so gRPC always gets `.all`, and `AccessibilityInfoRequest` has no `filter` field — confirmed at `da0f89a`.
  - Rough estimate of the win: 23 of 80 nodes on the test screen carried a label, so `.interactable` plausibly keeps ~30 and could bring a `keys[8]` read from ~14 KB toward ~5 KB. **Not measured** — it cannot be measured without the field existing.
  - Fix is small: add `filter` to the proto and pass it through in `options(from:)`. Worth an upstream PR; per DESIGN.md's "fork only once you accumulate a patch", this would be the first real candidate.
  - `profile` and `collect_frame_coverage` *were* added to the proto in this bump — so our generated client needs `npm run gen:proto` to see any new field.
- [ ] **#41** With AXBRIDGE available, revisit the `isDegenerateTree` / companion-restart workaround in `describeAll` ([index.ts:83](src/index.ts:83)) and the 0x0-frame heuristic. `COMPLETE` reports `truncated` and `modal` as explicit fields, so the MCP can read a fact instead of inferring one from a degenerate frame.

## Architecture — revisit the single-file rule (discussed 2026-08-12, deferred)

- [ ] **#47** **Extract the pure logic out of `src/index.ts` and put tests on it.** Not a general "split the architecture" — a narrow move, ~200 lines, with no change to the tool surface.
  - **Why the original rule has expired:** CLAUDE.md mandates one file, and the strongest reason was cheap merges from `joshuayoes/ios-simulator-mcp`. Upstream's last commit is **2026-01-23** (dormant ~7 months), and `src/index.ts` is now **2 193 lines against upstream's 1 030**, diverged **+1 663 / −500** — roughly two-thirds ours. Any future upstream merge is a manual reconciliation whether the code is in one file or six.
  - **What still argues for one file:** whole-surface comprehension in a single read (though ~25 k tokens now, no longer free), no import graph for a small server, and the rule's value as a guard against churn. These are real but weaker than they were.
  - **The concrete cost, hit during this session:** there is **no test script and no test framework** in the project. `pruneTree`, `isInteresting`, `transformPointToPortrait`, `isDegenerateTree`, `centreOf` and the orientation math are pure functions with real logic (keep/drop rules, descendant hoisting, coordinate mapping), all module-private in a file that starts a server on import. Verifying the #40 pruning rules took **four simulator boots at ~3 minutes each**, and a too-lenient identifier rule survived the first two. Unit tests would have caught it in milliseconds.
  - **Suggested shape:** move those into `src/ax/tree.ts` (or similar) and test with **`node:test`** — built in, zero new dependencies, which keeps faith with the project's minimal-dependency principle.
  - **Explicitly not proposed:** splitting the 16 tool registrations into per-tool modules. They are repetitive, they benefit from sitting together, and that split would be churn for its own sake.

## Upstream may soon publish companions itself — watch this

- [ ] **#49** `da0f89a` — the very sha we pinned — is **"Add a tag-triggered release workflow"**, landed 2026-08-12. Pushing a `v*` tag to `facebook/idb` now builds the full distribution on `macos-26`, packages `idb-companion.universal.tar.gz` + sha256, cuts a **prerelease** for human promotion, and prints the `url`/`sha256` lines for bumping the `idb-companion` homebrew formula.
  - **Changes nothing today.** It fires only on `v*` tags, and the newest tag is still **v1.1.8 (2022)** — the workflow has never run.
  - **If Meta resumes tagging, this deletes our biggest standing cost.** Their tarball is the same `Build/Distribution` layout we produce, so consuming it is a drop-in: point `companion.lock.json` at their release URL and sha256, and delete our `build-companion.yml` entirely. DESIGN.md's one unresolved objection to Option B — "you own a companion build nobody upstream tests" — goes away.
  - **But it would pin us to their tags, not arbitrary shas.** The fix this whole investigation needed (`39025e9`) landed one day before HEAD and is untagged; on a tags-only diet we would still be waiting. Likely shape: consume upstream releases by default, keep the local build path for when a fix has not been tagged yet.
  - Their release is a **prerelease**, so anything consuming it automatically has to opt into prereleases or wait for promotion.
- [ ] **#50** **Upstream's release artifact is misnamed: `idb-companion.universal.tar.gz` is arm64-only.** `build.sh` hardcodes `ARCHS=arm64` unconditionally in `common_settings` ([build.sh:276](vendor/idb/build.sh:276)) with the comment "build arm64 only (no Intel/x86_64 slices)", and `./build.sh build all` is exactly what `release.yml` runs. Verified against our own build of the same script: `lipo -archs` reports `arm64` for both `idb_companion` and `Resources/SimulatorFrameworkBridge`. Anyone on an Intel Mac who installs that tarball — or the homebrew formula it feeds — gets a binary that cannot run. Worth an upstream issue; it also means their release would not close our own Intel gap.

## Verified working

- [x] **Landscape coordinate transformation is correct.** With the device rotated left, `detect_rotation` returned `landscape_left`, and coordinates taken from landscape space tapped their intended targets: Library tab at (87.5, 360) switched to Library, Collections tab at (192.5, 360) switched back, and the nav bar `...` at (751, 46) opened the overflow menu. Round-tripped, so not a coincidence of an already-selected tab.

## Coverage achieved in the 2026-08-12 run

Passed: `start_simulator`, `destroy_simulator` (both owned and detach paths), `attach_simulator`, `ui_describe_all` (with #22/#29/#34 caveats), `ui_describe_point`, `ui_tap` (coordinates **and** label), `ui_type`, `ui_swipe`, `ui_view`, `screenshot` (119KB PNG, 1206x2622), `record_video` + `stop_recording` (5.6MB file), `launch_app`, `detect_rotation` (`landscape_left`, after a human performed the rotation).

`ui_find` exercised but **failed** on a validly-labelled element — see #34.

Never exercised: `install_app` (#27, no fixture).
