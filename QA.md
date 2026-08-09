# Quality Assurance

This guide contains manual quality assurance tests to make sure all the tools in this MCP server is functional on release.

You can run a test case copy and pasting the test case into a chat in an MCP client (like Cursor) that can run MCP tools.

## Test Case: Photos app

**Note:** This test case was written using iOS 17.2 and the native Photos app. It may need to be adjusted for other iOS versions or Photos app changes.

1. Call `start_simulator` to create and boot a new simulator, with an appropriate `id`.
2. Wait 30 seconds for boot, then use `ui_view` and `ui_tap` to open the Photos app.
3. Call `record_video` to start recording a screen recording of the test.
4. Call `ui_describe_all` to make sure we are on the All Photos tab.
5. Call `ui_describe_point` to find the x and y coordinates for tapping the Search tab button.
6. Call `ui_tap` to tap the Search tab button.
7. Call `ui_tap` to focus on the Search text input.
8. Call `ui_type` to type "Photos" into the Search text input.
9. Call `ui_describe_all` to describe the page and find the first photo result.
10. Call `ui_describe_point` to find the x and y coordinates for the first photo result touchable area.
11. Call `ui_tap` to tap the coordinates of the first photo result touchable area
12. Call `ui_swipe` to swipe from the center of the screen down to dismiss the photo and go back to the All Photos tab.
13. Call `ui_describe_all` to describe the page and see we are the All Photos tab.
14. Call `screenshot` to take a screenshot of the current page.
15. Call `ui_view` to view the current page.
16. Call `stop_recording` to stop the screen recording.

## Multi-Agent / HTTP Transport Test Cases

These tests validate the shared-server HTTP transport, which lets multiple
agents each drive their own simulator against one long-lived server, and lets an
agent disconnect and later resume using the same session `id`.

### Setup: start the shared server

1. In a terminal, start one long-lived server in HTTP mode:
   ```bash
   node build/index.js --http --port 8008
   ```
   Confirm it logs `iOS Simulator MCP server listening on http://127.0.0.1:8008/mcp`.
2. Point one or more MCP clients at it as a remote server (do **not** use the
   `command`/`args` stdio form):
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

### Test Case: Two agents, two simulators, one server

Run these two clients against the **same** server started above. Use two
separate MCP client windows/instances (e.g. two Cursor windows or two Claude
sessions).

1. In client A, call `start_simulator` with `id: "agent-a"` and `type: "iPhone"`.
   Confirm it returns `Simulator started: ...`.
2. In client B, call `start_simulator` with `id: "agent-b"` and `type: "iPad"`.
   Confirm it returns a **different** simulator (different UDID, iPad device).
3. Confirm two separate simulator windows are open.
4. In client A, call `ui_describe_all` with `id: "agent-a"` and confirm it
   describes the iPhone. In client B, call `ui_describe_all` with `id: "agent-b"`
   and confirm it describes the iPad. The two must not interfere.
5. In client A, call `ui_describe_all` with `id: "agent-b"` — confirm A can also
   reach B's session (state is shared in the one server). *(This shared access is
   expected; there is no isolation between sessions yet — see the security note
   in the README.)*
6. In each client, call `destroy_simulator` with its own `id`. Confirm each
   simulator is shut down and deleted independently.

### Test Case: Disconnect and reconnect (resume)

1. Start the shared server in HTTP mode (see Setup).
2. In a client, call `start_simulator` with `id: "resume-test"`. Note the UDID
   returned. Navigate somewhere non-default (e.g. open an app with `launch_app`).
3. Fully quit/close the MCP client (simulating an agent terminating). Leave the
   **server** running.
4. Reopen the client (or start a fresh one) pointed at the same server URL.
5. Call `start_simulator` again with the **same** `id: "resume-test"`. Confirm it
   returns `Resumed existing simulator for session "resume-test": ...` with the
   **same UDID** as step 2 — it must not create a new simulator.
6. Call `ui_describe_all` with `id: "resume-test"` and confirm the app/state from
   step 2 is still there.
7. Call `destroy_simulator` to clean up.

### Test Case: Config precedence and cleanup-on-exit

1. **CLI flag wins over env var:** run
   `IOS_SIMULATOR_MCP_TRANSPORT=stdio node build/index.js --http --port 8009`.
   Confirm it starts in **HTTP** mode (logs the listening URL) despite the env
   var saying stdio.
2. **Cleanup on exit (default):** with a server running in HTTP mode, call
   `start_simulator` with `id: "cleanup-test"`. Stop the server with Ctrl-C.
   Confirm the owned simulator is shut down and deleted (check `xcrun simctl
   list devices` — it should be gone).
3. **Cleanup disabled:** run
   `IOS_SIMULATOR_MCP_CLEANUP_ON_EXIT=false node build/index.js --http`, call
   `start_simulator` with `id: "keep-test"`, then stop the server with Ctrl-C.
   Confirm the simulator is **still present and booted** (`xcrun simctl list
   devices`). Manually delete it afterwards with `xcrun simctl delete <udid>`.

### Test Case: stdio mode still works (backward compatibility)

1. Configure a client with the original stdio form (`command` / `args`, no
   `--http` flag and no `IOS_SIMULATOR_MCP_TRANSPORT` env var).
2. Call `start_simulator`, `ui_describe_all`, and `destroy_simulator` and confirm
   they all work exactly as before.
