# 历史 Vendor 方案

这里归档了已停用的官方组件搬运方案：`lib/vendor/` 产物、旧构建入口、适配层、一次性迁移脚本与浏览器研究测试。它们不进入发布包，也不属于当前测试或构建流程。

文件保留原有目录结构与内容，其中的路径和接口属于历史版本。不要在当前工作区执行这些脚本；需要复现时，请使用对应历史提交。

当前入口：

- 前端源码：[`tools/machine-client.tsx`](../../tools/machine-client.tsx)。
- 构建与自动测试：`npm run build`、`npm test`。
- 真实 DSH 双实例验证：`npm run test:native`。
- 历史过程记录：[`VENDOR-PLAN.md`](../VENDOR-PLAN.md)。

上游 DeepSeek Harness 的许可证保留在 [`vendor/LICENSE.deepseek-harness`](../../vendor/LICENSE.deepseek-harness)。
