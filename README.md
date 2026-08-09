# iOS Multi-Simulator MCP Server

Forked from [joshuayoes/ios-simulator-mcp](https://github.com/joshuayoes/ios-simulator-mcp) — all foundational work by Joshua Yoes.

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
- Removed `get_booted_sim_id` / `open_simulator` / `IDB_UDID` — the session model replaces all of these

## Tools

All tools take a required `id` (session identifier) parameter.

| Tool | Additional Parameters | Description |
|------|----------------------|-------------|
| `start_simulator` | `type?` (e.g. "iPhone", "iPad", "iPhone 16 Pro") | Creates, boots, and opens a simulator for the session |
| `destroy_simulator` | — | Shuts down and deletes the session's simulator |
| `attach_simulator` | `udid` | Attaches to an existing booted simulator by UDID |
| `detect_rotation` | — | Detects device rotation and updates coordinate mapping |
| `ui_describe_all` | — | Returns accessibility tree for the entire screen (JSON) |
| `ui_tap` | `x`, `y`, `duration?` | Tap at coordinates |
| `ui_type` | `text` | Type text into the focused field |
| `ui_swipe` | `x_start`, `y_start`, `x_end`, `y_end`, `duration?`, `delta?` | Swipe gesture |
| `ui_describe_point` | `x`, `y` | Returns the accessibility element at a point |
| `ui_view` | — | Returns a compressed screenshot as base64 JPEG |
| `screenshot` | `output_path`, `type?`, `display?`, `mask?` | Saves a screenshot to a file |
| `record_video` | `output_path?`, `codec?`, `display?`, `mask?`, `force?` | Starts video recording |
| `stop_recording` | — | Stops the current recording |
| `install_app` | `app_path` | Installs a .app or .ipa on the simulator |
| `launch_app` | `bundle_id`, `terminate_running?` | Launches an app by bundle identifier |

## `ui_describe_all` — the key navigation tool

`ui_view` lets the agent visually see the screen with a compressed jpg image. While this is sufficient for the agent to determine where to click, it will not work if the screen is rotated. But `ui_describe_all` uses logical coordinates and will work fine for finding buttons to tap. Unless there is a good reason to do otherwise, I'd suggest telling agents to use `ui_describe_all` for navigation (though `ui_view` will work so long as the screen is in portrait)

`ui_describe_all` returns a nested JSON accessibility tree. This is another way  the agent can "see" the screen to decide what to tap. Example (abbreviated):

```json
[
  {
    "type": "Application",
    "frame": { "x": 0, "y": 0, "width": 393, "height": 852 },
    "role_description": "application",
    "title": "Settings",
    "children": [
      {
        "type": "NavigationBar",
        "frame": { "x": 0, "y": 59, "width": 393, "height": 96 },
        "children": [
          {
            "type": "StaticText",
            "frame": { "x": 152, "y": 75, "width": 89, "height": 25 },
            "title": "Settings"
          }
        ]
      },
      {
        "type": "Cell",
        "frame": { "x": 0, "y": 200, "width": 393, "height": 44 },
        "title": "General",
        "AXAccessibilityElement": true
      }
    ]
  }
]
```

The `frame` coordinates map directly to `ui_tap` coordinates — to tap "General", use the centre of its frame.

## Example usage

**Hot Tip:**

You can use cheap agents like Haiku to do navigation and even visual comparison. You do not need Opus to navigate around your app, saving you tons of money and time. Haiku is _almost_ fast enough that you can record demo videos without speeding up ;)

**Launch an app and navigate:**

> Start an iPhone 16 Pro simulator, open Settings, and navigate to General > About.

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

## Prerequisites

- **Node.js** (v18+)
- **macOS on Apple Silicon** (iOS simulators are macOS-only, and the companion
  binary is arm64 only — Intel Macs are not supported)
- **Xcode** with iOS simulators installed

That is the whole list. You do **not** install `idb_companion` yourself — the
server obtains it, see [How `idb_companion` is obtained](#how-idb_companion-is-obtained).
And there is **no Python involved** — this server speaks gRPC to the companion
directly, so you do not need `pipx`, `fb-idb`, or the `idb` command line tool.

> Upgrading from a version that asked for `fb-idb`? You can safely
> `pipx uninstall fb-idb`. It is no longer used. See
> [Breaking changes](#breaking-changes).

### How `idb_companion` is obtained

The server resolves the companion binary in this order, and uses the first one
it finds:

1. **`IOS_SIMULATOR_MCP_COMPANION_PATH`**, if set — used verbatim.
2. **A locally built companion** at `vendor/idb/Build/Distribution/idb_companion`.
   This is the developer path; it only exists if you have built the vendored
   idb submodule yourself (see [CONTRIBUTING.md](CONTRIBUTING.md)).
3. **A downloaded companion.** The URL and its sha256 are pinned in
   `companion.lock.json`. The download is verified against that hash and cached
   under `~/Library/Caches/ios-multi-simulator-mcp/companion/<sha256>/`, so it
   happens once. Set `IOS_SIMULATOR_MCP_COMPANION_CACHE` to use a different
   cache root.
4. **Otherwise the server fails with a clear error.**

Note what is *not* in that list: there is deliberately **no fallback to an
`idb_companion` on your `PATH`** — including one installed with
`brew install idb-companion`. An older companion does not reject request fields
it does not understand, it silently ignores them, so falling back to whatever
happens to be installed would produce wrong-but-plausible results instead of a
clean failure. If you do want to use your own build, point
`IOS_SIMULATOR_MCP_COMPANION_PATH` at it and you own the compatibility.

## Installation

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ios-multi-simulator": {
      "command": "npx",
      "args": ["-y", "github:zafnz/ios-multi-simulator-mcp"]
    }
  }
}
```

For local development, build from source and point to the built file:

```json
{
  "mcpServers": {
    "ios-multi-simulator": {
      "command": "node",
      "args": ["/path/to/ios-multi-simulator-mcp/build/index.js"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add ios-multi-simulator npx -y github:zafnz/ios-multi-simulator-mcp
```

For local development:

```bash
claude mcp add ios-multi-simulator -- node /path/to/ios-multi-simulator-mcp/build/index.js
```

## Troubleshooting

**Rotated screen**

The rotated screen is a problem when using `ui_view` due to the tapping and swipping using logical coordinate space, but the ui_view returning the pixel space, which when rotated don't align. Tell the agent to use `ui_describe_all` to navigate -- it uses less tokens anyhow. 

## Configuration

### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `IOS_SIMULATOR_MCP_FILTERED_TOOLS` | Comma-separated list of tool names to hide | `screenshot,record_video` |
| `IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR` | Default directory for screenshots and recordings (default: `~/Downloads`) | `~/Code/project/tmp` |
| `IOS_SIMULATOR_MCP_COMPANION_PATH` | Custom path to the `idb_companion` binary, used verbatim and ahead of everything else | `~/idb/Build/Distribution/idb_companion` |
| `IOS_SIMULATOR_MCP_COMPANION_CACHE` | Cache root for the downloaded companion (default: `~/Library/Caches/ios-multi-simulator-mcp`) | `~/.cache/imsm` |
| `IOS_SIMULATOR_MCP_TRANSPORT` | Transport to use: `stdio` (default) or `http` | `http` |
| `IOS_SIMULATOR_MCP_HTTP_HOST` | Bind address in HTTP mode (default: `127.0.0.1`) | `127.0.0.1` |
| `IOS_SIMULATOR_MCP_HTTP_PORT` | Listen port in HTTP mode (default: `8008`) | `8008` |
| `IOS_SIMULATOR_MCP_CLEANUP_ON_EXIT` | Destroy owned simulators when the server shuts down (default: `true`) | `false` |
| `IOS_SIMULATOR_MCP_VERBOSE` | Log client connections and tool calls to stderr in HTTP mode (default: `false`) | `true` |

Example with env vars:

```json
{
  "mcpServers": {
    "ios-multi-simulator": {
      "command": "npx",
      "args": ["-y", "ios-multi-simulator-mcp"],
      "env": {
        "IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR": "~/Code/project/tmp",
        "IOS_SIMULATOR_MCP_COMPANION_PATH": "~/idb/Build/Distribution/idb_companion"
      }
    }
  }
}
```

### HTTP transport (multi-agent)

By default the server runs over **stdio**, where each MCP client spawns its own
private server process — so simulator sessions are not shared between separate
clients.

To let multiple agents (separate Claude/Cursor instances) drive their own
simulators against a single shared server — and to let an agent disconnect and
later reconnect to the same simulator using the same session `id` — run one
long-lived server in **HTTP** mode.

Using CLI flags:

```bash
npx -y ios-multi-simulator-mcp --http --port 8008
```

Or the equivalent environment variables:

```bash
IOS_SIMULATOR_MCP_TRANSPORT=http \
IOS_SIMULATOR_MCP_HTTP_PORT=8008 \
  npx -y ios-multi-simulator-mcp
```

CLI flags take precedence over the environment variables:

| Flag | Equivalent env var |
|------|--------------------|
| `--http` / `--stdio` / `--transport <mode>` | `IOS_SIMULATOR_MCP_TRANSPORT` |
| `--host <addr>` | `IOS_SIMULATOR_MCP_HTTP_HOST` |
| `--port <n>` | `IOS_SIMULATOR_MCP_HTTP_PORT` |
| `--verbose` / `-v` | `IOS_SIMULATOR_MCP_VERBOSE` |

(Each value flag also accepts the `--flag=value` form.)

With `--verbose`, the server logs client connections and each call to stderr:

```
iOS Simulator MCP server listening on http://127.0.0.1:8008/mcp (verbose)
[2026-08-09T09:53:53.472Z] client 127.0.0.1:49630 connected
[2026-08-09T09:53:53.476Z] 127.0.0.1:49630 initialize
[2026-08-09T09:53:53.501Z] 127.0.0.1:49632 session "qa-a" start_simulator
[2026-08-09T09:53:54.900Z] 127.0.0.1:49632 session "qa-a" ui_tap
[2026-08-09T09:53:55.100Z] client 127.0.0.1:49630 disconnected
```

Then point each client at it as a remote MCP server:

```json
{
  "mcpServers": {
    "ios-multi-simulator": {
      "type": "http",
      "url": "http://127.0.0.1:8008/mcp"
    }
  }
}
```

Each agent picks a distinct session `id` and passes it to every tool. Because
all state lives in the one shared server process, that simulator survives the
agent disconnecting; calling `start_simulator` again with the same `id` resumes
the existing simulator instead of creating a new one. Owned simulators are
destroyed when the server itself shuts down unless
`IOS_SIMULATOR_MCP_CLEANUP_ON_EXIT=false`.

> **Security note:** the HTTP transport is unauthenticated and binds to
> `127.0.0.1` by default. Do not expose the port to untrusted networks — the
> server can create and control simulators and run screen recordings.

## Breaking changes

### Python `fb-idb` is no longer used

The server now speaks gRPC to `idb_companion` directly instead of shelling out
to the Python `idb` command line tool.

- **`pipx install fb-idb` is no longer needed.** Existing installs can be
  removed with `pipx uninstall fb-idb`.
- **`brew install idb-companion` is no longer needed either.** The server
  obtains a pinned companion itself and never falls back to one on your `PATH`,
  so a Homebrew companion is simply ignored. See
  [How `idb_companion` is obtained](#how-idb_companion-is-obtained).
- **`IOS_SIMULATOR_MCP_IDB_PATH` has been removed.** It pointed at the `idb`
  CLI, which is no longer run. The server now fails at startup with an
  explanation if it is set, rather than ignoring it and leaving you to believe
  a custom `idb` is in use. Use `IOS_SIMULATOR_MCP_COMPANION_PATH` to select a
  specific `idb_companion` binary.

Why it is worth the upgrade: every UI call used to spawn a Python process,
which cost roughly 165ms per tap. Over a persistent connection the same tap
takes about 1.2ms. The server also now manages `idb_companion` itself, which
means an empty accessibility tree — previously only fixable by destroying and
recreating the simulator — is recovered automatically.

## License

MIT
