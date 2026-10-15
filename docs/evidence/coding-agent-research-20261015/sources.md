# 固定源码索引

逐文件字节数与 SHA-256 见 [sources.json](sources.json)。这里列的是选取的提示词及其生产接线、依赖机制和回归文件，不声称逐行审查了所有项目。

## harness

`2a141309f01acae3707060faf1fab8aa247ed31d` — project baseline

| ID | 固定源码 |
| --- | --- |
| H01 | [packages/agents/src/coding-prompt.ts](https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/agents/src/coding-prompt.ts) |
| H02 | [packages/harness/src/coding-prompt-policy.ts](https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/harness/src/coding-prompt-policy.ts) |
| H03 | [packages/harness/src/create-harness.ts](https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/harness/src/create-harness.ts) |
| H04 | [packages/harness/src/tool-names.ts](https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/harness/src/tool-names.ts) |
| H05 | [packages/harness/src/profiles.ts](https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/harness/src/profiles.ts) |
| H06 | [packages/harness/src/compose/compose-tools.ts](https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/harness/src/compose/compose-tools.ts) |
| H07 | [packages/harness/src/compose/compose-context.ts](https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/harness/src/compose/compose-context.ts) |
| H08 | [packages/context/src/compaction.ts](https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/context/src/compaction.ts) |
| H09 | [packages/context/src/pipeline.ts](https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/context/src/pipeline.ts) |
| H10 | [packages/context/src/rehydration.ts](https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/context/src/rehydration.ts) |
| H11 | [packages/contracts/src/working-state.ts](https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/contracts/src/working-state.ts) |
| H12 | [packages/core/src/runtime/context-controller.ts](https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/core/src/runtime/context-controller.ts) |
| H13 | [packages/memory/src/retrieval.ts](https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/memory/src/retrieval.ts) |
| H14 | [packages/harness/src/memory-search-production.regressions.test.ts](https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/harness/src/memory-search-production.regressions.test.ts) |
| H15 | [packages/tools/src/symbol-index.ts](https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/tools/src/symbol-index.ts) |
| H16 | [packages/tools/src/navigate.ts](https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/tools/src/navigate.ts) |
| H17 | [packages/contracts/src/model.ts](https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/contracts/src/model.ts) |
| H18 | [packages/model/src/openai.ts](https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/packages/model/src/openai.ts) |
| H19 | [docs/coding-prompts.md](https://github.com/ki11a-Conton/harness-agent/blob/2a141309f01acae3707060faf1fab8aa247ed31d/docs/coding-prompts.md) |

## collection

`1a46ea13de9a3f5e6987c5dd0319b2000fe49c92` — aggregated snapshots; not individual upstream commit identities

| ID | 固定源码 |
| --- | --- |
| CX01 | [codex-main/LICENSE](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/codex-main/LICENSE) |
| CX02 | [codex-main/codex-rs/core/gpt-5.2-codex_prompt.md](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/codex-main/codex-rs/core/gpt-5.2-codex_prompt.md) |
| CX03 | [codex-main/codex-rs/prompts/templates/compact/prompt.md](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/codex-main/codex-rs/prompts/templates/compact/prompt.md) |
| CX04 | [codex-main/codex-rs/core/src/compact.rs](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/codex-main/codex-rs/core/src/compact.rs) |
| CX05 | [codex-main/codex-rs/core/src/client.rs](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/codex-main/codex-rs/core/src/client.rs) |
| CX06 | [codex-main/codex-rs/ext/memories/templates/memories/read_path.md](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/codex-main/codex-rs/ext/memories/templates/memories/read_path.md) |
| HM01 | [hermes-agent-main/LICENSE](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/hermes-agent-main/LICENSE) |
| HM02 | [hermes-agent-main/agent/system_prompt.py](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/hermes-agent-main/agent/system_prompt.py) |
| HM03 | [hermes-agent-main/agent/prompt_builder.py](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/hermes-agent-main/agent/prompt_builder.py) |
| HM04 | [hermes-agent-main/agent/coding_context.py](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/hermes-agent-main/agent/coding_context.py) |
| HM05 | [hermes-agent-main/agent/prompt_cache_boundary.py](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/hermes-agent-main/agent/prompt_cache_boundary.py) |
| HM06 | [hermes-agent-main/agent/prompt_caching.py](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/hermes-agent-main/agent/prompt_caching.py) |
| HM07 | [hermes-agent-main/agent/context_compressor.py](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/hermes-agent-main/agent/context_compressor.py) |
| HM08 | [hermes-agent-main/agent/memory_manager.py](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/hermes-agent-main/agent/memory_manager.py) |
| HM09 | [hermes-agent-main/tools/memory_tool.py](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/hermes-agent-main/tools/memory_tool.py) |
| PI01 | [pi-main/LICENSE](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/pi-main/LICENSE) |
| PI02 | [pi-main/packages/coding-agent/src/core/system-prompt.ts](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/pi-main/packages/coding-agent/src/core/system-prompt.ts) |
| PI03 | [pi-main/packages/coding-agent/src/core/tools/read.ts](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/pi-main/packages/coding-agent/src/core/tools/read.ts) |
| PI04 | [pi-main/packages/coding-agent/src/core/compaction/compaction.ts](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/pi-main/packages/coding-agent/src/core/compaction/compaction.ts) |
| PI05 | [pi-main/packages/ai/src/api/openai-prompt-cache.ts](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/pi-main/packages/ai/src/api/openai-prompt-cache.ts) |
| CC01 | [claude-code-fork-main/README.md](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/claude-code-fork-main/README.md) |
| CC02 | [claude-code-fork-main/src/constants/prompts.ts](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/claude-code-fork-main/src/constants/prompts.ts) |
| CC03 | [claude-code-fork-main/src/constants/systemPromptSections.ts](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/claude-code-fork-main/src/constants/systemPromptSections.ts) |
| CC04 | [claude-code-fork-main/src/services/compact/prompt.ts](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/claude-code-fork-main/src/services/compact/prompt.ts) |
| CC05 | [claude-code-fork-main/src/services/compact/microCompact.ts](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/claude-code-fork-main/src/services/compact/microCompact.ts) |
| PI06 | [pi-main/packages/ai/src/api/openai-responses.ts](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/pi-main/packages/ai/src/api/openai-responses.ts) |
| PI07 | [pi-main/packages/ai/src/api/openai-responses-shared.ts](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/pi-main/packages/ai/src/api/openai-responses-shared.ts) |
| PI08 | [pi-main/packages/ai/src/api/anthropic-messages.ts](https://github.com/ki11a-Conton/HARNESS-SRC-FORK/blob/1a46ea13de9a3f5e6987c5dd0319b2000fe49c92/pi-main/packages/ai/src/api/anthropic-messages.ts) |

## deepseek

`5badb15009ae1756c3afe0ae0cef1faafc290ccc` — upstream checkout

| ID | 固定源码 |
| --- | --- |
| DS01 | [packages/core/system-prompt/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/system-prompt/src/index.ts) |
| DS02 | [packages/preset/persona/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/preset/persona/src/index.ts) |
| DS03 | [packages/compaction/compaction-basic/src/summarizer.ts](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-basic/src/summarizer.ts) |
| DS04 | [packages/compaction/compaction/src/tool-pairing.ts](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction/src/tool-pairing.ts) |
| DS05 | [packages/compaction/compaction-tool-result-pruner/src/config.ts](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-tool-result-pruner/src/config.ts) |
| DS06 | [packages/compaction/compaction-tool-result-pruner/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-tool-result-pruner/src/index.ts) |
| DS07 | [packages/core/system-prompt/package.json](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/system-prompt/package.json) |
| DS08 | [packages/preset/persona/package.json](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/preset/persona/package.json) |

## zcode

`aac4755666d09fdcd70272fcf063c077a639015f` — upstream checkout; v3.15.1 in package.json

| ID | 固定源码 |
| --- | --- |
| Z01 | [LICENSE](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/LICENSE) |
| Z02 | [NOTICE.md](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/NOTICE.md) |
| Z03 | [apps/zcode-cli/docs/design/v2/loop/system-prompt-contract.md](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/docs/design/v2/loop/system-prompt-contract.md) |
| Z04 | [apps/zcode-cli/packages/core/src/context/builder.ts](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/context/builder.ts) |
| Z05 | [apps/zcode-cli/packages/core/src/context/sections/identity.ts](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/context/sections/identity.ts) |
| Z06 | [apps/zcode-cli/packages/core/src/context/sections/cli-prefix.ts](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/context/sections/cli-prefix.ts) |
| Z07 | [apps/zcode-cli/packages/adapters/src/model/system-message-compat.ts](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/adapters/src/model/system-message-compat.ts) |
| Z08 | [apps/zcode-cli/packages/adapters/src/model/transform.ts](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/adapters/src/model/transform.ts) |
| Z09 | [apps/zcode-cli/packages/adapters/src/model/runner-normalization.ts](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/adapters/src/model/runner-normalization.ts) |
| Z10 | [apps/zcode-cli/packages/adapters/tests/openai-compatible-stream-usage-wire.test.ts](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/adapters/tests/openai-compatible-stream-usage-wire.test.ts) |
| Z11 | [apps/zcode-cli/packages/adapters/tests/model-transform-deepseek-anthropic.test.ts](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/adapters/tests/model-transform-deepseek-anthropic.test.ts) |

## aider

`5dc9490bb35f9729ef2c95d00a19ccd30c26339c` — supplementary retrieval/editing comparison

| ID | 固定源码 |
| --- | --- |
| A01 | [LICENSE.txt](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/LICENSE.txt) |
| A02 | [aider/repomap.py](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py) |
| A03 | [aider/coders/editblock_prompts.py](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/editblock_prompts.py) |
| A04 | [aider/coders/architect_prompts.py](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/architect_prompts.py) |
| A05 | [aider/coders/base_coder.py](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py) |
