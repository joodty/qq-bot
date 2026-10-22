[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$qqRoot=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$qqNode=Join-Path $qqRoot '.tools\node\node.exe'
if(-not(Test-Path -LiteralPath $qqNode)){throw 'Portable Node missing; see LOCAL_DEVELOPMENT.md'}
$qqLogs=Join-Path $qqRoot '.local\baseline-logs'
New-Item -ItemType Directory -Path $qqLogs -Force | Out-Null
$qqTests=@(
    'scripts/test-group-roles.mjs',
    'scripts/test-conversation-roles.mjs',
    'scripts/test-conversation-role-races.mjs',
    'scripts/test-conversation-sessions.mjs',
    'scripts/test-session-switch-races.mjs',
    'scripts/test-console-auth.mjs',
    'scripts/test-token-daily.mjs',
    'scripts/test-group-mention-only.mjs',
    'scripts/test-mentioned-role-identity.mjs',
    'scripts/test-partial-send-retry.mjs',
    'scripts/test-participation-policy.mjs',
    'scripts/test-probability-delivery.mjs',
    'scripts/test-v2-initial-prompt.mjs',
    'scripts/test-role-card.mjs'
)
$qqResults=@()
Push-Location $qqRoot
try {
    foreach($qqTest in $qqTests){
        $qqLog=Join-Path $qqLogs ((Split-Path $qqTest -Leaf)+'.log')
        $qqOutput=@(& $qqNode $qqTest 2>&1)
        $qqExit=$LASTEXITCODE
        $qqOutput | Set-Content -LiteralPath $qqLog -Encoding utf8
        $qqResult=[pscustomobject]@{script=$qqTest;exitCode=$qqExit;log=$qqLog}
        $qqResults+=$qqResult
        Write-Output ('{0} {1}' -f $(if($qqExit -eq 0){'PASS'}else{'FAIL'}),$qqTest)
        if($qqExit -ne 0){$qqOutput | Select-Object -Last 12 | Write-Output}
    }
    [pscustomobject]@{checkedAt=(Get-Date -Format o);node=(& $qqNode --version);scope='isolated fixtures; no live QQ/DSH/model';tests=$qqResults} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $qqRoot '.local\baseline-test-results.json') -Encoding utf8
    if(@($qqResults | Where-Object {$_.exitCode -ne 0}).Count){throw 'Local baseline checks failed; see .local/baseline-logs'}
} finally {Pop-Location}
