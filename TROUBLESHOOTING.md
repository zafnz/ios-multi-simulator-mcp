# iOS Simulator MCP - TROUBLESHOOTING

If you encounter errors or issues using this MCP server, try the following troubleshooting steps before reporting a bug:

## 1. Prerequisites
- **macOS on Apple Silicon Only:** This server only works on macOS with Xcode and iOS simulators installed, and the companion binary is arm64 only.
- **Node.js:** Make sure Node.js is installed and up to date.

## 2. Where idb_companion comes from

You do not install it. The server picks the first of these that it finds:

1. `IOS_SIMULATOR_MCP_COMPANION_PATH`, if set — used verbatim.
2. A local build at `vendor/idb/Build/Distribution/idb_companion` (developer path).
3. The companion pinned in `companion.lock.json`, downloaded, sha256-verified and
   cached under `~/Library/Caches/ios-multi-simulator-mcp/companion/<sha256>/`
   (`IOS_SIMULATOR_MCP_COMPANION_CACHE` overrides the cache root).

There is **no fallback to an `idb_companion` on your PATH**, so
`brew install idb-companion` neither helps nor hurts — it is ignored. This is
deliberate: an older companion silently ignores request fields it does not
understand instead of rejecting them, so falling back would give you
wrong-but-plausible results rather than a clean failure.

**No Python is required either.** This server speaks gRPC to `idb_companion`
directly, so `pipx install fb-idb` and the `idb` command line tool are not used.
If you installed `fb-idb` for an older version of this server,
`pipx uninstall fb-idb` is safe.

## 3. Common Issues & Fixes

### "No booted simulator found"
- Open Xcode and boot an iOS simulator manually.
- Run `xcrun simctl list devices` to verify a simulator is booted.

### "Could not start idb_companion" / companion not found
- Remember the server will not use a companion on your PATH, so installing one
  with Homebrew will not fix this. See
  [Where idb_companion comes from](#2-where-idb_companion-comes-from).
- If `IOS_SIMULATOR_MCP_COMPANION_PATH` is set, check it points at a real,
  executable binary — it is used verbatim, with no fallback.
- Otherwise the download is the likely culprit; see the next entry.
- Note the `idb` Python CLI is **not** used any more; you do not need it.

### No companion available and no lock file

**Symptom:** the server refuses to start, saying it cannot resolve a companion,
and there is no `companion.lock.json`.

Without the lock file there is nothing to download — the pinned URL and its
sha256 live in that file. This normally means an incomplete checkout rather than
anything wrong on your machine. Either:

- Get the file back if your checkout lost it: `git status`, restore it, or
  re-pull. Note that on a development branch where no companion release has been
  published yet, there may be no lock file at all — in that case building the
  submodule or setting `IOS_SIMULATOR_MCP_COMPANION_PATH` is the expected route,
  not a broken checkout.
- Or supply a companion yourself: build the vendored submodule (see
  [CONTRIBUTING.md](CONTRIBUTING.md)) so
  `vendor/idb/Build/Distribution/idb_companion` exists, or point
  `IOS_SIMULATOR_MCP_COMPANION_PATH` at a binary you trust.

If the lock file *is* present and the download still fails, check network access
to the pinned URL. A sha256 mismatch is a hard failure by design — the server
will not run a binary that does not match the pin.

### The companion build fails with no error message

**Symptom:** `./build.sh build` in `vendor/idb` dies part-way through with a bare
compiler stack dump and nothing that reads like a diagnostic.

That is almost always a **Swift toolchain mismatch**, not a broken checkout. The
build requires **Xcode 26.6 exactly**, pinned in `.xcode-version`. A different
toolchain does not produce a polite error — it crashes the compiler.

```sh
cat .xcode-version        # what is required
xcodebuild -version       # what you have
sudo xcode-select -s /Applications/Xcode.app   # if you have several installed
```

Also confirm the build prerequisites are present:
`brew install xcodegen protobuf swift-protobuf`. Expect the build to take 20–30
minutes. You do not need to build at all unless you are working on the companion
— the pinned download is the normal path.

### Intel Mac / "bad CPU type" / architecture errors

The companion is **arm64 only**, so Apple Silicon is required. There is no x86_64
build, and Rosetta will not help — the binary is not built for Intel. If you see
`bad CPU type in executable` or a similar architecture error, check with:

```sh
uname -m          # expect arm64
```

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

**Check which companion you are running.** The last packaged release is **v1.1.8
(Aug 2022)** — what Homebrew gives you — but idb's source is actively developed
and its accessibility subsystem has been reworked substantially since. That is
why this server uses its own pinned companion built from source rather than
whatever is on your PATH. If you have overridden it with
`IOS_SIMULATOR_MCP_COMPANION_PATH`, check that binary's `--version` before
anything else.

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
issue](https://github.com/zafnz/ios-multi-simulator-mcp/issues).

## 4. Still Stuck?
- Check the [README](./README.md) for setup and usage instructions.
- If the problem persists, [open an issue](https://github.com/zafnz/ios-multi-simulator-mcp/issues) and include the error message and steps to reproduce.

