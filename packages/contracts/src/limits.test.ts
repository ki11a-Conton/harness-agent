// P3-3: child-count cap resolution — maxChildrenTotal / maxActiveChildren and
// the deprecated maxChildren alias.

import { describe, expect, it } from "vitest";
import { resolveChildLimits } from "./limits.js";

describe("P3-3: resolveChildLimits", () => {
  it("prefers maxChildrenTotal over the deprecated maxChildren alias", () => {
    expect(resolveChildLimits({ maxChildren: 3, maxChildrenTotal: 10, maxActiveChildren: 2 })).toEqual({
      total: 10,
      active: 2,
    });
  });

  it("falls back to maxChildren as the total alias (backward compatibility)", () => {
    expect(resolveChildLimits({ maxChildren: 5, maxActiveChildren: undefined })).toEqual({
      total: 5,
      active: undefined,
    });
  });

  it("defaults total to 0 (delegation disabled) when nothing is set", () => {
    expect(resolveChildLimits({ maxChildren: 0 })).toEqual({ total: 0, active: undefined });
  });

  it("exposes no active cap when maxActiveChildren is absent", () => {
    expect(resolveChildLimits({ maxChildren: 1, maxChildrenTotal: 1 })).toEqual({
      total: 1,
      active: undefined,
    });
  });
});
