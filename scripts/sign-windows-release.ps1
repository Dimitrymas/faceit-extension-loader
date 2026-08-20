[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string]$SetupPath,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Fa-f0-9]{40}$')]
  [string]$CertificateThumbprint,

  [string]$TimestampUrl = 'http://time.certum.pl'
)

$ErrorActionPreference = 'Stop'
$setup = (Resolve-Path -LiteralPath $SetupPath).Path
if ([IO.Path]::GetExtension($setup) -ne '.exe') {
  throw 'SetupPath must point to a Windows executable.'
}

$signTool = (Get-Command signtool.exe -ErrorAction Stop).Source
$thumbprint = $CertificateThumbprint.ToUpperInvariant()

& $signTool sign /sha1 $thumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 `
  /d 'AddonPort for FACEIT Setup' /du 'https://addonport.dev' /v $setup
if ($LASTEXITCODE -ne 0) {
  throw "signtool sign failed with exit code $LASTEXITCODE."
}

& $signTool verify /pa /all /v $setup
if ($LASTEXITCODE -ne 0) {
  throw "signtool verify failed with exit code $LASTEXITCODE."
}

$signature = Get-AuthenticodeSignature -LiteralPath $setup
if ($signature.Status -ne 'Valid') {
  throw "Authenticode status is $($signature.Status): $($signature.StatusMessage)"
}
if (-not $signature.TimeStamperCertificate) {
  throw 'The signature is valid but does not contain a trusted timestamp.'
}

$directory = Split-Path -Parent $setup
$versionedName = Split-Path -Leaf $setup
$currentName = 'AddonPort-for-FACEIT-Setup-x64.exe'
$currentPath = Join-Path $directory $currentName
if ($versionedName -ne $currentName) {
  Copy-Item -LiteralPath $setup -Destination $currentPath -Force
}

$utf8 = [Text.UTF8Encoding]::new($false)
foreach ($path in @($setup, $currentPath) | Select-Object -Unique) {
  $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  $name = Split-Path -Leaf $path
  [IO.File]::WriteAllText("$path.sha256", "$hash  $name`n", $utf8)
}

[PSCustomObject]@{
  Setup = $setup
  CurrentAlias = $currentPath
  Sha256 = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant()
  Signer = $signature.SignerCertificate.Subject
  TimestampedBy = $signature.TimeStamperCertificate.Subject
} | ConvertTo-Json
