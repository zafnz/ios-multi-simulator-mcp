# Changelog

## 2.0.0

The release where the server stops depending on anything you have to install
yourself, and where tapping a control by name became reliable.

This is a summary of where the project has arrived rather than an itemised diff
of every change since 1.2.0 — there were too many, across too long a stretch,
for a list to be more useful than a description.

### Self-contained

No `pipx install fb-idb`, no `brew install idb-companion`, no Python anywhere.
The server talks to `idb_companion` directly over gRPC, and ships its own
companion: built from a pinned `facebook/idb` commit in CI, published as a
release asset, then downloaded once and verified against the sha256 in
`companion.lock.json`.

There is deliberately no discovery — no `$PATH` lookup, no version negotiation.
A companion older than the pinned one does not reject request fields it does not
understand; it ignores them and answers anyway, so a fallback would return
answers that are wrong but entirely plausible. Pinning is what keeps the
generated client and the companion the same age.

Dropping the per-call Python process took a tap from ~165 ms to ~3 ms.

**Apple Silicon only.** The bundled companion is arm64; Intel Macs are not
supported.

### Sessions, and more than one simulator

Every tool takes an `id` naming your session, and each session owns one
simulator, so several agents can drive their own simulators against one server.
`start_simulator`, `attach_simulator` and `destroy_simulator` manage that
lifecycle; `get_booted_sim_id`, `open_simulator` and `IDB_UDID` are gone,
replaced by it.

**HTTP is now the default transport**, which is what makes a shared server
possible. `--stdio` selects the old behaviour for a client that wants to own its
own process.

### Navigating by name

`ui_find` and `ui_tap {label}` resolve a control on the simulator and return or
tap it, costing a few hundred bytes instead of a screen-sized tree.

The accessibility tree Apple's translator exposes turned out to omit whole
containers: tab bars, nav bars and toolbars arrive with no children, so every
control inside one was invisible — `ui_find` reported "no element found" for
elements carrying exactly that label and hit-testing perfectly well. Both tools
now fall back to idb's axbridge backend, which walks the app's real view
hierarchy, and `ui_describe_all` reads from it directly.

`ui_describe_all` is pruned to elements you can act on and asks for a restricted
key set, so a complete tree costs about what the incomplete one used to: on a
Photos screen, 3.9 KB for 25 nodes where the old read gave 3.8 KB for 9.

### Also

- `detect_rotation`, and logical-coordinate handling that survives rotation
- Accessibility reads recover from a wedged companion automatically, instead of
  requiring the simulator to be destroyed and recreated
- HTTP transport rejects DNS-rebound requests
- Every gRPC call carries a deadline

## Known issues

Being worked on for 2.0.1.

- **`start_simulator` returns before the simulator is usable.** Expect 40–90
  seconds before UI tools work, during which they fail with an idb error about
  "no translation object" that blames a fullscreen dialog rather than the boot
  that is actually in progress. Poll `ui_view` until it succeeds.
- **Label matching is exact substring, including typography.** iOS labels the
  permission button `Don’t Allow` with U+2019, so an ASCII apostrophe finds
  nothing.
- **Rotation cannot be driven.** No tool rotates the device; it has to be done
  by hand in the Simulator app, after which `detect_rotation` picks it up.
- **A miss costs more than a hit.** `ui_find` answers in ~13 ms when the cheap
  tree contains the element and ~330 ms when it does not, because the fallback
  runs. Do not poll in a tight loop.

## Earlier

1.0.0 through 1.2.0 established the fork: the session model, the multi-simulator
server, and the move off the Python `idb` client. They are not itemised here.

This project is a fork of
[joshuayoes/ios-simulator-mcp](https://github.com/joshuayoes/ios-simulator-mcp).
