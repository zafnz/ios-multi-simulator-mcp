# Testing the tools

Exercises every MCP tool against one simulator. Part 1 covers portrait, Part 2 verifies coordinates after rotation, Part 3 covers views hosted by another process, Part 4 covers controls whose frame is not the thing you can touch, Part 5 times the server.

**Run this through the `mcp__ios-multi-simulator__*` tools, one call at a time.
Do not script it without explicit permission.**

With the users permission you have `scripts/imsmd.sh start|stop|restart` that can
control the mcp for your dev and testing.

For transports, multiple sessions on one server and process lifecycle — none of which an agent can drive — see [TESTING_SERVER.md](TESTING_SERVER.md).

Session ID used throughout: `test-session`

Parts 1 and 2 use `testapp/`, a fixture built for this guide. It has no first-run wizards, and every control appears twice — once in the plain view hierarchy and once inside system chrome (nav bar, toolbar). The chrome copies are the interesting ones: their contents are absent from the default accessibility tree, so they exercise the paths that work around that. A status label reports each interaction, so a toolbar tap can be confirmed without reading the toolbar, and an orientation label reports what the app itself believes about rotation — the one fact no tool outside the app can observe.

Build it first:

```bash
testapp/build.sh
```

**Boot time.** `start_simulator` does not return until the simulator is driveable, so no polling is needed between steps.

**If a step fails with "not answering accessibility requests"**, that is the boot wedge, not the step under test. See [BOOT_BUG.md](BOOT_BUG.md).

---

## Part 1 — Portrait

### #1 start_simulator

```
start_simulator(id: "test-session", type: "iPhone")
```

**Expected:** Simulator is created and driveable. Output includes device name, type, UDID, and how long it took to become ready. Continue straight to the next step.

### #2 ui_view — home screen

```
ui_view(id: "test-session")
```

**Expected:** A screenshot of the iOS home screen.

### #3 ui_describe_all — accessibility tree

```
ui_describe_all(id: "test-session")
```

**Expected:** A JSON tree whose root has a non-zero frame matching the device's logical size. Contains the home screen's app icons, the dock and the status bar.

### #4 ui_describe_point — query a coordinate

Using the centre of any app icon from step #3:

```
ui_describe_point(id: "test-session", x: <icon_x>, y: <icon_y>)
```

**Expected:** The element at that point, with an `AXLabel` matching the icon's name.

### #5 ui_swipe — swipe to the second home screen page

```
ui_swipe(id: "test-session", x_start: 350, y_start: 550, x_end: 50, y_end: 550, duration: "0.3")
```

**Expected:** "Swiped successfully".

### #6 ui_view — verify the swipe

```
ui_view(id: "test-session")
```

**Expected:** A different set of icons from step #2, confirming the page changed.

### #7 install_app

```
install_app(id: "test-session", app_path: "<repo>/testapp/build/MCPTestApp.app")
```

**Expected:** "App installed successfully from: ...".

### #8 launch_app

```
launch_app(id: "test-session", bundle_id: "com.example.mcptestapp")
```

**Expected:** "App com.example.mcptestapp launched successfully".

### #9 ui_view — verify the app rendered

```
ui_view(id: "test-session")
```

**Expected:** A screenshot showing a nav bar with **Nav Button**, a text field, **Plain Button**, a status label reading `status: ready`, an orientation label reading `orientation: interface=portrait device=portrait`, **Show Login**, **Show Picker**, a Settings-shaped **Settings Switch** row and a plain **Split Switch** row, **Show In-App Modal**, **Ask Permission**, and a row of one-of-each controls (search bar, switch, slider, stepper, segmented control), and a bottom toolbar with **Toolbar Button** and a search field.

The tail of that list runs past the fold — the stepper and segmented control sit below the toolbar and are not visible without scrolling. They are in the tree, which is what the steps below need.

### #10 ui_describe_all — the whole tree, including system chrome

```
ui_describe_all(id: "test-session")
```

**Expected:** Every control is present, and — the point of this step — the `NavigationBar` and `Toolbar` groups **have children**:

- `NavButton`, inside the nav bar
- `PlainField`, `PlainButton`, `StatusLabel`, `OrientationLabel`, `InAppModalButton`, `SystemModalButton`, `SearchBar`, `PlainSwitch`, `PlainSlider`, `PlainStepper`, `PlainSegmented` in the plain hierarchy
- `ToolbarButton` and a text field, inside the toolbar

A nav bar or toolbar coming back with no children means the tree has regressed to the incomplete read, and everything below will fail.

### #11 ui_find — a control in the plain hierarchy

```
ui_find(id: "test-session", label: "Plain Button")
```

**Expected:** A single element with that label and a usable frame. This is the fast path.

### #12 ui_find — a control inside the toolbar

```
ui_find(id: "test-session", label: "Toolbar Button")
```

**Expected:** The same shape of answer. This one is resolved by the fallback, so it takes noticeably longer than #11 — see Part 3.

### #13 ui_tap — tap a toolbar control by name

```
ui_tap(id: "test-session", label: "Toolbar Button")
ui_find(id: "test-session", label: "status:")
```

**Expected:** `Tapped "Toolbar Button" (Button) at (102, 822).`, then a status label reading `status: tapped Toolbar Button`. The reply names the element it acted on, so a lookup that resolved the wrong thing is visible here rather than in the aftermath. The status label lives in the plain hierarchy, so this confirms the toolbar tap without reading the toolbar.

### #14 ui_tap — a control that has no label

The toolbar's text field carries its visible text in `AXValue` and has no `AXLabel`:

```
ui_tap(id: "test-session", label: "Toolbar Search")
```

**Expected:** `Tapped "Toolbar Search" (TextField) at (298, 822).`, and the field is focused. This is matching on value rather than label — and the reply naming a `TextField` is what confirms it matched the field and not some text saying the same thing.

### #15 ui_type — type into the focused field

```
ui_type(id: "test-session", text: "hello")
ui_find(id: "test-session", label: "status:")
```

**Expected:** "Typed successfully", then `status: Toolbar Search = "hello"`.

### #16 ui_describe_point — hit-test a chrome control

Using the centre of the `Toolbar Button` frame from step #12:

```
ui_describe_point(id: "test-session", x: <x>, y: <y>)
```

**Expected:** The toolbar button. Point reads hit-test rather than walking the tree, so this is the control case when a name-based lookup disagrees.

### #17 screenshot — save to file

```
screenshot(id: "test-session", output_path: "/tmp/mcp-test-screenshot.png")
```

**Expected:** "Wrote screenshot to". The file exists and is a valid PNG, in physical pixels — larger than the logical frame by the device's scale factor.

### #18 record_video — start recording

```
record_video(id: "test-session")
```

**Expected:** Recording started, with an output path (defaults under `~/Downloads` unless `IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR` is set).

### #19 ui_tap — activity while recording

```
ui_tap(id: "test-session", label: "Plain Button")
ui_tap(id: "test-session", label: "Nav Button")
```

**Expected:** Both succeed; the status label reports each in turn.

### #20 stop_recording

```
stop_recording(id: "test-session")
```

**Expected:** "Recording stopped successfully." The video file exists at the path from #18, is at least a few seconds long, and is at least 100KB. Do not expect megabytes: the fixture is a mostly white, mostly static screen, which HEVC compresses very well — a 12-second recording of it came to 468KB.

### #21 destroy_simulator, then attach to a new one

```
destroy_simulator(id: "test-session")
start_simulator(id: "owner-session", type: "iPhone")
attach_simulator(id: "attach-test", udid: "<udid from owner-session>")
```

**Expected:** "Simulator destroyed", then a new simulator, then "Attached to simulator: ...".

### #22 Verify the attached session, then clean up

```
ui_view(id: "attach-test")
destroy_simulator(id: "attach-test")
destroy_simulator(id: "owner-session")
```

**Expected:** A screenshot from the same simulator; then "Detached from simulator" for the attached session (owned=false), and "Simulator destroyed" for the owner (owned=true).

---

## Part 2 — Coordinates after rotation

Verifies that coordinates read in landscape are usable in landscape. Uses the same fixture, which supports both orientations.

### #23 Start a simulator and launch the fixture

```
start_simulator(id: "landscape-test", type: "iPhone")
install_app(id: "landscape-test", app_path: "<repo>/testapp/build/MCPTestApp.app")
launch_app(id: "landscape-test", bundle_id: "com.example.mcptestapp")
```

### #24 ui_view — confirm portrait

```
ui_view(id: "landscape-test")
```

**Expected:** The fixture in portrait: nav bar at the top, toolbar at the bottom.

### #25 ui_describe_all — note the portrait geometry

```
ui_describe_all(id: "landscape-test")
```

**Expected:** Root frame taller than it is wide. Note it, to compare after rotating.

### #26 Rotate to landscape

```
rotate(id: "landscape-test", orientation: "landscape_left")
```

**Expected:** `Rotated to "landscape_left" for session "landscape-test".` — the tool rotates the device and then reads the orientation back, so this wording means the interface actually adopted it. A reply of the form *"Asked the device to rotate to X, but the interface is Y"* is a real answer too, not an error: the app declined, and coordinates follow Y.

> This used to be a manual step, and Part 2 could not be run by an agent at all. Doing it by hand still works — **Device > Rotate Left** — and should give the same result, which is worth checking occasionally since it is the ground truth the tool is imitating.

### #27 detect_rotation

```
detect_rotation(id: "landscape-test")
```

**Expected:** `landscape_left` after a Rotate Left, or `landscape_right` if you rotated the other way — the same words the Simulator's own menus use.

Cross-check it against what the app itself believes:

```
ui_find(id: "landscape-test", label: "orientation:")
```

**Expected:** `orientation: interface=landscapeRight device=landscapeLeft` after a Rotate Left. The two disagree **by design** — `UIOrientation.h` defines `UIInterfaceOrientationLandscapeLeft` as `UIDeviceOrientationLandscapeRight` — and we report the orientation the *interface* is in, named in the *device* vocabulary. Do not read the mismatch as a fault; read a *match* between `device` and our answer, and a mirrored `interface`.

Upside down is not testable here: a Face ID iPhone moves the device but never gives the app an upside-down interface, so `device=portraitUpsideDown` while the interface stays where it was. Use an iPad for that case.

### #28 ui_view — confirm landscape

```
ui_view(id: "landscape-test")
```

**Expected:** A landscape screenshot of the fixture.

### #29 ui_describe_all — landscape geometry

```
ui_describe_all(id: "landscape-test")
```

**Expected:** Root frame now wider than tall, the reverse of #25. All five controls still present, with frames in landscape space. Note the centre of `Toolbar Button` and of `Nav Button`.

### #30 ui_tap — tap a toolbar control by landscape coordinate

```
ui_tap(id: "landscape-test", x: <toolbar_button_x>, y: <toolbar_button_y>)
ui_find(id: "landscape-test", label: "status:")
```

**Expected:** `status: tapped Toolbar Button`. This is the real assertion of Part 2: a coordinate taken from a landscape tree hit the element it pointed at.

### #31 ui_view — see the result

```
ui_view(id: "landscape-test")
```

**Expected:** The status label on screen reflects the tap.

### #32 ui_tap — a second control, elsewhere on screen

```
ui_tap(id: "landscape-test", x: <nav_button_x>, y: <nav_button_y>)
ui_find(id: "landscape-test", label: "status:")
```

**Expected:** `status: tapped Nav Button`, confirming the transformation holds in a different region.

### #33 ui_type — type in landscape

```
ui_tap(id: "landscape-test", label: "Toolbar Search")
ui_type(id: "landscape-test", text: "landscape")
ui_find(id: "landscape-test", label: "status:")
```

**Expected:** `status: Toolbar Search = "landscape"`.

### #34 Clean up

```
destroy_simulator(id: "landscape-test")
```

**Expected:** Simulator destroyed.

---

## Part 3 — Remote-hosted views

iOS draws some UI from a **separate process** hosted inside the app's window: the "Use Strong Password?" autofill sheet, photo and document pickers, share sheets. Their elements arrive in the same tree as the app's own, with nothing naming them as different, and their frames are measured from the hosting window rather than the screen.

This is the regression test for that. It is worth running carefully, because the failure mode is the worst kind this server has: `ui_tap {label}` resolves the name, taps a plausible-looking coordinate, and reports a cheerful success while the touch lands somewhere else entirely. Nothing in the reply said otherwise, and the tree that would contradict it is the same tree that is wrong. Before the fix, tapping `Fill Strong Password` pressed **Login Submit**.

Both halves matter and they check opposite things. The sheet's window sits partway down the screen, so its contents need translating; the picker's window sits at the screen origin, so its contents are **already correct** and must be left alone. A fix that shifts everything hosted passes the first half and fails the second.

### #35 Start a simulator and open the login screen

```
start_simulator(id: "remote-test", type: "iPhone")
install_app(id: "remote-test", app_path: "<repo>/testapp/build/MCPTestApp.app")
launch_app(id: "remote-test", bundle_id: "com.example.mcptestapp")
ui_tap(id: "remote-test", label: "Show Login")
ui_tap(id: "remote-test", label: "Login Password")
```

**Expected:** The **"Use Strong Password?"** sheet slides up across the bottom of the screen.

No device preparation is needed — no saved password, no Settings change, no software keyboard. If the sheet does not appear, the entitlement is missing from the build rather than the simulator being wrong; check with `otool -l testapp/build/MCPTestApp.app/MCPTestApp | grep -A2 __entitlements` and rebuild. A simulator whose password store has entries can also suppress it, by answering with a *fill* suggestion for a fuzzy-matched credential instead of generating one.

### #36 ui_view — see where the sheet actually is

```
ui_view(id: "remote-test")
```

**Expected:** The sheet occupies roughly the bottom half of the screen. On a 402x874 device its "Fill Strong Password" button is near y≈737 and its ✕ near y≈507. **Read these off the screenshot** — they are the ground truth the next step is checked against, and the whole point is that the tree cannot be trusted to supply them.

Let the sheet settle before believing the screenshot. A read taken during the presentation animation shows the sheet mid-flight and will not match a tree read taken a moment later.

### #37 ui_find — the frame must be in screen space

```
ui_find(id: "remote-test", label: "Fill Strong Password")
```

**Expected:** A frame whose centre matches the screenshot — on a 402x874 device, `y: 715.33`, `height: 44`, so a centre of **737**.

**The regression looks like `y: 239.33`**: the same rectangle measured from the sheet's own origin instead of the screen's, about 476 points too high. That number is not a magic constant to assert on — it is the hosting window's origin and moves with the sheet — so check the frame against the screenshot rather than against 715.33.

### #38 ui_describe_point — the two tools must agree

```
ui_describe_point(id: "remote-test", x: 201, y: 737)
```

**Expected:** `Fill Strong Password`, with **the same frame `ui_find` reported**.

Two distinct failures hide here. If it returns the wrong *element* — `ScrollArea`, or the login form — then the position is wrong. If it returns the right element with a frame that does not cover (201, 737), the tools disagree about one element, which is the defect [#58](TODO.md) was closed to prevent; a point read hit-tests and so is right about identity while having no ancestry to derive position from.

### #39 ui_tap — the tap must land on the button

```
ui_tap(id: "remote-test", label: "Fill Strong Password")
ui_view(id: "remote-test")
```

**Expected:** The sheet dismisses and the password field is **filled with a generated password** (a long row of dots).

This is the step that matters most, because it is the one an agent actually takes. A success line is **not** a pass on its own — the broken version returned one too. Only the screenshot decides. If the login screen is unchanged, or the app has navigated because "Login Submit" was pressed instead, the fix has regressed.

### #40 The control case — a picker must be left alone

```
launch_app(id: "remote-test", bundle_id: "com.example.mcptestapp", terminate_running: true)
ui_tap(id: "remote-test", label: "Show Picker")
ui_find(id: "remote-test", label: "Collections")
```

**Expected:** The photo picker opens, and `Collections` reports a frame in the nav bar near the top — on a 402x874 device, `{x: 201, y: 86, width: 95, height: 48}`.

The picker is hosted by another process exactly as the sheet is, but its window is at the screen origin, so **these coordinates are already correct and must come back unchanged**. A frame pushed down the screen here means the translation is being applied blindly to anything hosted, rather than by how far the hosting window actually sits from the origin.

### #41 ui_tap — the picker still taps correctly

```
ui_tap(id: "remote-test", label: "Collections")
ui_view(id: "remote-test")
```

**Expected:** The picker switches to its Collections view — "Pinned", "Albums", "Shared Albums".

### #42 Clean up

```
destroy_simulator(id: "remote-test")
```

**Expected:** Simulator destroyed.

---

## Part 4 — Toggles, by name and by coordinate

A switch is the one control whose accessibility frame is routinely **not** the thing you can touch. A Settings row publishes one element spanning label and control, so its centre is the gap between them; and even a bare `UISwitch` inherits whatever width its layout gives it. Tapping the centre of either actuates nothing, and it never did — measured 0/6 and 0/8 on the pinned companion and the 2022 one alike.

So `ui_tap {label}` operates a toggle through accessibility instead, the way VoiceOver does, while `ui_tap {x, y}` stays a real touch. **Both are checked here in one place, deliberately**: they are different mechanisms that can regress independently, and when a toggle stops working the first thing worth knowing is which of the two broke.

### #43 Start a simulator and launch the fixture

```
start_simulator(id: "toggle-test", type: "iPhone")
install_app(id: "toggle-test", app_path: "<repo>/testapp/build/MCPTestApp.app")
launch_app(id: "toggle-test", bundle_id: "com.example.mcptestapp")
```

**Expected:** The fixture, with a Settings-shaped `Settings Switch` row — label left, switch right — a little below `Show Picker`.

### #44 By name — the toggle must flip, and say so

```
ui_tap(id: "toggle-test", label: "Settings Switch")
```

**Expected:** `Toggled Settings Switch off -> on.`

Three distinct failures hide behind this one line:

- **`Tapped "Settings Switch" (Switch) at ...`** means the element was not recognised as a toggle, so it was touched at its centre instead of activated. The state will not have changed. This is the original bug.
- **`Activated Settings Switch through accessibility, but it is still off`** means activation reached the element and the element did nothing with it. That is an app-side gap rather than a tool one — a merged row that never implements activation cannot be worked by VoiceOver either — but check the fixture has not regressed into publishing a cell instead of the switch.
- **`could not read its state back`** means the toggle flipped but the confirming lookup failed. Most likely something else on screen now matches the name.

Run it twice more and confirm it round-trips — `on -> off`, then `off -> on`. The second call is the one that catches a read-back keyed on a label rather than an identifier: by then the status line reads `settings toggle = on`, and a lookup that matches loosely will find that sentence rather than the switch.

### #45 By coordinate — a real touch must also flip it

Read the switch's position off `ui_view` — **not** off the tree, whose frame spans the whole row and whose centre is the gap:

```
ui_view(id: "toggle-test")
ui_tap(id: "toggle-test", x: <switch_x>, y: <switch_y>)
ui_find(id: "toggle-test", label: "status:")
```

**Expected:** a `Tapped ... at (x, y)` line, and the status line changes — `status: settings toggle = ...`, flipped from wherever #44 left it.

This is the half that depends on a tap being **held**. An instantaneous touch actuates a switch about 40% of the time, so a coordinate tap that works once proves little; if this step is flaky, that floor has regressed rather than anything about toggles. See `MIN_TAP_HOLD_SECONDS`.

### #46 The boundary: a name that is not a control

```
ui_tap(id: "toggle-test", label: "Split Switch")
ui_find(id: "toggle-test", label: "status:")
```

**Expected:** `Tapped "Split Switch" (StaticText) at ...`, and **the status line does not change**.

The `(StaticText)` in that reply is the useful part: it says plainly that the name resolved to a piece of text rather than a control, which is the whole reason nothing happened.

That is correct, not a bug, and it is here so nobody later "fixes" it. `Split Switch` is a label and a switch in a plain container with nothing merging them, so iOS publishes two elements: a static text carrying the name, and an unnamed switch beside it. The name genuinely refers to the text. A VoiceOver user meets the same wall and moves on to the switch. The rule the tools follow is that they operate what iOS says the element *is* — and no amount of activation makes a label into a control.

### #47 A covered control must refuse, not tap something else

The fixture's stepper sits below the fold, under the toolbar — its frame is perfectly correct, and its centre belongs to the toolbar's search field:

```
ui_tap(id: "toggle-test", label: "Plain Stepper, Increment")
```

**Expected:** an **error**, naming what is in the way:

> `"Plain Stepper, Increment" is at {x:201 y:794 w:140 h:32}, but "Toolbar Search" is there instead, so a tap at its centre (271, 810) would not reach it — it is covered, off screen, or scrolled out of view.`

**A `Tapped ...` reply here is the regression.** Before this check existed, that call focused the toolbar's search field, opened the keyboard, and reported success. Every frame involved was correct, so no amount of tree work would have caught it — the guard is a single hit-test at the point about to be touched, ~10 ms against a tap that already costs ~110 ms.

Then confirm it has not become over-eager, which would be worse than the bug it prevents:

```
ui_tap(id: "toggle-test", label: "Plain Button")
ui_tap(id: "toggle-test", label: "Toolbar Button")
ui_tap(id: "toggle-test", label: "Nav Button")
```

**Expected:** three `Tapped ... at (x, y)` replies. `Toolbar Button` is the one to watch — it lives in system chrome and is resolved by the AXBridge fallback, so it exercises the verification against an element the cheap backend cannot see.

```
destroy_simulator(id: "toggle-test")
```

---

## Part 5 — Round-trip timing

Measures how long the **server** takes, with no model in the loop. Driving the tools through an agent measures the agent; this measures the tool.

Needs the server in HTTP mode and a booted simulator in a session named `rtt`. Start one however you like, then:

```bash
call() {
  curl -s -o /tmp/rtt-out.txt -w '%{time_total}' \
    -X POST http://127.0.0.1:8008/mcp \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d "$1"
}
med() { sort -n | awk '{a[NR]=$1} END{printf "%.0f ms\n", a[int(NR/2)+1]*1000}'; }

time_tool() {   # time_tool <name> <json args>
  printf '%-24s ' "$1"
  BODY="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"
  for _ in $(seq 6); do call "$BODY"; echo; done | med
}
```

Then:

```bash
time_tool ui_tap            '{"id":"rtt","x":200,"y":400}'
time_tool ui_describe_point '{"id":"rtt","x":200,"y":400}'
time_tool ui_find           '{"id":"rtt","label":"Settings"}'
time_tool ui_find           '{"id":"rtt","label":"ZZZnope"}'
time_tool ui_describe_all   '{"id":"rtt"}'
time_tool ui_view           '{"id":"rtt"}'
```

**Expected**, as medians on an M-series Mac. Exact numbers vary with the machine and what else is running; the **ratios** are what matter:

| Call | Order of magnitude |
|---|---|
| `ui_tap` by coordinate | **100–150 ms** — the 100 ms hold, plus the round trip |
| `ui_tap` by label | ~145 ms — the above, plus the lookup and the hit-test that verifies it |
| `ui_describe_point` | under 50 ms |
| `ui_find`, name present in the cheap tree | ~25 ms |
| `ui_find`, name absent — falls back | ~300 ms |
| `ui_describe_all` | ~300 ms |
| `ui_view` | ~350 ms |

Two things to check rather than exact figures:

- **`ui_tap` costs its own hold, and nothing else. Expect 100–150 ms.** Every tap is held for 100 ms (`MIN_TAP_HOLD_SECONDS`), because an instantaneous touch actuates a control only about 40% of the time — see Part 4. Everything above the hold is the real round trip, so the healthy band is 100–150 ms and the interesting readings are outside it: **below 100 ms the floor has been lost** and taps are unreliable again, which no other check in this file would notice; well above 150 ms is a slow companion connection rather than the tool.
- **`ui_describe_point` is fast** — single digits on an idle machine, under 50 ms in any case. It scales with what else the machine is doing: a busy Mac was measured at 22 ms, with every other figure in the table up by the same factor.
  - **`ui_describe_point` is the one to watch, and this row has caught a real regression.** It is the only cheap tool that can quietly become an expensive one, because it falls back to a whole-screen read when a frame looks like it belongs to a remote-hosted view (Part 3). Get that condition wrong and every point read pays ~300 ms while still returning the right answer, so nothing fails — the number here is the only thing that notices. A measurement of ~300 ms means the fallback is firing on ordinary elements; `isRemotelyHosted` in [src/ax/tree.ts](src/ax/tree.ts) is the thing to look at. It was measured at 313 ms once, because a hit-test at x=200 returns the home screen's Health icon, whose frame ends at x=188.67.
- **Anything reading the whole screen costs ~300 ms**, because it reads the app's real view hierarchy. A `ui_find` that misses pays the same, since it falls back to that read. This is the reason to tap by name rather than describing the screen and picking coordinates.

Discard the first call after a simulator starts — it includes connecting to the companion and runs an order of magnitude slower than the rest.

---

## Result

All tools tested:

| Tool | Steps |
|------|-------|
| `start_simulator` | #1, #21, #23, #35, #43 |
| `destroy_simulator` | #21, #22, #34, #42, #47 |
| `attach_simulator` | #21 |
| `rotate` | #26 |
| `detect_rotation` | #27 |
| `ui_describe_all` | #3, #10, #25, #29 |
| `ui_find` | #11, #12, #13, #15, #30, #32, #33, #37, #40, #45, #46 |
| `ui_tap` | #13, #14, #19, #30, #32, #33, #35, #39, #41, #44, #45, #46, #47 |
| `ui_type` | #15, #33 |
| `ui_swipe` | #5 |
| `ui_describe_point` | #4, #16, #38 |
| `ui_view` | #2, #6, #9, #24, #28, #31, #36, #39, #41, #45 |
| `screenshot` | #17 |
| `record_video` | #18 |
| `stop_recording` | #20 |
| `install_app` | #7, #23, #35, #43 |
| `launch_app` | #8, #23, #35, #40, #43 |
