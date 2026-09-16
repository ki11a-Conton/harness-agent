<#
.SYNOPSIS
  E4-R84 — versioned, sanitized serial benchmark campaign runner.

.DESCRIPTION
  This is the runner that produced the E4-R83 86-case campaign, moved out of the
  git-ignored `.ci/` directory and hardened so it can live in version control:

    * NO endpoint, NO model id and NO key are hard-coded here. The endpoint and
      model are REQUIRED parameters; the key is read only from the environment
      variable named by -ApiKeyEnv (default OPENAI_API_KEY). The key is never
      echoed, never written to a file, never placed in argv and never recorded
      in the manifest.
    * The campaign root defaults to a git-ignored directory (`.ci/bench-campaign`)
      so a real paid run never dirties the tree.
    * Per case, the runner writes a resume-manifest line IMMEDIATELY when the
      case's process exits, so an interruption loses at most the in-flight case.
    * A case whose report already exists is SKIPPED on relaunch (resumable).
    * Strictly serial: one benchmark process at a time, never concurrent.
    * After the campaign, the sanitized evidence chain is produced by
      `agent benchmark campaign validate` (which re-derives every number from
      the raw per-case reports).

  Authorization: this runner performs REAL, BILLED provider calls. It refuses to
  start unless -ConfirmPaidRun is passed AND RUN_PAID_BENCHMARKS=1 is set. The
  plan (R84–R86) forbids paid runs; a paid campaign requires its own explicit
  authorization.

.PARAMETER Endpoint
  Provider base URL. REQUIRED. Never committed — pass it on the command line.

.PARAMETER Model
  Model id. REQUIRED.

.PARAMETER Provider
  Provider id (default: openai).

.PARAMETER Root
  Campaign root (default: .ci/bench-campaign — git-ignored).

.PARAMETER LimitCases
  TEST HOOK: process at most this many REMAINING cases (0 = unlimited).

.PARAMETER ConfirmPaidRun
  Explicit acknowledgement that this run spends real money.

.EXAMPLE
  # Offline self-check of the resume/persist loop (no provider call):
  pwsh scripts/benchmark/run-campaign.ps1 -Endpoint https://example.invalid/v1 `
      -Model my-model -LimitCases 1 -DryRunOnly

.NOTES
  Never put a key in a parameter. Use the environment:
    $env:OPENAI_API_KEY = '<key>'          # not logged, not committed
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Endpoint,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Model,
    [ValidateNotNullOrEmpty()][string]$Provider = "openai",
    [ValidateNotNullOrEmpty()][string]$Root = ".ci/bench-campaign",
    [ValidateNotNullOrEmpty()][string]$CasesRoot = "benchmarks",
    # Suites to run, in order, comma-separated. Default: the four versioned
    # suites. A test fixture passes its own names.
    #
    # NOTE: the local working variable MUST NOT be named `$suites`: PowerShell
    # variable names are case-INSENSITIVE, so `$suites = @()` would overwrite
    # the `$Suites` parameter. It is `$suiteList` for that reason.
    [string]$Suites = "adversarial,stress,regression,holdout",
    [ValidateNotNullOrEmpty()][string]$ApiKeyEnv = "OPENAI_API_KEY",
    [ValidateRange(0, 100000)][int]$LimitCases = 0,
    [switch]$ConfirmPaidRun,
    # Offline: build the plan digest and exercise the loop WITHOUT any provider
    # call. Refuses to run a case; used by the Windows self-check.
    [switch]$DryRunOnly
)

$ErrorActionPreference = "Continue"

# --- Repository root -------------------------------------------------------
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

$cli = Join-Path $repoRoot "apps/cli/dist/main.js"
if (-not (Test-Path $cli)) {
    Write-Error "build first: apps/cli/dist/main.js is missing (run: pnpm build)"
    exit 2
}

# --- Authorization gate ----------------------------------------------------
if (-not $DryRunOnly) {
    if (-not $ConfirmPaidRun) {
        Write-Host "REFUSING: this runner makes REAL BILLED provider calls." -ForegroundColor Red
        Write-Host "Pass -ConfirmPaidRun and set RUN_PAID_BENCHMARKS=1 only under explicit authorization."
        exit 3
    }
    $key = [Environment]::GetEnvironmentVariable($ApiKeyEnv)
    if (-not $key) {
        Write-Host "REFUSING: environment variable $ApiKeyEnv is required (never passed as a parameter)." -ForegroundColor Red
        exit 2
    }
    $env:RUN_PAID_BENCHMARKS = "1"
    # TPM/rate-limit friendly: more retries, longer backoff (Retry-After wins).
    $env:OPENAI_MAX_RETRIES        = "8"
    $env:OPENAI_RETRY_DELAY_MS     = "3000"
    $env:OPENAI_REQUEST_TIMEOUT_MS = "300000"
}

# --- Identity (never committed) -------------------------------------------
$identity = @("--provider", $Provider, "--model", $Model, "--endpoint", $Endpoint)
# Plan-estimate rails. These are checked against the CLI's own planning
# heuristic (never against provider pricing) and are deliberately generous so
# they cannot refuse a run while still being explicit.
$budget = @(
    "--max-model-calls", "60",
    "--max-estimated-tokens", "1000000",
    "--max-estimated-cost-usd", "2.0"
)

$resultsDir = Join-Path $Root "results"
$stagingDir = Join-Path $Root "staging"
$manifest   = Join-Path $Root "manifest.jsonl"
$progress   = Join-Path $Root "progress.txt"
New-Item -ItemType Directory -Force -Path $resultsDir, $stagingDir | Out-Null

$suiteNames = @($Suites.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })
$suiteList = @()
foreach ($name in $suiteNames) {
    $suiteList += @{ name = $name; path = (Join-Path $CasesRoot $name) }
}
if ($suiteList.Count -eq 0) {
    Write-Error "-Suites must name at least one suite"
    exit 2
}

function Write-ProgressLine([string]$line) {
    "$(Get-Date -Format o)  $line" | Add-Content -Path $progress
    Write-Host $line
}

function Get-CaseOutDir([string]$suite, [string]$caseId) {
    return Join-Path $resultsDir (Join-Path $suite $caseId)
}

# regression keeps the historical baseline.json name; other suites use <suite>.json
function Get-ReportPath([string]$outDir, [string]$suite) {
    $base = if ($suite -eq "regression") { "baseline" } else { $suite }
    return Join-Path $outDir "$base.json"
}

function Test-CaseDone([string]$outDir, [string]$suite) {
    return Test-Path (Get-ReportPath $outDir $suite)
}

# Run ONE case in an isolated single-case dir; returns $null on success.
#
# loadBenchmarkCases treats every SUBDIRECTORY of --cases as one case and takes
# the case id from the directory NAME, so the staging layout must be
# <staging>/<caseId>/<case files...>.
function Invoke-OneCase([string]$suite, [string]$caseId, [string]$caseSrc, [string]$outDir) {
    $work = Join-Path $stagingDir "$suite-$caseId"
    $caseAt = Join-Path $work $caseId
    if (Test-Path $work) { Remove-Item -Recurse -Force $work }
    New-Item -ItemType Directory -Force -Path $caseAt | Out-Null
    Copy-Item -Recurse -Force (Join-Path $caseSrc "*") $caseAt

    $dryFlags = @("benchmark", "--suite", $suite, "--cases", $work) + $identity + $budget + @("--dry-run")
    $dry = & node $cli @dryFlags 2>&1
    if ($LASTEXITCODE -ne 0) {
        return "DRY-RUN FAILED ($LASTEXITCODE)"
    }
    $digest = ($dry | Select-String '"planDigest"' | ForEach-Object { ($_ -split '"')[3] } | Select-Object -First 1)
    if (-not $digest) {
        return "DRY-RUN produced no planDigest"
    }
    if ($DryRunOnly) {
        return $null
    }

    $execFlags = @("benchmark", "--suite", $suite, "--cases", $work) + $identity + $budget +
        @("--plan-digest", $digest, "--out", $outDir)
    $log = Join-Path $outDir "run.log"
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    & node $cli @execFlags *>&1 | Tee-Object -FilePath $log | Out-Null
    $exit = $LASTEXITCODE
    if ($exit -ne 0) {
        return "RUN EXIT $exit (report may still exist)"
    }
    if (-not (Test-CaseDone $outDir $suite)) {
        return "RUN EXIT 0 but no report written"
    }
    return $null
}

$total = 0
foreach ($s in $suiteList) {
    if (-not (Test-Path $s.path)) { continue }
    $total += (Get-ChildItem -Directory (Join-Path $s.path "*") | Where-Object { $_.Name -notlike ".*" }).Count
}
Write-ProgressLine "CAMPAIGN START suites=$($suiteList.Count) totalCases=$total dryRunOnly=$($DryRunOnly.IsPresent)"

$done = 0
$failed = 0
$stop = $false
foreach ($s in $suiteList) {
    if ($stop) { break }
    if (-not (Test-Path $s.path)) {
        Write-ProgressLine "[$($s.name)] SKIP suite (case source missing: $($s.path))"
        continue
    }
    $caseDirs = Get-ChildItem -Directory (Join-Path $s.path "*") | Where-Object { $_.Name -notlike ".*" } | Sort-Object Name
    foreach ($c in $caseDirs) {
        $caseId = $c.Name
        $outDir = Get-CaseOutDir $s.name $caseId
        if (Test-CaseDone $outDir $s.name) {
            $done++
            Write-ProgressLine "[$($s.name)/$caseId] SKIP already stored"
            continue
        }
        Write-ProgressLine "[$($s.name)/$caseId] START"
        $start = Get-Date
        $caseError = Invoke-OneCase $s.name $caseId $c.FullName $outDir
        $elapsed = [math]::Round(((Get-Date) - $start).TotalSeconds, 0)
        if ($caseError) {
            $failed++
            Write-ProgressLine "[$($s.name)/$caseId] FAIL after ${elapsed}s ($caseError)"
        } else {
            $done++
            Write-ProgressLine "[$($s.name)/$caseId] DONE after ${elapsed}s"
        }
        # Persist the attempt IMMEDIATELY (resume record). `error` is a short
        # status string only — never provider output, never a key.
        $entry = [pscustomobject]@{
            ts        = (Get-Date -Format o)
            suite     = $s.name
            caseId    = $caseId
            ok        = ($null -eq $caseError)
            error     = $caseError
            elapsedSec = $elapsed
        } | ConvertTo-Json -Compress
        Add-Content -Path $manifest -Value $entry
        if (-not $DryRunOnly) { Start-Sleep -Seconds 10 }
        if ($LimitCases -gt 0 -and ($done + $failed) -ge $LimitCases) {
            Write-ProgressLine "LIMITCASES=$LimitCases reached — stopping"
            $stop = $true
            break
        }
    }
}

Write-ProgressLine "CAMPAIGN END total=$total done=$done failed=$failed manifest=$manifest"

# Offline evidence chain: re-derive every number from the raw per-case reports.
if (-not $DryRunOnly) {
    $validateArgs = @("benchmark", "campaign", "validate", $Root, "--cases", $CasesRoot)
    if ($Suites -ne "adversarial,stress,regression,holdout") {
        $validateArgs += @("--suites", $suiteList)
    }
    & node $cli @validateArgs
    if ($LASTEXITCODE -ne 0) {
        Write-ProgressLine "CAMPAIGN VALIDATION FAILED ($LASTEXITCODE) — the evidence chain is not reproducible"
        exit 1
    }
}
exit 0
