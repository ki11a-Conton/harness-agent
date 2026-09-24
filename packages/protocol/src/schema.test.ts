import { describe, expect, it } from "vitest";
import { WIRE_SCHEMAS, schemaToJson, wireSchemaGolden } from "./schema.js";

describe("P29-10 schema generation / fixtures", () => {
  it("wire schema surface is a stable golden (protocol-breaking change shows as diff)", () => {
    // Guard the entire surface: extending a DTO (new field) or renaming a key
    // changes this golden and forces a deliberate version/migration decision.
    expect(wireSchemaGolden()).toMatchInlineSnapshot(`
      "### initialize.request

      {
        "type": "object",
        "properties": {
          "clientInfo": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string"
              },
              "version": {
                "type": "string"
              }
            },
            "required": [
              "name",
              "version"
            ],
            "additionalProperties": false
          },
          "capabilities": {
            "type": "object",
            "properties": {
              "streamingItems": {
                "type": "boolean"
              },
              "approvalForms": {
                "type": "boolean"
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "clientInfo"
        ],
        "additionalProperties": false
      }

      ### initialize.result

      {
        "type": "object",
        "properties": {
          "protocolVersion": {
            "type": "string"
          },
          "serverInfo": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string"
              },
              "version": {
                "type": "string"
              }
            },
            "required": [
              "name",
              "version"
            ],
            "additionalProperties": false
          },
          "capabilities": {
            "type": "object",
            "properties": {
              "streamingItems": {
                "type": "boolean"
              },
              "approvalForms": {
                "type": "boolean"
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "protocolVersion",
          "serverInfo",
          "capabilities"
        ],
        "additionalProperties": false
      }

      ### thread.start.params

      {
        "type": "object",
        "properties": {
          "agentName": {
            "type": "string"
          },
          "cwd": {
            "type": "string"
          },
          "idempotencyKey": {
            "type": "string"
          }
        },
        "required": [
          "agentName"
        ],
        "additionalProperties": false
      }

      ### turn.start.params

      {
        "type": "object",
        "properties": {
          "threadId": {
            "type": "string"
          },
          "prompt": {
            "type": "string"
          },
          "idempotencyKey": {
            "type": "string"
          }
        },
        "required": [
          "threadId",
          "prompt"
        ],
        "additionalProperties": false
      }

      ### approval.respond.params

      {
        "type": "object",
        "properties": {
          "approvalId": {
            "type": "string"
          },
          "decision": {
            "type": "string",
            "enum": [
              "allow",
              "deny"
            ]
          },
          "grantScope": {
            "type": "string",
            "enum": [
              "one_call",
              "one_tool",
              "session"
            ]
          }
        },
        "required": [
          "approvalId",
          "decision"
        ],
        "additionalProperties": false
      }

      ### threadItem

      {
        "type": "object",
        "properties": {
          "user_message": {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "enum": [
                  "user_message"
                ]
              },
              "sequence": {
                "type": "number"
              },
              "threadId": {
                "type": "string"
              },
              "text": {
                "type": "string"
              }
            },
            "required": [
              "kind",
              "sequence",
              "threadId",
              "text"
            ],
            "additionalProperties": false
          },
          "agent_message": {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "enum": [
                  "agent_message"
                ]
              },
              "sequence": {
                "type": "number"
              },
              "threadId": {
                "type": "string"
              },
              "text": {
                "type": "string"
              },
              "final": {
                "type": "boolean"
              }
            },
            "required": [
              "kind",
              "sequence",
              "threadId",
              "text"
            ],
            "additionalProperties": false
          },
          "tool_call": {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "enum": [
                  "tool_call"
                ]
              },
              "sequence": {
                "type": "number"
              },
              "threadId": {
                "type": "string"
              },
              "tool": {
                "type": "string"
              },
              "id": {
                "type": "string"
              },
              "args": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
              }
            },
            "required": [
              "kind",
              "sequence",
              "threadId",
              "tool",
              "id",
              "args"
            ],
            "additionalProperties": false
          },
          "tool_result": {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "enum": [
                  "tool_result"
                ]
              },
              "sequence": {
                "type": "number"
              },
              "threadId": {
                "type": "string"
              },
              "tool": {
                "type": "string"
              },
              "id": {
                "type": "string"
              },
              "ok": {
                "type": "boolean"
              }
            },
            "required": [
              "kind",
              "sequence",
              "threadId",
              "tool",
              "id",
              "ok"
            ],
            "additionalProperties": false
          },
          "approval": {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "enum": [
                  "approval"
                ]
              },
              "sequence": {
                "type": "number"
              },
              "threadId": {
                "type": "string"
              },
              "approvalId": {
                "type": "string"
              },
              "action": {
                "type": "string"
              },
              "target": {
                "type": "string"
              },
              "scope": {
                "type": "string",
                "enum": [
                  "one_call",
                  "one_tool",
                  "session"
                ]
              }
            },
            "required": [
              "kind",
              "sequence",
              "threadId",
              "approvalId",
              "action",
              "target",
              "scope"
            ],
            "additionalProperties": false
          },
          "ask_user": {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "enum": [
                  "ask_user"
                ]
              },
              "sequence": {
                "type": "number"
              },
              "threadId": {
                "type": "string"
              },
              "askId": {
                "type": "string"
              },
              "prompt": {
                "type": "string"
              }
            },
            "required": [
              "kind",
              "sequence",
              "threadId",
              "askId",
              "prompt"
            ],
            "additionalProperties": false
          }
        },
        "additionalProperties": false
      }
      "
    `);
  });

  it("every wire request schema exists", () => {
    for (const name of [
      "initialize.request",
      "initialize.result",
      "thread.start.params",
      "turn.start.params",
      "approval.respond.params",
      "threadItem",
    ] as const) {
      expect(WIRE_SCHEMAS[name]).toBeDefined();
    }
  });

  it("schemas serialize deterministically", () => {
    const a = schemaToJson(WIRE_SCHEMAS["initialize.request"]!);
    const b = schemaToJson(WIRE_SCHEMAS["initialize.request"]!);
    expect(a).toBe(b);
  });

  it("approval.respond decision is a closed enum", () => {
    const schema = WIRE_SCHEMAS["approval.respond.params"]!;
    expect(schema.properties?.decision?.enum).toEqual(["allow", "deny"]);
  });
});