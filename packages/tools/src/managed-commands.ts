import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { relative, isAbsolute, sep } from "node:path";
import { z } from "zod";
import {
  errorInfo,
  stableFingerprint,
  type BoundToolCallRequest,
  type ToolCallRequest,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
  type VerificationContext,
  type Verifier,
} from "@ar/contracts";
import { ToolOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import { execTool, type ExecInput, type ExecOutput } from "./tools/exec.js";
import { ManagedOutput } from "./process/managed-output.js";

export type ManagedCommandState =
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "unknown";
/** Supplied by the trusted host, never by model arguments. The signal must be
 * the owner lifetime signal BEFORE the orchestrator's per-call timeout link. */
export interface ManagedCommandAuthority {
  deadlineAt: number;
  signal: AbortSignal;
}
export interface ManagedCommandRecord {
  id: string;
  owner: string;
  workspace: string;
  deadlineAt: number;
  state: ManagedCommandState;
}
export interface ManagedCommandOptions {
  resolveAuthority(
    context: ToolExecutionContext,
  ): Promise<ManagedCommandAuthority>;
  maxJobMs?: number;
  retainedBytes?: number;
  /** Journal is host-owned; a rejected write refuses spawn/completion. */
  save?: (records: readonly ManagedCommandRecord[]) => Promise<void>;
  recovered?: readonly ManagedCommandRecord[];
}
interface Identity {
  key: string;
  workspace: string;
  context: ToolExecutionContext;
  authority: ManagedCommandAuthority;
}
interface Owner {
  key: string;
  sessionId: string;
  turnId: string;
  workspace: string;
  deadlineAt: number;
  signal: AbortSignal;
  abort: () => void;
  ended: boolean;
}
interface Job {
  record: ManagedCommandRecord;
  owner: Owner;
  input: ExecInput;
  signature: string;
  output: ManagedOutput;
  controller: AbortController;
  done: Promise<void>;
  result?: ToolResult<ExecOutput>;
  delivered: number;
  pollToken: number;
  busy: boolean;
  explicitCancel: boolean;
  supersedes?: string;
  supersededBy?: string;
  timer?: ReturnType<typeof setTimeout>;
}
// One native process may compose multiple Web project/model Harness owners.
// Share capacity and workspace barriers across them, never their handle access.
const domainJobs = new Set<Job>();
const domainRecovered = new Set<ManagedCommandRecord>();
const domainMutations = new Map<string, number>();
function overlaps(a: string, b: string): boolean {
  const within = (root: string, path: string) => {
    const rel = relative(root, path);
    return (
      rel === "" ||
      (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel))
    );
  };
  return within(a, b) || within(b, a);
}
const unavailable = () =>
  new Error(
    "managed command unavailable for this owner; never rerun an unknown handle",
  );
const denial = (message: string): ToolResult => ({
  status: "denied",
  error: errorInfo("SECURITY_DENIED", message),
});
const input = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    timeoutMs: z.number().int().positive().max(600000).optional(),
    yieldMs: z.number().int().min(0).max(1000).default(50),
    supersedes: z.string().optional(),
  })
  .strict();
const handle = z
  .object({
    jobId: z.string().min(1),
    cursor: z.number().int().nonnegative().optional(),
    pollToken: z.number().int().nonnegative().optional(),
    waitMs: z.number().int().min(0).max(10000).default(1000),
  })
  .strict();

/** Agent/tool-layer challenger. It reuses execTool, its cwd/sandbox preparation,
 * UTF-8 decoding and ProcessExecutor's awaited process-tree cleanup verbatim. */
export class ManagedCommands {
  private readonly local = new AsyncLocalStorage<Identity>();
  private readonly jobs = new Map<string, Job>();
  private readonly owners = new Map<string, Owner>();
  private readonly guarded = new WeakSet<ToolDefinition>();
  private readonly recovered: ManagedCommandRecord[];
  private closed = false;
  private closing?: Promise<void>;
  private persistence = Promise.resolve();
  private readonly maxJobMs: number;
  private readonly retainedBytes: number;
  constructor(private readonly options: ManagedCommandOptions) {
    this.maxJobMs = options.maxJobMs ?? 60000;
    this.retainedBytes = options.retainedBytes ?? 65536;
    if (
      !Number.isSafeInteger(this.maxJobMs) ||
      this.maxJobMs <= 0 ||
      this.maxJobMs > 600000
    )
      throw new RangeError("invalid managed command deadline");
    if (
      !Number.isSafeInteger(this.retainedBytes) ||
      this.retainedBytes < 0 ||
      this.retainedBytes > 65536
    )
      throw new RangeError("invalid managed output cap");
    // No PID reattachment or replay. Old live/failure records remain a workspace
    // barrier until the operator independently reconciles the interrupted host.
    this.recovered = (options.recovered ?? []).map((r) => ({
      ...r,
      state: "unknown",
    }));
    if (this.recovered.length + domainJobs.size + domainRecovered.size > 128)
      throw new RangeError("managed recovery journal exceeds its bound");
    for (const record of this.recovered) domainRecovered.add(record);
  }
  async inContext<T>(
    context: ToolExecutionContext,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!context.turnId) throw unavailable();
    const authority = await this.options.resolveAuthority(context);
    if (
      !Number.isSafeInteger(authority.deadlineAt) ||
      authority.deadlineAt <= Date.now()
    )
      throw new Error("managed owner deadline exhausted");
    const workspace = await realpath(context.cwd);
    const key = stableFingerprint([
      context.sessionId,
      context.turnId,
      context.agentId,
      workspace,
      context.permissions,
      context.sandboxPolicy,
    ]);
    return this.local.run({ key, workspace, context, authority }, fn);
  }
  private identity(): Identity {
    const ctx = this.local.getStore();
    if (!ctx) throw unavailable();
    return ctx;
  }
  private lookup(id: string): Job {
    const identity = this.identity(),
      job = this.jobs.get(id);
    if (!job || job.record.owner !== identity.key) throw unavailable();
    return job;
  }
  private records(): ManagedCommandRecord[] {
    return [
      ...this.recovered,
      ...[...this.jobs.values()].map((j) => ({ ...j.record })),
    ];
  }
  private save(): Promise<void> {
    const records = this.records();
    const next = this.persistence.then(() => this.options.save?.(records));
    // Keep the queue drainable after an error; the actual caller still receives
    // the rejected write and the corresponding job stays fail-closed.
    this.persistence = next.catch((error) => {
      process.stderr.write(
        `[degraded] managed-commands.journal: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
    return next;
  }
  private locked(workspace: string, includeMutations = true): boolean {
    return (
      (includeMutations &&
        [...domainMutations.keys()].some((root) =>
          overlaps(root, workspace),
        )) ||
      [...domainRecovered].some((j) => overlaps(j.workspace, workspace)) ||
      [...domainJobs].some(
        (j) =>
          overlaps(j.record.workspace, workspace) &&
          (j.record.state === "running" || j.record.state === "unknown"),
      )
    );
  }
  /** Narrowing only; safe workspace reads remain available while commands run. */
  guard(tool: ToolDefinition): ToolDefinition {
    if (this.guarded.has(tool)) return tool;
    if (
      tool.risk === "readonly" &&
      !tool.metadata.process &&
      !tool.metadata.sideEffect
    )
      return tool;
    const guarded: ToolDefinition = {
      ...tool,
      execute: async (args, context) => {
        const workspace = await realpath(context.cwd);
        if (this.closed || this.locked(workspace, false))
          return denial(
            "managed command holds this workspace; poll/cancel before another write or command",
          );
        domainMutations.set(
          workspace,
          (domainMutations.get(workspace) ?? 0) + 1,
        );
        try {
          return await tool.execute(args, context);
        } finally {
          const remaining = domainMutations.get(workspace)! - 1;
          if (remaining) domainMutations.set(workspace, remaining);
          else domainMutations.delete(workspace);
        }
      },
    };
    this.guarded.add(guarded);
    return guarded;
  }
  async permits(
    tool: ToolDefinition | undefined,
    workspace: string,
  ): Promise<boolean> {
    return (
      !this.closed &&
      (!this.locked(await realpath(workspace), false) ||
        (!!tool &&
          tool.risk === "readonly" &&
          !tool.metadata.sideEffect &&
          !tool.metadata.process))
    );
  }
  tools(): ToolDefinition[] {
    // Poll/cancel wire schemas contain only handle/cursor. Inside the trusted
    // dispatch scope, schema normalization derives the ORIGINAL command/argv.
    // The ordinary orchestrator then re-evaluates that actual permission and
    // process sandbox surface; model-supplied command fields are rejected.
    const authorizedHandle = handle.transform((args, ctx) => {
      try {
        const job = this.lookup(args.jobId);
        return {
          ...args,
          command: job.input.command,
          ...(job.input.args !== undefined
            ? { args: [...job.input.args] }
            : {}),
        };
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "managed command unavailable for this owner",
        });
        return z.NEVER;
      }
    });
    const metadata = {
      version: "0.1.0",
      sideEffect: true,
      network: false,
      filesystem: false,
      process: true,
      interactive: false,
      retry: "unknown" as const,
      concurrencySafe: false,
    };
    return [
      {
        name: "exec_start",
        description:
          "Start one non-interactive command and yield with an owner-scoped jobId. Poll that handle instead of starting again. While it runs, inspect files; other workspace writes/commands are blocked. Success here means admission, never command completion.",
        inputSchema: input,
        risk: "elevated",
        metadata: { ...metadata, name: "exec_start" },
        execute: (args: z.infer<typeof input>, ctx: ToolExecutionContext) =>
          this.start(args, ctx),
      },
      {
        name: "exec_poll",
        description:
          "Read incremental stdout/stderr and actual command state. Include pollToken from the last reply to identify the next observation, including a quiet command; all polls still consume the original turn/tool budgets. Cursor is an absolute decoded UTF-8 byte position; omitted resumes last delivery. lostBytes/incomplete mark discarded output. Never restart an unknown handle.",
        inputSchema: authorizedHandle,
        risk: "elevated",
        metadata: {
          ...metadata,
          name: "exec_poll",
          sideEffect: false,
          retry: "safe" as const,
        },
        execute: (args: z.infer<typeof authorizedHandle>) =>
          this.operate(args, false),
      },
      {
        name: "exec_cancel",
        description:
          "Cancel this owner's command and await process-tree cleanup before acknowledging. Explicit cancellation is not a successful command exit. Refused cleanup remains unknown and blocks verification.",
        inputSchema: authorizedHandle,
        risk: "elevated",
        metadata: { ...metadata, name: "exec_cancel" },
        execute: (args: z.infer<typeof authorizedHandle>) =>
          this.operate(args, true),
      },
      {
        name: "exec_jobs",
        description:
          "Recover this turn's command handles after context compaction. Lists only this exact session/turn/agent/workspace/policy owner. Does not start or replay commands.",
        inputSchema: z.object({}).strict(),
        risk: "readonly",
        metadata: {
          ...metadata,
          name: "exec_jobs",
          sideEffect: false,
          process: false,
          retry: "safe" as const,
        },
        execute: async () => {
          const owner = this.identity().key;
          return {
            status: "success" as const,
            output: {
              jobs: [...this.jobs.values()]
                .filter((j) => j.record.owner === owner)
                .map((j) => ({
                  jobId: j.record.id,
                  state: j.record.state,
                  deadlineAt: j.record.deadlineAt,
                  pollToken: j.pollToken,
                  nextCursor: j.delivered,
                  totalBytes: j.output.totalBytes,
                })),
              interrupted: this.recovered
                .filter((r) => r.owner === owner)
                .map((r) => ({
                  jobId: r.id,
                  state: "unknown",
                  deadlineAt: r.deadlineAt,
                })),
            },
          };
        },
      },
    ] as ToolDefinition[];
  }
  private async start(
    args: z.infer<typeof input>,
    call: ToolExecutionContext,
  ): Promise<ToolResult> {
    const identity = this.identity();
    if (this.closed || identity.authority.signal.aborted || call.signal.aborted)
      return denial("managed owner is closed or cancelled");
    const active = [...domainJobs].filter(
      (j) => j.record.state === "running" || j.record.state === "unknown",
    );
    if (
      this.locked(identity.workspace) ||
      active.length + domainRecovered.size >= 16 ||
      active.filter((j) => j.record.owner === identity.key).length >= 4 ||
      domainJobs.size + domainRecovered.size >= 128
    )
      return denial("managed workspace/capacity limit reached");
    const { yieldMs, supersedes, ...execInput } = args;
    const signature = stableFingerprint([execInput]);
    let previous: Job | undefined;
    if (supersedes !== undefined) {
      try {
        previous = this.lookup(supersedes);
      } catch {
        return denial("invalid replacement job");
      }
      if (
        previous.signature !== signature ||
        !["failed", "timed_out"].includes(previous.record.state) ||
        previous.supersededBy
      )
        return denial(
          "only the same failed command may be replaced after repair",
        );
    }
    let owner = this.owners.get(identity.key);
    if (owner?.ended) return denial("managed owner already terminated");
    if (!owner) {
      owner = {
        key: identity.key,
        sessionId: identity.context.sessionId,
        turnId: identity.context.turnId!,
        workspace: identity.workspace,
        deadlineAt: identity.authority.deadlineAt,
        signal: identity.authority.signal,
        ended: false,
        abort: () => {},
      };
      owner.abort = () => {
        owner!.ended = true;
        for (const j of this.jobs.values())
          if (j.owner === owner) j.controller.abort();
      };
      owner.signal.addEventListener("abort", owner.abort, { once: true });
      this.owners.set(owner.key, owner);
      if (owner.signal.aborted) owner.abort();
    }
    const deadlineAt = Math.min(
      owner.deadlineAt,
      identity.authority.deadlineAt,
      Date.now() + this.maxJobMs,
      Date.now() + (call.sandboxPolicy.process.timeoutMs ?? 60000),
      Date.now() + (args.timeoutMs ?? this.maxJobMs),
    );
    if (deadlineAt <= Date.now() || owner.ended)
      return denial("managed deadline exhausted");
    const job: Job = {
      record: {
        id: randomUUID(),
        owner: owner.key,
        workspace: owner.workspace,
        deadlineAt,
        state: "running",
      },
      owner,
      input: execInput,
      signature,
      output: new ManagedOutput(
        Math.min(
          this.retainedBytes,
          call.sandboxPolicy.process.maxOutputBytes ?? this.retainedBytes,
        ),
      ),
      controller: new AbortController(),
      done: Promise.resolve(),
      delivered: 0,
      pollToken: 0,
      busy: false,
      explicitCancel: false,
      ...(previous ? { supersedes: previous.record.id } : {}),
    };
    // Reserve pending spawn synchronously, before journal/fs/sandbox awaits.
    this.jobs.set(job.record.id, job);
    domainJobs.add(job);
    const abortCall = () => job.controller.abort();
    call.signal.addEventListener("abort", abortCall, { once: true });
    if (call.signal.aborted) abortCall();
    job.done = (async () => {
      try {
        await this.save();
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          job.record.state = "timed_out";
          return;
        }
        const narrowed = {
          ...call,
          signal: job.controller.signal,
          sandboxPolicy: {
            ...call.sandboxPolicy,
            process: {
              ...call.sandboxPolicy.process,
              maxOutputBytes: job.output.capacity,
            },
          },
          onOutput: (chunk: {
            stream: "stdout" | "stderr" | "progress";
            text: string;
          }) => {
            if (chunk.stream !== "progress")
              job.output.append(chunk.stream, chunk.text);
          },
        };
        job.timer = setTimeout(() => job.controller.abort(), remaining);
        job.result = await execTool.execute(
          { ...execInput, timeoutMs: remaining },
          narrowed,
        );
        const status = job.result.status;
        const cleanupFailed = /termination|taskkill|cleanup/i.test(
          job.result.error?.message ?? "",
        );
        job.record.state = cleanupFailed
          ? "unknown"
          : status === "success" && job.result.output?.exitCode === 0
            ? "succeeded"
            : status === "timeout" ||
                (Date.now() >= deadlineAt && status === "cancelled")
              ? "timed_out"
              : status === "cancelled"
                ? "cancelled"
                : "failed";
        if (job.record.state === "succeeded" && previous)
          previous.supersededBy = job.record.id;
        await this.save();
      } catch (err) {
        job.record.state = "unknown";
        job.result = {
          status: "failed",
          error: errorInfo(
            "PERSISTENCE_ERROR",
            `managed outcome requires reconciliation: ${err instanceof Error ? err.message : String(err)}`,
          ),
        };
      } finally {
        clearTimeout(job.timer);
      }
    })();
    // The per-call link is only for the admission operation. The owner link and
    // absolute command timer above intentionally survive its finally block.
    try {
      await this.wait(job, yieldMs);
      return {
        status: "success",
        output: this.deliver(job),
        evidence: [
          {
            type: "command",
            description: "managed command admitted; poll for actual exit",
            source: "exec_start",
            timestamp: Date.now(),
          },
        ],
      };
    } finally {
      call.signal.removeEventListener("abort", abortCall);
    }
  }
  private async wait(job: Job, ms: number): Promise<void> {
    if (!ms || job.record.state !== "running") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        job.done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private snapshot(job: Job, cursor: number) {
    return {
      jobId: job.record.id,
      state: job.record.state,
      pollToken: job.pollToken,
      deadlineAt: job.record.deadlineAt,
      exitCode: job.result?.output?.exitCode ?? null,
      commandStatus: job.result?.status ?? null,
      ...job.output.read(cursor),
      ...(job.result?.error ? { error: job.result.error } : {}),
      ...(job.supersedes ? { supersedes: job.supersedes } : {}),
      ...(job.supersededBy ? { supersededBy: job.supersededBy } : {}),
    };
  }
  private deliver(job: Job, cursor = job.delivered) {
    const result = this.snapshot(job, cursor);
    job.delivered = Math.max(job.delivered, result.nextCursor);
    return result;
  }
  private async operate(
    args: z.infer<typeof handle>,
    cancel: boolean,
  ): Promise<ToolResult> {
    const job = this.lookup(args.jobId);
    if (job.busy) return denial("another operation already owns this job");
    if (args.pollToken !== undefined && args.pollToken !== job.pollToken)
      return denial(
        "stale pollToken; query exec_jobs before another observation",
      );
    if (args.cursor !== undefined && args.cursor > job.output.totalBytes)
      return denial("invalid output cursor");
    job.busy = true;
    try {
      if (cancel) {
        job.explicitCancel = true;
        job.controller.abort();
        await job.done;
      } else await this.wait(job, args.waitMs);
      job.pollToken++;
      const output = this.deliver(job, args.cursor);
      if (job.record.state === "unknown")
        return {
          status: "failed",
          output,
          error:
            job.result?.error ??
            errorInfo(
              "PROCESS_ERROR",
              "managed cleanup/outcome is unconfirmed; reconcile before continuing",
            ),
        };
      return { status: "success", output };
    } finally {
      job.busy = false;
    }
  }
  /** A verifier cannot promote active, failed, unknown or involuntarily
   * cancelled jobs. An exact same-command successful repair resolves its
   * predecessor; an explicit service shutdown can finish without exit 0. */
  verifier(delegate: Verifier): Verifier {
    return {
      verify: async (task, context) => {
        const workspace = await realpath(context.cwd);
        const blocked = () => this.blocked({ ...context, cwd: workspace });
        const check = () => ({
          id: "managed-commands",
          kind: "command" as const,
          description: "all managed commands settled and reconciled",
          passed: false,
          error: errorInfo(
            "VERIFICATION_FAILED",
            "managed commands are unfinished, failed or unknown; poll/cancel/repair first",
          ),
        });
        if (blocked())
          return {
            level: 1,
            passed: false,
            checks: [check()],
            evidence: [],
            startedAt: Date.now(),
            completedAt: Date.now(),
          };
        const result = await delegate.verify(task, context);
        if (!blocked()) return result;
        return {
          ...result,
          level: 1,
          passed: false,
          checks: [...result.checks, check()],
          completedAt: Date.now(),
        };
      },
    };
  }
  private blocked(context: VerificationContext): boolean {
    return (
      [...domainRecovered].some((j) => overlaps(j.workspace, context.cwd)) ||
      [...domainJobs].some(
        (j) =>
          overlaps(j.record.workspace, context.cwd) &&
          (j.record.state === "running" ||
            j.record.state === "unknown" ||
            (j.owner.sessionId === context.sessionId &&
              j.owner.turnId === context.turnId &&
              j.record.state !== "succeeded" &&
              !j.supersededBy &&
              !(j.record.state === "cancelled" && j.explicitCancel))),
      )
    );
  }
  async endOwner(sessionId: string, turnId: string): Promise<void> {
    const matching = [...this.jobs.values()].filter(
      (j) => j.owner.sessionId === sessionId && j.owner.turnId === turnId,
    );
    for (const j of matching) {
      j.owner.ended = true;
      j.controller.abort();
    }
    await Promise.all(matching.map((j) => j.done));
    // Preserve unknown entries and their workspace barrier for reconciliation.
    for (const j of matching)
      if (j.record.state !== "unknown") {
        this.jobs.delete(j.record.id);
        domainJobs.delete(j);
        j.owner.signal.removeEventListener("abort", j.owner.abort);
        this.owners.delete(j.owner.key);
      }
    await this.save();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      for (const owner of this.owners.values()) owner.abort();
      await Promise.all([...this.jobs.values()].map((j) => j.done));
      for (const owner of this.owners.values())
        owner.signal.removeEventListener("abort", owner.abort);
      await this.save();
      for (const job of this.jobs.values())
        if (job.record.state !== "unknown") {
          domainJobs.delete(job);
          this.jobs.delete(job.record.id);
        }
      this.owners.clear();
      if ([...this.jobs.values()].some((j) => j.record.state === "unknown"))
        throw new Error(
          "managed command cleanup/outcome unknown; reconciliation required",
        );
    })();
    return this.closing;
  }
}

/** Composition adapter scopes schema normalization to the ORIGINAL trusted
 * tool context. No Runtime changes, permission bypass, or widened tool binding. */
export class ManagedCommandOrchestrator extends ToolOrchestrator {
  private readonly catalog: OrchestratorDeps["registry"];
  constructor(
    deps: OrchestratorDeps,
    private readonly managed: ManagedCommands,
  ) {
    super(deps);
    this.catalog = deps.registry;
  }
  override async execute(
    request: ToolCallRequest,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    try {
      return await this.managed.inContext(context, async () => {
        const tool = this.catalog.get(request.call.name);
        if (
          !tool ||
          ["exec_start", "exec_poll", "exec_cancel", "exec_jobs"].includes(
            request.call.name,
          )
        )
          return super.execute(request, context);
        return this.managed
          .guard({ ...tool, execute: () => super.execute(request, context) })
          .execute(request.call.args, context);
      });
    } catch (err) {
      return denial(
        err instanceof Error ? err.message : "managed owner unavailable",
      );
    }
  }
  override async executeBound(
    request: BoundToolCallRequest,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    try {
      return await this.managed.inContext(context, () =>
        super.executeBound(
          ["exec_start", "exec_poll", "exec_cancel", "exec_jobs"].includes(
            request.call.name,
          )
            ? request
            : {
                ...request,
                binding: {
                  ...request.binding,
                  definition: this.managed.guard(request.binding.definition),
                },
              },
          context,
        ),
      );
    } catch (err) {
      return denial(
        err instanceof Error ? err.message : "managed owner unavailable",
      );
    }
  }
}
