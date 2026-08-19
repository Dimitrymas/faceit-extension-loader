# AddonPort for FACEIT

[![CI](https://github.com/AddonPort/faceit/actions/workflows/ci.yml/badge.svg)](https://github.com/AddonPort/faceit/actions/workflows/ci.yml)
[![Development build](https://img.shields.io/badge/release-dev--latest-orange)](https://github.com/AddonPort/faceit/releases/tag/dev-latest)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

Install and manage compatible Chrome extensions inside the FACEIT desktop client. This repository
contains the FACEIT adapter for the open [AddonPort](https://addonport.dev) protocol.

> [!WARNING]
> This is an unofficial beta. It is not affiliated with or endorsed by FACEIT. The loader modifies the desktop client's `app.asar`; review the [project boundary](#project-boundary) and keep the restore option available.

## Install

1. Install the official FACEIT desktop client and close it.
2. Download the latest `AddonPort-for-FACEIT-Setup-*-x64.exe` from [GitHub Releases](https://github.com/AddonPort/faceit/releases).
3. Run Setup and select **Install**.
4. Start FACEIT normally and open **AddonPort** from the bottom of the right sidebar.

Setup installs only for the current Windows user and does not request administrator access. Prerelease builds are currently unsigned, so Windows may show an unknown-publisher warning. Verify the downloaded file against the accompanying `.sha256` file before running it.

Running a newer Setup shows **Update**. Running the same version shows **Repair**. Both preserve installed extensions and their settings.

## Use

The in-client manager provides three main workflows:

- **Extensions** opens extension actions and provides enable, disable, reload, options, shortcut, and remove controls.
- **Add** installs from a Chrome Web Store URL or 32-character extension ID.
- **Settings** exposes diagnostics, the loader data folder, manager shortcuts, and unpacked-folder loading for development.

Extension action popups open inside the FACEIT window and stay within the visible viewport. Full extension options pages use separate windows. Some extension changes require a FACEIT page refresh before content scripts can run in the current document.

The bundled catalog currently contains compatibility metadata for Repeek, FACEIT Forecast, and
PeekStats. The catalog improves names, icons, update checks, and install review; it does not restrict
manual Chrome Web Store installation.

## Install Links

Websites, desktop applications, and shortcuts can open AddonPort directly:

```text
addonport://open
addonport://install/<catalog-id>
addonport://install/<chrome-extension-id>
addonport://launch/<catalog-id-or-extension-id>
```

Every install link opens a confirmation screen before downloading. Known catalog entries include reviewed metadata. Direct Chrome Web Store IDs are clearly marked as not reviewed in the catalog.

Interactive websites should use the AddonPort SDK and connect-session flow instead of guessing
whether a protocol handler opened. Static `faceit-mods://` links remain supported for migration.
See [Third-party integration](docs/INTEGRATION.md) for the full contract.

## Compatibility

| Component | Current beta status |
| --- | --- |
| Windows | Windows 10/11 x64, current-user install |
| FACEIT desktop | Verified with FACEIT 2.9.0 |
| Electron runtime | Verified with Electron 43.4.0 |
| Chrome extensions | Manifest V2/V3 support varies by API usage |

Implemented compatibility includes browser actions, content scripts, extension pages, `runtime`, `storage.local`, and local-backed `storage.sync`. The loader grants extension access only to supported FACEIT origins. Chrome APIs that depend on a full browser profile, Chrome account, native messaging host, or unsupported Electron surface may not work.

Use the [extension compatibility issue form](https://github.com/AddonPort/faceit/issues/new?template=extension.yml) for reproducible compatibility problems.

## Restore

Open the same Setup and select **Restore FACEIT**. Restore:

- verifies the recorded backup before replacing `app.asar`;
- restores every patched FACEIT `app-*` version that still has a valid backup;
- removes the `addonport://` and legacy `faceit-mods://` registrations and installed-version markers;
- leaves extension data in place in case the loader is installed again.

The patcher creates `app.asar.orig` and a SHA-256 record before its first write. It stages and validates a replacement archive before swapping it into place.

## Updates

The loader does not install a background service, watcher, or resident launcher. While FACEIT is running, it listens for Electron's `update-downloaded` event and patches the newly installed Squirrel `app-*` directory before the client restarts. If FACEIT is replaced while it is not running, run Setup again and select **Repair**.

## Files And Diagnostics

| Data | Location |
| --- | --- |
| Stable adapter payload | `%LOCALAPPDATA%\FACEIT Mods\current` (legacy path) |
| Installed-version marker | `%LOCALAPPDATA%\FACEIT Mods\installed.marker` (legacy path) |
| Extension registry and managed packages | `%APPDATA%\FACEIT\extension-loader` |
| Runtime log | `%APPDATA%\FACEIT\extension-loader\loader.log` |
| Setup log | `%LOCALAPPDATA%\FACEIT Mods\current\setup.log` |

The manager can copy a sanitized diagnostics report. Review it before posting because local paths can contain a Windows username.

## Development

Requirements:

- Node.js 20 or newer;
- npm;
- MinGW-w64 when building Windows Setup outside CI.

```bash
npm ci
npm test
npm run build:win-installer
```

The Windows build produces:

```text
dist/AddonPort-for-FACEIT-Setup-<version>-x64.exe
dist/AddonPort-for-FACEIT-Setup-<version>-x64.exe.sha256
```

For direct patcher development:

```powershell
node .\bin\faceit-extension-loader.js inspect "$env:LOCALAPPDATA\FACEIT"
node .\bin\faceit-extension-loader.js patch "$env:LOCALAPPDATA\FACEIT"
node .\bin\faceit-extension-loader.js restore "$env:LOCALAPPDATA\FACEIT"
```

See [Architecture](docs/ARCHITECTURE.md), [Code signing](docs/CODE_SIGNING.md),
[Contributing](CONTRIBUTING.md), and the [Changelog](CHANGELOG.md) before changing patch, update, or
release behavior.

## Project Boundary

The loader changes the Electron web-client archive only. It does not modify or interact with FACEIT Anti-Cheat, drivers, gameplay processes, the native overlay, enforcement systems, or FACEIT-owned services outside the normal desktop web client.

Do not use this project or an installed extension to gain a gameplay advantage, bypass monetization, evade enforcement, or interfere with FACEIT Anti-Cheat. Do not redistribute FACEIT binaries, patched FACEIT archives, Chrome Web Store packages, or FACEIT-owned assets.

Review [FACEIT's terms](https://www.faceit.com/en/terms) and obtain any permission required for your intended use or distribution. Code signing identifies a publisher; it does not grant permission from FACEIT.

## License

AddonPort for FACEIT is licensed under [GPL-3.0-only](LICENSE). The framework-neutral AddonPort SDK
and protocol are maintained separately under MIT. See [Third-Party Notices](THIRD_PARTY_NOTICES.md)
for bundled dependencies and their licenses.
