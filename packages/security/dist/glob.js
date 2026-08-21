/**
 * Gitignore-style glob matching used by permission rules and sandbox checks.
 * Supported: `**` (any segments, optional), `*` (within a segment), `?` (one char).
 * Patterns are matched against normalized `/`-separated paths.
 */
export function normalizePath(p) {
    return p.replace(/\\/g, "/");
}
export function globToRegex(pattern) {
    const p = normalizePath(pattern);
    const chars = p.split("");
    let re = "";
    for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        if (c === "*") {
            if (chars[i + 1] === "*") {
                i += 1;
                if (chars[i + 1] === "/") {
                    // `**/` may match zero segments (also matches plain filenames)
                    i += 1;
                    re += "(?:.*/)?";
                }
                else {
                    re += ".*";
                }
            }
            else {
                re += "[^/]*";
            }
        }
        else if (c === "?") {
            re += "[^/]";
        }
        else if (c === "/") {
            re += "/";
        }
        else if (/[.+^${}()|[\]\\]/.test(c)) {
            re += `\\${c}`;
        }
        else {
            re += c;
        }
    }
    return new RegExp(`^${re}$`);
}
export function matchGlob(pattern, target) {
    const t = normalizePath(target);
    if (globToRegex(pattern).test(t))
        return true;
    // A pattern with no directory separator may also match the basename.
    if (!normalizePath(pattern).includes("/")) {
        const base = t.split("/").pop() ?? t;
        return globToRegex(pattern).test(base);
    }
    return false;
}
//# sourceMappingURL=glob.js.map