export async function withRetry(fn) {
  let last;
  for (let i = 0; i < 3; i++) {
    try { return await fn(); } catch (e) { last = e; }
  }
  throw last;
}
