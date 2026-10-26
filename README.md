# dsh-bili-fav-qq

`dsh-bili-fav`（[核心仓库](https://github.com/mswinandmc/dsh-bili-fav)）的 **QQ 渠道适配器**，直接调用**腾讯 QQ 官方 Bot API**。

- 发送：官方 HTTP API（不需要 DSH QQ Bot 插件 / `qq_send__*`）
- 目标：官方 WebSocket 事件网关自动收集群/私聊；也可手动填 openid
- target 可选：留空时用上次成功目标
- 最近入站消息的 `msg_id` 会自动用于被动回复（在 5/60 分钟窗口内）

## 安装

先安装/启用 `dsh-bili-fav`，再安装本包：

```bash
dsh plugin add https://github.com/mswinandmc/dsh-bili-fav-qq
# 或本地目录：dsh plugin add /path/to/dsh-bili-fav-qq
```

安装并启用后，核心设置页「投递方式 → 只 QQ / 都要」里会出现 **QQ Bot（官方 API）**。

## 配置

| 字段 | 说明 |
|---|---|
| AppID | QQ 开放平台机器人的 AppID |
| ClientSecret | 机器人的 ClientSecret；只保存在本机 `config.json`（0600） |
| 目标（可选） | 下拉：官方事件网关收到过的群/私聊；`不指定` = 用上次成功目标；`手动输入 openid` = 用下面的手动字段 |
| 手动 openid | `user_openid` / `group_openid`，仅「目标」选手动时使用；首次冷启动的兜底 |
| 手动目标类型 | 单聊 `c2c` / 群聊 `group`，仅手动 openid 用 |
| 被动回复 msg_id | 可选；不填时自动用该目标最近入站消息的 `msg_id`（窗口内），否则走主动消息 |

### 读取目标

点「读取目标」会：

1. 用 AppID/ClientSecret 获取 access_token；
2. `GET https://api.bot.qq.com/gateway` 拿官方 WebSocket 地址；
3. 带 `intents = 1 << 25`（群/单聊事件）连接并心跳；
4. 把 `C2C_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE` / 加群事件里的 openid 存进下拉；
5. 目标落盘到核心数据目录的 `qq-targets.json`（0600），重启后仍在下拉里。

注意：**官方没有“列出全部群/私聊”的 REST 接口**，所以：

- 冷启动时下拉是空的，机器人必须先收到过消息（或手动填 openid）；
- 同一个 Bot 同时只建议开一个 WebSocket 网关客户端；如果 DSH QQ Bot 插件也在连同一个 AppID，先停掉其中一个，避免会话冲突。

## 官方接口

```text
POST https://api.bot.qq.com/app/getAppAccessToken
  { "appId": "...", "clientSecret": "..." }

GET  https://api.bot.qq.com/gateway
  Authorization: QQBot <access_token>

POST https://api.bot.qq.com/v2/groups/{group_openid}/messages
POST https://api.bot.qq.com/v2/users/{user_openid}/messages
  Authorization: QQBot <access_token>
  { "msg_type": 0, "content": "...", "msg_id": "...", "msg_seq": 1 }
```

- access_token 有效期约 7200 秒；缓存并在过期前 60 秒刷新。
- 群聊被动回复 5 分钟 / 5 次；单聊被动回复 60 分钟 / 4 次。
- 主动消息受 Bot/单关系频控与权限限制；错误会显示官方 `err_code` / `message`。

参考：[获取访问凭证](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)、[发送群聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)、[发送单聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)。

## 渠道 API

本包仍是 `biliFavChannels` 渠道 API 的参考实现；渠道可以动态更新下拉：

```js
export const inject = ['biliFavChannels']

export function apply(ctx) {
  ctx.effect(() => ctx.biliFavChannels.register({
    id: 'demo',
    label: 'Demo',
    fields: [{ key: 'target', label: '目标', type: 'select', options: [] }],
    async send(payload, options) {
      return { ok: true, message: `sent to ${options.target}` }
    },
    listTargets() {
      return { ok: true, message: 'loaded', targets: [{ type: 'c2c', id: 'x', label: 'X' }] }
    },
  }))
}
```

核心只负责选择渠道、渲染字段、调用 `send/listTargets/test`，不 import 任何渠道包。
