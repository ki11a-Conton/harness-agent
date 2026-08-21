export class FakeOrchestrator {
    calls = [];
    result;
    constructor(result) {
        this.result = result ?? { status: "success", output: "fake-ok" };
    }
    async execute(request, _context) {
        this.calls.push({ request });
        return this.result;
    }
}
//# sourceMappingURL=fake-orchestrator.js.map