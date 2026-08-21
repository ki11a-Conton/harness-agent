import { readFile } from "node:fs/promises";
import { ExperimentHarness, renderReport } from "@ar/evaluation";
import { experimentConfigFromObject } from "@ar/evaluation";
export async function experimentCmd(args) {
    const [configPath] = args;
    if (configPath === undefined) {
        return {
            exitCode: 1,
            lines: ["usage: agent experiment <config.json|config.yaml>", "", "Runs a mechanism experiment with multiple variants and produces a comparison report (P2-9)."],
        };
    }
    try {
        const text = await readFile(configPath, "utf8");
        const obj = JSON.parse(text);
        const config = experimentConfigFromObject(obj);
        const harness = new ExperimentHarness();
        const report = await harness.run(config);
        const output = renderReport(report);
        return { exitCode: 0, lines: output.split("\n") };
    }
    catch (cause) {
        return { exitCode: 1, lines: [`error: ${String(cause)}`] };
    }
}
//# sourceMappingURL=experiment-command.js.map