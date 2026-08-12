# Driving the iOS simulator

You control iOS simulators through the `ios-multi-simulator` MCP tools. You do
not need this file to use them — the tool descriptions are usually enough — but
it covers the things that are easy to get wrong.

## Pick a session name and keep it

Every tool takes an `id`. That is your session, and it owns one simulator.

**Choose a distinctive name for yourself and use it for every call** — something
tied to what you are doing, like `qa-login-flow` or `dev-alice`. Do not use a
generic name like `test` or `session`: other agents may be working on their own
simulators against this same server at the same time, and colliding on an `id`
means you take over each other's simulator.

Reusing your own `id` is how you resume: `start_simulator` with an `id` you
already have returns the existing simulator rather than making another.

## Start and stop

```
start_simulator   { id: "qa-login-flow", type: "iPhone 16 Pro" }
destroy_simulator { id: "qa-login-flow" }
```

`type` is optional and fuzzy — "iPhone", "iPad", "iPhone 16 Pro" all work. Call
`destroy_simulator` when you are finished so the simulator is deleted and not
left running.

To drive a simulator someone else already booted (for example from Xcode), use
`attach_simulator { id, udid }` instead. `destroy_simulator` on an attached
simulator only detaches; it will not delete a simulator you did not create.

## Do not use `xcrun simctl` or shell commands

Use the MCP tools. Do not run `xcrun simctl`, `idb`, or any other shell command
to boot, control, screenshot or inspect simulators, even if you know how.

The server owns the lifecycle of the simulators and of the process that talks to
them. Driving the same simulator from the shell behind its back causes state it
cannot see, and shutting down or deleting a simulator out from under a session
will break that session. If a tool cannot do what you need, say so rather than
reaching for the shell.

## The fastest way to navigate

**If you know what you are looking for, tap it by name.** This is by far the
cheapest option — a few hundred bytes — and you never handle coordinates:

```
ui_tap  { id: "qa-login-flow", label: "Sign Up" }
```

`label` is a case-sensitive substring match against the accessibility label.

**To check whether something is on screen**, use `ui_find`. It returns the
element, or an ordinary "not found" answer if it is absent — so it is safe to
call while waiting for a screen to appear:

```
ui_find { id: "qa-login-flow", label: "Welcome back" }
```

**Only when you do not know what is on screen**, fall back to
`ui_describe_all`, which returns the whole accessibility tree as JSON. It is
several kilobytes, so prefer `ui_find` when you can name the thing. Its `frame`
coordinates are directly usable with `ui_tap { x, y }` if you need to tap
something that has no label — tap the centre of the frame.

A good loop is: try `ui_tap { label }` first; if it reports nothing found, call
`ui_describe_all` to see what is actually there, then act on that.

## Verifying what the screen looks like

**If you are asked to check anything visual, take a screenshot with `ui_view`.**
Do not answer from the accessibility tree.

The accessibility tree tells you what elements exist and where — it says nothing
about whether something is the right colour, overlapping, cut off, misaligned,
rendered at the wrong size, or visually broken. An element can be present and
correctly labelled while looking completely wrong. If the question is about
appearance, layout, styling, or "does this look right", you need to see it.

```
ui_view { id: "qa-login-flow" }
```

Use `ui_describe_all` to decide *what to do*, and `ui_view` to judge *how it
looks*. When you report on appearance, say that you looked at a screenshot.

Do not read tap coordinates off a screenshot: screenshots are in pixel space
while taps use logical space, and the two stop agreeing once the device is
rotated. Get coordinates from `ui_describe_all`, or avoid them entirely with
`ui_tap { label }`.

Use `screenshot { output_path }` instead when the user wants the image saved to
a file rather than shown to you.

## Text entry

```
ui_type { id: "qa-login-flow", text: "test@example.com" }
```

Tap the field first so it has focus. Only printable ASCII can be typed; anything
else is rejected rather than partially typed.

## Tools

| Tool | Parameters (besides `id`) | Use it for |
|---|---|---|
| `start_simulator` | `type?` | Create and boot your simulator |
| `destroy_simulator` | — | Shut down and delete it when done |
| `attach_simulator` | `udid` | Take over an already-booted simulator |
| `ui_tap` | `label?`, `x?`, `y?`, `duration?`, `count?` | Tap by name, or at coordinates |
| `ui_find` | `label` | Locate one element cheaply / check it exists |
| `ui_describe_all` | — | See everything on screen when you don't know what's there |
| `ui_describe_point` | `x`, `y` | Identify what is at a coordinate |
| `ui_type` | `text` | Type into the focused field |
| `ui_swipe` | `x_start`, `y_start`, `x_end`, `y_end`, `duration?`, `delta?` | Scroll and swipe gestures |
| `ui_view` | — | Look at the screen (visual checks) |
| `screenshot` | `output_path`, ... | Save a screenshot to a file |
| `record_video` / `stop_recording` | `output_path?`, ... | Record a video of a flow |
| `install_app` | `app_path` | Install a .app or .ipa |
| `launch_app` | `bundle_id`, `terminate_running?` | Launch an installed app |
| `detect_rotation` | — | Re-sync coordinates after rotating the device |

## A worked example

```
start_simulator { id: "qa-login-flow", type: "iPhone 16 Pro" }
install_app     { id: "qa-login-flow", app_path: "./build/MyApp.app" }
launch_app      { id: "qa-login-flow", bundle_id: "com.example.myapp" }

ui_tap  { id: "qa-login-flow", label: "Sign Up" }
ui_tap  { id: "qa-login-flow", label: "Email" }
ui_type { id: "qa-login-flow", text: "test@example.com" }
ui_tap  { id: "qa-login-flow", label: "Submit" }

ui_find { id: "qa-login-flow", label: "Welcome" }     # did it work?
ui_view { id: "qa-login-flow" }                        # does it look right?

destroy_simulator { id: "qa-login-flow" }
```
