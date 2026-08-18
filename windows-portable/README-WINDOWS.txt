FACEIT Extension Loader - portable fallback
===========================================

Use the native FACEIT-Extension-Loader-Setup executable when possible. This
portable package exists for environments where Setup cannot use FACEIT's
embedded Electron runtime.

Install
-------

1. Install the official FACEIT desktop client.
2. Close FACEIT.
3. Run 1-patch-faceit.bat as the same Windows user that installed FACEIT.
4. Start FACEIT normally.
5. Open Mods from the bottom of the right sidebar.

Do not run the scripts as Administrator. If FACEIT is open, the patcher closes
FACEIT.exe before changing app.asar. It does not stop or modify FACEIT
Anti-Cheat services.

Manager
-------

- Extensions opens installed extension actions and provides enable, disable,
  reload, options, shortcut, and remove controls.
- Add installs from a Chrome Web Store URL or 32-character extension ID.
- Settings opens diagnostics and loader data, creates a manager shortcut, and
  loads unpacked extension folders for development.
- Content-script changes can require a FACEIT page refresh. Use the refresh
  action shown by the manager when needed.

Install links
-------------

The patcher registers these links for the current Windows user:

  faceit-mods://open
  faceit-mods://install/<catalog-id>
  faceit-mods://install/<chrome-extension-id>
  faceit-mods://launch/<catalog-id-or-extension-id>

Install links always require confirmation. Direct Chrome Web Store IDs are
marked as not reviewed in the bundled catalog. Unknown actions, arbitrary
package URLs, query parameters, and filesystem paths are rejected.

Native applications can read the installed loader version from:

  HKCU\Software\FACEIT Mods\DisplayVersion

Diagnostics
-----------

Runtime log:

  %APPDATA%\FACEIT\extension-loader\loader.log

Run 3-run-faceit-debug.bat only when collecting browser console output. It
starts FACEIT with remote debugging enabled and opens:

  http://127.0.0.1:9222/json/list

Run 2-enable-smoke-extension.bat only to test the loader independently from a
real extension.

Restore
-------

1. Close FACEIT.
2. Run 4-restore-faceit.bat.

Restore verifies and reinstates the original app.asar, then removes the
faceit-mods protocol registration and installed-version marker. Extension data
is left in place for a later reinstall.
