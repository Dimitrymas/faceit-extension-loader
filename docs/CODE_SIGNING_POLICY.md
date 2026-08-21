# Code signing policy

This policy covers official Windows Setup releases for AddonPort for FACEIT.

## Release controls

- A versioned release must be built by GitHub Actions from a repository tag that exactly matches the
  package and changelog version.
- CI produces a temporary unsigned signing candidate. It must not be presented as a signed public
  release.
- The final executable must have a valid SHA-256 Authenticode signature and an RFC 3161 timestamp
  from a publicly trusted code-signing provider.
- The signed executable, rolling alias, and SHA-256 files must be derived from the same candidate.
- Publication is rejected when the tag, filename, signature, timestamp, or required assets do not
  match.
- Development prereleases are explicitly unsigned and kept separate from versioned releases.

## Responsibilities

- Committers and reviewers: [AddonPort organization owners](https://github.com/orgs/AddonPort/people?query=role%3Aowner).
- Signing approvers: [AddonPort organization owners](https://github.com/orgs/AddonPort/people?query=role%3Aowner).
- Changes from outside maintainers require review before merge. Signing-sensitive changes include
  build scripts, workflows, dependencies, installer sources, release scripts, and this policy.
- Every signing request requires an explicit maintainer approval after CI and candidate provenance
  have been checked.

## User protection

Signing identifies the publisher and protects artifact integrity. It does not grant permission from
FACEIT, certify installed extensions, or bypass Microsoft reputation checks. The project boundary,
restore procedure, and system changes are documented in the main README.

See the [privacy policy](PRIVACY.md) and [release signing procedure](CODE_SIGNING.md).
