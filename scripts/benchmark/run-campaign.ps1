#!/usr/bin/env pwsh
<#
.SYNOPSIS
  E4-R84/R89/R94 — versioned, sanitized, resumable serial benchmark campaign runner.

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

  Interruption recovery (E4-R94 / findings B and C):
    Resume used to hand `Get-CaseIdentity` the OLD `lastOk.planDigest`, so the
    stored identity was compared against ITSELF: a case whose source changed at
    an unchanged git SHA still matched, and the report's own bytes were never
    hashed. And the attempt record was written only AFTER the case finished, so
    a crash between "the request went out" and "the outcome was persisted" left
    no trace and the next run could silently re-bill.

    Resume now RE-OBSERVES the current identity: for every case that claims to
    be complete it regenerates the zero-call plan digest from the CURRENT case
    source (a free `--dry-run`), and it compares the stored identity AND the
    stored report content hash against the files on disk.

    A small explicit ATTEMPT STATE MACHINE closes the interruption window:

        planned -> in_flight -> completed
                             -> failed_before_dispatch
                             -> outcome_unknown

    The `in_flight` record is written ATOMICALLY (temp file + rename) BEFORE any
    subprocess that could reach a provider is started. It carries the
    experimentId, suite/case, arm, attemptId, currentPlanDigest and status; the
    terminal record adds the report content hash.

    The state machine tracks the ATTEMPT; the manifest tracks the CASE outcome.
    `completed` therefore means "this attempt reached a terminal state", which
    includes a child that ran to completion and reported failure (the manifest
    records `ok=false` for that).

    A dispatched attempt with no durable, valid report is `outcome_unknown`:
    a request may have been sent, so it is never retried automatically and the
    run reports PARTIAL. Recovery from `outcome_unknown` requires an explicit
    operator decision; this runner will not silently pay again. Budget
    reservation is NOT automatically returned.

    The manifest is the durable completion ledger and the attempt state is the
    in-flight intent; BOTH must agree before a case is credited. A manifest that
    cannot be parsed line-by-line is a stable DAMAGED state (the original file
    is preserved byte-for-byte, never rewritten) and the run fails closed rather
    than skipping anything.

    A single-instance lock per campaign root prevents two runners from
    recovering the same campaign at once. A lock whose owning PID is gone is
    STALE (that is precisely the crash this contract exists for) and is taken
    over with a recorded notice.

    Atomic rename and durability are described in terms of what the LOCAL
    filesystem actually provides. This is NOT a cross-network exactly-once
    guarantee, and no such guarantee is claimed.

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
    [ValidateRange(0, 600)][int]$InterCaseDelaySec = 10,
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

# Hash a FILE's bytes (E4-R94): the report's own content, not its metadata.
function Get-FileSha256Hex([string]$path) {
    if (-not (Test-Path $path)) { return "" }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($path)
        try {
            return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant()
        } finally {
            $stream.Dispose()
        }
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

# A lexical prefix check is not enough: a junction or symlink ANYWHERE between the
# repository root and the output root redirects every write — results, staging,
# quarantine, and the attempt state — somewhere else, while the path still LOOKS
# contained. Walk the real components and refuse if any is a reparse point.
function Test-ReparsePointInPath([string]$base, [string]$target) {
    $rel = $target.Substring($base.Length).TrimStart('\', '/')
    $cur = $base
    foreach ($part in ($rel -split '[\\/]' | Where-Object { $_ -ne "" })) {
        $cur = Join-Path $cur $part
        if (-not (Test-Path -LiteralPath $cur)) { continue }
        try {
            $item = Get-Item -LiteralPath $cur -Force -ErrorAction Stop
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return $cur }
        } catch { return $cur }
    }
    return $null
}
$reparse = Test-ReparsePointInPath $repoAbs $rootAbs
if ($reparse) {
    Write-Host "REFUSING: the output root passes through a reparse point (junction/symlink): $reparse" -ForegroundColor Red
    Write-Host "          Every write below it could land outside the repository." -ForegroundColor Red
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

# The experiment id: everything that makes this campaign a DIFFERENT experiment.
# It deliberately excludes the key and the raw endpoint (only the digest).
$experimentId = Get-Sha256Hex "$Provider|$Model|$endpointDigest|$suitesArg|$sourceSha|$($budget -join ',')"

$resultsDir = Join-Path $rootAbs "results"
$stagingDir = Join-Path $rootAbs "staging"
$quarantineDir = Join-Path $rootAbs "quarantine"
$manifest = Join-Path $rootAbs "manifest.jsonl"
$progress = Join-Path $rootAbs "progress.txt"
$statusPath = Join-Path $rootAbs "campaign-status.json"
# E4-R94: the durable attempt state and the single-instance lock.
$statePath = Join-Path $rootAbs "attempt-state.json"
$lockPath = Join-Path $rootAbs ".runner.lock"

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
#
# E4-R94 (finding B): `$planDigest` MUST be the digest re-derived from the
# CURRENT case source. The pre-R94 caller passed the STORED digest back in, which
# made this comparison a tautology.
function Get-CaseIdentity([string]$suite, [string]$caseId, [string]$planDigest) {
    return Get-Sha256Hex "$suite|$caseId|$Provider|$Model|$endpointDigest|$planDigest|$sourceSha"
}

# --- Durable attempt state (E4-R94) ----------------------------------------
#
# Atomic on the LOCAL filesystem: write a temp file in the same directory, then
# rename over the target. Same-volume rename is atomic on NTFS and on POSIX; no
# cross-network guarantee is claimed.
function Write-JsonAtomic([string]$path, $obj) {
    $tmp = "$path.tmp"
    Set-Content -Path $tmp -Value ($obj | ConvertTo-Json -Depth 8) -NoNewline
    Move-Item -Force $tmp $path
}

$script:attempts = @()
function Read-AttemptState {
    $script:attempts = @()
    if (-not (Test-Path $statePath)) { return }
    $doc = $null
    try { $doc = Get-Content $statePath -Raw | ConvertFrom-Json } catch { $doc = $null }
    if ($null -eq $doc) { return }
    if ($null -eq $doc.attempts) { return }
    $script:attempts = @($doc.attempts)
}

function Get-AttemptRecord([string]$key) {
    $hits = @($script:attempts | Where-Object { "$($_.suite)/$($_.caseId)" -eq $key })
    if ($hits.Count -eq 0) { return $null }
    return $hits[-1]
}

function Save-AttemptState {
    Write-JsonAtomic $statePath ([pscustomobject]@{
        schemaVersion = 1
        experimentId  = $experimentId
        sourceSha     = $sourceSha
        updatedAt     = (Get-Date -Format o)
        attempts      = @($script:attempts)
    })
}

# Record one attempt transition. `arm` is "single": this runner executes ONE
# configuration per campaign, so the arm concept only becomes two-valued in the
# R92/R97 driver.
function Set-Attempt([string]$suite, [string]$caseId, [string]$attemptId,
                     [string]$planDigest, [string]$status, [string]$reportHash, [string]$detail) {
    $key = "$suite/$caseId"
    $kept = @($script:attempts | Where-Object { "$($_.suite)/$($_.caseId)" -ne $key })
    $script:attempts = $kept + @([pscustomobject]@{
        suite             = $suite
        caseId            = $caseId
        arm               = "single"
        attemptId         = $attemptId
        currentPlanDigest = $planDigest
        status            = $status
        reportHash        = $reportHash
        sourceSha         = $sourceSha
        experimentId      = $experimentId
        detail            = $detail
        at                = (Get-Date -Format o)
    })
    Save-AttemptState
}

# --- Single-instance lock (E4-R94) -----------------------------------------
#
# CreateNew is the atomic test-and-set. A lock whose owning PID no longer exists
# is STALE — that is exactly the crash this contract recovers from — so it is
# taken over with a recorded notice rather than blocking recovery forever.
function Acquire-RunnerLock {
    while ($true) {
        try {
            $fs = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::CreateNew,
                                         [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
            try {
                $bytes = [System.Text.Encoding]::UTF8.GetBytes("pid=$PID`nstartedAt=$((Get-Date).ToString('o'))`n")
                $fs.Write($bytes, 0, $bytes.Length)
            } finally { $fs.Dispose() }
            return $true
        } catch {
            $owner = $null
            try {
                $txt = Get-Content $lockPath -Raw -ErrorAction SilentlyContinue
                if ($txt -match 'pid=(\d+)') { $owner = [int]$Matches[1] }
            } catch { $owner = $null }
            $alive = $false
            if ($owner) {
                try { $alive = $null -ne (Get-Process -Id $owner -ErrorAction Stop) } catch { $alive = $false }
            }
            if (-not $alive) {
                Write-ProgressLine "STALE LOCK from pid $owner — taking over (the previous run did not finish cleanly)"
                Remove-Item -Force $lockPath -ErrorAction SilentlyContinue
                continue
            }
            return $false
        }
    }
}

# Read the resume manifest into a lookup keyed by "<suite>/<caseId>".
#
# E4-R94 (finding C): a line that cannot be parsed is NO LONGER skipped with
# `catch { continue }`. The manifest is the durable completion ledger, so a
# damaged ledger is a stable DAMAGED state: the original file is preserved
# untouched and the run fails closed instead of silently skipping.
function Read-Manifest {
    $byKey = @{}
    $conflicts = @{}
    $damaged = $false
    $reason = ""
    if (-not (Test-Path $manifest)) {
        return @{ byKey = $byKey; conflicts = $conflicts; damaged = $false; reason = "" }
    }
    $n = 0
    foreach ($line in (Get-Content $manifest)) {
        $n++
        if ($line -eq "") { continue }
        $rec = $null
        try { $rec = $line | ConvertFrom-Json } catch { $rec = $null }
        if ($null -eq $rec) {
            $damaged = $true
            if (-not $reason) { $reason = "line $n is not valid JSON (the manifest is truncated or corrupt)" }
            continue
        }
        if (-not $rec.suite -or -not $rec.caseId) {
            $damaged = $true
            if (-not $reason) { $reason = "line $n names no suite/caseId" }
            continue
        }
        $k = "$($rec.suite)/$($rec.caseId)"
        if (-not $byKey.ContainsKey($k)) { $byKey[$k] = @() }
        $byKey[$k] += $rec
    }
    # Duplicate/conflicting completed records: two `ok` records for one case that
    # disagree about identity or report content cannot both be the truth. The
    # ledger no longer has ONE authoritative answer, so this is the same class of
    # defect as a truncated line — a stable DAMAGED state that fails closed —
    # rather than an unknown OUTCOME that a case-level quarantine could absorb.
    foreach ($k in $byKey.Keys) {
        $oks = @($byKey[$k] | Where-Object { $_.ok })
        if ($oks.Count -lt 2) { continue }
        $first = $oks[0]
        foreach ($other in $oks[1..($oks.Count - 1)]) {
            if ($other.identity -ne $first.identity -or $other.reportHash -ne $first.reportHash) {
                $conflicts[$k] = "$($oks.Count) conflicting completed records disagree about identity or report content"
                $damaged = $true
                if (-not $reason) { $reason = "case $k has $($oks.Count) conflicting completed records (identity or report content disagree)" }
                break
            }
        }
    }
    return @{ byKey = $byKey; conflicts = $conflicts; damaged = $damaged; reason = $reason }
}

# Validate a report's OWN contents against the expected identity. Returns $null
# when the report is structurally valid, else a short reason string.
#
# E4-R94: the COMPLETE result set is checked, not just the first entry.
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
    $results = @($doc.results)
    if ($results.Count -eq 0) { return "report has no results" }
    $i = 0
    foreach ($r in $results) {
        $i++
        if ($r.task_id -ne $caseId) { return "report result #$i task_id '$($r.task_id)' != '$caseId'" }
    }
    if ($doc.summary -and $null -ne $doc.summary.total -and [int]$doc.summary.total -ne $results.Count) {
        return "report summary.total '$($doc.summary.total)' != $($results.Count) results"
    }
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

# --- Case staging + the FREE re-observation dry run (E4-R94) ---------------
function Clear-CaseStaging([string]$suite, [string]$caseId) {
    $work = Join-Path $stagingDir "$suite-$caseId"
    if (Test-Path $work) { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue }
}

function Initialize-CaseStaging([string]$suite, [string]$caseId, [string]$caseSrc) {
    $work = Join-Path $stagingDir "$suite-$caseId"
    $caseAt = Join-Path $work $caseId
    if (Test-Path $work) { Remove-Item -Recurse -Force $work }
    New-Item -ItemType Directory -Force -Path $caseAt | Out-Null
    Copy-Item -Recurse -Force (Join-Path $caseSrc "*") $caseAt
    return $work
}

$script:planDigestCache = @{}

# Re-derive the CURRENT zero-call plan digest for a case. This is a free
# `--dry-run`: it never reaches a provider, and it is the ONLY way the runner can
# notice that a case's content changed at an unchanged git SHA.
function Get-PlanDigestCached([string]$suite, [string]$caseId, [string]$caseSrc) {
    $key = "$suite/$caseId"
    if ($script:planDigestCache.ContainsKey($key)) { return $script:planDigestCache[$key] }
    $result = @{ digest = ""; error = $null; work = "" }
    try {
        $work = Initialize-CaseStaging $suite $caseId $caseSrc
        $result.work = $work
        $dryFlags = @("benchmark", "--suite", $suite, "--cases", $work) + $identity + $budget + @("--dry-run")
        $dry = & node $cli @dryFlags 2>&1
        if ($LASTEXITCODE -ne 0) {
            $result.error = "DRY-RUN FAILED ($LASTEXITCODE)"
        } else {
            $digest = ($dry | Select-String '"planDigest"' | ForEach-Object { ($_ -split '"')[3] } | Select-Object -First 1)
            if (-not $digest) { $result.error = "DRY-RUN produced no planDigest" } else { $result.digest = $digest }
        }
    } catch {
        $result.error = "DRY-RUN THREW: $($_.Exception.Message)"
    }
    $script:planDigestCache[$key] = $result
    return $result
}

# Run the ACTUAL (potentially billable) child. The caller must already have
# written the durable `in_flight` intent.
function Invoke-CaseExecution([string]$suite, [string]$caseId, [string]$outDir, [string]$planDigest) {
    $work = Join-Path $stagingDir "$suite-$caseId"
    $execFlags = @("benchmark", "--suite", $suite, "--cases", $work) + $identity + $budget +
        @("--plan-digest", $planDigest, "--out", $outDir)
    $log = Join-Path $outDir "run.log"
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    & node $cli @execFlags *>&1 | Tee-Object -FilePath $log | Out-Null
    $exit = $LASTEXITCODE
    if ($exit -ne 0) {
        return "RUN EXIT $exit (report may still exist)"
    }
    return $null
}

# Append one durable attempt record to the resume manifest. `error` is a short
# status string only — never provider output, never a key, never the endpoint
# (only its digest).
function Add-ManifestRecord([string]$suite, [string]$caseId, [bool]$ok, [string]$error,
                            [int]$elapsedSec, [string]$planDigest, [string]$attemptId,
                            [string]$reportHash, [bool]$dryRun) {
    $entry = [pscustomobject]@{
        ts         = (Get-Date -Format o)
        suite      = $suite
        caseId     = $caseId
        ok         = $ok
        error      = $error
        elapsedSec = $elapsedSec
        planDigest = $planDigest
        identity   = (Get-CaseIdentity $suite $caseId $planDigest)
        reportHash = $reportHash
        attemptId  = $attemptId
        experimentId = $experimentId
        dryRun     = $dryRun
        sourceSha  = $sourceSha
        model      = $Model
        provider   = $Provider
    } | ConvertTo-Json -Compress
    Add-Content -Path $manifest -Value $entry
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

New-Item -ItemType Directory -Force -Path $rootAbs, $resultsDir, $stagingDir, $quarantineDir | Out-Null

# --- Single-instance lock (E4-R94) -----------------------------------------
# Acquired only AFTER the authorization gate and suite validation, so a refused
# invocation still creates no campaign directory at all.
if (-not (Acquire-RunnerLock)) {
    Write-Host "REFUSING: another runner already holds the campaign lock for $rootAbs." -ForegroundColor Red
    Write-Host "Two runners recovering one campaign could double-start a case. Wait for it to finish, or remove a stale lock."
    exit $EXIT_REFUSED
}

Write-ProgressLine "CAMPAIGN START suites=$($suiteNames.Count) totalCases=$total dryRunOnly=$($DryRunOnly.IsPresent) limitCases=$LimitCases sourceSha=$sourceSha endpointDigest=$($endpointDigest.Substring(0,12)) experimentId=$($experimentId.Substring(0,12)) pid=$PID"

Read-AttemptState
$manifestIndex = Read-Manifest
$manifestDamaged = $manifestIndex.damaged

# --- Main loop -------------------------------------------------------------
$attempted = 0       # cases STARTED by this invocation
$completed = 0       # cases that succeeded in this invocation
$failed = 0          # cases that failed in this invocation
$resumed = 0         # cases skipped because valid evidence already existed
$resumedLegacy = 0   # of those, records whose identity could NOT be re-verified
$quarantined = 0     # cases whose evidence was suspicious (operator decision)
$outcomeUnknown = @()
$stop = $false

if ($manifestDamaged) {
    Write-ProgressLine "MANIFEST DAMAGED: $($manifestIndex.reason) — refusing to resume or append; the original file is left untouched"
    $stop = $true
}

foreach ($s in $suiteList) {
    if ($stop) { break }
    foreach ($c in $s.cases) {
        if ($stop) { break }
        $caseId = $c.Name
        $key = "$($s.name)/$caseId"
        $outDir = Get-CaseOutDir $s.name $caseId
        $reportPath = Get-ReportPath $outDir $s.name
        $records = if ($manifestIndex.byKey.ContainsKey($key)) { $manifestIndex.byKey[$key] } else { @() }
        $lastOk = $records | Where-Object { $_.ok } | Select-Object -Last 1
        $stored = Get-AttemptRecord $key
        $storedStatus = if ($stored) { $stored.status } else { "" }

        $hasReport = Test-Path $reportPath
        $reportReason = if ($hasReport) { Test-ReportValid $reportPath $s.name $caseId } else { "report missing" }
        $reportOk = ($hasReport -and $null -eq $reportReason)
        $reportHash = if ($reportOk) { Get-FileSha256Hex $reportPath } else { "" }

        # Conflicting completed records block THIS case, not the whole campaign.
        if ($manifestIndex.conflicts.ContainsKey($key)) {
            $quarantined++
            Move-ToQuarantine $s.name $caseId $manifestIndex.conflicts[$key]
            Write-ProgressLine "[$key] QUARANTINE $($manifestIndex.conflicts[$key]) — OUTCOME_UNKNOWN"
            $outcomeUnknown += $key
            continue
        }

        # (1) A previous attempt was dispatched and never reached a terminal
        # state. A request may already have been sent: never retry automatically.
        if ($storedStatus -eq "outcome_unknown") {
            $failed++
            $outcomeUnknown += $key
            Write-ProgressLine "[$key] OUTCOME_UNKNOWN — a previous attempt may have reached the provider and has no terminal record; no automatic retry (explicit operator decision required)"
            continue
        }

        # (1b) A previous attempt was dispatched but the RUNNER died before it
        # could write a terminal state (so the state is still `in_flight`).
        # Offline re-registration is allowed ONLY when the evidence is
        # sufficient: the same experiment, the same plan digest re-observed from
        # the CURRENT case source, and a report that still validates. That path
        # makes NO provider call, so recovering never re-bills.
        if ($storedStatus -eq "in_flight") {
            $dig = Get-PlanDigestCached $s.name $caseId $c.FullName
            $substantiated = ($null -eq $dig.error) -and $reportOk -and
                ($stored.experimentId -eq $experimentId) -and
                ($stored.currentPlanDigest -eq $dig.digest)
            if ($substantiated) {
                $completed++
                Set-Attempt $s.name $caseId $stored.attemptId $dig.digest "completed" $reportHash "offline re-registration: the durable report matches the in-flight attempt"
                Add-ManifestRecord $s.name $caseId $true $null 0 $dig.digest $stored.attemptId $reportHash $false
                Write-ProgressLine "[$key] RECOVERED offline: the durable report matches the in-flight attempt (0 provider calls)"
            } else {
                $failed++
                $outcomeUnknown += $key
                Set-Attempt $s.name $caseId $stored.attemptId $dig.digest "outcome_unknown" "" "an in-flight attempt has no substantiated terminal record"
                Add-ManifestRecord $s.name $caseId $false "OUTCOME_UNKNOWN: in-flight attempt not substantiated" 0 $dig.digest $stored.attemptId "" $false
                Write-ProgressLine "[$key] OUTCOME_UNKNOWN — an attempt was dispatched and cannot be substantiated; no automatic retry"
            }
            Clear-CaseStaging $s.name $caseId
            continue
        }

        # (2) Both halves of the completion evidence exist.
        if ($lastOk -and $reportOk) {
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
            # A plan-only record can only satisfy another plan-only pass.
            if ($lastOk.dryRun -and -not $DryRunOnly) {
                Write-ProgressLine "[$key] the stored record is a DRY-RUN plan, not a real completion — running for real"
            } else {
                # RE-OBSERVE the current identity from the CURRENT case source.
                $dig = Get-PlanDigestCached $s.name $caseId $c.FullName
                if ($dig.error) {
                    $quarantined++
                    Move-ToQuarantine $s.name $caseId "the case no longer plans: $($dig.error)"
                    Write-ProgressLine "[$key] QUARANTINE re-observation failed: $($dig.error)"
                    $outcomeUnknown += $key
                    Clear-CaseStaging $s.name $caseId
                    continue
                }
                $expectedIdentity = Get-CaseIdentity $s.name $caseId $dig.digest
                if ($recordedIdentity -ne $expectedIdentity) {
                    $quarantined++
                    Move-ToQuarantine $s.name $caseId "the case plan/identity changed since the recorded run"
                    Write-ProgressLine "[$key] QUARANTINE identity changed (case content, tool config, provider/model/endpoint or source SHA) — old evidence isolated, not reused"
                    $outcomeUnknown += $key
                    Clear-CaseStaging $s.name $caseId
                    continue
                }
                if (-not $lastOk.reportHash) {
                    # A pre-R94 record: the identity is verified but the report's
                    # bytes were never bound, so this is weaker evidence and is
                    # counted as such rather than presented as verified.
                    $resumed++
                    $resumedLegacy++
                    Write-ProgressLine "[$key] SKIP already stored (pre-R94 record: identity verified, report content not hash-bound)"
                    Clear-CaseStaging $s.name $caseId
                    continue
                }
                if ($lastOk.reportHash -ne $reportHash) {
                    $quarantined++
                    Move-ToQuarantine $s.name $caseId "the report content changed since the recorded run"
                    Write-ProgressLine "[$key] QUARANTINE report content hash changed — the stored result is not the recorded one"
                    $outcomeUnknown += $key
                    Clear-CaseStaging $s.name $caseId
                    continue
                }
                $resumed++
                Write-ProgressLine "[$key] SKIP already stored (identity verified) — report content hash bound"
                Clear-CaseStaging $s.name $caseId
                continue
            }
        }
        if ($lastOk -and -not $hasReport) {
            $quarantined++
            Move-ToQuarantine $s.name $caseId "manifest says ok but the report is missing"
            Write-ProgressLine "[$key] QUARANTINE manifest without report — OUTCOME_UNKNOWN"
            $outcomeUnknown += $key
            continue
        }
        if ($hasReport -and -not $lastOk) {
            if ($AdoptOrphanReport -and $reportOk) {
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
        if ($hasReport -and -not $reportOk) {
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
        $attemptId = [guid]::NewGuid().ToString("n")
        $dig = Get-PlanDigestCached $s.name $caseId $c.FullName

        if ($dig.error) {
            # No billable child was ever started: this is the ONE state that may
            # be retried freely on the next invocation.
            $attempted++
            $failed++
            Set-Attempt $s.name $caseId $attemptId "" "failed_before_dispatch" "" $dig.error
            Add-ManifestRecord $s.name $caseId $false $dig.error 0 "" $attemptId "" $false
            Write-ProgressLine "[$key] FAIL before dispatch ($($dig.error)) — no billable child was started"
            Clear-CaseStaging $s.name $caseId
            continue
        }

        if ($DryRunOnly) {
            $attempted++
            $completed++
            Set-Attempt $s.name $caseId $attemptId $dig.digest "completed" "" "dry run only: no provider call"
            Add-ManifestRecord $s.name $caseId $true $null 0 $dig.digest $attemptId "" $true
            Write-ProgressLine "[$key] DONE (plan only, no provider call)"
            Clear-CaseStaging $s.name $caseId
            continue
        }

        # DURABLE IN-FLIGHT INTENT, written atomically BEFORE the billable child.
        # After this point a crash cannot be read as "the case never started".
        Set-Attempt $s.name $caseId $attemptId $dig.digest "in_flight" "" "dispatched"

        $caseError = $null
        try {
            $caseError = Invoke-CaseExecution $s.name $caseId $outDir $dig.digest
        } catch {
            $caseError = "UNEXPECTED: $($_.Exception.Message)"
        }
        $elapsed = [math]::Round(((Get-Date) - $start).TotalSeconds, 0)
        $attempted++

        # Did a durable, valid report survive? That is the ONLY thing that makes
        # the outcome knowable; without it the request may have been sent.
        $afterReason = if (Test-Path $reportPath) { Test-ReportValid $reportPath $s.name $caseId } else { "report missing" }
        $afterHash = if ($null -eq $afterReason) { Get-FileSha256Hex $reportPath } else { "" }

        if ($null -eq $afterReason) {
            # The attempt reached a terminal state. Whether the CASE succeeded is
            # recorded separately in the manifest.
            $completed++
            if ($caseError) {
                $failed++
                Set-Attempt $s.name $caseId $attemptId $dig.digest "completed" $afterHash "child exited non-zero with a durable report"
                Add-ManifestRecord $s.name $caseId $false $caseError $elapsed $dig.digest $attemptId $afterHash $false
                Write-ProgressLine "[$key] FAIL after ${elapsed}s ($caseError)"
            } else {
                Set-Attempt $s.name $caseId $attemptId $dig.digest "completed" $afterHash "clean exit, report verified"
                Add-ManifestRecord $s.name $caseId $true $null $elapsed $dig.digest $attemptId $afterHash $false
                Write-ProgressLine "[$key] DONE after ${elapsed}s"
            }
        } else {
            # Dispatched with no durable valid report: the outcome CANNOT be
            # known. Never auto-retry; the budget reservation is not returned.
            $failed++
            $outcomeUnknown += $key
            Set-Attempt $s.name $caseId $attemptId $dig.digest "outcome_unknown" "" $afterReason
            Add-ManifestRecord $s.name $caseId $false "OUTCOME_UNKNOWN: $afterReason" $elapsed $dig.digest $attemptId "" $false
            Write-ProgressLine "[$key] OUTCOME_UNKNOWN after ${elapsed}s ($afterReason) — a request may have been sent; no automatic retry"
        }
        Clear-CaseStaging $s.name $caseId
        if (-not $DryRunOnly -and $InterCaseDelaySec -gt 0) { Start-Sleep -Seconds $InterCaseDelaySec }
    }
}

# --- Final status ----------------------------------------------------------
$status = "COMPLETE"
$exitCode = $EXIT_OK
if ($manifestDamaged) {
    # A damaged completion ledger invalidates the resume decision itself, so the
    # evidence chain is not reproducible. Fail closed.
    $status = "INVALID"
    $exitCode = $EXIT_FAILED
}
if ($outcomeUnknown.Count -gt 0) {
    $status = "PARTIAL"
    $exitCode = $EXIT_PARTIAL
}
if ($stop -and -not $manifestDamaged) {
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
if (-not $DryRunOnly -and $status -ne "PARTIAL" -and -not $manifestDamaged) {
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
    manifestDamaged = $manifestDamaged
    experimentId   = $experimentId
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

# Release the single-instance lock.
Remove-Item -Force $lockPath -ErrorAction SilentlyContinue

# Restore the parent environment if we propagated a custom key variable.
if ($restoreKeyEnv -ne $null) { $env:OPENAI_API_KEY = $restoreKeyEnv }
if ($restorePaidEnv -ne $null) { $env:RUN_PAID_BENCHMARKS = $restorePaidEnv }

exit $exitCode
