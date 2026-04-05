# 第三方与溯源

## `cursor-agent-acp/`

本目录下的实现**最初参考**社区项目 [@blowmage/cursor-agent-acp](https://www.npmjs.com/package/@blowmage/cursor-agent-acp) 的思路与代码形态，已在当前仓库中**内嵌维护并自行演进**。

- **不承诺**与上述 npm 包或其上游仓库保持行为一致或持续同步。
- 桥接侧通过 `ACP_BACKEND=legacy` 启动的是**本仓库**内的 `cursor-agent-acp/`，而非要求从 npm 安装该包。

如需了解原始项目的发布与用法，请直接查阅其官方文档；本文档仅作历史来源说明。
