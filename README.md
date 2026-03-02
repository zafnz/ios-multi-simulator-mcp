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
- **macOS** (iOS simulators are macOS-only)
- **Xcode** with iOS simulators installed
- **Facebook IDB** — 

### Facebook IDB (Important)

This dependency is a little more involved. The official [install guide](https://fbidb.io/docs/installation) can be a little difficult, the easiest way to install it (imo) is to use `pipx`. 

**MacOS:**
```
# Install pipx to make installing python packages easier
brew install pipx
pipx ensurepath

brew tap facebook/fb
brew install idb-companion
pipx install fb-idb
```

## Installation

Please note the `fb-idb` dependecy above!

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
| `IOS_SIMULATOR_MCP_IDB_PATH` | Custom path to the IDB executable | `/opt/homebrew/bin/idb` |

Example with env vars:

```json
{
  "mcpServers": {
    "ios-multi-simulator": {
      "command": "npx",
      "args": ["-y", "ios-multi-simulator-mcp"],
      "env": {
        "IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR": "~/Code/project/tmp",
        "IOS_SIMULATOR_MCP_IDB_PATH": "/opt/homebrew/bin/idb"
      }
    }
  }
}
```

## License

MIT
