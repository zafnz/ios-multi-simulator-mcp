# Testing the tools

Exercises every MCP tool against one simulator. Part 1 covers portrait, Part 2 verifies coordinates after rotation, Part 3 times the server.

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

**Expected:** A screenshot showing a nav bar with **Nav Button**, a text field, **Plain Button**, a status label reading `status: ready`, an orientation label reading `orientation: interface=portrait device=portrait`, **Show In-App Modal**, **Ask Permission**, and a row of one-of-each controls (search bar, switch, slider, stepper, segmented control), and a bottom toolbar with **Toolbar Button** and a search field.

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

**Expected:** "Tapped successfully", then a status label reading `status: tapped Toolbar Button`. The status label lives in the plain hierarchy, so this confirms the toolbar tap without reading the toolbar.

### #14 ui_tap — a control that has no label

The toolbar's text field carries its visible text in `AXValue` and has no `AXLabel`:

```
ui_tap(id: "test-session", label: "Toolbar Search")
```

**Expected:** "Tapped successfully", and the field is focused. This is matching on value rather than label.

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

## Part 3 — Round-trip timing

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
| `ui_tap` by coordinate | ~2 ms |
| `ui_describe_point` | under 50 ms |
| `ui_find`, name present in the cheap tree | ~25 ms |
| `ui_find`, name absent — falls back | ~300 ms |
| `ui_describe_all` | ~300 ms |
| `ui_view` | ~350 ms |

Two things to check rather than exact figures:

- **`ui_tap` and `ui_describe_point` are fast** — single-digit milliseconds on an idle machine, and under 50 ms in any case. Past that, something is wrong with the companion connection, not with the tool. Both scale with what else the machine is doing: a busy Mac was measured at 5 ms and 22 ms for these two, with every other figure in the table up by the same factor.
- **Anything reading the whole screen costs ~300 ms**, because it reads the app's real view hierarchy. A `ui_find` that misses pays the same, since it falls back to that read. This is the reason to tap by name rather than describing the screen and picking coordinates.

Discard the first call after a simulator starts — it includes connecting to the companion and runs an order of magnitude slower than the rest.

---

## Result

All tools tested:

| Tool | Steps |
|------|-------|
| `start_simulator` | #1, #21, #23 |
| `destroy_simulator` | #21, #22, #34 |
| `attach_simulator` | #21 |
| `rotate` | #26 |
| `detect_rotation` | #27 |
| `ui_describe_all` | #3, #10, #25, #29 |
| `ui_find` | #11, #12, #13, #15, #30, #32, #33 |
| `ui_tap` | #13, #14, #19, #30, #32, #33 |
| `ui_type` | #15, #33 |
| `ui_swipe` | #5 |
| `ui_describe_point` | #4, #16 |
| `ui_view` | #2, #6, #9, #24, #28, #31 |
| `screenshot` | #17 |
| `record_video` | #18 |
| `stop_recording` | #20 |
| `install_app` | #7, #23 |
| `launch_app` | #8, #23 |
