# SimGadget: a library, a server, and a rename

> **Status: proposal. None of this is implemented.** No code in this repository
> does any of it. The line counts and dependency sizes below are measured; the
> sequencing and the API judgements are opinion. Treat the whole document as a
> proposal to argue with.

Sketched 2026-08-15, from a survey of what the MCP layer actually contributes.

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

GitHub redirects release assets after a repo rename, so this survives the rename
itself. The redirect dies the moment anything is created at the old path —
including by us, including by accident. **Re-cut the release under the new name
and update the lockfile before anything else moves.**

### It is arm64-only

`companion.lock.json` has `"arch": "arm64"` and there is no second slice.

For an MCP server whose users are all on Apple Silicon this is invisible. For a
published library it is a first-call failure on hardware we never tested, which
is the worst available outcome. The decision is to **fail loudly at resolve
time** — an explicit unsupported-architecture error naming the arch, not a
confusing gRPC timeout thirty seconds later.

Two things bear on whether that stays permanent, neither of which needs an
Intel Mac on the desk:

- **`macos-13` GitHub Actions runners are real Intel hardware**, free, and are
  the only realistic way to test an x86_64 slice without owning one. The
  constraint is the Xcode they carry, which is nowhere near 26.6 — so this can
  test *a* companion on Intel, not *this* companion.
- **Rosetta on Apple Silicon can build and smoke-test an x86_64 slice**
  (`arch -x86_64`), confirming it loads, links and binds its socket. It does not
  confirm it can drive a simulator on Intel: here the runtime is arm64 and the
  cross-architecture path is not the one an Intel user would take. A pass proves
  very little. A failure proves something.

**Open question, and it may delete this whole section: does Xcode 26 run on
Intel Macs at all?** macOS 26 Tahoe was announced as the last Intel-supporting
release, and if the toolchain the lockfile pins cannot be installed on Intel,
then no Intel user can be in a position to want this and "fail loudly" is simply
correct. Worth ten minutes with Apple's release notes before spending anything
on x86_64.

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

`index.ts` is 2757 lines in three natural pieces:

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

The tool registrations stay together, side by side, for the reason the original
rule gave: they are repetitive and they read better in one place. That half of
the rule survives. What dies is "everything lives in one file".

(`CLAUDE.md` says 16 tool registrations. There are 17.)

## Before the first publish

Publishing converts a free-to-change surface into a semver commitment. Two
things should not be frozen as they stand:

- **`IdbClient.accessibilityInfo()` returns `Promise<unknown>`.** It is the
  library's headline call and `AXElement` already exists in `ax/tree.ts`.
- **Roughly 25 exports from `src/ax/` are internals** — `collectProbeCandidates`,
  `uniquelyLabelled`, `reconcileType`, `HIT_SLOP`, `DESCRIBE_KEYS`. They are
  `export`ed only because `index.ts` is a separate compilation unit, not because
  anyone should call them. Everything exported on the day of publication is
  owned forever.

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

## Sequencing

Each phase ships on its own. As one commit this would be miserable to review and
impossible to revert.

1. **Re-cut the companion release** under the new name, update the lockfile.
   Fragile, and unrelated to everything else.
2. **Rename** repo, product, website, docs, env vars with fallback shim. No code
   movement.
3. **Workspaces split**, moving the high-level API into `simgadget`.
   `scripts/smoke-packed.sh` must pack *both* and verify the server resolves the
   library from the tarball rather than the workspace symlink — this is easy to
   get wrong in a way that only breaks for real users.
4. **API polish**, per "Before the first publish" above.
5. **Publish** `simgadget` and `simgadget-mcp`. Leave `ios-multi-simulator-mcp`
   as a deprecated wrapper depending on `simgadget-mcp`.
6. **Rewrite `CLAUDE.md`** — Architecture, the single-file rule, and every env
   var in the docs.

## Open questions

- Does Xcode 26 run on Intel Macs? If not, x86_64 is moot.
- Is a `macos-13` runner with an older Xcode a useful x86_64 signal, or
  misleading reassurance about a companion nobody would run?
- Does the library want its own `SimGadget` facade class, or is a bag of
  functions plus `IdbClient` the honest shape? The MCP server is currently the
  only caller and it uses the functions directly.
- `simgadget` on npm: available?
