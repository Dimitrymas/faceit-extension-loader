[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')]
  [string]$Tag,

  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string]$SetupPath,

  [string]$Repository = 'AddonPort/faceit'
)

$ErrorActionPreference = 'Stop'
$setup = (Resolve-Path -LiteralPath $SetupPath).Path
$version = $Tag.Substring(1)
$expectedName = "AddonPort-for-FACEIT-Setup-$version-x64.exe"
if ((Split-Path -Leaf $setup) -ne $expectedName) {
  throw "Expected the signed Setup filename to be $expectedName."
}

$current = Join-Path (Split-Path -Parent $setup) 'AddonPort-for-FACEIT-Setup-x64.exe'
$assets = @($setup, "$setup.sha256", $current, "$current.sha256")
foreach ($asset in $assets) {
  if (-not (Test-Path -LiteralPath $asset -PathType Leaf)) {
    throw "Missing release asset: $asset"
  }
}

foreach ($executable in @($setup, $current)) {
  $signature = Get-AuthenticodeSignature -LiteralPath $executable
  if ($signature.Status -ne 'Valid' -or -not $signature.TimeStamperCertificate) {
    throw "The release executable must have a valid timestamped Authenticode signature: $executable"
  }
}

$setupHash = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant()
$currentHash = (Get-FileHash -LiteralPath $current -Algorithm SHA256).Hash.ToLowerInvariant()
if ($setupHash -ne $currentHash) {
  throw 'The rolling Setup alias does not match the versioned executable.'
}

foreach ($executable in @($setup, $current)) {
  $hash = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
  $name = Split-Path -Leaf $executable
  $recorded = (Get-Content -LiteralPath "$executable.sha256" -Raw).Trim()
  if ($recorded -ne "$hash  $name") {
    throw "The checksum file does not match $name."
  }
}

$tagCommit = (& git rev-list -n 1 $Tag).Trim()
if (-not $tagCommit) {
  throw "Tag $Tag is not available in this checkout."
}
$headCommit = (& git rev-parse HEAD).Trim()
if ($tagCommit -ne $headCommit) {
  throw "The checkout is at $headCommit, but $Tag points to $tagCommit."
}

$notesPath = Join-Path $env:TEMP "addonport-$version-release-notes.md"
$notes = & node scripts/release-notes.js $version
if ($LASTEXITCODE -ne 0) {
  throw 'Release note generation failed.'
}
[IO.File]::WriteAllText($notesPath, (($notes -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))

$flags = @()
if ($version.Contains('-')) {
  $flags += '--prerelease'
}

& gh release create $Tag @assets --repo $Repository --verify-tag --notes-file $notesPath `
  --title "AddonPort for FACEIT $Tag" @flags
if ($LASTEXITCODE -ne 0) {
  throw "GitHub release publication failed with exit code $LASTEXITCODE."
}
