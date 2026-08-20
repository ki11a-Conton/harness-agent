let seen = new Set();
export function next() {
  const n = seen.size;
  if (seen.has(n)) return -1;
  seen.add(n);
  return n;
}
