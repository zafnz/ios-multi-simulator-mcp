# SimGadget: a library, a server, and a rename

> **Status: proposal. None of this is implemented.** No code in this repository
> does any of it. The line counts and dependency sizes below are measured; the
> sequencing and the API judgements are opinion. Treat the whole document as a
> proposal to argue with.

Sketched 2026-08-15, from a survey of what the MCP layer actually contributes.
Reviewed the same day: facts checked against the repo and the registry, the
open questions answered inline, and the phase-1 sequencing corrected.

## What we would be trying to do

Publish the simulator-driving code as a library in its own right — `simgadget` —
and leave the MCP server as one consumer of it, `simgadget-mcp`. Both stay in
this repository. Nobody maintains two repos.

The motivation is that the MCP protocol layer earns nothing for a caller who
already has a shell and a Node runtime. During development we routinely drive
simulators from throwaway `.cjs` scripts that `require()` the compiled
`build/idb/` directly and never speak MCP at all. Those scripts are three lines
because this repository has already solved companion resolution, process
lifecycle, orientation and tree pruning. That work is useful to people who will
never run an MCP server, and right now there is no way for them to have it.

There are several JS libraries for driving the simulator. None of them ships a
current companion (see below), and that is the whole argument.

## The names, decided

| Package | Contains | Runtime deps |
|---|---|---|
| `simgadget` | the library — companion lifecycle, gRPC, accessibility, coordinates | `@grpc/grpc-js`, `@bufbuild/protobuf` |
| `simgadget-mcp` | the MCP server — tools, Zod, sessions, transports | the above, plus `@modelcontextprotocol/sdk`, `zod` |

Base name is the library, `-mcp` is the integration. Nobody types an MCP config
by hand, so `npx simgadget-mcp` costs its users nothing, and the plain name is
worth more attached to the thing people `npm install`.

Both names were free on npm as of 2026-08-15, and `npm search simgadget` finds
nothing at all. **Reserve both with placeholder publishes before this plan is
visible anywhere public** — npm's name-dispute process is slow and the names are
squattable the moment they appear in a repo.

### Why not one package with two entry points

Measured, from `node_modules`:

```
9.1M  @modelcontextprotocol/sdk   → express, cors, ajv, express-rate-limit, eventsource
5.0M  zod
4.3M  @grpc/grpc-js
2.5M  @bufbuild/protobuf
```

A single package puts the first two in front of every library user. A library
for tapping a simulator that installs a web framework invites exactly one
question, and there is no good answer to it. This asymmetry is the only reason
the split is worth its ceremony — the code boundary is already clean.

## The real product is the companion

Facebook's last `idb` release was 2022. Anyone writing an iOS-simulator library
in JS today either shells out to a four-year-old `brew install idb-companion`,
or to `xcrun simctl`, which cannot read accessibility at all.

`companion.lock.json` currently pins a build from current idb source against
**Xcode 26.6, Swift 6.3.3, built 2026-08-12**, sha256-verified, downloaded on
demand. That is the differentiator. It is not a packaging detail, and it belongs
on the first screen of the README rather than in a troubleshooting appendix.

It is also the part of the rename most likely to break, in two ways.

### The download URL is baked to the old repo name

```
https://github.com/zafnz/ios-multi-simulator-mcp/releases/download/companion-da0f89a-xcode26.6/...
```

Releases and their assets move with a renamed repo, and GitHub redirects the
old URL, so this survives the rename itself. There is no re-cutting to do — and
no way to do it "before anything else moves": a release cannot be created under
`zafnz/simgadget` before that repo exists. The right order is the reverse of
the obvious one: **rename the repo first, then update the lockfile URL to the
new canonical path**, so nothing of ours depends on the redirect.

The redirect still matters, permanently. Every already-published version of
`ios-multi-simulator-mcp` (2.1.1 is live on npm) carries the old-path URL baked
into its lockfile, and those installs download through the redirect for as long
as anyone runs them. The redirect dies the moment anything is created at the
old path — including by us, including by accident. So "never recreate
`ios-multi-simulator-mcp` under this account" is not a transition-week rule; it
is a standing one, and it belongs in `CLAUDE.md` where a future session will
see it before helpfully reusing the name.

### It is arm64-only

`companion.lock.json` has `"arch": "arm64"` and there is no second slice.

For an MCP server whose users are all on Apple Silicon this is invisible. For a
published library it is a first-call failure on hardware we never tested, which
is the worst available outcome. The decision is to **fail loudly at resolve
time** — an explicit unsupported-architecture error naming the arch, not a
confusing gRPC timeout thirty seconds later.

**Answered (2026-08-15): Xcode 26 does run on Intel.** Apple ships it as a
Universal build (alongside a separate Apple-Silicon-only build since beta 5),
and macOS 26 Tahoe supports a handful of Intel Macs. It is Xcode 27 that drops
Intel entirely. So an Intel user on Xcode 26.6 can exist — but the audience is
four Mac models on the final Intel-supporting OS, with a published expiry date.

The decision stands: fail loudly, permanently, and spend nothing on x86_64.
That includes the two testing ideas previously sketched here — `macos-13`
GitHub Actions runners (real Intel, but cannot carry Xcode 26.6, so they test
*a* companion rather than *this* one) and Rosetta smoke tests (`arch -x86_64`
proves the slice loads, not that it drives a simulator on hardware we do not
have). Both are misleading reassurance about a build nobody would run.

## Layout

```
simgadget/                     ← repo
├── package.json               private, workspaces root, dev tooling
├── packages/
│   ├── simgadget/
│   │   ├── src/{ax,idb,ops}/
│   │   ├── test/              node --test on .mts, unchanged
│   │   └── companion.lock.json
│   └── simgadget-mcp/
│       └── src/
├── vendor/idb/                dev-only, stays at root
└── scripts/
```

Versions move in lockstep — both packages always carry the same number, one
script bumps and publishes both. npm symlinks the local library when the server
depends on `^<same version>`. This publishes some meaningless server bumps and
in exchange nobody ever reasons about version skew.

## What moves out of `src/index.ts`

The single-file rule in `CLAUDE.md` was written when there was one product. It
should be re-cut rather than defended, but one half of it is still load-bearing.

`index.ts` is ~3000 lines and growing (2757 when this table was measured; the
ranges below drift with every commit and are a sketch of the seams, not an
implementation map). Three natural pieces:

| Lines | What | Goes to |
|---|---|---|
| ~56–315 | `describeAll`, `describeScreen`, `findByLabel`, `describePoint`, `run` | **`simgadget`** |
| ~483–630 | `detectOrientation`, `getScreenDimensions`, `restartSimulatorBridge`, `diagnoseEmptyAccessibilityTree` | **`simgadget`** |
| ~319–480 | `SimSession`, `managedSimulators`, recordings, device/runtime lookup | `simgadget-mcp` — sessions are an MCP concept |
| ~1155–2500 | the 17 tool registrations | `simgadget-mcp`, **one file, intact** |
| ~2525–2757 | `createServer`, stdio and HTTP transports | `simgadget-mcp/transport.ts` |

The first two rows are the point. The high-level, edge-case-aware API — the one
that handles orientation, prunes the tree, recovers a wedged bridge and
diagnoses an empty one — already exists. It is trapped in `index.ts` because
there was only ever one file to put it in. Moving it is most of what makes the
library worth publishing, and almost none of it is new code.

One gap the table hides: the *input* side — tap, swipe, type — lives inline in
the tool registration bodies, not in named functions. A read-only library is
not the product; extracting those into library ops is the one piece of
genuinely new code the split requires.

The tool registrations stay together, side by side, for the reason the original
rule gave: they are repetitive and they read better in one place. That half of
the rule survives. What dies is "everything lives in one file".

(`CLAUDE.md` says 16 tool registrations. There are 17 — verified by count,
2026-08-15.)

## Before the first publish

Publishing converts a free-to-change surface into a semver commitment. Five
things should not be frozen as they stand:

- **`IdbClient.accessibilityInfo()` returns `Promise<unknown>`.** It is the
  library's headline call and `AXElement` already exists in `ax/tree.ts`.
- **Roughly 25 exports from `src/ax/` are internals** — `collectProbeCandidates`,
  `uniquelyLabelled`, `reconcileType`, `HIT_SLOP`, `DESCRIBE_KEYS`. They are
  `export`ed only because `index.ts` is a separate compilation unit, not because
  anyone should call them. Everything exported on the day of publication is
  owned forever. Do not rely on documentation to hide them: a `package.json`
  `"exports"` map makes internals *unresolvable*, which is the only kind of
  private that survives contact with users.
- **The first call downloads 19 MB.** For an MCP server that is a startup
  detail; for a library it is a surprising side effect — CI blocks on a GitHub
  download mid-test, offline environments fail at an unpredictable moment, and
  nothing reports progress. `COMPANION_PATH`/`COMPANION_CACHE` already give an
  escape hatch, but the library wants an explicit prefetch call (and probably a
  `npx simgadget prefetch` for CI images), and the behaviour documented on the
  same first screen of the README that advertises the companion.
- **`companionManager.ts` installs a `process.on("exit")` handler** on first
  spawn. It reaps *companions*, never simulators — a script's simulator keeps
  running, with all its state, after the script exits; only the helper process
  dies. That stays correct in the library, because socket paths embed the pid
  and generation (`${udid}.${pid}.${generation}.sock`): no later process can
  discover or reconnect to a surviving companion, so leaving one alive gains
  nothing and leaks a process per script run until `--idle-shutdown-time`
  (3600s) reaps it. Keep the hook, but rewrite its header in host-agnostic
  terms (it currently justifies itself by *this server's* signal handlers),
  document it, and expose `shutdown()` — `'exit'` never fires when the host
  dies to an unhandled signal, so the hook is a backstop, not a guarantee.
  The consequence for the short-script workflow: each run pays a companion
  spawn (~0.5s bind, longer on a cold simulator). If that ever matters, the
  answer is the HTTP server, which *is* the persistent-companion daemon;
  cross-process companion reuse via stable socket paths is a real design with
  real staleness hazards and is explicitly not in v1.
- **Simulator lifecycle: verbs in, policy out.** The library gets the explicit
  lifecycle calls — list, create, boot, shutdown, delete — because the
  short-script user needs to boot something, and the hard-won knowledge
  (newest-first devicetype ordering, latest-runtime lookup, and above all
  `waitUntilDriveable` with its 0x0-tree boot detection from BOOT_BUG.md) lives
  behind them. What stays out of the library is *implicit* lifecycle: nothing
  in `simgadget` ever destroys a simulator except an explicit call. Ownership
  tracking, sessions, and delete-what-we-created-on-exit are MCP-server policy
  and remain in `simgadget-mcp`. Multi-simulator "support" in the library is
  just functions keyed by udid — the session machinery that makes one server
  drive many simulators for many agents is likewise all server-side.

## Rename scope

- `package.json` name, bin entry, repo and homepage URLs
- GitHub repo rename — clones survive on the redirect
- README, CLAUDE.md, CONTRIBUTING, TESTING_*, TROUBLESHOOTING, CONTEXT, and this file
- The MCP server key users put in their client config — breaking, unavoidable, and
  loud rather than silent, which is the good kind
- `IOS_SIMULATOR_MCP_*` → `SIMGADGET_*`, all twelve:
  `ALLOWED_HOSTS`, `CLEANUP_ON_EXIT`, `COMPANION_CACHE`, `COMPANION_PATH`,
  `DEFAULT_OUTPUT_DIR`, `FILTERED_TOOLS`, `HTTP_HOST`, `HTTP_PORT`, `IDB_PATH`,
  `SIMCAMCTL_PATH`, `TRANSPORT`, `VERBOSE`.
  Read the new name, fall back to the old with one stderr deprecation line, drop
  the fallback two releases later. This is the change that breaks people
  silently; a hard cut is not worth the tidiness.
  Note `COMPANION_PATH` and `COMPANION_CACHE` become *library* configuration and
  must read identically from both packages.
- `scripts/imsmd.sh`, the pidfile, and `/tmp/imsm-daemon.log` — internal, but stale
- `/tmp/imsm-<uid>/` socket directory. `companionManager.ts` checks `sun_path`
  against macOS's 104-byte limit, and `simgadget-` is five characters longer than
  `imsm-`; `/tmp/simgadget-501/` plus a 36-character UDID still fits comfortably,
  but the check exists for a reason and should be re-run rather than assumed.
- **`~/Library/Caches/ios-multi-simulator-mcp/`** — not on the original list.
  Renaming it orphans an already-downloaded 19 MB companion. Harmless, since the
  next run re-downloads and re-verifies, but users on metered connections deserve
  a line in the changelog.
- **Search equity.** "ios simulator mcp" is literally what users type, and the
  current name *is* the query; "simgadget" says nothing about iOS. Survivable —
  npm keywords, a README title of the form "SimGadget — iOS simulator automation
  for JS/TS and MCP", and the deprecated wrapper package all preserve the trail —
  but it needs doing deliberately, not discovered from a download graph.
  The offsetting gain: upstream `ios-simulator-mcp` (joshuayoes) is still
  published, one word away from our name; a distinct name ends the
  "is this the same thing?" confusion permanently.

## Sequencing

Each phase ships on its own. As one commit this would be miserable to review and
impossible to revert.

0. **Reserve `simgadget` and `simgadget-mcp` on npm.** Minutes of work, and the
   only step that gets harder the longer the plan is public.
1. **Rename** repo, product, website, docs, env vars with fallback shim. No code
   movement. (This must come first: the lockfile fix depends on the renamed
   repo existing.)
2. **Update `companion.lock.json`** to the renamed repo's canonical URL — the
   release and its assets move with the repo, so there is nothing to re-cut —
   and add the never-recreate-the-old-name rule to `CLAUDE.md`.
3. **Workspaces split**, moving the high-level API into `simgadget`.
   `scripts/smoke-packed.sh` must pack *both* and verify the server resolves the
   library from the tarball rather than the workspace symlink — this is easy to
   get wrong in a way that only breaks for real users.
4. **API polish**, per "Before the first publish" above.
5. **Publish** `simgadget` and `simgadget-mcp`. Leave `ios-multi-simulator-mcp`
   as a deprecated wrapper depending on `simgadget-mcp`.
6. **Rewrite `CLAUDE.md`** — Architecture, the single-file rule, and every env
   var in the docs.

## Open questions — all answered, 2026-08-15

- *Does Xcode 26 run on Intel Macs?* **Yes** — Universal build; Xcode 27 is the
  one that drops Intel. Details in the arm64 section above. Fail-loudly stands.
- *Is a `macos-13` runner a useful x86_64 signal?* **No** — it cannot carry
  Xcode 26.6, so it is misleading reassurance. Also folded in above.
- *Facade class or bag of functions?* **Functions.** A facade can be added in a
  minor release; it can never be removed. The only real caller uses the
  functions directly, and that is the honest shape to publish.
- *`simgadget` on npm?* **Available**, as is `simgadget-mcp`. Reserve both now
  (phase 0).
