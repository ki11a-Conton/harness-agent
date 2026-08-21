import type { ExperimentConfig } from "@ar/contracts";
/** Parse a JSON or YAML config file into an ExperimentConfig. */
export declare function loadExperimentConfig(path: string): Promise<ExperimentConfig>;
/** Build an ExperimentConfig from a plain object with validation. */
export declare function experimentConfigFromObject(obj: Record<string, unknown>): ExperimentConfig;
/** Validate the raw object; returns error messages (empty = valid). */
export declare function validateExperimentConfigObject(obj: Record<string, unknown>): string[];
/** Minimal YAML subset parser: key:value scalars, - item lists, # comments. */
export declare function parseYaml(text: string): Record<string, unknown>;
//# sourceMappingURL=experiment-config.d.ts.map