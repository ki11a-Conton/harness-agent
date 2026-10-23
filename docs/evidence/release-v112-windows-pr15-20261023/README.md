# e1 Windows PR15 acceptance synchronization

Historical source: `e1c073858ab9a81cab3fd6feae12e65ba5cac7f2`. Failed main run: `39894775938`, Windows N6 job: `120222544782`.

The saved original check annotations name the ordinary `goal-human-task` request regression and report `expected '' to be 'real bytes'`. They do not preserve the complete stack, runtime phase or underlying file-read error. N6 uses the short-line `r97-ci-diagnostics.mjs` publisher; the saved eleven annotations contain no gzip/base64 detail packet. The historical Windows cause remains **NOT_PROVEN**. The old assertion converted every read error to `''`, so its message does not distinguish a missing file, another read error, or a genuinely empty file. No evidence establishes a production write failure.

## Deterministic counterexample

A bounded local control used the actual durable Harness, Web composition, `goal-human-task`, real bound `write_file`, and local `ScriptedModelProvider`. An explicit handshake held the real orchestrator call before execution. The unmodified default `expect.poll` assertion failed after 1,023 ms with the exact reported message while the real turn was still running and its inbox item promoted. All 21 recorded file reads were ENOENT. No sleep released work, no fake write result was returned, no network or paid model was used.

After explicit release, the original tool completed successfully with ten real bytes. Holding the second scripted model response then showed the other side of the same acceptance error: the file already contained `real bytes`, but the turn was still running and its inbox still promoted. Only after releasing that response and awaiting the original durable inbox consumption method did the single bound turn become completed and its single inbox item consumed. The ordinary request metadata remained accepted, no goal existed, exactly two model requests occurred, and no permission denial occurred.

The control test passed 1/1. Raw local audit script, JSON lifecycle receipt and machine test report are retained in `/workspace/.cache/harness-longrun-20261020/windows-pr15-e1-audit/`. This is a Linux control of the synchronization contract, not a new native Windows acceptance result. The unmodified focused test also passed locally in 158 ms; that observation does not explain the historical Windows failure.

## Repair and acceptance

Only the affected PR15 test changes. It subscribes before prompt admission and delegates the actual owner inbox consumption method, resolving its observation only after the real durable mutation succeeds. It then requires one consumed inbox item, exactly its one completed bound turn, accepted ordinary request metadata, no goal, two real scripted model calls and the exact ten file bytes. A real consumption error rejects the wait and propagates; the original method is restored in `finally`. A finite hang guard reports the last business stage and leaves cleanup time within the existing coarse integration guard. There is no production change, retry, relaxed byte assertion, sleep or larger polling deadline.

Independent review found that rejecting only the acknowledgement promise cannot stop a still-pending admission after acknowledgement has already succeeded. The guard therefore has its own rejecting promise and races the combined admission/acknowledgement wait. An additional bounded, off-tracked await/cleanup control explicitly resolves acknowledgement first, holds admission, then observes the independent guard reject and `finally` restore the observer. This control tests the waiting mechanism only; the separate real Harness control above supplies the production lifecycle evidence. The existing 120-second coarse guard and cleanup allowance remain unchanged.

The next candidate must still pass clean local gates and native Windows CI. The failed e1 result and frozen release evidence remain unchanged.
