# 本轮精选便携原始证据

[主报告](../source-optimization-20261002.md) 与 [machine-readable 验收记录](../source-optimization-20261002.json) 说明验收范围；[index.json](index.json) 保存每个文件的原始路径、字节数和复制前后 SHA-256。所选 manifest/log 是逐字节原样复制，不修改其中历史工作树路径、HEAD、缺失相对文件引用或中间失败说明。

各目录对应 R1、R2、R3、R4、R5、R6、S1、S2。历史 package manifest 的 source 指纹只证明当时测试的工作树；最终干净工作树和全量结果由主报告/主 JSON 的冻结验收部分提供，当前 Linux 冻结快照已 PASS，Windows 与最终发布按主报告中的真实状态记录。

本目录的局部 `.gitignore` 仅允许这些精选日志被提交，项目其他日志的忽略规则不变。

局部 `.gitattributes` 保持原始日志 bytes，避免 Windows autocrlf 改写指纹；Vitest 输出的结尾空行作为原始证据保留。

大体积 paired/offline JSON 和 debug/intermediate 日志保留于原 evidence root，不包含在这份精选目录中。external artifact 的 SHA 和概要在对应 package manifest 与主 JSON 中，不能据此声称完整原始请求已便携保存。旧研究证据位于另一个 JSON，未被本轮材料覆盖。

核对已复制文件：在仓库根目录执行以下标准库脚本。

```bash
python3 - <<'PY'
import hashlib, json
from pathlib import Path
root = Path('.')
index = json.loads((root / 'docs/evidence/source-optimization-20261002/index.json').read_text())
for item in index['files']:
    payload = (root / item['path']).read_bytes()
    digest = hashlib.sha256(payload).hexdigest()
    assert digest == item['sha256BeforeCopy'] == item['sha256AfterCopy'], item['path']
    assert len(payload) == item['bytes'], item['path']
print(f"verified {len(index['files'])} copied artifacts")
PY
```

这是文件完整性核对，不运行测试，也不把 PENDING 升为 PASS。

Linux 全量可使用本目录保存的 supervisor：

```bash
python3 docs/evidence/source-optimization-20261002/final/run-with-subreaper.py corepack pnpm test
```

它处理本环境的孤儿子进程回收，不改变 Vitest 的测试选择或结果。
