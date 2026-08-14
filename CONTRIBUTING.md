# Contributing to iOS Multi Simulator MCP

**Important Note**:
This is a fork of the original [joshuayoes/ios-simulator-mcp](https://github.com/joshuayoes/ios-simulator-mcp) MCP. The changes this fork makes are fundamentally different to Joshua's intent, so I chose to fork as Open Source ecology intended. If you wish to contribute to this project that is wonderful, but I highly encourage you to see if your contributions can also benefit the original project too. 

## Project Philosophy

This project is **intentionally simple** and follows these core principles:

### Simplicity First

- **Single file architecture**: All logic is contained in `src/index.ts` to simplify bundling and maintenance
- **Minimal dependencies**: We keep dependencies minimal to ensure fast installs and small footprint on user machines
- **Standard tooling**: We use `npm` (universally available) and `tsc` (simple, already available) for building

### Real Use Cases Only

- New tools should be driven by **real use cases**, not hypothetical situations
- We are **not trying to include every possible tool** - additional tools can pollute context windows and confuse AI agents
- The original use case: Give AI editors the ability to interact with iOS simulators like a user, similar to [playwright-mcp](https://github.com/microsoft/playwright-mcp) for browsers
- This enables autonomous agent loops where AI can validate its own work in the iOS simulator

### Architectural Stability

If you want to make significant changes to this fork then I'd suggest talking to the author first, however you could equally just fork your own too ;).

## Prerequisites

Before contributing, ensure you have:

- **macOS on Apple Silicon** (iOS simulators only work on macOS, and the companion build output is arm64 only)
- **Node.js** installed
- **Xcode** and iOS simulators installed
- An **MCP client** (like Cursor) for testing

You do not install `idb_companion` — the server resolves it itself (env var, then a local build of the vendored submodule, then a pinned download). No Python `fb-idb` and no `brew install idb-companion`; this server talks to the companion directly over gRPC. See [How `idb_companion` is obtained](README.md#how-idb_companion-is-obtained) for the full precedence order, and [Building the companion](#building-the-companion) below if you want the developer path.

For additional context and references, see [CONTEXT.md](CONTEXT.md) which contains helpful links for MCP development, iOS simulator commands, and security considerations.

## Development Setup

1. **Fork and clone the repository**

   idb is vendored as a git submodule at `vendor/idb`, pinned to a specific
   sha, so clone recursively:

   ```bash
   git clone --recurse-submodules https://github.com/your-username/ios-simulator-mcp.git
   cd ios-simulator-mcp
   ```

   If you already cloned without it, run `git submodule update --init`.

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Build the project**

   ```bash
   npm run build
   ```

4. **Test during development**

   ```bash
   # Watch mode for development
   npm run watch

   # Test with MCP inspector
   npm run dev
   ```

## The vendored idb submodule

`vendor/idb` is [facebook/idb](https://github.com/facebook/idb) pinned to a
specific sha. It is the source of two things: the `idb_companion` binary the
server talks to, and the generated gRPC client and keymap under `src/idb/`.

### Bumping to a newer idb

```bash
cd vendor/idb && git fetch && git checkout <sha> && cd ../..
npm run gen                       # regenerate the client and keymap
git commit -am "build: bump idb to <sha>"
git push
```

Pushing a moved submodule pointer is what triggers the companion build in CI.
It builds, smoke tests the artifact, publishes a release and produces a new
`companion.lock.json` — commit that lock file to point the server at the new
companion.

The build only runs when the idb pin or `.xcode-version` actually changes.
Ordinary pushes, and merges that carry an unchanged submodule pointer, skip it:
a macOS runner costs 10x minutes and a rebuild of the same commit produces a
byte-identical artifact. Use the workflow's **force** input to build anyway.

Check `vendor/idb/REPL/IDB/IDBAPI.swiftinterface` after a bump — its
`swift-compiler-version` line is upstream's own toolchain stamp, and
`.xcode-version` must agree with it. CI asserts this, because a mismatch does
not produce a compiler error, it produces a crash with no diagnostic at all.

### Building the companion

You do not need to build anything to run the server — it will download the
companion pinned in `companion.lock.json`. Build locally when you are working on
companion behaviour itself, or bumping the submodule. A build at
`vendor/idb/Build/Distribution/idb_companion` is picked up automatically, ahead
of the download.

**Xcode 26.6 exactly** is required, pinned in `.xcode-version`. Plus:

```bash
brew install xcodegen protobuf swift-protobuf
```

Then:

```bash
cd vendor/idb && ./build.sh build
```

It takes 20–30 minutes and produces `vendor/idb/Build/Distribution/`. The output
is **arm64 only**.

The version pin is not decoration: a mismatched Swift toolchain does not give
you a build error, it crashes the compiler with a bare stack dump and no message
about what is wrong. If that happens, check your Xcode version first.

### Regenerating the client (`npm run gen`)

```bash
npm run gen
```

This regenerates the gRPC client and the keymap from the submodule
(`gen:proto` + `gen:keymap`). The output is checked in, so only maintainers
bumping the submodule sha need to run it. Never hand-edit the generated files.

## Dependency Management & Upgrades

To maintain maximum compatibility with the MCP ecosystem, we align our dependencies with those used by `@modelcontextprotocol/sdk`. This ensures seamless integration and reduces potential conflicts.

### Current Dependency Strategy

- **`@modelcontextprotocol/sdk`**: Always use the latest stable version
- **`zod`**: Match the version used by `@modelcontextprotocol/sdk` (currently `^3.23.8`)
- **`typescript`**: Match the version used by `@modelcontextprotocol/sdk` (currently `^5.5.4`)
- **`@types/node`**: Match the version used by `@modelcontextprotocol/sdk` (currently `^22.0.2`)

### Checking for Updates

Before upgrading dependencies, check what versions the MCP SDK uses:

```bash
# Check MCP SDK dependencies
npm info @modelcontextprotocol/sdk dependencies

# Check MCP SDK dev dependencies
npm info @modelcontextprotocol/sdk devDependencies

# Compare with current project dependencies
npm ls --depth=0
```

### Upgrading Dependencies

1. **Check MCP SDK versions first**:

   ```bash
   npm info @modelcontextprotocol/sdk dependencies devDependencies
   ```

2. **Update package.json to match**:

   - Update `zod` to match MCP SDK version
   - Update `typescript` to match MCP SDK version
   - Update `@types/node` to match MCP SDK version
   - Keep `@modelcontextprotocol/sdk` at latest stable

3. **Install and test**:

   ```bash
   npm install
   npm run build
   npm run dev  # Test with MCP inspector
   ```

4. **Verify compatibility**:
   - Test all existing functionality
   - Run through [TESTING.md](TESTING.md), and [QA.md](QA.md) if transports or sessions are affected
   - Ensure no new TypeScript errors

### Why This Matters

- **Compatibility**: Ensures our tools work seamlessly with MCP clients
- **Stability**: Reduces version conflicts and unexpected behavior
- **Consistency**: Maintains a predictable development environment
- **Future-proofing**: Easier to adopt new MCP SDK features and fixes

### When to Deviate

Only deviate from MCP SDK dependency versions when:

- A security vulnerability requires a newer version
- A critical bug fix is only available in a newer version
- The MCP SDK explicitly supports newer versions

In such cases, document the deviation and reasoning in the pull request.

## Making Changes

### Code Style

- Follow the existing TypeScript patterns in the codebase
- Use the existing error handling patterns with `toError()` and `errorWithTroubleshooting()`
- Maintain the single-file architecture - all logic stays in `src/index.ts`

### Adding New Tools

Before adding a new tool, ask yourself:

1. **Is this driven by a real use case?** Provide specific examples of when this tool would be needed
2. **Can existing tools solve this problem?** Check if current functionality can address the need
3. **Will this add significant value without cluttering the context?** Consider the trade-off between utility and complexity

If adding a new tool:

1. Follow the existing pattern with `isToolFiltered()` check
2. Use proper Zod schemas for input validation
3. Include comprehensive error handling with troubleshooting links
4. Use the `--` separator when passing user input to commands (security best practice)
5. Add the tool to the README.md documentation

### Dependency Updates in Pull Requests

When submitting pull requests:

1. **Check dependency alignment** with MCP SDK before submitting
2. **Include dependency changes** in a separate commit when possible
3. **Document any deviations** from MCP SDK versions with clear reasoning
4. **Test thoroughly** after dependency updates to ensure compatibility

### Security Considerations

- Always use the `--` separator when passing user-provided arguments to shell commands
- Validate all inputs using Zod schemas
- Use `execFileAsync` with `shell: false` to prevent command injection
- Follow the existing patterns for UDID validation and path handling

For more security context, see the command injection resources in [CONTEXT.md](CONTEXT.md).

## Testing Requirements

Due to the nature of this project, **manual testing is required** for all changes:

### Why Manual Testing?

- Requires a real macOS device
- Needs a running iOS simulator
- Requires an MCP client with a real LLM
- Limited development budget (hobby project without sponsorship)

### Testing Process

1. **Build your changes**

   ```bash
   npm run build
   ```

2. **Configure your MCP client** (e.g., Cursor) to use your local build:

   ```json
   {
     "mcpServers": {
       "ios-simulator": {
         "command": "node",
         "args": ["/full/path/to/your/ios-simulator-mcp/build/index.js"]
       }
     }
   }
   ```

3. **Start an iOS simulator**

   ```bash
   xcrun simctl list devices
   xcrun simctl boot "iPhone 15"  # or your preferred device
   ```

4. **Test thoroughly in your MCP client**
   - Test all affected functionality
   - Test error conditions
   - Verify the tool works as expected with AI agents
   - Consider running [TESTING.md](TESTING.md) to ensure existing functionality still works, and [QA.md](QA.md) for transport or session changes

### Required Documentation for Contributions

Include in your pull request:

- **Step-by-step testing instructions**
- **Screenshots or video** of the functionality working
- **Description of the real use case** that drove this change
- **Confirmation that existing functionality still works**

## Submitting Changes

1. **Create a feature branch**

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** following the guidelines above

3. **Test thoroughly** using the manual testing process

4. **Update documentation** if needed:

   - Add new tools to README.md
   - Update any relevant documentation

5. **Submit a pull request** with:
   - Clear description of the change and motivation
   - Step-by-step testing instructions
   - Screenshots/video of manual testing
   - Confirmation of real use case

## Release Process

- Releases are managed through the GitHub releases page
- The pipeline uses standard `npm publish` commands
- Version bumping and release timing are handled by the maintainer

## Questions or Discussions

For significant changes or questions:

- Open a GitHub issue for discussion
- Reach out via DMs for architectural discussions
- Provide context about your specific use case

## Code of Conduct

- Be respectful and constructive in all interactions
- Focus on real use cases and practical solutions
- Respect the project's philosophy of intentional simplicity
- Provide thorough testing and documentation for contributions

Thank you for helping make iOS Simulator MCP better! 🚀
