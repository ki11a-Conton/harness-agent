import { type ZodType } from "zod";
/**
 * JSON Schema → Zod conversion for MCP tool input schemas.
 *
 * ToolDefinition.inputSchema is a ZodType (the registry and orchestrator
 * validate arguments with it), but an MCP server advertises its tools with
 * JSON Schema. This converter covers the JSON-Schema subset MCP tools
 * realistically use; anything unrecognized falls back to a permissive
 * object schema so a remote tool never fails registration over an exotic
 * keyword (the schema hash in the provenance still pins the original JSON
 * Schema — see mcp-tool-view.schemaHash).
 */
export declare function jsonSchemaToZod(schema: Record<string, unknown> | undefined): ZodType;
/** True when the schema declares `required` entries (used by callers that want
 *  to advertise a friendlier error than zod's generic message). */
export declare function requiredKeysOf(schema: Record<string, unknown> | undefined): string[];
//# sourceMappingURL=json-schema-zod.d.ts.map