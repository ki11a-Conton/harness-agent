import { z } from "zod";
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
export function jsonSchemaToZod(schema) {
    if (schema === undefined || typeof schema !== "object") {
        return z.record(z.string(), z.unknown());
    }
    const converted = convertNode(schema);
    return converted;
}
function convertNode(node) {
    const type = node.type;
    const isRequired = node.required;
    const requiredSet = new Set(Array.isArray(isRequired) ? isRequired.filter((r) => typeof r === "string") : []);
    switch (type) {
        case "string": {
            const base = z.string();
            return node.enum !== undefined ? z.enum(node.enum) : base;
        }
        case "number":
        case "integer":
            return z.number();
        case "boolean":
            return z.boolean();
        case "null":
            return z.null();
        case "array": {
            const items = node.items;
            if (items !== undefined && typeof items === "object" && items !== null && !Array.isArray(items)) {
                return z.array(convertNode(items));
            }
            return z.array(z.unknown());
        }
        case "object": {
            const properties = node.properties;
            if (properties !== undefined && typeof properties === "object" && properties !== null && !Array.isArray(properties)) {
                const shape = {};
                for (const [name, propSchema] of Object.entries(properties)) {
                    if (typeof propSchema === "object" && propSchema !== null && !Array.isArray(propSchema)) {
                        shape[name] = convertNode(propSchema);
                    }
                    else {
                        shape[name] = z.unknown();
                    }
                }
                const objectSchema = z.object(shape);
                // Reject unknown keys when the remote schema does not allow additional
                // properties (fail structurally instead of silently passing junk).
                if (node.additionalProperties === false)
                    return objectSchema.strict();
                return objectSchema.passthrough();
            }
            return z.record(z.string(), z.unknown());
        }
        default: {
            // No type keyword → permissive object (MCP arguments are JSON objects).
            return z.record(z.string(), z.unknown());
        }
    }
}
/** True when the schema declares `required` entries (used by callers that want
 *  to advertise a friendlier error than zod's generic message). */
export function requiredKeysOf(schema) {
    if (schema === undefined || typeof schema !== "object")
        return [];
    const required = schema.required;
    return Array.isArray(required) ? required.filter((r) => typeof r === "string") : [];
}
//# sourceMappingURL=json-schema-zod.js.map