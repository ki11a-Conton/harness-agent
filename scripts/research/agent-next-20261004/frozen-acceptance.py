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

BASELINE = "18f162bf7f12c4b8e8cebcebede4034dd1f3efb7"
HERE = Path(__file__).resolve().parent
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
REGRESSIONS = [
    "packages/model/src/openai-system-context.regressions.test.ts",
    "packages/memory/src/retrieval-work.regressions.test.ts",
    "packages/tools/src/navigation-work.regressions.test.ts",
]
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
    "schemaVersion": "agent-next-frozen-acceptance-v1",
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
    run_id = "agent-next-linux-" + expected[:12] + "-" + str(time.time_ns())
    manifest["observationRunId"] = run_id
    named = {**env, "E2E_OBSERVATION_RUN_ID": run_id,
             "E2E_OBSERVATION_EVIDENCE_DIR": str(output / "observations")}
    script = "scripts/research/agent-next-20261004/"
    artifact_verifier = "scripts/research/agent-trust-20261004/verify-artifacts.mjs"
    commands = [
        ("typecheck", ["corepack", "pnpm", "typecheck"], env),
        ("build", ["corepack", "pnpm", "build"], env),
        ("new-regressions", ["corepack", "pnpm", "exec", "vitest", "run", *REGRESSIONS], env),
        ("wire-e2e-regressions", ["corepack", "pnpm", "exec", "vitest", "run",
                                 "packages/core/src/runtime/wire-protocol-e2e.test.ts"], env),
        ("provider-production", ["python3", script + "provider-production.py", "--root", str(workspace),
                                 "--out", str(output / "r1-http"), "--expect-sha", expected], env),
        # All R2 invocations are serial. The performance probe itself alternates
        # the exact baseline reference and candidate (AB/BA), not two concurrent runs.
        ("memory-differential", ["node", script + "memory-differential-probe.mjs",
                                 str(workspace), str(output / "r2-differential")], env),
        ("memory-paired-performance", ["node", script + "memory-paired-performance-probe.mjs",
                                       str(workspace), str(output / "r2-performance")], env),
        ("memory-harness", ["node", script + "memory-harness-probe.mjs",
                            str(workspace), str(output / "r2-harness")], env),
        ("navigation-production", ["node", script + "navigation-probe.mjs", "--workspace", str(workspace)], env),
        ("joint-browser", ["python3", "scripts/research/web-dsh-20261004/browser.py", "--repo", str(workspace),
                           "--mode", "candidate", "--require-clean", "--out", str(output / "joint-browser")], env),
        ("security", ["corepack", "pnpm", "test:security"], env),
        ("docs-verify", ["corepack", "pnpm", "docs:verify"], env),
        ("full", ["python3", str(HERE.parent / "agent-context-memory-20261004" / "subreaper.py"),
                  "corepack", "pnpm", "test"], named),
        ("usage-audit", ["node", "apps/cli/dist/main.js", "usage-audit", "--run", run_id, "--strict"], named),
        ("web-artifact-integrity", ["node", artifact_verifier,
                                   "docs/evidence/web-dsh-20261004/artifact-index.json"], env),
        ("context-memory-artifact-integrity", ["node", artifact_verifier,
                                              "docs/evidence/agent-context-memory-20261004/artifact-index.json"], env),
        ("web-recheck-artifact-integrity", ["node", artifact_verifier,
                                           "docs/evidence/web-recheck-20261004/artifact-index.json"], env),
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
        if name in ("new-regressions", "wire-e2e-regressions", "full", "security"):
            require(counts.get("tests", {}).get("passed", 0) > 0, "missing passed test summary: " + name)
            require(not counts["tests"].get("failed", 0), "failed tests in " + name)
        if name == "new-regressions":
            require(counts["files"].get("passed") == len(REGRESSIONS), "not all new regression files ran")
            require(not counts["tests"].get("skipped", 0) and not counts["tests"].get("todo", 0),
                    "new regressions must have no skipped/todo cases")
        elif name == "wire-e2e-regressions":
            require(counts["files"].get("passed") == 1 and counts["tests"].get("passed") == 8
                    and not counts["tests"].get("skipped", 0) and not counts["tests"].get("todo", 0),
                    "all eight existing wire E2E contracts must run and pass")
        elif name == "build":
            expected_dist = dist_hashes()
            require(expected_dist, "build produced no dist files")
            manifest["distFileSha256AfterBuild"] = expected_dist
        elif name == "provider-production":
            receipt_path = output / "r1-http" / "result.json"
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
        elif name.startswith("memory-"):
            subdirectory = {"memory-differential": "r2-differential", "memory-paired-performance": "r2-performance",
                            "memory-harness": "r2-harness"}[name]
            receipt_path = output / subdirectory / "report.json"
            data = json_receipt(receipt_path)
            require(data.get("sourceUnchanged") is True, "R2 source/dist fingerprint mismatch: " + name)
            require(data.get("sourceHead") == expected and data.get("sourceHeadAfter") == expected
                    and data.get("sourceStatus") == "" and data.get("sourceStatusAfter") == "",
                    "R2 source provenance mismatch: " + name)
            active_row["receipt"] = {"path": str(receipt_path.relative_to(output)), "sha256": sha256(receipt_path)}
        elif name == "navigation-production":
            data = json.loads(body)
            require(data.get("status") == "PASS" and data.get("head") == expected,
                    "R3 provenance/verdict mismatch")
            require(len(data.get("checks", [])) == 7 and all(case.get("verdict") == "PASS" for case in data["checks"]),
                    "R3 seven production work/boundary checks incomplete")
            (output / "r3-navigation.json").write_text(json.dumps(data, indent=2) + "\n")
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
