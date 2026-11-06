import { promises as fs, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { canonicalizePath } from "./canonical-path.js";
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), "dangling-canonical-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const portable = (path: string) => path.replace(/\\/g, "/");
it.each(["file", "dir"] as const)("resolves an absent %s target before appending new segments", async kind => {
  const target = join(root, "new-target"), alias = join(root, "alias");
  await fs.symlink(target, alias, kind === "dir" && process.platform === "win32" ? "junction" : kind);
  const tail = kind === "dir" ? "/nested/code.ts" : "";
  expect(canonicalizePath(alias + tail, { cwd: root })).toBe(portable(realpathSync(root)) + "/new-target" + tail);
});
it("keeps filesystem meaning of a relative link through an existing parent alias", async () => {
  const outside = join(root, "outside"), sub = join(outside, "sub"), alias = join(root, "parent"); await fs.mkdir(sub, { recursive: true });
  await fs.symlink(sub, alias, process.platform === "win32" ? "junction" : "dir"); await fs.symlink("../new.ts", join(sub, "leaf"), "file");
  expect(canonicalizePath(join(alias, "leaf"), { cwd: root })).toBe(portable(realpathSync(outside)) + "/new.ts");
});
it.each([['EACCES', 'permission'], ['EPERM', 'permission'], ['EIO', 'io'], ['ELOOP', 'symlink_loop']] as const)("fails closed when readlink reports %s", (code, expected) => {
  const missing = () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
  expect(() => canonicalizePath(join(root, "new"), { cwd: root }, { realpath: missing, readlink: () => { throw Object.assign(new Error("blocked link inspection"), { code }); } })).toThrowError(expect.objectContaining({ code: expected }));
});
it("bounds symbolic-link expansion even if the resolver keeps returning missing targets", () => {
  let expansions = 0;
  expect(() => canonicalizePath(join(root, "new"), { cwd: root }, {
    realpath: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    readlink: path => { expansions++; return path + "x"; },
  })).toThrowError(expect.objectContaining({ code: "symlink_loop" }));
  expect(expansions).toBeLessThanOrEqual(41);
});
