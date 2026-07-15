# opencode-agentrouter-billing-filter

> OpenCode 插件：过滤 AgentRouter SSE 流末尾的非标准 `billing.summary` 消息，修复 `@ai-sdk/openai-compatible` 的 `Type validation failed` 报错。

## 背景

[AgentRouter](https://agentrouter.org) 在 SSE（Server-Sent Events）流结束前会发送一条非标准消息：

```
data: {"billing":{...},"object":"billing.summary"}
```

而 [`@ai-sdk/openai-compatible`](https://github.com/vercel/ai) 的 Zod 校验器对每条 SSE 消息做严格校验，只接受两种格式：

- `{ choices: [...] }` — 正常响应
- `{ error: {...} }` — 错误响应

`billing.summary` 不符合这两种格式，导致 OpenCode 在 AgentRouter 上运行时抛出 `Type validation failed`，流被中断。该问题与 [openai-compatible Issue #2784](https://github.com/vercel/ai/issues/2784) 中 `data: null` 的 bug 同源。

## 工作原理

本插件在 **fetch 层** 拦截对 `agentrouter.org`（及其子域）的请求，当响应为 `text/event-stream` 时，对流做逐行处理：

- 过滤 `data: null`（兼容 Issue #2784）
- 过滤包含 `"object":"billing.summary"` 的行
- 过滤包含 `"billing"` 字段的 `data:` 行

过滤后的流再交给 AI SDK 解析，从而绕过 Zod 校验失败的问题。

实现要点：

- **流式处理**：使用 `TextDecoder` / `TextEncoder` + `ReadableStream`，逐 chunk 读取并按 `\n` 切分，保留最后一个可能不完整的片段（`carry`）到下一次拼接，避免在数据包边界处截断消息。
- **幂等注入**：通过 `globalThis.__agentrouter_billing_filter_patched__` 标记，保证 `fetch` 只被 patch 一次。
- **非侵入**：只对 `agentrouter.org` 生效，其它 host 的请求原样透传。
- **错误兜底**：patch 或过滤流程中的任何异常都会回退到原始 `fetch`，不会阻断请求。

## 安装

### 1. 放置插件文件

将 `agentrouter-billing-filter.js` 放到 OpenCode 配置目录下的 `plugins/` 中，例如：

```
~/.config/opencode/plugins/agentrouter-billing-filter.js
```

Windows 下为：

```
C:\Users\<你的用户名>\.config\opencode\plugins\agentrouter-billing-filter.js
```

### 2. 在 `opencode.json` 中启用插件

在 `~/.config/opencode/opencode.json`（或项目级 `.opencode/opencode.json`）中添加：

```json
{
  "plugins": {
    "agentrouter-billing-filter": {
      "path": "~/.config/opencode/plugins/agentrouter-billing-filter.js"
    }
  }
}
```

> Windows 下请使用绝对路径，例如 `C:\\Users\\Administrator\\.config\\opencode\\plugins\\agentrouter-billing-filter.js`（注意 JSON 中反斜杠需转义）。

### 3. 重启 OpenCode

**必须彻底退出 OpenCode 进程**（确保进程完全终止，而非仅关闭窗口），然后重新启动：

```powershell
opencode
```

启动后日志中应能看到：

```
AgentRouter billing SSE filter installed
```

## 验证

1. 启动 OpenCode，使用 AgentRouter 作为模型提供商进行一次对话。
2. 观察是否仍出现 `Type validation failed` 报错。
3. 若流式响应能完整接收、不再中断，则过滤生效。

## 兼容性

- 适用于所有通过 `@ai-sdk/openai-compatible` 调用 AgentRouter 的场景。
- 不影响其它提供商（OpenAI、DeepSeek、Moonshot 等）的请求。
- 仅依赖运行时的 `fetch`、`TextDecoder`、`TextEncoder`、`ReadableStream`，无外部依赖。

## 文件

- `agentrouter-billing-filter.js` — 插件主文件

## 已知限制

- 过滤逻辑通过字符串匹配 `"billing"` 判断，理论上若 AgentRouter 未来在正常响应的 `data:` 行中也出现 `"billing"` 字段，可能被误过滤。当前 AgentRouter 的正常响应不会出现该字段，可安全使用。
- 仅处理 SSE 流（`text/event-stream`），不影响非流式 JSON 响应。

## License

MIT
