# Architecture

This document describes the loader's technical boundaries and lifecycle. User installation instructions belong in the main [README](../README.md); external link integration belongs in [Third-party integration](INTEGRATION.md).

## Patch Lifecycle

The patcher resolves the newest FACEIT Squirrel `app-*` directory and reads `resources/app.asar`. Before the first write it creates:

- `app.asar.orig`, containing the original archive;
- a SHA-256 record used to validate restore operations.

The patch changes the Electron package entry point to `mod/bootstrap.js`. It builds and validates a staged archive before replacing the active file. Native `.node`, `.dll`, and `.exe` entries remain unpacked when the archive is rebuilt.

`mod/bootstrap.js` initializes the extension runtime, then immediately requires FACEIT's original entry point. A missing or invalid loader marker fails open to the original client entry point.

## Extension Runtime

The runtime uses `electron-chrome-extensions` for the core extension model and adds compatibility layers for APIs that FACEIT's Electron runtime does not expose directly.

The loader:

- loads enabled entries from `%APPDATA%\FACEIT\extension-loader\installed.json`;
- treats compatible FACEIT windows as extension tab targets;
- injects extension compatibility before extension page scripts;
- bridges supported APIs into Manifest V3 `MAIN`-world content scripts;
- limits extension host access to known FACEIT origins;
- backs `storage.sync` with loader-managed local storage because FACEIT has no Chrome account sync backend.

Managed Chrome Web Store packages are stored under the loader data directory. External unpacked folders are referenced in place and are never deleted by Remove.

## Manager UI

The manager preload owns a dock and popover under `document.body`, outside FACEIT's React-managed tree. It selects the visible right sidebar by geometry so hidden responsive copies do not receive the controls.

Extension launchers declared in catalog metadata are represented by a visual proxy in the dock. The original launcher remains in its native DOM context as an invisible positioning anchor, and the proxy forwards activation to the original handler.

Extension actions use an embedded Electron view attached to the FACEIT window. Preferred-size events resize and clamp the view to the active display work area. Full options pages remain normal `BrowserWindow` instances.

## Updates

The loader installs no service or resident watcher. Its update hook subscribes ahead of FACEIT's existing `update-downloaded` listeners. When an update arrives, the hook synchronously applies the stable payload from `%LOCALAPPDATA%\FACEIT Mods\current` to the new `app-*` directory before FACEIT's restart handler continues.

This hook cannot observe a replacement performed while FACEIT is not running. Setup exposes Repair for that case.

## Deep Links

Native Setup installs a small, stable broker at:

```text
%LOCALAPPDATA%\FACEIT Mods\current\native\faceit-mods-handler.exe
```

The current-user `addonport` protocol points to this broker rather than a versioned FACEIT
executable. The broker accepts only the documented `open`, `install`, `launch`, and connect-session
forms, rejects extra arguments and malformed targets, and starts the stable FACEIT launcher.
Runtime parsing applies the same restrictions again before creating any manager action. Setup
removes the former beta protocol registration during install and restore.

Connect sessions are claimed over a fixed HTTPS service origin. The claim secret remains in the main
process and is never forwarded to the FACEIT renderer. The renderer sees only an opaque request token
needed for the existing confirmation UI; completion, rejection, and failure are serialized back to
the session service.

Install requests accept only bundled catalog IDs or syntactically valid Chrome Web Store extension IDs. They cannot select arbitrary URLs or local files, and they always require user confirmation.

## Trust Boundaries

- Renderer IPC is accepted only from trusted FACEIT HTTPS origins.
- Chrome Web Store downloads are restricted to Google's update hosts, bounded by redirect, archive-size, entry-count, and extraction-size limits.
- Archive extraction rejects traversal, absolute paths, links, and unsupported entry types.
- Registry writes are limited to the current user.
- Restore refuses a backup that does not match its recorded SHA-256 value.
- Connect-session results are UX signals, not process or device attestation.
- Anti-Cheat, drivers, gameplay processes, and native overlay files are outside the loader boundary.
