export async function fetchAll(urls) {
  const out = [];
  for (const u of urls) out.push(await fetch(u).then((r) => r.status));
  return out;
}
