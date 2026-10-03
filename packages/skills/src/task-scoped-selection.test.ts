import { describe, expect, it } from "vitest";
import { createTaskScopedSkillSelector, selectTaskScopedSkills } from "./task-scoped-selection.js";
import { newSessionId, newTurnId, type SkillIndexEntry } from "@ar/contracts";

const others = Array.from({ length: 7 }, (_, i) => ({ name: `build-${i}`, description: "build repair errors port config" }));
const target = (name: string): SkillIndexEntry => ({ name, description: "unrelated reference ".repeat(500) });
const names = (entries: SkillIndexEntry[]) => entries.map((entry) => entry.name);

describe("M2 task-scoped skill metadata strategy", () => {
  it.each([
    ["port-config", "帮我使用port-config技能修复build"],
    ["类型检查", "请使用类型检查技能修复build"],
    ["UI", "Use UI skill to repair build"],
    ["db", "Use skill db to repair build"],
    ["go", "请使用go技能修复build"],
    ["db", "使用 db 技能修复build"],
  ])("protects explicit %s under top-k and long-description pressure", (name, goal) => {
    const row = target(name);
    expect(selectTaskScopedSkills([...others, row], goal, { maxRelevantSkills: 1 }).selected).toContain(row);
  });
  it("preserves host-required safe-index rows and never fabricates foreign rows", () => {
    const required = target("global-policy");
    const result = selectTaskScopedSkills([...others, required], "build repair", { maxRelevantSkills: 1, requiredSkillNames: ["global-policy", "foreign"] });
    expect(names(result.selected)).toEqual(["build-0", "global-policy"]);
    expect(result.requiredNames).toEqual(["global-policy"]);
  });
  it("matches Chinese metadata without requiring spaces or English words", () => {
    const rows = [{ name: "weather", description: "天气预报" }, { name: "compiler", description: "类型检查与编译错误处理" }];
    expect(names(selectTaskScopedSkills(rows, "修复类型检查错误").selected)).toEqual(["compiler"]);
    expect(names(selectTaskScopedSkills(rows, "修复 TypeScript 类型检查错误").selected)).toEqual(["compiler"]);
  });
  it("does not treat host-required names as a relevance signal for an unknown task", () => {
    const index = [...others, target("global-policy")];
    expect(selectTaskScopedSkills(index, "quantum entanglement experiment", { requiredSkillNames: ["global-policy"] }).selected).toEqual(index);
  });
  it.each(["", "please fix this code", "未知的量子纠缠测量"]) ("retains the original index for unknown goal %s", (goal) => {
    const result = selectTaskScopedSkills(others, goal);
    expect(result.reason).toBe("unknown-fallback");
    expect(result.selected).toEqual(others);
    expect(result.excluded).toEqual([]);
  });
  it.each(["airport-config build", "port-config2 build", "dbase build"]) ("does not protect an embedded/prefix name for %s", (goal) => {
    const row = target(goal.startsWith("db") ? "db" : "port-config");
    const result = selectTaskScopedSkills([...others, row], goal, { maxRelevantSkills: 1 });
    expect(result.explicitNames).not.toContain(row.name);
    expect(result.selected).not.toContain(row);
  });
  it("preserves original index order after stable tie ranking", () => {
    const result = selectTaskScopedSkills(others, "build repair", { maxRelevantSkills: 2 });
    expect(names(result.selected)).toEqual(["build-0", "build-1"]);
  });
  it("freezes host policy while using the current turn goal", () => {
    const config = { strategy: "task_scoped_skills_v1" as const, maxRelevantSkills: 1, requiredSkillNames: ["global"] };
    const selector = createTaskScopedSkillSelector(config);
    config.maxRelevantSkills = 7; config.requiredSkillNames.push("build-6");
    const entries = [...others, target("global")];
    expect(names(selector(entries, { goal: "build repair", sessionId: newSessionId(), turnId: newTurnId() }))).toEqual(["build-0", "global"]);
  });
  it.each([0, -1, NaN, 1.5, Infinity])("rejects invalid relevance cap %s", (value) => {
    expect(() => selectTaskScopedSkills(others, "build", { maxRelevantSkills: value })).toThrow(/positive safe integer/);
  });
  it("rejects an unsupported strategy", () => {
    expect(() => createTaskScopedSkillSelector({ strategy: "unknown" } as never)).toThrow(/Unsupported/);
  });
});
