// E4-R88 RED evidence: the PRE-R88 computeSummary (verbatim from git db16dac,
// TS types stripped exactly as the reviewer did) run against the reviewer's
// scenario: baseline TARGET failures with ZERO candidate records.
// Expected RED: improvement=1 and verdict MECHANISM_VALIDATED on incomplete evidence.
function computeSummaryPreR88(records) {
  const baseline = records.filter((r) => r.arm === "baseline");
  const candidate = records.filter((r) => r.arm === "candidate");
  const baselineTargetFires = baseline.filter((r) => r.role === "TARGET" && r.h2SignatureFires).length;
  const candidateTargetFires = candidate.filter((r) => r.role === "TARGET" && r.h2SignatureFires).length;

  const counterexampleOutcomeDiffs = [];
  for (const b of baseline.filter((r) => r.role === "COUNTEREXAMPLE")) {
    const c = candidate.find((r) => r.caseId === b.caseId);
    if (c === undefined) continue;
    if (c.status !== b.status || c.terminationReason !== b.terminationReason) {
      counterexampleOutcomeDiffs.push(b.caseId);
    }
  }

  const securityViolations = records.reduce((n, r) => n + r.securityViolations, 0);
  const verifiedCompletion = baseline
    .filter((r) => r.role === "COUNTEREXAMPLE" && r.status === "completed")
    .every((b) => candidate.find((r) => r.caseId === b.caseId)?.status === "completed");

  const improvement = baselineTargetFires - candidateTargetFires;
  let verdict;
  if (improvement > 0 && counterexampleOutcomeDiffs.length === 0 && securityViolations === 0 && verifiedCompletion) {
    verdict = "MECHANISM_VALIDATED";
  } else if (improvement <= 0 || securityViolations > 0 || counterexampleOutcomeDiffs.length > 0) {
    verdict = "REJECTED";
  } else {
    verdict = "INCONCLUSIVE";
  }
  return {
    mechanismMetric: { baselineTargetFires, candidateTargetFires, improvement },
    counterexampleOutcomeDiffs,
    securityViolations,
    verifiedCompletion,
    verdict,
  };
}

const baselineOnlyTargets = [1, 2, 3].map((n) => ({
  caseId: `target-${n}`,
  arm: "baseline",
  role: "TARGET",
  status: "failed",
  terminationReason: "tool_limit",
  h2SignatureFires: true,
  securityViolations: 0,
}));

const out = computeSummaryPreR88(baselineOnlyTargets);
console.log("PRE-R88 (RED) input: 3 baseline TARGET failures, 0 candidate records");
console.log("PRE-R88 (RED) output:", JSON.stringify(out));
const red = out.verdict === "MECHANISM_VALIDATED" && out.mechanismMetric.improvement > 0;
console.log("RED confirmed (bug present in the pre-R88 code):", red);
if (!red) {
  console.error("RED NOT REPRODUCED: the pre-R88 function did not validate incomplete evidence");
  process.exit(1);
}
