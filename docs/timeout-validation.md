# Timeout Validation

用于验证 `cursor-legacy` 流式请求的超时语义是否正确。

## Goal

确认当前行为是：

- 流式请求启动后开始计时
- 只要持续收到输出，timeout 会不断刷新
- 只有连续空闲超过配置的 `--timeout` 时才触发超时

而不是：

- 从请求开始后经过固定总时长就直接超时

## Recommended Config

为了便于观察，建议把 legacy timeout 调小到一个容易人工判断的值，例如：

```bash
CURSOR_LEGACY_EXTRA_ARGS="--timeout 10000 --log-level debug"
```

如果你需要更明显的时间窗口，可以改成 `15000` 或 `20000`。

## Experiment 1: Continuous Output

目标：确认持续有流式输出时不会超时。

建议步骤：

1. 启动 bridge，确保当前 backend 为 `cursor-legacy`
2. 使用较短 timeout，例如 `10000ms`
3. 发送一个会持续产生输出的任务，最好能跨过多个 timeout 窗口

可用 prompt 示例：

- “请分 20 步分析这个仓库，每一步先输出一句观察，再继续下一步。”
- “递归扫描 `src/`，逐文件总结用途，每个文件单独输出一行。”

预期结果：

- 总耗时可以明显超过 `--timeout`
- 只要中间一直有 chunk 到达，就不应触发 timeout
- 最终若失败，也不应是 `Streaming command timed out`

## Experiment 2: Idle Timeout

目标：确认超时发生在“最后一次输出之后”，而不是“请求启动之后”。

建议步骤：

1. 保持较短 timeout，例如 `10000ms`
2. 构造一个先有输出、后停住的 case
3. 记录最后一次输出时间与最终 timeout 时间

推荐记录：

- `T0`: 请求发起时间
- `T1`: 第一条输出时间
- `Tlast`: 最后一条输出时间
- `Ttimeout`: 超时发生时间

判定方式：

- 若 `Ttimeout` 更接近 `T0 + timeout`，说明实现仍偏向固定总时长超时
- 若 `Ttimeout` 更接近 `Tlast + timeout`，说明空闲超时正确

## Experiment 3: Error Classification

目标：确认 timeout 不再误报成 authentication。

检查项：

- 超时后不应提示用户优先执行 `cursor-agent login`
- ACP stop reason detail 应为 `timeout`
- 飞书提示应明确说明是 Cursor CLI timeout

## Experiment 4: Timeout Hint Text

目标：确认飞书提示与实际 `--timeout` 配置一致。

建议分别验证：

- `--timeout 45000`
- `--timeout 120000`

预期结果：

- 45 秒配置对应“约 45 秒”
- 120 秒配置对应“约 120 秒”

## Minimal Evidence Template

实验完成后，建议把结果追加到这个文档底部，至少包含：

```md
## Result YYYY-MM-DD

- Config:
- Prompt:
- T0:
- T1:
- Tlast:
- Ttimeout:
- Observed behavior:
- Conclusion:
```
