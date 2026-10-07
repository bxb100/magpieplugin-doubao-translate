# opencode-doubao-translate-auth

magpie 插件：把豆包网页翻译接口（`/samantha/plugin/stream_article_translate`，SSE）包装成 LLM API，支持流式和非流式。

- 登录：`magpie plugin login doubao-translate`，粘贴 doubao.com Cookie 里 `sessionid` 的值即可（也可以写成 `sessionid=…`，或粘贴整段 Cookie），保存在 `~/.config/magpie/plugin-auth.json`（权限 600）。
  - 豆包只认会话 token：`sessionid`、`sessionid_ss`、`sid_tt` 任意一个就够（三者同值）；`uid_tt`、`uid_tt_ss` 不需要，单独带它们会返回“登录已过期”。
  - 不含 `=` 的输入按 `sessionid` 的值处理；含 `=` 的按完整 Cookie 原样发送。
  - token 失效时插件返回 401，magpie 会把账号标记为需要重新登录。
- 模型：`doubao-translate/doubao`（豆包 AI）、`doubao-translate/volc`（火山引擎）、`doubao-translate/microsoft`（微软）。
- 输入：最后一条 user 消息必须是 `{"to":"zh-CN","texts":["…"],"batch":true}`。这三个引擎只做翻译、不理解提示词，带提示词（有 system 消息）却不是这个 JSON 的请求会返回 400。KISS 里用下面的 Request Hook 生成它：

  ```js
  async (args, req) => {
    req.body.messages = [{
      role: "user",
      content: JSON.stringify({ to: args.toLang, texts: args.texts, batch: args.useBatchFetch !== false }),
    }];
    return req;
  }
  ```
- 输出：批量时 content 为 `{"translations":[{"id":0,"text":"…","sourceLanguage":"en"}]}`，`batch:false` 时为译文本身。
- 标记保护：译文丢失或改坏了原文里的标签（`<i1>…</i1>`、`<i i=1>`）、占位符（`{1}`、`[[1]]`）或多出 emoji 时，这些段落会依次换豆包 AI → 微软 → 火山重译，直到标记完整；都不行时保留首次译文。
- 协议：按请求路径后缀选择，`…/chat/completions` → OpenAI Chat Completions，`…/responses` → OpenAI Responses，`…/messages` → Anthropic Messages。magpie 按模型的 `npm` 决定调用哪个（默认 `@ai-sdk/openai-compatible`，即 Chat Completions），客户端用其他协议时由 magpie 网关转换。要让插件直接收某种协议，可在 `~/.config/magpie/plugins.json` 的 `config.provider["doubao-translate"].models.<id>` 上写 `"provider": {"npm": "@ai-sdk/anthropic"}`（或 `@ai-sdk/openai`）。
