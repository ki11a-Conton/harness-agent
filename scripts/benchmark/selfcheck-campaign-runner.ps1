#!/usr/bin/env pwsh
<#
.SYNOPSIS
  E4-R84 — offline self-check of the versioned campaign runner.

.DESCRIPTION
  Exercises the runner's real control flow (stage -> dry-run -> digest ->
  persist -> manifest -> resume-skip -> validate) against the committed
  synthetic fixture, with ZERO provider calls and ZERO cost.

  `-DryRunOnly` stops each case after the CLI's `--dry-run` plan digest, so no
  provider request is ever made. This is the Windows-native half of the R84
  gate; the Linux half runs the same fixture through
  `agent benchmark campaign validate` on ubuntu-latest in CI.

  Assertions (any failure exits non-zero):
    1. the authorization gate refuses a paid run without -ConfirmPaidRun;
    2. a fresh offline run discovers all 3 fixture cases and records one
       ok=true manifest line per case;
    3. a relaunch SKIPS every case already marked done and appends no new line;
    4. the campaign validates (exit 0) and re-derives the fixture's numbers,
       keeping PROCESS success (3/3) separate from CASE success (1/3);
    5. the emitted evidence manifest contains no absolute path, no endpoint,
       no key-shaped string and no real R83 identifier;
    6. the committed fixture still matches its generator (no hand-tuning).

  Usage:  pwsh scripts/benchmark/selfcheck-campaign-runner.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

$cli = Join-Path $repoRoot "apps/cli/dist/main.js"
if (-not (Test-Path $cli)) {
    Write-Host "FAIL: build first (apps/cli/dist/main.js missing)" -ForegroundColor Red
    exit 1
}

$fixture = Join-Path $repoRoot "scripts/benchmark/fixtures/r84-campaign"
$casesRoot = "scripts/benchmark/fixtures/r84-campaign/cases"
$root = ".ci/r84-runner-selfcheck"
$rootAbs = Join-Path $repoRoot $root
$evidence = ".ci/r84-runner-selfcheck-evidence.json"
$evidenceAbs = Join-Path $repoRoot $evidence

$script:failures = 0
function Assert-True([bool]$condition, [string]$label) {
    if ($condition) {
        Write-Host "  PASS  $label"
    } else {
        Write-Host "  FAIL  $label" -ForegroundColor Red
        $script:failures++
    }
}

if (Test-Path $rootAbs) { Remove-Item -Recurse -Force $rootAbs }
if (Test-Path $evidenceAbs) { Remove-Item -Force $evidenceAbs }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $rootAbs) | Out-Null

$runner = Join-Path $repoRoot "scripts/benchmark/run-campaign.ps1"
$common = @(
    "-Endpoint", "https://api.invalid.example/v1",
    "-Model", "selfcheck-model",
    "-Root", $root,
    "-CasesRoot", $casesRoot,
    "-Suites", "adversarial,stress"
)

Write-Host "== 1. authorization gate: a paid run without -ConfirmPaidRun is refused =="
$refused = & pwsh -NoProfile -File $runner @common 2>&1 | Out-String
$refusedExit = $LASTEXITCODE
Assert-True ($refusedExit -eq 3) "exit code is 3 (refused) — got $refusedExit"
Assert-True ($refused -match "REFUSING") "the refusal is explained on stdout"
Assert-True (-not (Test-Path $rootAbs)) "the refused run created no campaign directory"

Write-Host "== 2. fresh offline run: stage -> dry-run -> digest -> persist -> manifest =="
$first = & pwsh -NoProfile -File $runner @common -DryRunOnly 2>&1 | Out-String
$firstExit = $LASTEXITCODE
Assert-True ($firstExit -eq 0) "runner exits 0 — got $firstExit"
Assert-True ($first -match "totalCases=3") "the fixture's 3 cases were discovered"
Assert-True ($first -match "done=3 failed=0") "3 done, 0 failed"
Assert-True ($first -match "DRY-RUN FAILED" -eq $false) "no case failed its dry run"

$manifestPath = Join-Path $rootAbs "manifest.jsonl"
Assert-True (Test-Path $manifestPath) "a resume manifest was written"
$lines = @(Get-Content $manifestPath | Where-Object { $_ -ne "" })
Assert-True ($lines.Count -eq 3) "one manifest record per case (got $($lines.Count))"
$records = @($lines | ForEach-Object { $_ | ConvertFrom-Json })
Assert-True (@($records | Where-Object { $_.ok }).Count -eq 3) "every record is ok=true"
Assert-True (@($records | Where-Object { $_.suite -eq "adversarial" }).Count -eq 2) "adversarial contributed 2 records"
Assert-True (@($records | Where-Object { $_.suite -eq "stress" }).Count -eq 1) "stress contributed 1 record"
# The manifest must never carry a key, an endpoint or provider output.
$manifestText = Get-Content $manifestPath -Raw
Assert-True ($manifestText -notmatch "https?://") "no endpoint in the manifest"
Assert-True ($manifestText -notmatch "sk-[A-Za-z0-9]") "no key-shaped string in the manifest"
Assert-True ($manifestText -notmatch "api\.invalid") "not even the placeholder endpoint appears"

Write-Host "== 3. resume semantics: a relaunch skips every stored case =="
# Seed a second campaign root with the fixture's COMMITTED reports + manifest —
# i.e. exactly the on-disk state a completed run leaves behind — then relaunch.
# (A -DryRunOnly pass writes no report, so it cannot itself be resumed; the
# resume path keys on the report existing, which is the real semantics.)
$seedRoot = ".ci/r84-runner-selfcheck-seed"
$seedRootAbs = Join-Path $repoRoot $seedRoot
if (Test-Path $seedRootAbs) { Remove-Item -Recurse -Force $seedRootAbs }
New-Item -ItemType Directory -Force -Path $seedRootAbs | Out-Null
Copy-Item -Recurse -Force (Join-Path $fixture "campaign/*") $seedRootAbs
$seedManifest = Join-Path $seedRootAbs "manifest.jsonl"
Assert-True (Test-Path $seedManifest) "the seeded root carries a manifest"
$seedBefore = @(Get-Content $seedManifest | Where-Object { $_ -ne "" }).Count
Assert-True ($seedBefore -eq 3) "the seeded manifest has 3 records (got $seedBefore)"

$seedArgs = @(
    "-Endpoint", "https://api.invalid.example/v1",
    # E4-R89: completion is now IDENTITY-bound, so a relaunch must present the
    # same provider/model the stored evidence records. The committed fixture's
    # reports name provider "test" / model "synthetic-1"; using a different model
    # here is a DIFFERENT experiment and is correctly refused (not skipped).
    "-Model", "synthetic-1",
    "-Provider", "test",
    "-Root", $seedRoot,
    "-CasesRoot", $casesRoot,
    "-Suites", "adversarial,stress"
)
$second = & pwsh -NoProfile -File $runner @seedArgs -DryRunOnly 2>&1 | Out-String
$secondExit = $LASTEXITCODE
Assert-True ($secondExit -eq 0) "second run exits 0 — got $secondExit"
$skips = ([regex]::Matches($second, "SKIP already stored")).Count
Assert-True ($skips -eq 3) "all 3 cases were SKIPPED on relaunch (got $skips)"
$seedAfter = @(Get-Content $seedManifest | Where-Object { $_ -ne "" }).Count
Assert-True ($seedAfter -eq 3) "no new manifest record was appended on relaunch ($seedBefore -> $seedAfter)"
Assert-True ($second -match "done=3 failed=0") "the relaunch reports 3 done (all skips), 0 failed"
Remove-Item -Recurse -Force $seedRootAbs

Write-Host "== 4. campaign validation re-derives the numbers =="
# Validate the fixture's COMMITTED campaign (the state a finished run leaves).
# A -DryRunOnly pass writes no report, so its root is deliberately NOT valid
# evidence — which step 4b asserts separately.
$validate = & node $cli benchmark campaign validate "scripts/benchmark/fixtures/r84-campaign/campaign" --cases $casesRoot --suites adversarial,stress --expect aaaa1111,bbbb2222 --emit-evidence $evidence 2>&1 | Out-String
$validateExit = $LASTEXITCODE
Assert-True ($validateExit -eq 0) "validate exits 0 — got $validateExit"
Assert-True ($validate -match "VALID") "the campaign is reported VALID"
# PROCESS success and CASE success are separate statistics and must never be
# substituted for one another.
Assert-True ($validate -match "stored cases \(runner exit 0 \+ report on disk\):\s+3") "3/3 PROCESS successes reported separately"
Assert-True ($validate -match "passed \(harness verified completion\):\s+1") "1/3 CASE successes reported separately"
Assert-True ($validate -match "model calls:\s+20") "model calls re-derived as 20"
Assert-True ($validate -match "tokens \(in/out\):\s+650 / 120") "tokens re-derived as 650/120"
Assert-True ($validate -match "expected cases \(versioned source\):\s+3") "3 expected cases from the versioned source"

Write-Host "== 4b. a root with no stored report is NOT valid evidence =="
$noEvidence = & node $cli benchmark campaign validate $root --cases $casesRoot --suites adversarial,stress 2>&1 | Out-String
Assert-True ($LASTEXITCODE -ne 0) "validating the report-less dry-run root FAILS closed"
Assert-True ($noEvidence -match "CAMPAIGN_NO_CASE_ARTIFACTS") "reason code is CAMPAIGN_NO_CASE_ARTIFACTS"

Write-Host "== 4c. the recorded evidence manifest makes the campaign tamper-DETECTING =="
# The committed fixture is the recorded baseline. A copy with ONE changed byte
# must FAIL, and so must a copy with an INJECTED file. Without --evidence a
# change only moves the digest (tamper-evident); with it the change is a
# failure (tamper-detecting).
$fixtureCampaign = "scripts/benchmark/fixtures/r84-campaign/campaign"
$tamperRoot = ".ci/r84-tamper"
$tamperAbs = Join-Path $repoRoot $tamperRoot
$fixtureEvidence = ".ci/r84-fixture-evidence.json"
$fixtureEvidenceAbs = Join-Path $repoRoot $fixtureEvidence
if (Test-Path $tamperAbs) { Remove-Item -Recurse -Force $tamperAbs }
Copy-Item -Recurse -Force (Join-Path $repoRoot $fixtureCampaign) $tamperAbs

& node $cli benchmark campaign validate $fixtureCampaign --cases $casesRoot --suites adversarial,stress --emit-evidence $fixtureEvidence | Out-Null
Assert-True ($LASTEXITCODE -eq 0) "the fixture's evidence manifest was emitted"

$tamperReport = Join-Path $tamperAbs "results/stress/syn-str-1/stress.json"
(Get-Content $tamperReport -Raw).Replace('"model_calls": 9', '"model_calls": 10') | Set-Content $tamperReport -NoNewline
$tampered = & node $cli benchmark campaign validate $tamperRoot --cases $casesRoot --suites adversarial,stress --evidence $fixtureEvidence 2>&1 | Out-String
Assert-True ($LASTEXITCODE -ne 0) "a one-byte change FAILS the campaign (exit $LASTEXITCODE)"
Assert-True ($tampered -match "CAMPAIGN_ARTIFACT_HASH_MISMATCH") "reason code is CAMPAIGN_ARTIFACT_HASH_MISMATCH"
Assert-True ($tampered -match "syn-str-1/stress\.json") "the offending file is named"

# Restore the byte, then inject an EXTRA file instead.
Copy-Item -Force (Join-Path $repoRoot "$fixtureCampaign/results/stress/syn-str-1/stress.json") $tamperReport
Set-Content (Join-Path $tamperAbs "results/stress/syn-str-1/injected.log") "x"
$injected = & node $cli benchmark campaign validate $tamperRoot --cases $casesRoot --suites adversarial,stress --evidence $fixtureEvidence 2>&1 | Out-String
Assert-True ($LASTEXITCODE -ne 0) "an injected evidence file FAILS the campaign (exit $LASTEXITCODE)"
Assert-True ($injected -match "injected\.log") "the injected file is named"

Remove-Item -Recurse -Force $tamperAbs
Remove-Item -Force $fixtureEvidenceAbs -ErrorAction SilentlyContinue

Write-Host "== 5. the evidence manifest leaks nothing =="
Assert-True (Test-Path $evidenceAbs) "the evidence manifest was written"
$ev = Get-Content $evidenceAbs -Raw
Assert-True ($ev -notmatch "[A-Za-z]:[\\/]") "no absolute Windows path"
Assert-True ($ev -notmatch "/Users/|/home/|AppData") "no user/home path"
Assert-True ($ev -notmatch "https?://") "no endpoint"
Assert-True ($ev -notmatch "sk-[A-Za-z0-9]") "no key-shaped string"
Assert-True ($ev -notmatch "api\.invalid") "not even the placeholder endpoint appears"
Assert-True ($ev -notmatch "\b[0-9a-f]{40}\b") "no real 40-hex source SHA"
$evJson = $ev | ConvertFrom-Json
Assert-True ($evJson.cases.Count -eq 3) "the manifest carries 3 case rows"
Assert-True ($evJson.declaredSummary.processRunSuccesses -eq 3) "processRunSuccesses recorded as 3"
Assert-True ($evJson.declaredSummary.passed -eq 1) "passed recorded as 1"

Write-Host "== 6. the committed fixture still matches its generator =="
& node (Join-Path $fixture "generate.mjs") --check | Out-Null
Assert-True ($LASTEXITCODE -eq 0) "generate.mjs --check reports no drift"

Write-Host ""
if ($script:failures -gt 0) {
    Write-Host "SELF-CHECK FAILED: $($script:failures) assertion(s)" -ForegroundColor Red
    exit 1
}
Write-Host "SELF-CHECK PASSED (0 provider calls, 0 cost)" -ForegroundColor Green
exit 0
