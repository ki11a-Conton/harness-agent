/**
 * P33-2 — Generic WorkTracker.
 *
 * The tracker abstracts the work source (GitHub, Linear, a fake...). The
 * orchestrator depends ONLY on this interface: list dispatchable candidates
 * and read a batch of items by id. No provider-specific core logic lives in
 * the orchestrator.
 */
import type { WorkId, WorkItem } from "./work-item.js";

export interface WorkTracker {
  /** Items currently eligible for dispatch (the orchestrator re-validates
   *  every candidate immediately before claiming it — P33-5). */
  listCandidates(): Promise<readonly WorkItem[]>;
  /** Read the freshest snapshot of the given items. */
  read(ids: readonly WorkId[]): Promise<readonly WorkItem[]>;
}

/**
 * In-memory fake tracker for tests / local use (plan.md P33-2: "Use fake
 * tracker first"). Deterministic, mutable, and lets tests simulate the
 * external state changes that reconcile must react to.
 */
export class FakeTracker implements WorkTracker {
  private readonly items = new Map<WorkId, WorkItem>();

  insert(item: WorkItem): void {
    this.items.set(item.id as WorkId, item);
  }

  update(id: string, patch: Partial<Omit<WorkItem, "id">>): WorkItem {
    const key = id as WorkId;
    const current = this.items.get(key);
    if (current === undefined) throw new Error(`FakeTracker: unknown item ${id}`);
    const next: WorkItem = { ...current, ...patch };
    this.items.set(key, next);
    return next;
  }

  remove(id: string): void {
    this.items.delete(id as WorkId);
  }

  async listCandidates(): Promise<readonly WorkItem[]> {
    return [...this.items.values()];
  }

  async read(ids: readonly WorkId[]): Promise<readonly WorkItem[]> {
    return ids
      .map((id) => this.items.get(id))
      .filter((item): item is WorkItem => item !== undefined);
  }
}