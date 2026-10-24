import { describe, expect, it } from "vitest";
import type { ModelRequest } from "@ar/contracts";
import { applyModelReasoning, reasoningCatalog, reasoningEffortsSchema } from "./reasoning.js";

describe("model reasoning editor wire contract", () => {
  it("advertises a valueless Off and preserves the custom max wire value", () => {
    const efforts = reasoningEffortsSchema.parse({ off: null, high: "high", max: "xhigh" });
    expect(reasoningCatalog(efforts)?.efforts.map(item => item.id)).toEqual(["off", "high", "max"]);
    const request = { messages: [], maxTokens: 17 } as unknown as ModelRequest;
    expect(applyModelReasoning(request, efforts, "max")).toMatchObject({ maxTokens: 17, reasoningEffort: "xhigh" });
    expect(request).not.toHaveProperty("reasoningEffort");
  });

  it("Off null removes an existing override without mutating the original request", () => {
    const request = { messages: [], reasoningEffort: "high", maxTokens: 21 } as unknown as ModelRequest;
    const next = applyModelReasoning(request, { off: null, high: "high" }, "off");
    expect(next).not.toHaveProperty("reasoningEffort");
    expect(next.maxTokens).toBe(21); expect(request.reasoningEffort).toBe("high");
  });

  it("keeps existing string-valued Off profiles compatible", () => {
    const request = { messages: [] } as unknown as ModelRequest;
    expect(applyModelReasoning(request, { off: "none", high: "high" }, "off").reasoningEffort).toBe("none");
  });

  it("does not infer a wire value for undeclared or disabled capabilities", () => {
    const request = { messages: [] } as unknown as ModelRequest;
    for (const map of [undefined, false, { high: "high" }] as const) {
      expect(applyModelReasoning(request, map, "max")).toBe(request);
    }
    expect(reasoningCatalog(false)).toBeUndefined();
  });

  it.each([{ off: null }, { high: null }, { off: null, high: "bad wire" }, { off: null, unknown: "high" }])("rejects an invalid capability map %j", value => {
    expect(reasoningEffortsSchema.safeParse(value).success).toBe(false);
  });
});
