# E4-R07 Report — Windows workspace-root canonical path comparison (F16)

## Defect

`resolveExecCwd` (packages/tools/src/tools/exec.ts) canonicalized the **candidate**
with `realpath` but compared the result against the **un-canonicalized**
`workspaceRoot`:

```ts
const root = resolve(workspaceRoot);          // lexical only
canonical = await realpath(candidate);
if (!within(canonical)) …                     // within() used `root`, not canonical root
```

So a workspace root reached through any legitimate **alias** resolved outside its
own root:

- POSIX: a symlinked temp/volume path (e.g. `/tmp -> /private/tmp`);
- Windows: a junction, an 8.3 short path, or a case-folded volume root — which
  is what the Windows CI runner's paths are.

Result: `relative(lexicalRoot, canonicalCandidate)` begins with `..` →
`WORKSPACE_POLICY:symlink-escape` on a cwd that was always inside the workspace.

## Reproduction (Windows, this host)

The regression `packages/tools/src/tools/exec-workspace-root-alias.test.ts` builds
a real directory + a **junction alias** to it (junctions need no elevation) and
uses the alias as the workspace root. Before the fix, 5 of 7 cases failed with
the exact signature; the diagnostic recorded:

```text
lexicalRoot        = …\ar-exec-alias-ar-exec-real-gDZ95A
canonicalRoot      = …\ar-exec-real-gDZ95A
canonicalCandidate = …\ar-exec-real-gDZ95A
relative(lexicalRoot, canonicalRoot) = ..\ar-exec-real-gDZ95A
error = WORKSPACE_POLICY:symlink-escape
```

This is the same mechanism the plan's Linux symlink repro produces, and the same
class the Windows CI job hits — the local default temp path on this machine is not
aliased, which is why the three CI files pass here without the repro.

## Fix

Use a consistent containment basis:

1. canonicalize `workspaceRoot` with the same `realpath` used for the candidate;
2. keep the cheap lexical pre-check against **both** the lexical and canonical
   root forms (a candidate written in the root's canonical form is legitimate);
3. enforce the security-critical containment **canonical vs canonical**.

An unresolvable root falls back to the lexical basis, so no case becomes more
permissive than before.

## Security preserved (not weakened)

Explicitly asserted by the new tests, all still passing:

- a link **inside** the aliased workspace pointing **outside** → still
  `symlink-escape`;
- `..` escape through an aliased root → still `cwd-outside`;
- absolute path outside the workspace → still `cwd-outside`;
- non-existent cwd → `cwd-unresolvable`; a file cwd → `cwd-not-directory`;
- `cwd` undefined / `""` / `"."` still mean the **session workspace**, never the
  host `process.cwd()`.

No existing security assertion was relaxed, no test skipped, and the Windows
matrix was not removed. The security sandbox
(`packages/security/src/sandbox.ts`) already canonicalized roots and targets with
the same function (P14-1), so `resolveExecCwd` was the sole outlier — confirmed by
inspection, and no other lexical-vs-canonical containment comparison matched in
`packages/**`.

## Test results

| group | before fix | after fix |
|---|---|---|
| `exec-workspace-root-alias.test.ts` (new, Windows junction repro) | 5 failed / 2 passed | 7 passed |
| `exec-workspace-policy.test.ts` | 12 passed (unaliased local temp) | 12 passed |
| `orchestrator.test.ts` + `vs001.test.ts` | 44 passed locally | 44 passed |
| full offline suite | — | see below |

Commands:

```bash
pnpm typecheck
pnpm exec vitest run packages/tools/src/tools/exec-workspace-policy.test.ts \
  packages/tools/src/tools/exec-workspace-root-alias.test.ts \
  packages/tools/src/orchestrator.test.ts packages/tools/src/vs001.test.ts
```

## Honest limits of this verification

The plan asks for per-failure confirmation of the 13 Windows CI failures. I
reproduced and fixed **one** mechanism with a genuine Windows alias (junction),
which explains the `exec` cwd class of failures across all three files. I have
**not** re-run GitHub's Windows runner, and the CI job
(102297187269, commit 0164738) predates this fix. If any of those 13 had an
independent shell/timeout cause, it will remain visible in the next CI run and
must be fixed on its own evidence — this report does not claim all 13 are closed
by inspection.

Confirmation therefore requires a **push + Windows CI run on the fix commit**,
which is not covered by the current authorization (local commits for review only).
The completed row for this deliverable is:

- Windows CI job URL for the fix commit: _pending push_ (`<fill after pushing>`).
