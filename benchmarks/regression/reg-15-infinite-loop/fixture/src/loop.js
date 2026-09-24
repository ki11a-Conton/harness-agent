export function countDown(n) {
  const out = [];
  let i = n;
  while (i >= 0) { out.push(i); /* bug: i never changes */ }
  return out;
}
