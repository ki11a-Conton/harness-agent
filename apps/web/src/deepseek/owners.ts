import { atomicReplace } from "@ar/store-integrity";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { newEventId } from "@ar/contracts";
import type {
  AgentEvent, AgentId, ArtifactId, ArtifactStore, AskId, AskUserStore, CheckpointStore,
  EventStore, InboxStore, ModelProvider, ModelRef, Session, SessionId,
  SessionStore, ToolDefinition, ToolResult, TurnId,
} from "@ar/contracts";
import { acquireDataDirLease, type DataDirLease } from "@ar/cli";
import { createRuntimeRpc, type RpcMethodRegistry } from "@ar/gateway";
import { createHarness, resolveHarnessConfig, resolveProfile, type Harness, type HarnessConfig } from "@ar/harness";
import { RemoteFailure } from "./transport.js";

/** References only. API keys, provider implementations, and execution state never enter the host index. */
export interface OwnerModelSelection { providerKey: string; modelId: string }
export interface OwnerHooks {
  dataDir?: string;
  /** A registered canonical directory already admitted by the workspace read/sandbox boundary. */
  workspace(id?: string): Promise<{ path: string; workspaceId?: string } | undefined>;
  executeHostTool(sessionId: string | undefined, definition: ToolDefinition, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
  resolveSelection?(selection: OwnerModelSelection, signal: AbortSignal): Promise<{ modelProvider: ModelProvider; model: ModelRef }>;
  /** New UI sessions may use children even in the primary cwd, preserving the legacy host. */
  newSessionsUseChildren?: boolean;
  /** Server-owned exact metadata files needed by model tools; never request-controlled paths. */
  extraSandboxPaths?: readonly string[];
  /** Register approved host tools on a newly composed owner before any new session is frozen. */
  configureOwner?(harness: Harness): Promise<void> | void;
  /** Host-owned activity not represented by Core stores (uploads, PTYs, schedules).
   * Their admission must use withSessionLock too, so a replacement cannot race it. */
  draftBlockers?(sessionId: string, signal: AbortSignal): Promise<readonly string[]>;
}
export interface OwnerView {
  id: string;
  path: string;
  workspaceId?: string;
  selection?: OwnerModelSelection;
  harness: Harness;
}
export interface OwnerManager {
  harnessFacade: Harness;
  rpcFacade: RpcMethodRegistry;
  createSession(workspaceId: string | undefined, signal: AbortSignal, selection?: OwnerModelSelection): Promise<Session>;
  ownerOf(sessionId: string): Promise<Harness>;
  ownerList(): OwnerView[];
  /** Only the Web facade uses aliases. Runtime/tool contexts always receive this real native identity. */
  nativeSessionId(sessionId: string): SessionId;
  externalSessionId(nativeId: string): SessionId;
  withSessionLock<T>(sessionId: string, action: () => Promise<T>): Promise<T>;
  /** Translate a committed physical event to the stable Web journal coordinates. */
  projectEvent(event: AgentEvent): Promise<AgentEvent | undefined>;
  journalCoordinate(sessionId: string, globalSequence: number): Promise<{ sessionId: SessionId; sequence: number }>;
  /** Durable reservations include owners still opening, so configuration writes cannot race their creation. */
  referencedSelections(signal: AbortSignal): Promise<OwnerModelSelection[]>;
  /** Replace only a pristine Web draft behind its stable identity. Existing native snapshots never change. */
  selectModel(sessionId: string, selection: OwnerModelSelection, signal: AbortSignal): Promise<void>;
  /** Children only; the composition root remains responsible for closing its base Harness. */
  close(): Promise<void>;
}

const selectionSchema = z.object({ providerKey: z.string().min(1).max(200), modelId: z.string().min(1).max(200) }).strict();
const rowSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), path: z.string().min(1).max(32768), workspaceId: z.string().min(1).max(200).optional(), selection: selectionSchema.optional() }).strict();
const aliasSchema = z.object({ externalId: z.string().min(1).max(200), nativeId: z.string().min(1).max(200), createdAt: z.number().finite(),
  retired: z.array(z.object({ nativeId: z.string().min(1).max(200), eventCount: z.number().int().nonnegative() }).strict()).max(1000) }).strict();
const legacyIndexSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), owners: z.array(rowSchema).max(1000) }).strict();
const indexSchema = z.object({ version: z.literal(2), revision: z.number().int().nonnegative(), owners: z.array(rowSchema).max(1000), aliases: z.array(aliasSchema).max(10000) }).strict();
type OwnerRow = z.infer<typeof rowSchema>;
type OwnerIndex = z.infer<typeof indexSchema>;
type SessionAlias = z.infer<typeof aliasSchema>;
const blankIndex = (): OwnerIndex => ({ version: 2, revision: 0, owners: [], aliases: [] });
function parseIndex(value: unknown): OwnerIndex {
  const legacy = legacyIndexSchema.safeParse(value);
  return legacy.success ? { ...legacy.data, version: 2, aliases: [] } : indexSchema.parse(value);
}
const inertSignal = () => new AbortController().signal;

function samePath(a: string, b: string): boolean { return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }
function identity(path: string, selection?: OwnerModelSelection): string {
  return createHash("sha256").update(JSON.stringify({ path: process.platform === "win32" ? path.toLowerCase() : path, selection })).digest("hex");
}
function proxy<T extends object>(base: T, replacements: Record<string, unknown>): T {
  return new Proxy(base, { get(target, key) {
    if (typeof key === "string" && Object.hasOwn(replacements, key)) return replacements[key];
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

/** Stores for one real Harness remain isolated. The facade only routes native identities; it never rewrites frozen snapshots. */
export async function createOwnerManager(base: Harness, hooks: OwnerHooks): Promise<OwnerManager> {
  const dataDir = hooks.dataDir ?? base.config.dataDir;
  const metadataPath = resolve(dataDir ?? base.config.cwd, "deepseek", "owners-index.json");
  for (const path of hooks.extraSandboxPaths ?? []) {
    const delta = relative(dirname(metadataPath), path);
    if (!isAbsolute(path) || resolve(path) !== path || delta === "" || isAbsolute(delta) || delta === ".." || delta.startsWith(`..${sep}`)) throw new RemoteFailure("gateway/forbidden", "Extra owner capabilities must name exact files beneath the fixed host metadata directory");
  }
  let memory = blankIndex();
  let indexChain = Promise.resolve();
  let closed = false;
  let closing: Promise<void> | undefined;
  const children = new Map<string, OwnerView & { lease?: DataDirLease }>();
  const opening = new Map<string, Promise<OwnerView>>();
  const sessionOwners = new Map<string, Harness>();
  const aliases = new Map<string, SessionAlias>();
  const nativeAliases = new Map<string, string>();
  const sessionLocks = new Map<string, Promise<void>>();
  const baseView: OwnerView = { id: "base", path: base.config.cwd, harness: base };
  const all = (): Harness[] => [base, ...[...children.values()].map(owner => owner.harness)];
  const guard = (): void => { if (closed) throw new RemoteFailure("gateway/cancelled", "Workspace owner manager is closed"); };
  const nativeSessionId = (id: string): SessionId => (aliases.get(id)?.nativeId ?? id) as SessionId;
  const externalSessionId = (id: string): SessionId => (nativeAliases.get(id) ?? id) as SessionId;
  const hiddenNative = (id: string): boolean => {
    const external = nativeAliases.get(id); return external !== undefined && aliases.get(external)?.nativeId !== id;
  };
  const privateNative = (id: string): boolean => nativeAliases.has(id) && nativeAliases.get(id) !== id;
  function installAliases(rows: SessionAlias[]): void {
    aliases.clear(); nativeAliases.clear();
    for (const row of rows) {
      if (aliases.has(row.externalId) || row.retired.length === 0 || row.retired[0]?.nativeId !== row.externalId
        || row.nativeId === row.externalId) throw new Error("Invalid stable session alias");
      aliases.set(row.externalId, structuredClone(row));
      for (const id of [row.nativeId, ...row.retired.map(item => item.nativeId)]) {
        if (nativeAliases.has(id)) throw new Error("Native identity appears in two stable session aliases");
        nativeAliases.set(id, row.externalId);
      }
    }
    for (const [external, row] of aliases) if (nativeAliases.get(external) !== external || aliases.has(row.nativeId)) throw new Error("Cyclic stable session alias");
  }
  async function withSessionLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    const external = externalSessionId(id); const prior = sessionLocks.get(external);
    let release!: () => void; const chain = new Promise<void>(done => { release = done; });
    sessionLocks.set(external, chain); await prior;
    try { guard(); return await action(); } finally { release(); if (sessionLocks.get(external) === chain) sessionLocks.delete(external); }
  }
  const outwardSession = (session: Session): Session => ({ ...session, id: externalSessionId(session.id), createdAt: aliases.get(externalSessionId(session.id))?.createdAt ?? session.createdAt,
    ...(session.parentId === undefined ? {} : { parentId: externalSessionId(session.parentId) }) });
  const inwardSession = (session: Session): Session => ({ ...session, id: nativeSessionId(session.id),
    ...(session.parentId === undefined ? {} : { parentId: nativeSessionId(session.parentId) }) });
  const outward = <T extends { sessionId: SessionId }>(value: T): T => ({ ...value, sessionId: externalSessionId(value.sessionId) });
  const inward = <T extends { sessionId: SessionId }>(value: T): T => ({ ...value, sessionId: nativeSessionId(value.sessionId) });
  const outwardTurn = (turn: Awaited<ReturnType<SessionStore["getTurn"]>>) => turn === undefined ? undefined : { ...outward(turn), input: outward(turn.input) };
  const inwardTurn = (turn: NonNullable<Awaited<ReturnType<SessionStore["getTurn"]>>>) => ({ ...inward(turn), input: inward(turn.input) });

  async function metadataDirectory(create: boolean): Promise<void> {
    const root = await realpath(dataDir!);
    const path = dirname(metadataPath);
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    const actual = await realpath(path);
    const delta = relative(root, actual);
    if (!samePath(actual, join(root, "deepseek")) || isAbsolute(delta) || delta === ".." || delta.startsWith(`..${sep}`) || (await lstat(path)).isSymbolicLink()) {
      throw new Error("Workspace owner metadata directory leaves its fixed host root");
    }
  }
  async function loadIndex(signal: AbortSignal): Promise<OwnerIndex> {
    signal.throwIfAborted();
    if (dataDir === undefined) return structuredClone(memory);
    let opened = false;
    try {
      await metadataDirectory(false);
      const handle = await open(metadataPath, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
      opened = true;
      try {
        const stat = await handle.stat();
        const expectedPath = join(await realpath(dirname(metadataPath)), basename(metadataPath));
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024 || !samePath(await realpath(metadataPath), expectedPath)) throw new Error("Invalid workspace owner index file");
        const chunks: Buffer[] = []; let bytes = 0;
        while (bytes <= 2 * 1024 * 1024) {
          signal.throwIfAborted();
          const buffer = Buffer.alloc(Math.min(64 * 1024, 2 * 1024 * 1024 + 1 - bytes));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes);
          if (bytesRead === 0) break;
          bytes += bytesRead; chunks.push(buffer.subarray(0, bytesRead));
        }
        if (bytes > 2 * 1024 * 1024) throw new Error("Workspace owner index exceeds its durable byte budget");
        const current = await handle.stat();
        if (stat.dev !== current.dev || stat.ino !== current.ino || stat.size !== current.size || stat.mtimeMs !== current.mtimeMs || stat.ctimeMs !== current.ctimeMs || bytes !== stat.size || !samePath(await realpath(metadataPath), expectedPath)) throw new Error("Workspace owner index changed during reading");
        const value = parseIndex(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
        const ids = new Set<string>();
        for (const row of value.owners) {
          if (!isAbsolute(row.path) || resolve(row.path) !== row.path || row.id !== identity(row.path, row.selection) || ids.has(row.id)) throw new Error("Invalid workspace owner index identity");
          ids.add(row.id);
        }
        // Validate aliases without publishing an uncommitted index into the live facade.
        const claimed = new Set<string>(); const externals = new Set(value.aliases.map(row => row.externalId));
        for (const row of value.aliases) {
          if (row.retired.length === 0 || row.retired[0]?.nativeId !== row.externalId || row.nativeId === row.externalId || externals.has(row.nativeId)) throw new Error("Invalid stable session alias");
          for (const id of [row.nativeId, ...row.retired.map(item => item.nativeId)]) { if (claimed.has(id)) throw new Error("Duplicate native session alias identity"); claimed.add(id); }
        }
        return value;
      } finally { await handle.close(); }
    } catch (error) { if (!opened && (error as NodeJS.ErrnoException).code === "ENOENT") return blankIndex(); throw error; }
  }
  async function saveIndex(document: OwnerIndex, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (dataDir === undefined) { memory = structuredClone(document); return; }
    await metadataDirectory(true);
    try { if ((await lstat(metadataPath)).isSymbolicLink()) throw new Error("Workspace owner index is a symlink"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = `${metadataPath}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(document)); await handle.sync(); } finally { await handle.close(); }
      signal.throwIfAborted(); await metadataDirectory(false); await atomicReplace(temporary, metadataPath, signal);
      if (process.platform !== "win32") { const directory = await open(dirname(metadataPath), "r"); try { await directory.sync(); } finally { await directory.close(); } }
    } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  }
  const readIndex: ToolDefinition = {
    name: "web_owner_index_read", description: "Read the fixed workspace owner reference registry.",
    inputSchema: z.object({ path: z.literal(metadataPath) }).strict(), risk: "readonly",
    metadata: { name: "web_owner_index_read", version: "1.0.0", filesystem: true, process: false, network: false, sideEffect: false, interactive: false, retry: "safe" },
    async execute(_input, context) { try { return { status: "success", output: await loadIndex(context.signal) }; }
      catch (error) { return persistenceFailure(error, context.signal); } },
  };
  const writeIndex: ToolDefinition = {
    name: "web_owner_index_write", description: "Commit the fixed workspace owner reference registry with revision checking.",
    inputSchema: z.object({ path: z.literal(metadataPath), expectedRevision: z.number().int().nonnegative(), document: indexSchema }).strict(), risk: "side_effect",
    metadata: { name: "web_owner_index_write", version: "1.0.0", filesystem: true, process: false, network: false, sideEffect: true, interactive: false, retry: "safe" },
    async execute(raw, context) {
      try {
        const input = raw as { expectedRevision: number; document: OwnerIndex };
        const current = await loadIndex(context.signal);
        if (current.revision !== input.expectedRevision || input.document.revision !== current.revision + 1) throw new Error("Workspace owner index revision changed");
        // Every supplied row is derived by this host, with no path segment admitted into the owner directory name.
        if (input.document.owners.some(row => !isAbsolute(row.path) || resolve(row.path) !== row.path || row.id !== identity(row.path, row.selection))) throw new Error("Invalid workspace owner reference");
        await saveIndex(input.document, context.signal); return { status: "success", output: input.document };
      } catch (error) { return persistenceFailure(error, context.signal); }
    },
  };
  const prepareOwner: ToolDefinition = {
    name: "web_owner_directory_prepare", description: "Prepare one fixed, non-symlink owner store beneath the host metadata directory.",
    inputSchema: z.object({ path: z.literal(metadataPath), ownerId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), risk: "side_effect",
    metadata: { name: "web_owner_directory_prepare", version: "1.0.0", filesystem: true, process: false, network: false, sideEffect: true, interactive: false, retry: "safe" },
    async execute(raw, context) {
      try {
        if (dataDir === undefined) return { status: "success", output: {} };
        await metadataDirectory(true);
        const parent = resolve(dirname(metadataPath), "owners");
        try { if ((await lstat(parent)).isSymbolicLink()) throw new Error("Workspace owner parent is a symlink"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await mkdir(parent, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
        const canonicalParent = join(await realpath(dirname(metadataPath)), "owners");
        if (!samePath(await realpath(parent), canonicalParent) || !(await lstat(parent)).isDirectory()) throw new Error("Workspace owner parent leaves its fixed directory");
        const target = resolve(parent, (raw as { ownerId: string }).ownerId);
        try { if ((await lstat(target)).isSymbolicLink()) throw new Error("Workspace owner directory is a symlink"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        context.signal.throwIfAborted(); await mkdir(target, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
        const canonicalTarget = join(canonicalParent, (raw as { ownerId: string }).ownerId);
        if (!samePath(await realpath(target), canonicalTarget) || !(await lstat(target)).isDirectory()) throw new Error("Workspace owner directory leaves its fixed directory");
        return { status: "success", output: { path: canonicalTarget } };
      } catch (error) { return persistenceFailure(error, context.signal); }
    },
  };
  async function invokeIndex(tool: ToolDefinition, args: Record<string, unknown>, signal: AbortSignal): Promise<OwnerIndex> {
    const result = await hooks.executeHostTool(undefined, tool, { path: metadataPath, ...args }, signal);
    if (result.status !== "success") throw new RemoteFailure(result.status === "cancelled" ? "gateway/cancelled" : "gateway/internal", result.error?.message ?? "Workspace owner registry could not be accessed");
    return parseIndex(result.output);
  }
  async function persistRow(row: OwnerRow, signal: AbortSignal): Promise<void> {
    const action = indexChain.then(async () => {
      guard(); signal.throwIfAborted();
      const document = await invokeIndex(readIndex, {}, signal);
      const old = document.owners.find(item => item.id === row.id);
      if (old !== undefined) return;
      const expectedRevision = document.revision;
      document.owners.push(row); document.revision++;
      await invokeIndex(writeIndex, { expectedRevision, document }, signal);
    });
    indexChain = action.then(() => {}, () => {}); await action;
  }
  async function persistAlias(row: SessionAlias, expectedNative: string, signal: AbortSignal): Promise<void> {
    const action = indexChain.then(async () => {
      guard(); signal.throwIfAborted();
      const document = await invokeIndex(readIndex, {}, signal);
      const index = document.aliases.findIndex(item => item.externalId === row.externalId);
      const previous = index < 0 ? row.externalId : document.aliases[index]!.nativeId;
      if (previous !== expectedNative) throw new RemoteFailure("session/conflict", "The stable session generation changed");
      const expectedRevision = document.revision;
      if (index < 0) document.aliases.push(row); else document.aliases[index] = row;
      document.revision++;
      await invokeIndex(writeIndex, { expectedRevision, document }, signal);
      // No await after the durable commit: readers switch to the exact committed generation together.
      installAliases(document.aliases);
    });
    indexChain = action.then(() => {}, () => {}); await action;
  }
  async function refreshOwner(owner: Harness): Promise<void> {
    for (const session of await owner.store.listSessions()) {
      if (session.modelSelection !== undefined) await owner.runtime.getSessionAgent(session.id);
      const prior = sessionOwners.get(session.id);
      if (prior !== undefined && prior !== owner) throw new RemoteFailure("gateway/conflict", "Native session identity appears in two workspace stores");
      sessionOwners.set(session.id, owner);
    }
  }
  async function resolvedSelection(selection: OwnerModelSelection | undefined, signal: AbortSignal) {
    if (selection === undefined) return { modelProvider: base.config.modelProvider, model: base.config.model };
    selectionSchema.parse(selection);
    if (hooks.resolveSelection === undefined) throw new RemoteFailure("model/not-found", "Model selection resolver is not configured");
    const result = await hooks.resolveSelection(selection, signal); signal.throwIfAborted();
    if (result.model.modelId !== selection.modelId || result.model.providerId !== result.modelProvider.id) throw new RemoteFailure("model/unavailable", "Resolved model identity does not match the selected provider");
    return result;
  }
  async function openOwner(row: OwnerRow, signal: AbortSignal): Promise<OwnerView> {
    guard(); signal.throwIfAborted();
    async function validate(ready: OwnerView): Promise<OwnerView> {
      const target = await resolvedSelection(row.selection, signal);
      const requested = resolveHarnessConfig({ profile: ready.harness.profile, overrides: { ...ready.harness.config, ...target } });
      if (requested.fingerprint !== ready.harness.resolvedConfig.fingerprint) throw new RemoteFailure("session/provider-config-changed", "This provider reference already owns frozen sessions. Add a new provider reference to use another configuration.");
      return ready;
    }
    const ready = children.get(row.id); if (ready !== undefined) return validate(ready);
    const pending = opening.get(row.id); if (pending !== undefined) return validate(await pending);
    const promise = (async () => {
      const selection = await resolvedSelection(row.selection, signal);
      guard(); signal.throwIfAborted();
      const ownerDir = dataDir === undefined ? undefined : resolve(dataDir, "deepseek", "owners", row.id);
      const prepared = await hooks.executeHostTool(undefined, prepareOwner, { path: metadataPath, ownerId: row.id }, signal);
      if (prepared.status !== "success") throw new RemoteFailure("gateway/internal", prepared.error?.message ?? "Workspace owner directory preparation failed");
      const lease = await acquireDataDirLease(ownerDir);
      lease?.ref();
      let harness: Harness | undefined;
      try {
        signal.throwIfAborted(); guard();
        if (ownerDir !== undefined && (!lease?.dataDir || !samePath(lease.dataDir, (prepared.output as { path: string }).path))) throw new RemoteFailure("gateway/forbidden", "Workspace owner store resolved outside its fixed directory");
        const originalSandbox = base.config.sandboxPolicy ?? resolveProfile(base.profile).sandbox;
        const config: HarnessConfig = { ...base.config, cwd: row.path, dataDir: lease?.dataDir, ...selection,
          ...(hooks.extraSandboxPaths === undefined || hooks.extraSandboxPaths.length === 0 ? {} : { sandboxPolicy: { ...originalSandbox,
            filesystem: { ...originalSandbox.filesystem, allowedPaths: [...originalSandbox.filesystem.allowedPaths ?? [], ...hooks.extraSandboxPaths] } } }),
          // A sibling workspace must never share the original owner's SQLite memory file.
          ...(base.config.memory?.dbPath === undefined ? {} : { memory: { ...base.config.memory, dbPath: lease === undefined ? undefined : resolve(lease.dataDir, "memory.db") } }),
        };
        harness = await createHarness(config);
        await hooks.configureOwner?.(harness);
        signal.throwIfAborted(); guard();
        const view = { ...row, harness, ...(lease === undefined ? {} : { lease }) };
        await refreshOwner(harness); children.set(row.id, view); lease?.unref(); return view;
      } catch (error) {
        try { await harness?.close(); } finally { await lease?.release(); }
        throw error;
      }
    })();
    opening.set(row.id, promise);
    try { return await promise; } finally { if (opening.get(row.id) === promise) opening.delete(row.id); }
  }
  async function findNativeOwner(sessionId: string): Promise<Harness | undefined> {
    guard(); const cached = sessionOwners.get(sessionId); if (cached !== undefined) return cached;
    let found: Harness | undefined;
    for (const owner of all()) {
      if (await owner.store.getSession(sessionId as SessionId) === undefined) continue;
      if (found !== undefined) throw new RemoteFailure("gateway/conflict", "Native session identity appears in two workspace stores");
      found = owner;
    }
    if (found !== undefined) sessionOwners.set(sessionId, found); return found;
  }
  async function findOwner(sessionId: string): Promise<Harness | undefined> {
    if (privateNative(sessionId)) return undefined;
    return findNativeOwner(nativeSessionId(sessionId));
  }
  async function ownerOf(sessionId: string): Promise<Harness> {
    const owner = await findOwner(sessionId);
    if (owner === undefined) throw new RemoteFailure("session/not-found", "Session does not belong to this host"); return owner;
  }
  async function ownerOfTurn(turnId: TurnId): Promise<Harness | undefined> {
    guard(); let found: Harness | undefined;
    for (const owner of all()) {
      if (await owner.store.getTurn(turnId) === undefined) continue;
      if (found !== undefined) throw new RemoteFailure("gateway/conflict", "Turn identity appears in two workspace stores"); found = owner;
    }
    return found;
  }
  function ownerFromAgent(agentId: AgentId): Harness {
    guard(); const matches = all().filter(owner => owner.runtime.getAgent(agentId) !== undefined);
    if (matches.length !== 1) throw new RemoteFailure("agent/not-found", "Agent identity has no unique workspace owner"); return matches[0]!;
  }
  async function createSession(workspaceId: string | undefined, signal: AbortSignal, selection?: OwnerModelSelection): Promise<Session> {
    guard(); signal.throwIfAborted();
    const workspace = workspaceId === undefined ? { path: base.config.cwd } : await hooks.workspace(workspaceId);
    if (workspace === undefined || !isAbsolute(workspace.path) || resolve(workspace.path) !== workspace.path) throw new RemoteFailure("workspace/not-found", "Registered canonical workspace is unavailable");
    const choice = selection === undefined ? undefined : selectionSchema.parse(selection);
    let owner: Harness;
    if (!hooks.newSessionsUseChildren && samePath(workspace.path, base.config.cwd) && choice === undefined) owner = base;
    else {
      const row: OwnerRow = { id: identity(workspace.path, choice), path: workspace.path,
        ...(workspace.workspaceId === undefined ? workspaceId === undefined ? {} : { workspaceId } : { workspaceId: workspace.workspaceId }),
        ...(choice === undefined ? {} : { selection: choice }) };
      // Reference commitment precedes session creation: restart can always discover a durable session owner.
      await resolvedSelection(choice, signal); await persistRow(row, signal); owner = (await openOwner(row, signal)).harness;
    }
    signal.throwIfAborted(); guard();
    const agent = owner.agents[0]; if (agent === undefined) throw new RemoteFailure("agent/not-found", "Workspace owner has no runnable agent");
    // The creating owner's service freezes every required baseline while the
    // row is still failed, then publishes active. A failed Web initialization
    // must not leave a runnable session discoverable through list/restart.
    const session = await owner.sessionService.create({ agentId: agent.id, model: agent.model, cwd: owner.config.cwd });
    sessionOwners.set(session.id, owner);
    return session;
  }

  async function assertDraft(owner: Harness, session: Session, externalId: string, signal: AbortSignal): Promise<AgentEvent[]> {
    signal.throwIfAborted();
    const [turns, messages, inboxRows, pendingAsks, artifacts, journal, childrenRows, extra] = await Promise.all([
      owner.store.listTurns(session.id), owner.store.listMessages(session.id), owner.inbox.listAll(session.id),
      owner.askUserStore?.listPending(session.id) ?? [], owner.artifactStore?.bySessionId(session.id) ?? [],
      owner.events.list(session.id), store.listSessions({ parentId: externalId as SessionId }),
      hooks.draftBlockers?.(externalId, signal) ?? [],
    ]);
    signal.throwIfAborted();
    // This is a fresh Web draft, not an in-place edit of a Runtime snapshot.
    // In particular an admitted-but-not-yet-promoted input already freezes it.
    if (owner === base || session.status !== "active" || session.parentId !== undefined || turns.length || messages.length || inboxRows.length
      || pendingAsks.length || owner.approvalStore.listPending(session.id).length || owner.approvalStore.listDecisions(session.id).length
      || artifacts.length || childrenRows.length || extra.length || journal.some(event => event.turnId !== undefined
        || (!["session.created", "session.resumed"].includes(event.type)
          && !(event.type === "human.message" && event.payload.hostOnly === true && event.payload.kind === "web_model_selection"
            && typeof event.payload.selection === "object" && event.payload.selection !== null
            && (event.payload.selection as Record<string, unknown>).provider === session.model.providerId
            && (event.payload.selection as Record<string, unknown>).model === session.model.modelId)))) {
      throw new RemoteFailure("session/model-frozen", "Model selection can change only before this Web draft has any admitted input, tool activity, attachment, or child session");
    }
    if (journal.some((event, index) => event.sequence !== index) || await owner.events.nextSequence(session.id) !== journal.length) {
      throw new RemoteFailure("session/alias-corrupt", "A draft journal is not a dense immutable prefix");
    }
    return journal;
  }

  async function activateReplacement(row: SessionAlias): Promise<void> {
    const owner = await findNativeOwner(row.nativeId); const current = await owner?.store.getSession(row.nativeId as SessionId);
    if (owner === undefined || owner === base || current === undefined) throw new RemoteFailure("session/alias-corrupt", "A stable session has no committed native owner");
    if (current.status !== "failed") return;
    const snapshot = await owner.store.loadStateSnapshot(current.id);
    const [turns, messages, pending, asks, artifacts] = await Promise.all([
      owner.store.listTurns(current.id), owner.store.listMessages(current.id), owner.inbox.listAll(current.id),
      owner.askUserStore?.listPending(current.id) ?? [], owner.artifactStore?.bySessionId(current.id) ?? [],
    ]);
    if (snapshot === undefined || turns.length || messages.length || pending.length || asks.length || artifacts.length
      || owner.approvalStore.listPending(current.id).length || owner.approvalStore.listDecisions(current.id).length
      || (await owner.checkSessionConfigDrift(current.id)).severity !== "none") {
      throw new RemoteFailure("session/alias-corrupt", "A committed replacement cannot be safely activated");
    }
    // Keep retired native drafts unrunnable even for privileged native callers.
    // A crash at this point is recovered from the already committed index.
    for (const retired of row.retired) {
      const previousOwner = await findNativeOwner(retired.nativeId); const previous = await previousOwner?.store.getSession(retired.nativeId as SessionId);
      if (previousOwner === undefined || previous === undefined) throw new RemoteFailure("session/alias-corrupt", "A retired draft owner is missing");
      if (previous.status !== "failed") await previousOwner.store.updateSession({ ...previous, status: "failed" });
    }
    await owner.store.updateSession({ ...current, status: "active" });
  }

  async function selectModel(sessionId: string, selected: OwnerModelSelection, signal: AbortSignal): Promise<void> {
    return withSessionLock(sessionId, async () => {
      guard(); signal.throwIfAborted();
      const choice = selectionSchema.parse(selected); const owner = await ownerOf(sessionId);
      const nativeId = nativeSessionId(sessionId); const session = await owner.store.getSession(nativeId);
      if (session === undefined) throw new RemoteFailure("session/not-found", "Session does not belong to this host");
      const target = await resolvedSelection(choice, signal);
      const requested = resolveHarnessConfig({ profile: owner.profile, overrides: { ...owner.config, ...target } });
      if (session.model.providerId === target.model.providerId && session.model.modelId === target.model.modelId
        && requested.fingerprint === owner.resolvedConfig.fingerprint) {
        if (session.modelSelection !== undefined) await owner.runtime.getSessionAgent(nativeId);
        const committed = aliases.get(sessionId);
        if (committed !== undefined) await activateReplacement(committed);
        else if (session.status === "failed") throw new RemoteFailure("session/not-found", "Failed initialization is not a selectable Web session");
        return;
      }
      let prefix: Awaited<ReturnType<typeof assertDraft>> | undefined;
      try {
        prefix = await assertDraft(owner, session, sessionId, signal);
      } catch (error) {
        // DSH parity: a session that already admitted input, tool activity or a
        // child keeps its identity and transcript. The selection applies to its
        // next request instead of being refused.
        if (!(error instanceof RemoteFailure) || error.code !== "session/model-frozen") throw error;
      }
      const originalView = [...children.values()].find(view => view.harness === owner);
      if (prefix === undefined) {
        if (originalView === undefined) throw new RemoteFailure("session/model-frozen", "Legacy sessions keep their frozen model");
        await owner.runtime.setSessionModel(nativeId, target.model);
        return;
      }
      if (originalView === undefined) throw new RemoteFailure("session/model-frozen", "Legacy sessions keep their frozen model");
      const row: OwnerRow = { id: identity(session.cwd, choice), path: session.cwd,
        ...(originalView.workspaceId === undefined ? {} : { workspaceId: originalView.workspaceId }), selection: choice };
      await persistRow(row, signal);
      const replacementOwner = (await openOwner(row, signal)).harness;
      const agent = replacementOwner.agents[0]; if (agent === undefined) throw new RemoteFailure("agent/not-found", "Selected owner has no runnable agent");
      // Never expose an unfrozen runnable replacement. A failure before the CAS
      // leaves this private failed placeholder and the original draft intact.
      const replacement = await replacementOwner.runtime.createSession({ agent, cwd: session.cwd, initialStatus: "failed" });
      sessionOwners.set(replacement.id, replacementOwner);
      await replacementOwner.freezeConfigFingerprint(replacement.id);
      await replacementOwner.events.appendNew({ id: newEventId(), sessionId: replacement.id, timestamp: Date.now(), type: "human.message",
        payload: { hostOnly: true, kind: "web_model_selection", selection: { provider: replacement.model.providerId, model: replacement.model.modelId } } });
      signal.throwIfAborted(); guard();
      const checked = await assertDraft(owner, session, sessionId, signal);
      if (checked.length !== prefix.length || checked.some((event, index) => event.id !== prefix[index]!.id)) {
        throw new RemoteFailure("session/conflict", "The draft journal changed while preparing its selected model");
      }
      const previous = aliases.get(sessionId);
      const committed: SessionAlias = { externalId: sessionId, nativeId: replacement.id,
        createdAt: previous?.createdAt ?? session.createdAt,
        retired: [...previous?.retired ?? [], { nativeId, eventCount: prefix.length }] };
      await persistAlias(committed, nativeId, signal);
      // The durable alias is now the authority. Complete activation without
      // honoring a late browser abort; a retry/restart performs the same step.
      await activateReplacement(committed);
      await owner.sessions.unload(nativeId);
    });
  }

  await refreshOwner(base);
  try {
    const index = await invokeIndex(readIndex, {}, inertSignal()); for (const row of index.owners) await openOwner(row, inertSignal());
    for (const row of index.aliases) {
      for (const retired of row.retired) {
        const owner = await findNativeOwner(retired.nativeId);
        const journal = await owner?.events.list(retired.nativeId as SessionId);
        if (owner === undefined || owner === base || journal?.length !== retired.eventCount || journal.some((event, index) => event.sequence !== index)
          || (await owner.store.listTurns(retired.nativeId as SessionId)).length > 0 || (await owner.store.listMessages(retired.nativeId as SessionId)).length > 0
          || (await owner.inbox.listAll(retired.nativeId as SessionId)).length > 0) throw new RemoteFailure("session/alias-corrupt", "A retired draft no longer matches its immutable journal prefix");
      }
      const owner = await findNativeOwner(row.nativeId); const current = await owner?.store.getSession(row.nativeId as SessionId);
      if (owner === undefined || owner === base || current === undefined) throw new RemoteFailure("session/alias-corrupt", "A stable session has no committed native owner");
      // Recover the only crash window: the index was committed after freeze but before draft activation.
      if (current.status === "failed") await activateReplacement(row);
    }
    installAliases(index.aliases);
  }
  catch (error) { closed = true; for (const owner of children.values()) { try { await owner.harness.close(); } finally { await owner.lease?.release(); } } throw error; }

  const store: SessionStore = {
    async createSession(session) { const owner = ownerFromAgent(session.agentId); if (!samePath(session.cwd, owner.config.cwd)) throw new RemoteFailure("session/conflict", "Session cwd must match its frozen workspace owner"); if (await findOwner(session.id) !== undefined) throw new RemoteFailure("session/conflict", "Session identity already has an owner"); await owner.store.createSession(session); sessionOwners.set(session.id, owner); },
    async getSession(id) { const session = await (await findOwner(id))?.store.getSession(nativeSessionId(id)); return session === undefined ? undefined : outwardSession(session); },
    async updateSession(session) {
      const owner = await ownerOf(session.id); const native = inwardSession(session); const original = await owner.store.getSession(native.id);
      if (original === undefined || original.agentId !== native.agentId || original.cwd !== native.cwd || original.model.providerId !== native.model.providerId || original.model.modelId !== native.model.modelId || JSON.stringify(original.modelSelection) !== JSON.stringify(native.modelSelection)) throw new RemoteFailure("session/conflict", "Host update cannot mutate a session's frozen model, agent, or cwd");
      await owner.store.updateSession(native);
    },
    async listSessions(opts) {
      const owners = all(); const options = opts?.parentId === undefined ? opts : { ...opts, parentId: nativeSessionId(opts.parentId) };
      const groups = await Promise.all(owners.map(owner => owner.store.listSessions(options)));
      for (let i = 0; i < groups.length; i++) for (const session of groups[i]!) {
        const owner = owners[i]!; const prior = sessionOwners.get(session.id);
        if (prior !== undefined && prior !== owner) throw new RemoteFailure("gateway/conflict", "Native session identity appears in two workspace stores"); sessionOwners.set(session.id, owner);
      }
      return groups.flat().filter(session => !hiddenNative(session.id)).map(outwardSession).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    },
    async createTurn(turn) { if (await ownerOfTurn(turn.id) !== undefined) throw new RemoteFailure("session/conflict", "Turn identity already has an owner"); await (await ownerOf(turn.sessionId)).store.createTurn(inwardTurn(turn)); },
    async getTurn(id) { return outwardTurn(await (await ownerOfTurn(id))?.store.getTurn(id)); },
    async updateTurn(turn) { const owner = await ownerOf(turn.sessionId); const native = inwardTurn(turn); if ((await owner.store.getTurn(turn.id))?.sessionId !== native.sessionId) throw new RemoteFailure("session/conflict", "Turn ownership differs from its session"); await owner.store.updateTurn(native); },
    async listTurns(id) { return (await (await ownerOf(id)).store.listTurns(nativeSessionId(id))).map(turn => outwardTurn(turn)!); },
    async appendMessage(message) { const owner = await ownerOf(message.sessionId); const native = inward(message); if (message.turnId !== undefined && (await owner.store.getTurn(message.turnId))?.sessionId !== native.sessionId) throw new RemoteFailure("session/conflict", "Message turn does not belong to this session"); await owner.store.appendMessage(native); },
    async listMessages(id) { return (await (await ownerOf(id)).store.listMessages(nativeSessionId(id))).map(outward); },
    async listMessagesByTurn(id, turnId) { const owner = await ownerOf(id); const turn = await owner.store.getTurn(turnId); if (turn?.sessionId !== nativeSessionId(id)) throw new RemoteFailure("session/conflict", "Message query turn does not belong to this session"); return (await owner.store.listMessagesByTurn(nativeSessionId(id), turnId)).map(outward); },
    async saveStateSnapshot(id, snapshot) { await (await ownerOf(id)).store.saveStateSnapshot(nativeSessionId(id), snapshot); },
    async loadStateSnapshot(id) { return (await ownerOf(id)).store.loadStateSnapshot(nativeSessionId(id)); },
  };
  function eventPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const result = { ...payload };
    for (const key of ["sessionId", "parentId", "parentSessionId", "childSessionId", "sourceSessionId", "targetSessionId"]) if (typeof result[key] === "string") result[key] = externalSessionId(result[key]);
    return result;
  }
  async function projectEvent(event: AgentEvent): Promise<AgentEvent | undefined> {
    const external = externalSessionId(event.sessionId); const row = aliases.get(external);
    if (row === undefined) return { ...event, payload: eventPayload(event.payload) };
    let offset = 0;
    for (const retired of row.retired) {
      if (retired.nativeId === event.sessionId) return event.sequence < retired.eventCount ? { ...event, sessionId: external, sequence: offset + event.sequence, payload: eventPayload(event.payload) } : undefined;
      offset += retired.eventCount;
    }
    if (row.nativeId !== event.sessionId) return undefined;
    return { ...event, sessionId: external, sequence: offset + event.sequence, payload: eventPayload(event.payload) };
  }
  async function journalCoordinate(id: string, globalSequence: number): Promise<{ sessionId: SessionId; sequence: number }> {
    if (!Number.isSafeInteger(globalSequence) || globalSequence < 0) throw new RemoteFailure("gateway/bad-request", "Invalid stable journal coordinate");
    await ownerOf(id); let sequence = globalSequence; const row = aliases.get(externalSessionId(id));
    for (const retired of row?.retired ?? []) {
      if (sequence < retired.eventCount) return { sessionId: retired.nativeId as SessionId, sequence };
      sequence -= retired.eventCount;
    }
    const nativeId = nativeSessionId(externalSessionId(id)); const owner = await ownerOf(id);
    if (sequence >= await owner.events.nextSequence(nativeId)) throw new RemoteFailure("session/not-found", "Stable journal coordinate is outside this session");
    return { sessionId: nativeId, sequence };
  }
  async function listEvents(id: SessionId, opts?: { afterSequence?: number; limit?: number }): Promise<AgentEvent[]> {
    const owner = await ownerOf(id); const row = aliases.get(externalSessionId(id));
    if (row === undefined) return (await owner.events.list(nativeSessionId(id), opts)).map(event => ({ ...event, payload: eventPayload(event.payload) }));
    const physical: AgentEvent[] = [];
    const after = opts?.afterSequence ?? -1;
    let offset = 0;
    // Retired drafts are immutable safety boundaries. Always validate every
    // prefix, even when a bounded query starts after it or already has enough
    // results; a cache/watermark must not conceal a lost retired generation.
    for (const retired of row.retired) {
      const oldOwner = await findNativeOwner(retired.nativeId); if (oldOwner === undefined) throw new RemoteFailure("session/alias-corrupt", "Stable draft prefix owner is missing");
      const prefix = await oldOwner.events.list(retired.nativeId as SessionId);
      if (prefix.length !== retired.eventCount || new Set(prefix.map(event => event.id)).size !== prefix.length
        || prefix.some((event, index) => event.sessionId !== retired.nativeId || event.sequence !== index || Object.is(event.sequence, -0))) {
        throw new RemoteFailure("session/alias-corrupt", "A retired draft no longer matches its immutable journal prefix");
      }
      for (const event of prefix) if (offset + event.sequence > after && (opts?.limit === undefined || physical.length < opts.limit)) physical.push(event);
      offset += retired.eventCount;
    }
    const remaining = opts?.limit === undefined ? undefined : Math.max(0, opts.limit - physical.length);
    if (remaining !== 0) {
      const bounded = opts?.afterSequence !== undefined || opts?.limit !== undefined;
      physical.push(...await owner.events.list(row.nativeId as SessionId, bounded
        ? { afterSequence: Math.max(-1, after - offset), ...(remaining === undefined ? {} : { limit: remaining }) } : undefined));
    }
    return (await Promise.all(physical.map(projectEvent))).filter((event): event is AgentEvent => event !== undefined);
  }

  const events: EventStore = {
    async append(event) { const row = aliases.get(externalSessionId(event.sessionId)); const offset = row?.retired.reduce((sum, retired) => sum + retired.eventCount, 0) ?? 0;
      if (event.sequence < offset) throw new RemoteFailure("session/conflict", "Cannot append into a retired draft journal prefix");
      const committed = await (await ownerOf(event.sessionId)).events.append({ ...inward(event), sequence: event.sequence - offset }); return (await projectEvent(committed))!; },
    async appendNew(event) { const committed = await (await ownerOf(event.sessionId)).events.appendNew(inward(event)); return (await projectEvent(committed))!; },
    list: listEvents,
    async *stream(id, opts) { yield* await listEvents(id, opts); },
    async nextSequence(id) { const owner = await ownerOf(id); const row = aliases.get(externalSessionId(id)); return (row?.retired.reduce((sum, retired) => sum + retired.eventCount, 0) ?? 0) + await owner.events.nextSequence(nativeSessionId(id)); },
  };
  const sessions: Harness["sessions"] = {
    async load(id) {
      const actor = await (await ownerOf(id)).sessions.load(nativeSessionId(id));
      const stableId = externalSessionId(actor.sessionId);
      const currentActor = (): void => {
        guard(); if (nativeSessionId(stableId) !== actor.sessionId) throw new RemoteFailure("session/conflict", "This actor belongs to a retired draft generation; load the stable session again");
      };
      const inputForActor = (input: Parameters<typeof actor.createTurn>[0]) => {
        currentActor(); if (input.sessionId !== stableId) throw new RemoteFailure("session/conflict", "Input session differs from its loaded actor");
        return inward(input);
      };
      const queue = proxy(actor.inputQueue, {
        sessionId: stableId,
        enqueueSteer: async (input: Parameters<typeof actor.inputQueue.enqueueSteer>[0]) => actor.inputQueue.enqueueSteer(inputForActor(input)),
        enqueueFollowup: async (input: Parameters<typeof actor.inputQueue.enqueueFollowup>[0]) => actor.inputQueue.enqueueFollowup(inputForActor(input)),
        reservePendingFollowup: async () => { currentActor(); const reserved = await actor.inputQueue.reservePendingFollowup(); return reserved === undefined ? undefined : { ...reserved, input: outward(reserved.input) }; },
        bindReservedFollowup: async (...args: Parameters<typeof actor.inputQueue.bindReservedFollowup>) => { currentActor(); return actor.inputQueue.bindReservedFollowup(...args); },
        completeReservedFollowup: async (...args: Parameters<typeof actor.inputQueue.completeReservedFollowup>) => { currentActor(); return actor.inputQueue.completeReservedFollowup(...args); },
        releaseReservedFollowup: async (...args: Parameters<typeof actor.inputQueue.releaseReservedFollowup>) => { currentActor(); return actor.inputQueue.releaseReservedFollowup(...args); },
      });
      const replacements = {
        sessionId: stableId, inputQueue: queue,
        resourceScope: proxy(actor.resourceScope, { sessionId: stableId }),
        startTurn: async (...args: Parameters<typeof actor.startTurn>) => { const handle = await actor.startTurn(inputForActor(args[0]), args[1]); return { ...handle, outcome: handle.outcome.then(outwardOutcome) }; },
        createTurn: async (input: Parameters<typeof actor.createTurn>[0]) => outwardTurn(await actor.createTurn(inputForActor(input)))!,
        runTurn: async (...args: Parameters<typeof actor.runTurn>) => { currentActor(); return outwardOutcome(await actor.runTurn(...args)); },
        steer: async (input: Parameters<typeof actor.steer>[0]) => actor.steer(inputForActor(input)),
        enqueueFollowup: async (input: Parameters<typeof actor.enqueueFollowup>[0]) => actor.enqueueFollowup(inputForActor(input)),
        interrupt: async () => { currentActor(); const result = await actor.interrupt(); return result === undefined ? undefined : outwardOutcome(result); },
        cancelTurn: async (...args: Parameters<typeof actor.cancelTurn>) => { currentActor(); return actor.cancelTurn(...args); },
        status: () => { currentActor(); return outward(actor.status()); },
      };
      Object.defineProperty(replacements, "persistent", { get: () => outwardSession(actor.persistent) });
      Object.defineProperty(replacements, "activeTurn", { get: () => actor.activeTurn === undefined ? undefined : { ...actor.activeTurn,
        turn: outwardTurn(actor.activeTurn.turn)!, outcome: actor.activeTurn.outcome.then(outwardOutcome) } });
      return proxy(actor, replacements);
    }, async unload(id) { await (await ownerOf(id)).sessions.unload(nativeSessionId(id)); },
    listLoaded() { guard(); return all().flatMap(owner => owner.sessions.listLoaded()).filter(id => !hiddenNative(id)).map(externalSessionId); },
    async close() { await Promise.all(all().map(owner => owner.sessions.close())); },
  };
  function outwardOutcome<T extends Awaited<ReturnType<Harness["runtime"]["runTurn"]>>>(result: T): T {
    return { ...result, turn: outwardTurn(result.turn)!, ...(result.pendingAsk === undefined ? {} : { pendingAsk: outward(result.pendingAsk) }) };
  }
  const runtime = proxy(base.runtime, {
    getAgent: (id: AgentId) => all().map(owner => owner.runtime.getAgent(id)).find(agent => agent !== undefined),
    getSessionAgent: async (id: SessionId) => (await ownerOf(id)).runtime.getSessionAgent(nativeSessionId(id)),
    createSession: async (options: Parameters<Harness["runtime"]["createSession"]>[0]) => {
      const owner = ownerFromAgent(options.agent.id); if (!samePath(options.cwd, owner.config.cwd)) throw new RemoteFailure("session/conflict", "Use the registered workspace factory to change cwd");
      if (options.parentId !== undefined && await ownerOf(options.parentId) !== owner) throw new RemoteFailure("session/conflict", "Parent session belongs to another workspace owner");
      // Preserve the caller's exact restricted agent rather than substituting
      // a registry definition, while retaining the host baseline commit gate.
      const session = await owner.runtime.createSession({ ...options, initialStatus: "failed", ...(options.parentId === undefined ? {} : { parentId: nativeSessionId(options.parentId) }) });
      sessionOwners.set(session.id, owner);
      await owner.freezeConfigFingerprint(session.id);
      if (options.initialStatus === "failed") return outwardSession(session);
      const active: Session = { ...session, status: "active" };
      await owner.store.updateSession(active);
      return outwardSession(active);
    },
    startTurn: async (id: SessionId, text: string) => outwardTurn(await (await ownerOf(id)).runtime.startTurn(nativeSessionId(id), text))!,
    runTurn: async (...args: Parameters<Harness["runtime"]["runTurn"]>) => outwardOutcome(await (await ownerOf(args[0])).runtime.runTurn(nativeSessionId(args[0]), args[1], args[2], args[3])),
    resumeTurn: async (id: SessionId, signal: AbortSignal) => {
      const result = await (await ownerOf(id)).runtime.resumeTurn(nativeSessionId(id), signal);
      return { ...outward(result), outcome: outwardOutcome(result.outcome) };
    },
    submitUserAnswer: async (...args: Parameters<Harness["runtime"]["submitUserAnswer"]>) => (await ownerOf(args[0])).runtime.submitUserAnswer(nativeSessionId(args[0]), args[1], args[2], args[3]),
  });
  const approvalStore: Harness["approvalStore"] = {
    create(request) {
      guard(); const native = inward(request); const owner = sessionOwners.get(native.sessionId);
      if (privateNative(request.sessionId) || owner === undefined) throw new RemoteFailure("session/not-found", "Approval session owner is not registered");
      if (owner.runtime.getAgent(request.agentId) === undefined) throw new RemoteFailure("session/conflict", "Approval agent does not belong to its actual session owner");
      if (all().some(item => item.approvalStore.listPending().some(row => row.id === request.id) || item.approvalStore.listDecisions().some(row => row.id === request.id))) throw new RemoteFailure("approval/conflict", "Approval identity already belongs to this host");
      const pending = owner.approvalStore.create(native); return { request: outward(pending.request), wait: pending.wait.bind(pending) };
    },
    resolve(id, value, decidedBy) {
      guard(); const owners = all().filter(owner => owner.approvalStore.listPending().some(row => row.id === id) || owner.approvalStore.listDecisions().some(row => row.id === id));
      if (owners.length !== 1) throw new RemoteFailure("approval/not-found", "Approval has no unique workspace owner"); return owners[0]!.approvalStore.resolve(id, value, decidedBy);
    },
    cancelAll(id) { guard(); const native = nativeSessionId(id); const owner = sessionOwners.get(native); if (privateNative(id) || owner === undefined) throw new RemoteFailure("session/not-found", "Approval session owner is not registered"); owner.approvalStore.cancelAll(native); },
    listPending(id) { guard(); if (id !== undefined && privateNative(id)) return []; return all().flatMap(owner => owner.approvalStore.listPending(id === undefined ? undefined : nativeSessionId(id))).filter(row => !hiddenNative(row.sessionId)).map(outward); },
    listDecisions(id) { guard(); if (id !== undefined && privateNative(id)) return []; return all().flatMap(owner => owner.approvalStore.listDecisions(id === undefined ? undefined : nativeSessionId(id))).filter(row => !hiddenNative(row.sessionId)).map(outward); },
  };
  async function promptOwner(id: string): Promise<Harness> {
    let found: Harness | undefined;
    for (const owner of all()) for (const session of await owner.store.listSessions()) {
      if (!(await owner.inbox.listAll(session.id)).some(prompt => prompt.id === id)) continue;
      if (found !== undefined) throw new RemoteFailure("gateway/conflict", "Prompt has multiple owners"); found = owner;
    }
    if (found === undefined) throw new RemoteFailure("session/not-found", "Prompt owner was not found"); return found;
  }
  const inbox: InboxStore = {
    async admit(prompt) { await (await ownerOf(prompt.sessionId)).inbox.admit(inward(prompt)); },
    async listPending(id) { return (await (await ownerOf(id)).inbox.listPending(nativeSessionId(id))).map(outward); },
    async listRecoverable(id) { return (await (await ownerOf(id)).inbox.listRecoverable(nativeSessionId(id))).map(outward); },
    async listAll(id) { return (await (await ownerOf(id)).inbox.listAll(nativeSessionId(id))).map(outward); },
    async markPromoted(id) { await (await promptOwner(id)).inbox.markPromoted(id); },
    async bindPromotion(id, turnId) {
      const owner = await promptOwner(id); const turn = await owner.store.getTurn(turnId);
      if (turn === undefined || !(await owner.inbox.listAll(turn.sessionId)).some(prompt => prompt.id === id)) throw new RemoteFailure("session/conflict", "Prompt and promoted turn belong to different sessions");
      await owner.inbox.bindPromotion(id, turnId);
    },
    async markConsumed(id) { await (await promptOwner(id)).inbox.markConsumed(id); },
  };
  async function askOwner(id: AskId): Promise<Harness | undefined> {
    let found: Harness | undefined;
    for (const owner of all()) { if (await owner.askUserStore?.get(id) === undefined) continue; if (found !== undefined) throw new RemoteFailure("gateway/conflict", "Question has multiple owners"); found = owner; } return found;
  }
  async function requireAskOwner(id: AskId): Promise<AskUserStore> { const owner = await askOwner(id); if (owner?.askUserStore === undefined) throw new RemoteFailure("user-questions/not-found", "Question owner was not found"); return owner.askUserStore; }
  const askUserStore: AskUserStore | undefined = base.askUserStore === undefined && all().every(owner => owner.askUserStore === undefined) ? undefined : {
    async create(request) {
      const owner = await ownerOf(request.sessionId); if (!owner.askUserStore) throw new RemoteFailure("user-questions/unavailable", "Owner has no question store");
      const native = inward(request);
      if (request.turnId !== undefined && (await owner.store.getTurn(request.turnId))?.sessionId !== native.sessionId) throw new RemoteFailure("session/conflict", "Question turn belongs to another session");
      if (await askOwner(request.id) !== undefined) throw new RemoteFailure("user-questions/conflict", "Question identity already belongs to this host");
      await owner.askUserStore.create(native);
    },
    async get(id) { const value = await (await askOwner(id))?.askUserStore?.get(id); return value === undefined ? undefined : outward(value); },
    async listPending(id) { return (await (await ownerOf(id)).askUserStore?.listPending(nativeSessionId(id)) ?? []).map(outward); },
    async markAnswered(id, reply) { await (await requireAskOwner(id)).markAnswered(id, reply); },
    async markWithdrawn(id) { await (await requireAskOwner(id)).markWithdrawn(id); },
  };
  const checkpointStore: CheckpointStore | undefined = base.checkpointStore === undefined ? undefined : {
    // Checkpoints are integrity-bearing native Runtime values. Their contents and checksum are never aliased.
    async save(checkpoint) { const owner = await ownerOf(checkpoint.sessionId); if (nativeSessionId(checkpoint.sessionId) !== checkpoint.sessionId) throw new RemoteFailure("checkpoint/conflict", "Checkpoint integrity requires its physical native identity"); if (!owner.checkpointStore) throw new RemoteFailure("checkpoint/unavailable", "Owner has no checkpoint store"); await owner.checkpointStore.save(checkpoint); },
    async loadLatest(id) { return (await ownerOf(id)).checkpointStore?.loadLatest(nativeSessionId(id)); },
    async list(id) { return await (await ownerOf(id)).checkpointStore?.list(nativeSessionId(id)) ?? []; },
  };
  async function artifactOwner(id: ArtifactId): Promise<Harness | undefined> {
    let found: Harness | undefined;
    for (const owner of all()) { if (await owner.artifactStore?.get(id) === undefined) continue; if (found !== undefined) throw new RemoteFailure("gateway/conflict", "Artifact has multiple owners"); found = owner; } return found;
  }
  const artifactStore: ArtifactStore | undefined = base.artifactStore === undefined ? undefined : {
    async register(artifact) {
      const owner = await ownerOf(artifact.sessionId); if (!owner.artifactStore) throw new RemoteFailure("artifact/unavailable", "Owner has no artifact store");
      const native = inward(artifact);
      if ((await owner.store.getTurn(artifact.turnId))?.sessionId !== native.sessionId) throw new RemoteFailure("session/conflict", "Artifact turn belongs to another session");
      const existing = await artifactOwner(artifact.id);
      if (existing !== undefined && existing !== owner) throw new RemoteFailure("artifact/conflict", "Artifact identity belongs to another owner");
      await owner.artifactStore.register(native);
    },
    async get(id) { const value = await (await artifactOwner(id))?.artifactStore?.get(id); return value === undefined ? undefined : outward(value); },
    async byToolCallId(id, turnId, toolCallId) {
      const owner = await ownerOf(id);
      if ((await owner.store.getTurn(turnId))?.sessionId !== nativeSessionId(id)) throw new RemoteFailure("session/conflict", "Artifact query turn belongs to another session");
      return (await owner.artifactStore?.byToolCallId(nativeSessionId(id), turnId, toolCallId) ?? []).map(outward);
    },
    async bySessionId(id) { return (await (await ownerOf(id)).artifactStore?.bySessionId(nativeSessionId(id)) ?? []).map(outward); },
    async byHash(hash) { return (await Promise.all(all().map(async owner => await owner.artifactStore?.byHash(hash) ?? []))).flat().filter(row => !hiddenNative(row.sessionId)).map(outward); },
    async list() { return (await Promise.all(all().map(async owner => await owner.artifactStore?.list() ?? []))).flat().filter(row => !hiddenNative(row.sessionId)).map(outward); },
    async remove(ids) { for (const id of ids) { const owner = await artifactOwner(id); if (owner === undefined) throw new RemoteFailure("artifact/not-found", "Artifact owner was not found"); await owner.artifactStore!.remove([id]); } },
  };
  const sessionService = proxy(base.sessionService, {
    resume: async (id: SessionId) => outwardSession(await (await ownerOf(id)).sessionService.resume(nativeSessionId(id))),
    list: async (opts?: Parameters<SessionStore["listSessions"]>[0]) => store.listSessions(opts),
    threadFork: async (id: SessionId) => { const owner = await ownerOf(id); const fork = await owner.sessionService.threadFork(nativeSessionId(id)); sessionOwners.set(fork.id, owner); return outwardSession(fork); },
    fork: async (id: SessionId) => { const owner = await ownerOf(id); const fork = await owner.sessionService.fork(nativeSessionId(id)); sessionOwners.set(fork.id, owner); return outwardSession(fork); },
    spawnChild: async (id: SessionId) => { const owner = await ownerOf(id); const child = await owner.sessionService.spawnChild(nativeSessionId(id)); sessionOwners.set(child.id, owner); return outwardSession(child); },
    cancelSession: async (id: SessionId) => outwardSession(await (await ownerOf(id)).sessionService.cancelSession(nativeSessionId(id))),
    completeSession: async (id: SessionId) => outwardSession(await (await ownerOf(id)).sessionService.completeSession(nativeSessionId(id))),
    archive: async (id: SessionId) => {
      const owner = await ownerOf(id);
      if (aliases.has(id)) throw new RemoteFailure("session/archive-unavailable", "Stable Web sessions use the workspace archive; physical store archival would remove their durable generation index");
      return owner.sessionService.archive(nativeSessionId(id));
    },
    create: async (input: Parameters<Harness["sessionService"]["create"]>[0]) => {
      const owner = ownerFromAgent(input.agentId);
      if (!samePath(input.cwd, owner.config.cwd) || input.model.providerId !== owner.config.model.providerId || input.model.modelId !== owner.config.model.modelId) throw new RemoteFailure("session/conflict", "Session creation must use its workspace owner's actual model and cwd");
      if (input.parentId !== undefined && await ownerOf(input.parentId) !== owner) throw new RemoteFailure("session/conflict", "Parent session belongs to another workspace owner");
      const session = await owner.sessionService.create({ ...input, ...(input.parentId === undefined ? {} : { parentId: nativeSessionId(input.parentId) }) }); sessionOwners.set(session.id, owner); return outwardSession(session);
    },
  });
  async function close(): Promise<void> {
    return closing ??= (async () => {
      closed = true; await indexChain;
      await Promise.allSettled([...sessionLocks.values()]);
      await Promise.allSettled([...opening.values()]);
      const errors: unknown[] = [];
      for (const owner of children.values()) { try { await owner.harness.close(); } catch (error) { errors.push(error); } finally { try { await owner.lease?.release(); } catch (error) { errors.push(error); } } }
      children.clear(); sessionOwners.clear(); if (errors.length > 0) throw new AggregateError(errors, "Workspace owner shutdown failed");
    })();
  }
  const harnessFacade = proxy(base, {
    store, events, runtime, sessions, approvalStore, inbox, askUserStore, checkpointStore, artifactStore, sessionService,
    freezeConfigFingerprint: async (id: SessionId) => (await ownerOf(id)).freezeConfigFingerprint(nativeSessionId(id)),
    checkSessionConfigDrift: async (id: SessionId) => (await ownerOf(id)).checkSessionConfigDrift(nativeSessionId(id)), close,
  });
  const rpcFacade = createRuntimeRpc(runtime, { sessions, sessionService, approvalStore, events,
    listAgents: () => all().flatMap(owner => owner.agents), listTools: () => base.registry.specs(), listSkills: () => base.listSkills() });
  return { harnessFacade, rpcFacade, createSession, ownerOf, nativeSessionId, externalSessionId, withSessionLock, projectEvent, journalCoordinate,
    ownerList: () => { guard(); return [baseView, ...children.values()].map(({ id, path, workspaceId, selection, harness }) => ({ id, path, workspaceId, selection, harness })); },
    async referencedSelections(signal) { guard(); await indexChain; const current = await invokeIndex(readIndex, {}, signal); return current.owners.flatMap(row => row.selection === undefined ? [] : [structuredClone(row.selection)]); },
    selectModel, close };
}

function persistenceFailure(error: unknown, signal: AbortSignal): ToolResult {
  return { status: signal.aborted ? "cancelled" : "failed", error: { code: "PERSISTENCE_ERROR", message: error instanceof Error ? error.message : String(error), retryable: false, safeToRetry: false } };
}
