# Contributing

Contributions should improve the desktop web-client extension loader without expanding into FACEIT Anti-Cheat, drivers, gameplay processes, the native overlay, enforcement systems, monetization bypasses, or redistribution of third-party packages and FACEIT binaries.

## Workflow

1. Branch from `dev`.
2. Keep the change focused and preserve existing restore behavior.
3. Add tests that cover the changed contract or failure mode.
4. Update `CHANGELOG.md` under **Unreleased** for user-visible changes.
5. Open a pull request into `dev`. Release candidates are promoted from `dev` to `main`.

Use imperative commit subjects that describe the behavior, for example `Validate direct Store install links`. Avoid generated summaries, vague subjects such as `updates`, and commit messages that only list filenames.

## Local Checks

```bash
npm ci
npm test
npm run build:win-installer
```

Changes to patching, restore, native Setup, the protocol broker, or the Squirrel update hook also require a Windows or CrossOver install/restore run. Verify all of the following:

- Setup exits successfully.
- The patched archive reports `mod/bootstrap.js` as its entry point.
- Restore returns the entry point to the original value.
- The restored archive matches its recorded backup hash.
- Current-user registry values and markers are created and removed as expected.

UI changes require screenshots at a normal desktop viewport and a narrow viewport. Check for clipping, overlap, off-screen popups, unstable dimensions, and inaccessible controls.

## Changelog And Release Notes

Keep entries user-facing and behavior-specific. Use **Added**, **Changed**, **Deprecated**, **Removed**, **Fixed**, or **Security** headings from Keep a Changelog. Do not paste commit history into the changelog and do not describe internal experimentation that never shipped.

Versioned GitHub Releases read their notes from the matching `CHANGELOG.md` section. A release tag must match `package.json`, and the changelog must contain that exact version.

## Repository Hygiene

Do not commit:

- generated `dist` files;
- downloaded installers or extension packages;
- logs, registry exports, extension storage, or patched ASAR files;
- account data, tokens, cookies, or credentials;
- absolute local paths or usernames;
- FACEIT-owned binaries or assets.

Use `npm run clean` to remove local build output. Review the staged diff before every commit.
