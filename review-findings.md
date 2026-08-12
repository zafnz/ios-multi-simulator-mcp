# Review findings: `feat/self-contained-idb`

Bug-and-correctness review of the branch against base `ad83745`, per the review
brief. Whole files were read, not just the diff; assumptions were verified
against the generated gRPC client, the vendored `hid.py`, and the pinned MCP
SDK. Ranked most severe first. No fixes applied.

## Findings

### 1. A toolchain-only rebuild republishes over the same release tag, breaking every committed lock file

`.github/workflows/build-companion.yml:216` (tag), `:241` (URL), `:257-262` (publish)

The release tag and asset name are keyed only on the idb sha
(`companion-<idb_short>`), but the guard job deliberately rebuilds when
*either* pin moves (`:80-82`).

**Failure scenario:** `companion.lock.json` is committed (and shipped in
published npm versions) pointing at
`companion-abc1234/companion-abc1234-arm64.tar.gz` with sha256 `X`. Later,
`.xcode-version` is bumped with `vendor/idb` unchanged — an expected,
guard-approved event. The build publishes to the *same* tag;
`softprops/action-gh-release` replaces the same-named asset with a binary whose
sha256 ≠ `X`. From that moment, every fresh install of every previously
published package version downloads the new asset, fails the checksum check in
`src/idb/companionBinary.ts:217`, and refuses to run — permanently, since old
npm versions can't be re-locked.

Compounding it: the `push` trigger has no branch filter and `inputs.publish` is
empty (≠ `false`) on push events, so any branch push touching `.xcode-version`
publishes/overwrites production release assets.

### 2. HTTP transport is open to DNS rebinding — a web page can drive the server

`src/index.ts:1864-1866`

The brief accepts unauthenticated loopback, but DNS rebinding defeats the
"loopback = local processes only" boundary without binding wider.
`StreamableHTTPServerTransport` is created with no
`allowedHosts`/`enableDnsRebindingProtection` (the pinned SDK 1.18.2 supports
both), and the raw `http` server never checks `Host` or `Origin`.

**Failure scenario:** the user browses a malicious page at `attacker.com`; the
attacker re-resolves that name to `127.0.0.1`. The page's
`fetch("http://attacker.com:8008/mcp", {method:"POST"})` is now *same-origin*
— no CORS preflight applies — and reaches the server, which executes any tool:
drive simulators, exfiltrate `ui_view` screenshots, and write files at
attacker-chosen paths via `screenshot`/`record_video` `output_path` (absolute
paths are honored, `src/index.ts:1307`).

### 3. Concurrent dead-channel recoveries kill each other's freshly respawned companion; one read fails anyway

`src/idb/companionManager.ts:119-125` with `:358-361`

The non-exclusive retry does `shutdown(udid)` → `clientFor(udid)` → retry, but
`shutdown` has no notion of *which* companion the caller means.

**Failure scenario:** reads R1 and R2 are both in flight against companion C1
when it dies; both get `UNAVAILABLE`. R1 recovers: kills C1, spawns C2, starts
its retry against C2. R2 then enters its own recovery and calls
`shutdown(udid)` — which (deterministically, via the `spawning` await at
`:358`) waits for C2's spawn and then **kills healthy C2** mid-flight. R1's
retry fails with `UNAVAILABLE` and, being the retry, propagates to the caller.
Net: the read fails despite the respawn-and-retry design existing precisely to
hide this, plus C1→C2→C3 churn.

A generation/instance check (only shut down the companion you failed against)
would fix it.

### 4. The socket path is reused across respawns, so a dying companion unlinks its successor's socket

`src/idb/companionManager.ts:186` (path is `<udid>.<pid>.sock` — identical for
every respawn), `:388`

`shutdown` removes the entry from the map *first*, then spends up to 3s waiting
for the child to die. In that window `clientFor` sees no entry and spawns a
replacement onto the **same socket path**. When the old child then exits, its
own cleanup (and `shutdown`'s `unlinkSync` at `:388`) deletes the socket file
the *new* companion just bound.

**Failure scenario:** session A's `destroy_simulator` (or `describeAll`'s
empty-tree recovery) is mid-`shutdown` for a udid while session B's tool call
spawns a replacement; B's companion binds, the old one exits and unlinks the
path; B's `waitForReady` connect hits `ENOENT` → spurious "did not become
ready" error — or, if already connected, any later channel re-establishment
fails and an exclusive input call errors without retry.

A per-spawn nonce in the socket filename fixes it.

### 5. `changed` guard inspects only `HEAD^`, so a multi-commit push skips a genuinely needed build

`.github/workflows/build-companion.yml:61-86`

The `paths` filter evaluates the whole push range (`before..after`), but the
guard compares pins only between `HEAD` and `HEAD^`.

**Failure scenario:** `git push` of two commits — first bumps `vendor/idb`,
second touches `README.md` (or a rebase-merge lands the bump anywhere but the
tip). The workflow triggers, the guard sees `HEAD` vs `HEAD^` pins identical,
outputs `build=false`, and the notice asserts "The published release still
matches these pins" — false; the new pin has no release at all. A later
attempt to update the lock finds nothing to point at, and if the regenerated
client was committed with the bump, the repo ships a client generated from a
sha newer than the pinned companion — the exact skew this design exists to
prevent.

Compare against `github.event.before` (or the last published pin) instead.

### 6. `destroy_simulator` racing an in-flight read respawns a companion for a simulator being deleted

`src/index.ts:730-734` with `src/idb/companionManager.ts:121-123`

`destroy_simulator` shuts the companion down, then runs
`simctl shutdown`/`delete` (seconds). A concurrent read for the same udid
(second session attached to it, per the multi-agent design) sees its channel
die, and its recovery **spawns a fresh companion** for the doomed simulator.
If the spawn wins the race with `simctl delete`, the manager registers a
companion whose target is deleted moments later; nothing removes it until the
1-hour idle backstop or process exit — and meanwhile `running()` and the map
claim a live companion for a nonexistent simulator.

The manager needs a per-udid "closed, don't respawn" state that
`destroy_simulator` can set.

## Minor

- **`src/idb/companionBinary.ts:119-140` — the success memo never
  revalidates.** If the user clears the cache while the server runs (which the
  `ENOENT` guidance in `src/idb/companionManager.ts:341-343` explicitly
  suggests), `pending` still resolves to the deleted path, so every later spawn
  fails until the process restarts — the error message implies self-healing
  that can't happen. Re-checking `isUsable` before returning a memoized path
  fixes it.
- **`scripts/gen-keymap.mjs:60`** — the entry regex requires a trailing comma;
  a final KEY_MAP entry without one is silently dropped, and the
  printable-ASCII coverage check would not catch `"\n"` (outside 0x20–0x7E).
  Today's vendored `hid.py` has trailing commas throughout, so this is latent
  only.
- **`src/index.ts:1898-1900`** — `httpServer` has no `'error'` listener, so
  `EADDRINUSE` (likely now that HTTP is the default and multiple agents may
  auto-launch the server) dies as an unhandled `'error'` event with a raw stack
  rather than a message. Loud, so correctness-neutral.
- **`src/index.ts:1820`** — `readJsonBody` has no size cap; loopback-only, so
  noting rather than flagging.
- Pre-existing (unchanged by this branch, listed only because hunt item 5
  asks): `record_video`'s child has its stdout pipe never drained (a chatty
  `recordVideo` could block at 64KB) and its stderr handler appends to
  `errorOutput` for the recording's whole life; `start_simulator` leaks the
  created device if `simctl boot` fails after `simctl create`.

## Checked and fine

- `fetchToFile`: settled-guard, redirect bounding/relative resolution,
  hash-before-pipe ordering, error paths on truncation/disk-full, and scratch
  cleanup on every throw path all hold; the rename race handling
  (`ENOTEMPTY`/`EEXIST` + usability check) is correct, and tmp and install dirs
  share a filesystem so the rename is atomic.
- `socketDir()` ownership check is sound: `lstat` after `mkdirSync` catches
  pre-created symlinks and foreign-uid dirs, and /tmp's sticky bit prevents
  swapping the directory afterwards.
- `exclusively()` chain retains no tail and survives rejections; no exclusive
  call nests another, so no self-deadlock.
- Rounding, LEGACY describe-point, transform-then-round ordering, and returned
  JSON shapes all match the old CLI paths.
  `AccessibilityInfoRequest.fromPartial` leaves an unset `marker` as `""`,
  which proto3 doesn't serialize, so plain reads are unaffected by the marker
  plumbing.
- `sips --rotate` rotates **clockwise** (the comment at `src/index.ts:1253`
  says counter-clockwise), but the 90/270 mapping is consistent with
  `transformPointToPortrait`, so the code is right and only the comment is
  wrong.
- HTTP-mode state audit: everything durable (`managedSimulators`,
  `activeRecordings`, `startingSessions`, the companion manager, the download
  memo) is module-level; nothing per-request is assumed shared.
