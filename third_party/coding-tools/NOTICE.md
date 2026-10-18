# Coding tool adaptations

Snapshot matching and overlap rejection in packages/tools/src/edit.ts::applyBatchReplace adapt pi packages/coding-agent/src/core/tools/edit-diff.ts::applyEditsToNormalizedContent, Copyright (c) 2025 Mario Zechner, MIT. Full license: pi-LICENSE. Aggregate source snapshot: HARNESS-SRC-FORK@1a46ea13de9a3f5e6987c5dd0319b2000fe49c92 (not a separate pi upstream SHA).

Adaptations retain Harness's existing original-byte offsets, local CRLF/LF/BOM behavior, mandatory batch read version, cancellation, permissions and one-write boundary. No fuzzy/Unicode normalization, pi FS write implementation or dependency copied. Query scoping independently reuses the existing Harness syntax index; Aider/Codex/Hermes/DeepSeek are design references, with exact file hashes recorded in docs/evidence/coding-tools-20261019/sources.json.
