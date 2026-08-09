# iOS Simulator MCP - TROUBLESHOOTING

If you encounter errors or issues using this MCP server, try the following troubleshooting steps before reporting a bug:

## 1. Prerequisites
- **macOS Only:** This server only works on macOS with Xcode and iOS simulators installed.
- **idb_companion:** Ensure `idb_companion` is installed and on your PATH.
- **Node.js:** Make sure Node.js is installed and up to date.

## 2. Installing idb_companion

```sh
brew tap facebook/fb
brew install idb-companion
```

Verify it with `idb_companion --version`.

That is the only external dependency. **No Python is required.** This server
speaks gRPC to `idb_companion` directly, so `pipx install fb-idb` and the `idb`
command line tool are not used. If you installed `fb-idb` for an older version of
this server, `pipx uninstall fb-idb` is safe.

If the companion lives somewhere unusual, point at it with
`IOS_SIMULATOR_MCP_COMPANION_PATH`.

## 3. Common Issues & Fixes

### "No booted simulator found"
- Open Xcode and boot an iOS simulator manually.
- Run `xcrun simctl list devices` to verify a simulator is booted.

### "Could not start idb_companion" / companion not found
- Install it: `brew tap facebook/fb && brew install idb-companion`.
- Verify it runs: `idb_companion --version`.
- If it is installed somewhere not on your PATH, set
  `IOS_SIMULATOR_MCP_COMPANION_PATH` to its full path.
- Note the `idb` Python CLI is **not** used any more; you do not need it.

### Permission or File Errors
- Ensure you have permission to write to the output path (e.g., for screenshots or recordings).
- Try using a path in your home directory or `~/Downloads`.

### Simulator UI Not Responding
- Restart the simulator and try again.
- Quit and relaunch Xcode if needed.
- Prompt AI to check dimensions of the simulator screen and adjust coordinates to it. Screenshots have 3x resolution and this may result in incorrect position of screen presses.

### Empty accessibility tree

**Symptom:** `ui_describe_all` and `ui_view` fail, or return a single empty
element (`0x0` frame, no children), even though the simulator is clearly booted.
`ui_describe_point` may still return real elements.

**What it is:** in most cases this is **`idb_companion` state, not simulator
state**. A companion process that has been running for a while can wedge into
serving an empty tree for a simulator that is perfectly healthy. This was
verified directly: pointing a freshly spawned companion at the same simulator at
the same moment returned the full 13-element tree while the long-running
companion still returned `0x0`.

**This server now recovers automatically.** It manages `idb_companion` itself,
so when it sees a degenerate tree it restarts the companion and retries before
returning anything to you. You should rarely see this error at all now.

> Earlier versions of this guide said the broken state lived in the simulator
> and that only recreating the simulator would clear it. That was wrong for the
> common case — restarting the companion is enough, which is why the fix is now
> automatic.

**If it still fails after that**, the automatic companion restart has already
been tried, and the remaining possibilities are:

- The simulator has not finished booting. Wait a few seconds and retry.
- The simulator's own accessibility server is genuinely broken. Recover by
  calling `destroy_simulator` then `start_simulator` with the same session `id`.
  **Any app you installed must be reinstalled.** From the shell, keeping the same
  UDID: `xcrun simctl shutdown <UDID> && xcrun simctl erase <UDID> && xcrun simctl boot <UDID>`.

**Check your companion version.** The last packaged release is **v1.1.8 (Aug
2022)**, which is what Homebrew gives you, but idb's source is actively developed
and its accessibility subsystem has been reworked substantially since. Check with
`idb_companion --version`; building from [source](https://github.com/facebook/idb)
gets you a much newer accessibility implementation.

**Before you recreate a simulator, please gather diagnostics** so the trigger can
be found — recreating erases the evidence. Note the affected UDID (from the
error, or `xcrun simctl list devices | grep Booted`), then collect:

1. **Companion version and device:**
   ```sh
   idb_companion --version
   xcrun simctl list devices | grep <UDID>   # device type + iOS runtime
   sw_vers                                    # macOS host
   ```
2. **Whether a fresh companion sees the tree.** This is the key question — if it
   does, the automatic restart should have worked and we want to know why it did
   not:
   ```sh
   U=<UDID>
   idb_companion --udid $U --grpc-domain-sock /tmp/probe.sock
   # then, from another shell, drive it with this server or any gRPC client
   ```
3. **The trigger — most important.** Run the server in HTTP mode with
   `--verbose`: its stderr logs every call as `session "<id>" <tool>`. Capture the
   sequence of calls leading up to the first failure, plus what app was installed
   or launched beforehand.

Include all of the above when you [open an
issue](https://github.com/zafnz/ios-simulator-mcp/issues).

## 4. Still Stuck?
- Check the [README](./README.md) for setup and usage instructions.
- If the problem persists, [open an issue](https://github.com/joshuayoes/ios-simulator-mcp/issues) and include the error message and steps to reproduce.

