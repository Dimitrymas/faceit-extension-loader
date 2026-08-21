# Changelog

All notable changes to AddonPort for FACEIT are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0-beta.25] - 2026-08-21

### Changed

- Simplify install confirmation to the extension identity, trust source, requested permissions, and
  the actions needed to continue or cancel.
- Require timestamped Authenticode signing before a versioned Windows release can be published.
- Publish rolling Setup and checksum filenames alongside versioned release artifacts so install
  pages can link directly to the current build.
- Correct the third-party integration guide to point to the standalone AddonPort SDK repository.
- Document the public hosted install button and its session-first, direct-fallback behavior.

### Removed

- Remove active registration and runtime acceptance of the former beta deep-link scheme while
  retaining upgrade detection and cleanup for existing installations.

### Security

- Document the release signing controls, maintainer responsibilities, and first-party network and
  privacy boundaries.

## [0.3.0-beta.24] - 2026-08-19

### Added

- Added the `addonport://` protocol with direct `open`, `install`, and `launch` actions while retaining legacy links.
- Added AddonPort v2 connect sessions so websites can observe client launch, confirmation, completion, rejection, and failure.
- Added Repeek to the compatibility catalog and mapped its existing page launcher into the AddonPort dock.
- Added the versioned `HKCU\Software\AddonPort\FACEIT` integration contract for native applications.

### Changed

- Renamed user-facing Setup, manager, diagnostics, shortcuts, and release artifacts to AddonPort for FACEIT.
- Made `addonport://` the default for copied install links and newly created shortcuts.
- Reworked integration documentation around the framework-neutral AddonPort SDK and explicit session state.

### Security

- Kept session bearer tokens in the Electron main process and exposed only opaque confirmation tokens to FACEIT renderers.
- Restricted connect traffic to a fixed HTTPS origin with bounded requests, responses, and timeouts.

## [0.3.0-beta.23] - 2026-08-19

### Added

- Added stable `faceit-mods://open`, `install`, and `launch` links for websites, desktop applications, and shortcuts.
- Added direct install links for any valid Chrome Web Store extension ID, with an explicit not-reviewed warning for entries outside the bundled catalog.
- Added desktop shortcuts for the Mods manager and installed extension actions.
- Added loader version and active-extension counts to the manager header.
- Added current-user registry metadata for native installation and protocol-version detection.

### Changed

- Moved protocol registration from the versioned Electron process to a small broker stored under the stable loader payload.
- Setup now distinguishes Install, Update, and Repair by reading the installed loader version.
- Reworked public, architecture, Windows, and third-party integration documentation around supported user workflows.

### Removed

- Removed legacy helper scripts and catalog metadata tied to a single extension.

### Security

- Restricted the native protocol broker to one validated URL argument and three documented actions.
- Kept all deep-link installs behind an in-client confirmation screen and limited package sources to the Chrome Web Store.

## [0.3.0-beta.22] - 2026-08-18

### Changed

- Replaced the setup surface with a compact native Windows installer.
- Added explicit ready, working, success, and error states with inline recovery actions.
- Added per-monitor DPI, high-contrast, keyboard, and dark-window support.
- Standardized versioned and rolling Windows Setup artifact names.

## [0.3.0-beta.21] - 2026-08-18

### Added

- Published the first public beta with ASAR backup, patch, inspection, and verified restore commands.
- Added the in-client extension manager, Chrome Web Store installation, compatibility bridges, and diagnostics.
- Added CI, development prereleases, dependency automation, and versioned release builds.

[Unreleased]: https://github.com/AddonPort/faceit/compare/v0.3.0-beta.25...HEAD
[0.3.0-beta.25]: https://github.com/AddonPort/faceit/compare/v0.3.0-beta.24...v0.3.0-beta.25
[0.3.0-beta.24]: https://github.com/AddonPort/faceit/compare/v0.3.0-beta.23...v0.3.0-beta.24
[0.3.0-beta.23]: https://github.com/AddonPort/faceit/compare/v0.3.0-beta.22...v0.3.0-beta.23
[0.3.0-beta.22]: https://github.com/AddonPort/faceit/compare/v0.3.0-beta.21...v0.3.0-beta.22
[0.3.0-beta.21]: https://github.com/AddonPort/faceit/releases/tag/v0.3.0-beta.21
