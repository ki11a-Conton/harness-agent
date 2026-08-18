import type {
  ToolCallRequest,
  ToolExecutionContext,
  ToolOrchestrator,
  ToolResult,
} from "@ar/contracts";

export class FakeOrchestrator implements ToolOrchestrator {
  calls: Array<{ request: ToolCallRequest }> = [];
  result: ToolResult;

  constructor(result?: ToolResult) {
    this.result = result ?? { status: "success", output: "fake-ok" };
  }

  async execute(request: ToolCallRequest, _context: ToolExecutionContext): Promise<ToolResult> {
    this.calls.push({ request });
    return this.result;
  }
}