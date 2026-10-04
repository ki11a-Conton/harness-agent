import hashlib, json, os, platform, re, subprocess, sys, time
from pathlib import Path
workspace = Path(sys.argv[1]).resolve()
expected = sys.argv[2]
output = Path(sys.argv[3]).resolve()
output.mkdir(parents=True, exist_ok=True)
def git(*args):
    return subprocess.check_output(["/usr/bin/git", *args], cwd=workspace, text=True).strip()
def frozen():
    assert git("rev-parse", "HEAD") == expected, "HEAD changed during acceptance"
    assert git("status", "--porcelain") == "", "frozen worktree is dirty"
env = os.environ.copy()
env["OPENAI_API_KEY"] = ""
env.pop("E2E_OBSERVATION_RUN_ID", None)
env.pop("E2E_OBSERVATION_EVIDENCE_DIR", None)
run_id = "agent-context-memory-linux-" + expected[:12] + "-" + str(int(time.time()))
named = {**env, "E2E_OBSERVATION_RUN_ID": run_id, "E2E_OBSERVATION_EVIDENCE_DIR": str(output / "observations")}
manifest = {"schemaVersion":"agent-context-memory-frozen-acceptance-v1", "testedSourceSha":expected,
 "workspace":str(workspace), "startedAt":time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
 "platform":platform.platform(), "node":subprocess.check_output(["node","--version"], text=True).strip(),
 "pnpm":subprocess.check_output(["corepack","pnpm","--version"], text=True).strip(),
 "paidProviderCalls":0, "realModelQuality":"NOT_RUN", "promotion":"NOT_RUN", "windows":"NOT_RUN",
 "observationRunId":run_id, "commands":[], "status":"RUNNING"}
def save():
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
frozen()
source_files = git("diff", "--name-only", "dec7bd1237870f1d46aa063a7ba1a635e4c523c0", expected).splitlines()
manifest["changedFileSha256"] = {path:hashlib.sha256((workspace/path).read_bytes()).hexdigest() for path in source_files if (workspace/path).is_file()}
save()
commands = [
 ("typecheck", ["corepack","pnpm","typecheck"], env),
 ("build", ["corepack","pnpm","build"], env),
 ("security", ["corepack","pnpm","test:security"], env),
 ("docs-verify", ["corepack","pnpm","docs:verify"], env),
 ("full", ["python3",str(Path(__file__).with_name("subreaper.py")),"corepack","pnpm","test"], named),
 ("usage-audit", ["node","apps/cli/dist/main.js","usage-audit","--run",run_id,"--strict"], named),
 ("artifact-integrity", ["node","scripts/research/agent-trust-20261004/verify-artifacts.mjs","docs/evidence/web-dsh-20261004/artifact-index.json"], env),
 ("context-memory-artifact-integrity", ["node","scripts/research/agent-trust-20261004/verify-artifacts.mjs","docs/evidence/agent-context-memory-20261004/artifact-index.json"], env),
 ("diff-check", ["/usr/bin/git","diff","--check","dec7bd1237870f1d46aa063a7ba1a635e4c523c0",expected], env),
]
for name, command, command_env in commands:
    frozen()
    log = output/(name + ".log")
    row = {"name":name,"argv":command,"cwd":str(workspace),"cleanBefore":True,"status":"RUNNING","log":log.name}
    manifest["commands"].append(row)
    save()
    print("START", name, flush=True)
    started=time.monotonic()
    with log.open("w") as target:
        result = subprocess.run(command, cwd=workspace, env=command_env, stdout=target, stderr=subprocess.STDOUT)
    body=log.read_text(errors="replace")
    row.update({"status":"PASS" if result.returncode==0 else "FAIL","exitCode":result.returncode,
     "durationSeconds":round(time.monotonic()-started,3),"logSha256":hashlib.sha256(log.read_bytes()).hexdigest(),
     "summary":[line.strip() for line in body.splitlines() if re.search(r"Test Files|Tests  |Duration  |\[review supervisor\]",line)][-6:]})
    frozen()
    row["cleanAfter"]=True
    print("END", name, row["exitCode"], row["durationSeconds"], row["summary"], flush=True)
    if result.returncode:
        manifest["status"]="FAIL"
        save()
        sys.exit(result.returncode)
    save()
manifest["status"]="PASS"
manifest["finishedAt"]=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
save()
