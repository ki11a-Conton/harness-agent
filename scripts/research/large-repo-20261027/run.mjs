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
function annotate(level, title, details) {
  // Escape the command payload; fixture text must never create new commands.
  const escaped = JSON.stringify(details).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  console.log(`::${level} title=${title}::${escaped}`);
}
let report;
try { report = JSON.parse(result.stdout); } catch { /* Raw output remains in the evidence files. */ }
if (result.status !== 0 || result.error) {
  // GitHub truncates individual annotation messages at 4 KiB. Keep each
  // failing child separate, rather than losing its error behind passing rows.
  for (const name of ["largeFile", "longLine", "cache", "parallel"]) {
    const child = report?.[name];
    if (child && (child.exit !== 0 || child.error)) annotate("error", `Large-repository probe ${name}`, {
      exit: child.exit, signal: child.signal, error: child.error,
      stdout: child.stdout?.slice(-300), stderr: child.stderrTail?.slice(-1500),
    });
  }
  annotate("error", "Large-repository navigation probe", { exit: result.status, signal: result.signal,
    error: result.error?.message ?? null, stderr: result.stderr?.slice(-1000) });
  process.exitCode = result.status || 1;
} else if (report) {
  const metrics = { fixture: report.fixture };
  for (const name of ["largeFile", "longLine", "cache", "parallel"]) {
    try { metrics[name] = JSON.parse(report[name].stdout.trim().split("\n").at(-1)); }
    catch { metrics[name] = { exit: report[name]?.exit }; }
  }
  annotate("notice", "Large-repository navigation probe passed", metrics);
}
