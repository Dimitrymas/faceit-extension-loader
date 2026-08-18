## Summary

- Describe the behavior changed and why.

## Verification

- [ ] `npm test`
- [ ] `npm run build:win-installer`
- [ ] Windows or CrossOver install and restore, when patching or installer behavior changed
- [ ] No FACEIT-owned binaries, patched ASAR files, extension packages, credentials, or personal data added

## Scope

- [ ] Does not touch FACEIT Anti-Cheat, drivers, the native overlay, or gameplay processes
- [ ] Preserves restore and failure-open behavior
