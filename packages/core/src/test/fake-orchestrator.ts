import type {
  BoundToolCallRequest,
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

  /** P23-4: fake routes the bound request through execute() so subclass
   *  overrides (flaky/counting/recording) keep working — a bound call must
   *  behave exactly like the same call through the legacy path in fakes. */
  async executeBound(request: BoundToolCallRequest, context: ToolExecutionContext): Promise<ToolResult> {
    return this.execute(request, context);
  }
}