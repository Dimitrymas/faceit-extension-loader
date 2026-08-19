# Code signing

AddonPort for FACEIT development builds remain unsigned. Code signing is planned for versioned
releases after the public project and publisher identity have been verified.

## Certum Open Source

Certum offers three Open Source Code Signing delivery options:

- an activation code for developers who already own a compatible cryptoCertum card and reader;
- a set that includes the card and reader;
- a SimplySign cloud certificate.

Check the [current product list](https://shop.certum.eu/buy-a-code-signing-certyficate) before ordering.
The low-cost activation code is not a complete first-time setup. Certum's
[verification requirements](https://support.certum.eu/en/code-signing-required-documents/) include
identity verification, proof of address, and a public open-source project that clearly establishes
the subscriber's relationship to it. The certificate is issued to an individual as Open Source
Developer and cannot be used for commercial distribution.

A valid signature replaces the unknown-publisher identity and contributes to Microsoft SmartScreen
reputation. It does not grant permission from FACEIT, prove that an extension is safe, or guarantee
that reputation-based warnings disappear immediately.

## Release procedure

1. Build and test the exact tagged commit in GitHub Actions.
2. Download the unsigned Setup artifact and verify its Actions artifact digest.
3. Sign Setup on a trusted Windows signing machine using SHA-256 and Certum timestamping.
4. Verify the Authenticode signature and timestamp with `signtool verify /pa /v` and
   `Get-AuthenticodeSignature`.
5. Generate a new SHA-256 checksum for the signed binary.
6. Publish only the signed binary, signed checksum, source tag, and generated release notes.

Do not store a card PIN, SimplySign approval material, exported private key, or long-lived signing
credential in the repository or a general-purpose GitHub Actions secret. Keep manual signing until a
supported non-exportable CI signing flow is available and documented by the certificate provider.
