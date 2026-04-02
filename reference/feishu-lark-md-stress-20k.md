## 飞书 lark_md 极限压力（约 20000 字符）

用于压测 `CARD_LARK_MD_LIMIT`（20000）附近：多围栏、多语言、列表、行内代码、链接、中英文混排。观察是否出现「内容过长，已截断」、卡片 patch 失败、或围栏未闭合导致后半段不渲染。

### 固定三联：JSON

```json
{
  "limits": { "text_chunk": 4000, "card_lark_md": 20000 },
  "flags": { "normalize_fences": true, "close_odd_fence": true }
}
```

### 固定三联：Python

```python
def stress(n: int) -> str:
    return ("x" * 16 + "\n") * n
```

### 固定三联：TypeScript

```typescript
const LIMIT = 20_000;
const hint = "_（内容过长，已截断）_";
```


### 批量段 0001

- **序号** 1：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0002

- **序号** 2：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0003

- **序号** 3：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0004

- **序号** 4：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0005

- **序号** 5：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0006

- **序号** 6：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0007

- **序号** 7：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0008

- **序号** 8：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0009

- **序号** 9：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0010

- **序号** 10：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0011

- **序号** 11：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0012

- **序号** 12：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0013

- **序号** 13：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0014

- **序号** 14：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0015

- **序号** 15：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0016

- **序号** 16：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0017

- **序号** 17：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0018

- **序号** 18：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0019

- **序号** 19：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0020

- **序号** 20：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0021

- **序号** 21：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0022

- **序号** 22：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0023

- **序号** 23：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0024

- **序号** 24：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0025

- **序号** 25：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0026

- **序号** 26：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0027

- **序号** 27：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0028

- **序号** 28：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0029

- **序号** 29：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0030

- **序号** 30：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0031

- **序号** 31：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0032

- **序号** 32：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0033

- **序号** 33：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0034

- **序号** 34：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0035

- **序号** 35：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0036

- **序号** 36：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0037

- **序号** 37：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0038

- **序号** 38：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0039

- **序号** 39：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0040

- **序号** 40：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0041

- **序号** 41：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0042

- **序号** 42：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0043

- **序号** 43：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0044

- **序号** 44：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0045

- **序号** 45：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0046

- **序号** 46：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0047

- **序号** 47：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0048

- **序号** 48：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0049

- **序号** 49：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0050

- **序号** 50：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0051

- **序号** 51：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0052

- **序号** 52：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0053

- **序号** 53：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0054

- **序号** 54：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0055

- **序号** 55：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0056

- **序号** 56：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0057

- **序号** 57：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0058

- **序号** 58：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0059

- **序号** 59：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0060

- **序号** 60：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0061

- **序号** 61：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0062

- **序号** 62：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0063

- **序号** 63：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0064

- **序号** 64：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0065

- **序号** 65：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0066

- **序号** 66：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0067

- **序号** 67：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0068

- **序号** 68：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0069

- **序号** 69：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0070

- **序号** 70：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0071

- **序号** 71：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0072

- **序号** 72：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0073

- **序号** 73：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0074

- **序号** 74：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0075

- **序号** 75：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0076

- **序号** 76：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 批量段 0077

- **序号** 77：检查此行之后列表与加粗是否仍正常。
- 行内：`splitTextChunks`、`normalizeCardMarkdown`、`CARD_LARK_MD_TRUNCATED_HINT`。
- 链接：`https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot` 占位。
- 说明：重复段落用于堆叠字符数；若在某序号后突然变为纯文本或样式丢失，请记录序号与客户端版本。


### 末尾哨兵

若你能读到这里，说明 **20000 字级** 内容在卡片中仍连续可读。请对比：普通文本消息分片、interactive 卡片单字段、以及机器人日志里是否报错。


····························································································································································································