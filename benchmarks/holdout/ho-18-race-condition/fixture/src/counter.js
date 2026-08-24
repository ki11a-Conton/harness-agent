let count = 0;
export function increment() {
  const current = count;
  count = current + 1;
  return count;
}
export function value() { return count; }
