# Contributing

Use `dev` for integration work and open pull requests into `main` for release candidates. Keep changes within the desktop web client and extension-loader boundary. FACEIT Anti-Cheat, drivers, gameplay processes, native overlay files, monetization bypasses, copied extension packages, and FACEIT-owned binaries are out of scope.

## Local checks

```bash
npm ci
npm test
npm run build:win-installer
```

Changes to patching, restore, the native installer, or the Squirrel update hook also require an install/restore run on Windows or CrossOver. Confirm the restored `app.asar` hash matches its verified backup.

Do not commit generated `dist` files, downloaded installers, logs, registry data, extension storage, account data, tokens, cookies, or absolute user paths.
