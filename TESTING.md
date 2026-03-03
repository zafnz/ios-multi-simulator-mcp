# Manual Testing Guide

Step-by-step test plan that exercises every MCP tool. Run through the portrait section first, then the landscape coordinate verification section.

Session ID used throughout: `test-session`

---

## Part 1 — Portrait Mode (all tools)

### #1 start_simulator

```
start_simulator(id: "test-session", type: "iPhone")
```

**Expected:** Simulator is created and booted. Output includes device name, type, and UDID.

Wait ~10 seconds for the simulator to fully boot before continuing.

### #2 ui_view — home screen

```
ui_view(id: "test-session")
```

**Expected:** Returns a JPEG screenshot showing the iOS home screen with app icons.

### #3 ui_describe_all — accessibility tree

```
ui_describe_all(id: "test-session")
```

**Expected:** Returns a JSON accessibility tree. The root element should have a non-zero `frame` (e.g. `{"x":0,"y":0,"width":393,"height":852}`). Should contain child elements for app icons (e.g. "Settings", "Photos", "Safari").

### #4 ui_describe_point — query specific coordinates

Using the coordinates of an app icon from step #3 (e.g. the center of the Settings icon):

```
ui_describe_point(id: "test-session", x: <settings_x>, y: <settings_y>)
```

**Expected:** Returns the accessibility element at that point, including `AXLabel` matching the app icon name (e.g. "Settings").

### #5 ui_tap — open Settings

Using the same coordinates from step #4:

```
ui_tap(id: "test-session", x: <settings_x>, y: <settings_y>)
```

**Expected:** Output says "Tapped successfully".

### #6 ui_view — verify Settings opened

```
ui_view(id: "test-session")
```

**Expected:** Screenshot shows the Settings app is open (showing the Settings list view).

### #7 ui_tap — tap the search field

Use `ui_describe_all` to find the search field coordinates, then:

```
ui_tap(id: "test-session", x: <search_x>, y: <search_y>)
```

**Expected:** The search field is focused and the keyboard appears.

### #8 ui_type — type text

```
ui_type(id: "test-session", text: "General")
```

**Expected:** Output says "Typed successfully".

### #9 ui_view — verify typed text

```
ui_view(id: "test-session")
```

**Expected:** Screenshot shows "General" typed into the search field with filtered search results visible.

### #10 ui_swipe — scroll the results

```
ui_swipe(id: "test-session", x_start: 200, y_start: 600, x_end: 200, y_end: 300, duration: "0.5")
```

**Expected:** Output says "Swiped successfully".

### #11 ui_view — verify swipe

```
ui_view(id: "test-session")
```

**Expected:** Screenshot shows the list has scrolled compared to step #9.

### #12 screenshot — save to file

```
screenshot(id: "test-session", output_path: "/tmp/mcp-test-screenshot.png")
```

**Expected:** Output includes "Wrote screenshot to". Verify the file exists at `/tmp/mcp-test-screenshot.png`.

### #13 record_video — start recording

```
record_video(id: "test-session")
```

**Expected:** Output says recording started and gives the output file path.

### #14 ui_tap — do something while recording

Tap around the screen to create some activity in the recording.

### #15 stop_recording — stop and verify

```
stop_recording(id: "test-session")
```

**Expected:** Output says "Recording stopped successfully." Verify the video file exists at the path given in step #13.

### #16 install_app

```
install_app(id: "test-session", app_path: "<path to a .app bundle>")
```

**Expected:** Output says "App installed successfully from: ...".

### #17 launch_app

```
launch_app(id: "test-session", bundle_id: "<bundle id of installed app>")
```

**Expected:** Output says app launched successfully, includes PID.

### #18 ui_view — verify app launched

```
ui_view(id: "test-session")
```

**Expected:** Screenshot shows the installed app is running.

### #19 destroy_simulator — test detach/reattach first

First note the UDID from step #1. Destroy the current session:

```
destroy_simulator(id: "test-session")
```

**Expected:** Output says simulator destroyed.

### #20 attach_simulator — reattach

Since step #19 deleted the sim (owned=true), create a new one to test attach:

```
start_simulator(id: "owner-session", type: "iPhone")
```

Wait ~10 seconds, then note the UDID from the output.

```
attach_simulator(id: "attach-test", udid: "<udid from owner-session>")
```

**Expected:** Output says "Attached to simulator: ...".

### #21 Verify attached session works

```
ui_view(id: "attach-test")
```

**Expected:** Returns a screenshot from the same simulator.

### #22 Clean up attached session

```
destroy_simulator(id: "attach-test")
```

**Expected:** Output says "Detached from simulator" (not destroyed, since owned=false).

```
destroy_simulator(id: "owner-session")
```

**Expected:** Output says "Simulator destroyed" (owned=true, actually deleted).

---

## Part 2 — Landscape Coordinate Verification

This section verifies that logical coordinates work correctly after device rotation. Uses the Photos app because it supports landscape orientation.

### #23 Start a fresh simulator

```
start_simulator(id: "landscape-test", type: "iPhone")
```

Wait ~10 seconds for boot.

### #24 Open Photos app

```
launch_app(id: "landscape-test", bundle_id: "com.apple.mobileslideshow")
```

### #25 ui_view — verify Photos in portrait

```
ui_view(id: "landscape-test")
```

**Expected:** Screenshot shows the Photos app in portrait orientation.

### #26 Rotate to landscape

**Manual step:** In the Simulator app, use the menu Hardware > Rotate Left (or Cmd+Left Arrow) to rotate the device to landscape.

Wait a few seconds for the UI to settle.

### #27 detect_rotation

```
detect_rotation(id: "landscape-test")
```

**Expected:** Output says detected orientation is `landscape_right` or `landscape_left` (depending on rotation direction).

### #28 ui_view — verify landscape screenshot

```
ui_view(id: "landscape-test")
```

**Expected:** Screenshot is in landscape orientation showing the Photos app rotated.

### #29 ui_describe_all — get landscape coordinates

```
ui_describe_all(id: "landscape-test")
```

**Expected:** Root frame has width > height (e.g. `852x393` instead of `393x852`). Elements should have coordinates in logical landscape space.

Pick a tappable element from the output (e.g. a tab bar button like "Albums" or "For You") and note its coordinates.

### #30 ui_tap — tap element using logical coordinates

Using the center coordinates of the element chosen in step #29:

```
ui_tap(id: "landscape-test", x: <element_x>, y: <element_y>)
```

**Expected:** "Tapped successfully".

### #31 ui_view — verify tap worked

```
ui_view(id: "landscape-test")
```

**Expected:** Screenshot shows the tapped element was activated (e.g. navigated to the Albums tab).

### #32 ui_describe_all — verify state change

```
ui_describe_all(id: "landscape-test")
```

**Expected:** Accessibility tree reflects the new state after the tap (e.g. Albums content visible).

### #33 Second coordinate test — tap another element

Pick a different element from step #32's output and tap it:

```
ui_tap(id: "landscape-test", x: <other_x>, y: <other_y>)
```

```
ui_view(id: "landscape-test")
```

**Expected:** The second tap also hits the correct element, confirming coordinate transformation is consistent.

### #34 Clean up

```
destroy_simulator(id: "landscape-test")
```

**Expected:** Simulator destroyed.

---

## Result

All tools tested:

| Tool | Steps |
|------|-------|
| `start_simulator` | #1, #20, #23 |
| `destroy_simulator` | #19, #22, #34 |
| `attach_simulator` | #20 |
| `detect_rotation` | #27 |
| `ui_describe_all` | #3, #29, #32 |
| `ui_tap` | #5, #7, #14, #30, #33 |
| `ui_type` | #8 |
| `ui_swipe` | #10 |
| `ui_describe_point` | #4 |
| `ui_view` | #2, #6, #9, #11, #18, #25, #28, #31, #33 |
| `screenshot` | #12 |
| `record_video` | #13 |
| `stop_recording` | #15 |
| `install_app` | #16 |
| `launch_app` | #17, #24 |
