# Release Scripts

This folder contains the packaging helpers for Reina desktop releases.

## Windows

Use `package-release.cmd` on Windows. It runs from the project root even though
the script lives in `scripts/`.

```cmd
scripts\package-release.cmd
```

Default target:

```text
win-all
```

Supported targets:

```cmd
scripts\package-release.cmd win
scripts\package-release.cmd win-portable
scripts\package-release.cmd win-all
```

Output:

```text
release/Reina-<version>-win-x64.exe
```

## macOS

Use `package-mac.sh` on macOS. macOS packages must be built on macOS because
Electron and `node-pty` need platform-native binaries.

```bash
./scripts/package-mac.sh
```

Common options:

```bash
./scripts/package-mac.sh --arch=arm64
./scripts/package-mac.sh --arch=x64
./scripts/package-mac.sh --arch=universal
./scripts/package-mac.sh --dmg-only
./scripts/package-mac.sh --zip-only
```

Output:

```text
release/Reina-<version>-mac-<arch>.{dmg,zip}
```

## Node Wrapper

`package-release.mjs` is the shared release wrapper used by npm scripts.

```bash
npm run package:release -- --target=win
npm run package:release -- --target=win-portable
npm run package:release -- --target=win-all
npm run package:release -- --target=mac
npm run package:release -- --target=all
```

Platform rules:

- Windows packages should be built on Windows.
- macOS packages should be built on macOS.
- `all` skips targets that cannot be built on the current platform.

## Build Notes

Packaging runs `npm run build:desktop` first. That build:

- compiles TypeScript,
- builds the agent host,
- builds the Electron main/preload bundles,
- copies renderer assets into `dist/apps/desktop/renderer`.

Packaged apps load renderer files from `dist/apps/desktop/renderer`, not from
`apps/desktop/src/renderer`.

Release byproducts such as unpacked directories, blockmaps, and builder debug
files are cleaned by the release wrappers where possible.
