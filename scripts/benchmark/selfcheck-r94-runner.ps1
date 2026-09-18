#!/usr/bin/env pwsh
<#
.SYNOPSIS
  E4-R94 — offline gate for the campaign runner's interruption-recovery contract
  (findings B and C).

.DESCRIPTION
  Drives the REAL scripts/benchmark/run-campaign.ps1 through the FAKE CLI
  (scripts/benchmark/fixtures/r89-fake-cli.mjs), so the resume/persist state
  machine is covered end to end with ZERO provider calls, ZERO network access and
  ZERO cost.

  The two findings this gate closes:

    B  `Get-CaseIdentity` was handed `lastOk.planDigest` — the OLD digest — so it
       compared the stored identity against ITSELF. A case whose source changed at
       an unchanged git SHA still matched, and the report's own contents were
       never hashed at all. Resume therefore never re-observed the current
       identity.

    C  `Read-Manifest` did `catch { continue }`, so a truncated/corrupt manifest
       line was silently ignored; and the attempt record was written only AFTER
       the case finished. A crash between "the request went out" and "the outcome
       was persisted" left no trace, so the next run could treat the case as new
       and silently re-bill it.

  Assertions (any failure exits non-zero). See the sections below; every one of
  them is a statement about the runner, not about this script.

  Usage:  pwsh scripts/benchmark/selfcheck-r94-runner.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

$runner = Join-Path $repoRoot "scripts/benchmark/run-campaign.ps1"
$fakeCli = Join-Path $repoRoot "scripts/benchmark/fixtures/r89-fake-cli.mjs"
$workRoot = ".ci/r94-selfcheck"
$workAbs = Join-Path $repoRoot $workRoot
# The fake CLI's argv log is INSTRUMENTATION, not a runner artifact: the child
# must be told which endpoint to use, so its argv necessarily carries one. It is
# kept outside the output root so section 10 can assert the stronger property —
# that nothing the RUNNER persists ever contains the endpoint or the key.
$logDir = Join-Path $repoRoot ".ci/r94-selfcheck-argv"

$script:failures = 0
function Assert-True([bool]$condition, [string]$label) {
    if ($condition) {
        Write-Host "  PASS  $label"
    } else {
        Write-Host "  FAIL  $label" -ForegroundColor Red
        $script:failures++
    }
}

$FAKE_KEY = "sk-r94-fake-key-not-a-real-credential"

function Reset-Work {
    if (Test-Path $workAbs) { Remove-Item -Recurse -Force $workAbs }
    if (Test-Path $logDir) { Remove-Item -Recurse -Force $logDir }
    New-Item -ItemType Directory -Force -Path $workAbs | Out-Null
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
}

# A writable copy of the case fixtures, so a test can EDIT a case source without
# touching the committed fixture (which must stay byte-identical).
function New-CasesCopy([string]$name) {
    $dest = Join-Path $workAbs "cases-$name"
    Copy-Item -Recurse -Force (Join-Path $repoRoot "scripts/benchmark/fixtures/r89-cases") $dest
    return $dest
}

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

function Invoke-Runner([string[]]$runnerArgs, [hashtable]$env) {
    # Every child starts from a known environment: a leftover FAKE_CLI_* switch
    # from an earlier section would silently change what the next section proves.
    $envSetup = @(
        "Remove-Item Env:\RUN_PAID_BENCHMARKS -ErrorAction SilentlyContinue",
        "Remove-Item Env:\OPENAI_API_KEY -ErrorAction SilentlyContinue",
        "Get-ChildItem Env: | Where-Object { `$_.Name -like 'FAKE_CLI_*' } | Remove-Item -ErrorAction SilentlyContinue"
    )
    foreach ($k in $env.Keys) {
        $v = $env[$k]
        $envSetup += "`$env:$k = '" + ($v -replace "'", "''") + "'"
    }
    $script = ($envSetup -join "; ") + "; & '$runner' " + (Format-RunnerArgs $runnerArgs) + " 2>&1 | Out-String; exit `$LASTEXITCODE"
    $out = & pwsh -NoProfile -Command $script
    return @{ Output = ($out | Out-String); Exit = $LASTEXITCODE }
}

# The default invocation: fully (fake-)authorized, so the runner reaches the fake
# CLI and never touches a provider. -InterCaseDelaySec 0 keeps the gate fast: the
# real 10s courtesy delay is not part of this contract.
function New-Args([string]$root, [string]$casesRoot, [string]$extra = "") {
    $a = @(
        "-Endpoint", "https://fake.invalid/v1",
        "-Model", "fake-model",
        "-Root", $root,
        "-CasesRoot", $casesRoot,
        "-CliPath", $fakeCli,
        "-ConfirmPaidRun",
        "-InterCaseDelaySec", "0"
    )
    if ($extra -ne "") { $a += @($extra.Split(" ") | Where-Object { $_ -ne "" }) }
    return $a
}

# Set a parameter's value in an argument list, whether or not it is present
# already. Replacing in place (rather than appending) matters because PowerShell
# rejects a parameter that is specified twice.
function Set-Arg([string[]]$tokens, [string]$name, [string]$value) {
    $out = @()
    $seen = $false
    for ($i = 0; $i -lt $tokens.Count; $i++) {
        if ($tokens[$i] -eq $name) { $out += $name; $out += $value; $i++; $seen = $true; continue }
        $out += $tokens[$i]
    }
    if (-not $seen) { $out += $name; $out += $value }
    return $out
}

function Read-CliLog([string]$path) {
    if (-not (Test-Path $path)) { return @() }
    return @(Get-Content $path | Where-Object { $_ -ne "" } | ForEach-Object { $_ | ConvertFrom-Json })
}

# A case-execution call is any child invocation that is NOT a dry run and NOT the
# end-of-campaign `campaign validate` step. Only these can ever reach a provider.
function Get-CaseExecs([string]$logPath) {
    return @(Read-CliLog $logPath | Where-Object {
        ($_.argv -notcontains "--dry-run") -and -not ($_.argv[1] -eq "campaign")
    })
}

function Get-Status([string]$root) {
    $p = Join-Path $repoRoot "$root/campaign-status.json"
    if (-not (Test-Path $p)) { return $null }
    return (Get-Content $p -Raw | ConvertFrom-Json)
}

# The durable attempt state the runner must persist, for the case under test
# (each section here drives exactly ONE case). Returns $null when absent.
function Get-AttemptState([string]$root) {
    foreach ($name in @("attempt-state.json", "state.json")) {
        $p = Join-Path $repoRoot "$root/$name"
        if (Test-Path $p) {
            try {
                $doc = Get-Content $p -Raw | ConvertFrom-Json
                $a = @($doc.attempts)
                if ($a.Count -gt 0) { return $a[-1] }
                return $null
            } catch { return $null }
        }
    }
    return $null
}

$env:FAKE = $null

# ===========================================================================
Write-Host "== 0. the runner persists a durable attempt state with the contract's fields =="
Reset-Work
$cases = New-CasesCopy "s0"
$root = "$workRoot/s0"
$log0 = Join-Path $logDir "argv-s0.jsonl"
$r0 = Invoke-Runner (New-Args $root $cases "-Suites solo") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $log0
}
$state0 = Get-AttemptState $root
Assert-True ($null -ne $state0) "a durable attempt state file exists after a run"
if ($null -ne $state0) {
    foreach ($f in @("experimentId", "attemptId", "currentPlanDigest", "status", "reportHash", "caseId", "arm", "suite")) {
        Assert-True ($null -ne $state0.PSObject.Properties[$f]) "the state carries '$f'"
    }
    Assert-True ($state0.status -eq "completed") "a clean run ends in status=completed (got '$($state0.status)')"
}

# ===========================================================================
Write-Host "== 1. finding B: resume must RE-OBSERVE the current identity =="
# Pass 1: a full fake run, so a report AND a manifest record both exist.
Reset-Work
$cases = New-CasesCopy "s1"
$root = "$workRoot/s1"
Invoke-Runner (New-Args $root $cases "-Suites solo") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY
} | Out-Null
Assert-True (Test-Path (Join-Path $repoRoot "$root/manifest.jsonl")) "pass 1 wrote a manifest"
Assert-True (Test-Path (Join-Path $repoRoot "$root/results/solo/only-case/solo.json")) "pass 1 wrote a report"

# 1a. Unchanged: the relaunch is an honest skip.
$log1a = Join-Path $logDir "argv-s1a.jsonl"
$r1a = Invoke-Runner (New-Args $root $cases "-Suites solo -DryRunOnly") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $log1a
}
Assert-True ($r1a.Output -match "SKIP already stored \(identity verified\)") "1a: an UNCHANGED case is still resumed (sanity: the gate is not vacuous)"

# 1b. The case SOURCE changes at an unchanged git SHA. The old implementation
# passed `lastOk.planDigest` back to itself, so it could not notice this.
$caseFile = Join-Path $cases "solo/only-case/request.md"
Add-Content -Path $caseFile -Value "`nR94-CHANGED-CASE-CONTENT"
$log1b = Join-Path $logDir "argv-s1b.jsonl"
$r1b = Invoke-Runner (New-Args $root $cases "-Suites solo -DryRunOnly") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $log1b
}
Assert-True ($r1b.Output -notmatch "SKIP already stored \(identity verified\)") "1b: a CHANGED case is NOT resumed as verified evidence"
Assert-True ($r1b.Output -match "solo/only-case") "1b: the decision names the offending case"
Assert-True ($r1b.Output -match "OUTCOME_UNKNOWN|QUARANTINE|DRIFT|MISMATCH") "1b: the changed case is flagged, not silently reused"
Assert-True (@(Get-CaseExecs $log1b).Count -eq 0) "1b: the changed case was NOT automatically re-billed"
# The relaunch must have re-observed by running a DRY RUN (free), which is the
# only way it can know the current plan digest.
$dry1b = @(Read-CliLog $log1b | Where-Object { $_.argv -contains "--dry-run" })
Assert-True ($dry1b.Count -ge 1) "1b: the relaunch re-derived the current plan digest with a dry run"

# 1c. A provider/model change is still a different experiment.
Reset-Work
$cases = New-CasesCopy "s1c"
$root = "$workRoot/s1c"
Invoke-Runner (New-Args $root $cases "-Suites solo") @{ RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY } | Out-Null
$args1c = Set-Arg (New-Args $root $cases "-Suites solo -DryRunOnly") "-Model" "other-model"
$r1c = Invoke-Runner $args1c @{ RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY }
Assert-True ($r1c.Output -notmatch "SKIP already stored \(identity verified\)") "1c: a model change is not resumed as the same experiment"

# ===========================================================================
Write-Host "== 2. finding B: the report's own CONTENT is hashed =="
# The finding's exact scenario: keep meta/task_id so the old structural check
# passes, but change success / tokens / termination.
foreach ($field in @(
    @{ name = "success";            find = '"success": true';              repl = '"success": false' },
    @{ name = "output_tokens";      find = '"output_tokens": 1';           repl = '"output_tokens": 99999' },
    @{ name = "termination_reason"; find = '"termination_reason": "verified_complete"'; repl = '"termination_reason": "agent_limit"' }
)) {
    Reset-Work
    $cases = New-CasesCopy "s2-$($field.name)"
    $root = "$workRoot/s2-$($field.name)"
    Invoke-Runner (New-Args $root $cases "-Suites solo") @{ RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY } | Out-Null
    $report = Join-Path $repoRoot "$root/results/solo/only-case/solo.json"
    Assert-True (Test-Path $report) "2/$($field.name): the report exists before tampering"
    $raw = Get-Content $report -Raw
    Assert-True ($raw.Contains($field.find)) "2/$($field.name): the tamper target '$($field.find)' is present"
    Set-Content -Path $report -Value ($raw.Replace($field.find, $field.repl)) -NoNewline
    $log2 = Join-Path $logDir "argv-s2-$($field.name).jsonl"
    $r2 = Invoke-Runner (New-Args $root $cases "-Suites solo -DryRunOnly") @{
        RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $log2
    }
    Assert-True ($r2.Output -notmatch "SKIP already stored \(identity verified\)") "2/$($field.name): a report whose $($field.name) changed is NOT reused"
    Assert-True (@(Get-CaseExecs $log2).Count -eq 0) "2/$($field.name): the tampered report did not trigger an automatic re-bill"
}

# ===========================================================================
Write-Host "== 3. finding C: a corrupt manifest is a stable state, not a silent skip =="
Reset-Work
$cases = New-CasesCopy "s3"
$root = "$workRoot/s3"
Invoke-Runner (New-Args $root $cases "-Suites solo") @{ RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY } | Out-Null
$manifest = Join-Path $repoRoot "$root/manifest.jsonl"
$good = Get-Content $manifest -Raw
$bytesBefore = (Get-Item $manifest).Length
# A truncated line: exactly the crash-between-write-and-fsync shape.
Add-Content -Path $manifest -Value '{"ts":"1970-01-01T00:00:00.000Z","suite":"solo","caseId":"only-'
$log3 = Join-Path $logDir "argv-s3.jsonl"
$r3 = Invoke-Runner (New-Args $root $cases "-Suites solo -DryRunOnly") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $log3
}
Assert-True ($r3.Output -match "MANIFEST|CORRUPT|DAMAGED") "3: a truncated manifest line is reported as a stable damaged state"
Assert-True ($r3.Output -notmatch "SKIP already stored \(identity verified\)") "3: a damaged manifest never yields a silent verified skip"
Assert-True ((Get-Item $manifest).Length -ge $bytesBefore) "3: the original manifest file is preserved, not rewritten away"
Assert-True ((Get-Content $manifest -Raw).Contains($good.Trim())) "3: the pre-existing good record is still present verbatim"
$st3 = Get-Status $root
Assert-True ($null -ne $st3 -and $st3.status -ne "COMPLETE") "3: the run does not report COMPLETE over a damaged manifest (got '$($st3.status)')"

# ===========================================================================
Write-Host "== 4. finding C: durable in-flight intent is written BEFORE the billable child =="
# The child dies the instant it starts. The runner has already written its
# in-flight intent, so the case must NOT look like "never started".
Reset-Work
$cases = New-CasesCopy "s4"
$root = "$workRoot/s4"
$log4 = Join-Path $logDir "argv-s4.jsonl"
$r4 = Invoke-Runner (New-Args $root $cases "-Suites solo") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $log4
    FAKE_CLI_CRASH = "after-start"; FAKE_CLI_STATE_DIR = (Join-Path $workAbs "s4-state")
}
$state4 = Get-AttemptState $root
Assert-True ($null -ne $state4) "4: an attempt state survived the crash"
if ($null -ne $state4) {
    Assert-True ($state4.status -eq "outcome_unknown") "4: a child that died after start is outcome_unknown, never 'did not run' (got '$($state4.status)')"
    Assert-True ([bool]$state4.attemptId) "4: the crashed attempt records an attemptId"
    Assert-True ([bool]$state4.currentPlanDigest) "4: the crashed attempt records the plan digest it was launched with"
}
# Relaunch: no automatic re-bill, and an explicit UNKNOWN.
$log4b = Join-Path $logDir "argv-s4b.jsonl"
$r4b = Invoke-Runner (New-Args $root $cases "-Suites solo -DryRunOnly") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $log4b
}
Assert-True (@(Get-CaseExecs $log4b).Count -eq 0) "4: the unknown-outcome case is NOT automatically re-billed"
Assert-True ($r4b.Output -match "OUTCOME_UNKNOWN|UNKNOWN") "4: the relaunch reports OUTCOME_UNKNOWN"
Assert-True ($r4b.Output -notmatch "SKIP already stored \(identity verified\)") "4: the unknown-outcome case is never credited as verified"
$st4b = Get-Status $root
Assert-True ($null -ne $st4b -and $st4b.status -eq "PARTIAL") "4: the run is PARTIAL, not COMPLETE (got '$($st4b.status)')"
if ($null -ne $st4b) {
    Assert-True (@($st4b.outcomeUnknown).Count -ge 1) "4: the case is listed in outcomeUnknown"
}

# ===========================================================================
Write-Host "== 5. the six termination points of the interruption contract =="
# The child is terminated at each point. `before-*` means the point is reached
# BEFORE the named artifact is durable; `after-*` means after.
#
# The distinction that matters: a durable REPORT makes the outcome knowable, so
# the attempt reaches a terminal `completed` state (the manifest separately
# records whether the CASE passed). With no durable report a request may already
# have been sent, so the attempt is `outcome_unknown` and is never retried.
$points = @(
    @{ name = "before-start";      mode = "dryrunfail"; crash = "";                  expect = "failed_before_dispatch"; note = "no child ever reached the provider" },
    @{ name = "after-start";       mode = "ok";         crash = "after-start";       expect = "outcome_unknown";        note = "dispatched, nothing durable" },
    @{ name = "after-request";     mode = "ok";         crash = "after-request";     expect = "outcome_unknown";        note = "a request went out, nothing durable" },
    @{ name = "after-report";      mode = "ok";         crash = "after-report";      expect = "completed";              note = "the report is durable, so the outcome IS knowable" },
    @{ name = "before-completion"; mode = "ok";         crash = "before-completion"; expect = "completed";              note = "the report is durable" },
    @{ name = "after-completion";  mode = "ok";         crash = "";                  expect = "completed";              note = "clean exit" }
)
foreach ($p in $points) {
    Reset-Work
    $cases = New-CasesCopy "s5-$($p.name)"
    $root = "$workRoot/s5-$($p.name)"
    $envh = @{
        RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY
        FAKE_CLI_STATE_DIR = (Join-Path $workAbs "s5-state-$($p.name)")
    }
    if ($p.mode -ne "ok") { $envh["FAKE_CLI_MODE"] = $p.mode }
    if ($p.crash -ne "") { $envh["FAKE_CLI_CRASH"] = $p.crash }
    Invoke-Runner (New-Args $root $cases "-Suites solo") $envh | Out-Null
    $st = Get-AttemptState $root
    $actual = if ($null -eq $st) { "<no state>" } else { $st.status }
    Assert-True ($actual -eq $p.expect) "5/$($p.name): state is '$($p.expect)' — $($p.note) (got '$actual')"
}
# `before-start` is the ONLY point that may be retried: no billable child ever
# existed. Verify the retry actually happens and is allowed.
Reset-Work
$cases = New-CasesCopy "s5-retry"
$root = "$workRoot/s5-retry"
Invoke-Runner (New-Args $root $cases "-Suites solo") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_MODE = "dryrunfail"
} | Out-Null
$logR = Join-Path $logDir "argv-s5-retry.jsonl"
$rR = Invoke-Runner (New-Args $root $cases "-Suites solo") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $logR
}
Assert-True (@(Get-CaseExecs $logR).Count -eq 1) "5/retry: a failed_before_dispatch case IS retried (exactly one new execution)"
Assert-True ($rR.Output -notmatch "OUTCOME_UNKNOWN") "5/retry: a never-dispatched case is not reported as UNKNOWN"

# ===========================================================================
Write-Host "== 5b. the RUNNER dies mid-case: offline re-registration vs UNKNOWN =="
# The child is still running when the runner is killed, so the attempt state is
# left at `in_flight`. This is the window the plan calls out: the report may or
# may not be durable, and recovery must decide from evidence, never from hope.

# 5b-i: the report IS durable. Recovery may re-register it OFFLINE — the same
# experiment, the same re-observed plan digest, a report that still validates —
# and must make ZERO provider calls doing so.
Reset-Work
$cases = New-CasesCopy "s5b-i"
$root = "$workRoot/s5b-i"
$pidFile = Join-Path $workAbs "s5b-i-child.pid"
$argsB = New-Args $root $cases "-Suites solo"
$scriptB = "Remove-Item Env:\RUN_PAID_BENCHMARKS -ErrorAction SilentlyContinue; " +
    "`$env:RUN_PAID_BENCHMARKS='1'; `$env:OPENAI_API_KEY='$FAKE_KEY'; " +
    "`$env:FAKE_CLI_SLOW_AFTER_REPORT_MS='20000'; `$env:FAKE_CLI_PID_FILE='$pidFile'; " +
    "& '$runner' " + (Format-RunnerArgs $argsB)
$procB = Start-Process -FilePath "pwsh" -ArgumentList @("-NoProfile", "-Command", $scriptB) -PassThru
# Wait for the durable report to appear, then kill the RUNNER (not the child).
$deadline = (Get-Date).AddSeconds(120)
$reportB = Join-Path $repoRoot "$root/results/solo/only-case/solo.json"
while ((Get-Date) -lt $deadline -and -not (Test-Path $reportB)) { Start-Sleep -Milliseconds 500 }
Assert-True (Test-Path $reportB) "5b-i: the child made its report durable before the runner was killed"
Stop-Process -Id $procB.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$stB = Get-AttemptState $root
Assert-True ($null -ne $stB -and $stB.status -eq "in_flight") "5b-i: the killed runner left the attempt at in_flight (got '$($stB.status)')"
$logBi = Join-Path $logDir "argv-s5b-i.jsonl"
$rBi = Invoke-Runner (New-Args $root $cases "-Suites solo -DryRunOnly") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $logBi
}
Assert-True (@(Get-CaseExecs $logBi).Count -eq 0) "5b-i: offline re-registration made 0 provider calls"
Assert-True ($rBi.Output -match "RECOVERED offline") "5b-i: the substantiated attempt is re-registered offline"
$stBi = Get-AttemptState $root
Assert-True ($null -ne $stBi -and $stBi.status -eq "completed") "5b-i: the attempt is now terminal (got '$($stBi.status)')"
Assert-True ($null -ne $stBi -and [bool]$stBi.reportHash) "5b-i: the recovered attempt binds the report content hash"

# 5b-ii: NO durable report. Recovery must refuse to guess and must not re-bill.
Reset-Work
$cases = New-CasesCopy "s5b-ii"
$root = "$workRoot/s5b-ii"
$markerDir = Join-Path $workAbs "s5b-ii-markers"
$pidFile2 = Join-Path $workAbs "s5b-ii-child.pid"
$argsB2 = New-Args $root $cases "-Suites solo"
$scriptB2 = "Remove-Item Env:\RUN_PAID_BENCHMARKS -ErrorAction SilentlyContinue; " +
    "`$env:RUN_PAID_BENCHMARKS='1'; `$env:OPENAI_API_KEY='$FAKE_KEY'; " +
    "`$env:FAKE_CLI_HANG='before-report'; `$env:FAKE_CLI_STATE_DIR='$markerDir'; `$env:FAKE_CLI_PID_FILE='$pidFile2'; " +
    "& '$runner' " + (Format-RunnerArgs $argsB2)
$procB2 = Start-Process -FilePath "pwsh" -ArgumentList @("-NoProfile", "-Command", $scriptB2) -PassThru
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline -and -not (Test-Path $pidFile2)) { Start-Sleep -Milliseconds 500 }
Assert-True (Test-Path $pidFile2) "5b-ii: the child started and recorded its pid"
Start-Sleep -Seconds 3
Stop-Process -Id $procB2.Id -Force -ErrorAction SilentlyContinue
if (Test-Path $pidFile2) { Stop-Process -Id ([int](Get-Content $pidFile2 -Raw)) -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
$stB2 = Get-AttemptState $root
Assert-True ($null -ne $stB2 -and $stB2.status -eq "in_flight") "5b-ii: the killed runner left the attempt at in_flight (got '$($stB2.status)')"
$logBii = Join-Path $logDir "argv-s5b-ii.jsonl"
$rBii = Invoke-Runner (New-Args $root $cases "-Suites solo -DryRunOnly") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $logBii
}
Assert-True (@(Get-CaseExecs $logBii).Count -eq 0) "5b-ii: an unsubstantiated in-flight attempt is NOT re-billed"
Assert-True ($rBii.Output -match "OUTCOME_UNKNOWN") "5b-ii: the unsubstantiated attempt is reported OUTCOME_UNKNOWN"
$stBii = Get-AttemptState $root
Assert-True ($null -ne $stBii -and $stBii.status -eq "outcome_unknown") "5b-ii: the state is outcome_unknown (got '$($stBii.status)')"

# 5b-iii: the report IS durable, but the CASE SOURCE changed while the runner was
# dead. This is the case that separates a real digest binding from a decorative
# one: every other input to the substantiation test still passes, so only the
# re-observed plan digest can reject it. The stored report describes code that is
# no longer on disk, so it must NOT be re-registered as this attempt's outcome.
Reset-Work
$cases = New-CasesCopy "s5b-iii"
$root = "$workRoot/s5b-iii"
$pidFile3 = Join-Path $workAbs "s5b-iii-child.pid"
$argsB3 = New-Args $root $cases "-Suites solo"
$scriptB3 = "Remove-Item Env:\RUN_PAID_BENCHMARKS -ErrorAction SilentlyContinue; " +
    "`$env:RUN_PAID_BENCHMARKS='1'; `$env:OPENAI_API_KEY='$FAKE_KEY'; " +
    "`$env:FAKE_CLI_SLOW_AFTER_REPORT_MS='20000'; `$env:FAKE_CLI_PID_FILE='$pidFile3'; " +
    "& '$runner' " + (Format-RunnerArgs $argsB3)
$procB3 = Start-Process -FilePath "pwsh" -ArgumentList @("-NoProfile", "-Command", $scriptB3) -PassThru
$deadline = (Get-Date).AddSeconds(120)
$reportB3 = Join-Path $repoRoot "$root/results/solo/only-case/solo.json"
while ((Get-Date) -lt $deadline -and -not (Test-Path $reportB3)) { Start-Sleep -Milliseconds 500 }
Assert-True (Test-Path $reportB3) "5b-iii: the child made its report durable before the runner was killed"
Stop-Process -Id $procB3.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$stB3 = Get-AttemptState $root
Assert-True ($null -ne $stB3 -and $stB3.status -eq "in_flight") "5b-iii: the killed runner left the attempt at in_flight (got '$($stB3.status)')"
# Edit the case source at the SAME git HEAD: the plan digest must move.
$caseFile = Get-ChildItem -Recurse -File (Join-Path $cases "solo") | Select-Object -First 1
$orig = [System.IO.File]::ReadAllText($caseFile.FullName)
[System.IO.File]::WriteAllText($caseFile.FullName, $orig + "`n<!-- E4-R94: source changed after dispatch -->`n")
$logBiii = Join-Path $logDir "argv-s5b-iii.jsonl"
$rBiii = Invoke-Runner (New-Args $root $cases "-Suites solo -DryRunOnly") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $logBiii
}
Assert-True ($rBiii.Output -notmatch "RECOVERED offline") "5b-iii: a changed case source is NOT re-registered as the in-flight attempt's outcome"
Assert-True ($rBiii.Output -match "OUTCOME_UNKNOWN") "5b-iii: the changed-source attempt is OUTCOME_UNKNOWN"
Assert-True (@(Get-CaseExecs $logBiii).Count -eq 0) "5b-iii: the changed-source attempt is NOT re-billed"
$stBiii = Get-AttemptState $root
Assert-True ($null -ne $stBiii -and $stBiii.status -eq "outcome_unknown") "5b-iii: the state is outcome_unknown (got '$($stBiii.status)')"

# ===========================================================================
Write-Host "== 6. crash after the request marker: 0 new fake requests on the second run =="
Reset-Work
$cases = New-CasesCopy "s6"
$root = "$workRoot/s6"
$markerDir = Join-Path $workAbs "s6-markers"
$log6 = Join-Path $logDir "argv-s6.jsonl"
Invoke-Runner (New-Args $root $cases "-Suites solo") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $log6
    FAKE_CLI_CRASH = "after-request"; FAKE_CLI_STATE_DIR = $markerDir
} | Out-Null
Assert-True (@(Get-ChildItem $markerDir -Filter "*.marker" -ErrorAction SilentlyContinue).Count -ge 1) "6: the fake request marker proves a request was sent"
Assert-True (@(Get-CaseExecs $log6).Count -eq 1) "6: the request was attempted exactly once"
$log6b = Join-Path $logDir "argv-s6b.jsonl"
$r6b = Invoke-Runner (New-Args $root $cases "-Suites solo") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $log6b
}
Assert-True (@(Get-CaseExecs $log6b).Count -eq 0) "6: the SECOND run adds 0 new fake requests"
Assert-True ($r6b.Output -match "OUTCOME_UNKNOWN") "6: the second run returns OUTCOME_UNKNOWN"
$st6 = Get-Status $root
Assert-True ($null -ne $st6 -and $st6.status -eq "PARTIAL") "6: the second run is PARTIAL (got '$($st6.status)')"

# ===========================================================================
Write-Host "== 7. single-instance lock: two runners cannot share one output root =="
Reset-Work
$cases = New-CasesCopy "s7"
$root = "$workRoot/s7"
$log7 = Join-Path $logDir "argv-s7.jsonl"
$argsA = New-Args $root $cases "-Suites solo"
$scriptA = "Remove-Item Env:\RUN_PAID_BENCHMARKS -ErrorAction SilentlyContinue; `$env:RUN_PAID_BENCHMARKS='1'; `$env:OPENAI_API_KEY='$FAKE_KEY'; `$env:FAKE_CLI_LOG='$log7'; `$env:FAKE_CLI_SLOW_MS='5000'; & '$runner' " + (Format-RunnerArgs $argsA) + " 2>&1 | Out-String"
$jobA = Start-Job -ScriptBlock { param($s) & pwsh -NoProfile -Command $s } -ArgumentList $scriptA
Start-Sleep -Seconds 4
$log7b = Join-Path $logDir "argv-s7b.jsonl"
$r7b = Invoke-Runner (New-Args $root $cases "-Suites solo") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $log7b
}
Assert-True ($r7b.Exit -ne 0) "7: the second runner on the same root is REFUSED (got exit $($r7b.Exit))"
Assert-True ($r7b.Output -match "LOCK|lock|already running|in progress") "7: the refusal names the lock"
Assert-True (@(Get-CaseExecs $log7b).Count -eq 0) "7: the refused runner started NO child (no double-start)"
Wait-Job $jobA -Timeout 120 | Out-Null
Remove-Job $jobA -Force -ErrorAction SilentlyContinue
Assert-True (@(Get-CaseExecs $log7).Count -eq 1) "7: the lock holder ran its single case exactly once"
# After the holder exits, the lock must be released.
$log7c = Join-Path $logDir "argv-s7c.jsonl"
$r7c = Invoke-Runner (New-Args $root $cases "-Suites solo -DryRunOnly") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $log7c
}
Assert-True ($r7c.Exit -eq 0) "7: the lock is released when the holder finishes (got exit $($r7c.Exit))"

# ===========================================================================
Write-Host "== 8. legacy records stay legacy: never counted as verified =="
Reset-Work
$cases = New-CasesCopy "s8"
$root = "$workRoot/s8"
# Seed a root with the committed R84 fixture (pre-R89 records carry NO identity)
# and a matching report, i.e. exactly the historical on-disk shape. The
# destination directory is created FIRST: a wildcard copy into a missing
# directory flattens the tree and would drop the results/ level.
New-Item -ItemType Directory -Force -Path (Join-Path $repoRoot $root) | Out-Null
Copy-Item -Path (Join-Path $repoRoot "scripts/benchmark/fixtures/r84-campaign/campaign/*") `
    -Destination (Join-Path $repoRoot $root) -Recurse -Force
Assert-True (Test-Path (Join-Path $repoRoot "$root/results/adversarial/syn-adv-1/adversarial.json")) `
    "8: the seeded legacy root keeps the historical results/ layout"
$args8 = Set-Arg (New-Args $root "scripts/benchmark/fixtures/r84-campaign/cases" "-Suites adversarial -DryRunOnly") "-Provider" "test"
$args8 = Set-Arg $args8 "-Model" "synthetic-1"
$r8 = Invoke-Runner $args8 @{ RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY }
Assert-True ($r8.Output -match "LEGACY") "8: an identity-less record is labelled LEGACY"
$st8 = Get-Status $root
Assert-True ($null -ne $st8) "8: the run wrote a status document"
if ($null -ne $st8) {
    Assert-True ($st8.resumedLegacy -ge 1) "8: legacy reuse is counted separately (resumedLegacy=$($st8.resumedLegacy))"
    Assert-True ($st8.resumed -eq $st8.resumedLegacy) "8: legacy reuse is NOT presented as verified reuse (resumed=$($st8.resumed), legacy=$($st8.resumedLegacy))"
}

# ===========================================================================
Write-Host "== 8b. duplicate/conflicting completed records are refused =="
# Two `ok` records for one case that disagree are NOT a case to pick a winner
# from: the manifest no longer has one authoritative answer, so reuse stops.
Reset-Work
$cases = New-CasesCopy "s8b"
$root = "$workRoot/s8b"
Invoke-Runner (New-Args $root $cases "-Suites solo") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY
} | Out-Null
# Forge a second, CONFLICTING completed record for the same case.
$mp = Join-Path $repoRoot "$root/manifest.jsonl"
$first = Get-Content $mp -Raw
$forged = $first.TrimEnd("`r", "`n") -replace '"identity":"[0-9a-f]+"', '"identity":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"'
Add-Content -Path $mp -Value $forged
$log8b = Join-Path $logDir "argv-s8b.jsonl"
$r8b = Invoke-Runner (New-Args $root $cases "-Suites solo -DryRunOnly") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $log8b
}
Assert-True ($r8b.Output -match "conflicting completed records") "8b: conflicting completed records are named"
Assert-True ($r8b.Output -notmatch "SKIP already stored \(identity verified\)") "8b: a conflicting manifest never yields a verified skip"
Assert-True (@(Get-CaseExecs $log8b).Count -eq 0) "8b: a conflicting manifest does not trigger a re-bill"
$st8b = Get-Status $root
Assert-True ($null -ne $st8b -and $st8b.status -eq "INVALID") "8b: the run is INVALID over a conflicting manifest (got '$($st8b.status)')"

# ===========================================================================
Write-Host "== 8c. AdoptOrphanReport requires an EXPLICIT operator decision =="
# A report with no manifest record is an orphan: the runner cannot know whether
# the case passed, or whether the record was simply lost. Default = quarantine.
# Only the explicit switch adopts it, and it is counted as resumed.
Reset-Work
$cases = New-CasesCopy "s8c"
$root = "$workRoot/s8c"
$log8c1 = Join-Path $logDir "argv-s8c1.jsonl"
$r8c1 = Invoke-Runner (New-Args $root $cases "-Suites solo") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $log8c1
}
Assert-True (Test-Path (Join-Path $repoRoot "$root/manifest.jsonl")) "8c: the first run wrote a manifest"
# Delete the manifest but keep the durable report -> an orphan report.
Remove-Item -Force (Join-Path $repoRoot "$root/manifest.jsonl")
Remove-Item -Force (Join-Path $repoRoot "$root/attempt-state.json") -ErrorAction SilentlyContinue
$log8c2 = Join-Path $logDir "argv-s8c2.jsonl"
$r8c2 = Invoke-Runner (New-Args $root $cases "-Suites solo -DryRunOnly") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $log8c2
}
Assert-True ($r8c2.Output -match "report without manifest") "8c: an orphan report is quarantined by default"
Assert-True ($r8c2.Output -notmatch "ADOPTED") "8c: an orphan report is NOT adopted without the explicit switch"
Assert-True (@(Get-CaseExecs $log8c2).Count -eq 0) "8c: an orphan report does not trigger a re-bill"
$st8c = Get-Status $root
Assert-True ($null -ne $st8c -and $st8c.status -eq "PARTIAL") "8c: an orphan report yields PARTIAL, not COMPLETE (got '$($st8c.status)')"
# Now with the explicit operator switch it IS adopted.
$log8c3 = Join-Path $logDir "argv-s8c3.jsonl"
$r8c3 = Invoke-Runner (New-Args $root $cases "-Suites solo -DryRunOnly -AdoptOrphanReport") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $log8c3
}
Assert-True ($r8c3.Output -match "ADOPTED orphan report by explicit operator decision") "8c: the explicit switch adopts the orphan report"
Assert-True (@(Get-CaseExecs $log8c3).Count -eq 0) "8c: adoption is offline (0 provider calls)"

# ===========================================================================
Write-Host "== 8d. the output root cannot escape through a junction/symlink =="
# A lexical containment check passes for a link that points outside the
# repository, so the runner must refuse to walk through one. Windows uses a
# junction; Unix uses a symlink. Both surface as FileAttributes.ReparsePoint.
$linkParent = Join-Path $workAbs "link-parent"
New-Item -ItemType Directory -Force -Path $linkParent | Out-Null
$tmpBase = if ($env:TEMP) { $env:TEMP } elseif ($env:TMPDIR) { $env:TMPDIR } else { "/tmp" }
$outside = Join-Path $tmpBase "r94-outside-$([guid]::NewGuid().ToString('n'))"
New-Item -ItemType Directory -Force -Path $outside | Out-Null
$junction = Join-Path $linkParent "escape"
$madeLink = $false
foreach ($kind in @("Junction", "SymbolicLink")) {
    if ($madeLink) { break }
    try {
        New-Item -ItemType $kind -Path $junction -Target $outside -ErrorAction Stop | Out-Null
        $madeLink = $true
    } catch { $madeLink = $false }
}
if ($madeLink) {
    $rootRel = "$workRoot/link-parent/escape/out"
    $r8d = Invoke-Runner (New-Args $rootRel (New-CasesCopy "s8d") "-Suites solo -DryRunOnly") @{
        RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY
    }
    Assert-True ($r8d.Output -match "reparse point") "8d: an output root behind a link is refused"
    Assert-True ($r8d.Exit -eq 2) "8d: the link refusal is a configuration error (got exit $($r8d.Exit))"
    Assert-True (-not (Test-Path (Join-Path $outside "out"))) "8d: nothing was written outside the repository"
} else {
    Write-Host "  SKIP  8d: this platform could not create a junction/symlink (not a contract failure)"
}
Remove-Item -Recurse -Force $outside -ErrorAction SilentlyContinue

# ===========================================================================
Write-Host "== 8e. LimitCases counts only NEW executions, never resumed cases =="
# R89 pinned this. Re-assert it here because R94 changed the resume path.
Reset-Work
$cases = New-CasesCopy "s8e"
$root = "$workRoot/s8e"
$log8e1 = Join-Path $logDir "argv-s8e1.jsonl"
Invoke-Runner (New-Args $root $cases "-Suites solo") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $log8e1
} | Out-Null
$log8e2 = Join-Path $logDir "argv-s8e2.jsonl"
$r8e = Invoke-Runner (New-Args $root $cases "-Suites solo -DryRunOnly -LimitCases 1") @{
    RUN_PAID_BENCHMARKS = "1"; OPENAI_API_KEY = $FAKE_KEY; FAKE_CLI_LOG = $log8e2
}
Assert-True (@(Get-CaseExecs $log8e2).Count -eq 0) "8e: a resumed case does not consume the LimitCases budget"
$st8e = Get-Status $root
Assert-True ($null -ne $st8e -and $st8e.attempted -eq 0) "8e: attempted counts only new dispatches (got $($st8e.attempted))"
Assert-True ($null -ne $st8e -and $st8e.status -eq "COMPLETE") "8e: a fully resumed run is COMPLETE (got '$($st8e.status)')"

# ===========================================================================
Write-Host "== 9. the historical R83/R85 evidence is byte-identical =="
$pinned = @{
    "docs/evidence/e4-r87-phase-a-manifest.json" = "cfecb47172c3d3bb3d4e529985acb902c8babcd44711e6854153aa354ce967e1"
    "docs/evidence/e4-r88-phase-a-manifest.json" = "d3bd5a1d90225a3bd88f1c9ea10f79d371118244bcd3f116856bb9fb0912ec69"
    "docs/evidence/e4-r85-failure-taxonomy.json" = "861557f093fdaac69df56e08c1ac900e1e2462e09fd241d6b78a33bbde3454e8"
}
foreach ($rel in $pinned.Keys) {
    $p = Join-Path $repoRoot $rel
    $h = if (Test-Path $p) { (Get-FileHash $p -Algorithm SHA256).Hash.ToLowerInvariant() } else { "<missing>" }
    Assert-True ($h -eq $pinned[$rel]) "9: $rel is unchanged ($h)"
}

# ===========================================================================
Write-Host "== 10. no secrets and no endpoints in any persisted artifact =="
$leak = $false
foreach ($f in (Get-ChildItem -Recurse -File $workAbs -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne "run.log" })) {
    $txt = Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue
    if ($txt -match [regex]::Escape($FAKE_KEY)) { $leak = $true; Write-Host "    key leak in $($f.Name)" }
    if ($txt -match "fake\.invalid") { $leak = $true; Write-Host "    endpoint leak in $($f.Name)" }
}
Assert-True (-not $leak) "10: no artifact contains the key or the endpoint"

Write-Host ""
if ($script:failures -gt 0) {
    Write-Host "R94 SELF-CHECK FAILED: $($script:failures) assertion(s)" -ForegroundColor Red
    exit 1
}
Write-Host "R94 SELF-CHECK PASSED (0 provider calls, 0 network, 0 cost)" -ForegroundColor Green
exit 0
