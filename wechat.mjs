// Loomy 微信扫码登录：二维码、长轮询、本地弹窗页。
//
// 思路来自 Ebony-Vinyl/dsh-our-free-model（MIT）的
// vendor/channel-pack/src/loomy-wechat*.ts，改成 magpie 的用法：
// authorize 起一个只监听 127.0.0.1 的小页面，浏览器扫码，callback 等结果。
//
// 官方客户端用 Electron 的 will-redirect 截微信回调；那个回调页实测 404，
// 所以这里完全不用它 —— code 从微信的长轮询里直接拿。

import { createServer } from "node:http"
import { randomUUID } from "node:crypto"

/** 微信开放平台「网站应用」AppID（Loomy 客户端 .env.prod 里的 LOOMY_WECHAT_APP_ID）。 */
export const WECHAT_APP_ID = "wx18d60be432287cf8"

/** 微信校验域名白名单，必须是官方的回调地址（它返回 404，但我们不加载它）。 */
export const WECHAT_REDIRECT_URI = "https://loomy.xunfei.cn/oauth/wechat/callback"

export const POLL_STATUS = Object.freeze({
  waiting: "waiting", // 408：待扫码
  scanned: "scanned", // 404：已扫码，等确认
  confirmed: "confirmed", // 405：已确认，wx_code 在这一帧
  cancelled: "cancelled", // 403
  expired: "expired", // 402
  error: "error", // 网络/解析异常，调用方继续轮询
})

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

const UUID_PATTERN = /^[A-Za-z0-9_\-=+/]{6,64}$/

export function buildAuthUrl(state) {
  return (
    "https://open.weixin.qq.com/connect/qrconnect" +
    `?appid=${encodeURIComponent(WECHAT_APP_ID)}` +
    `&redirect_uri=${encodeURIComponent(WECHAT_REDIRECT_URI)}` +
    "&response_type=code&scope=snsapi_login" +
    `&state=${encodeURIComponent(state)}` +
    "#wechat_redirect"
  )
}

/** 授权页把 uuid 直接写在 HTML 里，不用执行 JS */
export function extractUuid(html) {
  if (typeof html !== "string" || !html) return ""
  for (const pattern of [/\/connect\/qrcode\/([A-Za-z0-9_\-=+/]+)/, /l\/qrconnect\?uuid=([A-Za-z0-9_\-=+/]+)/]) {
    const hit = html.match(pattern)
    const candidate = String(hit?.[1] ?? "")
    if (UUID_PATTERN.test(candidate)) return candidate
  }
  return ""
}

export async function fetchUuid(state, fetcher = fetch) {
  const res = await fetcher(buildAuthUrl(state), {
    headers: { "User-Agent": UA, Referer: "https://open.weixin.qq.com/" },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`微信授权页返回 HTTP ${res.status}`)
  const uuid = extractUuid(await res.text())
  if (!uuid) throw new Error("微信授权页里没有二维码 uuid（页面结构可能变了）")
  return uuid
}

function imageMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png"
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif"
  return ""
}

export async function fetchQrDataUrl(uuid, fetcher = fetch) {
  const res = await fetcher(`https://open.weixin.qq.com/connect/qrcode/${encodeURIComponent(uuid)}`, {
    headers: { "User-Agent": UA, Referer: "https://open.weixin.qq.com/" },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`微信二维码返回 HTTP ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const mime = imageMime(bytes)
  if (!mime || bytes.length < 200) throw new Error("微信二维码不是图片（可能是错误页）")
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`
}

/**
 * 一次长轮询。状态码语义以微信授权页自己的 JS 为准：
 * 408 待扫码、404 已扫码、405 已确认（带 wx_code）、403 取消、402 过期。
 */
export async function pollOnce(uuid, lastErrcode, fetcher = fetch) {
  const query =
    `uuid=${encodeURIComponent(uuid)}` +
    (lastErrcode ? `&last=${encodeURIComponent(lastErrcode)}` : "") +
    `&_=${Date.now()}`
  let body = ""
  try {
    const res = await fetcher(`https://long.open.weixin.qq.com/connect/l/qrconnect?${query}`, {
      headers: { "User-Agent": UA, Referer: buildAuthUrl("") },
      signal: AbortSignal.timeout(40_000),
    })
    body = await res.text()
  } catch (e) {
    // 长轮询偶发失败不该终止流程
    return { status: POLL_STATUS.error, code: "", errcode: e?.message ?? "network" }
  }
  const errcode = (body.match(/wx_errcode\s*=\s*(\d+)/) ?? [])[1] ?? ""
  const code = (body.match(/wx_code\s*=\s*'([^']*)'/) ?? [])[1] ?? ""
  if (errcode === "405") {
    return code ? { status: POLL_STATUS.confirmed, code, errcode } : { status: POLL_STATUS.scanned, code: "", errcode }
  }
  if (errcode === "404") return { status: POLL_STATUS.scanned, code: "", errcode }
  if (errcode === "403") return { status: POLL_STATUS.cancelled, code: "", errcode }
  if (errcode === "402") return { status: POLL_STATUS.expired, code: "", errcode }
  return { status: POLL_STATUS.waiting, code: "", errcode }
}

const QR_PATH = "/wechat/qr"
const POLL_PATH = "/wechat/poll"
const COMPLETE_PATH = "/wechat/complete"

/**
 * 起一个本机弹窗页，返回地址和结果 promise。
 *
 * api 是四个账号服务调用，由 index.mjs 提供（那里有签名密钥）：
 *   bindAuth(code) → { bind, rcode, nickname }
 *   bindSkip(rcode) → { session, userid }
 *   bindSend(rcode, phone) → msgid
 *   bindCheck(rcode, code, msgid) → { session, userid, phone }
 */
export async function startWechatLogin(api, { timeoutMs = 5 * 60 * 1000, fetcher = fetch } = {}) {
  const state = { uuid: "", last: "", code: "", rcode: "", bind: 0, nickname: "", msgid: "" }
  state.uuid = await fetchUuid(randomUUID(), fetcher)
  const qrDataUrl = await fetchQrDataUrl(state.uuid, fetcher)

  let settle
  let settled = false
  const result = new Promise((resolve, reject) => {
    settle = { resolve, reject }
  })
  result.catch(() => {})
  const done = (value) => {
    if (settled) return
    settled = true
    settle.resolve(value)
  }
  const fail = (error) => {
    if (settled) return
    settled = true
    settle.reject(error)
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      try {
        json(res, 500, { status: "error", message: String(e?.message ?? e) })
      } catch {}
    })
  })

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname === QR_PATH) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(renderPage(qrDataUrl))
      return
    }
    if (url.pathname === POLL_PATH) {
      if (settled) return json(res, 200, { status: "done", message: "已登录" })
      const polled = await pollOnce(state.uuid, state.last, fetcher)
      if (polled.errcode) state.last = polled.errcode

      if (polled.status === POLL_STATUS.confirmed && polled.code) {
        state.code = polled.code
        try {
          const auth = await api.bindAuth(polled.code)
          state.rcode = auth.rcode
          state.bind = auth.bind
          state.nickname = auth.nickname ?? ""
          if (auth.bind === 1) {
            const login = await api.bindSkip(auth.rcode)
            done({ ...login, phone: "", nickname: state.nickname })
            return json(res, 200, { status: "done", message: "登录成功，可以关闭此窗口了" })
          }
          return json(res, 200, { status: "need_phone" })
        } catch (e) {
          fail(e)
          return json(res, 200, { status: "error", message: String(e?.message ?? e) })
        }
      }
      if (polled.status === POLL_STATUS.expired) {
        fail(new Error("微信二维码已失效，请重新登录"))
        return json(res, 200, { status: "expired" })
      }
      if (polled.status === POLL_STATUS.cancelled) {
        fail(new Error("你取消了微信登录"))
        return json(res, 200, { status: "cancelled" })
      }
      return json(res, 200, { status: polled.status })
    }
    if (url.pathname === COMPLETE_PATH && req.method === "POST") {
      const body = await readJson(req)
      if (!state.rcode) return json(res, 200, { ok: false, message: "还没有扫码" })
      try {
        if (body.action === "send_sms") {
          const phone = String(body.phone ?? "").replace(/\D/g, "")
          if (!/^1[3-9]\d{9}$/.test(phone)) return json(res, 200, { ok: false, message: "请填写 11 位手机号" })
          state.msgid = await api.bindSend(state.rcode, phone)
          return json(res, 200, { ok: true })
        }
        if (body.action === "verify_sms") {
          const phone = String(body.phone ?? "").replace(/\D/g, "")
          const code = String(body.code ?? "").replace(/\D/g, "")
          if (!state.msgid) return json(res, 200, { ok: false, message: "请先获取验证码" })
          if (!/^\d{6}$/.test(code)) return json(res, 200, { ok: false, message: "请输入 6 位验证码" })
          const login = await api.bindCheck(state.rcode, code, state.msgid)
          done({ ...login, phone: login.phone || phone, nickname: state.nickname })
          return json(res, 200, { ok: true, done: true })
        }
        return json(res, 200, { ok: false, message: `未知 action: ${body.action}` })
      } catch (e) {
        // 单步失败不终止：用户可能只是验证码输错
        return json(res, 200, { ok: false, message: String(e?.message ?? e) })
      }
    }
    res.writeHead(404).end("Not found")
  }

  const port = await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const p = typeof address === "object" && address ? address.port : 0
      if (p) resolve(p)
      else reject(new Error("微信登录页没能拿到端口"))
    })
  })

  const close = () =>
    new Promise((resolve) => {
      try {
        server.close(() => resolve())
      } catch {
        resolve()
      }
    })

  const timer = setTimeout(() => fail(new Error("微信登录超时（5 分钟）")), timeoutMs)
  timer.unref?.()
  result.catch(() => {}).finally(() => {
    clearTimeout(timer)
    setTimeout(() => void close(), 50)
  })

  return { url: `http://127.0.0.1:${port}${QR_PATH}`, result, close }
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(payload))
}

async function readJson(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > 64 * 1024) throw new Error("请求体过大")
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function renderPage(qrDataUrl) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Loomy 微信登录</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #f5f6f8; color: #1f2329; }
  .card { background: #fff; border-radius: 12px; padding: 28px 32px; box-shadow: 0 4px 24px rgba(0,0,0,.08);
          text-align: center; width: 320px; }
  h1 { font-size: 17px; margin: 0 0 4px; font-weight: 600; }
  .sub { font-size: 13px; color: #8a9099; margin-bottom: 18px; }
  .qr { width: 220px; height: 220px; display: block; margin: 0 auto; border: 1px solid #eceef1; border-radius: 8px; }
  .status { margin-top: 16px; font-size: 13px; color: #4e5969; min-height: 20px; }
  .status[data-tone="ok"] { color: #0f9d58; font-weight: 600; }
  .status[data-tone="err"] { color: #d93026; }
  .form { display: none; margin-top: 18px; text-align: left; }
  .form[data-show="1"] { display: block; }
  .form label { display: block; font-size: 12px; color: #8a9099; margin-bottom: 4px; }
  input { width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 14px; margin-bottom: 10px;
          border: 1px solid #d9dde3; border-radius: 6px; }
  button { width: 100%; padding: 9px; font-size: 14px; border: 0; border-radius: 6px;
           background: #07c160; color: #fff; cursor: pointer; }
  button:disabled { background: #c9cdd4; cursor: not-allowed; }
  .row { display: flex; gap: 8px; }
  .row input { margin-bottom: 10px; }
  .row button { width: auto; white-space: nowrap; padding: 8px 12px; }
</style>
</head>
<body>
  <div class="card">
    <h1>使用微信扫码登录 Loomy</h1>
    <div class="sub">打开微信扫一扫，扫描下方二维码</div>
    <img class="qr" alt="微信登录二维码" src="${qrDataUrl}">
    <div class="status" id="status">等待扫码…</div>
    <div class="form" id="phoneForm">
      <label for="phone">首次使用需绑定手机号</label>
      <div class="row">
        <input id="phone" type="tel" inputmode="numeric" maxlength="11" placeholder="手机号">
        <button id="sendBtn" type="button">获取验证码</button>
      </div>
      <input id="code" type="text" inputmode="numeric" maxlength="6" placeholder="短信验证码">
      <button id="verifyBtn" type="button">完成绑定并登录</button>
    </div>
  </div>
<script>
(function () {
  var statusEl = document.getElementById('status');
  var formEl = document.getElementById('phoneForm');
  var phoneEl = document.getElementById('phone');
  var codeEl = document.getElementById('code');
  var sendBtn = document.getElementById('sendBtn');
  var verifyBtn = document.getElementById('verifyBtn');
  var stopped = false;
  function setStatus(text, tone) {
    statusEl.textContent = text;
    if (tone) statusEl.setAttribute('data-tone', tone); else statusEl.removeAttribute('data-tone');
  }
  function post(payload) {
    return fetch('${COMPLETE_PATH}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json(); });
  }
  function poll() {
    if (stopped) return;
    fetch('${POLL_PATH}').then(function (r) { return r.json(); }).then(function (res) {
      if (res.status === 'done') { stopped = true; setStatus(res.message || '登录成功，可以关闭此窗口了', 'ok'); formEl.setAttribute('data-show', '0'); return; }
      if (res.status === 'need_phone') { stopped = true; setStatus('已扫码，请绑定手机号'); formEl.setAttribute('data-show', '1'); return; }
      if (res.status === 'expired') { stopped = true; setStatus('二维码已失效，请关闭窗口后重试', 'err'); return; }
      if (res.status === 'cancelled') { stopped = true; setStatus('你已取消授权，请关闭窗口后重试', 'err'); return; }
      if (res.status === 'error') { stopped = true; setStatus(res.message || '微信授权失败', 'err'); return; }
      if (res.status === 'scanned') setStatus('已扫码，请在手机上确认'); else setStatus('等待扫码…');
      setTimeout(poll, 1200);
    }).catch(function () { setTimeout(poll, 2000); });
  }
  sendBtn.addEventListener('click', function () {
    var phone = (phoneEl.value || '').replace(/\\D/g, '');
    if (phone.length !== 11) { setStatus('请输入 11 位手机号', 'err'); return; }
    sendBtn.disabled = true; setStatus('正在发送验证码…');
    post({ action: 'send_sms', phone: phone }).then(function (res) {
      if (res.ok) setStatus('验证码已发送至 ' + phone); else setStatus(res.message || '发送失败', 'err');
    }).catch(function () { setStatus('发送失败，请重试', 'err'); }).finally(function () { sendBtn.disabled = false; });
  });
  verifyBtn.addEventListener('click', function () {
    var phone = (phoneEl.value || '').replace(/\\D/g, '');
    var code = (codeEl.value || '').replace(/\\D/g, '');
    if (phone.length !== 11) { setStatus('请输入 11 位手机号', 'err'); return; }
    if (!code) { setStatus('请输入短信验证码', 'err'); return; }
    verifyBtn.disabled = true; setStatus('正在完成绑定…');
    post({ action: 'verify_sms', phone: phone, code: code }).then(function (res) {
      if (res.ok && res.done) setStatus('登录成功，可以关闭此窗口了', 'ok');
      else setStatus(res.message || '验证码错误，请重试', 'err');
    }).catch(function () { setStatus('绑定失败，请重试', 'err'); }).finally(function () { verifyBtn.disabled = false; });
  });
  poll();
})();
</script>
</body>
</html>`
}
