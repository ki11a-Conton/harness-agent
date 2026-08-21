/** Collects closeables in registration order; first failure stops the drain
 *  and is surfaced to the caller (never silently swallowed). */
export class Lifecycle {
    items = [];
    add(item) {
        this.items.push(item);
    }
    async close() {
        let firstError;
        for (const item of [...this.items].reverse()) {
            try {
                await item.close();
            }
            catch (err) {
                firstError ??= err;
            }
        }
        if (firstError !== undefined)
            throw firstError;
    }
}
/** Adapter that closes a MemoryStore (SQLite holds an open handle). */
export class MemoryStoreCloser {
    store;
    constructor(store) {
        this.store = store;
    }
    close() {
        const closable = this.store;
        closable.close?.();
    }
}
//# sourceMappingURL=lifecycle.js.map