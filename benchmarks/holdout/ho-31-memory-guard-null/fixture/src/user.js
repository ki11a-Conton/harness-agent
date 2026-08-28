export function greet(b: string | null): string {
  // bug: accessing b.trim() when b is null throws
  return `hi ${(b as string).trim()}`;
}

export function main(b: string | null): string {
  return greet(b);
}
