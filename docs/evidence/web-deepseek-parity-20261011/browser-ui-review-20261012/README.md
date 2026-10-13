# Actual official UI review, 2026-10-12

This directory retains the initial browser observations against the production Harness Web host on `http://127.0.0.1:46318`. Chromium loaded the original published DeepSeek client bytes; no RPC or HTTP responses were mocked. The model provider was a local HTTP fixture; no paid model calls were made by these control probes.

- Settings model editor, workspace directory chooser, plugin inventory and schedule catalog were accessed through the actual official controls and production RPCs.
- Plugin installation was unavailable because the host has no manageable plugin profile. Disabled buttons are not evidence that plugin management is complete.
- The initial file-tree probe showed `Reading…`; concurrent investigation identified HTTP/1 connection exhaustion. This observation alone does not prove a file-service defect.
- The initial terminal control exposed a genuine lazy-chunk crash: the Host graph used plain file URLs, while the unmodified official module loader requires `plugins/??<owner>/client.js&rev=<revision>`. The terminal UI is not accepted until a fresh production host demonstrates the repaired routes and lazy chunk loading.
- A real shell-discovery approval was rejected through the official UI during cleanup. No terminal process was authorized by this probe.
- `lazy-graph-negative-controls.log` records 10 passing offline integrity and negative-control tests. These tests prove provenance and graph rejection rules, not successful browser terminal operation.

The `Workspace filesBrowse` locator timeout in `surfaces-initial.json` was a test accessible-name mistake; it was corrected to a whitespace-tolerant locator in the deeper probe. The model-picker probe following the terminal test could not start because the session was awaiting the real shell-discovery approval; this is retained as context, not a separate model-selector defect.

Full conversational, tool, approval, question, reload, mobile, terminal, and all-control acceptance remains pending in these initial records.
