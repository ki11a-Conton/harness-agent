/**
 * Q-12 — Windows / Linux Path Parity.
 *
 * CI runs on Linux, but the harness may be interactively addressed from a
 * Windows host (drive letters, UNC shares) or receive Windows-style paths
 * from the model. This test module proves the path SEMANTICS the harness
 * depends on are platform-independent — it drives the real `path.win32`
 * module (available on every platform) to construct canonical Windows paths,
 * then asserts containment, normalization, and fail-closed denial behave
 * exactly like their POSIX counterparts, with no host-dependent behavior.
 *
 * Covered per plan.md Q-12: drive letter · backslash · case-insensitive ·
 * UNC · symlink(Point: realpath canonicalization is exercised through the
 * manager, which already has junction/symlink-escape tests; here we assert
 * the pure helpers are separator-agnostic so the manager's realpath reasoning
 * is safe when handed Windows paths).
 */
import { join, posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { containsPath } from "./sandbox.js";
import { globToRegex, matchGlob, normalizePath } from "./glob.js";
describe("Q-12 path parity — normalizePath (backslash / drive)", () => {
    it("normalizes backslashes to slashes on every platform", () => {
        expect(normalizePath("a\\b\\c.txt")).toBe("a/b/c.txt");
        expect(normalizePath(win32.join("a", "b"))).toBe("a/b");
    });
    it("collapses a win32-style absolute path into a slash form (no double slash)", () => {
        const drive = win32.join("C:\\", "ws", "sub", "f.txt");
        expect(normalizePath(drive)).toBe("C:/ws/sub/f.txt");
        // The drive letter must survive; that is what the sandbox's drive regex reads.
        expect(/^[A-Za-z]:\//.test(normalizePath(drive))).toBe(true);
    });
    it("UNC backslash paths normalize to forward-slash UNC form", () => {
        const unc = "\\\\server\\share\\file.txt";
        expect(normalizePath(unc)).toBe("//server/share/file.txt");
    });
    it("is idempotent (already-normalized input is unchanged)", () => {
        expect(normalizePath("a/b/c")).toBe("a/b/c");
    });
});
describe("Q-12 path parity — win32 vs posix containment equivalence", () => {
    it("containsPath treats posix-joined and win32-joined paths the same (slash-folded)", () => {
        const posixAbs = posix.join("/ws", "sub", "f.txt");
        const winAbs = win32.join("C:\\", "ws", "sub", "f.txt");
        // In slash-normalized form the trailing separator logic must agree.
        expect(containsPath(posixAbs, "/ws", false)).toBe(true);
        expect(containsPath(normalizePath(winAbs), "C:/ws", false)).toBe(true);
    });
    it("containment is boundary-safe for win32-style siblings", () => {
        const root = "C:/ws";
        expect(containsPath("C:/ws/child/f.txt", root, false)).toBe(true);
        expect(containsPath("C:/ws2/f.txt", root, false)).toBe(false);
        expect(containsPath("C:/ws-2/f.txt", root, false)).toBe(false);
    });
    it("case-insensitive fold works on win32-style uppercase paths", () => {
        expect(containsPath("C:/WS/Child/Secret.txt", "c:/ws/child/secret.txt", true)).toBe(true);
        // Case-insensitive must still not admit a genuinely different sibling.
        expect(containsPath("C:/ws2/Secret.txt", "c:/ws/child", true)).toBe(false);
    });
    it("trailing-slash roots behave identically for win32-style paths", () => {
        expect(containsPath("C:/ws/a.txt", "C:/ws/", false)).toBe(true);
        // A child inside a trailing-slash root is contained…
        expect(containsPath("C:/ws/child/f.txt", "C:/ws/", false)).toBe(true);
        // P14-1: containment is canonical — separator normalisation strips the
        // trailing slash, so the root itself IS inside its own trailing-slash
        // form (same directory, not an escape). Sibling collision is still
        // rejected below; allowing the granted root itself is fail-closed safe.
        expect(containsPath("C:/ws", "C:/ws/", false)).toBe(true);
        expect(containsPath("C:/ws2/x", "C:/ws/", false)).toBe(false);
    });
});
describe("Q-12 path parity — glob matching is separator-agnostic", () => {
    it("matchGlob matches backslash input against slash patterns", () => {
        expect(matchGlob("src/**/*.ts", "src\\core\\main.ts")).toBe(true);
        expect(matchGlob("*.ts", "C:\\ws\\main.ts")).toBe(true); // basename fallback
        expect(matchGlob("tests/**", "tests\\fixtures\\a.json")).toBe(true);
    });
    it("globToRegex is independent of the host separator", () => {
        // The pattern text is slash-based; a backslash literal in the TARGET is
        // normalized before matching, so the regex never sees it.
        expect(globToRegex("**/a.ts").test(normalizePath("x\\y\\a.ts"))).toBe(true);
        expect(globToRegex("**/a.ts").test("x/y/a.ts")).toBe(true);
    });
});
describe("Q-12 path parity — win32 module parity contract", () => {
    it("win32.join is available on the host platform (module contract)", () => {
        expect(typeof win32.resolve === "function").toBe(true);
        expect(typeof win32.join === "function").toBe(true);
    });
});
//# sourceMappingURL=path-parity.test.js.map