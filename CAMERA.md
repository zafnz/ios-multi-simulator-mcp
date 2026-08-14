# Camera in the simulator: a design, not a feature

> **Status: idea only. None of this is implemented.** No code in this repository
> does any of it, and nothing below has been run. Every estimate is a reading of
> someone else's source plus the usual arithmetic, not a measurement. Treat the
> whole document as a proposal to argue with.

Sketched 2026-08-14, from a survey of the two existing approaches.

## What we would be trying to do

Let a session say "the camera is this JPEG", and have an app running in that
session's simulator see it through whatever ordinary AVFoundation code it
already contains. No changes to the app under test, no SDK, no `Info.plist`
edit. The simulator has never had a camera — `AVCaptureDevice` returns nil —
so anything that fixes this is an interception somewhere.

The motivating use is an agent driving a scanner or capture flow and needing a
deterministic fixture in front of the lens.

## Two ways, and why the obvious one is wrong for us

### CoreMedia I/O system extension — rejected

The clean approach. A `CMIOExtension` registers a virtual camera at the macOS
system level; the Simulator (Xcode 16+) picks up host cameras through
AVFoundation, so the guest app sees a real device and *every* camera API works
on top of it because AVFoundation itself is doing the work. `dautovri/SimulatorCamera`
does exactly this.

It is rejected for us on four counts, any one of which would be enough:

| Cost | Detail |
|---|---|
| Signing | The extension must be signed with a real Apple Developer team; ad-hoc will not activate. Developer ID + notarization on every release. This project currently needs no Apple account at all. |
| Install shape | macOS refuses to activate a system extension outside `/Applications`. npm installs into `node_modules`. The install story becomes "npm install, then copy an app bundle, then approve in System Settings as admin". |
| Uninstall | `npm uninstall` cannot remove it. It survives as a system component until `systemextensionsctl uninstall`. |
| **Scope** | **A CMIO camera is global to the Mac.** |

The last one is the real blocker and it is architectural, not economic. This
server is per-session by design: every tool takes an `id`, `managedSimulators`
tracks a device per session, sessions own their simulator's lifecycle. One
system-wide camera cannot serve two sessions that want two different fixtures.
An extension can publish several devices, but the guest calls
`AVCaptureDevice.default(for: .video)` and gets whatever macOS nominates —
nothing obviously lets you bind camera 2 to simulator B. **This is untested.
See Open questions.**

There is also a values mismatch. We have an explicit rule about not touching
the user's `/tmp/idb`. Installing a system-wide virtual camera that appears in
the developer's Zoom and QuickTime, from an npm package, is the same concern
several sizes larger.

The irony is exact: the property that makes CMIO complete — a real device the
whole OS believes in — is the property that makes it wrong for a per-session
tool.

**If someone wants the CMIO behaviour anyway**, the cheap answer is to *drive*
an existing extension rather than ship one. `simcamctl set-source --image
./test.jpg` already exists in `dautovri/SimulatorCamera`, and its README names
"AI agents that need to feed deterministic test fixtures" as a target use. A
`set_camera` tool that shells out to it, with an
`IOS_SIMULATOR_MCP_SIMCAMCTL_PATH` override in the style of
`src/idb/companionBinary.ts`, is around two days of work and no signing burden.
It would have to be documented as machine-global — it would be the only tool in
our surface that ignores `id`.

### Method swizzling — the proposal

`CarGuo/iOS-Simulator-Camera-Extend` (MIT) takes the other route.
`simctl` forwards any environment variable prefixed `SIMCTL_CHILD_` into the
launched process with the prefix stripped, so:

```bash
SIMCTL_CHILD_DYLD_INSERT_LIBRARIES="$HOOK" \
  xcrun simctl launch --terminate-running-process "$UDID" "$BUNDLE_ID"
```

loads a dylib into the **guest app process** before its `main()`. Inside the
simulator there is no hardened runtime or library validation to fight. The
dylib then rewrites the Objective-C method tables so that AVFoundation calls
made by the app — and by Apple's own frameworks inside that process — land in
our code instead.

The trade against CMIO, stated plainly:

| | CMIO extension | Swizzled hook |
|---|---|---|
| Privilege | User-approved system extension | None |
| Scope | Every camera client on the Mac | Only processes we launch |
| Persistence | Installed, survives reboot | Gone when we stop passing the env var |
| Coverage | Complete, for free | **Exactly what we hand-write** |
| Launch path | Unchanged | Must go through `simctl launch` |

Per-session scoping is what we want and CMIO cannot give us. Coverage is what
we pay for it, and the rest of this document is that bill.

## What the existing hook gives us to build on

`Sources/SimCamHook/SimCamHook.m` is 972 lines, MIT, and better structured than
expected. Three mechanisms, all reusable:

1. **Fabrication of objects with private initialisers.**
   `SimCamFakeAVCaptureDevice` is a real `AVCaptureDevice` subclass instantiated
   through `class_createInstance`, sidestepping the private init;
   `SimCamFakeMetadata` does the same for `AVMetadataMachineReadableCodeObject`.
   Every gap below is filled with this same trick.
2. **Registry and pump.** Swizzled registration points
   (`setSampleBufferDelegate:queue:`, `setMetadataObjectsDelegate:queue:`)
   record entries; `simcam_dispatch_sample` / `simcam_dispatch_metadata` drain
   them, filtered by camera slot. Adding a surface means adding a registry and a
   dispatch function.
3. **Working `CMSampleBuffer` construction** from an IOSurface-backed
   `CVPixelBuffer`. The genuinely fiddly part, already done.

Covered today: device discovery, authorization, session wiring
(`addInput:`/`addOutput:`/`startRunning`), `AVCaptureVideoDataOutput`,
`AVCaptureMetadataOutput` (QR), and `AVCaptureVideoPreviewLayer`.

That is enough for a live preview and a barcode scanner. It is not enough for
an app with a shutter button.

## The gap, and why the failure mode is nasty

Consider an app that previews and then captures a still. `canAddOutput:` and
`addOutput:` *are* swizzled, so adding an `AVCapturePhotoOutput` succeeds and
the session looks healthy. Preview works. The user taps the shutter.
`capturePhoto(with:delegate:)` is **not** hooked, so it reaches real
AVFoundation, which asks a pipeline with no hardware behind it for an image.
`photoOutput(_:didFinishProcessingPhoto:)` never fires.

No exception, no nil, no log line. The spinner spins forever, in a flow that
looked correct right up to the last step. A nil `AVCaptureDevice` is a failure
apps handle; this is one they do not.

Every row below is a variation on that.

| Surface | Why it matters | New ObjC |
|---|---|---|
| **`AVCapturePhotoOutput`** | The shutter button. Needs `capturePhoto:delegate:`, a fabricated `AVCapturePhoto` (`fileDataRepresentation` is trivial — we *have* the JPEG), a fabricated `AVCaptureResolvedSettings`, and the four lifecycle callbacks (`willBeginCaptureFor:`, `willCapturePhotoFor:`, `didCapturePhotoFor:`, `didFinishCaptureFor:`) that apps gate UI on | ~300 |
| **`device.formats` / `activeFormat`** | Today `formats` returns `@[]` and `activeFormat` is not overridden at all, so it dispatches into real AVFoundation on a fabricated object. Every serious camera codebase walks `formats` to choose resolution and frame rate, including react-native-vision-camera and Flutter's camera plugin. **The quiet one that breaks real apps.** | ~120 |
| **`UIImagePickerController(.camera)`** | System UI, so there is no device to fake. Swizzle `presentViewController:animated:completion:`, detect a picker with `sourceType == .camera`, substitute our own view controller showing the JPEG with a shutter and a cancel, firing `imagePickerController:didFinishPickingMediaWithInfo:` | ~200 |
| **Device properties** | `hasTorch`/`torchMode`, `videoZoomFactor` and its min/max, `focusMode`/`isFocusModeSupported:`, `exposureMode`, `isFlashAvailable`. One-line getters, but an unimplemented one dispatches to real AVFoundation on a fake instance — undefined, usually a crash | ~80 |
| **Pixel format negotiation** | Everything is BGRA. An app that sets `videoSettings` to 420f/420v and feeds Vision or CoreML gets misread buffers | ~80 |
| **`AVCaptureConnection`** | `videoOrientation`, `videoRotationAngle` (iOS 17+), `isVideoMirrored`. Set during routine configuration | ~50 |
| **`AVCaptureStillImageOutput`** | Deprecated since iOS 10, still everywhere in older code. We already build `CMSampleBuffer`s, so it is nearly free | ~40 |
| **Session preset** | `canSetSessionPreset:` → YES. Apps branch on it and bail | ~20 |
| `AVCaptureMovieFileOutput` | Video recording. Needs AVAssetWriter to produce a real file. **Cut from v1** | *~150* |
| VisionKit `DataScannerViewController` | Modern scanning UI, same shape as the picker. **Cut from v1** | *~150* |

**v1 total: roughly 890 new lines**, about doubling the file.

Out of scope entirely: ARKit (does not run in the simulator regardless), depth
and portrait-matte outputs, `AVCaptureMultiCamSession`. SwiftUI needs nothing —
it has no camera API of its own and wraps the above.

## The simplification a static JPEG buys

CarGuo's design streams frames from a macOS host app over a unix socket, using
a 48-byte wire header, because its sources include webcams, screen capture and
video files. **We want none of that.** For a static image:

- Delete the puller thread, the socket and the wire protocol from the dylib
  (lines 717–809, ~90 lines). Replace with ~30: decode the file once at
  startup, hold one `CVPixelBuffer`, drive a 30 fps timer off it.
- Delete the host-side frame server entirely — no Mac app, and no
  reimplementation of one in Node.
- Delete the risk of owning a private wire contract we did not specify, whose
  failure mode is silent black frames rather than an error.

Net change to the dylib: **−90 / +30**. This is the single biggest reason the
narrow scope is worth keeping.

### Getting the file to the guest

The guest process must read the JPEG, and host-path access through the
simulator's sandbox is not something to bet on. The deterministic route uses
machinery we already have:

1. `install_app` puts the app on the device.
2. `xcrun simctl get_app_container <udid> <bundle_id> data` gives the host path
   of the app's container.
3. Write the JPEG there from the Node side.
4. Pass the *guest* path in `SIMCTL_CHILD_SIMCAM_IMAGE`.

No sandbox question arises. It does mean the camera can only be set for an app
we have installed, which is already true of everything else here.

## Work on our side

| Piece | Notes | TS |
|---|---|---|
| `run()` gains optional `env` | It currently takes `(cmd, args)` only | ~10 |
| `launch_app` camera plumbing | New param, container-path resolution, env construction | ~80 |
| `camhook.lock.json` + resolver | Straight adaptation of `src/idb/companionBinary.ts`: explicit env override, else `vendor/`, else sha256-pinned download from our own release | ~200 |
| Validation and errors | Path checks in the style of `install_app` and `screenshot` | ~60 |

**~350 lines**, every piece patterned on code already in the repo.

### API shape

`start_simulator(withCamera=...)` **cannot work.** The environment variable is
consumed at app launch, not at boot; setting it at boot is far too early.

The fit for our session model is to store the camera source on the session
record beside `orientation`, and have `launch_app` apply it. A separate
`set_camera` tool is probably better than a create-time parameter — it lets an
agent swap the fixture between launches without rebooting the device. Either
way the constraint is the same and must be documented: **it takes effect at the
next launch**, and an app started any other way (Xcode, an already-running
process) will not have it.

## Distribution and build

The dylib is an Xcode build for the simulator platform, in a project whose
build is otherwise `tsc`. That sounds like a bigger departure than it is: the
pattern already exists twice over in `src/idb/`. `companion.lock.json` plus
`companionBinary.ts` is exactly this — build locally into `vendor/`, or fetch a
sha256-pinned tarball from our own GitHub release, and never fall back to
`$PATH`. The camera hook is copy-and-adapt, and unlike the companion it builds
in seconds rather than half an hour.

The `$PATH` prohibition applies here for the same reason it applies to the
companion: a stale hook would silently fail to intercept newer APIs rather than
erroring, which is the worst possible failure for something whose entire job is
to lie convincingly.

## Testing

None of this can live in `npm test`. It is Objective-C running inside a
simulator; `src/ax/` exists precisely because it is the part that can be tested
without one, and this is the opposite of that.

Verification is therefore the fixture app and a new section of
`TESTING_TOOLS.md`, which means **`testapp/` needs camera screens** — preview,
photo capture, QR scan, image picker, one per surface. Call it ~300 lines of
Swift, on top of every estimate above. Without them there is no way to tell a
working hook from a broken one.

## The part that has no number

Everything above is knowable. This is not.

The fabrication trick means an app that calls a property we did not override
dispatches into real AVFoundation on an object that is not real. **We find out
which properties matter by crashing.** CarGuo's `formats { return @[]; }` is
that pattern caught mid-stride — stopped at the first thing that worked for
their demo.

So the loop is: run a real app, catch the crash, add the getter, repeat. The
1,200 lines are writable. How many rounds of that it takes depends entirely on
which apps get pointed at it, and it will likely dominate the calendar time
while remaining a minority of the code.

This is the honest argument against the whole approach, and it should be
weighed before starting rather than discovered halfway.

## Open questions

Both are cheap to answer and both change the decision. Neither has been tested.

1. **Does per-simulator isolation actually matter in practice?** Install
   `dautovri/SimulatorCamera`, boot two sessions through this server, run
   `simcamctl set-source --image`, and `ui_view` both. If both simulators show
   the fixture and there is no way to give them different ones, that confirms
   the CMIO rejection above. If some binding *is* possible, the two-day
   integration beats the two-week hook and this document is mostly wrong.
2. **Does the injection path work at all on a current Xcode?** A stub dylib
   that logs its own load and nothing else, injected via
   `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES`, against a current simulator runtime.
   Everything here is built on that mechanism still being open.

Answer 2 before writing anything. Answer 1 before choosing between approaches.

## If it goes ahead

Order matters, because the first slice is also the riskiest:

1. Stub dylib, injection confirmed (open question 2).
2. Strip the socket; load the JPEG from the container path; make the existing
   preview and `AVCaptureVideoDataOutput` paths work from a file. Proves the
   plumbing end to end.
3. `AVCapturePhotoOutput`. ~300 lines that exercise every hard technique at
   once — object fabrication, delegate lifecycle, the file path. **If this
   lands cleanly the remaining rows are mechanical. If it does not, stop.**
4. `device.formats`, then the device property surface. The two that decide
   whether real third-party apps work.
5. Everything else in the table, cheapest first.
6. `testapp/` screens and `TESTING_TOOLS.md`, alongside each step rather than
   at the end.

## A note on scope

This adds a third module and a second native toolchain to a project whose
stated rule is that the two existing splits "are not a licence to keep
splitting". The `src/idb/` precedent argues for it — "generated code plus
process lifecycle rather than server logic" describes a vendored dylib fairly
exactly — but this is the kind of change CLAUDE.md says to decide deliberately
rather than drift into. Hence a document rather than a branch.

## Prior art

- [CarGuo/iOS-Simulator-Camera-Extend](https://github.com/CarGuo/iOS-Simulator-Camera-Extend) — MIT. The hook this proposal would vendor. Also ships a CMIO pipeline requiring SIP relaxation and a self-signed cert, which we would not use.
- [dautovri/SimulatorCamera](https://github.com/dautovri/SimulatorCamera) — the CMIO route done properly, plus `simcamctl` for automation.
- [Create camera extensions with Core Media IO — WWDC22](https://developer.apple.com/videos/play/wwdc2022/10022/) — why DAL plug-ins died and what replaced them.
- [RocketSim](https://www.rocketsim.app/docs/features/capturing/simulator-camera-support/) — commercial, same global-device constraint.
