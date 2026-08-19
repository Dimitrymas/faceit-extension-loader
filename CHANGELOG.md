# Changelog

All notable changes to FACEIT Extension Loader are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/AddonPort/faceit/compare/v0.3.0-beta.23...HEAD
[0.3.0-beta.23]: https://github.com/AddonPort/faceit/compare/v0.3.0-beta.22...v0.3.0-beta.23
[0.3.0-beta.22]: https://github.com/AddonPort/faceit/compare/v0.3.0-beta.21...v0.3.0-beta.22
[0.3.0-beta.21]: https://github.com/AddonPort/faceit/releases/tag/v0.3.0-beta.21
