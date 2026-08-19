# Third-party integration

FACEIT Mods exposes a current-user Windows protocol for extension websites, companion apps, and desktop shortcuts.

## Links

Use one of these canonical forms:

```text
faceit-mods://open
faceit-mods://install/<catalog-id>
faceit-mods://install/<chrome-extension-id>
faceit-mods://launch/<catalog-id-or-extension-id>
```

`install` always opens an in-client confirmation screen. A catalog ID must match `[a-z0-9-]{1,64}` and resolve to bundled marketplace metadata. A Chrome extension ID must match `[a-p]{32}`, downloads only from the Chrome Web Store, and is identified as not catalog-reviewed. URLs, local paths, query parameters, fragments, credentials, and unknown actions are rejected.

Do not launch a protocol link automatically during page load. Browsers commonly require a user gesture and may show their own confirmation prompt.

## Website button

Keep the fallback visible or reveal it after a short best-effort launch check. Browser state cannot prove whether a native protocol handler is installed, so the fallback must say "Didn't open?" or "FACEIT Mods may not be installed", not claim a detection result.

```html
<button id="install-with-faceit-mods" type="button">Install with FACEIT Mods</button>
<p id="faceit-mods-fallback" hidden>
  Didn't open?
  <a href="https://github.com/AddonPort/faceit/releases">Install FACEIT Mods</a>
</p>

<script type="module">
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  const button = document.querySelector('#install-with-faceit-mods');
  const fallback = document.querySelector('#faceit-mods-fallback');

  button.addEventListener('click', () => {
    let leftPage = false;
    const markLaunch = () => { leftPage = true; };
    const markHidden = () => {
      if (document.visibilityState === 'hidden') markLaunch();
    };

    button.disabled = true;
    fallback.hidden = true;
    window.addEventListener('blur', markLaunch);
    document.addEventListener('visibilitychange', markHidden);
    window.location.href = `faceit-mods://install/${extensionId}`;

    window.setTimeout(() => {
      window.removeEventListener('blur', markLaunch);
      document.removeEventListener('visibilitychange', markHidden);
      button.disabled = false;
      if (!leftPage && document.visibilityState === 'visible') fallback.hidden = false;
    }, 1500);
  });
</script>
```

The timeout is only a usability hint. A browser prompt, a slow FACEIT startup, or browser policy can produce a false fallback. Keep the install guide accessible even when the launch appears successful.

## Native Windows detection

Native applications can inspect the current user's loader state without launching FACEIT:

```text
HKCU\Software\FACEIT Mods
  DisplayName       REG_SZ  FACEIT Extension Loader
  DisplayVersion    REG_SZ  <loader version>
  InstallLocation   REG_SZ  <stable payload directory>
  Protocol          REG_SZ  faceit-mods
  ProtocolVersion   REG_SZ  1
```

Treat a missing key as not installed. Compare `ProtocolVersion` before relying on newer link actions. Do not infer loader state from a versioned FACEIT `app-*` path because official client updates replace those directories.

The setup also writes `%LOCALAPPDATA%\FACEIT Mods\installed.marker` for repair and migration compatibility. The registry contract is preferred for external native applications.
