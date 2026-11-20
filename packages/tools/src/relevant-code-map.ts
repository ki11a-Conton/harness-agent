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
  // Keep the original spelling of identifiers the user explicitly names.
  // Bare prose remains on the existing graph ranking.
  const exactSymbols = new Set<string>();
  for (const [word, quoted] of input.query.matchAll(/`([\p{L}_$][\p{L}\p{N}_$]*)`|[\p{L}\p{N}_$]+/gu)) {
    if (quoted !== undefined) exactSymbols.add(quoted);
    else if (/\p{Ll}\p{Lu}|\p{Lu}{2}\p{Ll}|[_$]/u.test(word)) exactSymbols.add(word);
  }
  const definitions = new Map<string, Set<number>>();
  const exactTiers = index.files.map(() => 0);
  for (const [i, file] of index.files.entries()) for (const tag of file.tags) {
    if (exactSymbols.has(tag.name)) {
      exactTiers[i] = Math.max(exactTiers[i]!, tag.role === "definition" ? 2 : 1);
    }
    if (tag.role === "definition") {
      const key = tag.name.toLowerCase(); const targets = definitions.get(key) ?? new Set<number>(); targets.add(i); definitions.set(key, targets);
    }
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
  // The graph score sums two unit-mass distributions. A fixed bonus per
  // tier puts exact declarations ahead of exact usages, then partial names.
  // Graph scores and path tie-breaking still determine order within a tier.
  const ordered = index.files.map((file, i) => ({ file, score: scores[i]! + 2 * exactTiers[i]! }))
    .sort((a, b) => b.score - a.score || a.file.file.localeCompare(b.file.file, "en"));
  const truncated = ordered.length > 12;
  const output: RelevantCodeMap = { query: input.query, ...(input.path === undefined ? {} : { scope: input.path }), indexer: index.indexer, semantic: false, fingerprint: index.fingerprint,
    filesIndexed: index.files.length, complete: index.complete && edgeCount < 20000 && !truncated, truncated, files: [], edges: [] };
  const tagPriority = (name: string) => {
    if (exactSymbols.has(name)) return 2;
    const normalized = name.toLowerCase();
    return tokens.some(token => normalized.includes(token)) ? 1 : 0;
  };
  for (const { file, score } of ordered.slice(0, 12)) {
    const tags = file.tags.filter(tag => tag.role === "definition").sort((a, b) =>
      tagPriority(b.name) - tagPriority(a.name) || a.line - b.line).slice(0, 8);
    output.files.push({ path: file.file, sha256: file.sha256, score, symbols: tags.map(({ name, line, endLine, text }) => ({ name, line, endLine, text })) });
  }
  const selected = new Set(output.files.map(file => file.path));
  for (const [i, targets] of links.entries()) for (const [j, weight] of targets) if (selected.has(index.files[i]!.file) && selected.has(index.files[j]!.file) && output.edges.length < 40) {
    output.edges.push({ from: index.files[i]!.file, to: index.files[j]!.file, weight });
  }
  while (Buffer.byteLength(JSON.stringify(output)) > maxTokens * 4) {
    output.truncated = true;
    output.complete = false;
    if (output.edges.length) { output.edges.pop(); continue; }
    const last = output.files.at(-1);
    if (!last) {
      if (output.query.length) { output.query = Array.from(output.query).slice(0, Math.floor(Array.from(output.query).length / 2)).join(""); continue; }
      throw new RangeError("maxCodeTokens is too small to retain the requested scope metadata");
    }
    if (last.symbols.length) last.symbols.pop(); else output.files.pop();
  }
  return output;
}
