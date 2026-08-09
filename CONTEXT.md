# Context

This document is a collection of relevant references to use as context (for humans and LLMs) for working on this project.

- [MCP Docs - Server Features - Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
  - [LLM optimized page](https://modelcontextprotocol.io/specification/2025-06-18/server/tools.md)
- [iOS Simulator from the Command Line](https://suelan.github.io/2020/02/05/iOS-Simulator-from-the-Command-Line/)
- [idb Commands](https://fbidb.io/docs/commands) — the CLI this server no longer uses, still useful for understanding the companion's capabilities
  - [LLM optimized page](https://raw.githubusercontent.com/facebook/idb/refs/heads/main/website/docs/commands.mdx)
- [`idb.proto`](https://github.com/facebook/idb/blob/main/proto/idb.proto) — the actual contract this server speaks. Vendored at `proto/idb.proto`; `CompanionService` is the service, and the accessibility, HID and screenshot messages are the ones in use.
- [idb `CompanionDiscovery/`](https://github.com/facebook/idb/tree/main/CompanionDiscovery) — upstream's own Swift implementation of companion spawn/registry/lifecycle, the reference for `src/idb/companionManager.ts`
- [gRPC for Node.js (`@grpc/grpc-js`)](https://grpc.io/docs/languages/node/basics/)
- [sips man page for image compression](https://ss64.com/mac/sips.html)
- [Claude Vision docs](https://docs.anthropic.com/en/docs/build-with-claude/vision)
  - [LLM optimized page](https://docs.anthropic.com/en/docs/build-with-claude/vision.md)
- [An Introduction to Command Injection Vulnerabilities in Node.js and JavaScript](https://www.nodejs-security.com/blog/introduction-command-injection-vulnerabilities-nodejs-javascript)
