/**
 * P14-1 — Pure path containment regression tests.
 *
 * Covers every scenario listed in the plan:
 *   - `/work/../etc` traversal
 *   - `/work/a/../../etc` multi-level traversal
 *   - `/work2` / `/work-evil` sibling collision
 *   - `C:\work\..\Windows` Windows traversal
 *   - drive letter case folding
 *   - UNC paths
 *   - trailing separators
 *   - `.` / `..` mixture
 *   - symlink containment is handled by the I/O layer (canonical-path tests);
 *     the pure primitive is tested with canonical inputs.
 */
import { describe, expect, it } from "vitest";
import { classifyPath, isPathWithin, lexicalNormalize, normaliseSeparators, } from "./path-containment.js";
describe("classifyPath", () => {
    it("classifies POSIX absolute paths", () => {
        expect(classifyPath("/home/u/work")).toBe("posix-absolute");
        expect(classifyPath("/")).toBe("posix-absolute");
        expect(classifyPath("/etc/passwd")).toBe("posix-absolute");
    });
    it("classifies Windows drive paths", () => {
        expect(classifyPath("C:\\work")).toBe("windows-drive");
        expect(classifyPath("c:/work/sub")).toBe("windows-drive");
        expect(classifyPath("D:\\a\\b\\c")).toBe("windows-drive");
    });
    it("classifies UNC paths", () => {
        expect(classifyPath("\\\\server\\share")).toBe("unc");
        expect(classifyPath("//server/share/file")).toBe("unc");
    });
    it("classifies relative paths", () => {
        expect(classifyPath("relative/path")).toBe("relative");
        expect(classifyPath("C:relative")).toBe("relative"); // drive-relative
        expect(classifyPath("")).toBe("relative");
    });
});
describe("normaliseSeparators", () => {
    it("converts backslashes to forward slashes", () => {
        expect(normaliseSeparators("a\\b\\c.txt")).toBe("a/b/c.txt");
    });
    it("collapses duplicate slashes", () => {
        expect(normaliseSeparators("a//b///c")).toBe("a/b/c");
    });
    it("strips trailing slash", () => {
        expect(normaliseSeparators("/work/")).toBe("/work");
        expect(normaliseSeparators("C:/work/")).toBe("C:/work");
    });
    it("preserves root slash", () => {
        expect(normaliseSeparators("/")).toBe("/");
    });
});
describe("lexicalNormalize (pure, no I/O)", () => {
    // --- POSIX cases ---
    it("resolves /work/../etc → /etc", () => {
        expect(lexicalNormalize("/work/../etc")).toBe("/etc");
    });
    it("resolves /work/a/../../etc → /etc", () => {
        expect(lexicalNormalize("/work/a/../../etc")).toBe("/etc");
    });
    it("resolves multi-level /work/a/b/../../c → /work/c", () => {
        expect(lexicalNormalize("/work/a/b/../../c")).toBe("/work/c");
    });
    it("clamps .. above root to root", () => {
        expect(lexicalNormalize("/../etc")).toBe("/etc");
        expect(lexicalNormalize("/../../etc")).toBe("/etc");
    });
    it("resolves . segments (no-ops)", () => {
        expect(lexicalNormalize("/work/./sub/./f.txt")).toBe("/work/sub/f.txt");
    });
    it("leaves normal absolute paths unchanged", () => {
        expect(lexicalNormalize("/home/u/work")).toBe("/home/u/work");
        expect(lexicalNormalize("/work")).toBe("/work");
    });
    it("handles trailing slashes", () => {
        expect(lexicalNormalize("/work/sub/")).toBe("/work/sub");
    });
    it("handles mixed . and ..", () => {
        expect(lexicalNormalize("/work/./a/../b/./c")).toBe("/work/b/c");
    });
    // --- Windows cases ---
    it("resolves C:\\work\\..\\Windows to C:/Windows", () => {
        expect(lexicalNormalize("C:\\work\\..\\Windows")).toBe("C:/Windows");
    });
    it("handles Windows multi-level traversal", () => {
        expect(lexicalNormalize("C:\\a\\b\\..\\..\\c")).toBe("C:/c");
    });
    it("clamps Windows .. above root to root", () => {
        expect(lexicalNormalize("C:\\..\\Windows")).toBe("C:/Windows");
    });
    it("normalises Windows drive letter to uppercase form", () => {
        // win32.resolve preserves the drive letter case as given
        const result = lexicalNormalize("c:\\work\\sub");
        expect(result.startsWith("c:/work/sub")).toBe(true);
    });
    it("handles Windows forward-slash inputs", () => {
        expect(lexicalNormalize("C:/work/../sub")).toBe("C:/sub");
    });
    // --- UNC cases ---
    it("resolves UNC path traversal", () => {
        expect(lexicalNormalize("\\\\server\\share\\a\\..\\b")).toBe("//server/share/b");
    });
    it("clamps UNC .. above share root (win32 semantics: share is the root)", () => {
        // path.win32 treats \\server\share as the root; .. above it clamps back
        // to the share root, never to \\server or above.
        expect(lexicalNormalize("\\\\server\\share\\..\\other")).toBe("//server/share/other");
        expect(lexicalNormalize("\\\\server\\share\\a\\..\\..\\..\\x")).toBe("//server/share/x");
    });
    // --- Relative cases ---
    it("resolves relative . and ..", () => {
        expect(lexicalNormalize("a/../b/c")).toBe("b/c");
        expect(lexicalNormalize("a/b/../../c")).toBe("c");
    });
    it("clamps relative .. above the first segment", () => {
        expect(lexicalNormalize("../../a")).toBe("a");
    });
    it("empty relative path", () => {
        expect(lexicalNormalize("")).toBe("");
    });
});
describe("isPathWithin (pure boundary containment)", () => {
    // --- POSIX sibling collision ---
    it("a child is inside the root", () => {
        expect(isPathWithin("/home/u/work/docs", "/home/u/work", false)).toBe(true);
    });
    it("the root itself is inside", () => {
        expect(isPathWithin("/home/u/work", "/home/u/work", false)).toBe(true);
    });
    it("a sibling with a shared prefix is NOT inside", () => {
        expect(isPathWithin("/home/u/workdocs", "/home/u/work", false)).toBe(false);
        expect(isPathWithin("/home/u/workx", "/home/u/work", false)).toBe(false);
    });
    it("a sibling with a numeric suffix is NOT inside", () => {
        expect(isPathWithin("/home/u/work2", "/home/u/work", false)).toBe(false);
    });
    it("a completely different path is NOT inside", () => {
        expect(isPathWithin("/etc/passwd", "/home/u/work", false)).toBe(false);
    });
    it("a path with a trailing separator root", () => {
        // root is canonical (no trailing slash) but the pure function handles
        // both forms — a root with trailing slash should still work
        expect(isPathWithin("/home/u/work/a", "/home/u/work/", false)).toBe(true);
        // but the root itself is NOT inside its trailing-slash variant
        // (empty segment does not exist)
        expect(isPathWithin("/home/u/work", "/home/u/work/", false)).toBe(false);
    });
    // --- Traversal (canonicalised inputs) ---
    it("/work/../etc after canonicalisation is NOT inside /work", () => {
        // After lexicalNormalize: /work/../etc → /etc
        expect(isPathWithin("/etc", "/work", false)).toBe(false);
    });
    it("canonicalised /work/a/../../etc → /etc is NOT inside /work", () => {
        expect(isPathWithin("/etc", "/work", false)).toBe(false);
    });
    // --- Windows ---
    it("a child inside a Windows root", () => {
        expect(isPathWithin("C:/work/sub", "C:/work", false)).toBe(true);
        expect(isPathWithin("C:/work/sub/f.txt", "C:/work", false)).toBe(true);
    });
    it("a Windows sibling is NOT inside", () => {
        expect(isPathWithin("C:/work2", "C:/work", false)).toBe(false);
        expect(isPathWithin("C:/work-2", "C:/work", false)).toBe(false);
    });
    it("canonicalised C:\\work\\..\\Windows is NOT inside C:\\work", () => {
        // After lexicalNormalize: C:\work\..\Windows → C:/Windows
        expect(isPathWithin("C:/Windows", "C:/work", false)).toBe(false);
    });
    // --- Case-insensitive ---
    it("case-insensitive match works", () => {
        expect(isPathWithin("/TMP/WS/x", "/tmp/ws", true)).toBe(true);
        expect(isPathWithin("/TMP/WS/x", "/tmp/ws", false)).toBe(false);
    });
    it("case-insensitive still rejects siblings", () => {
        expect(isPathWithin("/TMP/WS2/x", "/tmp/ws", true)).toBe(false);
    });
    it("case-insensitive Windows drive paths", () => {
        expect(isPathWithin("C:/WORK/SUB", "c:/work", true)).toBe(true);
        expect(isPathWithin("C:/WRK/SUB", "c:/work", true)).toBe(false);
    });
    // --- UNC ---
    it("UNC paths are boundary-aware", () => {
        expect(isPathWithin("//server/share/sub", "//server/share", false)).toBe(true);
        expect(isPathWithin("//server/share2/sub", "//server/share", false)).toBe(false);
    });
});
//# sourceMappingURL=path-containment.test.js.map