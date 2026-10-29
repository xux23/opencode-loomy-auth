# opencode-loomy-auth

magpie / OpenCode 的 Loomy（讯飞）供应商插件：用你的 Loomy 账号登录，把它的
OpenAI 兼容模型网关变成 magpie 的一个供应商。

- `auth`：只有一种登录方式——微信扫码（浏览器）
- `provider.models`：登录后按账号拉取 `/models`，保留厂商倍率 `(x3.0)`
- 请求：转发 `/chat/completions`，补齐 `token` / `traceparent` / `loomy-version`
  等必需头，思考档位收成 none/low/medium/high/xhigh，deepseek 的图片转成标记
- `auth.usage`：读永久积分与每日赠送积分（v2 接口，失败退回 v1）
- `auth.checkin`：每天调一次 `/points/first-login` 刷新每日赠送积分

**没有实现**：token 续期（Loomy 不发 refresh token，session 固定 14 天，到期只能
重新登录）；新手任务的自动领取。

## 安装

```sh
magpie plugin add ./loomy-plugin
magpie plugin login loomy
magpie plugin            # loomy (Loomy（讯飞）, N models) signed in
magpie provider test loomy
magpie quota
```

在应用里：插件 → 添加插件 → 填这个文件夹的路径，然后在 Loomy 那一行登录。

## 登录方式

只有一种：微信扫码。`magpie plugin login loomy` 会起一个只监听 `127.0.0.1` 的页面
（二维码 + 状态），用微信扫一下并确认即可。微信没绑手机号的账号，页面会让你绑一次。

登录接口（`account.xfinfr.com`）要用官方客户端自带的 access key 做 HMAC-SHA1 签名。
那对常量随客户端分发，但**不写进本仓库**；用插件选项或环境变量提供你那份：

```sh
magpie plugin options opencode-loomy-auth '{"accessKeyId":"…","accessKeySecret":"…"}'
```

或环境变量 `LOOMY_AK_ID` / `LOOMY_AK_SECRET`。

## 登录状态与退出

登录成功后 magpie 把 session 存进 `~/.config/magpie/plugin-auth.json`（权限 600），
重启 magpie 不用重新登录；应用和终端读的是同一份。

- **有效期**：Loomy 只发 14 天 session、没有续期端点。到期后 `usage` 会把账号标成
  「需要重新登录」。
- **再次登录**：`magpie plugin login loomy`，扫码就行；浏览器里没有可复制的令牌，
  别去网页版找。
- **退出账号**：
  - 应用里：插件 → 已安装 → Loomy 的账号行 →「退出登录」
  - 终端里：`magpie plugin logout loomy`
- 退出只删除本地凭据；Loomy 服务端的 session 仍会按自己的 14 天期限失效——
  magpie 的退出流程不会调用厂商的登出接口。

## 插件选项

| 键 | 说明 | 默认 |
|---|---|---|
| `accessKeyId` / `accessKeySecret` | 账号服务签名密钥 | 环境变量，否则无（登录时需要） |
| `modelBase` | 模型网关 | `https://loomyad.xunfei.cn/api/v1` |
| `accountBase` | 账号服务 | `https://account.xfinfr.com` |
| `version` | 发出去的 `loomy-version` | `0.9.38` |

## 沙箱里试

别让正在写的插件碰你真正的 magpie：

```sh
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache \
       MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add ./loomy-plugin </dev/null
m plugin --json
m plugin login loomy
m provider test loomy
m quota
```

## 单元测试

```sh
node --test        # 21 个用例，全部离线，fetch 是 mock 的
```

测试覆盖签名串、思考档位、图片改写、模型映射、二维码 uuid 提取与长轮询状态、
扫码流程（本机页面 → 轮询 → 换 session）、请求头、401 标记、积分 v1/v2 回退和签到。

## 行为细节

- 一个 provider id `loomy`；模型按 `<账号>` 作用域列出，低档套餐不会收到它没有的模型。
- 上游 401 转成带 `X-Magpie-Sign-In: expired` 的 401，magpie 会标记账号；
  403 只有在正文提到登录/会话时才按失效处理，否则原样传回当「模型被拒」。
- 积分：v2 接口返回 `dailyLimitPoints` / `dailyRemainingPoints` 时显示「已用 / 上限」，
  否则只显示余额，不编造上限；永久积分按钱包余额显示。
- `checkin` 每个北京日由 magpie 调一次；没有可领的额度时仍报 `claimed`（接口幂等）。
- 不写任何日志，不保存 session 以外的账号信息。

## 来源与风险

协议来自对官方桌面客户端 0.9.38 的公开逆向记录，以及社区已有的实现（均为 MIT）：

- `haoxinyu1/loomy2api` — 端点、签名串、请求头、积分账本
- `Ebony-Vinyl/dsh-our-free-model` — 微信扫码登录的完整链路（uuid 提取、长轮询状态、
  绑手机号四步）、`type === "chat"` 的模型过滤、思考档位 `none…xhigh`
- `magpie-loomy-auth`（npm）— magpie 钩子映射、v2 积分接口的字段名

**这是非官方客户端。用它把订阅额度接到第三方工具，可能违反 Loomy / 讯飞的服务条款，
账号也可能被风控。** 只在你自己的账号上、自己承担风险地使用。插件不会自动领取
新手任务之类的奖励，那需要真的在客户端里完成对应动作。
