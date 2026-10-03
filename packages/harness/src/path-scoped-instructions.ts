import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import type { AgentEvent, EventStore } from "@ar/contracts";
import { ContextPipeline, PathScopedInstructionDiscovery } from "@ar/context";
import type { ContextPipelineBuildOptions, ContextPipelineDeps, ContextPipelineResult } from "@ar/context";

export interface PathScopedInstructionsConfig {
  strategy: "path_scoped_instructions_v1";
  /** Explicit host inputs, relative to the configured workspace root. */
  initialTargets?: readonly string[];
  maxDocuments?: number;
  maxBytesPerFile?: number;
}

/** Target scope comes from the latest successfully executed read/search
 *  batch. Requested, denied, failed and tool-output strings never qualify.
 *  Each batch is a union; a later batch replaces the previous scope. */
export function instructionTargetsFromEvents(events: readonly AgentEvent[], cwd: string): string[] {
  const requested = new Map<string, { name: string; args: Record<string, unknown>; batch: string }>();
  let activeBatch: string | undefined;
  let targets: string[] = [];
  for (const event of events) {
    const id = event.payload.toolCallId;
    if (typeof id !== "string") continue;
    if (event.type === "tool.requested") {
      const name = event.payload.name;
      const args = event.payload.args;
      if ((name === "read_file" || name === "search_files") && args !== null && typeof args === "object" && !Array.isArray(args)) {
        requested.set(id, { name, args: args as Record<string, unknown>, batch: typeof event.payload.stepId === "string" ? event.payload.stepId : id });
      }
    } else if (event.type === "tool.failed") {
      requested.delete(id);
    } else if (event.type === "tool.completed" && event.payload.status === "success") {
      const request = requested.get(id);
      if (request === undefined || event.payload.tool !== request.name) continue;
      requested.delete(id);
      const inputPath = request.args.path ?? (request.name === "search_files" ? "." : undefined);
      if (typeof inputPath !== "string" || inputPath.split(/[\\/]/u).includes("..")) continue;
      if (request.batch !== activeBatch) { activeBatch = request.batch; targets = []; }
      const path = resolve(cwd, inputPath);
      if (!targets.includes(path)) targets.push(path);
    }
  }
  return targets;
}

/** Request-local scope isolates concurrent sessions sharing a pipeline.
 *  Rehydration reads durable events, so restart/resume needs no target log. */
export class PathScopedContextPipeline extends ContextPipeline {
  readonly instructionDiscovery: PathScopedInstructionDiscovery;
  private readonly targets: AsyncLocalStorage<readonly string[]>;
  private readonly initialTargets: readonly string[];

  constructor(private readonly scope: { workspaceRoot: string; config: PathScopedInstructionsConfig; events: EventStore }, deps: ContextPipelineDeps = {}) {
    const targets = new AsyncLocalStorage<readonly string[]>();
    const discovery = new PathScopedInstructionDiscovery({ workspaceRoot: scope.workspaceRoot, targets: () => targets.getStore() ?? [],
      maxDocuments: scope.config.maxDocuments, maxBytesPerFile: scope.config.maxBytesPerFile });
    super({ ...deps, discovery });
    this.targets = targets;
    this.instructionDiscovery = discovery;
    this.initialTargets = (scope.config.initialTargets ?? []).map(path => path.split(/[\\/]/u).includes("..") ? path : resolve(scope.workspaceRoot, path));
  }

  override async build(opts: ContextPipelineBuildOptions): Promise<ContextPipelineResult> {
    const events = opts.telemetrySessionId === undefined ? [] : await this.scope.events.list(opts.telemetrySessionId as import("@ar/contracts").SessionId);
    const evidenceTargets = instructionTargetsFromEvents(events, opts.cwd);
    const targets = evidenceTargets.length > 0 ? evidenceTargets : this.initialTargets;
    return this.targets.run(targets, async () => {
      const built = await super.build({ ...opts, instructionOpts: {
        ...opts.instructionOpts,
        ...(this.scope.config.maxDocuments !== undefined ? { maxDocuments: this.scope.config.maxDocuments } : {}),
        ...(this.scope.config.maxBytesPerFile !== undefined ? { maxBytesPerFile: this.scope.config.maxBytesPerFile } : {}),
      } });
      // The existing Runtime pins discovered into instructionSources. For
      // this experimental adapter that identity must describe only documents
      // admitted to the model, including their exact bounded rendering.
      const admitted = new Set(built.blocks.filter(block => block.source === "project").map(block => block.path));
      return { ...built, discovered: built.discovered.filter(doc => admitted.has(doc.path)) };
    });
  }
}
