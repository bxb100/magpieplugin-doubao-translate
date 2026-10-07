// magpie 插件：把豆包网页翻译接口（SSE）包装成 LLM API，按请求路径选择协议：
//   …/chat/completions → OpenAI Chat Completions
//   …/responses        → OpenAI Responses
//   …/messages         → Anthropic Messages
// magpie 只会按模型 npm 对应的协议调用插件（默认 @ai-sdk/openai-compatible，即 Chat Completions），
// 换成 @ai-sdk/openai 或 @ai-sdk/anthropic 时插件同样能应答。
//
// 豆包/火山/微软都是纯翻译引擎，不理解提示词，所以输入只接受结构化 JSON：
//   最后一条 user 消息为 {"to":"zh-CN","texts":["Hello","World"],"batch":true}
//   （由 KISS 的 request hook 生成；也接受 segments:[{id,text}]、target_lang、toLang 等别名）
// 没有系统提示词的普通文本（如 magpie provider test）按一条原文翻成中文；
// 其余带提示词的请求直接报错，避免把提示词本身当原文翻译。
// 输出文本：
//   批量时为 {"translations":[{"id":0,"text":"你好","sourceLanguage":"en"}]}
//   单条时就是译文本身
// 模型：doubao（豆包 AI）、volc（火山引擎）、microsoft（微软）

const PROVIDER = "doubao-translate"
const BASE = "https://www.doubao.com/samantha/plugin"
const UPSTREAM = `${BASE}/stream_article_translate`
const SERVICES = { doubao: "1", volc: "0", microsoft: "3" }
const MAX_TEXTS = 100

const LANG_NAMES = {
  chinese: "zh", "simplified chinese": "zh", "traditional chinese": "zh", 中文: "zh", 简体中文: "zh", 繁體中文: "zh",
  english: "en", 英语: "en", japanese: "ja", 日语: "ja", korean: "ko", 韩语: "ko",
  french: "fr", 法语: "fr", german: "de", 德语: "de", spanish: "es", 西班牙语: "es",
  russian: "ru", 俄语: "ru", portuguese: "pt", 葡萄牙语: "pt", italian: "it", 意大利语: "it",
  arabic: "ar", thai: "th", vietnamese: "vi", indonesian: "id", malay: "ms", turkish: "tr",
  dutch: "nl", polish: "pl", ukrainian: "uk", hindi: "hi",
}

const model = (name) => ({ name, limit: { context: 64000, output: 64000 }, tool_call: false })

export const DoubaoTranslatePlugin = async () => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: "豆包翻译",
      npm: "@ai-sdk/openai-compatible",
      api: BASE,
      models: {
        doubao: model("豆包 AI 翻译"),
        volc: model("火山引擎翻译"),
        microsoft: model("微软翻译"),
      },
    }
  },

  auth: {
    provider: PROVIDER,
    methods: [{ type: "api", label: "豆包 sessionid", placeholder: "sessionid 的值，或 sessionid=…" }],
    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api") return {}
      const cookie = toCookie(auth.key)
      return { baseURL: BASE, fetch: (input, init) => handleRequest(cookie, input, init) }
    },
  },
})

// 豆包只认会话 token：sessionid、sessionid_ss、sid_tt 任意一个即可（三者同值），uid_tt 等其他字段不需要。
// 登录时可以只粘贴 token 本身（不含 "="），这里补成 sessionid=…；含 "=" 的视为完整 Cookie 原样使用。
function toCookie(key) {
  const value = String(key ?? "").trim()
  return value.includes("=") ? value : `sessionid=${value}`
}

// ---------- 请求处理 ----------

async function handleRequest(cookie, input, init = {}) {
  const proto = protocolOf(input)
  if (!proto) return errorResponse(chat, 404, `不支持的接口路径：${urlOf(input)}`)

  let req
  try {
    req = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body))
  } catch {
    return errorResponse(proto, 400, "请求体不是合法 JSON")
  }

  const { text, hasSystem, stream } = proto.read(req)
  const job = parseJob(text, hasSystem)
  if (!job) {
    return errorResponse(proto, 400, '无法识别输入：请把最后一条 user 消息改成 {"to","texts","batch"} JSON（KISS 用 Request Hook），见插件 README')
  }
  if (!job.texts.length) return errorResponse(proto, 400, "没有找到待翻译文本")
  if (job.texts.length > MAX_TEXTS) return errorResponse(proto, 400, `一次最多 ${MAX_TEXTS} 段，收到 ${job.texts.length} 段`)

  const modelId = String(req.model || "doubao").split("/").pop()
  const service = SERVICES[modelId] ?? "1"
  let up
  try {
    up = await callDoubao(cookie, job.texts, job.to, service, init.signal)
  } catch (err) {
    if (err?.name === "AbortError") throw err
    return errorResponse(proto, 502, `连接豆包失败：${err?.message || err}`)
  }

  // 参数错误、未登录等情况豆包返回 HTTP 200 + JSON
  if (!isEventStream(up)) {
    const text = await up.text()
    let data
    try { data = JSON.parse(text) } catch { return errorResponse(proto, 502, `豆包返回了无法识别的内容：${text.slice(0, 200)}`) }
    if (data.code === 710012001) return errorResponse(proto, 401, `豆包登录已失效：${data.msg}`, { "X-Magpie-Sign-In": "expired" })
    return errorResponse(proto, 400, `豆包错误 ${data.code}: ${data.msg ?? text}`)
  }

  const meta = { uid: crypto.randomUUID().replaceAll("-", ""), created: Math.floor(Date.now() / 1000), model: req.model }
  const items = withMarkupFallback(doubaoItems(up.body), { cookie, job, service, signal: init.signal })
  return stream ? streamResponse(proto, items, job, meta) : await jsonResponse(proto, items, job, meta)
}

function callDoubao(cookie, texts, to, service, signal) {
  return fetch(UPSTREAM, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ raw_text: texts, target_lang: to, translate_service: service, scene: 1, frontend_source: 1 }),
    signal,
  })
}

const isEventStream = (res) => (res.headers.get("content-type") || "").includes("event-stream")

// 译文必须保留原文里的标签和占位符（KISS 富文本的 <i1>…</i1>、<i i=1>、{1}、[[1]] 等），
// 否则 KISS 还原 HTML 时会错位；也不应凭空多出 emoji。
// 火山引擎实测会丢掉开标签、把 <i i=1> 改成 <i=1>、把 "react" 换成 😍。
const MARKUP = /<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?>|\{\{?\d+\}\}?|\[\[?\d+\]\]?|\p{Extended_Pictographic}/gu
const markupOf = (s) => (String(s ?? "").match(MARKUP) ?? []).map((m) => m.replace(/\s+/g, " ")).sort().join("\u0000")
const sameMarkup = (src, out) => markupOf(src) === markupOf(out)

// 译文弄坏了标签、占位符或多出 emoji 的段落，依次换其他引擎重译（豆包 AI → 微软 → 火山），
// 直到标记完整。实测豆包 AI 译日语时会和火山一样把 <i1> 写成 <i 1>，微软则保持完整。
// 所有引擎都不行或重译出错时保留首次译文，不让整批失败。
const FALLBACK_ORDER = ["1", "3", "0"]

async function* withMarkupFallback(items, { cookie, job, service, signal }) {
  let broken = []
  for await (const it of items) {
    if (sameMarkup(job.texts[it.index], it.res)) yield it
    else broken.push(it)
  }

  for (const next of FALLBACK_ORDER.filter((s) => s !== service)) {
    if (!broken.length) return
    const redo = new Map()
    try {
      const up = await callDoubao(cookie, broken.map((it) => job.texts[it.index]), job.to, next, signal)
      if (isEventStream(up)) for await (const it of doubaoItems(up.body)) redo.set(it.index, it)
    } catch (err) {
      if (err?.name === "AbortError") throw err
    }
    const still = []
    for (const [k, it] of broken.entries()) {
      const fixed = redo.get(k)
      if (fixed && sameMarkup(job.texts[it.index], fixed.res)) yield { ...fixed, index: it.index }
      else still.push(it)
    }
    broken = still
  }
  yield* broken
}

// 取最后一条 user 消息的文本；content 可以是字符串或 [{type:"text"|"input_text", text}] 片段
function lastUserText(messages = []) {
  const msg = [...messages].reverse().find((m) => m?.role === "user")
  return textOf(msg?.content)
}

function textOf(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("")
  return ""
}

function normLang(lang) {
  if (!lang) return "zh"
  const s = String(lang).trim()
  if (/^[a-z]{2}([-_][a-z0-9]+)*$/i.test(s)) return s.split(/[-_]/)[0].toLowerCase()
  return LANG_NAMES[s.toLowerCase()] ?? "zh"
}

// 解析出 { texts, to, batch }；无法可靠拆出原文时返回 null
function parseJob(content, hasSystemPrompt) {
  const trimmed = content.trim()
  try {
    const obj = JSON.parse(trimmed)
    const list = Array.isArray(obj) ? obj : obj.texts ?? obj.segments ?? obj.raw_text
    if (Array.isArray(list)) {
      const texts = list.map((t) => (typeof t === "string" ? t : String(t?.text ?? "")))
      const to = Array.isArray(obj) ? undefined : obj.to ?? obj.toLang ?? obj.target_lang ?? obj.targetLanguage
      const batch = Array.isArray(obj) || obj.batch !== false
      return { texts, to: normLang(to), batch }
    }
  } catch {}

  if (hasSystemPrompt) return null
  return { texts: trimmed ? [trimmed] : [], to: "zh", batch: false }
}

// 逐条产出豆包翻译结果 { index, res, detect_lang }
async function* doubaoItems(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (value) buf += value
    const blocks = buf.split(/\r?\n\r?\n/)
    buf = done ? "" : blocks.pop()
    for (const block of blocks) {
      let event = "", data = ""
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim()
        else if (line.startsWith("data:")) data += line.slice(5).trim()
      }
      if (event === "err") throw new Error(`豆包翻译流异常：${data}`)
      if (event === "done") return
      if (event !== "json" || !data) continue
      const obj = JSON.parse(data)
      if (obj.code !== 0) throw new Error(`豆包错误 ${obj.code}: ${obj.msg}`)
      yield* obj.data?.items ?? []
    }
    if (done) return
  }
}

const itemJson = (it) => JSON.stringify({ id: it.index, text: it.res ?? "", sourceLanguage: it.detect_lang ?? "" })

// ---------- 协议 ----------
// 每个协议实现：
//   read(req)              → { text, hasSystem, stream }
//   json(meta, content, u) → 非流式响应体
//   stream(meta, u0)       → { start(), delta(text), end(content, u), fail(message) }，各返回若干 SSE 帧
//   error(status, message) → 错误响应体
// u = { input, output } 为粗估的 token 数

const sse = (event, data) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`
const hasRole = (list, ...roles) => (Array.isArray(list) ? list : []).some((m) => roles.includes(m?.role))

const chat = {
  read: (req) => ({
    text: lastUserText(req.messages),
    hasSystem: hasRole(req.messages, "system", "developer"),
    stream: !!req.stream,
  }),
  json: (m, content, u) => ({
    id: `chatcmpl-${m.uid}`,
    object: "chat.completion",
    created: m.created,
    model: m.model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: chatUsage(u),
  }),
  stream(m) {
    const chunk = (delta, finish = null, extra = {}) =>
      sse(null, { id: `chatcmpl-${m.uid}`, object: "chat.completion.chunk", created: m.created, model: m.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })
    return {
      start: () => [chunk({ role: "assistant", content: "" })],
      delta: (text) => [chunk({ content: text })],
      end: (_, u) => [chunk({}, "stop", { usage: chatUsage(u) }), "data: [DONE]\n\n"],
      fail: (message) => [sse(null, { error: { message, type: "upstream_error" } }), "data: [DONE]\n\n"],
    }
  },
  error: (status, message) => ({ error: { message, type: "doubao_error", code: status } }),
}

const chatUsage = (u) => ({ prompt_tokens: u.input, completion_tokens: u.output, total_tokens: u.input + u.output })

const responses = {
  read(req) {
    const input = typeof req.input === "string" ? [{ role: "user", content: req.input }] : Array.isArray(req.input) ? req.input : []
    const messages = input.filter((it) => !it?.type || it.type === "message")
    return {
      text: lastUserText(messages),
      hasSystem: !!textOf(req.instructions).trim() || hasRole(messages, "system", "developer"),
      stream: !!req.stream,
    }
  },
  json: (m, content, u) => responseObject(m, "completed", [responseMessage(m, "completed", content)], u),
  stream(m) {
    let seq = 0
    const ev = (type, data) => sse(type, { type, sequence_number: seq++, ...data })
    const at = { item_id: `msg_${m.uid}`, output_index: 0, content_index: 0 }
    const part = (text) => ({ type: "output_text", text, annotations: [] })
    return {
      start: () => [
        ev("response.created", { response: responseObject(m, "in_progress", []) }),
        ev("response.in_progress", { response: responseObject(m, "in_progress", []) }),
        ev("response.output_item.added", { output_index: 0, item: responseMessage(m, "in_progress") }),
        ev("response.content_part.added", { ...at, part: part("") }),
      ],
      delta: (text) => [ev("response.output_text.delta", { ...at, delta: text })],
      end: (content, u) => {
        const item = responseMessage(m, "completed", content)
        return [
          ev("response.output_text.done", { ...at, text: content }),
          ev("response.content_part.done", { ...at, part: part(content) }),
          ev("response.output_item.done", { output_index: 0, item }),
          ev("response.completed", { response: responseObject(m, "completed", [item], u) }),
        ]
      },
      fail: (message) => [
        ev("error", { code: "upstream_error", message, param: null }),
        ev("response.failed", { response: { ...responseObject(m, "failed", []), error: { code: "server_error", message } } }),
      ],
    }
  },
  error: chat.error,
}

function responseObject(m, status, output, u) {
  return {
    id: `resp_${m.uid}`,
    object: "response",
    created_at: m.created,
    status,
    model: m.model,
    output,
    ...(u && { usage: { input_tokens: u.input, output_tokens: u.output, total_tokens: u.input + u.output } }),
  }
}

function responseMessage(m, status, text) {
  const content = text === undefined ? [] : [{ type: "output_text", text, annotations: [] }]
  return { type: "message", id: `msg_${m.uid}`, status, role: "assistant", content }
}

const ANTHROPIC_ERRORS = { 400: "invalid_request_error", 401: "authentication_error", 404: "not_found_error" }

const anthropic = {
  read: (req) => ({
    text: lastUserText(req.messages),
    hasSystem: !!textOf(req.system).trim(),
    stream: !!req.stream,
  }),
  json: (m, content, u) => ({
    id: `msg_${m.uid}`,
    type: "message",
    role: "assistant",
    model: m.model,
    content: [{ type: "text", text: content }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: u.input, output_tokens: u.output },
  }),
  stream(m, u0) {
    const ev = (type, data = {}) => sse(type, { type, ...data })
    return {
      start: () => [
        ev("message_start", {
          message: { id: `msg_${m.uid}`, type: "message", role: "assistant", model: m.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: u0.input, output_tokens: 0 } },
        }),
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      ],
      delta: (text) => [ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } })],
      end: (_, u) => [
        ev("content_block_stop", { index: 0 }),
        ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: u.output } }),
        ev("message_stop"),
      ],
      fail: (message) => [ev("error", { error: { type: "api_error", message } })],
    }
  },
  error: (status, message) => ({ type: "error", error: { type: ANTHROPIC_ERRORS[status] ?? "api_error", message } }),
}

// 按路径后缀匹配：magpie 传来的是 基地址 + 协议路径（如 https://www.doubao.com/samantha/plugin/messages），
// 不一定以 /v1 开头
const PROTOCOLS = [
  ["/chat/completions", chat],
  ["/responses", responses],
  ["/messages", anthropic],
]

const urlOf = (input) => (typeof input?.url === "string" ? input.url : String(input))

function protocolOf(input) {
  let path
  try { path = new URL(urlOf(input)).pathname.replace(/\/+$/, "") } catch { return null }
  return PROTOCOLS.find(([suffix]) => path.endsWith(suffix))?.[1] ?? null
}

// ---------- 输出 ----------

const JSON_HEADERS = { "Content-Type": "application/json" }
const SSE_HEADERS = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }

async function jsonResponse(proto, items, job, meta) {
  const got = []
  try {
    for await (const it of items) got.push(it)
  } catch (err) {
    return errorResponse(proto, 502, err.message)
  }
  got.sort((a, b) => a.index - b.index)
  const content = job.batch
    ? `{"translations":[${got.map(itemJson).join(",")}]}`
    : got.map((it) => it.res ?? "").join("\n")
  return new Response(JSON.stringify(proto.json(meta, content, usage(job, content))), { headers: JSON_HEADERS })
}

function streamResponse(proto, items, job, meta) {
  const enc = new TextEncoder()
  const writer = proto.stream(meta, usage(job, ""))
  const stream = new ReadableStream({
    async start(ctrl) {
      const emit = (frames) => { for (const f of frames) ctrl.enqueue(enc.encode(f)) }
      let content = ""
      const send = (text) => { content += text; emit(writer.delta(text)) }
      emit(writer.start())
      try {
        let first = true
        if (job.batch) send(`{"translations":[`)
        for await (const it of items) {
          if (job.batch) send(`${first ? "" : ","}${itemJson(it)}`)
          else send(`${first ? "" : "\n"}${it.res ?? ""}`)
          first = false
        }
        if (job.batch) send(`]}`)
        emit(writer.end(content, usage(job, content)))
      } catch (err) {
        emit(writer.fail(err.message))
      }
      ctrl.close()
    },
  })
  return new Response(stream, { headers: SSE_HEADERS })
}

// 豆包不返回用量，这里按字符数粗估，仅供 magpie 用量页参考
function usage(job, content) {
  return { input: Math.ceil(job.texts.join("").length / 2), output: Math.ceil(content.length / 2) }
}

function errorResponse(proto, status, message, headers = {}) {
  return new Response(JSON.stringify(proto.error(status, message)), { status, headers: { ...JSON_HEADERS, ...headers } })
}
