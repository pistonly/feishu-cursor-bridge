# TODO: Legacy Streaming Timeout Validation

目标：确认 `cursor-legacy` 的流式超时已经从“固定总时长超时”改为“空闲超时”。

## Pending

- [ ] 确认流式请求在持续收到输出时，不会因为总耗时超过 `--timeout` 而被中断
- [ ] 确认流式请求只有在连续空闲超过 `--timeout` 后才超时
- [ ] 确认超时时间接近“最后一次输出时间 + timeout”，而不是“请求开始时间 + timeout”
- [ ] 确认 timeout 错误不再被误判为 authentication / `cursor-agent login`
- [ ] 确认飞书里的超时提示文案会跟随 legacy adapter 的 `--timeout` 配置变化
- [ ] 用一次真实 `cursor-agent` 慢任务保留验证证据：配置、步骤、时间点、日志摘要

## Suggested Evidence

- `T0`: 发起请求时间
- `T1`: 第一条流式输出时间
- `Tlast`: 最后一条流式输出时间
- `Ttimeout`: 超时发生时间

判定规则：

- 若 `Ttimeout` 接近 `T0 + timeout`，说明仍是固定总时长超时
- 若 `Ttimeout` 接近 `Tlast + timeout`，说明空闲超时生效

## Reference

- 实验方案见 [docs/timeout-validation.md](/home/liuyang/Documents/feishu-bridge/feishu-cursor-bridge/docs/timeout-validation.md)
