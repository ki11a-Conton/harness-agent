import type { MemoryStore } from "@ar/contracts";

/** Resources the composition root must release on shutdown. */
export interface Closeable {
  close(): Promise<void> | void;
}

/** Collects closeables in registration order; all resources are drained in reverse order; the first rejection
 *  is surfaced to the caller (never silently swallowed). */
export class Lifecycle {
  private readonly items: Closeable[] = [];

  add(item: Closeable): void {
    this.items.push(item);
  }

  async close(): Promise<void> {
    let firstError: unknown;
    let failed = false;
    for (const item of [...this.items].reverse()) {
      try {
        await item.close();
      } catch (err) {
        if (!failed) { failed = true; firstError = err; }
      }
    }
    if (failed) throw firstError;
  }
}

/** Adapter that closes a MemoryStore (SQLite holds an open handle). */
export class MemoryStoreCloser implements Closeable {
  constructor(private readonly store: MemoryStore) {}
  close(): Promise<void> | void {
    const closable = this.store as { close?: () => Promise<void> | void };
    return closable.close?.();
  }
}