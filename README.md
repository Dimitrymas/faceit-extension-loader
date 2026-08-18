# FACEIT Extension Loader

[![CI](https://github.com/Dimitrymas/faceit-extension-loader/actions/workflows/ci.yml/badge.svg)](https://github.com/Dimitrymas/faceit-extension-loader/actions/workflows/ci.yml)
[![Development build](https://img.shields.io/badge/release-dev--latest-orange)](https://github.com/Dimitrymas/faceit-extension-loader/releases/tag/dev-latest)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

An experimental extension loader and mod manager for the official FACEIT desktop client. The project distributes a small patcher, not FACEIT itself or a modified copy of its client.

The patch changes one field inside `resources/app.asar/package.json`:

```json
{
  "main": "mod/bootstrap.js"
}
```

`mod/bootstrap.js` wraps `app.whenReady()` so its extension setup resolves before the original client's ready handlers, then immediately requires the original `main.js`. The native overlay and anti-cheat-adjacent files are outside this project boundary and are not modified.

## Current Scope

Implemented:

- Finds the newest `app-*` directory under a FACEIT Squirrel install root.
- Creates `resources/app.asar.orig` plus a SHA-256 integrity record before the first write.
- Replaces a patched ASAR only after the staged archive can be read successfully.
- Hooks Electron's Squirrel `update-downloaded` event and reapplies the patch to the newly installed `app-*` before FACEIT restarts, without a service, watcher, or resident launcher.
- Restores every retained Squirrel app version that has a verified backup.
- Extracts and repacks `app.asar` with `.node`, `.dll`, and `.exe` kept unpacked.
- Adds `mod/bootstrap.js` and runtime dependencies for `electron-chrome-extensions`.
- Loads unpacked extensions listed in an `installed.json` registry on every start.
- Tracks FACEIT `BrowserWindow` instances as `chrome.tabs` targets where possible.
- Adds a compact bottom-right dock over the extension-launcher area of FACEIT's visible right sidebar while keeping it outside React's managed tree.
- Keeps extension action icons in a vertically scrollable dock above the Mods button.
- Mirrors a catalogued extension's existing page launcher into the dock while preserving an invisible anchor in its original DOM context, avoiding duplicates without breaking extension-positioned popups.
- Opens a compact, content-sized manager popover directly to the left of the right sidebar.
- Installs any valid Chrome Web Store extension from its Store URL or 32-character extension ID.
- Downloads CRX packages from the Chrome Web Store, validates their headers, and extracts them with path, symlink, file-count, and size protections.
- Installs marketplace mods into managed storage with rollback if the new version cannot be loaded.
- Adds, enables, disables, reloads, and removes unpacked extensions from the in-client manager.
- Deletes managed marketplace packages on removal while keeping external unpacked source folders intact.
- Embeds extension action popups inside FACEIT at the bottom-right, auto-sizes them to their content, and keeps them inside the viewport; full options pages remain separate resizable windows.
- Bridges `runtime`, `storage.local`, and local-backed `storage.sync` into MV3 `MAIN`-world scripts before extension code starts.
- Registers confirmed `faceit-mods://install/<catalog-id>` installation links on Windows.
- Keeps diagnostics, local folder loading, and data-folder access under Settings.
- Bundles the browser-action preload next to the patch so FACEIT sandboxed pages do not need to resolve npm modules.
- Grants only known FACEIT origins (`https://www.faceit.com/*`, `https://api.faceit.com/*`, `https://open.faceit.com/*`) for loaded extensions.
- Keeps the legacy Windows Repeek helper as an offline recovery path.
- Builds a native current-user Windows Setup executable with install/update, restore, launch, and open-folder actions.
- Provides `inspect` and `restore` commands.

The Windows beta has validated content scripts and FACEIT-focused extensions such as Repeek in the live client.

## Legal / Product Boundary

This project is unofficial and is not affiliated with, endorsed by, or supported by FACEIT. [FACEIT's terms](https://www.faceit.com/en/terms) restrict unauthorized software and extensions that alter or interfere with its services. Obtain written permission before broad distribution or promotion, and never use this project or an extension to gain a gameplay advantage, bypass monetization, evade enforcement, or interact with FACEIT Anti-Cheat.

The project boundary excludes `build/`, `modules/overlay/`, `app.asar.unpacked`, driver-facing code, the native overlay, and FACEIT Anti-Cheat. Do not ship copied Chrome Web Store packages or FACEIT-owned assets.

Because `electron-chrome-extensions` is GPL-3 licensed unless a separate patron license is obtained, this project is marked `GPL-3.0-only`.

## Install From Source

```bash
npm install
```

For Windows testing, download the newest prerelease installer from [GitHub Releases](https://github.com/Dimitrymas/faceit-extension-loader/releases). The installer is current-user scoped, does not request administrator rights, and includes a `Restore FACEIT` action.

## Build Windows Setup

The release build produces one self-contained current-user x64 Windows GUI installer under 2 MB. It requests no administrator privileges and needs no network download: patch and restore commands run through the Node runtime already embedded in the installed FACEIT Electron executable.

This path is verified with FACEIT 2.9.0 (Electron 43.4.0). The separate portable package remains a fallback if a future FACEIT release disables Electron's `runAsNode` capability.

```bash
npm run build:win-installer
```

Output:

```text
dist/FACEIT-Mods-Setup-<version>-x64.exe
dist/FACEIT-Mods-Setup-<version>-x64.exe.sha256
```

Development executables are unsigned. A promoted release should be Authenticode-signed and timestamped with the same publisher identity on every release; signing does not replace FACEIT permission or guarantee immediate Microsoft SmartScreen reputation.

## Patch a FACEIT Install

On Windows, with the standard Squirrel layout:

```powershell
node .\bin\faceit-extension-loader.js patch "$env:LOCALAPPDATA\FACEIT"
```

You can also pass a specific `app-*` directory, `resources` directory, or `app.asar` path:

```powershell
node .\bin\faceit-extension-loader.js patch "$env:LOCALAPPDATA\FACEIT\app-2.9.0"
node .\bin\faceit-extension-loader.js inspect "$env:LOCALAPPDATA\FACEIT"
node .\bin\faceit-extension-loader.js restore "$env:LOCALAPPDATA\FACEIT"
```

The patch is idempotent. Installs made with the native Setup or portable fallback keep a small payload under `%LOCALAPPDATA%\FACEIT Mods\current`. While a patched FACEIT process is running, its `update-downloaded` event synchronously patches the newest Squirrel `app-*` before the client's own update handlers continue. If FACEIT is replaced by a separate installer while the client is not running, run Setup once to repair it.

## Load One Unpacked Extension for the Spike

For the first test, use an already-unpacked extension directory containing `manifest.json`.

Create a registry JSON:

```json
{
  "version": 1,
  "extensions": [
    {
      "path": "C:\\Users\\you\\Desktop\\repeek-unpacked",
      "enabled": true
    }
  ]
}
```

Then launch FACEIT from the same shell with the registry override:

```powershell
$env:FACEIT_EXTENSION_REGISTRY = "C:\Users\you\Desktop\faceit-extensions.json"
& "$env:LOCALAPPDATA\FACEIT\app-2.9.0\FACEIT.exe" --remote-debugging-port=9222
```

Logs are written to:

```text
%APPDATA%\FACEIT\extension-loader\loader.log
```

If `FACEIT_EXTENSION_REGISTRY` is not set, the loader creates an empty registry under the app `userData` directory.

## FACEIT Mods

The patch installs a session preload that selects the visible FACEIT right sidebar by geometry instead of taking the first matching responsive copy. It anchors a loader-owned dock near the bottom-right extension area. The Mods button occupies the lower slot; action icons for loaded extensions stack above it and scroll when needed. When catalog metadata declares an extension-owned page launcher, the dock renders a visual proxy and leaves the original element as an invisible anchor in its native DOM context. Clicking the proxy invokes the original handler, so extension popups still choose their intended placement mode. The dock remains under `document.body`, so React cannot delete or reorder it. If no visible right sidebar exists, the dock stays hidden rather than appearing elsewhere on the page.

`Mods` opens a small popover immediately to the left of the native sidebar. `Extensions` is the default view: click an extension row to open its action in a browser-style popup at the bottom-right, or use its enable, options, reload, and remove controls. The popup closes through the extension's own close control, `Escape`, or a click outside it; full options pages use normal windows. `Add` accepts a Chrome Web Store URL or extension ID and downloads the CRX directly from Google's update service. Settings contains diagnostics and the developer-only unpacked-folder picker. Registry changes are applied live where Electron supports it; the manager offers a FACEIT page refresh when content scripts need a fresh document.

The bundled metadata catalog currently recognizes Repeek, FACEIT Forecast, PeekStats, and Heatcheck for names, icons, update checks, and confirmed install links. It does not limit manual Chrome Web Store installation.

## Install Links

After the patched FACEIT client has started once on Windows, websites can open a reviewed catalog listing with:

```text
faceit-mods://install/repeek
```

For example:

```html
<a href="faceit-mods://install/repeek">Install Repeek in FACEIT Mods</a>
```

The link only selects an entry already present in `mod/marketplace.json`. FACEIT Mods opens a review screen with the package author, compatibility status, and declared access; the user must confirm before anything is downloaded. Deep links cannot supply arbitrary package URLs or unknown ids. Manual installation in `Add` separately accepts valid Chrome Web Store links and extension IDs. Restoring FACEIT with the portable rollback script removes the current-user protocol registration.

## Legacy Repeek Recovery

Repeek's Chrome Web Store id is:

```text
mokknliiomknodkdmpcellamkopbdmao
```

Normal installation is now `Mods` -> `Add` -> paste the Repeek Chrome Web Store link or ID -> `Install`. The Windows portable package still includes `5-install-repeek-webstore.bat` as a recovery path.

`6-enable-repeek-from-browser.bat` remains as a fallback if the Web Store endpoint is unavailable. It looks for an already-installed Repeek copy in Chrome, Edge, Brave, or Opera profiles and writes that unpacked path to the same registry.

## Verify Locally

The test creates fake FACEIT Squirrel directories and a fake `app.asar`, applies the patch, verifies idempotency, and checks that native `.node` files remain marked as unpacked:

```bash
npm test
```

`npm run clean` removes generated `dist`, `tmp`, and coverage artifacts. Both Windows build scripts remove their temporary staging directories after producing their final files.

## Branches And Releases

- `main` contains reviewed release candidates and stable releases.
- `dev` is the integration branch. Every push runs the full test/build pipeline and replaces the `dev-latest` prerelease.
- Tags matching the package version, such as `v0.3.0-beta.21` or `v0.3.0`, produce immutable versioned GitHub Releases.
- Pull requests into `main` must pass the `test-and-build` status check.

## Windows Spike Checklist

1. Download and install the official FACEIT client.
2. Run `node .\bin\faceit-extension-loader.js patch "$env:LOCALAPPDATA\FACEIT"`.
3. Prepare one unpacked extension whose content scripts match `*://*.faceit.com/*`.
4. Launch `FACEIT.exe` with `FACEIT_EXTENSION_REGISTRY` and `--remote-debugging-port=9222`.
5. Open DevTools through the remote debugging endpoint and confirm:
   - `loader.log` says the extension loaded.
   - The extension appears in `session.defaultSession.extensions.getAllExtensions()` if evaluated in the main process.
   - Its content script runs on the live FACEIT page.
   - No preload, CSP, service worker, or sandbox errors appear.
6. Restore with `node .\bin\faceit-extension-loader.js restore "$env:LOCALAPPDATA\FACEIT"` when done.
