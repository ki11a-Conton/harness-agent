/**
 * P29-10 — minimal JSON Schema generation for the protocol DTOs.
 *
 * The protocol types are TypeScript-only; this module derives a stable JSON
 * Schema surface for the wire DTOs so that (a) a client can validate inbound
 * requests in ANY language and (b) CI can diff the generated schema against a
 * committed golden file — a protocol-breaking change (adding/renaming/removing
 * a field) shows up as a schema diff and forces an explicit version/migration
 * review.
 *
 * This is intentionally a hand-maintained registry rather than a runtime
 * reflection library: the DTO set is small and stable, and hand-maintained
 * schemas make the golden diff attributable ("what changed") instead of opaque.
 */
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: readonly unknown[];
  additionalProperties?: boolean;
  description?: string;
}

const STRING_SCHEMA: JsonSchema = { type: "string" };
const NUMBER_SCHEMA: JsonSchema = { type: "number" };
const BOOLEAN_SCHEMA: JsonSchema = { type: "boolean" };

const OBJECT_SCHEMA = (props: Record<string, JsonSchema>, required: readonly string[] = []): JsonSchema => ({
  type: "object",
  properties: props,
  required: required.length > 0 ? [...required] : undefined,
  additionalProperties: false,
});

const THREAD_ITEM_A = OBJECT_SCHEMA(
  {
    kind: { ...STRING_SCHEMA, enum: ["user_message"] },
    sequence: NUMBER_SCHEMA,
    threadId: STRING_SCHEMA,
    text: STRING_SCHEMA,
  },
  ["kind", "sequence", "threadId", "text"],
);

const THREAD_ITEM_B = OBJECT_SCHEMA(
  {
    kind: { ...STRING_SCHEMA, enum: ["agent_message"] },
    sequence: NUMBER_SCHEMA,
    threadId: STRING_SCHEMA,
    text: STRING_SCHEMA,
    final: BOOLEAN_SCHEMA,
  },
  ["kind", "sequence", "threadId", "text"],
);

const THREAD_ITEM_C = OBJECT_SCHEMA(
  {
    kind: { ...STRING_SCHEMA, enum: ["tool_call"] },
    sequence: NUMBER_SCHEMA,
    threadId: STRING_SCHEMA,
    tool: STRING_SCHEMA,
    id: STRING_SCHEMA,
    args: OBJECT_SCHEMA({}),
  },
  ["kind", "sequence", "threadId", "tool", "id", "args"],
);

const THREAD_ITEM_D = OBJECT_SCHEMA(
  {
    kind: { ...STRING_SCHEMA, enum: ["tool_result"] },
    sequence: NUMBER_SCHEMA,
    threadId: STRING_SCHEMA,
    tool: STRING_SCHEMA,
    id: STRING_SCHEMA,
    ok: BOOLEAN_SCHEMA,
  },
  ["kind", "sequence", "threadId", "tool", "id", "ok"],
);

const THREAD_ITEM_E = OBJECT_SCHEMA(
  {
    kind: { ...STRING_SCHEMA, enum: ["approval"] },
    sequence: NUMBER_SCHEMA,
    threadId: STRING_SCHEMA,
    approvalId: STRING_SCHEMA,
    action: STRING_SCHEMA,
    target: STRING_SCHEMA,
    scope: { ...STRING_SCHEMA, enum: ["one_call", "one_tool", "session"] },
  },
  ["kind", "sequence", "threadId", "approvalId", "action", "target", "scope"],
);

const THREAD_ITEM_F = OBJECT_SCHEMA(
  {
    kind: { ...STRING_SCHEMA, enum: ["ask_user"] },
    sequence: NUMBER_SCHEMA,
    threadId: STRING_SCHEMA,
    askId: STRING_SCHEMA,
    prompt: STRING_SCHEMA,
  },
  ["kind", "sequence", "threadId", "askId", "prompt"],
);

export const WIRE_SCHEMAS = {
  "initialize.request": OBJECT_SCHEMA(
    {
      clientInfo: OBJECT_SCHEMA(
        { name: STRING_SCHEMA, version: STRING_SCHEMA },
        ["name", "version"],
      ),
      capabilities: OBJECT_SCHEMA({
        streamingItems: BOOLEAN_SCHEMA,
        approvalForms: BOOLEAN_SCHEMA,
      }),
    },
    ["clientInfo"],
  ),
  "initialize.result": OBJECT_SCHEMA(
    {
      protocolVersion: STRING_SCHEMA,
      serverInfo: OBJECT_SCHEMA(
        { name: STRING_SCHEMA, version: STRING_SCHEMA },
        ["name", "version"],
      ),
      capabilities: OBJECT_SCHEMA({
        streamingItems: BOOLEAN_SCHEMA,
        approvalForms: BOOLEAN_SCHEMA,
      }),
    },
    ["protocolVersion", "serverInfo", "capabilities"],
  ),
  "thread.start.params": OBJECT_SCHEMA(
    {
      agentName: STRING_SCHEMA,
      cwd: STRING_SCHEMA,
      idempotencyKey: STRING_SCHEMA,
    },
    ["agentName"],
  ),
  "turn.start.params": OBJECT_SCHEMA(
    {
      threadId: STRING_SCHEMA,
      prompt: STRING_SCHEMA,
      idempotencyKey: STRING_SCHEMA,
    },
    ["threadId", "prompt"],
  ),
  "approval.respond.params": OBJECT_SCHEMA(
    {
      approvalId: STRING_SCHEMA,
      decision: { ...STRING_SCHEMA, enum: ["allow", "deny"] },
      grantScope: { ...STRING_SCHEMA, enum: ["one_call", "one_tool", "session"] },
    },
    ["approvalId", "decision"],
  ),
  "threadItem": OBJECT_SCHEMA({
    user_message: THREAD_ITEM_A,
    agent_message: THREAD_ITEM_B,
    tool_call: THREAD_ITEM_C,
    tool_result: THREAD_ITEM_D,
    approval: THREAD_ITEM_E,
    ask_user: THREAD_ITEM_F,
  }),
};

/** Compile a registry entry to a stable canonical JSON string (golden diff). */
export function schemaToJson(schema: JsonSchema): string {
  return JSON.stringify(schema, null, 2);
}

/** Render the full wire schema surface for golden-file CI. */
export function wireSchemaGolden(): string {
  const text = Object.entries(WIRE_SCHEMAS)
    .map(([name, schema]) => `### ${name}\n\n${schemaToJson(schema)}\n`)
    .join("\n");
  return text;
}