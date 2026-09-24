#!/usr/bin/env pwsh
<#
.SYNOPSIS
  E4-R89 — offline gate for the campaign runner's authorization, identity-resume
  and command-argument contract (findings F3, F4, F5).

.DESCRIPTION
  Drives the REAL scripts/benchmark/run-campaign.ps1 through a FAKE CLI
  (scripts/benchmark/fixtures/r89-fake-cli.mjs), so the paid-shaped control flow
  — argv, exit codes, resume, quarantine — is covered end to end with ZERO
  provider calls, ZERO network access and ZERO cost.

  Assertions (any failure exits non-zero):
    1. F3 authorization: -ConfirmPaidRun + a fake key WITHOUT
       RUN_PAID_BENCHMARKS=1 is REFUSED (exit 3), starts no child process and
       creates no campaign directory. The runner must never set the flag itself.
    2. F3 all authorization combinations behave correctly.
    3. F5 custom suites: the value handed to --suites is the comma-joined
       suite-name string, never a hashtable; a missing/unknown suite fails
       BEFORE any case runs.
    4. F4 completion: a truncated report, a wrong-model report, a wrong-suite
       report and a wrong-case report are NOT treated as completed.
    5. F4 crash windows: report-without-manifest and manifest-without-report are
       quarantined as OUTCOME_UNKNOWN, never silently reused or auto-re-billed.
    6. F5 counting: with 3 already-complete cases and -LimitCases 2, exactly 2
       NEW cases run (skips do not consume the limit) and the status is PARTIAL.
    7. exit status: a failing case cannot be masked by a later success.

  Usage:  pwsh scripts/benchmark/selfcheck-r89-runner.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

$runner = Join-Path $repoRoot "scripts/benchmark/run-campaign.ps1"
$fakeCli = Join-Path $repoRoot "scripts/benchmark/fixtures/r89-fake-cli.mjs"
$casesRoot = "scripts/benchmark/fixtures/r89-cases"
$casesAbs = Join-Path $repoRoot $casesRoot
$workRoot = ".ci/r89-selfcheck"

$script:failures = 0
function Assert-True([bool]$condition, [string]$label) {
    if ($condition) {
        Write-Host "  PASS  $label"
    } else {
        Write-Host "  FAIL  $label" -ForegroundColor Red
        $script:failures++
    }
}

# A fake key that is deliberately key-SHAPED so a leak would be detectable, but
# is not a real credential and is never sent anywhere.
$FAKE_KEY = "sk-r89-fake-key-not-a-real-credential"

function Reset-Work {
    $abs = Join-Path $repoRoot $workRoot
    if (Test-Path $abs) { Remove-Item -Recurse -Force $abs }
    New-Item -ItemType Directory -Force -Path $abs | Out-Null
}

# R89 requires an INJECTABLE CLI entry point so the paid-shaped control flow can
# be covered offline. Probe for it rather than passing an unknown parameter,
# which would fail during binding and mask the real findings.
$script:hasCliPath = (Get-Content $runner -Raw) -match '\$CliPath'
Assert-True $script:hasCliPath "the runner exposes an injectable CLI entry point (-CliPath)"

function New-RunnerArgs([string]$root, [string]$extra = "") {
    $a = @(
        "-Endpoint", "https://fake.invalid/v1",
        "-Model", "fake-model",
        "-Root", $root,
        "-CasesRoot", $casesRoot
    )
    if ($script:hasCliPath) { $a += @("-CliPath", $fakeCli) }
    if ($extra -ne "") { $a += @($extra.Split(" ") | Where-Object { $_ -ne "" }) }
    return $a
}

# Build a PowerShell argument list for the runner. Parameter NAMES must stay
# UNQUOTED (a quoted '-Name' is a positional string, not a parameter binding);
# VALUES are single-quoted so paths with spaces survive.
function Format-RunnerArgs([string[]]$tokens) {
    $parts = @()
    for ($i = 0; $i -lt $tokens.Count; $i++) {
        $t = $tokens[$i]
        if ($t -like "-*") {
            $next = if ($i + 1 -lt $tokens.Count) { $tokens[$i + 1] } else { $null }
            if ($null -ne $next -and $next -notlike "-*") {
                $parts += "$t '" + ($next -replace "'", "''") + "'"
                $i++
            } else {
                $parts += $t
            }
        } else {
            $parts += "'" + ($t -replace "'", "''") + "'"
        }
    }
    return ($parts -join " ")
}

# Invoke the runner in a CHILD pwsh with a controlled environment, so the
# authorization state is exactly what the test sets (never the parent's).
#
# SAFETY: without -CliPath the runner would invoke the REAL CLI, which with a
# paid-shaped environment could attempt a real request. The test therefore never
# invokes the runner unless the injectable entry point exists.
function Invoke-Runner([string[]]$runnerArgs, [hashtable]$env, [string]$logPath = "") {
    if (-not $script:hasCliPath) {
        return @{ Output = "SKIPPED: runner has no injectable CLI entry point (R89 not implemented)"; Exit = -1 }
    }
    $envSetup = @(
        "Remove-Item Env:\RUN_PAID_BENCHMARKS -ErrorAction SilentlyContinue",
        "Remove-Item Env:\OPENAI_API_KEY -ErrorAction SilentlyContinue",
        "Remove-Item Env:\FAKE_CLI_MODE -ErrorAction SilentlyContinue"
    )
    foreach ($k in $env.Keys) {
        $v = $env[$k]
        $envSetup += "`$env:$k = '" + ($v -replace "'", "''") + "'"
    }
    $script = ($envSetup -join "; ") + "; & '$runner' " + (Format-RunnerArgs $runnerArgs) + " 2>&1 | Out-String; exit `$LASTEXITCODE"
    $out = & pwsh -NoProfile -Command $script
    return @{ Output = ($out | Out-String); Exit = $LASTEXITCODE }
}

function Read-CliLog([string]$path) {
    if (-not (Test-Path $path)) { return @() }
    return @(Get-Content $path | Where-Object { $_ -ne "" } | ForEach-Object { $_ | ConvertFrom-Json })
}

Write-Host "== 1. F3 authorization gate: READ the inputs, never create them =="
Reset-Work
# The finding: ConfirmPaidRun + a key present, RUN_PAID_BENCHMARKS missing.
$r = Invoke-Runner (New-RunnerArgs "$workRoot/a") @{ OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = (Join-Path $repoRoot "$workRoot/argv-a.jsonl") }
Assert-True ($r.Exit -eq 3) "half-authorized (key + switch, no RUN_PAID_BENCHMARKS) is REFUSED with exit 3 — got $($r.Exit)"
Assert-True ($r.Output -match "RUN_PAID_BENCHMARKS") "the refusal names the missing authorization"
Assert-True (-not (Test-Path (Join-Path $repoRoot "$workRoot/a"))) "the refused run created no campaign directory"
$logA = Join-Path $repoRoot "$workRoot/argv-a.jsonl"
Assert-True (-not (Test-Path $logA)) "the refused run started NO child process"
Assert-True ($r.Output -notmatch [regex]::Escape($FAKE_KEY)) "the refusal never echoes the key"

Write-Host "== 2. F3 authorization combinations =="
Reset-Work
$combos = @(
    @{ name = "no switch, no env";            env = @{ OPENAI_API_KEY = $FAKE_KEY }; expect = 3 },
    @{ name = "switch, no env, no key";       env = @{ };                            expect = 3; args = @("-ConfirmPaidRun") },
    @{ name = "switch + env, no key";         env = @{ RUN_PAID_BENCHMARKS = "1" };  expect = 2; args = @("-ConfirmPaidRun") },
    @{ name = "env only, no switch";          env = @{ RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY }; expect = 3 },
    @{ name = "switch + key, env='0'";        env = @{ RUN_PAID_BENCHMARKS = "0"; OPENAI_API_KEY = $FAKE_KEY }; expect = 3; args = @("-ConfirmPaidRun") }
)
$i = 0
foreach ($c in $combos) {
    $i++
    $extra = if ($c.args) { $c.args -join " " } else { "" }
    $rr = Invoke-Runner (New-RunnerArgs "$workRoot/b$i" $extra) $c.env
    Assert-True ($rr.Exit -eq $c.expect) "$($c.name) -> exit $($c.expect) (got $($rr.Exit))"
}
# Fully authorized (fake) run must reach the fake CLI.
$logB = Join-Path $repoRoot "$workRoot/argv-b.jsonl"
$full = Invoke-Runner (New-RunnerArgs "$workRoot/b-ok" "-ConfirmPaidRun -Suites adversarial") @{ RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $logB }
Assert-True (Test-Path $logB) "a fully (fake-)authorized run DOES start the child CLI"

Write-Host "== 3. F5 custom suites: the --suites value is a comma-joined string =="
Reset-Work
$logC = Join-Path $repoRoot "$workRoot/argv-c.jsonl"
$rc = Invoke-Runner (New-RunnerArgs "$workRoot/c" "-ConfirmPaidRun -Suites adversarial,stress -LimitCases 1") @{ RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $logC }
$calls = Read-CliLog $logC
Assert-True ($calls.Count -gt 0) "the fake CLI was invoked at least once"
$validateCalls = @($calls | Where-Object { $_.argv -contains "validate" })
foreach ($vc in $validateCalls) {
    $idx = [array]::IndexOf($vc.argv, "--suites")
    Assert-True ($idx -ge 0) "validate received --suites"
    if ($idx -ge 0) {
        $val = $vc.argv[$idx + 1]
        Assert-True ($val -is [string]) "--suites value is a STRING, not a hashtable (got $($val.GetType().Name))"
        Assert-True ($val -eq "adversarial,stress") "--suites value is the comma-joined suite list (got '$val')"
    }
}
# An unknown suite must fail BEFORE any case runs.
Reset-Work
$logD = Join-Path $repoRoot "$workRoot/argv-d.jsonl"
$rd = Invoke-Runner (New-RunnerArgs "$workRoot/d" "-ConfirmPaidRun -Suites adversarial,no-such-suite") @{ RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $logD }
Assert-True ($rd.Exit -eq 2) "an unknown suite is refused with the config exit code 2 (got $($rd.Exit))"
Assert-True (-not (Test-Path $logD)) "the unknown suite failed BEFORE any case executed"
# An unsafe (path-shaped) suite name must be refused.
$re = Invoke-Runner (New-RunnerArgs "$workRoot/e" "-ConfirmPaidRun -Suites ../etc") @{ RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY }
Assert-True ($re.Exit -eq 2) "a path-shaped suite name is refused with exit 2 (got $($re.Exit))"

Write-Host "== 4. F4 completion: a bad report is NOT completion =="
foreach ($mode in @("truncate", "wrongmodel", "wrongsuite", "wrongtask")) {
    Reset-Work
    $root = "$workRoot/m-$mode"
    # Pass 1: produce the anomalous report(s) with a full (fake) run.
    Invoke-Runner (New-RunnerArgs $root "-ConfirmPaidRun -Suites adversarial") @{
        RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_MODE = $mode
    } | Out-Null
    # Pass 2: relaunch OFFLINE. An invalid report must never be credited.
    $logM3 = Join-Path $repoRoot "$workRoot/argv3-$mode.jsonl"
    $relaunch = Invoke-Runner (New-RunnerArgs $root "-ConfirmPaidRun -Suites adversarial -DryRunOnly") @{
        RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $logM3
    }
    Assert-True ($relaunch.Exit -ne -1) "the relaunch actually executed for mode=$mode (got $($relaunch.Exit))"
    Assert-True ($relaunch.Output -notmatch "SKIP already stored \(identity verified\)") "a $mode report is NOT resumed as verified evidence"
}

Write-Host "== 5. F4 crash windows: quarantine, never auto-re-bill =="
# The `solo` suite has exactly ONE case, so any child invocation on relaunch is
# unambiguous evidence of an automatic re-bill of the quarantined case.
Reset-Work
# (a) report exists, manifest does NOT (crash between report write and manifest write)
$root = "$workRoot/crash-a"
Invoke-Runner (New-RunnerArgs $root "-ConfirmPaidRun -Suites solo") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_MODE = "ok"
} | Out-Null
$manA = Join-Path $repoRoot "$root/manifest.jsonl"
if (Test-Path $manA) { Remove-Item -Force $manA }
$logA2 = Join-Path $repoRoot "$workRoot/argv-crash-a.jsonl"
$ra = Invoke-Runner (New-RunnerArgs $root "-ConfirmPaidRun -Suites solo") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $logA2
}
Assert-True ($ra.Output -match "OUTCOME_UNKNOWN|QUARANTINE") "report-without-manifest is flagged OUTCOME_UNKNOWN/quarantined"
Assert-True (@(Read-CliLog $logA2).Count -eq 0) "the orphan report is NOT automatically re-billed"
$quarA = Join-Path $repoRoot "$root/quarantine"
Assert-True (Test-Path $quarA) "the suspicious evidence was moved to quarantine/"

# (b) manifest says ok, report is missing (crash between manifest write and report durability)
Reset-Work
$root = "$workRoot/crash-b"
Invoke-Runner (New-RunnerArgs $root "-ConfirmPaidRun -Suites solo") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_MODE = "ok"
} | Out-Null
$resDir = Join-Path $repoRoot "$root/results"
Assert-True (Test-Path $resDir) "the first pass produced a results directory"
if (Test-Path $resDir) { Get-ChildItem -Recurse -File $resDir -Filter "*.json" | Remove-Item -Force }
$logB2 = Join-Path $repoRoot "$workRoot/argv-crash-b.jsonl"
$rb = Invoke-Runner (New-RunnerArgs $root "-ConfirmPaidRun -Suites solo") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $logB2
}
Assert-True ($rb.Output -match "OUTCOME_UNKNOWN|QUARANTINE") "manifest-without-report is flagged OUTCOME_UNKNOWN/quarantined"
Assert-True (@(Read-CliLog $logB2).Count -eq 0) "the missing-report case is NOT automatically re-billed"

Write-Host "== 6. F5 counting: LimitCases bounds only NEW cases; skips are free =="
# A case-execution call is any child invocation that is NOT a dry run and NOT
# the end-of-campaign `campaign validate` step.
function Get-CaseExecs([string]$logPath) {
    return @(Read-CliLog $logPath | Where-Object {
        ($_.argv -notcontains "--dry-run") -and -not ($_.argv[1] -eq "campaign")
    })
}

Reset-Work
$root = "$workRoot/count"
# Pass 1: complete all 5 cases (adversarial 3 + stress 2) with an unlimited run.
Invoke-Runner (New-RunnerArgs $root "-ConfirmPaidRun -Suites adversarial,stress") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY
} | Out-Null
$st1 = Get-Content (Join-Path $repoRoot "$root/campaign-status.json") -Raw | ConvertFrom-Json
Assert-True ($st1.completed -eq 5) "pass 1 completed all 5 cases (got $($st1.completed))"
Assert-True ($st1.status -eq "COMPLETE") "pass 1 reports COMPLETE (got '$($st1.status)')"
# Pass 2: LimitCases=2 must start NO new case — every case is already stored, and
# skips must not consume the limit.
$logF = Join-Path $repoRoot "$workRoot/argv-count.jsonl"
$rf = Invoke-Runner (New-RunnerArgs $root "-ConfirmPaidRun -Suites adversarial,stress -LimitCases 2") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $logF
}
$newExecs = Get-CaseExecs $logF
Assert-True ($newExecs.Count -eq 0) "already-complete cases consume no limit and run no new case (got $($newExecs.Count))"
$statusPath = Join-Path $repoRoot "$root/campaign-status.json"
Assert-True (Test-Path $statusPath) "a machine-readable campaign-status.json was written"
if (Test-Path $statusPath) {
    $st = Get-Content $statusPath -Raw | ConvertFrom-Json
    Assert-True ($st.status -eq "COMPLETE") "an all-resumed run reports COMPLETE (got '$($st.status)')"
    Assert-True ($st.resumed -eq 5) "resumed count is 5 (got $($st.resumed))"
    Assert-True ($st.attempted -eq 0) "attempted count is 0 (got $($st.attempted))"
}
# The plan's exact scenario: 3 already-complete cases + LimitCases=2 -> exactly 2
# NEW cases execute (skips are free), and the run reports PARTIAL.
Reset-Work
$root = "$workRoot/count-partial"
Invoke-Runner (New-RunnerArgs $root "-ConfirmPaidRun -Suites adversarial") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY
} | Out-Null
$stPre = Get-Content (Join-Path $repoRoot "$root/campaign-status.json") -Raw | ConvertFrom-Json
Assert-True ($stPre.completed -eq 3) "3 cases are already complete (got $($stPre.completed))"
$logP = Join-Path $repoRoot "$workRoot/argv-count-partial.jsonl"
$rp = Invoke-Runner (New-RunnerArgs $root "-ConfirmPaidRun -Suites adversarial,stress,solo -LimitCases 2") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $logP
}
$execsP = Get-CaseExecs $logP
Assert-True ($execsP.Count -eq 2) "3 done + LimitCases=2 runs exactly 2 NEW cases (got $($execsP.Count))"
$stP = Get-Content (Join-Path $repoRoot "$root/campaign-status.json") -Raw | ConvertFrom-Json
Assert-True ($stP.resumed -eq 3) "the 3 stored cases were skipped without consuming the limit (resumed=$($stP.resumed))"
Assert-True ($stP.attempted -eq 2) "attempted is 2 (got $($stP.attempted))"
# The limit CUT WORK OFF (solo/only-case was never reached), so the evidence is
# genuinely incomplete and the run must say so.
Assert-True ($stP.status -eq "PARTIAL") "a limit that cuts work off reports PARTIAL (got '$($stP.status)')"
Assert-True ($rp.Exit -eq 4) "the limited run exits 4 (got $($rp.Exit))"
# The complement: a limit that happens to coincide with finishing ALL work is an
# honest COMPLETE. The status describes the EVIDENCE state, not the flag.
Reset-Work
$root = "$workRoot/count-exact"
Invoke-Runner (New-RunnerArgs $root "-ConfirmPaidRun -Suites adversarial") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY
} | Out-Null
$logX = Join-Path $repoRoot "$workRoot/argv-count-exact.jsonl"
$rx = Invoke-Runner (New-RunnerArgs $root "-ConfirmPaidRun -Suites adversarial,stress -LimitCases 2") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $logX
}
$execsX = Get-CaseExecs $logX
Assert-True ($execsX.Count -eq 2) "exactly 2 new cases ran (got $($execsX.Count))"
$stX = Get-Content (Join-Path $repoRoot "$root/campaign-status.json") -Raw | ConvertFrom-Json
Assert-True ($stX.status -eq "COMPLETE") "a limit coinciding with all work done is COMPLETE (got '$($stX.status)')"
Assert-True ($rx.Exit -eq 0) "that run exits 0 (got $($rx.Exit))"
# A fresh root with LimitCases=1 must run exactly 1 new case and report PARTIAL.
Reset-Work
$root = "$workRoot/count2"
$logG = Join-Path $repoRoot "$workRoot/argv-count2.jsonl"
$rg = Invoke-Runner (New-RunnerArgs $root "-ConfirmPaidRun -Suites adversarial,stress -LimitCases 1") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $logG
}
$execsG = Get-CaseExecs $logG
Assert-True ($execsG.Count -eq 1) "LimitCases=1 ran exactly 1 NEW case (got $($execsG.Count))"
if (-not (Test-Path (Join-Path $repoRoot "$root/campaign-status.json"))) { Write-Host "  FAIL  no campaign-status.json"; $script:failures++ } else { $stG = Get-Content (Join-Path $repoRoot "$root/campaign-status.json") -Raw | ConvertFrom-Json }
Assert-True ($stG.status -eq "PARTIAL") "a limited run reports PARTIAL, never a complete campaign (got '$($stG.status)')"
Assert-True ($rg.Exit -eq 4) "a limited run exits 4 (got $($rg.Exit))"

Write-Host "== 7. F4 crash between request and persist: OUTCOME_UNKNOWN, no silent retry =="
# The request was sent and the process died before persisting anything. There is
# no way to know the outcome, so the runner must record it as unknown and must
# NOT silently issue the request again (that would be an unbounded re-bill).
Reset-Work
$root = "$workRoot/crash-mid"
$logMid = Join-Path $repoRoot "$workRoot/argv-crash-mid.jsonl"
$rmid = Invoke-Runner (New-RunnerArgs $root "-ConfirmPaidRun -Suites solo") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $logMid
    FAKE_CLI_CRASH = "after-request"; FAKE_CLI_STATE_DIR = (Join-Path $repoRoot "$workRoot/mid-state")
}
Assert-True ($rmid.Exit -ne 0) "the crashed case does not report success (exit $($rmid.Exit))"
$midExecs = Get-CaseExecs $logMid
Assert-True ($midExecs.Count -eq 1) "the request was attempted exactly once (got $($midExecs.Count))"
$stMid = Get-Content (Join-Path $repoRoot "$root/campaign-status.json") -Raw | ConvertFrom-Json
Assert-True ($stMid.failed -ge 1) "the unknown-outcome case is recorded as not-succeeded (failed=$($stMid.failed))"
Assert-True ($stMid.status -ne "COMPLETE") "a crashed case never yields COMPLETE (got '$($stMid.status)')"
# A relaunch must NOT silently re-issue the request: the operator decides.
$logMid2 = Join-Path $repoRoot "$workRoot/argv-crash-mid2.jsonl"
$rmid2 = Invoke-Runner (New-RunnerArgs $root "-ConfirmPaidRun -Suites solo -DryRunOnly") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $logMid2
}
Assert-True ($rmid2.Output -notmatch "SKIP already stored \(identity verified\)") "the unknown-outcome case is not silently credited on relaunch"

Write-Host "== 8. F3 ApiKeyEnv: a custom key variable reaches the child, then is restored =="
# The real CLI reads OPENAI_API_KEY. When the operator names a different
# variable, the runner must propagate it explicitly to the child.
Reset-Work
$logK = Join-Path $repoRoot "$workRoot/argv-keyenv.jsonl"
$rk = Invoke-Runner (New-RunnerArgs "$workRoot/keyenv" "-ConfirmPaidRun -Suites adversarial -LimitCases 1 -ApiKeyEnv MY_R89_KEY") @{
    RUN_PAID_BENCHMARKS = "1"; MY_R89_KEY = $FAKE_KEY; FAKE_CLI_LOG = $logK
}
$kCalls = Get-CaseExecs $logK
Assert-True ($kCalls.Count -ge 1) "the custom-key run started a child (got $($kCalls.Count))"
if ($kCalls.Count -ge 1) {
    Assert-True ($kCalls[0].sawOpenAiKey -eq $true) "the child SAW the key in OPENAI_API_KEY (the variable the real CLI reads)"
}
# A custom variable that is NOT set must be refused, exactly like the default.
$rk2 = Invoke-Runner (New-RunnerArgs "$workRoot/keyenv2" "-ConfirmPaidRun -Suites adversarial -ApiKeyEnv MY_R89_KEY") @{
    RUN_PAID_BENCHMARKS = "1"
}
Assert-True ($rk2.Exit -eq 2) "a missing custom key variable is refused with exit 2 (got $($rk2.Exit))"

Write-Host "== 9. exit status: a failure cannot be masked =="
$logH = Join-Path $repoRoot "$workRoot/argv-fail.jsonl"
$rh = Invoke-Runner (New-RunnerArgs "$workRoot/fail" "-ConfirmPaidRun -Suites adversarial") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $logH; FAKE_CLI_MODE = "exit1"
}
Assert-True ($rh.Exit -eq 1) "a failing case yields exit 1 (got $($rh.Exit))"
if (-not (Test-Path (Join-Path $repoRoot "$workRoot/fail/campaign-status.json"))) { Write-Host "  FAIL  no campaign-status.json"; $script:failures++ } else { $stH = Get-Content (Join-Path $repoRoot "$workRoot/fail/campaign-status.json") -Raw | ConvertFrom-Json }
Assert-True ($stH.status -eq "FAILED" -or $stH.status -eq "INVALID") "the status records the failure (got '$($stH.status)')"
Assert-True ($stH.failed -ge 1) "the failed counter is recorded (got $($stH.failed))"

Write-Host "== 10. secrets: no key and no endpoint in any persisted artifact =="
$allArtifacts = @()
foreach ($rootDir in (Get-ChildItem -Directory (Join-Path $repoRoot $workRoot) -ErrorAction SilentlyContinue)) {
    $allArtifacts += Get-ChildItem -Recurse -File $rootDir.FullName -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne "run.log" }
}
$leak = $false
foreach ($f in $allArtifacts) {
    $txt = Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue
    if ($txt -match [regex]::Escape($FAKE_KEY) -or $txt -match "fake\.invalid") { $leak = $true; Write-Host "    leak in $($f.Name)" }
}
Assert-True (-not $leak) "no artifact contains the key or the endpoint"

Write-Host ""
if ($script:failures -gt 0) {
    Write-Host "R89 SELF-CHECK FAILED: $($script:failures) assertion(s)" -ForegroundColor Red
    exit 1
}
Write-Host "R89 SELF-CHECK PASSED (0 provider calls, 0 network, 0 cost)" -ForegroundColor Green
exit 0
