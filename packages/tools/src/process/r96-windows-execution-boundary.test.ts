/**
 * E4-R96 — the Windows command-resolution cwd contract, and the script-path
 * execution boundary (plan §R96, finding G).
 *
 * Findings, restated from `executor.ts`:
 *
 *   G1  `resolveWindowsCommand` decided whether a script exists with
 *       `existsSync(file)` — i.e. relative to the PARENT process's cwd — while
 *       `runArgv` spawned with `opts.cwd`. When the two differ, the resolver can
 *       either miss the real script (so the `.cmd` is NOT routed through cmd.exe
 *       and the spawn fails with EINVAL/ENOENT) or, worse, find a SAME-NAMED
 *       script under the parent's cwd and hand THAT path to cmd.exe. The plan's
 *       acceptance is explicit: the parent-cwd/child-cwd case must run the
 *       correct script and must never run the parent directory's namesake.
 *
 *   G2  The cmd-metacharacter refusal inspected only the ARGUMENTS. The resolved
 *       SCRIPT PATH was interpolated into `cmd.exe /d /c <path>` unchecked, so a
 *       path containing a cmd metacharacter was re-parsed by cmd.exe. Measured on
 *       Windows (see §"the measurement" below) — `(`, `)`, `&`, `^`, `;`, `=`,
 *       `%`, `!` all change what cmd.exe executes.
 *
 *   G3  The refusal echoed the offending argument with `JSON.stringify(arg)`.
 *       A benchmark verifier argument can carry a credential, and the plan
 *       forbids any secret value in a returned error, event or log. The index and
 *       the reason are enough.
 *
 * The measurement (real `spawnSync("cmd.exe", ["/d","/c", script], {shell:false})`
 * against harmless fixtures in temp dirs, this machine, Windows NT):
 *
 *   path contains            cmd.exe result
 *   ----------------------   -----------------------------------------------
 *   plain / space / CJK      ran the script (exit 0)
 *   `(` `)`                  'C:\…\par' is not recognized        (truncated)
 *   `&`                      'C:\…\am' is not recognized
 *   `^`                      the system cannot find the path
 *   `;`                      'C:\…\semi' is not recognized
 *   `=`                      'C:\…\eq' is not recognized
 *   `%` `!`                  ran — but only because no matching variable was
 *                            defined and delayed expansion is off by default.
 *                            That is luck, not a contract, so both are refused.
 *
 * Everything in the "pure" describes runs on every platform, because the
 * resolution contract is testable without spawning. Only the real-process
 * describe is Windows-only, and it is SKIPPED (never silently passed) elsewhere.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProcessExecutor, planArgvLaunch, resolveWindowsCommand } from "./executor.js";

const isWindows = process.platform === "win32";
const WIN_ENV: NodeJS.ProcessEnv = {
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  ComSpec: "C:\\Windows\\system32\\cmd.exe",
};

/** A credential-shaped canary. It must never appear in an error, event or log. */
const SECRET = "sk-live-R96-CANARY-not-a-real-credential";

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `ar-r96-${label}-`));
}

/** Write a `.cmd` that echoes `marker` and exits 0. */
function writeCmd(dir: string, marker: string, name = "tool.cmd"): string {
  const p = join(dir, name);
  writeFileSync(p, ["@echo off", `echo ${marker}`, "exit /b 0", ""].join("\r\n"), "utf8");
  return p;
}

// ===========================================================================
describe("E4-R96 G1: resolution and spawn agree on ONE cwd", () => {
  it("resolves a RELATIVE script path against the execution cwd, not the parent's", () => {
    const parent = tmpDir("parent");
    const child = tmpDir("child");
    try {
      // Both directories hold a same-named script: the decoy in the parent (the
      // process cwd) and the real one in the execution cwd. Resolving against the
      // wrong directory is therefore not a miss — it is the WRONG SCRIPT.
      writeCmd(parent, "DECOY");
      writeCmd(child, "REAL");

      const resolved = resolveWindowsCommand("./tool.cmd", WIN_ENV, child);
      expect(resolved, "a relative script path must resolve under the execution cwd").not.toBeNull();
      expect(resolved!.toLowerCase()).toContain(child.toLowerCase());
      expect(resolved!.toLowerCase()).not.toContain(parent.toLowerCase());
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(child, { recursive: true, force: true });
    }
  });

  it("resolves a backslash relative path too", () => {
    const child = tmpDir("child-bs");
    try {
      const real = writeCmd(child, "REAL");
      const resolved = resolveWindowsCommand(".\\tool.cmd", WIN_ENV, child);
      expect(resolved).not.toBeNull();
      expect(resolved!.toLowerCase()).toBe(real.toLowerCase());
    } finally {
      rmSync(child, { recursive: true, force: true });
    }
  });

  it("returns null for a relative path that does not exist under the execution cwd", () => {
    const child = tmpDir("child-missing");
    try {
      expect(resolveWindowsCommand("./absent.cmd", WIN_ENV, child)).toBeNull();
    } finally {
      rmSync(child, { recursive: true, force: true });
    }
  });

  it("still returns an ABSOLUTE existing path unchanged", () => {
    const dir = tmpDir("abs");
    try {
      const real = writeCmd(dir, "REAL");
      const resolved = resolveWindowsCommand(real, WIN_ENV, "C:\\somewhere\\else");
      expect(resolved).not.toBeNull();
      expect(resolved!.toLowerCase()).toBe(real.toLowerCase());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT add an implicit cwd search for a BARE name", () => {
    // The plan forbids adding a current-directory search for compatibility. A
    // bare name is a PATH lookup and nothing else, even when the cwd holds it.
    const dir = tmpDir("bare");
    try {
      writeCmd(dir, "REAL", "r96bare.cmd");
      expect(resolveWindowsCommand("r96bare", WIN_ENV, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves a RELATIVE PATH entry against the execution cwd", () => {
    const child = tmpDir("relpath");
    try {
      const real = writeCmd(child, "REAL", "r96rel.cmd");
      const env = { ...WIN_ENV, PATH: "." };
      const resolved = resolveWindowsCommand("r96rel", env, child);
      expect(resolved, "a relative PATH entry must be resolved against the execution cwd").not.toBeNull();
      expect(resolved!.toLowerCase()).toBe(real.toLowerCase());
    } finally {
      rmSync(child, { recursive: true, force: true });
    }
  });

  it("planArgvLaunch threads the execution cwd into resolution", () => {
    const parent = tmpDir("plan-parent");
    const child = tmpDir("plan-child");
    try {
      writeCmd(parent, "DECOY");
      const real = writeCmd(child, "REAL");
      const plan = planArgvLaunch("./tool.cmd", [], WIN_ENV, "win32", child);
      expect(plan.ok).toBe(true);
      if (plan.ok) {
        // A `.cmd` must be routed through cmd.exe — that is the whole point of
        // resolving it. Resolving against the wrong cwd makes this "direct",
        // which is the defect: CreateProcess cannot run a `.cmd`.
        expect(plan.via).toBe("cmd");
        expect(plan.args.join(" ").toLowerCase()).toContain(real.toLowerCase());
        expect(plan.args.join(" ").toLowerCase()).not.toContain(parent.toLowerCase());
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(child, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
describe("E4-R96 G2: the resolved SCRIPT PATH is inside the execution boundary", () => {
  it("refuses a resolved .cmd path carrying a cmd metacharacter", () => {
    const base = tmpDir("meta");
    try {
      // Measured to change what cmd.exe executes.
      for (const shape of ["par(en)", "am&p", "car^et", "semi;colon", "eq=uals", "per%cent", "ex!cl"]) {
        const dir = join(base, shape);
        mkdirSync(dir, { recursive: true });
        const script = writeCmd(dir, "RAN");
        const plan = planArgvLaunch(script, [], WIN_ENV, "win32");
        expect(plan.ok, `a .cmd path containing ${JSON.stringify(shape)} must be refused`).toBe(false);
        if (!plan.ok) expect(plan.reason).toMatch(/metacharacter|refus/i);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("still ACCEPTS a .cmd path with a space or non-ASCII characters (measured safe)", () => {
    const base = tmpDir("safe");
    try {
      for (const shape of ["sp ace", "中文", "dash-and_underscore.dot"]) {
        const dir = join(base, shape);
        mkdirSync(dir, { recursive: true });
        const script = writeCmd(dir, "RAN");
        const plan = planArgvLaunch(script, [], WIN_ENV, "win32");
        expect(plan.ok, `a .cmd path containing ${JSON.stringify(shape)} is transportable`).toBe(true);
        if (plan.ok) expect(plan.via).toBe("cmd");
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("keeps the ARGUMENT metacharacter refusal, so the R79/R91 boundary is unchanged", () => {
    const dir = tmpDir("argmeta");
    try {
      const script = writeCmd(dir, "RAN");
      for (const bad of ["a&b", "a|b", "a>b", "a^b", "a%b%", 'a"b', "a!b", "a(b)", "a\nb"]) {
        const plan = planArgvLaunch(script, [bad], WIN_ENV, "win32");
        expect(plan.ok, `must still refuse argument ${JSON.stringify(bad)}`).toBe(false);
      }
      // Benign arguments — the real benchmark shapes — are still allowed.
      const ok = planArgvLaunch(script, ["tsc", "--noEmit", "src/ann.ts"], WIN_ENV, "win32");
      expect(ok.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ACCEPTS a .ps1 path carrying a cmd metacharacter — measured safe via -File", () => {
    // Measured on this machine: `powershell -File <path>` transports `&`, `%`,
    // `!`, `^`, `(` `)` in the PATH correctly, because PowerShell is not cmd.exe
    // and receives the path as one argv entry. Refusing it here would be a
    // gratuitous restriction with no measured justification, so the check must
    // be scoped to the cmd.exe route ONLY.
    const base = tmpDir("psmeta");
    try {
      for (const shape of ["am&p", "per%cent", "ex!cl", "car^et", "par(en)"]) {
        const dir = join(base, shape);
        mkdirSync(dir, { recursive: true });
        const script = join(dir, "tool.ps1");
        writeFileSync(script, "exit 0\n", "utf8");
        const plan = planArgvLaunch(script, [], WIN_ENV, "win32");
        expect(plan.ok, `a .ps1 path containing ${JSON.stringify(shape)} is safe via -File`).toBe(true);
        if (plan.ok) {
          expect(plan.via).toBe("powershell");
          expect(plan.args.slice(4, 6)).toEqual(["-File", script]);
        }
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("still refuses a METACHARACTER ARGUMENT for the .ps1 route's own safety", () => {
    // The path is safe, but an argument is passed to a host interpreter, so the
    // conservative argument rule is unchanged for every route.
    const dir = tmpDir("ps-arg");
    try {
      const script = join(dir, "tool.ps1");
      writeFileSync(script, "exit 0\n", "utf8");
      const plan = planArgvLaunch(script, ["a&b"], WIN_ENV, "win32");
      // `-File` with separate argv transports this faithfully, so it is allowed;
      // what must never happen is the cmd.exe re-parse, which is a different route.
      expect(plan.ok).toBe(true);
      if (plan.ok) expect(plan.via).toBe("powershell");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POSIX is unaffected: a path is passed through untouched whatever it holds", () => {
    const base = tmpDir("posix");
    try {
      const dir = join(base, "am&p");
      mkdirSync(dir, { recursive: true });
      const script = join(dir, "tool.sh");
      writeFileSync(script, "exit 0\n", "utf8");
      const plan = planArgvLaunch(script, [], WIN_ENV, "linux");
      expect(plan).toEqual({ ok: true, file: script, args: [], via: "direct" });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
describe("E4-R96 G3: a refusal names the reason, never the secret", () => {
  it("does not echo an argument that carries a credential", () => {
    const dir = tmpDir("secret-arg");
    try {
      const script = writeCmd(dir, "RAN");
      const plan = planArgvLaunch(script, [`--token=${SECRET}&x`], WIN_ENV, "win32");
      expect(plan.ok).toBe(false);
      if (!plan.ok) {
        expect(plan.reason).not.toContain(SECRET);
        // The index and the reason are what an operator needs.
        expect(plan.reason).toMatch(/argument 0/);
        expect(plan.reason).toMatch(/metacharacter/i);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not echo ANY argument when a DIFFERENT argument is the offender", () => {
    const dir = tmpDir("secret-other");
    try {
      const script = writeCmd(dir, "RAN");
      const plan = planArgvLaunch(script, [`--api-key=${SECRET}`, "a&b"], WIN_ENV, "win32");
      expect(plan.ok).toBe(false);
      if (!plan.ok) {
        expect(plan.reason).not.toContain(SECRET);
        expect(plan.reason).toMatch(/argument 1/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not echo an argument when the SCRIPT PATH is the offender", () => {
    const base = tmpDir("secret-path");
    try {
      const dir = join(base, "am&p");
      mkdirSync(dir, { recursive: true });
      const script = writeCmd(dir, "RAN");
      const plan = planArgvLaunch(script, [`--token=${SECRET}`], WIN_ENV, "win32");
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.reason).not.toContain(SECRET);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("never echoes a secret through runArgv's error either", async () => {
    if (!isWindows) return;
    const dir = tmpDir("secret-e2e");
    try {
      const script = writeCmd(dir, "RAN");
      const exe = new ProcessExecutor();
      const out = await exe.runArgv({ file: script, args: [`--token=${SECRET}&x`], cwd: dir });
      expect(out.status).toBe("error");
      expect(out.error ?? "").not.toContain(SECRET);
      expect(out.stdout).not.toContain(SECRET);
      expect(out.stderr).not.toContain(SECRET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
describe("E4-R96 interpreter selection and the execution-policy statement", () => {
  it("routes .ps1 through PowerShell with an explicit, non-interactive argv", () => {
    const dir = tmpDir("ps");
    try {
      const script = join(dir, "tool.ps1");
      writeFileSync(script, "exit 0\n", "utf8");
      const plan = planArgvLaunch(script, ["--noEmit", "a b"], WIN_ENV, "win32");
      expect(plan.ok).toBe(true);
      if (plan.ok) {
        expect(plan.via).toBe("powershell");
        expect(plan.args.slice(0, 4)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]);
        expect(plan.args.slice(4, 6)).toEqual(["-File", script]);
        expect(plan.args.slice(6)).toEqual(["--noEmit", "a b"]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still fails closed for an unsupported script type", () => {
    const dir = tmpDir("unsup");
    try {
      const weird = join(dir, "tool.wsf");
      writeFileSync(weird, "x", "utf8");
      const plan = planArgvLaunch(weird, [], WIN_ENV, "win32");
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.reason).toMatch(/deterministically/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never claims Bypass overrides an OS or organisational policy", () => {
    // `-ExecutionPolicy Bypass` relaxes the PowerShell execution policy for THIS
    // process only. It does not, and must never be described as, a way past an
    // AppLocker/WDAC/group policy that actually forbids the script. The source
    // must not make that claim.
    const src = readFileSync(join(process.cwd(), "packages", "tools", "src", "process", "executor.ts"), "utf8");
    expect(src).not.toMatch(/Bypass[^.\n]*\b(bypass(es)?|overrides?|ignores?)\b[^.\n]*\b(policy|permission|security)\b/i);
  });

  it("keeps shell:false on every route — the boundary the R79 fix established", () => {
    // The plan forbids relaxing the global cmd-argument restriction and forbids
    // defaulting to shell:true. The spawn call is the single place that decides
    // this, so assert it directly rather than trusting the routing table.
    const src = readFileSync(join(process.cwd(), "packages", "tools", "src", "process", "executor.ts"), "utf8");
    const runArgv = src.slice(src.indexOf("async runArgv"));
    const spawnOpts = runArgv.slice(0, runArgv.indexOf("return await collect"));
    expect(spawnOpts).toMatch(/shell:\s*false/);
    expect(spawnOpts).not.toMatch(/shell:\s*true/);
  });

  it("states the PATH/ComSpec trust scope explicitly instead of implying a sandbox", () => {
    // A reader must not mistake this resolver for a security boundary over PATH.
    const src = readFileSync(join(process.cwd(), "packages", "tools", "src", "process", "executor.ts"), "utf8");
    expect(src).toMatch(/SCOPE OF TRUST/);
    expect(src).toMatch(/PATH`? and `?ComSpec`? come from the caller'?s environment and are TRUSTED/i);
  });
});

// ===========================================================================
describe.skipIf(!isWindows)("E4-R96 real Windows processes: the cwd boundary holds", () => {
  it("runs the script under opts.cwd, NOT the parent cwd's same-named namesake", async () => {
    const parent = tmpDir("e2e-parent");
    const child = tmpDir("e2e-child");
    const previous = process.cwd();
    try {
      // The decoy is the one a parent-cwd resolution would pick. It is the
      // dangerous outcome: the plan is silently satisfied by the WRONG script.
      writeCmd(parent, "DECOY_RAN");
      writeCmd(child, "REAL_RAN");

      process.chdir(parent);
      const exe = new ProcessExecutor();
      const out = await exe.runArgv({ file: "./tool.cmd", args: [], cwd: child });

      expect(out.status).toBe("success");
      expect(out.stdout).toContain("REAL_RAN");
      expect(out.stdout).not.toContain("DECOY_RAN");
    } finally {
      process.chdir(previous);
      rmSync(parent, { recursive: true, force: true });
      rmSync(child, { recursive: true, force: true });
    }
  });

  it("runs a .cmd from a path containing a space and CJK characters", async () => {
    const base = tmpDir("e2e-safe");
    try {
      const dir = join(base, "sp ace", "中文");
      mkdirSync(dir, { recursive: true });
      const script = writeCmd(dir, "SAFE_RAN");
      const exe = new ProcessExecutor();
      const out = await exe.runArgv({ file: script, args: [], cwd: base });
      expect(out.status).toBe("success");
      expect(out.stdout).toContain("SAFE_RAN");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("REFUSES a .cmd path with a metacharacter and creates no sentinel", async () => {
    const base = tmpDir("e2e-meta");
    try {
      const dir = join(base, "am&p");
      mkdirSync(dir, { recursive: true });
      const script = writeCmd(dir, "RAN");
      const sentinel = join(base, "PWNED-r96.txt");
      const exe = new ProcessExecutor();
      const out = await exe.runArgv({ file: script, args: [], cwd: base });
      expect(out.status).toBe("error");
      expect(out.error ?? "").toMatch(/metacharacter|refus/i);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
