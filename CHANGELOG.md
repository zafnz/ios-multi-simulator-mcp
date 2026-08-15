# Changelog

## 2.2.0

### Taps are held long enough to land

Every tap this server has ever sent was a touch-down and a touch-up in the same
instant, and UIKit does not reliably see one. Measured against a switch in
Settings, tapping the control itself: **5 of 12** instantaneous taps actuated it,
against **12 of 12** with a 0.1s hold. The 2022 companion behaves the same
(1 of 10 against 10 of 10), so this was never a regression in some version — it
is what a zero-length touch has always been worth, and the likeliest explanation
for any tap that reported success and changed nothing.

Every tap is now held for at least 0.1s, whatever the caller asks for. That is
well under UIKit's 0.5s long-press threshold, so nothing that was a tap becomes
one. `ui_tap` by coordinate now costs 100–150ms, essentially all of it the hold.

### A tap that cannot land says so, instead of reporting success

`ui_tap {label}` now checks the touch will reach the element before sending it,
with a hit-test costing ~10ms against a tap that costs ~110ms.

The case this exists for: an element whose frame is perfectly correct but which
is covered, below the fold, or scrolled out of view. Its centre belongs to
whatever is drawn on top. In this project's own fixture, tapping the stepper's
increment button by name focused the toolbar's search field, opened the
keyboard, and answered `Tapped successfully` — with every frame involved
correct, so no amount of tree work would have caught it.

Disabled controls are refused for the same reason: the touch was delivered and
ignored, which looks identical to a mis-aimed tap.

`ui_tap {x, y}` is unaffected. Coordinates are the caller saying where, and are
taken at their word.

### `ui_tap` says what it tapped

`Tapped "Toolbar Button" (Button) at (102, 822).` rather than
`Tapped successfully`.

Matching is substring and the companion returns its first hit, so the element
found is not always the one meant — a status line reading `Settings Switch = on`
has outranked the switch it was describing, and a permission alert's prose has
outranked an app icon. Naming the element acted on puts that where a caller sees
it immediately, rather than where they deduce it from the aftermath.

Where several elements match, an exact name now beats a partial one and a
control beats prose. An enclosing container no longer wins on document order
alone.

### Switches can be switched by name

`ui_tap {label: "Sound"}` now operates a toggle instead of aiming a touch at it,
and answers with the state it read back: `Toggled Sound off -> on.`

A switch is the one control whose accessibility frame is routinely not the thing
you can touch. A Settings row publishes a single element spanning label and
control, so its centre is the gap between them; a bare `UISwitch` inherits
whatever width its layout gives it. Tapping the centre of either actuated
nothing, on the current companion and the 2022 one alike — measured 0 of 6 and
0 of 8, with and without a hold. It never worked.

So a toggle is activated the way VoiceOver activates it. The trade is stated
plainly: that activation does not hit-test, so it will operate a switch a finger
could not reach. `ui_tap {x, y}` remains a real touch for anyone who needs that
fidelity, and the state read back makes a false pass visible rather than silent.

Where activation cannot reach an element — a switch in a toolbar or nav bar, or
one inside a sheet drawn by another process — the tap falls back to a real
touch, because the accessibility action API has no way to select the backend
that can see it.

### Elements inside system sheets are where the tools say they are

iOS draws some UI from a separate process hosted inside the app's window: the
"Use Strong Password?" autofill sheet, photo and document pickers, share sheets.
Their elements arrived in the same tree as the app's own, with frames measured
from the hosting window rather than the screen.

Untranslated this was not cosmetic. `ui_tap {label: "Fill Strong Password"}`
resolved the label, tapped its centre, and reported success while the touch
landed 476 points away — pressing "Login Submit" in the fixture.

The offset was never missing: at the boundary the subtree restarts at a local
origin while its parent still describes that region in screen space, and the two
rectangles are the same size. Pruning was discarding the parent. A full-screen
picker is hosted identically and its frames are already correct, so the
correction is derived per hosted view rather than applied to anything that looks
like a sheet.

`ui_describe_point` is corrected the same way, so it and `ui_describe_all` agree
about such an element.

### `ui_find` resolves accessibility identifiers

The tree publishes `AXUniqueId`, so handing one back is the obvious thing to do.
It used to answer "No element found" for a name it had just given you. Tried
after the label, so it costs nothing until that has missed.

### One name per element, whichever tool you ask

`ui_describe_all` and `ui_describe_point` are served by different accessibility
backends, and they named the same element differently: a search field was
`SearchField` to one and `TextField` to the other, a switch `Switch` against
`CheckBox`, a segment `Button` against `RadioButton`, a nav bar title
`StaticText` against `Heading`. An agent branching on `type` behaved differently
depending on which tool it happened to call.

Point reads now answer in the vocabulary the tree uses. Measured on a screen
with one of every control kind: 17 elements described both ways, previously five
disagreements, now none.

The obvious fix — mapping the type strings — cannot work, because the point
read calls a plain field and a search field both `TextField`; promoting that
type would promote every text field on screen. The element's `subrole` is what
separates them, so that is what the translation reads. It is asked for as
evidence and never returned.

## 2.1.1

### Fixed: a client in a container could not connect

Since 2.0.0, a client reaching the server at `host.docker.internal` was refused
with `403 Invalid Host header` — which is the primary way this server is used,
the simulators being on the host and the agent in a container.

The cause was the DNS rebinding protection added in 2.0.0: it allowlisted the
loopback spellings and nothing else, so the container host aliases fell outside
it. `host.docker.internal`, `gateway.docker.internal` and Podman's
`host.containers.internal` are now accepted by default.

This does not weaken the protection. It works by rejecting a name the *attacker*
controls, and these are not such names: `.internal` is reserved by ICANN and
cannot be served by public DNS, and the container runtime resolves these locally
to the host the container is already running on. `Host: evil.example.com` is
still refused.

A refusal now also explains itself — what was rejected, what is accepted, and
the `IOS_SIMULATOR_MCP_ALLOWED_HOSTS` setting that permits a name of your own —
rather than the SDK's bare `Invalid Host header`. The README gains the container
recipe.

## 2.1.0

Adds device rotation, makes every tool recover a wedged simulator rather than
two of them, and puts the first unit tests on the logic that decides where a tap
lands.

**Also carries everything under 2.0.3, which was never published** — v2.0.2 is
the last release on npm, so the boot-wedge recovery and the bounded
`start_simulator` arrive with this version rather than before it.

### New tool: `rotate`

Rotates the device — `portrait`, `landscape_left`, `landscape_right`,
`upside_down` — and then **reads the orientation back and reports what the
interface actually adopted**, which is not always what was asked for.

Two things make that worth doing rather than reporting success:

- **An app can decline.** No Face ID iPhone gives an app an upside-down
  interface, whatever its `Info.plist` says. `rotate upside_down` there turns
  the device, leaves the interface where it was, and says so — naming the cause
  and pointing at iPad — instead of leaving the caller to wonder.
- **It caught a bug in itself.** idb's orientation enum turns out to use UIKit's
  *interface* vocabulary while ours names the device, and UIKit crosses the two
  landscapes on purpose. The first mapping was name-for-name, and the read-back
  reported the mirror image immediately rather than silently inverting every
  coordinate that followed.

Orientation names follow the **device**, exactly as the Simulator's own
Device > Orientation menu does. An app reporting
`UIInterfaceOrientationLandscapeRight` is in `landscape_left` here; both are
correct, and the README says why.

This also makes TESTING_TOOLS.md Part 2 runnable by an agent — rotating the
device was previously the one step in the whole plan that needed a human.

### Every tool recovers a wedged simulator, not two of them

A simulator can render, respond to taps and answer `describe` while every
accessibility read fails forever. Until now that was only cured while the
simulator was booting, and afterwards only `ui_describe_all` and `ui_view` did
anything about it — `ui_tap`, `ui_find`, `ui_type`, `ui_swipe` and
`ui_describe_point` returned a clearer error and left the session dead, advising
the caller to go and call a different tool.

The cure now lives with the reads themselves, so every tool built on them gets
it without knowing anything about it: the simulator's bridge is restarted, and
the caller's own read is retried and served. Two rules keep it from doing harm,
and both are unit tested in `src/ax/recovery.ts`:

- **Never for a simulator that has not yet answered a read.** That one is
  booting, not broken, and the boot wait already owns it with its own budget.
- **Not more than once a minute per simulator.** A wedged simulator under an
  agent fails every few hundred milliseconds; restarting under each failure
  would leave the bridge permanently mid-restart.

**`ui_describe_point` on an empty point now says so.** idb reports "no
translation object" both for a bridge that is not answering and for a point with
nothing on it, which is an ordinary answer. That is now told apart — by asking
for the whole screen, which is unambiguous — so an empty point returns a message
naming the coordinates instead of one blaming a fullscreen dialog, and does not
cause a recovery.

The wedge itself still cannot be induced on demand, so the recovery is verified
by unit tests over its decision rules and by watching the mechanism run, not by
a reproduction. `launchctl stop` on a healthy bridge does not produce it.

### Tests

No behaviour change from this part: the tool surface, its parameters and its
output are identical.

The pure logic — accessibility tree pruning, label matching, coordinate
transforms — moved out of `src/index.ts` into `src/ax/` and gained unit tests
(`npm test`, 75 assertions, well under a second). It could not be tested where
it was, because `src/index.ts` starts a server on import. These rules were
previously verified by booting simulators, at roughly three minutes an attempt.

One duplicate implementation went with it: orientation detection had its own
copy of the logical→portrait rotation arithmetic, separate from the one taps and
swipes use. It now calls the same function, so the two cannot drift apart.

CI and the publish workflow both run the tests.

## 2.0.3 — never published

Written up as a release and then not tagged, so none of it reached npm on its
own; it ships as part of 2.1.0. Kept as its own section because the work is
self-contained and worth reading separately.

Recovers a simulator whose accessibility service never starts, and stops
`start_simulator` outlasting the client that called it.

### The boot wedge

Roughly one in four freshly created simulators would come up rendering their
home screen, responding to taps and answering `describe`, while every
accessibility read failed — permanently, with an error blaming a fullscreen
dialog that did not exist.

`start_simulator` now detects this and recovers it, by restarting the guest's
`com.apple.CoreSimulator.bridge`. A wedged simulator answers again within about
five seconds, with the device and its installed apps intact. idb has the same
cure internally but only applies it when SpringBoard has crashed, which is not
this case.

`ui_describe_all` recovers the same way instead of recommending you destroy and
recreate the simulator, which cost every installed app for the same result. In
verbose mode both paths log when they recover. If recovery ever fails — not yet
observed — the message asks you to file a bug.

**The cause is still unknown.** This is a verified cure, not a fix. What was
ruled out, what was not, and why, is written up in
[BOOT_BUG.md](BOOT_BUG.md).

### `start_simulator` returns when it says it will

It now waits on `simctl bootstatus` rather than a fixed sleep — measured to be a
few seconds *earlier* than accessibility readiness, so nothing is lost — and
returns within 55 seconds whatever happens.

It previously waited up to three minutes, which outlasted the MCP client's
patience: the call was cancelled and the caller learned nothing at all, not even
that a simulator had been created. Returning honestly with a UDID and an
instruction to poll is more useful than being killed mid-wait.

## 2.0.2

Friction removal. Everything here is something an agent hit in the first minute.

### `start_simulator` waits until the simulator can actually be driven

It used to return as soon as `simctl boot` did, which is 30–90 seconds before
the accessibility bridge answers anything. Every session began with a stretch of
failures, and the error blamed "a fullscreen dialog" — so the natural response
was to go looking for a dialog rather than to wait.

It now polls until the simulator answers and reports how long that took, so the
next call works. `attach_simulator` does the same, because a device reports
"Booted" well before it is driveable. If the wait runs out, it says so and tells
you to poll `ui_view` rather than pretending to be ready.

The underlying idb error is also rewritten to name the cause it usually has.

### Finding controls by the text you can see

Two things made controls unfindable by name:

- **Typography.** iOS labels a button `Don’t Allow` with a typographic
  apostrophe. Asking for `Don't Allow` matched nothing. Curly quotes,
  apostrophes, dashes and non-breaking spaces are now folded before comparing.
- **Text that is not the label.** A control's visible text is not always its
  accessibility label — search fields in particular have no label at all and
  carry their text in `AXValue`, making them impossible to name. Lookups now
  consider both, preferring label matches.

### One shape from every tool

The same element used to come back differently depending on how you found it:
sixteen fields from `ui_find`, six from `ui_describe_point`, and a different
`role` and `traits` depending on which accessibility backend answered. Every
element now carries the same six fields — `AXLabel`, `AXValue`, `AXUniqueId`,
`frame`, `type`, `enabled` — with empty ones omitted. `type` carries what `role`
was for.

## 2.0.1

**2.0.0 could not start. Use this instead.**

The generated gRPC client imports `@bufbuild/protobuf/wire` at runtime, and that
package was never declared as a dependency — in the repository it resolved
through `ts-proto`, a devDependency, so it worked everywhere it was tested and
nowhere it was installed. A fresh `npm install` of 2.0.0 exits immediately with
`Cannot find module '@bufbuild/protobuf/wire'`.

`@bufbuild/protobuf` is now a dependency, and `publish.yml` packs the tarball,
installs it into an empty directory and starts the server before publishing, so
a package that cannot run cannot ship.

Nothing else changed; everything in 2.0.0 below applies.

## 2.0.0

The release where the server stops depending on anything you have to install
yourself, and where tapping a control by name became reliable.

This is a summary of where the project has arrived rather than an itemised diff
of every change since 1.2.0 — there were too many, across too long a stretch,
for a list to be more useful than a description.

### Self-contained

No `pipx install fb-idb`, no `brew install idb-companion`, no Python anywhere.
The server talks to `idb_companion` directly over gRPC, and ships its own
companion: built from a pinned `facebook/idb` commit in CI, published as a
release asset, then downloaded once and verified against the sha256 in
`companion.lock.json`.

There is deliberately no discovery — no `$PATH` lookup, no version negotiation.
A companion older than the pinned one does not reject request fields it does not
understand; it ignores them and answers anyway, so a fallback would return
answers that are wrong but entirely plausible. Pinning is what keeps the
generated client and the companion the same age.

Dropping the per-call Python process took a tap from ~165 ms to ~3 ms.

**Apple Silicon only.** The bundled companion is arm64; Intel Macs are not
supported.

### Sessions, and more than one simulator

Every tool takes an `id` naming your session, and each session owns one
simulator, so several agents can drive their own simulators against one server.
`start_simulator`, `attach_simulator` and `destroy_simulator` manage that
lifecycle; `get_booted_sim_id`, `open_simulator` and `IDB_UDID` are gone,
replaced by it.

**HTTP is now the default transport**, which is what makes a shared server
possible. `--stdio` selects the old behaviour for a client that wants to own its
own process.

### Navigating by name

`ui_find` and `ui_tap {label}` resolve a control on the simulator and return or
tap it, costing a few hundred bytes instead of a screen-sized tree.

The accessibility tree Apple's translator exposes turned out to omit whole
containers: tab bars, nav bars and toolbars arrive with no children, so every
control inside one was invisible — `ui_find` reported "no element found" for
elements carrying exactly that label and hit-testing perfectly well. Both tools
now fall back to idb's axbridge backend, which walks the app's real view
hierarchy, and `ui_describe_all` reads from it directly.

`ui_describe_all` is pruned to elements you can act on and asks for a restricted
key set, so a complete tree costs about what the incomplete one used to: on a
Photos screen, 3.9 KB for 25 nodes where the old read gave 3.8 KB for 9.

### Also

- `detect_rotation`, and logical-coordinate handling that survives rotation
- Accessibility reads recover from a wedged companion automatically, instead of
  requiring the simulator to be destroyed and recreated
- HTTP transport rejects DNS-rebound requests
- Every gRPC call carries a deadline

## Known issues

Being worked on for 2.0.1.

- **`start_simulator` returns before the simulator is usable.** Expect 40–90
  seconds before UI tools work, during which they fail with an idb error about
  "no translation object" that blames a fullscreen dialog rather than the boot
  that is actually in progress. Poll `ui_view` until it succeeds.
- **Label matching is exact substring, including typography.** iOS labels the
  permission button `Don’t Allow` with U+2019, so an ASCII apostrophe finds
  nothing.
- **Rotation cannot be driven.** No tool rotates the device; it has to be done
  by hand in the Simulator app, after which `detect_rotation` picks it up.
- **A miss costs more than a hit.** `ui_find` answers in ~13 ms when the cheap
  tree contains the element and ~330 ms when it does not, because the fallback
  runs. Do not poll in a tight loop.

## Earlier

1.0.0 through 1.2.0 established the fork: the session model, the multi-simulator
server, and the move off the Python `idb` client. They are not itemised here.

This project is a fork of
[joshuayoes/ios-simulator-mcp](https://github.com/joshuayoes/ios-simulator-mcp).
