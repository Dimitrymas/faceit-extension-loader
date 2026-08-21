# Privacy

AddonPort for FACEIT does not include first-party analytics, advertising, crash reporting, or
background telemetry. Diagnostics remain on the device until the user explicitly copies and shares
them.

The adapter transfers information to other networked systems only for an operation requested by the
user or by the person operating it:

- A Connect install request contacts `https://connect.addonport.dev` after the user starts an
  installation from an integrating website. The client exchanges an opaque session identifier,
  one-time claim secret, requested extension target, adapter version and platform, and install
  result.
- Confirmed extension installs download packages from the Chrome Web Store update service. Catalog
  screens can load extension icons hosted by Google.
- The embedded FACEIT client continues to communicate with FACEIT services independently of
  AddonPort.

Installed extensions are third-party software and can have their own network behavior and privacy
policies. Review the extension publisher, requested permissions, source, and privacy policy before
installation. AddonPort does not send FACEIT credentials, cookies, extension storage, local file
paths, or copied diagnostics to the AddonPort Connect service.

Restore removes the adapter and protocol registration but intentionally keeps extension data so it
can be reused after reinstall. The retained data is documented in the main README and can be removed
manually from `%APPDATA%\FACEIT\extension-loader`.
