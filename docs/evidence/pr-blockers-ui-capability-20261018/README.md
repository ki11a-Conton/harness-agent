# main 能力说明验收修正

原始 main `e39fc6129bdf8998f6f1eeb18a2ca651ac38ba2c` 的 UI 安装运行 39096821251/job 117585051194 保留失败，另三工作流首次成功。ci-original 保存四工作流和所有 job 原件，不把失败写成全绿。

产品编译源码仍为 `e39fc6129bdf8998f6f1eeb18a2ca651ac38ba2c`，仅浏览器驱动修改：SHA-256 `bb9061de6eb96e5bac7face90e14896bc02ea29e30bc682ddeea8b2f68cac413`。这些本地浏览器实验在尚未提交的修正驱动上执行，不声称整个工作树 clean；结果中分别绑定产品编译摘要和准确驱动哈希。最终新 main 的 clean 安装验收必须另看精确 SHA 四工作流。

- ui-capability-red：350ms 单向真实 TCP 字节延迟，原 body 断言确定性失败。
- ui-capability-green：只等待可见说明，但不收窄屏导航，desktop/mobile 通过、narrow 失败。
- ui-capability-layout-probe：原生浏览器实测说明元素 x=304px、width=0px、height=220px；RPC 成功，侧栏仍打开。对应精确探针源码保存在 local。
- ui-capability-visible-green：真实按钮收起导航，并等待可见 role=status；3 尺寸、9 检查通过。
- ui-capability-full：42 场景、117 检查全部通过，无真实 provider 付费请求、无 RPC 响应替换。19 项现有 Node 导航/连接/延迟回归通过。

截图与逐场景记录保留；JSON/log/mjs 用确定性 gzip，PNG 原字节保存。copy-map 记录归档和原件双哈希；SHA256SUMS 覆盖目录中除自身的全部文件。未修改 Runtime、产品前端/后端能力或权限策略。
