# iOS Simulator MCP - TROUBLESHOOTING

If you encounter errors or issues using this MCP server, try the following troubleshooting steps before reporting a bug:

## 1. Prerequisites
- **macOS Only:** This server only works on macOS with Xcode and iOS simulators installed.
- **IDB Tool:** Ensure [Facebook IDB](https://fbidb.io/) is installed and available in your PATH.
- **Node.js:** Make sure Node.js is installed and up to date.

## 2. Installing IDB 

The installation section in [IDB](https://fbidb.io/docs/installation/) is a little out of date. Since [python environments are famously borked](https://xkcd.com/1987/), here are some ways to install that are hopefully compatible with your existing python install.

### Using Homebrew + pip

1. Install [Homebrew](https://brew.sh/) if you don't have it:
   ```sh
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```
2. Install Python (if not already installed):
   ```sh
   brew install python
   ```
3. Install idb using pip:
   ```sh
   pip3 install --user fb-idb
   ```
4. Ensure your user base binary directory is in your PATH (often `~/.local/bin`):
   ```sh
   export PATH="$HOME/.local/bin:$PATH"
   # Add the above line to your ~/.zshrc or ~/.bash_profile for persistence
   ```
5. Verify installation:
   ```sh
   idb -h
   ```

### Using asdf (Python version manager)

1. Install [asdf](https://asdf-vm.com/):
   ```sh
   brew install asdf
   ```
2. Add the [Python plugin](https://github.com/asdf-community/asdf-python), install Python, set to global version (see asdf docs for [set](https://asdf-vm.com/manage/versions.html#set-version) and [global](https://asdf-vm.com/guide/getting-started-legacy.html#global) to do isolated installs):
   ```sh
   asdf plugin add python
   asdf install python latest
   asdf global python latest
   asdf set python <latest-version> -u
   asdf reshim
   ```
3. Install idb using pip:
   ```sh
   python -m pip install --user fb-idb
   ```
4. Ensure your user base binary directory is in your PATH (often `~/.local/bin`):
   ```sh
   export PATH="$HOME/.local/bin:$PATH"
   # Add the above line to your ~/.zshrc or ~/.bash_profile for persistence
   ```
5. Verify installation:
   ```sh
   idb -h
   ```

## 3. Common Issues & Fixes

### "No booted simulator found"
- Open Xcode and boot an iOS simulator manually.
- Run `xcrun simctl list devices` to verify a simulator is booted.

### "idb: command not found" or IDB errors
- Follow the install steps above for Homebrew + pip or asdf.
- Ensure `idb` is in your PATH: try running `idb --version` in your terminal.

### Permission or File Errors
- Ensure you have permission to write to the output path (e.g., for screenshots or recordings).
- Try using a path in your home directory or `~/Downloads`.

### Simulator UI Not Responding
- Restart the simulator and try again.
- Quit and relaunch Xcode if needed.
- Prompt AI to check dimensions of the simulator screen and adjust coordinates to it. Screenshots have 3x resolution and this may result in incorrect position of screen presses.

### Empty accessibility tree ("idb returned an empty accessibility tree, but the simulator is booted")

**Symptom:** `ui_describe_all` and `ui_view` fail even though the simulator is
clearly booted and other tools work. `ui_describe_point` still returns real
elements. The error names this condition explicitly.

**What it is:** a known accessibility failure in `idb` (Facebook's iOS Debug
Bridge). idb's full-tree `describe-all` returns a single empty element (`0x0`
frame, no children) while point queries keep working. The broken state is stored
in the simulator's data container, so it **survives reboots, `idb kill`, and
restarting SpringBoard** — only recreating the simulator (or `xcrun simctl
erase`, which wipes it) recovers it. This is not a bug in this MCP server; it
faithfully reports what idb returns.

**Important — check your idb version.** The last *packaged* idb release is
**v1.1.8 (Aug 2022)**, which is what Homebrew and `pip install fb-idb` give you —
but idb's source is actively developed, and its accessibility subsystem (the
hit-test / read code behind this exact failure) was being reworked as recently as
Aug 2026. If you are on the 2022 build (`idb_companion --version`), **building
idb from [source](https://github.com/facebook/idb) may fix or reduce this bug.**
Newer builds also add `idb ui --api` / `--format` flags to select alternative
accessibility backends, which can be worth trying.

**How to recover:**
- Call `destroy_simulator` then `start_simulator` with the same session `id`.
  This gives a fresh simulator. **Any app you installed must be reinstalled**,
  and any in-simulator state is lost.
- Equivalent from the shell (keeps the same UDID): `xcrun simctl shutdown <UDID>
  && xcrun simctl erase <UDID> && xcrun simctl boot <UDID>`.

**Before you recreate, please gather diagnostics** so the trigger can be found —
recreating erases the evidence. Note the affected UDID first (it is in the error,
or from `xcrun simctl list devices | grep Booted`), then collect:

1. **Confirm the split behaviour** (this is the fingerprint of the bug):
   ```sh
   U=<UDID>
   # describe-all: expect a single 0x0 element with no children
   idb ui describe-all --udid $U --json --nested
   # describe-point: expect a real element with a non-zero frame
   idb ui describe-point --udid $U --json -- 100 100
   ```
2. **Versions and device:**
   ```sh
   idb_companion --version
   xcrun simctl list devices | grep <UDID>   # device type + iOS runtime
   sw_vers                                    # macOS / Xcode host
   ```
3. **idb companion log** for that simulator — look for errors such as
   `Unrecognised type` or `accessibilityElementsWithNestedFormat`:
   ```sh
   grep -iE "error|fail|unrecognised|accessibility" /tmp/idb/logs/<UDID> | tail -40
   ```
4. **The trigger — most important.** If you run the MCP server in HTTP mode with
   `--verbose`, its stderr logs every call as `session "<id>" <tool>`. Capture
   the sequence of calls for that session leading up to the first failure — this
   shows what the agent did right before the tree broke. Also note **what app was
   installed/launched** and the last few actions before it started failing.

Include all of the above when you [open an
issue](https://github.com/zafnz/ios-simulator-mcp/issues).

## 4. Still Stuck?
- Check the [README](./README.md) for setup and usage instructions.
- If the problem persists, [open an issue](https://github.com/joshuayoes/ios-simulator-mcp/issues) and include the error message and steps to reproduce.

