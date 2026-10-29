// Loomy（讯飞）供应商插件 for magpie / OpenCode
//
// 登录 Loomy 账号，把它的 OpenAI 兼容模型网关变成 magpie 的一个供应商：
// 列出账号可用的模型、转发 chat completions、读出两个积分钱包、每天刷新
// 一次「每日赠送积分」。协议来自对官方桌面客户端（0.9.38）的公开逆向记录，
// 见 README 的来源一节。
//
// 没有实现的：token 续期（Loomy 不发 refresh token，session 固定 14 天，
// 到期只能重新登录）；新手任务的自动领取（那是替用户伪造「已完成」）。

import { createHash, createHmac, randomUUID } from "node:crypto"

import { startWechatLogin } from "./wechat.mjs"

const ID = "loomy"
const NAME = "Loomy（讯飞）"

const DEFAULT_MODEL_BASE = "https://loomyad.xunfei.cn/api/v1"
const DEFAULT_ACCOUNT_BASE = "https://account.xfinfr.com"
const DEFAULT_VERSION = "0.9.38"

// 账号服务是讯飞的标准 HTTP + HMAC-SHA1 接口，这些是客户端请求信封里的常量
const APP_ID = "GM3LOOMY"
const CLIENT_MODEL = "Web"
const CLIENT_VERSION = "1.0.0"
const CLIENT_DEVICE = "web"
const CLIENT_UA = "Loomy|Desktop|Electron|macOS"

// 业务码：000000 成功；这两个表示登录态没了
const OK = "000000"
const AUTH_CODES = new Set(["020002", "100002"])

const SESSION_SECONDS = 14 * 24 * 3600
const REQUEST_TIMEOUT = 20_000

// 讯飞账号服务的签名常量不写进仓库：用插件选项 accessKeyId / accessKeySecret
// 或环境变量 LOOMY_AK_ID / LOOMY_AK_SECRET 提供。它只用于登录接口的签名，
// 跟用户凭据无关。

// ── 配置 ────────────────────────────────────────────────────────────────────

const trimBase = (v) => String(v).trim().replace(/\/+$/, "")
const first = (...values) => {
  for (const v of values) {
    if (v != null && String(v).trim()) return String(v).trim()
  }
  return ""
}

function resolveSettings(options = {}) {
  const env = process.env
  return {
    modelBase: trimBase(first(options.modelBase, env.LOOMY_MODEL_BASE_URL, DEFAULT_MODEL_BASE)),
    accountBase: trimBase(first(options.accountBase, env.LOOMY_ACCOUNT_BASE_URL, DEFAULT_ACCOUNT_BASE)),
    version: first(options.version, env.LOOMY_VERSION, DEFAULT_VERSION),
    akId: first(options.accessKeyId, env.LOOMY_AK_ID),
    akSecret: first(options.accessKeySecret, env.LOOMY_AK_SECRET),
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

const toNum = (v) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
const codeOf = (p) => String(p?.code ?? "").trim()
const messageOf = (p) => {
  const m = p?.desc ?? p?.message ?? p?.msg ?? p?.errmsg
  return typeof m === "string" ? m.trim() : ""
}
const payloadData = (p) => p?.data?.data ?? p?.data ?? p ?? {}

const expired = (message) => Object.assign(new Error(message), { signIn: "expired" })

const errorResponse = (status, message, headers = {}) =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

const beijingMidnight = () => Math.floor((Date.now() + 8 * 3600e3) / 86400e3) * 86400e3 + 86400e3 - 8 * 3600e3

const newTraceparent = () => `00-${randomUUID().replace(/-/g, "")}-${randomUUID().replace(/-/g, "").slice(0, 16)}-01`

// ── 账号服务的 HMAC-SHA1 签名 ───────────────────────────────────────────────
// stringToSign 固定 9 行：方法、路径、查询、Content-MD5、Content-Type、
// Date、Nonce、SignedHeaders、CanonicalizedHeaders。后两项没有 x-* 头时是
// 空字符串，但不能省略。

function escapeSegment(segment) {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase())
}
function escapedPath(path) {
  let clean = path.startsWith("/") ? path : `/${path}`
  if (clean.length > 1 && clean.endsWith("/")) clean = clean.slice(0, -1)
  return clean.split("/").map(escapeSegment).join("/")
}
function escapedQuery(params) {
  if (!params) return ""
  return Object.entries(params)
    .map(([k, v]) => `${escapeSegment(k)}=${escapeSegment(v == null ? "" : v)}`)
    .join("&")
}
function contentMD5(bodyString) {
  return bodyString ? createHash("md5").update(bodyString).digest("base64") : ""
}

function signString({ method, path, query, bodyString = "", contentType = "application/json", date, nonce }) {
  return [
    String(method).toUpperCase(),
    escapedPath(path),
    escapedQuery(query),
    contentMD5(bodyString),
    contentType,
    date,
    nonce,
    "",
    "",
  ].join("\n")
}

function signHeaders(settings, method, path, bodyString, query) {
  if (!settings.akId || !settings.akSecret) {
    throw new Error("缺少 Loomy 客户端签名密钥：请用插件选项 accessKeyId / accessKeySecret 或环境变量 LOOMY_AK_ID / LOOMY_AK_SECRET 配置")
  }
  const date = new Date().toUTCString()
  const nonce = randomUUID()
  const signature = createHmac("sha1", settings.akSecret)
    .update(signString({ method, path, query, bodyString, date, nonce }))
    .digest("base64")
  const headers = {
    Authorization: `account ${settings.akId}:${signature}`,
    Date: date,
    Nonce: nonce,
    "Content-Type": "application/json",
  }
  const md5 = contentMD5(bodyString)
  if (md5) headers["Content-MD5"] = md5
  return headers
}

function makeBase() {
  return {
    appid: APP_ID,
    modelid: CLIENT_MODEL,
    version: CLIENT_VERSION,
    devid: CLIENT_DEVICE,
    ua: CLIENT_UA,
    traceid: createHash("md5").update(randomUUID()).digest("hex"),
  }
}

// 账号服务的签名请求：body 只序列化一次，签名覆盖的正是发出去的字节
async function signedPost(settings, pathname, body) {
  const bodyString = JSON.stringify(body)
  const res = await fetch(settings.accountBase + pathname, {
    method: "POST",
    headers: signHeaders(settings, "POST", pathname, bodyString),
    body: bodyString,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  })
  const text = await res.text().catch(() => "")
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    /* 非 JSON：下面统一报错 */
  }
  if (!payload) throw new Error(`Loomy 账号接口返回了无法解析的内容（HTTP ${res.status}）`)
  if (!res.ok) throw new Error(`Loomy 账号接口返回 HTTP ${res.status}：${messageOf(payload) || text.slice(0, 200)}`)
  return payload
}

// 网关请求：session 同时放在 Authorization 和 token 两个头里（客户端两个都发）；
// traceparent 少了上游会一直挂到超时。
async function tokenRequest(settings, method, pathOrUrl, session, body) {
  if (!session) throw expired("Loomy 登录态缺失，请重新登录")
  const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : settings.modelBase + pathOrUrl
  const headers = {
    Accept: "application/json",
    token: session,
    Authorization: `Bearer ${session}`,
    traceparent: newTraceparent(),
    "loomy-version": settings.version,
  }
  const init = { method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT) }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json;charset=utf-8"
    init.body = JSON.stringify(body)
  }
  let res
  try {
    res = await fetch(url, init)
  } catch (e) {
    throw new Error(`Loomy 请求失败：${e?.message ?? e}`)
  }
  if (res.status === 401) throw expired("Loomy 登录态已失效，请重新登录")
  const text = await res.text().catch(() => "")
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    /* 下面统一报错 */
  }
  if (!res.ok) {
    throw new Error(`Loomy 返回 HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ""}`)
  }
  if (!payload) throw new Error("Loomy 返回了无法解析的内容")
  return payload
}

// ── 积分 ────────────────────────────────────────────────────────────────────

// 两个已知版本：v2 用 camelCase 的查询参数并可能多包一层 data；
// v1 是逆向文档里的老接口。谁先成功用谁。
function gatewayRoot(settings) {
  const m = settings.modelBase.match(/^(.*)\/api\/v1$/)
  return m ? m[1] : settings.modelBase
}

function pointsFrom(payload) {
  const data = payloadData(payload)
  if (!data || typeof data !== "object") return null
  const balance = toNum(data.balance ?? data.permanentBalance)
  const daily = toNum(data.dailyBalance ?? data.daily)
  const available = toNum(data.availableBalance ?? data.available)
  if (balance == null && daily == null && available == null) return null
  return {
    balance,
    daily,
    available,
    dailyLimit: toNum(data.dailyLimitPoints),
    dailyRemaining: toNum(data.dailyRemainingPoints),
  }
}

async function readPoints(settings, session) {
  const root = gatewayRoot(settings)
  const urls = [
    `${root}/api/v2/points/records?pageNo=1&pageSize=1&direction=debit&granularity=chat`,
    `${settings.modelBase}/points/records?record_type=all&page_no=1&page_size=1`,
  ]
  let last = null
  for (const url of urls) {
    try {
      const payload = await tokenRequest(settings, "GET", url, session)
      const code = codeOf(payload)
      if (AUTH_CODES.has(code)) throw expired("Loomy 登录态已失效，请重新登录")
      if (code && code !== OK) {
        last = new Error(messageOf(payload) || `code=${code}`)
        continue
      }
      const points = pointsFrom(payload)
      if (points) return points
      last = new Error("Loomy 没有返回积分字段")
    } catch (e) {
      if (e?.signIn === "expired") throw e
      last = e
    }
  }
  throw last ?? new Error("积分查询失败")
}

// ── 模型 ────────────────────────────────────────────────────────────────────

// 模型显示名以倍率结尾，如 "DeepSeek V4 Flash (x3.0)" / "（x0.8）"
function splitRateSuffix(raw) {
  const trimmed = String(raw ?? "").trimEnd()
  for (const [close, open] of [
    [")", "("],
    ["）", "（"],
  ]) {
    if (!trimmed.endsWith(close)) continue
    const body = trimmed.slice(0, -1)
    const at = body.lastIndexOf(open)
    if (at < 0) continue
    const inner = body.slice(at + 1).trim()
    if (!/^x\d+(\.\d+)?$/i.test(inner)) return { name: trimmed, rate: undefined }
    return { name: body.slice(0, at).trimEnd() || trimmed, rate: inner.toLowerCase() }
  }
  return { name: trimmed, rate: undefined }
}

function catalogModel(entry) {
  const id = String(entry?.id ?? "").trim()
  if (!id) return null
  // 上游目录里还有 image 之类的条目，它们不走 chat completions
  if (entry?.type && String(entry.type) !== "chat") return null
  const caps = entry?.capabilities ?? {}
  const { name, rate } = splitRateSuffix(entry?.name ?? entry?.display_name ?? id)
  const context = toNum(entry?.context_length ?? entry?.context_window ?? entry?.limit?.context)
  const output = toNum(entry?.max_output_tokens ?? entry?.max_tokens ?? entry?.limit?.output)

  const config = { name: name || id }
  if (context != null) {
    config.limit = { context }
    if (output != null) config.limit.output = output
  }
  if (caps.reasoning) config.reasoning = true
  if (caps.function_calling) config.tool_call = true
  if (caps.vision) {
    config.modalities = { input: ["text", "image"] }
  }
  // 远端给的思考档位就是 magpie 的 variants
  const efforts = Array.isArray(entry?.reasoning_efforts)
    ? entry.reasoning_efforts.filter((v) => typeof v === "string" && v)
    : []
  if (efforts.length) config.variants = Object.fromEntries(efforts.map((v) => [v, {}]))
  // magpie 读的倍率字段；0 表示没有给出倍率，不是免费
  if (rate) config.rate = rate
  return { id, config }
}

// ── chat 请求体适配 ─────────────────────────────────────────────────────────

// Loomy 实测的思考档位：none / low / medium / high / xhigh
function foldReasoning(body) {
  const supported = new Set(["none", "low", "medium", "high", "xhigh"])
  const fold = (v) => (v === "minimal" ? "low" : supported.has(v) ? v : null)
  let changed = false
  if (typeof body.reasoning_effort === "string") {
    const folded = fold(body.reasoning_effort)
    if (folded !== body.reasoning_effort) {
      if (folded) body.reasoning_effort = folded
      else delete body.reasoning_effort
      changed = true
    }
  }
  if (body.reasoning && typeof body.reasoning === "object" && typeof body.reasoning.effort === "string") {
    const folded = fold(body.reasoning.effort)
    if (folded !== body.reasoning.effort) {
      if (folded) body.reasoning.effort = folded
      else delete body.reasoning.effort
      changed = true
    }
  }
  return changed
}

const isDeepSeek = (model) => String(model ?? "").toLowerCase().includes("deepseek")

// deepseek 在 Loomy 上只认 <image_base64> 文本标记，不认 OpenAI 的 image_url；
// 只转换 data: URI（远程 URL 客户端本来也拿不到内容）
function rewriteImagesToTags(body) {
  let converted = 0
  for (const message of body.messages ?? []) {
    if (!Array.isArray(message.content)) continue
    for (let i = message.content.length - 1; i >= 0; i--) {
      const part = message.content[i]
      const kind = String(part?.type ?? "").trim().toLowerCase()
      if (kind !== "image_url" && kind !== "input_image") continue
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url
      if (typeof url !== "string" || !url.startsWith("data:")) continue
      const tag = `<image_base64>${url}</image_base64>`
      message.content.splice(i, 1)
      const prev = i > 0 && message.content[i - 1]?.type === "text" ? message.content[i - 1] : null
      if (prev) prev.text += `\n${tag}`
      else if (message.content[i]?.type === "text") message.content[i].text = `${tag}\n${message.content[i].text}`
      else message.content.splice(i, 0, { type: "text", text: tag })
      converted++
    }
  }
  return converted
}

async function bodyText(input, init) {
  const b = init?.body
  if (typeof b === "string") return b
  if (b instanceof Uint8Array) return new TextDecoder().decode(b)
  if (b instanceof ArrayBuffer) return new TextDecoder().decode(b)
  if (input instanceof Request) return input.clone().text()
  if (b && typeof b.text === "function") return b.text()
  return ""
}

// ── 微信扫码登录的账号服务调用 ─────────────────────────────────────────────

function unwrap(payload) {
  const code = codeOf(payload)
  if (code && code !== OK) throw new Error(messageOf(payload) || `code=${code}`)
  return payloadData(payload)
}

async function bindThirdAccount(settings, code) {
  const data = unwrap(
    await signedPost(settings, "/login/thirdAccount/bind/auth", {
      base: makeBase(),
      param: { tcode: { code }, type: "wx" },
    }),
  )
  const rcode = String(data?.rcode ?? "").trim()
  if (!rcode) throw new Error("微信授权响应缺少 rcode")
  return {
    bind: data?.bind === 1 ? 1 : 0,
    rcode,
    nickname: String(data?.nickname ?? ""),
  }
}

async function bindSkip(settings, rcode) {
  const data = unwrap(
    await signedPost(settings, "/login/thirdAccount/bind/skip", {
      base: makeBase(),
      param: { rcode, expire: SESSION_SECONDS },
    }),
  )
  const session = String(data?.session ?? "").trim()
  if (!session) throw new Error("微信登录响应缺少 session")
  return { session, userid: String(data?.userid ?? "") }
}

async function bindSendCode(settings, rcode, phone) {
  const data = unwrap(
    await signedPost(settings, "/login/thirdAccount/bind/sendMsg", {
      base: makeBase(),
      param: { rcode, phone, ccode: "86", expire: 300 },
    }),
  )
  const msgid = String(data?.msgid ?? "").trim()
  if (!msgid) throw new Error("绑定手机号响应缺少 msgid")
  return msgid
}

async function bindCheckCode(settings, rcode, code, msgid) {
  const data = unwrap(
    await signedPost(settings, "/login/thirdAccount/bind/checkCode", {
      base: makeBase(),
      param: { rcode, mcode: code, msgid, expire: SESSION_SECONDS },
    }),
  )
  const session = String(data?.session ?? "").trim()
  if (!session) throw new Error("绑定登录响应缺少 session")
  return {
    session,
    userid: String(data?.userid ?? ""),
    phone: String(data?.phone ?? ""),
  }
}

// ── 插件 ────────────────────────────────────────────────────────────────────

export async function LoomyAuthPlugin(_input, options = {}) {
  const settings = resolveSettings(options)

  // 微信扫码：起一个只监听 127.0.0.1 的页面，浏览器扫码，callback 等结果。
  // 没绑手机号的微信账号会在那个页面上走一遍绑定流程。
  const wechatMethod = {
    type: "oauth",
    label: "微信扫码登录（浏览器）",
    async authorize() {
      if (!settings.akId || !settings.akSecret) {
        throw new Error("缺少 Loomy 客户端签名密钥：请用插件选项 accessKeyId / accessKeySecret 或环境变量 LOOMY_AK_ID / LOOMY_AK_SECRET 配置")
      }
      const flow = await startWechatLogin({
        bindAuth: (code) => bindThirdAccount(settings, code),
        bindSkip: (rcode) => bindSkip(settings, rcode),
        bindSend: (rcode, phone) => bindSendCode(settings, rcode, phone),
        bindCheck: (rcode, code, msgid) => bindCheckCode(settings, rcode, code, msgid),
      })
      return {
        url: flow.url,
        instructions: "用微信扫一扫窗口里的二维码，确认后自动完成；没绑手机号的账号会要求绑定一次。",
        method: "auto",
        async callback() {
          try {
            const got = await flow.result
            const phone = String(got.phone ?? "")
            return {
              type: "success",
              refresh: "",
              access: got.session,
              expires: Date.now() + SESSION_SECONDS * 1000,
              accountId: phone ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : got.nickname || "微信登录",
              userId: got.userid,
              source: "wechat",
            }
          } catch (e) {
            return { type: "failed", error: String(e?.message ?? e) }
          } finally {
            await flow.close()
          }
        },
      }
    },
  }

  return {
    async config(config) {
      config.provider ??= {}
      config.provider[ID] ??= {
        name: NAME,
        npm: "@ai-sdk/openai-compatible",
        api: settings.modelBase,
        models: {},
      }
    },

    auth: {
      provider: ID,
      methods: [wechatMethod],

      // Loomy 没有 refresh token：session 到期只能重新登录。
      // getAuth() 在账号作用域里，返回的就是这个账号。
      async loader(getAuth) {
        return {
          baseURL: settings.modelBase,
          async fetch(input, init = {}) {
            const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url
            let url
            try {
              url = new URL(rawUrl)
            } catch {
              return errorResponse(400, "请求地址无效")
            }
            if (!/\/chat\/completions\/?$/.test(url.pathname)) {
              return errorResponse(404, "Loomy 插件只提供 chat completions")
            }

            const account = await getAuth().catch(() => null)
            const session = account?.access
            if (!session) {
              return errorResponse(401, "Loomy 登录态缺失，请重新登录", { "X-Magpie-Sign-In": "expired" })
            }

            let body
            try {
              body = JSON.parse(await bodyText(input, init))
            } catch {
              return errorResponse(400, "请求体不是 JSON")
            }

            // 客户端就是这么写的：思考档位折成三档；deepseek 的图转成标记
            try {
              foldReasoning(body)
              if (isDeepSeek(body.model)) rewriteImagesToTags(body)
            } catch {
              /* 适配失败就按原文发 */
            }

            let res
            try {
              res = await fetch(`${settings.modelBase}/chat/completions`, {
                method: "POST",
                headers: {
                  // charset=utf-8 是必须的：少了上游会按 GBK 读正文
                  "Content-Type": "application/json;charset=utf-8",
                  Accept: "text/event-stream, application/json",
                  Authorization: `Bearer ${session}`,
                  token: session,
                  traceparent: newTraceparent(),
                  "loomy-version": settings.version,
                  ChatId: randomUUID(),
                  MsgId: randomUUID(),
                  TurnId: randomUUID(),
                  "X-Loomy-Request-Purpose": "chat.message",
                },
                body: JSON.stringify(body),
                signal: init.signal,
              })
            } catch (e) {
              if (init.signal?.aborted) throw e
              return errorResponse(502, `连接 Loomy 失败：${e?.message ?? e}`)
            }

            if (res.status === 401) {
              return errorResponse(401, "Loomy 登录态已失效，请重新登录", { "X-Magpie-Sign-In": "expired" })
            }
            // 403 也可能是「这个模型不可用」，交给 magpie 当模型被拒处理；
            // 只有正文明确在说登录/会话才按登录失效算
            if (res.status === 403) {
              const text = await res.clone().text().catch(() => "")
              if (/session|token|login|sign.?in|登录|会话/i.test(text)) {
                return errorResponse(401, "Loomy 登录态已失效，请重新登录", { "X-Magpie-Sign-In": "expired" })
              }
            }
            // 其他状态码和正文原样传回，magpie 自己决定故障切换
            return res
          },
        }
      },

      async usage(getAuth) {
        try {
          const account = await getAuth()
          if (account?.type !== "oauth" || !account.access) {
            return { error: "Loomy 尚未登录", signIn: "kept" }
          }
          const p = await readPoints(settings, account.access)
          const windows = []

          if (p.dailyLimit != null && p.dailyRemaining != null && p.dailyLimit > 0) {
            const spent = Math.max(0, p.dailyLimit - p.dailyRemaining)
            windows.push({
              name: "每日赠送积分",
              used: Math.round((spent / p.dailyLimit) * 1000) / 10,
              amount: spent,
              limit: p.dailyLimit,
              unit: "credits",
              resetsAt: beijingMidnight(),
              span: 86400,
            })
          } else if (p.daily != null) {
            // 没有限额数字时，钱包只能当「有这么多」，不编一个 limit
            windows.push({ name: "每日赠送积分", display: `${p.daily} credits`, aside: true })
          }

          if (p.balance != null) {
            windows.push({ name: "永久积分", balance: p.balance, unit: "credits", aside: true })
          }

          return {
            plan: "Loomy",
            user: account.accountId || account.name,
            ...(p.available != null ? { balance: `${p.available} credits` } : {}),
            windows,
          }
        } catch (e) {
          return {
            error: String(e?.message ?? e),
            signIn: e?.signIn === "expired" ? "expired" : "kept",
          }
        }
      },

      // 每日首次登录刷新每日赠送积分；没有续期接口，所以这就是「签到」
      async checkin(getAuth) {
        const account = await getAuth()
        if (account?.type !== "oauth" || !account.access) {
          throw expired("Loomy：未登录，无法刷新每日积分")
        }
        let payload
        try {
          payload = await tokenRequest(settings, "POST", "/points/first-login", account.access, {})
        } catch (e) {
          if (e?.signIn === "expired") throw expired("Loomy 登录态已失效，请重新登录后再刷新每日积分")
          return { outcome: "failed", message: `每日积分刷新失败：${e?.message ?? e}` }
        }
        const code = codeOf(payload)
        if (AUTH_CODES.has(code)) throw expired("Loomy 登录态已失效，请重新登录后再刷新每日积分")
        if (code && code !== OK) {
          return { outcome: "failed", message: `每日积分刷新失败：${messageOf(payload) || `code=${code}`}` }
        }
        const daily = toNum(payloadData(payload)?.dailyBalance)
        return {
          outcome: "claimed",
          message: daily != null ? `每日赠送积分已刷新（当前 ${daily}）` : "每日赠送积分已刷新",
        }
      },
    },

    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        provider.models ??= {}
        if (auth?.type !== "oauth" || !auth.access) return provider.models
        try {
          const payload = await tokenRequest(settings, "GET", "/models", auth.access)
          const code = codeOf(payload)
          if (code && code !== OK) return provider.models
          const entries = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
          for (const entry of entries) {
            const model = catalogModel(entry)
            if (!model) continue
            provider.models[model.id] = { ...(provider.models[model.id] ?? {}), ...model.config }
          }
        } catch {
          // 连不上厂商时保留原有列表
        }
        return provider.models
      },
    },
  }
}

// 测试用
export const _internal = {
  ID,
  NAME,
  OK,
  AUTH_CODES,
  signString,
  signHeaders,
  escapedPath,
  escapedQuery,
  contentMD5,
  makeBase,
  foldReasoning,
  isDeepSeek,
  rewriteImagesToTags,
  splitRateSuffix,
  catalogModel,
  pointsFrom,
  beijingMidnight,
}
