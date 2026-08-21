# Code signing

AddonPort for FACEIT development builds remain unsigned. Versioned tags produce temporary unsigned
signing candidates, not public releases. A trusted public release cannot be created until a provider
has issued or approved code-signing access.

The repository-side controls are defined in the [code signing policy](CODE_SIGNING_POLICY.md).

## Choose a provider

Two realistic paths are available:

- **Certum Open Source in SimplySign:** a certificate issued to the verified individual, used from a
  trusted Windows machine. This is the direct manual workflow documented below. Product availability
  and price must be checked before purchase.
- **SignPath Foundation:** free signing for accepted open-source projects with verifiable CI builds.
  It requires an existing public release, documented system changes and removal, a privacy policy,
  repository MFA, explicit signing roles, manual approval for every release, and project acceptance.
  Do not claim SignPath signing or add its required attribution until the project has been accepted.

## Certum Open Source

Certum offers three Open Source Code Signing delivery options:

- an activation code for developers who already own a compatible cryptoCertum card and reader;
- a set that includes the card and reader;
- a SimplySign cloud certificate.

Check the [current SimplySign product page](https://shop.certum.eu/open-source-code-signing-on-simplysign.html)
before ordering.
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
2. On the trusted Windows signing machine, install Git, GitHub CLI, the Windows SDK Signing Tools,
   and Certum SimplySign Desktop. Connect SimplySign and confirm that the certificate is visible:

   ~~~powershell
   Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
     Select-Object Subject, Thumbprint, NotAfter
   ~~~

3. Check out the exact tag and download its candidate artifact:

   ~~~powershell
   git clone https://github.com/AddonPort/faceit.git
   Set-Location .\faceit
   git checkout v0.3.0-beta.25
   gh run list --repo AddonPort/faceit --workflow "Versioned Release" --branch v0.3.0-beta.25
   gh run download RUN_ID --repo AddonPort/faceit `
     --name unsigned-addonport-for-faceit-0.3.0-beta.25 `
     --dir .\dist
   ~~~

4. Sign, timestamp, verify, and generate checksums. Use the 40-character thumbprint reported by the
   certificate store; do not paste a PIN, access code, or private key into the command or repository:

   ~~~powershell
   .\scripts\sign-windows-release.ps1 `
     -SetupPath .\dist\AddonPort-for-FACEIT-Setup-0.3.0-beta.25-x64.exe `
     -CertificateThumbprint YOUR_CERTIFICATE_SHA1_THUMBPRINT
   ~~~

5. Inspect the JSON result, then independently verify both the signature and timestamp:

   ~~~powershell
   signtool verify /pa /all /v .\dist\AddonPort-for-FACEIT-Setup-0.3.0-beta.25-x64.exe
   Get-AuthenticodeSignature .\dist\AddonPort-for-FACEIT-Setup-0.3.0-beta.25-x64.exe | Format-List
   ~~~

6. Publish the signed versioned and rolling assets only from the matching tag checkout:

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
