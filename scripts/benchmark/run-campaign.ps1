#!/usr/bin/env pwsh
<#
.SYNOPSIS
  E4-R84/R89 — versioned, sanitized, resumable serial benchmark campaign runner.

.DESCRIPTION
  This is the runner that produced the E4-R83 86-case campaign, moved out of the
  git-ignored `.ci/` directory and hardened so it can live in version control.

  Identity and secrecy:
    * NO endpoint, NO model id and NO key are hard-coded here. The endpoint and
      model are REQUIRED parameters; the key is read only from the environment
      variable named by -ApiKeyEnv (default OPENAI_API_KEY). The key is never
      echoed, never written to a file, never placed in argv and never recorded
      in the manifest. Only a DIGEST of the endpoint is ever persisted.
    * The campaign root must resolve INSIDE the repository, so the staging
      cleanup can never be pointed at an arbitrary directory.

  Authorization (E4-R89 / finding F3):
    A real run performs REAL, BILLED provider calls. The runner only ever READS
    the authorization inputs; it NEVER creates a missing authorization flag.
    It refuses to start unless ALL of these hold:
      * -ConfirmPaidRun is passed;
      * RUN_PAID_BENCHMARKS=1 is ALREADY set in the environment;
      * the key variable named by -ApiKeyEnv is non-empty.
    An API key alone is not authorization, and a switch alone is not
    authorization. A refusal creates no campaign directory and starts no child
    process.

  Completion (E4-R89 / finding F4):
    "The report file exists" is NOT completion. A case is skipped only when its
    report parses, its suite/case/plan identity matches the frozen experiment
    identity, AND a matching manifest record exists. Four anomalous states are
    distinguished and QUARANTINED (never silently reused, never automatically
    re-billed): report without manifest, manifest without report, truncated
    JSON, and changed identity. A crash after a request was sent but before the
    outcome was persisted is recorded as OUTCOME_UNKNOWN and requires an
    explicit operator decision. This runner makes NO exactly-once guarantee
    across a network boundary.

  Counting and limits (E4-R89 / finding F5):
    Attempted/completed/failed THIS RUN, historically resumed, and case
    pass/fail are SEPARATE counters. -LimitCases bounds only the number of NEW
    cases started by this invocation; reaching it produces PARTIAL, never a
    claim of a complete campaign. The final exit code reflects the WORST
    outcome and is never overwritten by a later successful command.

.PARAMETER Endpoint
  Provider base URL. REQUIRED. Never committed — pass it on the command line.

.PARAMETER Model
  Model id. REQUIRED.

.PARAMETER Provider
  Provider id (default: openai).

.PARAMETER Root
  Campaign root (default: .ci/bench-campaign — git-ignored). MUST resolve inside
  the repository.

.PARAMETER CasesRoot
  Directory holding <suite>/<caseId>/ case sources (default: benchmarks).

.PARAMETER Suites
  Comma-separated suite names, in order. Default: the four versioned suites.
  Each name must be a simple identifier; a missing or unknown suite is an error
  reported BEFORE any case executes.

.PARAMETER ApiKeyEnv
  Name of the environment variable holding the key (default OPENAI_API_KEY).
  The child CLI reads OPENAI_API_KEY, so when a different name is given the
  runner explicitly propagates it to the child and restores the parent
  environment afterwards.

.PARAMETER LimitCases
  Bound on the number of NEW cases this invocation may START (0 = unlimited).

.PARAMETER ConfirmPaidRun
  Explicit acknowledgement that this run spends real money. Necessary, NOT
  sufficient: RUN_PAID_BENCHMARKS=1 must already be set.

.PARAMETER DryRunOnly
  Offline: exercise the loop WITHOUT any provider call.

.PARAMETER CliPath
  Injectable CLI entry point (default apps/cli/dist/main.js). Tests point this
  at a fake CLI so the PAID-SHAPED control flow (argv, exit codes, resume) is
  covered end to end with zero real requests.

.PARAMETER AdoptOrphanReport
  Explicit operator decision: adopt a valid report that has no manifest record
  instead of quarantining it. Without this switch such a case is quarantined
  and never silently re-billed.

.EXAMPLE
  # Offline self-check of the resume/persist loop (no provider call):
  pwsh scripts/benchmark/run-campaign.ps1 -Endpoint https://example.invalid/v1 `
      -Model my-model -LimitCases 1 -DryRunOnly

.NOTES
  Never put a key in a parameter. Use the environment:
    $env:OPENAI_API_KEY = '<key>'          # not logged, not committed
    $env:RUN_PAID_BENCHMARKS = '1'         # the authorization, set by the operator

  Exit codes: 0 complete · 1 failed · 2 config/usage · 3 refused · 4 partial
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Endpoint,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Model,
    [ValidateNotNullOrEmpty()][string]$Provider = "openai",
    [ValidateNotNullOrEmpty()][string]$Root = ".ci/bench-campaign",
    [ValidateNotNullOrEmpty()][string]$CasesRoot = "benchmarks",
    [string]$Suites = "adversarial,stress,regression,holdout",
    [ValidateNotNullOrEmpty()][string]$ApiKeyEnv = "OPENAI_API_KEY",
    [ValidateRange(0, 100000)][int]$LimitCases = 0,
    [switch]$ConfirmPaidRun,
    [switch]$DryRunOnly,
    [string]$CliPath = "",
    [switch]$AdoptOrphanReport
)

$ErrorActionPreference = "Stop"

# Machine-readable exit codes (never inferred from the last command run).
$EXIT_OK = 0
$EXIT_FAILED = 1
$EXIT_CONFIG = 2
$EXIT_REFUSED = 3
$EXIT_PARTIAL = 4

# --- Repository root -------------------------------------------------------
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

$cli = if ($CliPath -ne "") { $CliPath } else { Join-Path $repoRoot "apps/cli/dist/main.js" }
if (-not (Test-Path $cli)) {
    Write-Error "build first: $cli is missing (run: pnpm build)"
    exit $EXIT_CONFIG
}

function Get-Sha256Hex([string]$text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

# --- Authorization gate (E4-R89 F3): READ inputs, never create them --------
#
# This runs FIRST, before any other validation or work: an unauthorized
# invocation must be refused for AUTHORIZATION reasons, and must not reveal or
# act on configuration details first.
$restorePaidEnv = $null
$restoreKeyEnv = $null
if (-not $DryRunOnly) {
    if (-not $ConfirmPaidRun) {
        Write-Host "REFUSING: this runner makes REAL BILLED provider calls." -ForegroundColor Red
        Write-Host "Pass -ConfirmPaidRun and set RUN_PAID_BENCHMARKS=1 only under explicit authorization."
        exit $EXIT_REFUSED
    }
    # RUN_PAID_BENCHMARKS is the AUTHORIZATION and must already be set by the
    # operator. The runner must never grant itself the missing flag.
    if ($env:RUN_PAID_BENCHMARKS -ne "1") {
        Write-Host "REFUSING: RUN_PAID_BENCHMARKS=1 is required — an API key and -ConfirmPaidRun are NOT authorization." -ForegroundColor Red
        Write-Host "The operator must set it explicitly; this runner never sets it for itself."
        exit $EXIT_REFUSED
    }
    $key = [Environment]::GetEnvironmentVariable($ApiKeyEnv)
    if (-not $key) {
        Write-Host "REFUSING: environment variable $ApiKeyEnv is required (never passed as a parameter)." -ForegroundColor Red
        exit $EXIT_CONFIG
    }
    # The child CLI reads OPENAI_API_KEY. If the operator named a different
    # variable, propagate it EXPLICITLY for the child and restore the parent
    # environment afterwards. The key never enters argv or any file.
    if ($ApiKeyEnv -ne "OPENAI_API_KEY") {
        $restoreKeyEnv = [Environment]::GetEnvironmentVariable("OPENAI_API_KEY")
        $env:OPENAI_API_KEY = $key
    }
    # TPM/rate-limit friendly: more retries, longer backoff (Retry-After wins).
    $env:OPENAI_MAX_RETRIES = "8"
    $env:OPENAI_RETRY_DELAY_MS = "3000"
    $env:OPENAI_REQUEST_TIMEOUT_MS = "300000"
}

# --- Suite input validation (before ANY case executes) ---------------------
$suiteNames = @($Suites.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })
if ($suiteNames.Count -eq 0) {
    Write-Error "-Suites must name at least one suite"
    exit $EXIT_CONFIG
}
foreach ($name in $suiteNames) {
    # A suite name is an identifier, never a path: no separators, no traversal.
    if ($name -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]*$') {
        Write-Host "REFUSING: unsafe suite name '$name' (expected a simple identifier)" -ForegroundColor Red
        exit $EXIT_CONFIG
    }
}
$missingSuites = @($suiteNames | Where-Object { -not (Test-Path (Join-Path $CasesRoot $_)) })
if ($missingSuites.Count -gt 0) {
    Write-Host "REFUSING: suite source missing: $($missingSuites -join ', ') (under $CasesRoot)" -ForegroundColor Red
    exit $EXIT_CONFIG
}

# --- Root containment ------------------------------------------------------
$rootAbs = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $Root))
$repoAbs = [System.IO.Path]::GetFullPath($repoRoot)
if (-not $rootAbs.StartsWith($repoAbs, [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-Host "REFUSING: -Root must resolve inside the repository ($repoAbs); got $rootAbs" -ForegroundColor Red
    exit $EXIT_CONFIG
}

# --- Identity --------------------------------------------------------------
$endpointDigest = Get-Sha256Hex $Endpoint
$sourceSha = "unknown"
try {
    $sourceSha = (& git rev-parse HEAD 2>$null | Select-Object -First 1)
    if (-not $sourceSha) { $sourceSha = "unknown" }
} catch {
    $sourceSha = "unknown"
}
$identity = @("--provider", $Provider, "--model", $Model, "--endpoint", $Endpoint)
$budget = @(
    "--max-model-calls", "60",
    "--max-estimated-tokens", "1000000",
    "--max-estimated-cost-usd", "2.0"
)
$suitesArg = ($suiteNames -join ",")

$resultsDir = Join-Path $rootAbs "results"
$stagingDir = Join-Path $rootAbs "staging"
$quarantineDir = Join-Path $rootAbs "quarantine"
$manifest = Join-Path $rootAbs "manifest.jsonl"
$progress = Join-Path $rootAbs "progress.txt"
$statusPath = Join-Path $rootAbs "campaign-status.json"

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

# The frozen identity of ONE case: suite/caseId + provider/model + endpoint
# digest + plan digest + source SHA. A report is only reusable when every one of
# these still matches, so a model/endpoint/source change can never be mistaken
# for the same experiment.
function Get-CaseIdentity([string]$suite, [string]$caseId, [string]$planDigest) {
    return Get-Sha256Hex "$suite|$caseId|$Provider|$Model|$endpointDigest|$planDigest|$sourceSha"
}

# Read the resume manifest into a lookup keyed by "<suite>/<caseId>".
function Read-Manifest {
    $byKey = @{}
    if (-not (Test-Path $manifest)) { return $byKey }
    foreach ($line in (Get-Content $manifest | Where-Object { $_ -ne "" })) {
        try { $rec = $line | ConvertFrom-Json } catch { continue }
        if (-not $rec.suite -or -not $rec.caseId) { continue }
        $k = "$($rec.suite)/$($rec.caseId)"
        if (-not $byKey.ContainsKey($k)) { $byKey[$k] = @() }
        $byKey[$k] += $rec
    }
    return $byKey
}

# Validate a report's OWN contents against the expected identity. Returns $null
# when the report is structurally valid, else a short reason string.
function Test-ReportValid([string]$reportPath, [string]$suite, [string]$caseId) {
    if (-not (Test-Path $reportPath)) { return "report missing" }
    $raw = Get-Content $reportPath -Raw
    if (-not $raw -or $raw.Trim() -eq "") { return "report empty" }
    try {
        $doc = $raw | ConvertFrom-Json
    } catch {
        return "report JSON truncated/invalid"
    }
    if (-not $doc.meta -or -not $doc.results) { return "report schema missing meta/results" }
    if ($doc.meta.suite -ne $suite) { return "report suite '$($doc.meta.suite)' != '$suite'" }
    $first = @($doc.results)[0]
    if (-not $first) { return "report has no results" }
    if ($first.task_id -ne $caseId) { return "report task_id '$($first.task_id)' != '$caseId'" }
    if ($doc.manifest) {
        if ($doc.manifest.model -and $doc.manifest.model -ne $Model) {
            return "report model '$($doc.manifest.model)' != '$Model'"
        }
        if ($doc.manifest.provider -and $doc.manifest.provider -ne $Provider) {
            return "report provider '$($doc.manifest.provider)' != '$Provider'"
        }
    }
    return $null
}

# Isolate a case's suspicious artifacts WITHOUT altering the originals. The
# original R83/R84 evidence must stay byte-identical, so this COPIES and never
# moves or deletes: a quarantine is an audit record plus a block on reuse, not a
# destructive operation. The directory name is deterministic so repeated runs do
# not accumulate duplicates.
function Move-ToQuarantine([string]$suite, [string]$caseId, [string]$reason) {
    $src = Get-CaseOutDir $suite $caseId
    if (-not (Test-Path $src)) { return }
    $dest = Join-Path $quarantineDir "$suite-$caseId"
    if (Test-Path $dest) { return }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    "reason: $reason" | Set-Content -Path (Join-Path $dest "QUARANTINE.txt")
    Copy-Item -Recurse -Force (Join-Path $src "*") $dest -ErrorAction SilentlyContinue
}

# Run ONE case in an isolated single-case dir.
# Returns @{ error = <$null on success>; planDigest = <the frozen plan digest> }.
function Invoke-OneCase([string]$suite, [string]$caseId, [string]$caseSrc, [string]$outDir) {
    $work = Join-Path $stagingDir "$suite-$caseId"
    $caseAt = Join-Path $work $caseId
    try {
        if (Test-Path $work) { Remove-Item -Recurse -Force $work }
        New-Item -ItemType Directory -Force -Path $caseAt | Out-Null
        Copy-Item -Recurse -Force (Join-Path $caseSrc "*") $caseAt

        $dryFlags = @("benchmark", "--suite", $suite, "--cases", $work) + $identity + $budget + @("--dry-run")
        $dry = & node $cli @dryFlags 2>&1
        if ($LASTEXITCODE -ne 0) {
            return @{ error = "DRY-RUN FAILED ($LASTEXITCODE)"; planDigest = "" }
        }
        $digest = ($dry | Select-String '"planDigest"' | ForEach-Object { ($_ -split '"')[3] } | Select-Object -First 1)
        if (-not $digest) {
            return @{ error = "DRY-RUN produced no planDigest"; planDigest = "" }
        }
        if ($DryRunOnly) {
            return @{ error = $null; planDigest = $digest }
        }

        $execFlags = @("benchmark", "--suite", $suite, "--cases", $work) + $identity + $budget +
            @("--plan-digest", $digest, "--out", $outDir)
        $log = Join-Path $outDir "run.log"
        New-Item -ItemType Directory -Force -Path $outDir | Out-Null
        & node $cli @execFlags *>&1 | Tee-Object -FilePath $log | Out-Null
        $exit = $LASTEXITCODE
        if ($exit -ne 0) {
            return @{ error = "RUN EXIT $exit (report may still exist)"; planDigest = $digest }
        }
        $reportPath = Get-ReportPath $outDir $suite
        $invalid = Test-ReportValid $reportPath $suite $caseId
        if ($invalid) { return @{ error = "RUN EXIT 0 but $invalid"; planDigest = $digest } }
        return @{ error = $null; planDigest = $digest }
    } finally {
        # Staging is disposable ONLY because it is provably inside the root.
        if (Test-Path $work) { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue }
    }
}

# --- Discover the frozen case set -----------------------------------------
$suiteList = @()
$total = 0
foreach ($name in $suiteNames) {
    $path = Join-Path $CasesRoot $name
    $caseDirs = @(Get-ChildItem -Directory (Join-Path $path "*") | Where-Object { $_.Name -notlike ".*" } | Sort-Object Name)
    $suiteList += [pscustomobject]@{ name = $name; path = $path; cases = $caseDirs }
    $total += $caseDirs.Count
}

New-Item -ItemType Directory -Force -Path $resultsDir, $stagingDir, $quarantineDir | Out-Null
Write-ProgressLine "CAMPAIGN START suites=$($suiteNames.Count) totalCases=$total dryRunOnly=$($DryRunOnly.IsPresent) limitCases=$LimitCases sourceSha=$sourceSha endpointDigest=$($endpointDigest.Substring(0,12))"

$manifestIndex = Read-Manifest

# --- Main loop -------------------------------------------------------------
$attempted = 0       # cases STARTED by this invocation
$completed = 0       # cases that succeeded in this invocation
$failed = 0          # cases that failed in this invocation
$resumed = 0         # cases skipped because valid evidence already existed
$resumedLegacy = 0   # of those, records whose identity could NOT be re-verified
$quarantined = 0     # cases whose evidence was suspicious (operator decision)
$outcomeUnknown = @()
$stop = $false

foreach ($s in $suiteList) {
    if ($stop) { break }
    foreach ($c in $s.cases) {
        if ($stop) { break }
        $caseId = $c.Name
        $outDir = Get-CaseOutDir $s.name $caseId
        $reportPath = Get-ReportPath $outDir $s.name
        $key = "$($s.name)/$caseId"
        $records = if ($manifestIndex.ContainsKey($key)) { $manifestIndex[$key] } else { @() }
        $lastOk = $records | Where-Object { $_.ok } | Select-Object -Last 1

        $hasReport = Test-Path $reportPath
        $reportReason = if ($hasReport) { Test-ReportValid $reportPath $s.name $caseId } else { "report missing" }

        if ($lastOk -and $hasReport -and $null -eq $reportReason) {
            # Both halves exist. The stored identity must still match.
            #
            # A record written by the PRE-R89 runner (or by the committed R84
            # fixture) carries no `identity`, so its experiment identity cannot
            # be re-verified. Such a record is LEGACY: it is trusted only for the
            # same model/provider it names, and it is counted separately so a
            # report can never present unverifiable legacy reuse as verified
            # evidence.
            $recordedIdentity = $lastOk.identity
            if (-not $recordedIdentity) {
                $legacyOk = $true
                if ($lastOk.model -and $lastOk.model -ne $Model) { $legacyOk = $false }
                if ($lastOk.provider -and $lastOk.provider -ne $Provider) { $legacyOk = $false }
                if ($legacyOk) {
                    $resumed++
                    $resumedLegacy++
                    Write-ProgressLine "[$key] SKIP already stored (LEGACY record: identity not verifiable)"
                    continue
                }
                $quarantined++
                Move-ToQuarantine $s.name $caseId "legacy record names a different model/provider"
                Write-ProgressLine "[$key] QUARANTINE legacy record does not match this experiment"
                $outcomeUnknown += $key
                continue
            }
            if ($recordedIdentity -eq (Get-CaseIdentity $s.name $caseId $lastOk.planDigest)) {
                $resumed++
                Write-ProgressLine "[$key] SKIP already stored (identity verified)"
                continue
            }
            $quarantined++
            Move-ToQuarantine $s.name $caseId "identity changed since the recorded run"
            Write-ProgressLine "[$key] QUARANTINE identity changed — old evidence isolated, not reused"
            $outcomeUnknown += $key
            continue
        }
        if ($lastOk -and -not $hasReport) {
            $quarantined++
            Move-ToQuarantine $s.name $caseId "manifest says ok but the report is missing"
            Write-ProgressLine "[$key] QUARANTINE manifest without report — OUTCOME_UNKNOWN"
            $outcomeUnknown += $key
            continue
        }
        if ($hasReport -and -not $lastOk) {
            if ($AdoptOrphanReport -and $null -eq $reportReason) {
                $resumed++
                Write-ProgressLine "[$key] ADOPTED orphan report by explicit operator decision"
                continue
            }
            $quarantined++
            Move-ToQuarantine $s.name $caseId "report exists without a manifest record"
            Write-ProgressLine "[$key] QUARANTINE report without manifest — OUTCOME_UNKNOWN (no automatic re-bill)"
            $outcomeUnknown += $key
            continue
        }
        if ($hasReport -and $null -ne $reportReason) {
            $quarantined++
            Move-ToQuarantine $s.name $caseId $reportReason
            Write-ProgressLine "[$key] QUARANTINE $reportReason — OUTCOME_UNKNOWN"
            $outcomeUnknown += $key
            continue
        }

        if ($LimitCases -gt 0 -and $attempted -ge $LimitCases) {
            Write-ProgressLine "LIMITCASES=$LimitCases reached — stopping (PARTIAL)"
            $stop = $true
            break
        }

        Write-ProgressLine "[$key] START"
        $start = Get-Date
        $caseError = $null
        $planDigest = ""
        try {
            $result = Invoke-OneCase $s.name $caseId $c.FullName $outDir
            $caseError = $result.error
            $planDigest = $result.planDigest
        } catch {
            $caseError = "UNEXPECTED: $($_.Exception.Message)"
        }
        $elapsed = [math]::Round(((Get-Date) - $start).TotalSeconds, 0)
        $attempted++
        if ($caseError) {
            $failed++
            Write-ProgressLine "[$key] FAIL after ${elapsed}s ($caseError)"
        } else {
            $completed++
            Write-ProgressLine "[$key] DONE after ${elapsed}s"
        }
        # Persist the attempt IMMEDIATELY (resume record). `error` is a short
        # status string only — never provider output, never a key, never the
        # endpoint (only its digest).
        $entry = [pscustomobject]@{
            ts         = (Get-Date -Format o)
            suite      = $s.name
            caseId     = $caseId
            ok         = ($null -eq $caseError)
            error      = $caseError
            elapsedSec = $elapsed
            planDigest = $planDigest
            identity   = (Get-CaseIdentity $s.name $caseId $planDigest)
            sourceSha  = $sourceSha
            model      = $Model
            provider   = $Provider
        } | ConvertTo-Json -Compress
        Add-Content -Path $manifest -Value $entry
        if (-not $DryRunOnly) { Start-Sleep -Seconds 10 }
    }
}

# --- Final status ----------------------------------------------------------
$status = "COMPLETE"
$exitCode = $EXIT_OK
if ($outcomeUnknown.Count -gt 0) {
    $status = "PARTIAL"
    $exitCode = $EXIT_PARTIAL
}
if ($stop) {
    $status = "PARTIAL"
    if ($exitCode -eq $EXIT_OK) { $exitCode = $EXIT_PARTIAL }
}
if ($failed -gt 0) {
    $status = if ($status -eq "COMPLETE") { "FAILED" } else { $status }
    if ($exitCode -eq $EXIT_OK -or $exitCode -eq $EXIT_PARTIAL) { $exitCode = $EXIT_FAILED }
}

# Offline evidence chain: re-derive every number from the raw per-case reports.
# A validation failure must RAISE the exit code, never be overwritten by a
# later success.
if (-not $DryRunOnly -and $status -ne "PARTIAL") {
    $validateArgs = @("benchmark", "campaign", "validate", $rootAbs, "--cases", $CasesRoot, "--suites", $suitesArg)
    & node $cli @validateArgs
    if ($LASTEXITCODE -ne 0) {
        Write-ProgressLine "CAMPAIGN VALIDATION FAILED ($LASTEXITCODE) — the evidence chain is not reproducible"
        $status = "INVALID"
        $exitCode = $EXIT_FAILED
    }
}

$statusDoc = [pscustomobject]@{
    status         = $status
    exitCode       = $exitCode
    attempted      = $attempted
    completed      = $completed
    failed         = $failed
    resumed        = $resumed
    resumedLegacy  = $resumedLegacy
    quarantined    = $quarantined
    outcomeUnknown = @($outcomeUnknown)
    totalCases     = $total
    limitCases     = $LimitCases
    suites         = $suiteNames
    sourceSha      = $sourceSha
} | ConvertTo-Json -Depth 4
Set-Content -Path $statusPath -Value $statusDoc

# `done` counts every case this invocation considers finished (freshly completed
# or resumed), matching the historical runner's progress vocabulary. `done` and
# `failed` are kept ADJACENT so the historical progress-line contract holds.
$done = $completed + $resumed
Write-ProgressLine "CAMPAIGN END status=$status totalCases=$total done=$done failed=$failed attempted=$attempted completed=$completed resumed=$resumed legacyResumed=$resumedLegacy quarantined=$quarantined exit=$exitCode"

# Restore the parent environment if we propagated a custom key variable.
if ($restoreKeyEnv -ne $null) { $env:OPENAI_API_KEY = $restoreKeyEnv }
if ($restorePaidEnv -ne $null) { $env:RUN_PAID_BENCHMARKS = $restorePaidEnv }

exit $exitCode
