[CmdletBinding()]
param([switch]$SkipTests)
$ErrorActionPreference='Stop'
$qqRoot=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$qqNode=Join-Path $qqRoot '.tools\node\node.exe'
$qqNpm=Join-Path $qqRoot '.tools\node\node_modules\npm\bin\npm-cli.js'
$qqNodeVersion='24.22.0'
$qqArchiveName="node-v$qqNodeVersion-win-x64.zip"
# Pinned official release checksum; do not execute an unverified download.
$qqArchiveSha='f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3'
if(-not [Environment]::Is64BitOperatingSystem){throw 'This portable bootstrap requires 64-bit Windows.'}
if(-not(Test-Path -LiteralPath $qqNode) -or -not(Test-Path -LiteralPath $qqNpm)){
    $qqTarget=Join-Path $qqRoot '.tools\node'
    if(Test-Path -LiteralPath $qqTarget){throw 'Incomplete .tools/node exists; inspect it before retrying. No existing tools were overwritten.'}
    $qqDownloadDir=Join-Path $qqRoot '.local\node-downloads'
    New-Item -ItemType Directory -Path $qqDownloadDir -Force | Out-Null
    $qqArchive=Join-Path $qqDownloadDir $qqArchiveName
    $qqOldProgress=$ProgressPreference
    try {
        $ProgressPreference='SilentlyContinue'
        if(-not(Test-Path -LiteralPath $qqArchive)){
            Write-Output "Downloading portable Node $qqNodeVersion from nodejs.org..."
            Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$qqNodeVersion/$qqArchiveName" -OutFile $qqArchive -TimeoutSec 180
        }
    } finally {$ProgressPreference=$qqOldProgress}
    if((Get-FileHash -LiteralPath $qqArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $qqArchiveSha){throw 'Node archive SHA256 mismatch. Nothing was extracted or executed.'}
    $qqExtract=Join-Path $qqDownloadDir ([Guid]::NewGuid().ToString('N'))
    Expand-Archive -LiteralPath $qqArchive -DestinationPath $qqExtract
    $qqSource=[IO.Path]::GetFullPath((Join-Path $qqExtract "node-v$qqNodeVersion-win-x64"))
    $qqAbsoluteTarget=[IO.Path]::GetFullPath($qqTarget)
    $qqWorkspacePrefix=[IO.Path]::GetFullPath($qqRoot).TrimEnd('\')+'\'
    if(-not $qqSource.StartsWith($qqWorkspacePrefix,[StringComparison]::OrdinalIgnoreCase) -or -not $qqAbsoluteTarget.StartsWith($qqWorkspacePrefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Portable tool paths escaped the checkout.'}
    New-Item -ItemType Directory -Path (Split-Path $qqTarget -Parent) -Force | Out-Null
    Move-Item -LiteralPath $qqSource -Destination $qqAbsoluteTarget
}
$qqVersion=& $qqNode --version
if($LASTEXITCODE -ne 0 -or $qqVersion -notmatch '^v24\.'){throw 'Use the tested Node 24 portable runtime; no global Node was changed.'}
$qqOldPath=$env:PATH
$qqOldCache=$env:npm_config_cache
Push-Location $qqRoot
try {
    $env:PATH=(Split-Path $qqNode -Parent)+';'+$env:PATH
    $env:npm_config_cache=Join-Path $qqRoot '.local\npm-cache'
    & $qqNode $qqNpm ci --ignore-scripts --no-audit --no-fund
    if($LASTEXITCODE -ne 0){throw 'npm ci failed'}
    & $qqNode (Join-Path $qqRoot 'scripts\patch-snowluma-sdk.mjs')
    if($LASTEXITCODE -ne 0){throw 'Local SnowLuma SDK patch failed'}
    & git config --local core.hooksPath .githooks
    if($LASTEXITCODE -ne 0){throw 'Could not enable this repository pre-push check'}
    if(-not $SkipTests){
        & $qqNode (Join-Path $qqRoot 'scripts\test-core.mjs')
        if($LASTEXITCODE -ne 0){throw 'Core tests failed'}
    }
    & $qqNode (Join-Path $qqRoot 'scripts\check-publication.mjs')
    if($LASTEXITCODE -ne 0){throw 'Public source check failed'}
    Write-Output 'Ready for isolated development. Read AGENTS.md and docs/HANDOFF.md. No QQ or model service was started.'
} finally {
    $env:PATH=$qqOldPath
    $env:npm_config_cache=$qqOldCache
    Pop-Location
}
