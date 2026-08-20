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

1. Push the version tag. GitHub Actions builds and tests the exact commit, then uploads an
   `unsigned-addonport-for-faceit-<version>` signing candidate for 14 days. It does not create a
   public versioned release.
2. Download that artifact on the trusted Windows signing machine with the Windows SDK, Certum
   SimplySign Desktop, and GitHub CLI installed.
3. Sign, timestamp, verify, and generate checksums:

   ~~~powershell
   .\scripts\sign-windows-release.ps1 `
     -SetupPath .\dist\AddonPort-for-FACEIT-Setup-0.3.0-beta.25-x64.exe `
     -CertificateThumbprint YOUR_CERTIFICATE_SHA1_THUMBPRINT
   ~~~

4. Inspect the JSON result, then independently verify both the signature and timestamp:

   ~~~powershell
   signtool verify /pa /all /v .\dist\AddonPort-for-FACEIT-Setup-0.3.0-beta.25-x64.exe
   Get-AuthenticodeSignature .\dist\AddonPort-for-FACEIT-Setup-0.3.0-beta.25-x64.exe | Format-List
   ~~~

5. Publish the signed versioned and rolling assets only from the matching tag checkout:

   ~~~powershell
   .\scripts\publish-signed-release.ps1 `
     -Tag v0.3.0-beta.25 `
     -SetupPath .\dist\AddonPort-for-FACEIT-Setup-0.3.0-beta.25-x64.exe
   ~~~

The publishing script rejects a missing timestamp, invalid Authenticode status, mismatched filename,
missing checksum, or checkout that does not match the release tag.

Do not store a card PIN, SimplySign approval material, exported private key, or long-lived signing
credential in the repository or a general-purpose GitHub Actions secret. Keep manual signing until a
supported non-exportable CI signing flow is available and documented by the certificate provider.
