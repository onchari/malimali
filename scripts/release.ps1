param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d{4}\.\d{2}\.\d{2}\.\d+$')]
  [string]$Version
)

$root = Split-Path -Parent $PSScriptRoot
$appPath = Join-Path $root 'app.js'
$swPath = Join-Path $root 'sw.js'
$versionPath = Join-Path $root 'version.json'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Update-TextFile([string]$Path, [string]$Pattern, [string]$Replacement) {
  $text = [IO.File]::ReadAllText($Path)
  if (-not [regex]::IsMatch($text, $Pattern)) {
    throw "Expected version marker was not found in $Path"
  }
  $updated = [regex]::Replace($text, $Pattern, $Replacement, 1)
  [IO.File]::WriteAllText($Path, $updated, $utf8NoBom)
}

Update-TextFile $appPath 'const APP_VERSION = "[^"]+";' "const APP_VERSION = `"$Version`";"
Update-TextFile $swPath "const APP_VERSION = '[^']+';" "const APP_VERSION = '$Version';"
[IO.File]::WriteAllText($versionPath, "{`n  `"version`": `"$Version`"`n}`n", $utf8NoBom)

Write-Host "Release version updated to $Version"
Write-Host "Review the diff, run checks, then commit and push."
