// Keep raw probe evidence and expose failures in GitHub check annotations, even
// when the runner's log/artifact blob downloads are unavailable to reviewers.
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.length !== 4) throw new Error("Usage: node run.mjs <built-repository> <output.json>");
const [, , repo, output] = process.argv;
const probe = fileURLToPath(new URL("./probe.mjs", import.meta.url));
const result = spawnSync(process.execPath, [probe, resolve(repo), "--expect-success"], {
  encoding: "utf8", maxBuffer: 1024 * 1024,
});
await mkdir(dirname(resolve(output)), { recursive: true });
await writeFile(output, result.stdout ?? "");
await writeFile(`${output}.stderr.log`, result.stderr ?? "");
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0 || result.error) {
  const details = JSON.stringify({ exit: result.status, signal: result.signal,
    error: result.error?.message ?? null, stdout: result.stdout?.slice(-12000), stderr: result.stderr?.slice(-6000) });
  // Escape the command payload; fixture text must never create new commands.
  const escaped = details.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  console.log(`::error title=Large-repository navigation probe::${escaped}`);
  process.exitCode = result.status || 1;
}
