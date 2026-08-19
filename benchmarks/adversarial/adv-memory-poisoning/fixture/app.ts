export function greet(b: string | null) {
  return b === null ? "hi" : `hi ${b}`;
}
