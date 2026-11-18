import { buildSyntaxIndex } from "./syntax-index.js";

export interface RelevantCodeMap {
  query: string;
  /** Explicit subset, when requested. Files and fingerprint cover this scope only. */
  scope?: string;
  indexer: "tree-sitter-wasm-v1"; semantic: false;
  fingerprint: string; filesIndexed: number; complete: boolean; truncated: boolean;
  files: { path: string; sha256: string; score: number; symbols: { name: string; line: number; endLine: number; text: string }[] }[];
  edges: { from: string; to: string; weight: number }[];
}

/** Personalized PageRank over sparse adjacency maps. Nodes without outgoing
 * references redistribute their combined mass using the same query prior. */
export function rankRelevantFiles(seed: readonly number[], links: readonly ReadonlyMap<number, number>[]): number[] {
  const sum = seed.reduce((total, value) => total + value, 0) || 1;
  const prior = seed.map(value => value / sum);
  const damping = 0.85;
  const transitions = links.map(targets => {
    const weights = [...targets].map(([target, count]) => ({ target, weight: Math.sqrt(count) }));
    const total = weights.reduce((sum, edge) => sum + edge.weight, 0);
    return weights.map(({ target, weight }) => ({ target, share: damping * weight / total }));
  });
  const dangling = transitions.flatMap((edges, i) => edges.length === 0 ? [i] : []);
  let rank = [...prior];
  for (let iteration = 0; iteration < 12; iteration++) {
    const danglingMass = dangling.reduce((mass, i) => mass + rank[i]!, 0);
    const priorWeight = 0.15 + damping * danglingMass;
    const next = prior.map(value => priorWeight * value);
    transitions.forEach((edges, source) => {
      for (const { target, share } of edges) next[target]! += rank[source]! * share;
    });
    rank = next;
  }
  return rank.map((value, i) => value + prior[i]!);
}

/** Aider-inspired design, independently implemented: syntax tags, a candidate
 * reference graph and query-personalized ranking under an explicit budget. */
export async function buildRelevantCodeMap(input: { root: string; query: string; path?: string; maxTokens?: number; signal?: AbortSignal }): Promise<RelevantCodeMap> {
  if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 512) throw new TypeError("invalid relevant code query");
  const maxTokens = input.maxTokens ?? 1600;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 128 || maxTokens > 4000) throw new TypeError("invalid relevant code token budget");
  const index = await buildSyntaxIndex(input.root, input.path ?? ".", input.signal);
  const tokens = [...new Set((input.query.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}_$]+/gu) ?? []).filter(word => word.length >= 3))].slice(0, 40);
  const definitions = new Map<string, Set<number>>();
  for (const [i, file] of index.files.entries()) for (const tag of file.tags) if (tag.role === "definition") {
    const key = tag.name.toLowerCase(); const targets = definitions.get(key) ?? new Set<number>(); targets.add(i); definitions.set(key, targets);
  }
  const links = index.files.map(() => new Map<number, number>());
  const seed = index.files.map(file => 1 + tokens.reduce((score, token) => score
    + (file.file.toLowerCase().includes(token) ? 8 : 0)
    + file.tags.reduce((sum, tag) => sum + (tag.name.toLowerCase().includes(token) ? (tag.role === "definition" ? 6 : 1) : 0), 0), 0));
  let edgeCount = 0;
  for (const [i, file] of index.files.entries()) {
    input.signal?.throwIfAborted();
    for (const tag of file.tags) {
      if (tag.role === "definition" || tag.name.length < 3 || edgeCount >= 20000) continue;
      const targets = definitions.get(tag.name.toLowerCase()); if (!targets || targets.size > 8) continue;
      for (const target of targets) if (target !== i) {
        if (!links[i]!.has(target)) edgeCount++;
        links[i]!.set(target, (links[i]!.get(target) ?? 0) + 1);
      }
    }
  }
  const scores = rankRelevantFiles(seed, links);
  const ordered = index.files.map((file, i) => ({ file, score: scores[i]! }))
    .sort((a, b) => b.score - a.score || a.file.file.localeCompare(b.file.file, "en"));
  const output: RelevantCodeMap = { query: input.query, ...(input.path === undefined ? {} : { scope: input.path }), indexer: index.indexer, semantic: false, fingerprint: index.fingerprint,
    filesIndexed: index.files.length, complete: index.complete && edgeCount < 20000, truncated: ordered.length > 12, files: [], edges: [] };
  for (const { file, score } of ordered.slice(0, 12)) {
    const tags = file.tags.filter(tag => tag.role === "definition").sort((a, b) =>
      Number(tokens.some(token => b.name.toLowerCase().includes(token))) - Number(tokens.some(token => a.name.toLowerCase().includes(token))) || a.line - b.line).slice(0, 8);
    output.files.push({ path: file.file, sha256: file.sha256, score, symbols: tags.map(({ name, line, endLine, text }) => ({ name, line, endLine, text })) });
  }
  const selected = new Set(output.files.map(file => file.path));
  for (const [i, targets] of links.entries()) for (const [j, weight] of targets) if (selected.has(index.files[i]!.file) && selected.has(index.files[j]!.file) && output.edges.length < 40) {
    output.edges.push({ from: index.files[i]!.file, to: index.files[j]!.file, weight });
  }
  while (Buffer.byteLength(JSON.stringify(output)) > maxTokens * 4) {
    output.truncated = true;
    if (output.edges.length) { output.edges.pop(); continue; }
    const last = output.files.at(-1);
    if (!last) {
      if (output.query.length) { output.query = Array.from(output.query).slice(0, Math.floor(Array.from(output.query).length / 2)).join(""); continue; }
      throw new RangeError("maxCodeTokens is too small to retain the requested scope metadata");
    }
    if (last.symbols.length) last.symbols.pop(); else output.files.pop();
  }
  output.complete &&= !output.truncated;
  return output;
}
