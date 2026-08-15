/**
 * A typed gRPC client for a single idb_companion, over a unix domain socket.
 *
 * Replaces shelling out to the Python `idb` CLI: one long-lived channel per
 * simulator instead of a ~165ms process spawn per call.
 *
 * Lifetime is deliberately not this class's job — it holds a channel to a
 * socket path someone else chose. CompanionManager owns spawn/respawn/kill.
 */

import * as grpc from "@grpc/grpc-js";
import {
  AccessibilityInfoRequest,
  AccessibilityInfoRequest_Backend,
  AccessibilityInfoRequest_Format,
  AccessibilityActionRequest,
  AccessibilityActionRequest_SearchableKey,
  CompanionServiceClient,
  HIDEvent,
  HIDEvent_HIDButtonType,
  HIDEvent_HIDDirection,
  HIDEvent_HIDOrientationType,
  TargetDescription,
} from "./generated/idb";
import { HID_KEY_SHIFT, KEY_MAP, unmappedCharacters } from "./keymap";

export {
  AccessibilityInfoRequest_Backend as Backend,
  AccessibilityInfoRequest_Format as Format,
  AccessibilityActionRequest_SearchableKey as SearchableKey,
  HIDEvent_HIDButtonType as Button,
  HIDEvent_HIDOrientationType as OrientationType,
};

/**
 * Screenshots run ~2.8MB and an AXBRIDGE tree ~84KB, both over grpc-js's 4MB
 * default once video frames arrive. Raised here rather than per-call.
 */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/** How long to wait for the channel to come up before failing a call. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Every call carries a deadline. Without one, a companion that accepts a
 * request and never answers leaves the promise pending forever — and because
 * input is serialized per simulator, one such call would wedge every later tap,
 * swipe and keystroke for that simulator until the server was restarted. A
 * deadline turns that into a recoverable error instead.
 */
const READ_TIMEOUT_MS = 60_000;

/**
 * Input gets longer: a swipe's duration is caller-supplied, and typing a long
 * string is thousands of key events.
 */
const INPUT_TIMEOUT_MS = 120_000;

function deadline(afterMs: number): Partial<grpc.CallOptions> {
  return { deadline: Date.now() + afterMs };
}

/**
 * Descent budget for a marker query when the caller does not choose one.
 *
 * `depth` is how far below the root the search may go: 0 tests only the root,
 * 1 adds its direct children. Home-screen icons are direct children, but a
 * control inside a real app sits many levels down, so a shallow default would
 * report perfectly visible elements as missing. The search is depth-first and
 * stops at the first match, so a generous bound costs nothing when the element
 * is found and merely walks the tree when it is not.
 */
const MARKER_DEFAULT_DEPTH = 50;

export type AccessibilityQuery = {
  /** Describe the element at this point instead of the whole screen. */
  point?: { x: number; y: number };
  format?: AccessibilityInfoRequest_Format;
  backend?: AccessibilityInfoRequest_Backend;
  /** Substring-match a single element by `matchKey` instead of dumping a tree. */
  marker?: string;
  matchKey?: AccessibilityActionRequest_SearchableKey;
  /**
   * Tree depth for marker queries. Ignored for whole-screen and point reads —
   * use `keys` to control payload size there.
   */
  depth?: number;
  /** Restricts described keys; empty returns the companion's default set. */
  keys?: string[];
};

export class IdbError extends Error {
  constructor(
    message: string,
    readonly code?: grpc.status,
    readonly details?: string
  ) {
    super(message);
    this.name = "IdbError";
  }
}

export class IdbClient {
  private client: CompanionServiceClient;

  constructor(readonly socketPath: string) {
    this.client = new CompanionServiceClient(
      `unix://${socketPath}`,
      grpc.credentials.createInsecure(),
      {
        "grpc.max_receive_message_length": MAX_MESSAGE_BYTES,
        "grpc.max_send_message_length": MAX_MESSAGE_BYTES,
      }
    );
  }

  /** Resolves once the channel is connected, so callers fail fast, not hang. */
  async waitForReady(timeoutMs: number = CONNECT_TIMEOUT_MS): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.client.waitForReady(Date.now() + timeoutMs, (err) =>
        err
          ? reject(
              new IdbError(
                `Companion at ${this.socketPath} did not become ready within ${timeoutMs}ms: ${err.message}`
              )
            )
          : resolve()
      );
    });
  }

  /** Target metadata, including screen dimensions in both pixels and points. */
  async describe(): Promise<TargetDescription> {
    const response = await this.unary<TargetDescription | undefined>((cb) =>
      this.client.describe(
        { fetchDiagnostics: false },
        new grpc.Metadata(),
        deadline(READ_TIMEOUT_MS),
        (err, res) => cb(err, res?.targetDescription)
      )
    );
    if (!response) throw new IdbError("describe returned no target description");
    return response;
  }

  /**
   * Accessibility tree, or a single element when `point` or `marker` is set.
   * Returns the companion's parsed JSON — shape depends on `format`.
   */
  async accessibilityInfo(query: AccessibilityQuery = {}): Promise<unknown> {
    // depth defaults to 0, and a marker query at depth 0 searches only the root:
    // it reports the element as absent rather than erroring, which reads exactly
    // like a missing control. Never let a marker query go out at depth 0.
    const depth =
      query.marker !== undefined && !query.depth
        ? MARKER_DEFAULT_DEPTH
        : query.depth ?? 0;

    const request = AccessibilityInfoRequest.fromPartial({
      point: query.point,
      format: query.format ?? AccessibilityInfoRequest_Format.NESTED,
      backend:
        query.backend ?? AccessibilityInfoRequest_Backend.BACKEND_UNSPECIFIED,
      marker: query.marker,
      matchKey: query.matchKey,
      depth,
      keys: query.keys ?? [],
    });

    const json = await this.unary<string>((cb) =>
      this.client.accessibilityInfo(
        request,
        new grpc.Metadata(),
        deadline(READ_TIMEOUT_MS),
        (err, res) => cb(err, res?.json)
      )
    );

    try {
      return JSON.parse(json);
    } catch (e) {
      throw new IdbError(
        `Companion returned unparseable accessibility JSON: ${(e as Error).message}`
      );
    }
  }

  /**
   * Activates an element through accessibility rather than by touching it.
   *
   * The companion implements this as `AXPress` — the activation VoiceOver
   * performs — so it operates a control the caller cannot aim at: a switch
   * whose accessibility frame spans its whole row actuates nowhere near its own
   * centre, and no coordinate derived from the tree will hit it.
   *
   * It is not a touch, and the difference matters in both directions. It cannot
   * carry a hold duration, and it does not hit-test, so it will operate a
   * control that a finger could not reach. Callers decide when that trade is
   * the right one; this only performs it.
   */
  async activate(
    marker: string,
    matchKey: AccessibilityActionRequest_SearchableKey
  ): Promise<void> {
    const request = AccessibilityActionRequest.fromPartial({
      marker,
      matchKey,
      depth: MARKER_DEFAULT_DEPTH,
      tap: {},
    });
    await this.unary<unknown>((cb) =>
      this.client.accessibilityAction(
        request,
        new grpc.Metadata(),
        deadline(READ_TIMEOUT_MS),
        (err, res) => cb(err, res)
      )
    );
  }

  /** Taps once at a point, optionally holding for `duration` seconds. */
  async tap(x: number, y: number, duration?: number): Promise<void> {
    const touch = { touch: { point: { x, y } } };
    await this.sendHidEvents([
      press(touch, HIDEvent_HIDDirection.DOWN),
      ...(duration ? [HIDEvent.fromPartial({ delay: { duration } })] : []),
      press(touch, HIDEvent_HIDDirection.UP),
    ]);
  }

  /** Presses a hardware button (HOME, LOCK, SIRI, ...). */
  async pressButton(
    button: HIDEvent_HIDButtonType,
    duration?: number
  ): Promise<void> {
    const action = { button: { button } };
    await this.sendHidEvents([
      press(action, HIDEvent_HIDDirection.DOWN),
      ...(duration ? [HIDEvent.fromPartial({ delay: { duration } })] : []),
      press(action, HIDEvent_HIDDirection.UP),
    ]);
  }

  /**
   * Rotates the device, as the Simulator's own Device > Orientation menu does.
   *
   * Sending the request is all this does. Whether the *app* follows the device
   * is the app's decision and iOS's — a Face ID iPhone never adopts
   * upside-down portrait however the fixture's Info.plist is written — so the
   * caller must read the orientation back rather than assume it took.
   */
  async setOrientation(
    orientation: HIDEvent_HIDOrientationType
  ): Promise<void> {
    await this.sendHidEvents([
      HIDEvent.fromPartial({ orientation: { orientation } }),
    ]);
  }

  async swipe(
    start: { x: number; y: number },
    end: { x: number; y: number },
    options: { delta?: number; duration?: number } = {}
  ): Promise<void> {
    await this.sendHidEvents([
      HIDEvent.fromPartial({
        swipe: {
          start,
          end,
          delta: options.delta ?? 0,
          duration: options.duration ?? 0,
        },
      }),
    ]);
  }

  /**
   * Types text as key events. Only printable ASCII and newline have keycodes;
   * anything else is rejected before a single event goes out, so a bad
   * character can't leave half a string typed into the app.
   */
  async typeText(text: string): Promise<void> {
    const unmapped = unmappedCharacters(text);
    if (unmapped.length > 0) {
      const shown = [...new Set(unmapped)]
        .map((c) => JSON.stringify(c))
        .join(", ");
      throw new IdbError(
        `Cannot type ${shown}: no keycode exists for it. ` +
          `Only printable ASCII (space through ~) and newline can be typed.`
      );
    }

    const events: HIDEvent[] = [];
    for (const char of text) {
      const { keycode, shift } = KEY_MAP[char];
      const key = { key: { keycode } };
      const shiftKey = { key: { keycode: HID_KEY_SHIFT } };
      if (shift) events.push(press(shiftKey, HIDEvent_HIDDirection.DOWN));
      events.push(press(key, HIDEvent_HIDDirection.DOWN));
      events.push(press(key, HIDEvent_HIDDirection.UP));
      if (shift) events.push(press(shiftKey, HIDEvent_HIDDirection.UP));
    }
    await this.sendHidEvents(events);
  }

  /** Streams HID events and resolves once the companion acknowledges them. */
  async sendHidEvents(events: HIDEvent[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const call = this.client.hid(deadline(INPUT_TIMEOUT_MS), (err) =>
        err ? reject(this.toIdbError(err)) : resolve()
      );
      call.on("error", (err) => reject(this.toIdbError(err)));
      for (const event of events) call.write(event);
      call.end();
    });
  }

  close(): void {
    this.client.close();
  }

  /** Bridges a callback-style unary call into a promise with a useful error. */
  private unary<T>(
    invoke: (cb: (err: grpc.ServiceError | null, value?: T) => void) => void
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      invoke((err, value) => {
        if (err) reject(this.toIdbError(err));
        else resolve(value as T);
      });
    });
  }

  private toIdbError(err: grpc.ServiceError | Error): IdbError {
    const serviceError = err as grpc.ServiceError;
    if (serviceError.code === undefined) {
      return new IdbError(err.message);
    }
    return new IdbError(
      `${grpc.status[serviceError.code]}: ${serviceError.details || err.message}`,
      serviceError.code,
      serviceError.details
    );
  }
}

/** Wraps a press action in a HIDEvent, since every key and touch needs both. */
function press(
  action: {
    touch?: { point: { x: number; y: number } };
    key?: { keycode: number };
    button?: { button: HIDEvent_HIDButtonType };
  },
  direction: HIDEvent_HIDDirection
): HIDEvent {
  return HIDEvent.fromPartial({ press: { action, direction } });
}
