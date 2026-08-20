import type { MemoryStore } from "@ar/contracts";

/** Resources the composition root must release on shutdown. */
export interface Closeable {
  close(): Promise<void> | void;
}

/** Collects closeables in registration order; first failure stops the drain
 *  and is surfaced to the caller (never silently swallowed). */
export class Lifecycle {
  private readonly items: Closeable[] = [];

  add(item: Closeable): void {
    this.items.push(item);
  }

  async close(): Promise<void> {
    let firstError: unknown;
    for (const item of [...this.items].reverse()) {
      try {
        await item.close();
      } catch (err) {
        firstError ??= err;
      }
    }
    if (firstError !== undefined) throw firstError;
  }
}

/** Adapter that closes a MemoryStore (SQLite holds an open handle). */
export class MemoryStoreCloser implements Closeable {
  constructor(private readonly store: MemoryStore) {}
  close(): void {
    const closable = this.store as { close?: () => void };
    closable.close?.();
  }
}