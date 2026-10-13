# Schedule pure implementation provenance

Source: https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/schedule/schedule/src

License: MIT, retained in LICENSE. Full domain/update implementations were copied; only module extensions, the structural Session replay shim and nominal type imports were adapted for this host. Cordis declaration merges are omitted from types.ts; their wire data types remain unchanged. Temporal 0.5.1 provides the upstream calendar/DST behavior. Host persistence, admission and timers are separately implemented in Harness.

Original source SHA-256:

```json
[
  {
    "source": "packages/schedule/schedule/src/domain.ts",
    "sha256": "d7a5ca9121a284276f841a7429302e447b8de77df76eedc9adcaf2b2a6d506cd",
    "file": "domain.ts"
  },
  {
    "source": "packages/schedule/schedule/src/update.ts",
    "sha256": "ef186da70fe5b378a657722730a03faa18089fca37e6cf8776527c436d1b8104",
    "file": "update.ts"
  },
  {
    "source": "packages/schedule/schedule/src/types.ts",
    "sha256": "995e067824c7f6b848e29e3aac968debcc9d68da24a512eb7d732cb693546bff",
    "file": "types.ts"
  }
]
```
