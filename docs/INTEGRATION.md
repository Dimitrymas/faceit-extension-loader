# Third-party integration

AddonPort for FACEIT registers the versioned AddonPort protocol for extension websites, companion
applications, and desktop shortcuts.

## Website SDK

Use the framework-neutral `@addonport/sdk` package when a page needs to show whether FACEIT opened,
whether confirmation is pending, and whether an action completed. The service creates a five-minute
session with separate native and browser secrets; no resident local process or WebSocket is required.

```js
import { AddonPortClient } from "@addonport/sdk";

const client = new AddonPortClient({
  apiBaseUrl: "https://connect.addonport.dev",
  client: { name: "example-extension-site", version: "1.0.0" },
});

const session = await client.prepare({
  action: "install",
  target: "abcdefghijklmnopabcdefghijklmnop",
});

session.open();
const result = await session.wait({
  onStatus: (snapshot) => renderStatus(snapshot.state),
});
```

The SDK is maintained in the [AddonPort repository](https://github.com/addonport/addonport), with
Web Component, React, and Vue bindings. A session result is a user-experience signal, not device
attestation and must not be used for authentication or authorization.

## Static links

Use these forms when the caller does not need a result channel:

```text
addonport://open
addonport://install/<catalog-id>
addonport://install/<chrome-extension-id>
addonport://launch/<catalog-id-or-extension-id>
```

`install` always opens an in-client confirmation screen. A catalog ID must match
`[a-z0-9-]{1,64}` and resolve to bundled marketplace metadata. A Chrome extension ID must match
`[a-p]{32}`, downloads only from the Chrome Web Store, and is identified as not catalog-reviewed.
URLs, local paths, query parameters, fragments, credentials, and unknown actions are rejected.

Launch a protocol link only from a user action. Browsers can show their own confirmation prompt.
Keep a normal Setup download link available because browser focus and timeout heuristics cannot
reliably detect a registered protocol handler.

Legacy `faceit-mods://open`, `install`, and `launch` links remain accepted during migration. New
integrations must use `addonport://` or the SDK.

## Native Windows detection

Native applications can inspect the current user's adapter state without launching FACEIT:

```text
HKCU\Software\AddonPort\FACEIT
  DisplayName       REG_SZ  AddonPort for FACEIT
  DisplayVersion    REG_SZ  <adapter version>
  InstallLocation   REG_SZ  <stable payload directory>
  Protocol          REG_SZ  addonport
  ProtocolVersion   REG_SZ  2
  LegacyProtocol    REG_SZ  faceit-mods
```

Treat a missing key as not installed and compare `ProtocolVersion` before relying on connect
sessions. Do not infer adapter state from a versioned FACEIT `app-*` directory because official
client updates replace those directories.

Setup continues to write `HKCU\Software\FACEIT Mods` and the legacy installed marker for upgrades
from older beta builds. New native integrations should use only the AddonPort registry key.
