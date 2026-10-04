import { ContextPipeline } from "@ar/context";
import type { ContextPipelineBuildOptions, ContextPipelineResult } from "@ar/context";

/** The Runtime's existing instruction identity consumes `discovered`.
 *  At the Harness boundary that view describes only the project blocks
 *  actually admitted to this model request, including their final content.
 *  The underlying ContextPipeline retains raw discovery for direct callers.
 */
export class EffectiveInstructionContextPipeline extends ContextPipeline {
  override async build(opts: ContextPipelineBuildOptions): Promise<ContextPipelineResult> {
    const built = await super.build(opts);
    const admitted = new Map(built.blocks
      .filter(block => block.source === "project" && block.path !== undefined)
      .map(block => [block.path!, block]));
    return { ...built, discovered: built.discovered.flatMap(doc => {
      const block = admitted.get(doc.path);
      return block !== undefined && block.id === doc.path ? [{ ...doc, content: block.content }] : [];
    }) };
  }
}
