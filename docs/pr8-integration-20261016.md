# PR #8 修正与集成

用户授权先关闭审查问题，确认可用后合并，再继续coding优化。基线main95a27dfd，
原PR head4375388a，原审查候选fe3adf06及[原报告](pr8-review-20261016.md)保留。

R1：生产SessionService不再从首个收到的事件推导sourceBaseline，完整日志保持
严格0基线。Owner读取retired日志时，检查权威前缀长度、原生session身份、连续
序号和重复id；缺失、改写、增长都明确返回session/alias-corrupt，不暴露live
后缀或重新编号。显式投影基线仍只用于独立声明的有界范围，不用于生产完整日志。

R2：队列admissionBarrier是事件序号，改为按序号过滤，而非数组slice索引。
生产未独立证明的非零完整日志在投影前失败关闭，因此不再提前发布未绑定消息。
另补显式范围的MAX_SAFE_INTEGER边界，避免合法baseline加index后溢出。

验收：旧PR的配置固定读取fe3adf06的三个产品文件（session/projections/owners），
仍为3项预期失败、2项健康通过；原main对照也固定owners，避免新guard改变历史
反例形状。默认回归新增8项，覆盖六种前缀故障、普通会话非法偏移、健康分页与
native游标逆映射；原队列屏障/控制流/重启用例保留。Web226、安全2146已通过。
实现阶段结果和字节哈希归档见[证据](evidence/pr8-fix-20261016/validation.json)。
类型、固定clean源码全仓与最终远端CI结果按实际完成状态记录，不以旧PR的历史
checks或main95a的成功代替本候选。

原PR所说的“有retired就应从offset开始”不成立：健康拼接日志仍从0开始。
本次合并范围是修复日志完整性与队列坐标，不宣称已经复现/恢复用户原始丢失
历史，也不把损坏状态的明确拒绝称为浏览器现场问题已根治。旧现场文档为历史
诊断记录，其“修复未实施”等描述保持时间绑定，以本报告说明本次实际行为。
没有付费调用或release；所有实际工具操作仍走现有权限/沙箱/Orchestrator。
