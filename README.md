# iOS Multi-Simulator MCP Server

Forked from [joshuayoes/ios-simulator-mcp](https://github.com/joshuayoes/ios-simulator-mcp) — all foundational work by Joshua Yoes, but this fork adds some substantial new features and is not directly compatible. This fork does _NOT_ require idb-companion nor idb python cli scripts to be installed. It is a lot faster than the original.

An MCP server that lets AI agents create, control, and destroy iOS simulators through session-based lifecycle management. Each session owns its own simulator, enabling multiple agents to work in parallel on separate simulators without conflicts.

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   Agent A    │  │   Agent B    │  │   Agent C    │
│  (id: "qa1") │  │  (id: "qa2") │  │  (id: "dev") │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       └────────────┬────┴────┬────────────┘
                    │         │
              ┌─────┴─────────┴──────┐
              │    MCP Server        │
              │  (single process)    │
              └──┬─────────┬──────┬──┘
                 │         │      │
          ┌──────┴──┐ ┌────┴───┐ ┌┴────────┐
          │ iPhone  │ │ iPad   │ │ iPhone  │
          │ 16 Pro  │ │ Air    │ │ 16 Pro  │
          │ (qa1)   │ │ (qa2)  │ │ (dev)   │
          └─────────┘ └────────┘ └─────────┘
```

**What this fork adds:**

- **Session-based lifecycle** — `start_simulator` / `destroy_simulator` create and tear down simulators on demand, with automatic cleanup on server exit
- **Multi-agent support** — each session gets an isolated simulator, so parallel agents don't collide
- **Attach to existing simulators** — `attach_simulator` lets you control a simulator that was created externally (e.g. by Xcode)
- **Tap by name** — `ui_tap { label: "Sign Up" }` resolves the element on the simulator and taps it, so the model never reads a tree or picks coordinates. Around 340 bytes instead of 7–10 KB
- **No Python** — talks to `idb_companion` over gRPC directly. No `pipx`, no `fb-idb`, no `brew install`. A tap costs ~1.2 ms instead of the ~165 ms it took to spawn a Python process
- **A current companion** — Homebrew's `idb_companion` is from 2022. This ships its own, built from a pinned upstream commit, which is what makes tap-by-name possible at all
- **Self-healing accessibility** — the empty-tree failure that used to require destroying and recreating a simulator is now recovered automatically
- Removed `get_booted_sim_id` / `open_simulator` / `IDB_UDID` — the session model replaces all of these

## Prerequisites

- **Node.js** (v18+)
- **macOS on Apple Silicon** — iOS simulators are macOS-only, and the companion is arm64 only
- **Xcode** with iOS simulators installed

That is the whole list. You do NOT install `idb_companion` yourself — the server
fetches a pinned one on first use. See
[How `idb_companion` is obtained](#how-idb_companion-is-obtained).

## Installation

First run the mcp in http mode:
```
npx -y ios-multi-simulator-mcp --port 54321
```

**Then add the mcp to your agent**

**Claude Code:**

```bash
claude mcp add --transport http ios-multi-simulator http://localhost:54321/mcp
```

**Cursor and other config-file clients** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "ios-multi-simulator": {
      "type": "http",
      "url": "http://127.0.0.1:54321/mcp"
    }
  }
}
```

## Example usage

The internal help should allow your agent to figure out how to drive it, but
[AGENT_INSTRUCTIONS.md](AGENT_INSTRUCTIONS.md) can be provided for more concrete
examples. In our testing the instructions below are typically sufficient.

Each agent picks a distinct session `id` and passes it to every tool. Because
all state lives in the one shared server process, that simulator survives the
agent disconnecting; calling `start_simulator` again with the same `id` resumes
the existing simulator instead of creating a new one. Owned simulators are
destroyed when the server itself shuts down unless
`IOS_SIMULATOR_MCP_CLEANUP_ON_EXIT=false`.

> **Security note:** the HTTP transport is unauthenticated and binds to
> `127.0.0.1` by default. Do not expose the port to untrusted networks — the
> server can create and control simulators, read screenshots, and write files.
>
> Requests are checked against an allowlist of `Host` headers, which stops a web
> page you happen to visit from pointing a hostname it controls at `127.0.0.1`
> and driving the server from your browser. If you deliberately reach the server
> by another name, add it to `IOS_SIMULATOR_MCP_ALLOWED_HOSTS`. A rejected
> request says so, lists what is accepted, and names that variable.

### Running the client in a container

The simulators live on the host — a container cannot run them — so the usual
shape is the server on the host and the client inside the container, reaching
out through Docker's host alias:

```bash
# on the host: listen where the container can reach it
npx -y ios-multi-simulator-mcp --host 0.0.0.0 --port 8008
```

```json
{ "mcpServers": { "ios-multi-simulator": {
  "type": "http", "url": "http://host.docker.internal:8008/mcp"
} } }
```

`host.docker.internal`, `gateway.docker.internal` and Podman's
`host.containers.internal` are accepted by default. Any other name — a proxy, a
LAN address, a hostname of your own — needs
`IOS_SIMULATOR_MCP_ALLOWED_HOSTS="that.name:8008"`.

Binding to `0.0.0.0` exposes an unauthenticated server to every network the host
is on, so do it only on a machine you trust, and prefer publishing the port to
the container alone where your setup allows it.

**Launch an app and navigate:**

> Use ios-multi-simulator to start an iPhone 16 Pro simulator, open Settings, and navigate to General > About.

**Compare a screenshot against expected state:**

> Take a screenshot of the simulator and check whether the login screen is showing
> the "Welcome back" message.

**Multi-step agent workflow (great for Haiku subagents):**

> You are a QA agent. Start a simulator, install the app at ./build/MyApp.app,
> launch it (com.example.myapp), then:
> 1. Tap "Sign Up"
> 2. Fill in the email field with "test@example.com" and password with "password123"
> 3. Tap "Submit"
> 4. Take a screenshot and verify the success message appears

**Pro Tip:**

You can use cheap agents like Haiku to do navigation and even visual comparison. You do not need Opus to navigate around your app, saving you tons of money and time. Haiku is _almost_ fast enough that you can record demo videos without speeding up ;)

## Driving the UI

There are two ways for an agent to act on the screen, and picking the right one
is most of the difference between a cheap agent loop and an expensive one.

### When you know what you want: `ui_tap` and `ui_find`

```
ui_tap  { id: "qa1", label: "Sign Up" }
ui_find { id: "qa1", label: "Welcome back" }
```

The simulator resolves the element itself and returns only the match — a few
hundred bytes, versus several kilobytes for a whole screen. `ui_tap` operates
that element, so the model never handles a coordinate. `ui_find` returns the
element without its subtree, and reports a miss as an ordinary answer rather
than an error.

Matching is a case-sensitive substring match against the element's accessibility
label, its visible text, or its accessibility identifier. The first match wins,
so name things precisely — `ui_tap` replies with the element it acted on, which
is where a wrong match shows up.

`ui_tap` checks the touch will reach the element before sending it, so a control
that is covered, scrolled out of view or disabled is **refused** rather than
silently missed. A switch is switched rather than touched — its accessibility
frame usually spans its whole row, so the centre is not the control — and the
reply carries the state read back:

```
Tapped "Toolbar Button" (Button) at (102, 822).
Toggled Sound off -> on.
"Plain Stepper, Increment" is at {x:201 y:794 w:140 h:32}, but "Toolbar Search"
is there instead, so a tap at its centre would not reach it.
```

`ui_tap { x, y }` is always a plain touch, for when you want exactly that.

### When you need to look around: `ui_describe_all`

Use this when the agent doesn't yet know what is on screen. It returns a nested
JSON accessibility tree in logical coordinates.

### Seeing the screen: `ui_view`

`ui_view` returns a compressed screenshot, which is useful for *verifying* what
an app looks like. It is a poor choice for navigation: screenshots are in pixel
space while taps are in logical space, and the two do not line up once the
device is rotated. Navigate with labels or `ui_describe_all`; use `ui_view` to
check the result.

## Tools

All tools take a required `id` (session identifier) parameter.

| Tool | Additional Parameters | Description |
|------|----------------------|-------------|
| `start_simulator` | `type?` (e.g. "iPhone", "iPad", "iPhone 16 Pro") | Creates, boots, and opens a simulator for the session |
| `destroy_simulator` | — | Shuts down and deletes the session's simulator |
| `attach_simulator` | `udid` | Attaches to an existing booted simulator by UDID |
| `rotate` | `orientation` (`portrait`, `landscape_left`, `landscape_right`, `upside_down`) | Rotates the device, then reports the orientation the interface actually adopted |
| `detect_rotation` | — | Detects device rotation and updates coordinate mapping |
| `ui_find` | `label` | Finds one element by accessibility label, without fetching the screen |
| `ui_tap` | `label?`, `x?`, `y?`, `duration?`, `count?` | Operate an element by name, or tap at coordinates |
| `ui_describe_all` | — | Returns accessibility tree for the entire screen (JSON) |
| `ui_type` | `text` | Type text into the focused field |
| `ui_swipe` | `x_start`, `y_start`, `x_end`, `y_end`, `duration?`, `delta?` | Swipe gesture |
| `ui_describe_point` | `x`, `y` | Returns the accessibility element at a point |
| `ui_view` | — | Returns a compressed screenshot as base64 JPEG |
| `screenshot` | `output_path`, `type?`, `display?`, `mask?` | Saves a screenshot to a file |
| `record_video` | `output_path?`, `codec?`, `display?`, `mask?`, `force?` | Starts video recording |
| `stop_recording` | — | Stops the current recording |
| `install_app` | `app_path` | Installs a .app or .ipa on the simulator |
| `launch_app` | `bundle_id`, `terminate_running?` | Launches an app by bundle identifier |

## Configuration

### CLI Flags

CLI flags take precedence over the equivalent environment variables:

| Flag | Equivalent env var |
|------|--------------------|
| `--http` / `--stdio` / `--transport <mode>` | `IOS_SIMULATOR_MCP_TRANSPORT` |
| `--host <addr>` | `IOS_SIMULATOR_MCP_HTTP_HOST` |
| `--port <n>` | `IOS_SIMULATOR_MCP_HTTP_PORT` |
| `--verbose` / `-v` | `IOS_SIMULATOR_MCP_VERBOSE` |

(Each value flag also accepts the `--flag=value` form.)

### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `IOS_SIMULATOR_MCP_FILTERED_TOOLS` | Comma-separated list of tool names to hide | `screenshot,record_video` |
| `IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR` | Default directory for screenshots and recordings (default: `~/Downloads`) | `~/Code/project/tmp` |
| `IOS_SIMULATOR_MCP_COMPANION_PATH` | Custom path to the `idb_companion` binary, used verbatim and ahead of everything else | `~/idb/Build/Distribution/idb_companion` |
| `IOS_SIMULATOR_MCP_COMPANION_CACHE` | Cache root for the downloaded companion (default: `~/Library/Caches/ios-multi-simulator-mcp`) | `~/.cache/imsm` |
| `IOS_SIMULATOR_MCP_TRANSPORT` | Transport to use: `http` (default) or `stdio` | `stdio` |
| `IOS_SIMULATOR_MCP_HTTP_HOST` | Bind address in HTTP mode (default: `127.0.0.1`) | `127.0.0.1` |
| `IOS_SIMULATOR_MCP_HTTP_PORT` | Listen port in HTTP mode (default: `8008`) | `8008` |
| `IOS_SIMULATOR_MCP_CLEANUP_ON_EXIT` | Destroy owned simulators when the server shuts down (default: `true`) | `false` |
| `IOS_SIMULATOR_MCP_VERBOSE` | Log client connections and tool calls to stderr in HTTP mode (default: `false`) | `true` |
| `IOS_SIMULATOR_MCP_ALLOWED_HOSTS` | Extra `host:port` values accepted in the HTTP `Host` header. Loopback and the container host aliases are accepted already; this is for a proxy, a LAN address, or a name of your own | `mac.local:8008` |

In http mode these belong in the shell that starts the server, since that is the
process they configure — the client only holds a URL:

```bash
IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR=~/Code/project/tmp \
  npx -y ios-multi-simulator-mcp --port 54321
```

In stdio mode, where the client spawns the server, set them in the `env` block
of your MCP client config instead.

### Verbose

Adding --verbose shows the clients connecting and their commands. 
```
iOS Simulator MCP server listening on http://127.0.0.1:8008/mcp (verbose)
[2026-08-09T09:53:53.472Z] client 127.0.0.1:49630 connected
[2026-08-09T09:53:53.476Z] 127.0.0.1:49630 initialize
[2026-08-09T09:53:53.501Z] 127.0.0.1:49632 session "qa-a" start_simulator
[2026-08-09T09:53:54.900Z] 127.0.0.1:49632 session "qa-a" ui_tap
[2026-08-09T09:53:55.100Z] client 127.0.0.1:49630 disconnected
```

### Stdio mode

By default it uses http mode, but if for some reason you want to use stdio, you can specify the `--stdio` flag. Note that in that case you won't have multi agent support, since that requires multiple agents talking to one mcp.

In stdio mode the MCP client spawns the server itself, so the config is the
usual `command` / `args` form rather than a URL:

```json
{
  "mcpServers": {
    "ios-multi-simulator": {
      "command": "npx",
      "args": ["-y", "ios-multi-simulator-mcp", "--stdio"]
    }
  }
}
```

## How `idb_companion` is obtained

This mcp still uses `idb_companion` but it uses a much more recent version than the 2022 version available via brew.

The server resolves the companion binary in this order, using the first it finds:

1. **`IOS_SIMULATOR_MCP_COMPANION_PATH`**, if set — used verbatim.
2. **A locally built companion** at `vendor/idb/Build/Distribution/idb_companion`,
   if you have built the vendored idb submodule (see [CONTRIBUTING.md](CONTRIBUTING.md)).
3. **A downloaded companion**, pinned by URL and sha256 in `companion.lock.json`,
   verified against that hash and cached — so it downloads once.
4. **Otherwise the server fails with a clear error.**

There is deliberately no fallback to an `idb_companion` on your `PATH`, including
a Homebrew one, which is simply ignored. An older companion silently ignores
request fields it does not understand rather than rejecting them, so falling back
would produce wrong-but-plausible results instead of a clean failure. Details in
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Troubleshooting

**Rotated screen** — `ui_view` returns pixel space while taps use logical space,
so they don't align once rotated. Navigate with `ui_tap { label }` or
`ui_describe_all` instead; both use logical coordinates, and both cost fewer
tokens anyway.

**"I asked for `landscape_left` and the app says `landscapeRight`"** — both are
right. UIKit has two orientation vocabularies and crosses them deliberately:
`UIInterfaceOrientationLandscapeLeft` *is* `UIDeviceOrientationLandscapeRight`,
"because rotating the device to the left requires rotating the content to the
right". `rotate` and `detect_rotation` name the **device**, the same way the
Simulator's own Device > Orientation menu does; an app reading its own
`interfaceOrientation` will report the mirror word for the two landscapes.

**`rotate: "upside_down"` appears to do nothing on an iPhone** — the device does
turn, but no Face ID iPhone gives an app an upside-down interface, whatever its
`Info.plist` says. `rotate` tells you so, and reports the orientation the
interface actually kept. Use an iPad if you need that case.

For everything else, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Breaking changes

### 2.0.0 — http by default, idb is no longer a dependency

The headline: **you no longer install anything from the idb project.** The
server speaks gRPC to `idb_companion` directly instead of shelling out to the
Python `idb` command line tool, and it obtains a pinned companion itself.
Install went from five steps to one.

- **`pipx install fb-idb` is no longer needed.** Existing installs can be
  removed with `pipx uninstall fb-idb`.
- **`brew install idb-companion` is no longer needed either.** The server
  obtains a pinned companion itself and never falls back to one on your `PATH`,
  so a Homebrew companion is simply ignored.
- **`IOS_SIMULATOR_MCP_IDB_PATH` has been removed.** It pointed at the `idb`
  CLI, which is no longer run. The server now fails at startup with an
  explanation if it is set, rather than ignoring it and leaving you to believe
  a custom `idb` is in use. Use `IOS_SIMULATOR_MCP_COMPANION_PATH` to select a
  specific `idb_companion` binary.
- **Apple Silicon only.** The companion is built arm64-only; Intel Macs are no
  longer supported.
- **http is now the default transport.** Sessions live in the server process, so
  stdio — where every client spawns its own private server — cannot share a
  simulator between agents, which is the point of this fork. An existing
  `command`/`args` config will still work if you add `--stdio`, but the
  recommended setup is now to run the server yourself and point clients at its
  URL. See [Stdio mode](#stdio-mode).

## License

MIT
