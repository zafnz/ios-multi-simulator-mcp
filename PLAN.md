# Implementation plan: self-contained idb

Branch: `feat/self-contained-idb`. Background and evidence: `../DESIGN.md`.

## Goal

`ios-multi-simulator-mcp` ships with its own `idb_companion`, built by our CI,
downloaded on first use. No `pipx install fb-idb`. No `brew install
idb-companion`. **The user's own idb installation is never read, written, or
touched.**

### Non-goals

- Replacing `simctl` for simulator lifecycle (create/boot/shutdown/delete/list).
  Those stay. See "Why lifecycle stays on simctl".
- Supporting Intel Macs in v1 (see Risks).
- Contributing anything upstream.

---

## Architecture

```
 MCP process (node)
   ├─ lifecycle tools ──────────────► xcrun simctl        (create/boot/delete/list)
   └─ everything else ──► IdbClient ──► gRPC over UDS ──► our idb_companion
                             │                              (one per session udid)
                             └─ CompanionManager
                                  ├─ resolve binary  ~/Library/Caches/ios-multi-simulator-mcp/companion/<sha>/
                                  ├─ spawn           /tmp/imsm-<uid>/<udid>.<pid>.sock
                                  ├─ respawn         on child exit / UNAVAILABLE
                                  └─ reap            --idle-shutdown-time + explicit kill
```

Two hard boundaries, both load-bearing:

1. **Our companion binary is ours.** Cached under our own directory, never
   `/usr/local/bin/idb_companion`, never on `$PATH`.
2. **Our companion registry is ours.** We never read or write `/tmp/idb/*`,
   which is the shared v1 state used by both `brew`'s companion and the Python
   `idb` client (`CompanionPaths.swift` documents it as shared on purpose). We
   never enumerate or signal a process we did not spawn.

---

## Gotchas — read this before writing code

Every one of these was hit or found during the investigation. They are cheap to
respect up front and expensive to rediscover.

**Build**

- **Pin the toolchain, and assert it.** A toolchain mismatch produces a
  `swift-frontend` crash with **no `error:` line anywhere in the log** — just a
  stack dump. Three plausible workarounds (`-Onone`, clean rebuild, symbol
  rename) all failed against Swift 6.2.4; the actual fix was Xcode 26.6. If a
  build ever dies with no diagnostic, suspect the toolchain before the source.
- `./build.sh` needs `protoc-gen-swift` → `brew install swift-protobuf`. Also
  `protoc` and `xcodegen`.
- **Build with `XCODEGEN_STRIP_XATTRS=false`.** By default `build.sh` generates
  each Xcode project into a temp dir and `sed`-rewrites absolute paths back to
  relative ones. That rewriting mangles paths once the checkout is a couple of
  directories deep: building at `…/ios-simulator-mcp/vendor/idb` failed with
  *"Build input file cannot be found:
  `/projects/…/REPL/Executor/ReplSocketServer.m`"* — the same path with the two
  leading components eaten — while the identical sha built fine at the shallower
  `…/idb-mcp/idb`. The env var takes the direct-generation branch and skips the
  rewriting. This bites CI too; a runner checkout is deeper still.
- `vendor/idb/Build/` reaches **~1.9 GB**. Gitignore it; clean it in CI.

**Isolation**

- **`/tmp/idb/` is shared state**, deliberately, between brew's companion and
  the Python `idb` client. Never read it, never write it, never enumerate its
  PIDs. Ours goes in `/tmp/imsm-<uid>/`.
- `/tmp` is world-writable — create our dir `0700` and **verify ownership**
  before adopting it, or a pre-created directory/symlink there gets trusted.
- **`sockaddr_un.sun_path` is 104 bytes.** A socket under
  `~/Library/Caches/…/<36-char-udid>.sock` is ~86 chars for a short username and
  overflows for a long one. This is why sockets live in `/tmp/imsm-<uid>/`, not
  the cache dir.

**gRPC / protocol**

- **There is no text RPC — `ui_type` means porting the keymap.** Text→keycode
  translation lives in the Python *client*, not the companion:
  `idb/common/hid.py` `KEY_MAP` (~110 entries) plus the shift-modifier
  down/up sequencing in `key_press_shifted_to_events`. The `hid` stream only
  accepts raw `HIDKey`/`HIDPress` events. Port the map to TypeScript. It is
  **ASCII-only** and `text_to_events` throws on anything else — surface an
  unknown character as a clean tool error, never a half-sent stream, and cover
  symbols, newline, and a non-ASCII rejection in the parity harness.

- **An old companion silently ignores unknown request fields.** Protobuf
  compatibility means `format: COMPLETE`, `backend`, `keys` and `depth` produce
  *no error* on the 2022 binary — just old behaviour. This is why the download
  path must **never** silently fall back to a `$PATH` companion: you'd get
  wrong-but-plausible results instead of a failure.
- **`marker` with `depth: 0` fails**, and 0 is the default. `marker:"Maps"`
  returned *"found no element whose AXLabel contains Maps"* with Maps plainly on
  screen; `depth: 1` found it in 25 ms. **Always pass an explicit depth.**
- **`depth` does nothing on whole-screen reads** — it is consumed only by marker
  queries. Use `keys` to control payload size on a full describe.
- **`ScreenshotRequest` is empty** — no format field, returns PNG. `ui_view`
  still needs `sips` for JPEG.
- **`record` spans two tool calls.** `Start{file_path}` … `Stop`, with the bidi
  stream held open in between, then a `Payload{file_path|data}` comes back.
  Replaces the `activeRecordings` ChildProcess map with a stream map — same
  lifetime problem, different handle. Reading `IdleMonitor.swift` /
  `CompanionServiceProvider.swift`, an open stream should hold the idle timer
  (tracking wraps the handler body), so `--idle-shutdown-time` shouldn't kill
  a long recording — but that's inferred from source, not tested. Gate 8.2
  covers it.
- **Readiness: parse stdout, don't poll the socket.** The companion prints
  `{"grpc_path":"/tmp/…"}` once bound (`IDBPortsConfiguration.swift`; the
  bare-path variant in `CompanionSpawner` is only for the separate idb2 binary
  — our invocation always gets the JSON). Waiting for that line removes the
  bind race. Don't assume it's literally the first line — parse lines until one
  matches.
- **Keep draining stdout/stderr after readiness.** The companion logs
  verbosely to stderr for its whole lifetime; an unread pipe blocks it at
  64 KB and presents as a mysterious hang hours in. Drain both pipes or
  redirect to a per-udid log file.

**Accessibility**

- **The empty-accessibility-tree bug is companion state, not simulator state.**
  Proven during step 3: a companion that had been up for days served a
  degenerate `0x0` tree with no children for a booted simulator, while a
  companion spawned against *the same simulator at the same moment* returned the
  full 13-element tree. Even `describe-point` returned `0x0` on the wedged one.
  Restarting the companion clears it — the README, TROUBLESHOOTING and the
  in-code diagnostic all previously said the only cure was destroying and
  recreating the simulator (losing its installed apps), which is now the last
  resort rather than the first. Since we own the companion, `describeAll`
  restarts it and retries automatically. This also means **AXBRIDGE is not
  needed to fix this bug** (§Part 6.4 wondered) — it is a different question.

**Runtime**

- Two MCP processes can race a cold cache. Download to a temp dir and
  **atomically rename** into place, so a half-extracted tree is never visible.
- The Python CLI leaks companions — there were **9 stale entries** in
  `/tmp/idb/state` on the dev machine. Spawn with `--idle-shutdown-time` *and*
  kill explicitly on `destroy_simulator`.
- **`--idle-shutdown-time` does not exist on brew's 1.1.8**, but passing it is
  harmless: 1.1.8 parses argv leniently and ignores unknown flags outright
  (verified — it echoes them in its `Invoked with args=[…]` line and starts
  normally). So pass it unconditionally rather than trying to detect support.
  Against brew you simply get no idle backstop, which makes respawn-on-death
  the only thing covering a companion that goes away.
- **The readiness JSON is not the first stdout line.** 1.1.8 prints a build
  banner, its full argv *and its entire environment* before the `grpc_path`
  report. Parse lines until one matches — and note companion logs therefore
  contain the environment you spawned it with.
- **The companion will die mid-session by design.** `--idle-shutdown-time`
  means any quiet stretch kills it, so the next tool call after an idle period
  gets `UNAVAILABLE` on a dead channel — the *common* path for an agent, not an
  edge case. `CompanionManager` must watch the child's exit, invalidate the
  channel, and respawn transparently on next use. This also covers sim crashes
  and macOS's 3-day `/tmp` cleaner reaping the socket under a long-lived
  daemon.
- **HTTP mode makes state placement load-bearing.** `createServer()` runs
  **once per request** in HTTP mode (`src/index.ts:1585`), so `CompanionManager`,
  the gRPC channels, and the record-stream map must be process-level
  singletons — never per-`McpServer`. And a long-lived daemon serving multiple
  clients makes concurrent tool calls on the *same udid* normal: two
  interleaved `hid` streams can scramble a swipe, and two clients can race
  `record` Start/Stop. A per-udid mutex around input events and recording
  state closes it.

---

## Part 1 — Vendoring idb

```bash
git submodule add https://github.com/facebook/idb vendor/idb
cd vendor/idb && git checkout <sha> && cd ..
```

Plain submodule on upstream. **No fork** — the build needs zero patches on the
right toolchain (`../DESIGN.md` §6).

Two files pin the build:

- `.xcode-version` → `26.6`
- `companion.lock.json` → the built artifact (see Part 3)

**The toolchain pin is the critical one.** Derive it from
`vendor/idb/REPL/IDB/IDBAPI.swiftinterface`:

```
// swift-compiler-version: Apple Swift version 6.3.3 (swiftlang-6.3.3.1.3 clang-2100.1.1.101)
```

Re-check that line on every submodule bump. A mismatch produces a compiler crash
with **no `error:` line anywhere in the log** — budget a day if you skip this.

---

## Part 2 — CI builds and publishes the companion

`.github/workflows/build-companion.yml`, `workflow_dispatch` + on changes to
`vendor/idb` or the workflow itself.

```yaml
runs-on: macos-26            # VERIFY: needs Xcode 26.6 — see Risks
steps:
  - uses: actions/checkout@v4
    with: { submodules: true }
  - run: sudo xcode-select -s /Applications/Xcode_26.6.app
  - run: |
      test "$(xcodebuild -version | head -1)" = "Xcode 26.6"
      swiftc --version | grep -q 'swiftlang-6.3.3' || exit 1
  - run: brew install xcodegen protobuf swift-protobuf
  - run: cd vendor/idb && ./build.sh build
  - run: |
      cd vendor/idb/Build/Distribution
      tar czf "$RUNNER_TEMP/companion-${SHA}-arm64.tar.gz" .
      shasum -a 256 "$RUNNER_TEMP/companion-${SHA}-arm64.tar.gz"
  - uses: softprops/action-gh-release@v2
```

Notes from having run this locally:

- Cold build is **~20–30 min**. macOS runners bill at **10× minutes** — this is
  the main cost. Only rebuild when the submodule sha moves; never on every push.
- `./build.sh build` (no target) is the right invocation: 13 targets, and it
  assembles `Build/Distribution/` with the exact runtime layout the companion
  expects — `idb_companion`, `idb-repl`, `Resources/{SimulatorFrameworkBridge,
  libShimulator-*.dylib, libRepl-*.dylib}`, plus SwiftPM resource bundles.
  **73 MB uncompressed.**
- `./build.sh generate-proto` runs implicitly; it clones grpc-swift 1.23.1 and
  builds `protoc-gen-grpc-swift` (~75 s). Cache `vendor/idb/Build/grpc-swift`.
- Verify the artifact in CI before releasing: extract to a clean path, run
  `idb_companion --version`, assert it prints today's `build_date`.
- **Tie the generated client to the published companion.** The TS client is
  generated from the submodule sha; the downloaded companion comes from the
  lock file's sha. Nothing ties them together, and — see Gotchas — a mismatched
  companion doesn't error, it silently ignores fields: the exact bug class this
  project escapes, reintroduced between our own artifacts. CI must assert
  `git -C vendor/idb rev-parse HEAD` == `companion.lock.json .idbSha`, and
  `npm run gen:proto` runs in the same workflow so the checked-in client can't
  drift from the sha being built.

### Release output

Per build, publish:

| asset | notes |
|---|---|
| `companion-<idbShortSha>-arm64.tar.gz` | the 73 MB tree, gzipped — **18 MB** in practice (measured) |
| `companion-<idbShortSha>-arm64.tar.gz.sha256` | verified at download |

Then commit `companion.lock.json` into the branch:

```json
{
  "idbSha":  "7c90442…",
  "xcode":   "26.6",
  "swift":   "swiftlang-6.3.3.1.3",
  "arch":    "arm64",
  "url":     "https://github.com/zafnz/ios-multi-simulator-mcp/releases/download/companion-7c90442/companion-7c90442-arm64.tar.gz",
  "sha256":  "…",
  "bytes":   30000000,
  "builtAt": "2026-08-09T…Z"
}
```

The lock file ships **inside the npm package**. The MCP never queries the GitHub
API at runtime — it reads a pinned URL and a pinned hash. No network discovery,
no rate limits, no surprise version drift.

---

## Part 3 — Runtime acquisition

`src/idb/companionBinary.ts`

```
resolve():
  1. if IOS_SIMULATOR_MCP_COMPANION_PATH set → use it verbatim, skip everything
  2. dir = <cacheRoot>/companion/<lock.sha256>/
  3. if dir/idb_companion exists and is executable → return it
  4. download lock.url → <cacheRoot>/tmp/<random>.tar.gz
  5. verify sha256 against lock.sha256; mismatch → delete, throw
  6. extract to <cacheRoot>/tmp/<random>/, chmod +x
  7. smoke test: `idb_companion --version` exits 0
  8. atomic rename into dir  (concurrent-safe: two MCP processes may race)
```

- `cacheRoot` = `$XDG_CACHE_HOME/ios-multi-simulator-mcp` or
  `~/Library/Caches/ios-multi-simulator-mcp`.
- **Keyed by content hash, not version** — a changed lock file is a new
  directory, so rollback and multi-version coexistence are free.
- Step 8 is a rename, so a partially-downloaded tree is never visible under
  `dir`. Two racing processes both succeed; last rename wins; both get a valid
  tree.
- First-run UX: 30 MB download. Emit an MCP log notification; do it lazily on
  first *companion-requiring* tool call, not at server start, so `--help`-ish
  usage and lifecycle-only flows never pay for it.
- Failure → actionable error naming the override env var. Never silently fall
  back to a `$PATH` companion; that would reintroduce the 2022 binary and its
  silently-ignored request fields, which is exactly the bug class we are
  escaping.

### Staying out of the user's way

| concern | rule |
|---|---|
| binary | ours lives in our cache; we never write to `/usr/local/bin` or `$PATH` |
| registry | we never read/write `/tmp/idb/state` |
| sockets | ours live in `/tmp/imsm-<uid>/`, never `/tmp/idb/` |
| processes | we only ever signal PIDs we spawned and recorded |
| brew/pipx | untouched; a user's `idb` CLI keeps working alongside |

**Socket path length matters.** `sockaddr_un.sun_path` is 104 bytes on macOS.
`~/Library/Caches/ios-multi-simulator-mcp/run/<36-char-udid>.sock` is ~86 for
this user and overflows for a longer username. Use:

```
/tmp/imsm-<uid>/<udid>.<pid>.sock    # ~61 chars, safe
```

Create `/tmp/imsm-<uid>` with mode `0700` and verify ownership before use —
`/tmp` is world-writable, so an attacker-created directory or symlink there
must not be adopted.

The `<pid>` suffix (our own pid) exists because the path would otherwise be
instance-agnostic: two of our processes serving the same udid — normal during
the stdio→HTTP transition, or a user running two daemons — would collide on
one socket. Unlinking a stale socket file left by a dead pid of ours is fine
(it isn't signalling a process); do it on startup.

---

## Part 4 — The gRPC client

`src/idb/client.ts`, `src/idb/companionManager.ts`

- Codegen with **`ts-proto`** from `vendor/idb/proto/idb.proto`, output checked
  in under `src/idb/generated/`, regenerated by `npm run gen:proto`. Typed
  request shapes matter here — the enums (`Format`, `Backend`, `SearchableKey`)
  are exactly where silent mistakes hide.
  - `@grpc/proto-loader` at runtime also works and needs no build step; it is
    how the whole thing was prototyped. Fine as a fallback if ts-proto fights
    the toolchain.
- One long-lived channel per udid; `CompanionManager` owns spawn → ready →
  reuse → **respawn** → kill. Respawn is not optional: `--idle-shutdown-time`
  guarantees the companion dies during quiet stretches, so on child exit or
  `UNAVAILABLE` the manager invalidates the channel and respawns on next use
  (see Gotchas).
- `CompanionManager` and the record-stream map are **process-level
  singletons**. HTTP mode creates a `McpServer` per request
  (`src/index.ts:1585`) — any state hung off the server instance silently loses
  the persistent channel. Serialize `hid` and recording per udid with a mutex;
  concurrent clients on one udid are normal in daemon mode.
- Readiness: the companion prints `{"grpc_path":"/tmp/…"}` on stdout once bound.
  Parse that line rather than polling the socket — it removes the bind race.
  (`CompanionSpawner.swift` upstream does exactly this.)
- Spawn with `--idle-shutdown-time` as a backstop, and kill explicitly on
  `destroy_simulator`. The Python CLI's leak left **9 stale entries** in
  `/tmp/idb/state` on this machine; don't reproduce it.

---

## Part 5 — Tool migration

**Everything except lifecycle moves to gRPC.**

| tool | today | after |
|---|---|---|
| `start_simulator` | simctl create/boot | **simctl** (+ spawn our companion) |
| `destroy_simulator` | simctl shutdown/delete | **simctl** (+ kill our companion) |
| `attach_simulator` | simctl list | **simctl** |
| `ui_describe_all` | `idb ui describe-all` | `accessibility_info` COMPLETE + `keys` |
| `ui_describe_point` | `idb ui describe-point` | `accessibility_info` point |
| `ui_tap` | `idb ui tap` | `hid` |
| `ui_type` | `idb ui text` | `hid` — **port the Python keymap**, see Gotchas |
| `ui_swipe` | `idb ui swipe` | `hid` |
| `detect_rotation` | `idb ui describe-all` | `describe` + `accessibility_info` |
| `screenshot` | simctl io screenshot | `screenshot` |
| `ui_view` | simctl + sips | `screenshot` + sips (see below) |
| `record_video` | spawn simctl, SIGINT | `record` bidi stream |
| `stop_recording` | SIGINT the child | `record` → send `Stop` |
| `install_app` | simctl install | `install` (stream) |
| `launch_app` | simctl launch | `launch` (stream) |

### Why lifecycle stays on simctl

`idb_companion` *can* do it (`--boot/--create/--delete/--list 1`, and `--list 1`
emits flat JSON that is nicer than `simctl list -j`'s runtime-keyed nesting).
But those are short-lived subprocess invocations either way, so there is no
latency win — only dependency reduction. Keeping simctl means **a bad companion
build cannot break simulator creation**, only UI automation. That blast-radius
split is worth more than the last dependency.

Revisit once the companion has a few months of daily use.

### Migration notes

See **Gotchas** above for the traps (`ScreenshotRequest` is PNG-only so `sips`
stays; `record` spans two tool calls). Measurements to set expectations:

- `screenshot` RPC: **207 ms / 2 831 KB** vs `simctl io screenshot` **245 ms** —
  marginally faster, and you get bytes in memory instead of via a temp file,
  which also simplifies `ui_view`.
- `list_apps`: 342 ms, 24 apps with bundle id + process state.
- `hid` tap on a warm channel: **2.9 ms**, vs ~165 ms for `idb ui tap`.
  Re-measured on the step-1 client over 10 consecutive taps: **1.2 ms/tap**.

Not applicable now, but worth knowing if lifecycle ever moves to the companion:
**`--verify-booted`** (default true) makes `--boot` block until known-booted,
which would delete the hand-rolled describe-point boot probe at
`src/index.ts:466`.

---

## Part 6 — New capabilities (the actual payoff)

Do these *after* parity, in this order.

1. **`ui_find` / `ui_tap` by label — the headline.** `marker` + `match_key` +
   `depth` resolves a control server-side in **~670 bytes**, versus 5 881 for a
   full cheap tree or 84 381 for a rich one. Replaces "dump tree → model picks
   coordinates → tap" with one call.
   - ⚠️ **`depth` defaults to 0 and marker-at-depth-0 fails.** `marker:"Maps"`
     returned *"found no element whose AXLabel contains Maps"* with Maps plainly
     on screen; `depth:1` found it in 25 ms. Always pass an explicit depth.
2. **`keys` on `ui_describe_all`** — 5 881 B → 1 848 B on the default backend.
   Consider a `fields` parameter, defaulting to a lean set.
3. **`COMPLETE` format** — returns `screen{width,height}`, `truncated`, `modal`,
   `backend` alongside elements. Kills the separate screen-dims call *and* the
   0×0-frame heuristic at `src/index.ts:454`. Element keys become `label` /
   `frame` / `identifier` / `traits` instead of `AXLabel` / `AXFrame`. **This is
   a breaking change to tool output** — version the response shape.
4. **`AXBRIDGE` backend as opt-in "look harder"** — 280 nodes vs 14, 43 labelled
   vs 14, at ~400 ms and 84 KB. Not a default. Good fallback when a marker
   lookup misses. Requires `Resources/SimulatorFrameworkBridge`, which our
   distribution ships. Note this is *not* the fix for the empty-tree bug — that
   turned out to be companion state and is already handled (see Gotchas).

Free once the channel exists, if wanted later: `approve`/`revoke` (grant camera
/photos/location without tapping a permission dialog — removes a whole class of
agent flakiness), `setting`/`get_setting` (dark mode, locale), `open_url`,
`set_location`, `send_notification`, `simulate_memory_warning`, `log` streaming.

---

## Part 7 — Configuration

| env var | meaning |
|---|---|
| `IOS_SIMULATOR_MCP_COMPANION_PATH` | use this companion; skip download entirely |
| `IOS_SIMULATOR_MCP_COMPANION_CACHE` | override cache root |
| `IOS_SIMULATOR_MCP_FILTERED_TOOLS` | unchanged |
| `IOS_SIMULATOR_MCP_DEFAULT_OUTPUT_DIR` | unchanged |
| ~~`IOS_SIMULATOR_MCP_IDB_PATH`~~ | **remove** — there is no `idb` CLI any more |

Removing `IOS_SIMULATOR_MCP_IDB_PATH` is user-visible; note it in the README's
breaking-changes list, and error clearly if it is set.

---

## Part 8 — Verification gates

Ordered by how much they'd hurt if skipped.

1. **The artifact runs on a machine that didn't build it** (R2). Assumed true,
   **not yet verified — do this on the work laptop before step 5.** Concretely:
   download the release tarball on a Mac that has never built idb, extract,
   `xattr -l idb_companion` (expect no `com.apple.quarantine`), then
   `./idb_companion --version` and a real `accessibility_info` call against a
   booted sim. If Gatekeeper blocks it, stop and re-read R2's fallbacks before
   writing the download path.
2. **Parity harness.** For each migrated tool, run old path and new path against
   the same simulator state and diff. Especially `ui_describe_all`, whose shape
   changes. Must include: `ui_type` with symbols and newline, plus a non-ASCII
   input asserting a clean error; a recording longer than
   `--idle-shutdown-time` with no other RPCs (assert the companion survives and
   the file is playable).
3. **Respawn.** Let the companion idle out, then issue a tool call — it must
   succeed via transparent respawn, not surface `UNAVAILABLE`.
4. **Isolation test.** With `brew`'s companion and `pipx`'s `idb` installed and
   a user companion running: exercise every tool, then assert `/tmp/idb/state`
   is byte-identical and the user's companion PIDs are alive.
5. **Concurrency.** Two MCP processes racing a cold cache; N sessions in
   parallel (this is the multi-simulator feature — it's the differentiator);
   two clients driving the *same udid* through one daemon (hid and record
   serialization).
6. **Leak check.** After a full session lifecycle, no orphaned companions in
   `/tmp/imsm-<uid>/` and no stray PIDs.

---

## Part 9 — Risks

The three open questions are answered below. **Answers 2 and 3 are assumptions,
not verified facts** — they are recorded here so that if something breaks later,
this is the first list to re-read.

### R1 — arm64 only ✅ DECIDED

`build.sh` hard-codes `ARCHS=arm64`; the built binary is thin arm64. Intel Macs
get nothing.

> **Decision: arm64 only. Ship it.** Intel is barely supported anyway. If
> someone wants it, they can open a PR adding an x86_64 CI matrix leg and a fat
> tarball.
>
> Implementation: gate on the **hardware**, not the Node build —
> `process.arch` is `"x64"` for x64 Node under Rosetta on an M-series Mac,
> which runs the arm64 companion fine; checking it would refuse working
> machines. Use `sysctl -n hw.optional.arm64` (→ `1` on Apple Silicon, even
> under Rosetta; errors/`0` on Intel) at companion-resolve time and fail with
> a clear message pointing at the limitation — not a confusing download or
> exec error. Note arm64-only in the README.

### R2 — will a downloaded companion run on a machine that didn't build it? ⚠️ ASSUMED

The binary is `adhoc, linker-signed`, Mach-O thin arm64. Programmatic download
(node/curl, not a browser) shouldn't set `com.apple.quarantine`, so Gatekeeper
shouldn't engage.

> **Decision: assume it works; verify tomorrow on the work laptop.**
>
> This is an assumption, not a result. If it's wrong, the distribution model
> changes materially — the fallbacks are ad-hoc re-signing on extract
> (`codesign -f -s - --deep`), stripping quarantine
> (`xattr -dr com.apple.quarantine`), or in the worst case a real Developer ID
> signature + notarization, which would need an Apple developer account.
>
> Build steps 1–4 do not depend on this. **Verify before step 5** (the download
> path) so a bad assumption costs nothing already written.

### R3 — do GitHub runners have Xcode 26.6? ⚠️ ASSUMED

Could not verify available runner images from here.

> **Decision: assume yes, on `macos-26`.**
>
> Keep the assertion step in the workflow regardless — it turns a wrong
> assumption into a one-line CI failure instead of a 25-minute build that
> crashes with no `error:` line:
>
> ```yaml
> - run: ls /Applications | grep Xcode        # prints what's actually there
> - run: swiftc --version | grep -q 'swiftlang-6.3.3' || exit 1
> ```
>
> If absent: self-hosted runner, or pin to the newest available Xcode and
> re-derive the expected toolchain from `IDBAPI.swiftinterface`.

### Remaining risks

| risk | severity | mitigation |
|---|---|---|
| **No upstream CI builds the companion.** Meta builds internally with Buck; public HEAD × public Xcode is untested by anyone but us. | ongoing | Pin submodule sha. Bump deliberately, never automatically. CI build is the canary. |
| macOS runner minutes at 10× | cost | Build only on submodule change; cache grpc-swift. |
| 30 MB first-run download | UX | Lazy, with progress logging and a clear override. |
| `COMPLETE` changes tool output shape | breaking | Do it as a deliberate versioned change, after parity. |

---

## Part 10 — Commit sequence

Each step should leave the branch working.

1. `ts-proto` codegen + `IdbClient` with `describe`/`accessibility_info`/`hid`.
   Prove against a **brew** companion. No download machinery yet.
2. `CompanionManager`: spawn/reuse/kill in our own socket dir. Still brew binary.
3. Migrate the 5 `idb` call sites. Delete the `idb()` shell-out and the Python
   dependency from README/CLAUDE.md. **Shippable here** — this alone removes
   Python and takes tap latency from ~165 ms to ~2.9 ms.
4. Submodule + `.xcode-version` + CI workflow. Publish a first release asset.
5. `companionBinary.ts` download/verify/cache + `companion.lock.json`. Now
   self-contained. Run gate 8.1 before going further.
6. Migrate screenshot / ui_view / install / launch to gRPC.
7. Migrate record_video / stop_recording to the `record` stream.
8. Part 6 capabilities, in order — `marker` first, it's the biggest win.

Steps 1–3 are independently valuable and carry no distribution risk. Step 5 is
where the project becomes self-contained. Step 8.1 is where it becomes better
than what exists today.
