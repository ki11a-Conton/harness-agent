#!/usr/bin/env python3
"""Serial, clean-SHA engineering acceptance; never calls a paid model."""
import argparse
import hashlib
import json
import os
import platform
import re
import signal
import subprocess
import sys
import time
import traceback
from pathlib import Path

BASELINE = "7dce382bf4e8a670d5995c4be879769f991cca44"
HERE = Path(__file__).resolve().parent
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
REGRESSIONS = []  # Filled from added, tracked regression files at the frozen commit.
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("workspace", type=Path)
parser.add_argument("expected_sha", help="Full forty-character frozen source commit")
parser.add_argument("output", type=Path, help="Fresh, Git-ignored output directory")
args = parser.parse_args()
workspace = args.workspace.resolve()
expected = args.expected_sha
output = args.output.resolve()
if not re.fullmatch(r"[0-9a-f]{40}", expected):
    parser.error("expected_sha must be the full lowercase commit SHA")
# Never reuse a prior PASS/FAIL, even if it is empty or partially written.
output.mkdir(parents=True, exist_ok=False)
manifest = {
    "schemaVersion": "agent-next4-frozen-acceptance-v1",
    "testedSourceSha": expected,
    "baselineSha": BASELINE,
    "workspace": str(workspace),
    "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "platform": platform.platform(),
    "paidProviderCalls": 0,
    "realModelQuality": "NOT_RUN",
    "promotion": "NOT_RUN",
    "windows": "NOT_RUN",
    "commands": [],
    "status": "RUNNING",
}
active_process = None
active_row = None


def save():
    temporary = output / "manifest.json.tmp"
    temporary.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    temporary.replace(output / "manifest.json")


def git(*argv):
    return subprocess.check_output(["/usr/bin/git", *argv], cwd=workspace, text=True).strip()


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def clean_snapshot():
    sha = git("rev-parse", "HEAD")
    status = git("status", "--porcelain")
    snapshot = {"head": sha, "clean": status == "", "porcelain": status}
    if sha != expected or status:
        raise RuntimeError("frozen source changed: " + json.dumps(snapshot))
    return snapshot


def source_hashes():
    paths = git("ls-files", "-z").split("\0")
    return {
        path: sha256(workspace / path)
        for path in paths
        if path and (workspace / path).is_file()
        and (path.startswith(("packages/", "apps/", "scripts/", ".github/"))
             or "/" not in path and Path(path).suffix in (".json", ".yaml", ".yml"))
    }


def dist_hashes():
    paths = sorted({path for area in ("packages", "apps")
                    for path in (workspace / area).glob("*/dist/**/*") if path.is_file()})
    return {str(path.relative_to(workspace)): sha256(path) for path in paths}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def json_receipt(path):
    data = json.loads(path.read_text())
    require(data.get("status") == "PASS", "receipt is not PASS: " + str(path))
    return data


def vitest_counts(body):
    plain = ANSI.sub("", body)
    result = {}
    for label, prefix in (("Test Files", "files"), ("Tests", "tests")):
        lines = re.findall(r"^\s*" + label + r"\s+([^\n]+)", plain, re.MULTILINE)
        if lines:
            text = lines[-1]
            counts = {status: int(count) for count, status in
                      re.findall(r"(\d+)\s+(passed|failed|skipped|todo)", text)}
            total = re.search(r"\((\d+)\)", text)
            if total:
                counts["total"] = int(total.group(1))
            result[prefix] = counts
    return result


def interrupted(signum, _frame):
    raise InterruptedError("acceptance interrupted by signal " + str(signum))


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
save()
try:
    manifest["sourceBefore"] = clean_snapshot()
    require(platform.system() == "Linux", "This runner is Linux acceptance only")
    subprocess.run(["/usr/bin/git", "merge-base", "--is-ancestor", BASELINE, expected],
                   cwd=workspace, check=True)
    manifest["node"] = subprocess.check_output(["node", "--version"], text=True).strip()
    manifest["pnpm"] = subprocess.check_output(["corepack", "pnpm", "--version"], text=True).strip()
    manifest["changedFiles"] = git("diff", "--name-status", "--no-renames", BASELINE, expected).splitlines()
    changed = git("diff", "--name-only", BASELINE, expected).splitlines()
    allowed_production = {"packages/memory/src/search-text.ts", "packages/memory/src/memory-store.ts", "packages/memory/src/sqlite-memory-store.ts"}
    production_changes = [path for path in changed if path.startswith(("packages/", "apps/")) and path.endswith(".ts") and not path.endswith(".test.ts")]
    require(set(production_changes) <= allowed_production, "production changed outside the preregistered memory-query scope")
    manifest["allowedProductionFiles"] = sorted(allowed_production)
    manifest["productionChangedFiles"] = production_changes
    manifest["changedFileSha256"] = {
        path: sha256(workspace / path) if (workspace / path).is_file() else None for path in changed
    }
    initial_source = source_hashes()
    manifest["sourceFileSha256Before"] = initial_source
    manifest["distFileSha256BeforeBuild"] = dist_hashes()
    manifest["runnerSha256"] = sha256(Path(__file__))
    env = os.environ.copy()
    cleared = ["OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL", "BASE_URL",
               "E2E_OBSERVATION_RUN_ID", "E2E_OBSERVATION_EVIDENCE_DIR"]
    for name in cleared:
        env.pop(name, None)
    manifest["environmentKeysCleared"] = cleared
    run_id = "agent-next4-linux-" + expected[:12] + "-" + str(time.time_ns())
    manifest["observationRunId"] = run_id
    named = {**env, "E2E_OBSERVATION_RUN_ID": run_id,
             "E2E_OBSERVATION_EVIDENCE_DIR": str(output / "observations")}
    script = "scripts/research/agent-next4-20261005/"
    artifact_verifier = "scripts/research/agent-trust-20261004/verify-artifacts.mjs"
    REGRESSIONS = [p for p in git("diff", "--name-only", "--diff-filter=A", BASELINE, expected).splitlines()
                   if p.endswith(".test.ts") and p.startswith(("packages/model/", "packages/tools/", "packages/context/", "packages/harness/", "packages/memory/", "packages/core/"))]
    require(REGRESSIONS == ["packages/memory/src/query-preparation.regressions.test.ts"], "memory query repair requires its permanent regression file")
    manifest["newRegressionFiles"] = REGRESSIONS
    commands = [
        ("typecheck", ["corepack", "pnpm", "typecheck"], env),
        ("build", ["corepack", "pnpm", "build"], env),
        ("new-regressions", ["corepack", "pnpm", "exec", "vitest", "run", *REGRESSIONS], env),
        ("related-integration", ["corepack", "pnpm", "exec", "vitest", "run", "packages/model", "packages/tools", "packages/context", "packages/memory", "packages/harness",
                                  "packages/core/src/runtime/wire-protocol-e2e.test.ts",
                                  "apps/web/src/harness.integration.test.ts"], env),
        ("query-work-production", ["node", script + "query-work-probe.mjs", str(workspace), str(output / "query-work")], env),
        ("memory-harness-production", ["node", "scripts/research/agent-next2-20261005/memory-feedback-probe.mjs", str(workspace), str(output / "memory-harness")], env),
        ("provider-footer-control", ["node", "scripts/research/agent-followup-20261005/provider-probe.mjs", str(workspace), str(output / "provider-footer")], env),
        ("main-accounting", ["python3", "scripts/research/agent-followup-20261005/main-accounting.py", "--root", str(workspace),
                             "--out", str(output / "main-accounting"), "--expect-sha", expected], env),
        ("joint-browser", ["python3", "scripts/research/web-dsh-20261004/browser.py", "--repo", str(workspace),
                           "--mode", "candidate", "--require-clean", "--out", str(output / "joint-browser")], env),
        ("security", ["corepack", "pnpm", "test:security"], env),
        ("docs-verify", ["corepack", "pnpm", "docs:verify"], env),
        ("full", ["python3", str(HERE.parent / "agent-context-memory-20261004" / "subreaper.py"),
                  "corepack", "pnpm", "test"], named),
        ("usage-audit", ["node", "apps/cli/dist/main.js", "usage-audit", "--run", run_id, "--strict"], named),
        ("prior-artifact-integrity", ["node", artifact_verifier,
                                     "docs/evidence/agent-next3-20261005/artifact-index.json"], env),
        ("diff-check", ["/usr/bin/git", "diff", "--check", BASELINE, expected], env),
    ]
    manifest["mandatoryCommandNames"] = [name for name, _, _ in commands]
    expected_dist = None
    save()
    for name, command, command_env in commands:
        before = clean_snapshot()
        require(source_hashes() == initial_source, "tracked source bytes changed before " + name)
        if expected_dist is not None:
            require(dist_hashes() == expected_dist, "built dist bytes changed before " + name)
        log = output / (name + ".log")
        active_row = {"name": name, "argv": command, "cwd": str(workspace), "cleanBefore": True,
                      "sourceBefore": before, "status": "RUNNING", "log": log.name}
        manifest["commands"].append(active_row)
        save()
        print("START", name, flush=True)
        started = time.monotonic()
        with log.open("x") as target:
            active_process = subprocess.Popen(command, cwd=workspace, env=command_env,
                                              stdout=target, stderr=subprocess.STDOUT, start_new_session=True)
            exit_code = active_process.wait()
        active_process = None
        body = log.read_text(errors="replace")
        active_row.update({"exitCode": exit_code, "durationSeconds": round(time.monotonic() - started, 3),
                           "logSha256": sha256(log), "logBytes": log.stat().st_size,
                           "summary": [line.strip() for line in ANSI.sub("", body).splitlines()
                                       if re.search(r"Test Files|Tests\s{2}|Duration\s{2}|\[review supervisor\]", line)][-8:]})
        counts = vitest_counts(body)
        if counts:
            active_row["vitestCounts"] = counts
        require(exit_code == 0, name + " exited " + str(exit_code))
        if name in ("new-regressions", "related-integration", "full", "security"):
            require(counts.get("tests", {}).get("passed", 0) > 0, "missing passed test summary: " + name)
            require(not counts["tests"].get("failed", 0), "failed tests in " + name)
        if name == "new-regressions":
            require(counts["files"].get("passed") == len(REGRESSIONS), "not all new regression files ran")
            require(not counts["tests"].get("skipped", 0) and not counts["tests"].get("todo", 0),
                    "new regressions must have no skipped/todo cases")
            manifest["newRegressionTestsPassed"] = counts["tests"]["passed"]
        elif name == "full":
            require(counts["files"].get("passed", 0) >= 470 + len(REGRESSIONS),
                    "full run must collect the baseline files and every added regression")
            require(counts["tests"].get("passed", 0) >= 8713 + manifest["newRegressionTestsPassed"],
                    "full run omitted existing or newly added test coverage")
            require(counts["tests"].get("skipped", 0) == 12 and not counts["tests"].get("todo", 0),
                    "full run must retain exactly the twelve existing skips and no todos")
        elif name == "build":
            expected_dist = dist_hashes()
            require(expected_dist, "build produced no dist files")
            manifest["distFileSha256AfterBuild"] = expected_dist
        elif name == "main-accounting":
            receipt_path = output / "main-accounting" / "result.json"
            data = json_receipt(receipt_path)
            require(data.get("sourceSha") == expected and data.get("sourceShaAtEnd") == expected,
                    "R1 source provenance mismatch")
            require(not data.get("sourceTrackedDirtyAtStart") and not data.get("sourceTrackedDirtyAtEnd"),
                    "R1 ran a dirty source")
            require(data.get("sourceFingerprintsBefore") == data.get("sourceFingerprintsAfter"),
                    "R1 source/dist changed")
            require(len(data.get("cases", [])) == 7 and all(case.get("status") == "PASS" for case in data["cases"]),
                    "R1 direct/CLI/Web cases incomplete")
            active_row["receipt"] = {"path": str(receipt_path.relative_to(output)), "sha256": sha256(receipt_path)}
        elif name in ("query-work-production", "memory-harness-production", "provider-footer-control"):
            subdirectory = {"query-work-production": "query-work", "memory-harness-production": "memory-harness", "provider-footer-control": "provider-footer"}[name]
            receipt_path = output / subdirectory / "result.json"
            data = json_receipt(receipt_path)
            require(data.get("sourceSha") == expected and data.get("sourceShaAtEnd") == expected, "production source provenance mismatch")
            require(data.get("sourceTrackedDirtyAtStart") is False and data.get("sourceTrackedDirtyAtEnd") is False, "dirty production probe")
            require(data.get("sourceFingerprintsBefore") and data["sourceFingerprintsBefore"] == data.get("sourceFingerprintsAfter"), "production bytes changed")
            required_count = {"query-work-production": 17, "memory-harness-production": 44, "provider-footer-control": 31}[name]
            require(len(data.get("cases", [])) == required_count and len({case.get("name") for case in data["cases"]}) == required_count and all(case.get("status") == "PASS" for case in data["cases"]), "production cases incomplete")
            if name == "query-work-production":
                for backend in ("jsonl", "sqlite"):
                    case = next(c for c in data["cases"] if c["name"] == backend + "-1500-row-query-work")
                    require(case["observed"]["queryLowerCalls"] <= 1 and case["observed"]["lexicalTokenizationCalls"] <= 1, "invariant query work budget failed")
            active_row["receipt"] = {"path": str(receipt_path.relative_to(output)), "sha256": sha256(receipt_path)}
        elif name == "joint-browser":
            receipt_path = output / "joint-browser" / "browser-result.json"
            data = json_receipt(receipt_path)
            require(data.get("requireCleanSource") is True and data.get("caseCount") == 27
                    and data.get("passed") == 27 and data.get("failed") == 0 and data.get("browserErrorCount") == 0,
                    "joint browser needs all 27 cases and zero page errors")
            active_row["receipt"] = {"path": str(receipt_path.relative_to(output)), "sha256": sha256(receipt_path)}
        elif name == "usage-audit":
            require("usage audit: PASS (all key capabilities observed)" in body,
                    "strict same-run usage audit did not observe all capabilities")
        active_row["sourceAfter"] = clean_snapshot()
        require(source_hashes() == initial_source, "tracked source bytes changed during " + name)
        if expected_dist is not None:
            require(dist_hashes() == expected_dist, "built dist bytes changed during " + name)
        active_row.update(status="PASS", cleanAfter=True)
        print("END", name, exit_code, active_row["durationSeconds"], active_row["summary"], flush=True)
        save()
        active_row = None
    manifest["sourceAfter"] = clean_snapshot()
    manifest["sourceFileSha256After"] = source_hashes()
    manifest["distFileSha256AfterAcceptance"] = dist_hashes()
    manifest["status"] = "PASS"
    manifest["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    save()
except BaseException as error:
    if active_process is not None and active_process.poll() is None:
        try:
            os.killpg(active_process.pid, signal.SIGTERM)
            active_process.wait(timeout=8)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            if active_process.poll() is None:
                os.killpg(active_process.pid, signal.SIGKILL)
                active_process.wait()
    manifest.update(status="FAIL", finishedAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    exception={"type": type(error).__name__, "message": str(error)})
    if active_row is not None:
        active_row.update(status="FAIL", exception=manifest["exception"])
        if active_process is not None:
            active_row["exitCode"] = active_process.returncode
        log = output / active_row["log"]
        if log.is_file():
            active_row.update(logSha256=sha256(log), logBytes=log.stat().st_size)
    (output / "exception.txt").write_text(traceback.format_exc())
    save()
    print("FAIL", type(error).__name__, str(error), flush=True)
    sys.exit(1)
