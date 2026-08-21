// P3-4/P3-5: child workspace isolation — session isolation alone is not
// workspace isolation. A write-capable child must never mutate the parent's
// working directory directly (plan.md AUDIT-013): it runs in an isolated
// copy and returns a structured patch the parent applies under conflict
// detection. Read-only children share the parent root (no write rights, so
// no isolation needed).
export {};
//# sourceMappingURL=workspace-isolation.js.map