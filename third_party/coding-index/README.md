# Coding index provenance

Harness's syntax/tag walker, candidate graph and ranking code are independently implemented. The design comparison used Aider `aider/repomap.py` at `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` (Apache-2.0); no Aider implementation or prompt text was copied into the index.

Parsing uses the MIT-licensed npm dependency `@vscode/tree-sitter-wasm@0.3.1`, published from Microsoft/vscode-tree-sitter-wasm. The package contains the Tree-sitter runtime and grammar WASM; its package integrity is pinned by pnpm-lock.yaml. The upstream MIT notice is retained in LICENSE-tree-sitter-wasm and in the installed dependency. TS/TSX/JS, Python, Rust and Go grammars are loaded from this trusted dependency, never from workspace files or network URLs. Package cgmanifest.json records its upstream components.

WASM avoids native compiler installation and is not a claim of full semantic language-server resolution. Existing permissions and sandbox path checks still gate tools.
