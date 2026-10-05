# Context budget audit — baseline 320cf3e

Read-only production audit. No tracked source/test edits. Original exploratory scripts, stdout, stderr and results are retained; `findings.json` hashes the originals and records the tested source/dist fingerprints.

## Deterministic production defect

`ContextPipeline` appends rehydration with its independent default 600-token budget, after the compacted footprint has already been selected. It does not limit the optional references to the remaining spendable headroom. This can turn a fitting digest into an avoidable context overflow.

The actual `createHarness` case uses the unchanged default main system prompt, ordinary user message `continue`, the real JSONL memory store and normal memory retrieval (opt-in). A small memory renders to 21 tokens and a large one to 1,521 tokens; both are actually retrieved, and the large one is dropped by the production budget planner. No storage, compactor, planner or model-request return values are mocked.

At host budget 165 with configured reserved values zero, Core adds the actual active user cost to the pipeline's task reservation. Thus the **actual pipeline input** is `reserved.task=10`, and spendable context is 155. The selected small memory compacts to a 17-token digest; system130 + digest17 =147, which fits. The optional transcript pointer adds11 => built.used158. Core checks built158 + active user10 =168 >165, emits `run.limit_reached {used:168}`, fails with RESOURCE_LIMIT and makes **zero provider requests**. Neighboring budget170 completes and makes one provider request.

The exact observations, durable events, full build inputs/results and request bytes are retained in `harness-memory-exploration.json`. Its command exits0 because this is an observation driver, not a passing acceptance claim. `findings.json` marks the defect reproduced and candidate validation NOT_RUN.

## Candidate scope and formula (unimplemented)

Change only pipeline rehydration admission to cap the independent default600 by the remaining spendable footprint:

`min(600, max(0, opts.budget.maxTokens - reserved.system - reserved.task - reserved.output - sum(compactedBlock.tokens)))`

For the actual165 case this is165 -10 -147 =8, so the optional11-token pointer cannot enter. The existing system and17-token summary remain byte-identical; the active user remains on the user channel. This reasoning is arithmetic over actual inputs, not a candidate production test. Do not incorrectly use the host's configured reserved0 in place of the observed pipeline reserved.task10, which would calculate18 and fail to fix the observed case. Do not additionally subtract the complete `report.messagesTokens`; the Runtime owns history trimming and has already reserved the active user.

Suggested acceptance: same actual165 memory case must complete with one provider request, fitting digest/user retained, optional pointer omitted;170/large-budget controls retain refs; reserved system/task/output and Unicode/custom estimator matrices keep final optional refs within spendable capacity; protected/digest irreducible overflow remains observable and never evicts anchors; no compaction means no rehydration. Existing compaction telemetry, breaker measured final footprint, no missing summary admission and memory/default-off boundaries must pass.

Root reviewed the original effective pipeline inputs and selected this candidate as R4 before preregistration. Implementation and candidate verification are pending; no candidate-success claim is made here.

## Original exploratory limits

- `harness-exploration.mjs` has an invalid relative import and exited1 before any Harness execution. Its raw stderr is retained. `harness-exploration-v2.mjs` corrected only the import.
- The write/read tool-loop exploration does not reproduce this issue because its real tool blocks are ephemeral and are removed by an earlier compactor stage; all six outcomes were completed. Its logs are controls, not a failure proof.
- `pipeline-exploration.json` is an additional actual built-dist observation: max100, zero reserve, digest50+system1 fit51; refs39+11 push used101. The original inline command is not independently stored as a script, so the reproducible original memory-driver case is the primary evidence.
- Paid requests0; scripted provider only. Actual model quality, provider tokenizer hard limits and Windows execution NOT_RUN. This is a context-estimate correctness defect, not evidence of model quality improvement.
