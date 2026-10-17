# 语言验收时序修正

原 main 61ef8e20 的 Windows 安装 UI 成功，Ubuntu 第一个语言用例过早读取 lang，
其余用例继承中文后连续失败，最终总时限失败。original-ci-partial.json.gz 是
原失败 artifact 的有界只读投影，原检查数/失败没有改写。原 run 39005879731，
精确源码 61ef8e2030c40e81a1b768a741d5b63626edbab3。受现有网络策略限制
无法读取 artifact 下载重定向，使用仓库已有诊断 workflow，在独立分支固定
2785eaff35674426c448a6d0377595c0588c4e5c；run 39006967102 只读取上述原件，
没有重新执行应用或验收，不能替代验收结论。

原本地单例在真实 350ms TCP 延迟下通过，但其退出时持久化仍为 zh，说明页面
英文不能证明请求已提交。仅等 DOM 的候选在桌面通过、随后两视口 boot 失败；
该失败保留。增加对拥有的 fixture 的 settings.json 只读等待，再实际 reload
检查英文：三视口均通过。最终仓库脚本再次三视口通过，保留 9 项原严格检查，
并增加实际双向延迟和持久化/刷新条件；没有增加总超时、跳过或修改产品。

完整 suite 固定 clean 产品 4e651587：9874 PASS /15 SKIP /0 FAIL，详见
../title-final/full.json。完整 suite 完成后才编辑本验收脚本；后续新归档仍需
完整 30+42 场景、连接恢复与精确 main CI。所有调用限本地 loopback provider。
