import type { MemoryStore } from "@ar/contracts";
/** Resources the composition root must release on shutdown. */
export interface Closeable {
    close(): Promise<void> | void;
}
/** Collects closeables in registration order; first failure stops the drain
 *  and is surfaced to the caller (never silently swallowed). */
export declare class Lifecycle {
    private readonly items;
    add(item: Closeable): void;
    close(): Promise<void>;
}
/** Adapter that closes a MemoryStore (SQLite holds an open handle). */
export declare class MemoryStoreCloser implements Closeable {
    private readonly store;
    constructor(store: MemoryStore);
    close(): void;
}
//# sourceMappingURL=lifecycle.d.ts.map