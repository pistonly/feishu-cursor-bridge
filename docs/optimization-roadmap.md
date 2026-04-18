# Optimization Roadmap

记录日期：2026-04-18

本文件用于长期跟踪 `feishu-cursor-bridge` 的优化事项。与会话内 todo 不同，这份清单已落盘，适合作为后续多次迭代、跨会话持续推进的任务基线。

## 优先级与执行阶段

### P0：命令 / backend 元数据收口

目标：减少 parser、help、card、README、详细文档之间的漂移，降低后续新增命令或 alias 时的维护成本。

- [ ] 盘点所有 command、backend、alias、help/doc 定义来源
- [ ] 设计 commands/backends 的统一 metadata registry
- [ ] 让 help 文案、welcome card、backend shortcut 展示复用共享 metadata
- [ ] 同步 README 与 `docs/feishu-commands.md`，避免命令列表继续漂移
- [ ] 增加回归测试，保证 parser / help / cards / docs 的一致性

### P1：prompt 执行状态与排队逻辑抽离

目标：把 active / queued prompt 的状态机从 `Bridge` 中抽出，降低耦合和回归风险。

- [ ] 抽取 active / queued prompt 状态为独立 coordinator
- [ ] 明确定义 `start` / `enqueueOrReplace` / `cancel` / `finish` 等接口
- [ ] 重构 bridge 测试，避免通过 `(bridge as any)` 直接修改私有状态
- [ ] 用行为测试覆盖排队替换、取消、slot 隔离等关键语义

### P2：卡片渲染热路径优化

目标：减少长回复、工具密集型会话中的重复 markdown 重建和卡片更新开销。

- [ ] 对长回复 / 多工具场景做渲染路径 profiling
- [ ] 将正文内容刷新与 status-only 刷新拆开
- [ ] 为 rendered sections / markdown chunks 增加缓存，减少重复构建
- [ ] 尽量避免仅 footer/status 变化时重算整张卡片

### P3：展示层格式化逻辑收口

目标：统一数字、百分比、模型、context usage 等展示格式，减少重复实现和输出漂移。

- [ ] 合并共享的 number / percent / model / usage formatting helpers
- [ ] 让 `/status`、卡片状态栏、模型/模式提示复用同一套展示工具
- [ ] 为关键格式化输出补充小而稳定的单测

### P4：脚本与工具链整理

目标：减少 shell 脚本中的重复 `.env` 解析逻辑，提高脚本可维护性和跨环境稳定性。

- [ ] 统一 `service.sh` 与 `scripts/bridge-dev.sh` 中的 `.env` 解析与路径展开逻辑
- [ ] 尽量把复杂配置解析下沉到 Node/TS helper，而不是 Bash 文本处理
- [ ] 替换当前较重的 shell test discovery 方式，改为更易维护的 test runner 入口
- [ ] 在每个优化批次后重新跑 typecheck 与定向回归测试

## 推荐执行顺序

1. P0：命令 / backend metadata 收口
2. P1：prompt 状态与队列逻辑抽离
3. P2：卡片渲染热路径优化
4. P3：格式化逻辑收口
5. P4：脚本与工具链整理

## 完成标准

每个阶段完成时，至少满足：

- [ ] 相关代码改动已落地
- [ ] 相关回归测试已补齐或更新
- [ ] `npm run typecheck` 通过
- [ ] 受影响的文档已同步
- [ ] 若涉及飞书卡片/UI 表现，已验证关键路径行为
