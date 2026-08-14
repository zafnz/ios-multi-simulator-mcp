# MCPTestApp — test fixture

A minimal UIKit app for exercising this MCP server's UI tools. **Not shipped
with the package** (`package.json`'s `files` covers `build` and
`companion.lock.json` only) and not part of the server in any way — it exists
so [TESTING.md](../TESTING.md) has a fixture it controls, instead of borrowing
Apple's apps and their first-run wizards.

## Why it looks the way it does

Every control comes in a pair — one in the plain view hierarchy, one inside
system chrome:

| Plain view | System chrome |
|---|---|
| `Plain Button` (`PlainButton`) | `Toolbar Button` (`ToolbarButton`), `Nav Button` (`NavButton`) |
| `Plain Field` (`PlainField`) | toolbar text field (`ToolbarField`) |

That pairing is the point. Apple's AX translation graph has no parent→child
edge into `Toolbar`, `Tab Bar` and `Nav bar`, so their contents are absent from
the default accessibility tree even though they are on screen, labelled and
tappable — see TODO.md #22 / #34 and the root-cause table below them. The
server works around it: `describeScreen` reads over AXBridge, and `findByLabel`
falls back to AXBridge when the cheap marker query misses. This app reproduces
the failing shape on demand, so those two paths can be checked without booting
Photos and dismissing two wizards first.

Two further details are deliberate:

- **The toolbar text field has no `accessibilityLabel`.** Like Contacts' search
  field, its visible text arrives as `AXValue` with a null `AXLabel` — the case
  `findByLabel`'s value matching exists for (TODO.md #23), which has been
  implemented but never verified against a real value-only element.
- **A status label reports every tap and keystroke.** It sits in the plain view
  hierarchy, so a toolbar interaction can be confirmed without reading the
  toolbar — otherwise verifying the buggy container would depend on the buggy
  container.

## Build

```bash
testapp/build.sh
```

Produces `testapp/build/MCPTestApp.app` (git-ignored — the repo's `build/`
rule matches at any depth), bundle id `com.example.mcptestapp`. Needs the
Xcode command line tools and an iOS simulator SDK; takes about a second.

## Use it

```
install_app(id: "test-session", app_path: "<repo>/testapp/build/MCPTestApp.app")
launch_app(id: "test-session", bundle_id: "com.example.mcptestapp")
```

### What to expect

- `ui_describe_all` should list **all five** controls. The nav bar and toolbar
  groups coming back with `"children": []` means the AXBridge read has stopped
  working and the server has silently regressed to the incomplete tree.
- `ui_find` / `ui_tap {label: "Toolbar Button"}` should resolve — via the
  AXBridge fallback, so expect ~330 ms rather than ~13 ms.
- `ui_tap {label: "Toolbar Search"}` exercises value-only matching.
- After any tap, the status label reads e.g. `status: tapped Toolbar Button`;
  after `ui_type`, `status: Plain Field = "hello"`.
- `ui_describe_point` hit-tests, so it finds the chrome controls regardless —
  useful as the control case when something else disagrees.

Landscape is supported, so the fixture can also stand in for Photos in the
landscape coordinate section of TESTING.md.
