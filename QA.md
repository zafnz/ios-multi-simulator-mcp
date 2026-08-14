# Quality Assurance

Release checks for the things **[TESTING.md](TESTING.md) does not cover**: transports, multiple sessions on one server, and process lifecycle.

TESTING.md exercises every tool against a single simulator. Nothing here repeats that — if a tool misbehaves, this guide will not be what catches it.

These cases need two MCP clients and a terminal, so they are run by hand.

---

## Setup: a shared server

HTTP is the default transport, so a plain start is a shared server:

```bash
node build/index.js --port 8008
```

**Expected:** logs `iOS Simulator MCP server listening on http://127.0.0.1:8008/mcp`.

Point clients at it as a remote server — **not** the `command`/`args` stdio form:

```json
{
  "mcpServers": {
    "ios-multi-simulator": {
      "type": "http",
      "url": "http://127.0.0.1:8008/mcp"
    }
  }
}
```

---

## Two agents, two simulators, one server

The reason this fork exists. Needs two separate MCP client windows against the **same** server.

1. In client A: `start_simulator` with `id: "agent-a"`, `type: "iPhone"`.
2. In client B: `start_simulator` with `id: "agent-b"`, `type: "iPad"`.

   **Expected:** a different simulator — different UDID, iPad rather than iPhone. Two simulator windows are open.
3. In A: `ui_describe_all` with `id: "agent-a"`. In B: the same with `id: "agent-b"`.

   **Expected:** each describes its own device. Neither disturbs the other.
4. In A: `ui_describe_all` with `id: "agent-b"`.

   **Expected:** it works. Sessions are not isolated from each other — one server, shared state. This is current behaviour, not a bug; see the security note in the README.
5. In each client: `destroy_simulator` with its own `id`.

   **Expected:** each simulator shuts down and is deleted independently.

## Disconnect and resume

An agent that dies mid-task should be able to pick its simulator back up.

1. In a client: `start_simulator` with `id: "resume-test"`. Note the UDID. Then `launch_app` to put it somewhere recognisable.
2. Fully quit the client. **Leave the server running.**
3. Reopen the client, or start a different one, pointed at the same URL.
4. `start_simulator` again with the same `id: "resume-test"`.

   **Expected:** `Resumed existing simulator for session "resume-test": ...`, with the **same UDID**. A new simulator here is a failure.
5. `ui_describe_all` with `id: "resume-test"`.

   **Expected:** the app from step 1 is still open.
6. `destroy_simulator` to clean up.

## Transport selection

1. **Default is HTTP:**

   ```bash
   node build/index.js
   ```

   **Expected:** logs a listening URL.
2. **`--stdio` selects stdio:**

   ```bash
   node build/index.js --stdio
   ```

   **Expected:** no listening line; the process speaks MCP on stdin/stdout. A client configured with the `command`/`args` form drives it, and `start_simulator`, `ui_describe_all` and `destroy_simulator` all behave as they do over HTTP.
3. **A flag beats the environment**, both ways:

   ```bash
   IOS_SIMULATOR_MCP_TRANSPORT=stdio node build/index.js --http --port 8009
   IOS_SIMULATOR_MCP_TRANSPORT=http  node build/index.js --stdio
   ```

   **Expected:** HTTP for the first, stdio for the second.
4. **Port is taken from `--port`, then `IOS_SIMULATOR_MCP_HTTP_PORT`, then 8008.**

## Cleanup on exit

Simulators the server created are its responsibility; ones it merely attached to are not.

1. With a server running, `start_simulator` with `id: "cleanup-test"`, then stop the server with Ctrl-C.

   **Expected:** the simulator is shut down and deleted — gone from `xcrun simctl list devices`.
2. Repeat with cleanup disabled:

   ```bash
   IOS_SIMULATOR_MCP_CLEANUP_ON_EXIT=false node build/index.js
   ```

   **Expected:** after Ctrl-C the simulator is **still present and booted**. Delete it by hand afterwards.
3. Attach to a simulator the server did not create (`attach_simulator`), then stop the server.

   **Expected:** that simulator survives, whatever the cleanup setting. The server only deletes what it owns.

## Port already in use

1. With a server running on 8008, start a second one on the same port.

   **Expected:** it exits with a message naming the port and suggesting `--port`, rather than a raw `EADDRINUSE` stack trace.
