# Third-Party Notices

FACEIT Client Extension Loader Patch includes third-party software. The complete
license texts shipped by npm dependencies remain alongside those dependencies
under `node_modules`.

## Node.js

The native Windows setup does not distribute Node.js. It runs its patch and
restore scripts through the runtime already embedded in the user's installed
FACEIT Electron executable. The separate portable fallback package includes an
unmodified official Node.js executable; its license and bundled third-party
notices are provided in `node/LICENSE`.

## electron-chrome-extensions

`electron-chrome-extensions` 4.9.0 is distributed under GNU GPL version 3 in
this build. Its license is available in
`node_modules/electron-chrome-extensions/LICENSE-GPL`.

## Other npm dependencies

The package contains the production dependency tree recorded in
`package-lock.json`. Each dependency's license file and package metadata are
preserved in its own `node_modules` directory.

FACEIT, its desktop client, and installed Chrome extensions are not included in
this project's license grant. This project is unofficial and is not affiliated
with or endorsed by FACEIT.
