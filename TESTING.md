# Manual Testing Guide

Step-by-step test plan that exercises every MCP tool. Run through the portrait section first, then the landscape coordinate verification section.

Session ID used throughout: `test-session`

**Known issue — simulator boot time.** `start_simulator` returns success before the simulator is actually driveable. Until that is fixed, after any `start_simulator` you must poll `ui_view` until it stops erroring. Expect **40–90 seconds**, not the 10 seconds this guide previously claimed. While booting, every UI tool fails with a misleading message:

```
INTERNAL: No translation object returned for simulator. This means you have likely
specified a point onscreen that is invalid or invisible due to a fullscreen dialog
```

That error does **not** mean your coordinates are wrong — it usually means the device is still booting.

**Known issue — incomplete accessibility trees.** `ui_describe_all` sometimes returns containers with `"children": []` even though elements are plainly visible — the bottom `Toolbar` group is affected consistently, and freshly-presented views (such as search results) can come back with the entire content area empty. `ui_describe_point` still resolves those elements correctly. Where this guide says to locate something with `ui_describe_point` rather than `ui_describe_all`, that is why.

---

## Part 1 — Portrait Mode (all tools)

### #1 start_simulator

```
start_simulator(id: "test-session", type: "iPhone")
```

**Expected:** Simulator is created and booted. Output includes device name, type, and UDID.

Poll `ui_view(id: "test-session")` until it returns a screenshot instead of an error before continuing. See the boot-time note above.

### #2 ui_view — home screen

```
ui_view(id: "test-session")
```

**Expected:** Returns a JPEG screenshot showing the iOS home screen with app icons.

### #3 ui_describe_all — accessibility tree

```
ui_describe_all(id: "test-session")
```

**Expected:** Returns a JSON accessibility tree. The root element should have a non-zero `frame` (e.g. `{"x":0,"y":0,"width":402,"height":874}` on an iPhone 17 Pro — exact dimensions vary by device). Should contain child elements for app icons (e.g. "Settings", "Photos", "Safari").

### #4 ui_describe_point — query specific coordinates

Using the coordinates of an app icon from step #3 (e.g. the center of the Settings icon):

```
ui_describe_point(id: "test-session", x: <settings_x>, y: <settings_y>)
```

**Expected:** Returns the accessibility element at that point, including `AXLabel` matching the app icon name (e.g. "Settings").

### #5 ui_swipe — swipe to the second home screen page

The first home screen page is full of apps with intrusive first-run wizards, so the test flow uses Contacts on page 2. This step doubles as the `ui_swipe` test.

```
ui_swipe(id: "test-session", x_start: 350, y_start: 550, x_end: 50, y_end: 550, duration: "0.3")
```

**Expected:** Output says "Swiped successfully".

### #6 ui_view + ui_find — verify page 2 and locate Contacts

```
ui_view(id: "test-session")
```

**Expected:** Screenshot shows the second home screen page — a different set of icons including **Contacts**, **Fitness**, **Watch**, **Files**. This confirms the swipe in #5 took effect.

Then confirm `ui_find` locates the icon without fetching the whole tree:

```
ui_find(id: "test-session", label: "Contacts")
```

**Expected:** Returns a single element with `AXLabel` "Contacts" and a frame on the current page.

### #7 ui_tap — open Contacts by label

Tap by label rather than coordinates, to exercise label resolution:

```
ui_tap(id: "test-session", label: "Contacts")
```

**Expected:** Output says "Tapped successfully".

### #8 ui_view — verify Contacts opened

```
ui_view(id: "test-session")
```

**Expected:** Screenshot shows the Contacts app with the sample contact list (John Appleseed, Kate Bell, Anna Haro, Daniel Higgins Jr., David Taylor, Hank M. Zakroff). Contacts is used deliberately: it presents **no first-run wizards**.

### #9 ui_describe_point — locate the search text field

Contacts has a search text field in the bottom toolbar. It will **not** appear in `ui_describe_all` (see the incomplete-tree note above), so locate it by point. Probe near the bottom centre of the screen:

```
ui_describe_point(id: "test-session", x: 170, y: 822)
```

**Expected:** Returns `"type": "TextField"` with `"subrole": "AXSearchField"` and `"AXValue": "Search"`. Note its frame — e.g. `{{33, 803}, {276, 38}}` — and compute the centre for the next step.

Note the field's `AXLabel` is `null`, so it cannot be tapped by label.

### #10 ui_tap — tap the search field

Using the centre of the frame from step #9:

```
ui_tap(id: "test-session", x: 171, y: 822)
```

**Expected:** "Tapped successfully". The search field is focused.

On a fresh simulator a first-run **QuickPath keyboard overlay** ("Speed up your typing by sliding your finger across the letters…") may cover the keyboard. It does not need dismissing — typing in the next step works anyway and clears it.

### #11 ui_type — type text

```
ui_type(id: "test-session", text: "Kate")
```

**Expected:** Output says "Typed successfully".

### #12 ui_view — verify typed text and filtering

```
ui_view(id: "test-session")
```

**Expected:** Screenshot shows "Kate" in the search field and a filtered result **"Kate Bell"** under a "Top Name Matches" heading.

Contacts search is used rather than Settings search because Settings search depends on a background index that is not built on a freshly-created simulator, and returns "No Results" for anything for the first several minutes.

### #13 screenshot — save to file

```
screenshot(id: "test-session", output_path: "/tmp/mcp-test-screenshot.png")
```

**Expected:** Output includes "Wrote screenshot to". Verify the file exists at `/tmp/mcp-test-screenshot.png` and is a valid PNG. Note the file is in **physical pixels** (e.g. 1206x2622 for a 402x874 logical frame at 3x).

### #14 record_video — start recording

```
record_video(id: "test-session")
```

**Expected:** Output says recording started and gives the output file path (defaults to `~/Downloads/simulator_recording_<timestamp>.mp4` unless `IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR` is set).

### #15 ui_tap — do something while recording

Tap the filtered contact to create activity in the recording. Note that at this point `ui_describe_all` may return an empty tree for the search-results view, and `ui_tap` by label will fail with "No element found" — use coordinates from `ui_describe_point`:

```
ui_describe_point(id: "test-session", x: 100, y: 130)
ui_tap(id: "test-session", x: 194, y: 130)
```

**Expected:** "Tapped successfully".

### #16 stop_recording — stop and verify

```
stop_recording(id: "test-session")
```

**Expected:** Output says "Recording stopped successfully." Verify the video file exists at the path given in step #14 and is non-trivial in size (several MB for a short recording).

### #17 install_app

**Requires a fixture.** This repo does not ship a test `.app` bundle, so this step needs one supplied — either build any simple iOS app for the simulator, or point at an existing `.app` in your Xcode DerivedData. Record the path and bundle identifier before running.

```
install_app(id: "test-session", app_path: "<path to a .app bundle>")
```

**Expected:** Output says "App installed successfully from: ...".

Skip #17–#19 if no fixture is available; `launch_app` is still covered by step #24.

### #18 launch_app

```
launch_app(id: "test-session", bundle_id: "<bundle id of installed app>")
```

**Expected:** Output says the app launched successfully — e.g. `App <bundle_id> launched successfully`. (The output does **not** include a PID.)

### #19 ui_view — verify app launched

```
ui_view(id: "test-session")
```

**Expected:** Screenshot shows the installed app is running.

### #20 destroy_simulator — destroy the owned session

First note the UDID from step #1. Destroy the current session:

```
destroy_simulator(id: "test-session")
```

**Expected:** Output says "Simulator destroyed".

### #21 attach_simulator — reattach

Since step #20 deleted the sim (owned=true), create a new one to test attach:

```
start_simulator(id: "owner-session", type: "iPhone")
```

Poll `ui_view` until it succeeds, then note the UDID from the output.

```
attach_simulator(id: "attach-test", udid: "<udid from owner-session>")
```

**Expected:** Output says "Attached to simulator: ...".

### #22 Verify attached session works, then clean up

```
ui_view(id: "attach-test")
```

**Expected:** Returns a screenshot from the same simulator.

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

Poll `ui_view` until it succeeds before continuing.

### #24 Open Photos app

```
launch_app(id: "landscape-test", bundle_id: "com.apple.mobileslideshow")
```

**Expected:** Output says `App com.apple.mobileslideshow launched successfully`.

### #24.5 Dismiss the first-run wizards

On a fresh simulator Photos opens into onboarding, not the library. There are **two** dialogs to clear, in order:

1. A **"What's New in Photos"** screen — tap its **Continue** button.

   ```
   ui_tap(id: "landscape-test", label: "Continue")
   ```

2. A **notifications permission** prompt — tap **Don't Allow**.

   ```
   ui_tap(id: "landscape-test", label: "Don’t Allow")
   ```

   ⚠️ That apostrophe is **U+2019** (typographic), not an ASCII `'`. iOS labels the
   button `Don’t Allow`, and `ui_tap` matches by exact substring, so an ASCII
   apostrophe fails with "No element found". Match on `Allow` alone if in doubt —
   but note it also substring-matches the **Allow** button, so prefer the full
   curly-apostrophe string.

**Expected:** Both taps report "Tapped successfully", and the Photos library is visible afterwards.

If a tap by label fails, fall back to `ui_describe_point` to locate the button (see the incomplete-tree note at the top). Take a `ui_view` between the two taps if you need to confirm which dialog is showing — the order and exact wording vary between iOS versions.

### #25 ui_view — verify Photos in portrait

```
ui_view(id: "landscape-test")
```

**Expected:** Screenshot shows the Photos app **library content** in portrait orientation — not an onboarding or permission screen. If a wizard is still showing, step #24.5 did not complete.

### #26 Rotate to landscape

**Manual step:** In the Simulator app, use the menu **Device > Rotate Left** (or Cmd+Left Arrow) to rotate the device.

Wait a few seconds for the UI to settle.

> This step cannot be performed by an MCP client — no rotation tool is exposed, and driving the Simulator app directly is out of bounds. A human must do this, or Part 2 must be run manually.

### #27 detect_rotation

```
detect_rotation(id: "landscape-test")
```

**Expected:** Output says the detected orientation is `landscape_left`, matching the **Rotate Left** performed in step #26. (If you rotated the other way, expect `landscape_right`.)

### #28 ui_view — verify landscape screenshot

```
ui_view(id: "landscape-test")
```

**Expected:** Screenshot is in landscape orientation showing the Photos app rotated.

### #29 ui_describe_all — get landscape coordinates

```
ui_describe_all(id: "landscape-test")
```

**Expected:** Root frame has width > height — `874x402` instead of `402x874` on an iPhone 17 Pro. Elements have coordinates in logical landscape space.

**The tab bar buttons will not be in this output.** The `Tab Bar` group at `{{0, 338}, {874, 64}}` comes back with `"children": []`, and `ui_find(id: "landscape-test", label: "Collections")` also reports "No element found" — even though the element does carry that exact label. Locate the two tabs by point instead:

```
ui_describe_point(id: "landscape-test", x: 100, y: 360)   → Library tab
ui_describe_point(id: "landscape-test", x: 205, y: 360)   → Collections tab
```

**Expected:** `AXRadioButton` / subrole `AXTabButton` elements with `AXUniqueId` `LibraryTab` and `CollectionsTab`, labels "Library" and "Collections", frames around `{{42, 342}, {91, 36}}` and `{{137, 342}, {111, 36}}`. The selected one has `AXValue: 1` and a `Selected` trait.

Note which tab is currently selected — Photos usually opens on **Collections**, which matters for the next step.

### #30 ui_tap — tap element using logical coordinates

Photos normally starts on Collections, so tapping Collections first would assert nothing — the screen would be unchanged whether or not the coordinate landed correctly. Switch **away** first, then back.

Tap Library, using the centre of the Library frame from step #29:

```
ui_tap(id: "landscape-test", x: 87.5, y: 360)
```

**Expected:** "Tapped successfully", and a following `ui_view` shows the **Library** view — a photo grid titled "Library" with a photo count. This is the real assertion of Part 2: a coordinate derived from a landscape accessibility tree hit the element it pointed at.

Then tap Collections, using the centre of the Collections frame:

```
ui_tap(id: "landscape-test", x: 192.5, y: 360)
```

**Expected:** "Tapped successfully".

### #31 ui_view — verify tap worked

```
ui_view(id: "landscape-test")
```

**Expected:** Screenshot shows the **Collections view, with "Collections" as the title** — Memories and Pinned shelves visible. Combined with the Library screenshot in #30, this confirms both taps landed on their intended tabs and the coordinate transformation round-trips.

### #32 ui_describe_all — verify state change

```
ui_describe_all(id: "landscape-test")
```

**Expected:** The tree reflects Collections **content** — headings "Memories", "Pinned", "Albums", and buttons "Favorites", "Recently Saved", "Map", "Videos", "Screenshots", "Recently Deleted".

Do **not** expect a "Collections" title element: the Nav bar group is childless and carries the string only as `AXUniqueId`, with `AXLabel: null`. The visible title is not represented as a labelled element.

### #33 Second coordinate test — tap the overflow menu

The three dots (`...`) sit in the nav bar, which is also childless, so locate the button by point rather than from the #32 output:

```
ui_describe_point(id: "landscape-test", x: 750, y: 46)
```

**Expected:** `AXPopUpButton` labelled **"View Options and Reorder"**, frame around `{{737, 28}, {28, 36}}`.

Tap its centre:

```
ui_tap(id: "landscape-test", x: 751, y: 46)
ui_view(id: "landscape-test")
```

**Expected:** The overflow menu opens, showing **Show All**, **Collapse All**, **Reorder** and a row of layout options. This confirms the coordinate transformation is consistent across more than one element, in a different region of the screen.

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
| `start_simulator` | #1, #21, #23 |
| `destroy_simulator` | #20, #22, #34 |
| `attach_simulator` | #21 |
| `detect_rotation` | #27 |
| `ui_describe_all` | #3, #29, #32 |
| `ui_find` | #6 |
| `ui_tap` | #7, #10, #15, #24.5, #30, #33 |
| `ui_type` | #11 |
| `ui_swipe` | #5 |
| `ui_describe_point` | #4, #9, #15 |
| `ui_view` | #2, #6, #8, #12, #19, #25, #28, #31, #33 |
| `screenshot` | #13 |
| `record_video` | #14 |
| `stop_recording` | #16 |
| `install_app` | #17 |
| `launch_app` | #18, #24 |
