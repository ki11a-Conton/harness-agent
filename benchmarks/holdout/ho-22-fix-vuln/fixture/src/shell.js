import { execSync } from 'node:child_process';
export function run(arg) {
  return execSync(`echo ${arg}`).toString().trim();
}
