# 默认工作区环境加入后的原验收合同

bb1d93bc 的第一次完整本地验收为10281通过、8失败、16原有跳过，未推送main。完整原始结果与专项失败日志保留于 /tmp/harness-v113-workspace-final-20261025，摘要及指纹见 rejected-full-bb1.json。

PR15两项用例把无模式system内容写死为 Base policy.。新默认环境必须存在；改为切模式前的完整system基线，精确比较关闭模式和另一会话的结果，并新增基线cwd断言。没有把精确相等改成仅contains，也没有改500-token上限、goal数据隔离或冻结policy断言。

六项rehydration用例以旧130-token主系统构造165/170-token合成窗口，并把used写死为147/158/130。新增必需环境后，基准系统成本改变。现在从真实生产context adapter校准这部分精确增量，只为这些相对余量夹具补入同样增量；原35/40-token空位、Refs选择临界点、active user和输出预留均不变，实际请求仍受各自配置上限检查。129-token绝对硬溢出用例不补预算，继续在0次模型调用时失败；其used断言只补实际渲染框架中的环境成本，保留精确数值检查。

生产预算、默认模型窗口、Runtime/Core、Contracts、权限和验证器均没有更改。全部34项PR15/rehydration以及typecheck通过；之后重新固定最终候选并做全量与双平台CI。失败没有跳过、删除或伪装为完整通过。
