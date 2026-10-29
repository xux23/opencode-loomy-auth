import test from "node:test"
import assert from "node:assert/strict"

import { buildAuthUrl, extractUuid, pollOnce, startWechatLogin, POLL_STATUS } from "../wechat.mjs"

function mockFetch(t, handler) {
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    // 本地登录页走真实 fetch，其余都拦
    if (u.startsWith("http://127.0.0.1")) return original(u, init)
    return handler(u, init)
  }
  t.after(() => {
    globalThis.fetch = original
  })
}

test("授权 URL 带 Loomy 的微信 appid 和官方回调地址", () => {
  const url = buildAuthUrl("state-1")
  assert.match(url, /^https:\/\/open\.weixin\.qq\.com\/connect\/qrconnect\?/)
  assert.match(url, /appid=wx18d60be432287cf8/)
  assert.match(url, /redirect_uri=https%3A%2F%2Floomy\.xunfei\.cn%2Foauth%2Fwechat%2Fcallback/)
  assert.match(url, /state=state-1/)
})

test("从授权页 HTML 里提取二维码 uuid", () => {
  assert.equal(extractUuid('<img class="js_qrcode_img" src="/connect/qrcode/001ZDsw64Vu7ll2E"/>'), "001ZDsw64Vu7ll2E")
  assert.equal(extractUuid('<script>var x = "l/qrconnect?uuid=4Y0N_jyVQg=="</script>'), "4Y0N_jyVQg==")
  assert.equal(extractUuid("<html></html>"), "")
})

test("长轮询状态码语义", async (t) => {
  const bodies = {
    "405": "window.wx_errcode=405;window.wx_code='wx-code';",
    "404": "window.wx_errcode=404;",
    "408": "window.wx_errcode=408;",
    "403": "window.wx_errcode=403;",
    "402": "window.wx_errcode=402;",
  }
  let current = "408"
  mockFetch(t, async () => new Response(bodies[current]))

  assert.deepEqual(await pollOnce("uuid", ""), { status: POLL_STATUS.waiting, code: "", errcode: "408" })
  current = "404"
  assert.equal((await pollOnce("uuid", "408")).status, POLL_STATUS.scanned)
  current = "405"
  const confirmed = await pollOnce("uuid", "404")
  assert.equal(confirmed.status, POLL_STATUS.confirmed)
  assert.equal(confirmed.code, "wx-code")
  current = "403"
  assert.equal((await pollOnce("uuid", "")).status, POLL_STATUS.cancelled)
  current = "402"
  assert.equal((await pollOnce("uuid", "")).status, POLL_STATUS.expired)
})

test("扫码流程：本地页 → 轮询 → 直接换 session", async (t) => {
  const jpeg = new Uint8Array(300)
  jpeg.set([0xff, 0xd8, 0xff])

  mockFetch(t, async (url) => {
    if (url.includes("open.weixin.qq.com/connect/qrconnect")) {
      return new Response('<img class="js_qrcode_img" src="/connect/qrcode/abc123XYZ"/>', { status: 200 })
    }
    if (url.includes("/connect/qrcode/")) {
      return new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } })
    }
    if (url.includes("long.open.weixin.qq.com")) {
      return new Response("window.wx_errcode=405;window.wx_code='wx-code-1';", { status: 200 })
    }
    throw new Error(`unexpected request: ${url}`)
  })

  let seenCode = ""
  const flow = await startWechatLogin(
    {
      bindAuth: async (code) => {
        seenCode = code
        return { bind: 1, rcode: "rc-1", nickname: "Ada" }
      },
      bindSkip: async () => ({ session: "sess-1", userid: "u-1" }),
      bindSend: async () => "msg-1",
      bindCheck: async () => ({ session: "s", userid: "u", phone: "" }),
    },
    { timeoutMs: 5000 },
  )

  const page = await fetch(flow.url)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /微信扫码登录 Loomy/)

  const base = new URL(flow.url).origin
  const polled = await (await fetch(`${base}/wechat/poll`)).json()
  assert.equal(polled.status, "done")

  const result = await flow.result
  assert.equal(result.session, "sess-1")
  assert.equal(result.nickname, "Ada")
  assert.equal(seenCode, "wx-code-1")
  await flow.close()
})
