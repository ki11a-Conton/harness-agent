# Codex context compaction adaptation

Reference: local HARNESS-SRC-FORK collection commit `1a46ea13de9a3f5e6987c5dd0319b2000fe49c92`, `codex-main/codex-rs/`:

- `prompts/templates/compact/prompt.md`: handoff prompt copied and extended in `packages/context/src/history-checkpoint.ts`.
- `core/src/compact.rs`, `core/src/session/turn.rs`, `core/src/compact_token_budget.rs`: automatic threshold, summary checkpoint, current-context reinjection and continuation informed the TypeScript strategy. Rust runtime and hosted Responses compaction API are not copied.

OpenAI Codex, Copyright 2025 OpenAI. Apache-2.0 license and upstream notice retained at [codex-Apache-2.0.txt](codex-Apache-2.0.txt) and [codex-NOTICE.txt](codex-NOTICE.txt).

Changes: the summary uses the configured model with no tools through the existing model controller and budget; input/output/deadline are bounded. Historical data is redacted/scanned and quoted with assistant-level authority. Current human messages retain their original role. The complete transcript remains in storage and the checkpoint only changes the model view. Failures use an observable bounded extractive fallback. This generic Chat Completions path does not claim Codex's hosted remote-compaction endpoint or identical model quality.
