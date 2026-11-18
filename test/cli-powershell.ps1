param(
  [Parameter(Mandatory = $true)][string]$FixtureRoot,
  [Parameter(Mandatory = $true)][string]$RemotePath,
  [Parameter(Mandatory = $true)][string]$NodeExe
)

$ErrorActionPreference = "Stop"
$CliPath = Join-Path $FixtureRoot "bin\default-workflows.mjs"
$CatalogPath = Join-Path $FixtureRoot "catalog.json"

function Invoke-Cli {
  param([string[]]$CliArgs, [int]$ExpectedExit = 0)
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $lines = & $NodeExe $CliPath @CliArgs 2>&1
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorActionPreference
  $text = ($lines | ForEach-Object { [string]$_ }) -join "`n"
  if ($exitCode -ne $ExpectedExit) {
    throw "CLI '$($CliArgs -join ' ')' returned exit $exitCode; expected $ExpectedExit. Output: $text"
  }
  return $text.Trim()
}

function Invoke-Git {
  param([string]$WorkingDirectory, [string[]]$GitArgs)
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $lines = & git -C $WorkingDirectory @GitArgs 2>&1
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorActionPreference
  if ($exitCode -ne 0) { throw "Git fixture operation '$($GitArgs[0])' failed (exit $exitCode)." }
  return ($lines | ForEach-Object { [string]$_ }) -join "`n"
}

function Invoke-BareGit {
  param([string[]]$GitArgs)
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $lines = & git "--git-dir=$RemotePath" @GitArgs 2>&1
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorActionPreference
  if ($exitCode -ne 0) { throw "Bare Git fixture operation '$($GitArgs[0])' failed (exit $exitCode)." }
  return (($lines | ForEach-Object { [string]$_ }) -join "`n").Trim()
}

if ((Invoke-Cli @("--version")) -ne "1.1.0") { throw "CLI package version is not 1.1.0." }
$validation = ConvertFrom-Json (Invoke-Cli @("validate"))
if (-not $validation.valid -or $validation.workflows -ne 11 -or $validation.systemSkills -ne 3) { throw "CLI source validation result is incomplete." }

$list = ConvertFrom-Json (Invoke-Cli @("list", "--catalog", $CatalogPath))
if ($list.repository -ne "bojii-custom-harness/agent-system-default-workflows" -or $list.products.Count -ne 12) { throw "CLI list did not return all current products." }
if (@($list.products | Where-Object { $_.currentVersion -ne "2.0.0" }).Count -ne 0) { throw "CLI list returned a non-approved current version." }

$historyBefore = ConvertFrom-Json (Invoke-Cli @("history", "workflow-generator", "--catalog", $CatalogPath))
if ($historyBefore.currentVersion -ne "2.0.0" -or $historyBefore.localTags.Count -ne 0) { throw "CLI history did not distinguish current source and published tags." }
$dirtyBeforePublish = Invoke-Git $FixtureRoot @("status", "--porcelain=v1")
if (-not [string]::IsNullOrWhiteSpace($dirtyBeforePublish)) { throw "Git source fixture must be clean before tag publication: $dirtyBeforePublish" }

$published = ConvertFrom-Json (Invoke-Cli @("publish", "workflow-generator", "2.0.0", "--remote", "origin"))
if ($published.action -ne "created-and-pushed" -or $published.sourceCommit -notmatch "^[0-9a-f]{40}$") { throw "CLI did not push the exact approved source tag." }
$repeat = ConvertFrom-Json (Invoke-Cli @("publish", "workflow-generator", "2.0.0", "--remote", "origin"))
if ($repeat.action -ne "already-published" -or $repeat.sourceCommit -ne $published.sourceCommit) { throw "Same-source CLI retry was not idempotent." }

$historyAfter = ConvertFrom-Json (Invoke-Cli @("history", "workflow-generator", "--catalog", $CatalogPath))
if ($historyAfter.localTags.Count -ne 1 -or $historyAfter.localTags[0].tag -ne "workflow-generator-2.0.0") { throw "CLI history did not report the pushed local tag." }

$invalidSemver = Invoke-Cli @("publish", "workflow-generator", "1.0", "--remote", "origin") 1
if ($invalidSemver -notmatch "INVALID_SEMVER") { throw "CLI did not clearly reject malformed SemVer." }
$invalidIdentity = Invoke-Cli @("publish", "unknown-workflow", "2.0.0", "--remote", "origin") 1
if ($invalidIdentity -notmatch "PRODUCT_ID_INVALID") { throw "CLI did not clearly reject an unknown product ID." }

$tag = "workflow-generator-2.0.0"
[void](Invoke-BareGit @("update-ref", "-d", "refs/tags/$tag"))
$conflictRoot = Join-Path (Split-Path -Parent $FixtureRoot) "conflicting-tag-clone"
$null = & git clone --quiet $RemotePath $conflictRoot 2>&1
if ($LASTEXITCODE -ne 0) { throw "Unable to create isolated conflicting-tag fixture." }
[void](Invoke-Git $conflictRoot @("config", "user.name", "Conflicting Test Fixture"))
[void](Invoke-Git $conflictRoot @("config", "user.email", "conflict@example.invalid"))
Set-Content -Path (Join-Path $conflictRoot "conflict-marker.txt") -Value "different source" -NoNewline
[void](Invoke-Git $conflictRoot @("add", "conflict-marker.txt"))
[void](Invoke-Git $conflictRoot @("commit", "-m", "conflicting tag source"))
$conflictingCommit = (Invoke-Git $conflictRoot @("rev-parse", "HEAD")).Trim()
[void](Invoke-Git $conflictRoot @("tag", $tag))
[void](Invoke-Git $conflictRoot @("push", "origin", "refs/tags/${tag}:refs/tags/${tag}"))
$conflict = Invoke-Cli @("publish", "workflow-generator", "2.0.0", "--remote", "origin") 1
if ($conflict -notmatch "TAG_CONFLICT") { throw "CLI did not reject a conflicting remote tag." }
$remoteCommit = Invoke-BareGit @("rev-parse", "refs/tags/$tag^{commit}")
if ($remoteCommit -ne $conflictingCommit) { throw "CLI modified the conflicting remote tag." }

Write-Output "Windows PowerShell CLI, local bare Git tag, idempotency and conflict checks passed."
