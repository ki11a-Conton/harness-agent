import { expect, it } from "vitest";
import { rankRelevantFiles } from "./relevant-code-map.js";

/** Previous deployed transition formula, used as an independent numeric oracle. */
function previousRank(seed: number[], links: Map<number, number>[]): number[] {
  const sum = seed.reduce((a, b) => a + b, 0);
  const prior = seed.map(value => value / sum);
  let rank = [...prior];
  for (let iteration = 0; iteration < 12; iteration++) {
    const next = prior.map(value => 0.15 * value);
    for (const [i, outgoing] of links.entries()) {
      const total = [...outgoing.values()].reduce((n, weight) => n + Math.sqrt(weight), 0);
      if (total === 0) {
        for (let j = 0; j < next.length; j++) next[j]! += 0.85 * rank[i]! * prior[j]!;
      } else {
        for (const [j, weight] of outgoing) next[j]! += 0.85 * rank[i]! * Math.sqrt(weight) / total;
      }
    }
    rank = next;
  }
  return rank.map((value, i) => value + prior[i]!);
}

it("preserves personalized repository ranking on weighted graphs with unlinked files", () => {
  for (const size of [6, 30, 120]) {
    const seed = Array.from({ length: size }, (_, i) => 1 + i % 11);
    const links = seed.map((_, i) => i % 3 === 0
      ? new Map([[(i + 1) % size, i + 3], [(i + 2) % size, 2]])
      : new Map<number, number>());
    const before = previousRank(seed, links);
    const after = rankRelevantFiles(seed, links);
    expect(after).toHaveLength(size);
    after.forEach((score, i) => expect(score).toBeCloseTo(before[i]!, 13));
    expect(after.reduce((sum, score) => sum + score, 0)).toBeCloseTo(2, 13);
  }
});

it("retains equal scores and the exact query prior when no reference links are present", () => {
  const scores = rankRelevantFiles([1, 9, 1, 9], Array.from({ length: 4 }, () => new Map()));
  expect(scores[0]).toBe(scores[2]);
  expect(scores[1]).toBe(scores[3]);
  expect(scores[0]).toBeCloseTo(0.1, 14);
  expect(scores[1]).toBeCloseTo(0.9, 14);
  expect(rankRelevantFiles([], [])).toEqual([]);
});
