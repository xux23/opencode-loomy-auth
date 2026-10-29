import test from "node:test"
import assert from "node:assert/strict"

import { LoomyAuthPlugin, _internal } from "../index.mjs"

const {
  signString,
  signHeaders,
  escapedPath,
  contentMD5,
  foldReasoning,
  rewriteImagesToTags,
  splitRateSuffix,
  catalogModel,
  pointsFrom,
} = _internal

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

function mockFetch(t, handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), init }
    calls.push(call)
    return handler(call)
  }
  t.after(() => {
    globalThis.fetch = original
  })
  return calls
}

const plugin = () => LoomyAuthPlugin({}, { accessKeyId: "test-id", accessKeySecret: "test-secret" })
const account = () => async () => ({ type: "oauth", access: "session-1", accountId: "138****0000" })

// ── 纯函数 ─────────────────────────────────────────────────────────────────

test("signString 是 9 行，路径按段转义", () => {
  assert.equal(escapedPath("/login/phone/sendMsgCode"), "/login/phone/sendMsgCode")
  assert.equal(escapedPath("/a b/c(d)"), "/a%20b/c%28d%29")
  const s = signString({
    method: "post",
    path: "/login/phone/sendMsgCode",
    bodyString: '{"a":1}',
    date: "Sat, 26 Sep 2026 12:00:00 GMT",
    nonce: "n",
  })
  assert.equal(s.split("\n").length, 9)
  assert.equal(s.split("\n")[0], "POST")
  assert.equal(s.split("\n")[3], contentMD5('{"a":1}'))
  assert.equal(s.split("\n")[4], "application/json")
  assert.equal(s.split("\n")[7], "")
  assert.equal(s.split("\n")[8], "")
})

test("signHeaders 的 Authorization 是 account id:signature", () => {
  const h = signHeaders({ akId: "akid", akSecret: "secret" }, "POST", "/x", '{"a":1}')
  assert.match(h.Authorization, /^account akid:[A-Za-z0-9+/=]+$/)
  assert.ok(h.Date.endsWith("GMT"))
  assert.ok(h.Nonce)
  assert.equal(h["Content-MD5"], contentMD5('{"a":1}'))
})

test("缺少签名密钥时给出可操作的错误", () => {
  assert.throws(() => signHeaders({ akId: "", akSecret: "" }, "POST", "/x", "{}"), /accessKeyId/)
})

test("foldReasoning 只留 Loomy 支持的档位", () => {
  const a = { reasoning_effort: "xhigh" }
  assert.equal(foldReasoning(a), false)
  assert.equal(a.reasoning_effort, "xhigh")
  const b = { reasoning_effort: "max" }
  assert.equal(foldReasoning(b), true)
  assert.equal(b.reasoning_effort, undefined)
  const c = { reasoning_effort: "none" }
  foldReasoning(c)
  assert.equal(c.reasoning_effort, "none")
  const d = { reasoning: { effort: "minimal" } }
  foldReasoning(d)
  assert.equal(d.reasoning.effort, "low")
})

test("rewriteImagesToTags 只转 data URI 并合并进相邻文本", () => {
  const b = {
    messages: [
      { role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] },
      { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] },
    ],
  }
  assert.equal(rewriteImagesToTags(b), 1)
  assert.equal(b.messages[0].content.length, 1)
  assert.equal(b.messages[0].content[0].text, "看图\n<image_base64>data:image/png;base64,AAA</image_base64>")
  assert.equal(b.messages[1].content[0].type, "image_url")
})

test("splitRateSuffix 与 catalogModel", () => {
  assert.deepEqual(splitRateSuffix("DeepSeek V4 Flash (x3.0)"), { name: "DeepSeek V4 Flash", rate: "x3.0" })
  assert.deepEqual(splitRateSuffix("qwen（x0.8）"), { name: "qwen", rate: "x0.8" })
  assert.deepEqual(splitRateSuffix("No rate"), { name: "No rate", rate: undefined })

  const m = catalogModel({
    id: "deepseek-v4-flash-0731",
    name: "DeepSeek V4 Flash (x3.0)",
    context_length: 1_000_000,
    max_output_tokens: 32_000,
    capabilities: { reasoning: true, function_calling: true, vision: true },
  })
  assert.equal(m.id, "deepseek-v4-flash-0731")
  assert.equal(m.config.name, "DeepSeek V4 Flash")
  assert.equal(m.config.rate, "x3.0")
  assert.deepEqual(m.config.limit, { context: 1_000_000, output: 32_000 })
  assert.equal(m.config.reasoning, true)
  assert.equal(m.config.tool_call, true)
  assert.deepEqual(m.config.modalities, { input: ["text", "image"] })
  assert.equal(catalogModel({}), null)
  // 目录里的非 chat 条目（画图模型）不进供应商列表
  assert.equal(catalogModel({ id: "doubao-seedream", type: "image" }), null)

  const withEfforts = catalogModel({
    id: "kimi",
    type: "chat",
    name: "Kimi (x6.5)",
    reasoning_efforts: ["none", "low", "medium", "high", "xhigh"],
  })
  assert.deepEqual(Object.keys(withEfforts.config.variants), ["none", "low", "medium", "high", "xhigh"])
})

test("pointsFrom 兼容 v1/v2 形状", () => {
  assert.deepEqual(pointsFrom({ data: { balance: 1, dailyBalance: 2, availableBalance: 3 } }), {
    balance: 1,
    daily: 2,
    available: 3,
    dailyLimit: null,
    dailyRemaining: null,
  })
  assert.deepEqual(
    pointsFrom({ data: { data: { balance: 4, dailyBalance: 5, dailyLimitPoints: 10, dailyRemainingPoints: 6 } } }),
    { balance: 4, daily: 5, available: null, dailyLimit: 10, dailyRemaining: 6 },
  )
  assert.equal(pointsFrom({ data: {} }), null)
})

// ── 插件结构 ───────────────────────────────────────────────────────────────

test("插件只声明一种登录方式：微信扫码", async () => {
  const p = await plugin()
  assert.equal(p.auth.provider, "loomy")
  assert.equal(p.auth.methods.length, 1)
  assert.equal(p.auth.methods[0].type, "oauth")
  assert.match(p.auth.methods[0].label, /微信扫码/)

  const config = {}
  await p.config(config)
  assert.equal(config.provider.loomy.npm, "@ai-sdk/openai-compatible")
  assert.equal(config.provider.loomy.api, "https://loomyad.xunfei.cn/api/v1")
})

// ── 请求转发 ───────────────────────────────────────────────────────────────

test("loader 的 fetch 转发到 chat/completions 并带上全部必需头", async (t) => {
  const p = await plugin()
  const loader = await p.auth.loader(account())
  const calls = mockFetch(t, () => new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }))

  const res = await loader.fetch("https://loomyad.xunfei.cn/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-flash-0731", reasoning_effort: "minimal", messages: [] }),
  })

  assert.equal(res.status, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, "https://loomyad.xunfei.cn/api/v1/chat/completions")
  const h = calls[0].init.headers
  assert.equal(h.token, "session-1")
  assert.equal(h.Authorization, "Bearer session-1")
  assert.match(h.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
  assert.equal(h["loomy-version"], "0.9.38")
  assert.equal(h["Content-Type"], "application/json;charset=utf-8")
  assert.equal(JSON.parse(calls[0].init.body).reasoning_effort, "low")
})

test("loader 的 fetch 把 401 变成带标记的登录失效", async (t) => {
  const p = await plugin()
  const loader = await p.auth.loader(account())
  mockFetch(t, () => json({ error: "no session" }, 401))

  const res = await loader.fetch("https://loomyad.xunfei.cn/api/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "m", messages: [] }),
  })
  assert.equal(res.status, 401)
  assert.equal(res.headers.get("x-magpie-sign-in"), "expired")
})

test("loader 的 fetch 拒绝非 chat 路径", async (t) => {
  const p = await plugin()
  const loader = await p.auth.loader(account())
  const calls = mockFetch(t, () => json({}))
  const res = await loader.fetch("https://loomyad.xunfei.cn/api/v1/embeddings", { method: "POST", body: "{}" })
  assert.equal(res.status, 404)
  assert.equal(calls.length, 0)
})

// ── 模型 / 用量 / 签到 ─────────────────────────────────────────────────────

test("models 钩子合并上游列表", async (t) => {
  const p = await plugin()
  mockFetch(t, () =>
    json({
      code: "000000",
      data: [
        {
          id: "deepseek-v4-flash-0731",
          name: "DeepSeek V4 Flash (x3.0)",
          context_length: 1_000_000,
          max_output_tokens: 32_000,
          capabilities: { reasoning: true, function_calling: true },
        },
      ],
    }),
  )
  const provider = { id: "loomy", models: {} }
  const models = await p.provider.models(provider, { auth: { type: "oauth", access: "s" } })
  assert.equal(models["deepseek-v4-flash-0731"].name, "DeepSeek V4 Flash")
  assert.equal(models["deepseek-v4-flash-0731"].rate, "x3.0")
})

test("models 钩子失败时保留原列表", async (t) => {
  const p = await plugin()
  mockFetch(t, () => {
    throw new Error("offline")
  })
  const provider = { id: "loomy", models: { keep: { name: "Keep" } } }
  const models = await p.provider.models(provider, { auth: { type: "oauth", access: "s" } })
  assert.deepEqual(models, { keep: { name: "Keep" } })
})

test("usage 读 v2 积分并用限额算出已用", async (t) => {
  const p = await plugin()
  mockFetch(t, (call) => {
    assert.match(call.url, /\/api\/v2\/points\/records/)
    return json({
      code: "000000",
      data: { balance: 100, dailyBalance: 700, availableBalance: 800, dailyLimitPoints: 1000, dailyRemainingPoints: 700 },
    })
  })
  const usage = await p.auth.usage(account())
  assert.equal(usage.plan, "Loomy")
  assert.equal(usage.balance, "800 credits")
  const daily = usage.windows.find((w) => w.name === "每日赠送积分")
  assert.equal(daily.used, 30)
  assert.equal(daily.amount, 300)
  assert.equal(daily.limit, 1000)
  const permanent = usage.windows.find((w) => w.name === "永久积分")
  assert.equal(permanent.balance, 100)
})

test("usage 在 v2 不可用时退回 v1", async (t) => {
  const p = await plugin()
  mockFetch(t, (call) => {
    if (call.url.includes("/api/v2/")) return json({ error: "not found" }, 404)
    assert.match(call.url, /\/api\/v1\/points\/records\?record_type=all/)
    return json({ code: "000000", data: { balance: 5, dailyBalance: 2, availableBalance: 7 } })
  })
  const usage = await p.auth.usage(account())
  assert.equal(usage.balance, "7 credits")
  assert.equal(usage.windows.find((w) => w.name === "每日赠送积分").display, "2 credits")
  assert.equal(usage.windows.find((w) => w.name === "永久积分").balance, 5)
})

test("checkin 调用 first-login 并报告刷新", async (t) => {
  const p = await plugin()
  const calls = mockFetch(t, () => json({ code: "000000", data: { dailyBalance: 500 } }))
  const result = await p.auth.checkin(account())
  assert.equal(result.outcome, "claimed")
  assert.match(result.message, /500/)
  assert.equal(calls[0].url, "https://loomyad.xunfei.cn/api/v1/points/first-login")
  assert.equal(calls[0].init.method, "POST")
  assert.equal(calls[0].init.body, "{}")
})

test("checkin 在登录失效时抛 signIn=expired", async (t) => {
  const p = await plugin()
  mockFetch(t, () => json({ code: "020002", desc: "登录态已失效" }, 200))
  await assert.rejects(() => p.auth.checkin(account()), (e) => e.signIn === "expired")
})
