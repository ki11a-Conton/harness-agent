<#
.SYNOPSIS
  E4-R81 — two-phase helper for the frozen E4-R74 baseline (Windows).

.DESCRIPTION
  Splits the runbook into two explicit phases so the plan digest cannot be
  produced and consumed in one accidental step:

    plan     - build the FINAL plan WITHOUT any API key and save its digest.
               Never contacts a provider, never reads or writes a secret, and
               never sets RUN_PAID_BENCHMARKS.
    execute  - run against the SAME parameters, requiring the digest AND an
               explicit -AuthorizePaidRun switch. It never reuses the last saved
               digest implicitly: a paid run must be a deliberate act.

  This script never writes a secret to disk. Credentials are only ever read from
  the environment by the CLI at execute time, and this script does not touch
  them.

.EXAMPLE
  .\scripts\baseline-plan.ps1 plan -Model gpt-4o-mini -Endpoint https://api.example.com/v1 `
      -MaxLogicalRuns 8 -MaxModelCalls 80 -MaxEstimatedTokens 320000 -MaxEstimatedCostUsd 0.04

.EXAMPLE
  .\scripts\baseline-plan.ps1 execute -PlanDigest <64-hex> -AuthorizePaidRun
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('plan', 'execute')]
  [string] $Phase,

  # ---- plan phase ----
  [string] $Model,
  [string] $Endpoint,
  [string] $Provider = 'openai',
  [int]    $Limit = 0,
  [int]    $MaxLogicalRuns,
  [int]    $MaxModelCalls,
  [int]    $MaxEstimatedTokens,
  [double] $MaxEstimatedCostUsd,

  # ---- execute phase ----
  [ValidatePattern('^[0-9a-f]{64}$')]
  [string] $PlanDigest,
  [switch] $AuthorizePaidRun,

  # ---- shared ----
  [string] $Cases = 'benchmarks/baseline-e4-r74',
  [string] $Out
)

$ErrorActionPreference = 'Stop'

function Fail([string] $Message) {
  Write-Error $Message
  exit 2
}

# The four budget flags are operator discipline (see runbook §3.1): this script
# refuses to run without them rather than silently leaving a cap unlimited.
# Presence is judged at the CALL SITE with `$PSBoundParameters`, because that
# variable is not visible from inside a function.
$budgetKeys = @('MaxLogicalRuns', 'MaxModelCalls', 'MaxEstimatedTokens', 'MaxEstimatedCostUsd')
$missingBudget = @($budgetKeys | Where-Object { -not $PSBoundParameters.ContainsKey($_) })
if ($missingBudget.Count -gt 0) {
  Fail "all four budget caps are required (they are bound into the plan digest): missing $(($missingBudget | ForEach-Object { "-$_" }) -join ', ')"
}
$budgetArgs = @(
  '--max-logical-runs', "$MaxLogicalRuns",
  '--max-model-calls', "$MaxModelCalls",
  '--max-estimated-tokens', "$MaxEstimatedTokens",
  '--max-estimated-cost-usd', "$MaxEstimatedCostUsd"
)

if (-not $Out -or $Out -eq '') {
  if ($Model -and $Model -ne '') {
    $stamp = Get-Date -Format 'yyyy-MM-dd'
    $Out = "benchmarks/results/$stamp-$Provider-$Model-baseline"
  } else {
    $Out = 'benchmarks/results/baseline'
  }
}

$cli = 'apps/cli/dist/main.js'
if (-not (Test-Path $cli)) { Fail "CLI not built: run 'pnpm build' first ($cli missing)" }

$args = @(
  $cli, 'benchmark',
  '--suite', 'regression',
  '--cases', $Cases,
  '--provider', $Provider,
  '--limit', "$Limit",
  '--out', $Out
)
if ($Model -and $Model -ne '')       { $args += @('--model', $Model) }
if ($Endpoint -and $Endpoint -ne '') { $args += @('--endpoint', $Endpoint) }

switch ($Phase) {
  'plan' {
    $args += $budgetArgs
    $args += @('--dry-run')
    # A dry-run must not depend on credentials; make that structural.
    $savedPaid = $env:RUN_PAID_BENCHMARKS
    $env:RUN_PAID_BENCHMARKS = $null
    try {
      $raw = & node @args 2>&1 | Out-String
      $code = $LASTEXITCODE
    } finally {
      $env:RUN_PAID_BENCHMARKS = $savedPaid
    }
    if ($code -ne 0) { Fail "plan failed (exit $code):`n$raw" }

    # The CLI may prefix advisory lines (e.g. the context-budget notice) before
    # the canonical plan JSON. Extract the JSON object rather than assuming the
    # whole stream is parseable, and FAIL if no plan object is present — a plan
    # we cannot read is a plan we must not authorize.
    $jsonStart = $raw.IndexOf('{')
    if ($jsonStart -lt 0) { Fail "plan produced no JSON object:`n$raw" }
    $plan = $raw.Substring($jsonStart) | ConvertFrom-Json
    if (-not $plan.planDigest) { Fail "plan JSON has no planDigest:`n$raw" }
    if ($plan.providerCalls -ne 0) { Fail "dry-run reported providerCalls=$($plan.providerCalls); expected 0" }

    New-Item -ItemType Directory -Force -Path $Out | Out-Null
    $digestPath = Join-Path $Out 'plan.digest'
    # ONLY the digest is persisted — never a key, never an endpoint credential.
    Set-Content -Path $digestPath -Value $plan.planDigest -NoNewline

    Write-Host $raw
    Write-Host ''
    Write-Host "plan digest : $($plan.planDigest)"
    Write-Host "saved to    : $digestPath"
    Write-Host "identity    : provider=$($plan.providerId) model=$($plan.modelId) endpointIdentity=$($plan.endpointIdentity)"
    Write-Host "billing     : $($plan.billingClass) (no key was needed to plan)"
    Write-Host ''
    Write-Host "NEXT: review the plan, then run 'execute -PlanDigest <digest> -AuthorizePaidRun'."
    Write-Host "      Adding or changing --provider/--model/--endpoint at execute time will invalidate this digest."
    exit 0
  }

  'execute' {
    if (-not $PSBoundParameters.ContainsKey('PlanDigest') -or -not $PlanDigest) {
      # Deliberately NOT defaulting to $Out/plan.digest: a paid run must quote the
      # digest explicitly rather than silently reusing the last one written.
      Fail "execute requires -PlanDigest <64-hex>. This script will not reuse the last saved digest automatically."
    }
    if (-not $AuthorizePaidRun) {
      Fail "execute requires the explicit -AuthorizePaidRun switch (paid authorization is never implicit)."
    }
    if (-not $env:OPENAI_API_KEY) {
      Fail "OPENAI_API_KEY is not set. Export it in this shell (it is never read from or written to a file by this script)."
    }

    $args += $budgetArgs
    $args += @('--plan-digest', $PlanDigest)
    $env:RUN_PAID_BENCHMARKS = '1'
    Write-Host "executing with the confirmed plan digest; any identity drift is refused BEFORE the first provider call."
    & node @args
    exit $LASTEXITCODE
  }
}
