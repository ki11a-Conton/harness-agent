import type { AgentEvent, ApprovalStore } from "@ar/contracts";
import { AgentError, errorInfo } from "@ar/contracts";
import type { InMemoryTransport } from "./transport.js";

/** Constructor options for the §85 desktop client. */
export interface DesktopClientOptions {
  /**
   * Client endpoint of a transport pair whose server side is bound to the
   * runtime RPC registry (createRuntimeRpc). This is the client's ONLY
   * runtime-facing dependency: every method forwards through it.
   */
  transport: InMemoryTransport;
  /** Agent + cwd used by createSession when its arguments are omitted. */
  sessionDefaults?: { agentId: string; cwd: string };
  /**
   * §162 approval-UI exception: read-only pending lookup. The §84 RPC
   * surface has no pending-approval listing method, so the client reads
   * pending requests through this injected store — never mutating it;
   * every decision still goes through the session.approve RPC.
   */
approvalStore?: ApprovalStore;
  /** Event-poll interval for run()/subscribe() (tests use small values). */
  pollDelayMs?: number;
}

/** Paces event polling; resolves when a poll tick is due. */
function delay(ms: number): Promise<"tick"> {
  return new Promise((resolve) => setTimeout(() => resolve("tick"), ms));
}

/**
 * Desktop client (§85): the desktop owns rendering, interaction, approval
 * UI, session browsing, and event display — never the agent loop, tool
 * execution, permission logic, or session persistence. This class is a thin
 * UI-facing surface over the §84 RPC methods; it holds no direct reference
 * to the runtime, registry, session store, or event store.
 */
export class DesktopClient {
  #transport: InMemoryTransport;
  #sessionDefaults?: { agentId: string; cwd: string };
  #approvalStore?: ApprovalStore;
  #pollDelayMs: number;

  constructor(opts: DesktopClientOptions) {
    this.#transport = opts.transport;
    this.#sessionDefaults = opts.sessionDefaults;
    this.#approvalStore = opts.approvalStore;
    this.#pollDelayMs = opts.pollDelayMs ?? 50;
  }

  async createSession(agentId?: string, cwd?: string): Promise<{ sessionId: string }> {
    const agentIdValue = agentId ?? this.#sessionDefaults?.agentId;
    const cwdValue = cwd ?? this.#sessionDefaults?.cwd;
    if (agentIdValue === undefined || cwdValue === undefined) {
      throw new AgentError(
        errorInfo("INTERNAL_ERROR", "agentId/cwd are required (no sessionDefaults configured)"),
      );
    }
    const session = (await this.#transport.request("session.create", {
      agentId: agentIdValue,
      cwd: cwdValue,
    })) as { id: string };
    return { sessionId: session.id };
  }

  async send(sessionId: string, text: string): Promise<{ turnId: string }> {
    return (await this.#transport.request("session.send", { sessionId, text })) as {
      turnId: string;
    };
  }

  /**
   * Run a turn and return its outcome. While the turn is running, the
   * session's event stream is exposed to the UI layer (§85 event display)
   * by incremental polling of the session.subscribe RPC. The callback
   * receives the session's events from its start, so a full run is covered
   * (turn.started → tool.* → turn.completed); the UI filters by
   * turnId/sessionId. A final drain after the run settles guarantees the
   * terminal events are delivered even when the run finishes between polls.
   */
  async run(
    sessionId: string,
    turnId: string,
    onEvent?: (e: AgentEvent) => void,
  ): Promise<{ status: string; toolCalls: number; iterations: number }> {
    const runPromise = this.#transport.request("session.run", { sessionId, turnId });
    if (onEvent === undefined) {
      const outcome = (await runPromise) as {
        status: string;
        toolCalls: number;
        iterations: number;
      };
      return {
        status: outcome.status,
        toolCalls: outcome.toolCalls,
        iterations: outcome.iterations,
      };
    }
    let settled = false;
    let outcome: unknown;
    let runError: unknown;
    runPromise.then(
      (value) => {
        settled = true;
        outcome = value;
      },
      (err) => {
        settled = true;
        runError = err;
      },
    );
    let after = 0;
    while (!settled) {
      const winner = await Promise.race([
        runPromise.then(() => "run" as const),
        delay(this.#pollDelayMs),
      ]);
      if (winner === "run") break;
      after = await this.#deliverEvents(sessionId, after, onEvent);
    }
    await this.#deliverEvents(sessionId, after, onEvent);
    if (runError !== undefined) throw runError;
    const o = outcome as { status: string; toolCalls: number; iterations: number };
    return { status: o.status, toolCalls: o.toolCalls, iterations: o.iterations };
  }

  async cancel(sessionId: string, turnId: string): Promise<{ status: string }> {
    const result = (await this.#transport.request("session.cancel", {
      sessionId,
      turnId,
    })) as { status: string };
    return { status: result.status };
  }

  async resume(sessionId: string): Promise<{ session: unknown }> {
    return { session: await this.#transport.request("session.resume", { sessionId }) };
  }

  async approve(approvalId: string, allow: boolean, decidedBy?: string): Promise<{ value: string }> {
    const decision = (await this.#transport.request("session.approve", {
      approvalId,
      value: allow ? "allow" : "deny",
      ...(decidedBy !== undefined ? { decidedBy } : {}),
    })) as { value: string };
    return { value: decision.value };
  }

  /**
   * Pending approvals for the §162 approval UI. The RPC surface has no
   * pending-approval listing method, so this reads the injected store
   * read-only (see DesktopClientOptions.approvalStore); decisions still go
   * through session.approve RPC.
   */
  async listPendingApprovals(): Promise<unknown[]> {
    const store = this.#approvalStore;
    if (store === undefined) {
      throw new AgentError(
        errorInfo("INTERNAL_ERROR", "approvalStore not injected; pending-approval listing unavailable"),
      );
    }
    return store.listPending();
  }

  /**
   * Subscribe to a session's event stream (§85 event display). The §84 RPC
   * surface only provides snapshots (session.subscribe returns the event
   * list — EventStore.stream is server-side), so delivery is snapshot +
   * incremental polling, the portable choice; a future streaming RPC
   * wrapping EventStore.stream can replace this loop. Resolves when
   * `signal` aborts; without a signal the subscription keeps polling.
   */
  async subscribe(
    sessionId: string,
    afterSequence?: number,
    onEvent?: (e: AgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    let after = afterSequence ?? 0;
    for (;;) {
      if (signal?.aborted) return;
      const events = (await this.#transport.request("session.subscribe", {
        sessionId,
        afterSequence: after,
      })) as AgentEvent[];
      for (const ev of events) {
        after = ev.sequence;
        onEvent?.(ev);
      }
      await delay(this.#pollDelayMs);
    }
  }

  /** Fetch one snapshot and forward new events; returns the new tail sequence. */
  async #deliverEvents(
    sessionId: string,
    after: number,
    onEvent: (e: AgentEvent) => void,
  ): Promise<number> {
    const events = (await this.#transport.request("session.subscribe", {
      sessionId,
      afterSequence: after,
    })) as AgentEvent[];
    let last = after;
    for (const ev of events) {
      last = ev.sequence;
      onEvent(ev);
    }
    return last;
  }
}
