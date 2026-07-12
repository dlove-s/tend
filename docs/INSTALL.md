# Install

## Requirements

### Packaged Release

- A Claude Code session for the intended in-app-browser preview and feed-lane workflow
- A Tend archive matching your platform
- Any connectors (MCP or otherwise) used by your feeds

The packaged `tend` executable is self-contained and includes the Bun runtime. Bun, Node.js, and
pnpm are not required to run a downloaded release.

### Source And Binary Builds

- Git
- Bun 1.3.11 or newer
- Node.js 22 or newer
- pnpm 9.15.4

```sh
bun --version
node --version
corepack enable
corepack prepare pnpm@9.15.4 --activate
```

## From Source

```sh
pnpm install
pnpm start
```

Open:

```text
http://127.0.0.1:4321
```

Open this URL in a Claude Code session's in-app browser preview. Tend's intended first-run flow keeps
the feed UI beside the Claude session that operates it.

The local API listens on:

```text
http://127.0.0.1:4332
```

## Build A Bun Binary

```sh
pnpm build
pnpm tend:build
pnpm tend:smoke
./dist-bin/tend version
./dist-bin/tend start
```

The binary starts the local app in the background and serves built UI assets and API from
`http://127.0.0.1:4332`.

```sh
./dist-bin/tend health
./dist-bin/tend logs
./dist-bin/tend restart
./dist-bin/tend stop
```

Use `./dist-bin/tend start --foreground` when you want the server attached to the current
terminal.

Package the current platform binary for local distribution:

```sh
pnpm tend:package
```

The package command writes `dist-bin/releases/tend-<version>-<platform>-<arch>.tar.gz` plus a
`.sha256` checksum. The archive contains the `tend` executable, the Tend manual, built `dist/` UI
assets, README, license, contributor notes, all public
install/architecture/agent/data/development/iPhone/security/releasing docs, the changelog, and
operator/capability references.
The packaged executable resolves UI assets from the sibling `dist/` directory, so it can be launched
from inside the extracted folder or by absolute path from another working directory.

Release binaries are not Apple Developer ID signed or notarized yet. On macOS, Gatekeeper may show a
first-run warning for downloaded archives. You can still run Tend by opening the binary
explicitly from Finder or by removing the quarantine attribute:

```sh
xattr -d com.apple.quarantine ./tend
./tend start
```

## Claude Setup

Tend is Claude-native: the default lane wakes a Claude Code session to drain queued work. Create or
choose a feed in Tend, keep it open in a Claude session's in-app browser preview, then arm that same
session for the feed. Do not share one session across multiple feeds.

```sh
pnpm tend -- setup claude --feed <feed-id>
```

Paste the complete output into that Claude session. It binds the feed's Claude lane (the server mints
the lane id), routes the feed's drain agent to Claude, and points the session at the `/tend` skill to
register presence and start the wake monitor so queued work activates the session without polling.

You can also just run the `/tend` skill in the session that has the feed open — it arms presence and
the wake monitor directly.

To run the feed manually later, open or wake that same session and say:

```text
go deal with the feed
```

Use the manual wake whenever you want an immediate sweep, or after a session has been closed and
reopened.

See [`docs/CLAUDE_THREAD.md`](./CLAUDE_THREAD.md) for the full Claude lane operating contract.

### Alternative: Codex lane

Tend still supports a Codex feed thread as an additional drain lane. To bind one, start a fresh Codex
Desktop thread for the feed and paste the output of:

```sh
pnpm tend -- setup codex --feed <feed-id>
```

It binds the thread, installs one heartbeat, and handles the feed once. See [`AGENTS.md`](../AGENTS.md)
for the Codex feed-thread protocol. A feed can be routed between lanes with
`pnpm tend -- cli feed:drain-agent --feed <feed-id> --agent <codex|claude>`.

## Health Check

```sh
pnpm tend -- version
pnpm tend -- start
pnpm tend -- health
pnpm tend -- doctor
pnpm tend -- status
```

`version` prints the app version and CLI contract version. `doctor` checks local storage immediately.
It also calls the running local API at `/api/status`, so run `tend start` first when you want
the full server, version contract, and API readiness check to be green.

## Backup And Restore

```sh
pnpm tend -- backup export ./tend-backup
pnpm tend -- stop
pnpm tend -- backup import ./tend-backup
```

Backups include a consistent SQLite snapshot, the readable `data/` mirrors, and a manifest. Export
requires a destination that does not already exist. Import stages and validates the backup before
swapping data, preserves the previous runtime until the swap succeeds, and refuses to run while the
same Tend home is active. Legacy data-directory-only backups can still be imported.

## iPhone Companion

The optional native client additionally requires a Mac, a private Supabase project, Xcode,
XcodeGen, an Apple Account configured in Xcode, and an iOS 17 device or simulator. A paid Apple
Developer Program membership is needed only for TestFlight or App Store distribution. See
[`docs/IOS.md`](./IOS.md) for the complete requirements, magic-link, worker, signing, installation,
and validation guide.
