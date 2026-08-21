import type { ToolCallRequest, ToolExecutionContext, ToolOrchestrator, ToolResult } from "@ar/contracts";
export declare class FakeOrchestrator implements ToolOrchestrator {
    calls: Array<{
        request: ToolCallRequest;
    }>;
    result: ToolResult;
    constructor(result?: ToolResult);
    execute(request: ToolCallRequest, _context: ToolExecutionContext): Promise<ToolResult>;
}
//# sourceMappingURL=fake-orchestrator.d.ts.map