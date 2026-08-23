// 修复 pnpm 在 Windows junction 下静默失败留下的空目录链接
// 用法: node fix-links.mjs
// 扫描 node_modules/.pnpm/<pkg>@<ver>/node_modules/ 下所有空目录，
// 若能在 .pnpm 找到同名真实包，则删除空目录并创建 junction 指向真实包。
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const pnpmDir = path.join(root, "node_modules", ".pnpm");

if (!fs.existsSync(pnpmDir)) {
  console.error("no .pnpm dir at", pnpmDir);
  process.exit(1);
}

// 收集 .pnpm 下所有真实包目录：name@version/node_modules/<name>
const realPackages = new Map(); // key: 包名 (含 scope)，value: 绝对路径
const entries = fs.readdirSync(pnpmDir);
for (const entry of entries) {
  const full = path.join(pnpmDir, entry);
  if (!fs.statSync(full).isDirectory()) continue;
  // entry 形如 vitest@4.1.10_xxx 或 @vitest+utils@4.1.10
  const nm = path.join(full, "node_modules");
  if (!fs.existsSync(nm)) continue;
  const scan = (dir, prefix) => {
    for (const child of fs.readdirSync(dir)) {
      const childPath = path.join(dir, child);
      let st;
      try { st = fs.lstatSync(childPath); } catch { continue; }
      if (st.isDirectory() && child.startsWith("@")) {
        scan(childPath, prefix ? `${prefix}/${child}` : child);
      } else if (st.isDirectory()) {
        const name = prefix ? `${prefix}/${child}` : child;
        // 优先保留内容非空的目录：空目录可能是链接失败的占位，不能作为真实包
        const existing = realPackages.get(name);
        if (existing === undefined) {
          realPackages.set(name, childPath);
        } else {
          let existingNonEmpty = false;
          try { existingNonEmpty = fs.readdirSync(existing).length > 0; } catch { existingNonEmpty = false; }
          const curNonEmpty = fs.readdirSync(childPath).length > 0;
          if (!existingNonEmpty && curNonEmpty) realPackages.set(name, childPath);
        }
      }
    }
  };
  scan(nm, "");
}

console.log(`real packages indexed: ${realPackages.size}`);

let fixed = 0;
let skipped = 0;
for (const entry of entries) {
  const pkgRoot = path.join(pnpmDir, entry);
  const nm = path.join(pkgRoot, "node_modules");
  if (!fs.existsSync(nm)) continue;
  const walk = (dir, prefix) => {
    for (const child of fs.readdirSync(dir)) {
      const childPath = path.join(dir, child);
      let st;
      try { st = fs.lstatSync(childPath); } catch { continue; }
      if (st.isSymbolicLink()) continue; // 已是链接
      if (!st.isDirectory()) continue;
      if (child.startsWith("@")) { walk(childPath, prefix ? `${prefix}/${child}` : child); continue; }
      const name = prefix ? `${prefix}/${child}` : child;
      // 判断是否"空目录": 目录内没有 package.json 且没有 dist 等常见内容
      const items = fs.readdirSync(childPath);
      const looksEmpty = items.length === 0 ||
        (items.length <= 1 && !items.includes("package.json"));
      if (!looksEmpty) continue;
      const target = realPackages.get(name);
      if (!target) { skipped++; continue; }
      // 目标内容必须非空
      let targetItems;
      try { targetItems = fs.readdirSync(target); } catch { continue; }
      if (targetItems.length === 0) { skipped++; continue; }
      try {
        fs.rmSync(childPath, { recursive: true, force: true });
        fs.symlinkSync(target + path.sep, childPath, "junction");
        console.log(`FIXED: ${childPath} -> ${target}`);
        fixed++;
      } catch (e) {
        console.log(`FAIL: ${childPath} (${e.code ?? e.message})`);
        skipped++;
      }
    }
  };
  walk(nm, "");
}

console.log(`done: fixed=${fixed}, skipped=${skipped}`);
