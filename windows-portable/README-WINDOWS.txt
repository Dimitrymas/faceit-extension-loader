FACEIT Mods for Windows - beta
==============================

This is the portable fallback package. The native FACEIT-Extension-Loader-Setup executable
is the recommended installation path. Both patch only the current FACEIT install.

Steps:

1. Install the official FACEIT desktop client.
2. Run 1-patch-faceit.bat.
3. If FACEIT is running, the patcher warns you and closes the desktop client
   immediately. No confirmation input is required.
4. Start FACEIT normally.
5. Open Mods from the bottom button in FACEIT's right sidebar.
6. Open Add, paste a Chrome Web Store link or extension ID, and click Install.

Expected:

- FACEIT opens.
- A compact extension dock appears at the bottom of the visible right sidebar.
  It stays hidden instead of moving elsewhere when that sidebar is unavailable.
- The Mods button occupies the lower extension-launcher slot. Loaded extension
  action icons stack above it and scroll when the list is long.
- Extensions with a catalogued page launcher show a proxy in the dock while the
  original remains an invisible positioning anchor, avoiding visible duplicates
  without sending the extension's own popup off-screen.
- Mods opens a compact popover directly to the left of the native sidebar.
- Extensions opens actions and exposes enable, options, reload, and remove.
- Add installs from any valid Chrome Web Store link or 32-character ID.
- MAIN-world extensions can use runtime, storage.local, and local-backed
  storage.sync through the loader bridge.
- Action popups open inside FACEIT at the bottom-right, size themselves to their
  content, and stay inside the client viewport.
- Action popups close from their own close control, Escape, or an outside click.
- Full options pages keep normal resize and close controls.
- Settings can load an unpacked folder, open loader storage, and copy logs.
- FACEIT's Squirrel update-downloaded event reapplies the patch to a newly
  installed app-* directory before the official client restarts. No service,
  watcher, or permanently running launcher is installed.

Debug launch (optional):

- Run 3-run-faceit-debug.bat only when collecting DevTools or loader logs.
- If FACEIT is already running, the same warning and automatic close applies.
- It opens http://127.0.0.1:9222/json/list in your browser.

Smoke extension (optional):

- Run 2-enable-smoke-extension.bat before FACEIT only when testing the loader
  independently from a marketplace mod.

Legacy Repeek recovery:

1. Fully close FACEIT.
2. Run 5-install-repeek-webstore.bat.
3. Run 3-run-faceit-debug.bat or start FACEIT normally.

If direct Web Store install fails, install Repeek in Chrome, Edge, Brave, or
Opera and run 6-enable-repeek-from-browser.bat.

Repeek id:
  mokknliiomknodkdmpcellamkopbdmao

Manager behavior:

- Add folder registers an unpacked extension folder containing manifest.json.
- Remove deletes Store-managed files. It never deletes an external
  unpacked source folder.
- Enable, disable, reload, and remove may require a FACEIT page refresh so
  content scripts can be applied to a fresh document. Use Reload in the banner.
- Settings can copy a report and open:
  %APPDATA%\FACEIT\extension-loader

Install links:

- Starting patched FACEIT once registers faceit-mods:// for this Windows user.
- A catalog mod can be opened with faceit-mods://install/repeek
- Run 7-test-install-link.bat to exercise that link without a website.
- The review screen always requires confirmation before download and install.
- Unknown catalog ids and arbitrary package URLs are rejected.

Rollback:

- Run 4-restore-faceit.bat.
- If FACEIT is running, the same warning and automatic close applies.
- Restore also removes the faceit-mods:// handler for the current Windows user.

The close helper targets FACEIT.exe only. It does not stop or modify FACEIT
Anti-Cheat services.

Do not run as Administrator. Use the same Windows user that installed FACEIT.
