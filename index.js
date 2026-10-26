/**
 * QQ channel adapter for dsh-bili-fav, using Tencent's official QQ Bot API.
 *
 * Targets:
 *   - learned from the official WebSocket gateway (C2C / group events)
 *   - manually entered openids
 *   - optional: when empty, reuse the last successful target
 *
 * Sending (official API):
 *   POST https://api.bot.qq.com/app/getAppAccessToken
 *   GET  https://api.bot.qq.com/gateway
 *   POST https://api.bot.qq.com/v2/groups/{group_openid}/messages
 *   POST https://api.bot.qq.com/v2/users/{user_openid}/messages
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const name = 'bili-fav-qq'
export const inject = ['biliFavChannels']

const API_BASE = 'https://api.bot.qq.com'
const TOKEN_URL = `${API_BASE}/app/getAppAccessToken`
const GATEWAY_PATH = '/gateway'
const CONTENT_LIMIT = 1800
const GROUP_INTENTS = 1 << 25
const MAX_TARGETS = 30
const TARGETS_FILE = 'qq-targets.json'

function trimmed(value, max = 500) {
  return String(value || '').trim().slice(0, max)
}

function shortId(value) {
  const text = String(value || '')
  return text.length > 12 ? `${text.slice(0, 12)}…` : text
}

function normalizeType(value) {
  return value === 'group' || value === 'guild' ? 'group' : value === 'c2c' ? 'c2c' : ''
}

function apiError(label, response, data) {
  const code = data?.err_code ?? data?.code ?? response?.status ?? 'unknown'
  const message = data?.message || data?.msg || ''
  return new Error(`QQ 官方 API ${label}失败：${code}${message ? ` ${message}` : ''}`)
}

function targetKey(type, id) {
  return `${type}|${id}`
}

function sanitizeTarget(value) {
  if (!value || typeof value !== 'object') return null
  const type = normalizeType(value.type)
  const id = trimmed(value.id, 200)
  if (!type || !id) return null
  return {
    type,
    id,
    label: trimmed(value.label, 80),
    lastAt: Number(value.lastAt) || 0,
    msgId: trimmed(value.msgId, 200),
    msgAt: Number(value.msgAt) || 0,
  }
}

function loadStore(dataDir) {
  const file = dataDir ? join(dataDir, TARGETS_FILE) : ''
  const empty = { targets: [], lastTarget: null }
  if (!file) return empty
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const seen = new Set()
    const targets = []
    for (const raw of Array.isArray(parsed?.targets) ? parsed.targets : []) {
      const target = sanitizeTarget(raw)
      if (!target) continue
      const key = targetKey(target.type, target.id)
      if (seen.has(key)) continue
      seen.add(key)
      targets.push(target)
      if (targets.length >= MAX_TARGETS) break
    }
    const last =
      parsed?.lastTarget && typeof parsed.lastTarget === 'object'
        ? sanitizeTarget({ ...parsed.lastTarget, type: parsed.lastTarget.type })
        : null
    return { targets, lastTarget: last ? { type: last.type, id: last.id } : null }
  } catch {
    return empty
  }
}

function saveStore(dataDir, targets, lastTarget) {
  if (!dataDir) return
  const file = join(dataDir, TARGETS_FILE)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(
      file,
      `${JSON.stringify({ targets, lastTarget }, null, 2)}\n`,
      { mode: 0o600 },
    )
  } catch {
    /* persistence is best-effort; targets still work in memory */
  }
}

export function createQQChannel({
  fetchImpl = fetch,
  webSocketImpl = globalThis.WebSocket,
  dataDir = '',
  onFields = () => {},
  readyTimeoutMs = 3000,
  reconnectDelayMs = 5000,
} = {}) {
  const tokenCache = new Map()
  const store = loadStore(dataDir)
  let targets = store.targets
  let lastTarget = store.lastTarget
  let sequence = 0
  let disposed = false
  let gateway = null

  function targetOptions() {
    return [
      { value: '', label: '不指定（用上次成功目标）' },
      ...targets.map((target) => ({
        value: targetKey(target.type, target.id),
        label: `${target.type === 'group' ? '群聊' : '私聊'} · ${target.label || '未命名'} · ${shortId(target.id)}`,
      })),
      { value: '__manual__', label: '手动输入 openid' },
    ]
  }

  const fields = [
    {
      key: 'appId',
      label: 'AppID',
      type: 'text',
      required: true,
      placeholder: 'QQ 开放平台机器人的 AppID',
    },
    {
      key: 'appSecret',
      label: 'ClientSecret',
      type: 'text',
      required: true,
      placeholder: 'QQ 开放平台机器人的 ClientSecret',
      help: '只保存在本机 config.json（0600）；不要发到群聊或日志里。',
    },
    {
      key: 'target',
      label: '目标（可选）',
      type: 'select',
      required: false,
      default: '',
      options: targetOptions(),
      help: '从官方事件网关收到的群/私聊会出现在这里；留空则用上次成功目标。',
    },
    {
      key: 'targetManual',
      label: '手动 openid（可选）',
      type: 'text',
      required: false,
      placeholder: 'user_openid / group_openid',
      help: '只有「目标」选「手动输入 openid」时才使用；也可作为首次的兜底。',
    },
    {
      key: 'targetType',
      label: '手动目标类型',
      type: 'select',
      required: true,
      default: 'c2c',
      options: [
        { value: 'c2c', label: '单聊（user_openid）' },
        { value: 'group', label: '群聊（group_openid）' },
      ],
      help: '从下拉里选的目标会自动带类型；这里只用于手动 openid。',
    },
    {
      key: 'msgId',
      label: '被动回复 msg_id（可选）',
      type: 'text',
      placeholder: '不填 = 自动用最近入站消息 / 主动消息',
      help: '来自最近一条入站事件的 d.id；群聊 5 分钟、单聊 60 分钟内有效。',
    },
  ]

  function publishFields() {
    const targetField = fields.find((field) => field.key === 'target')
    if (targetField) targetField.options = targetOptions()
    try {
      onFields(fields)
    } catch {
      /* the channel may not be registered yet */
    }
  }

  function persist() {
    saveStore(dataDir, targets, lastTarget)
  }

  function addTarget(type, id, label, msgId) {
    const targetType = normalizeType(type)
    const targetId = trimmed(id, 200)
    if (!targetType || !targetId) return
    const existing = targets.find(
      (target) => target.type === targetType && target.id === targetId,
    )
    const entry = existing || { type: targetType, id: targetId, label: '', lastAt: 0, msgId: '', msgAt: 0 }
    if (label) entry.label = trimmed(label, 80)
    entry.lastAt = Date.now()
    if (msgId) {
      entry.msgId = trimmed(msgId, 200)
      entry.msgAt = Date.now()
    }
    targets = [entry, ...targets.filter((target) => target !== entry)].slice(0, MAX_TARGETS)
    lastTarget = { type: targetType, id: targetId }
    persist()
    publishFields()
  }

  function resolveTarget(options = {}) {
    const selected = trimmed(options.target, 300)
    let type = normalizeType(options.targetType || options.scope)
    let id = ''
    if (selected === '__manual__') {
      id = trimmed(options.targetManual, 300)
      type = type || 'c2c'
    } else if (selected.includes('|')) {
      const [selectedType, selectedId] = selected.split('|', 2)
      type = normalizeType(selectedType) || type
      id = trimmed(selectedId, 300)
    } else if (selected) {
      id = selected
    }
    if (!id && lastTarget) {
      type = lastTarget.type
      id = lastTarget.id
    }
    if (!id) {
      throw new Error('QQ 官方 API 缺少目标 openid；请在设置页选一个目标，或手动填 openid')
    }
    type = type === 'group' ? 'group' : 'c2c'
    const known = targets.find((target) => target.type === type && target.id === id)
    let msgId = trimmed(options.msgId, 200)
    if (!msgId && known?.msgId) {
      const windowMs = type === 'group' ? 5 * 60_000 : 60 * 60_000
      if (known.msgAt && Date.now() - known.msgAt <= windowMs) msgId = known.msgId
    }
    return { type, id, label: known?.label || '', msgId }
  }

  async function getAccessToken(appId, appSecret, signal) {
    const cacheKey = `${appId}\u0000${appSecret}`
    const cached = tokenCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token

    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: appSecret }),
      signal,
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || data?.code || !data?.access_token) {
      tokenCache.delete(cacheKey)
      throw apiError('获取 access_token ', response, data)
    }
    const expiresIn = Number(data.expires_in) || 7200
    tokenCache.set(cacheKey, {
      token: data.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    })
    return data.access_token
  }

  async function send(payload, options = {}, { signal } = {}) {
    const appId = trimmed(options.appId, 80)
    const appSecret = trimmed(options.appSecret, 200)
    if (!appId) throw new Error('QQ 官方 API 缺少 AppID')
    if (!appSecret) throw new Error('QQ 官方 API 缺少 ClientSecret')
    const target = resolveTarget(options)
    const content = String(payload?.text || '').trim().slice(0, CONTENT_LIMIT)
    if (!content) throw new Error('QQ 官方 API 没有可发送的文本')

    const token = await getAccessToken(appId, appSecret, signal)
    const path =
      target.type === 'group'
        ? `/v2/groups/${encodeURIComponent(target.id)}/messages`
        : `/v2/users/${encodeURIComponent(target.id)}/messages`
    const body = { msg_type: 0, content }
    if (target.msgId) {
      sequence = (sequence + 1) % 1_000_000_000
      body.msg_id = target.msgId
      body.msg_seq = ((Date.now() % 100_000_000) ^ sequence) % 1_000_000 || 1
    }

    const response = await fetchImpl(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `QQBot ${token}`,
      },
      body: JSON.stringify(body),
      signal,
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || data?.err_code || data?.code) {
      throw apiError('发送', response, data)
    }
    addTarget(target.type, target.id, target.label)
    return {
      ok: true,
      message: `已发送到${target.type === 'group' ? '群聊' : '私聊'}（QQ 官方 API）`,
    }
  }

  function closeGateway() {
    if (!gateway) return
    const state = gateway
    gateway = null
    state.closed = true
    if (state.heartbeat) clearInterval(state.heartbeat)
    if (state.reconnect) clearTimeout(state.reconnect)
    try {
      state.socket?.close()
    } catch {
      /* ignore */
    }
    state.reject?.(new Error('QQ 官方网关已关闭'))
  }

  function listen(socket, event, handler) {
    if (typeof socket.addEventListener === 'function') {
      socket.addEventListener(event, handler)
    } else if (typeof socket.on === 'function') {
      socket.on(event, (data) => handler({ data }))
    }
  }

  function messageText(event) {
    return typeof event?.data === 'string' ? event.data : String(event?.data || '')
  }

  function handleGatewayPayload(state, payload) {
    if (!payload || typeof payload !== 'object') return
    if (payload.s !== undefined) state.seq = payload.s
    if (payload.op === 10) {
      const interval = Number(payload.d?.heartbeat_interval) || 30_000
      state.socket?.send(
        JSON.stringify({
          op: 2,
          d: {
            token: `QQBot ${state.token}`,
            intents: GROUP_INTENTS,
            shard: [0, 1],
          },
        }),
      )
      if (state.heartbeat) clearInterval(state.heartbeat)
      state.heartbeat = setInterval(() => {
        if (state.socket?.readyState === 1) {
          try {
            state.socket.send(JSON.stringify({ op: 1, d: state.seq }))
          } catch {
            /* ignore */
          }
        }
      }, interval)
      return
    }
    if (payload.op === 0) {
      if (payload.t === 'READY' || payload.t === 'RESUMED') {
        state.ready = true
        state.error = null
        state.resolve?.(state)
        return
      }
      ingestEvent(payload.t, payload.d)
      return
    }
    if (payload.op === 7 || payload.op === 9) {
      try {
        state.socket?.close()
      } catch {
        /* ignore */
      }
    }
  }

  function ingestEvent(eventType, data) {
    if (!data || typeof data !== 'object' || data.author?.bot) return
    const author = data.author || {}
    if (author.user_openid) {
      addTarget(
        'c2c',
        author.user_openid,
        author.username || '私聊',
        String(eventType || '').includes('MESSAGE') ? data.id : '',
      )
    } else if (data.group_openid) {
      addTarget(
        'group',
        data.group_openid,
        data.group_name || '群',
        String(eventType || '').includes('MESSAGE') ? data.id : '',
      )
    }
  }

  async function connectGateway(state) {
    const token = await getAccessToken(state.appId, state.appSecret)
    if (disposed || gateway !== state || state.closed) return
    state.token = token
    const response = await fetchImpl(`${API_BASE}${GATEWAY_PATH}`, {
      headers: { authorization: `QQBot ${token}` },
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || !data?.url) {
      throw apiError('获取 WebSocket 网关 ', response, data)
    }
    if (disposed || gateway !== state || state.closed) return
    if (typeof webSocketImpl !== 'function') {
      throw new Error('当前 Node 没有 WebSocket，无法连接 QQ 官方事件网关')
    }
    const socket = new webSocketImpl(data.url)
    state.socket = socket
    listen(socket, 'open', () => {
      /* the server sends HELLO; identify in handleGatewayPayload */
    })
    listen(socket, 'message', (event) => {
      try {
        handleGatewayPayload(state, JSON.parse(messageText(event)))
      } catch {
        /* ignore malformed gateway frames */
      }
    })
    listen(socket, 'error', () => {
      if (state.error) return
      state.error = new Error('QQ 官方事件网关连接失败')
      state.reject?.(state.error)
    })
    listen(socket, 'close', () => {
      if (state.closed || disposed || gateway !== state) return
      state.ready = false
      if (state.heartbeat) clearInterval(state.heartbeat)
      state.heartbeat = null
      state.socket = null
      state.attempts = (state.attempts || 0) + 1
      if (state.attempts > 5) {
        state.reject?.(new Error('QQ 官方事件网关重连失败'))
        return
      }
      state.reconnect = setTimeout(() => {
        if (gateway !== state || disposed || state.closed) return
        connectGateway(state).catch((error) => {
          state.error = error
          state.reject?.(error)
        })
      }, reconnectDelayMs)
    })
  }

  async function ensureGateway(appId, appSecret) {
    if (disposed) throw new Error('QQ 渠道已卸载')
    const key = `${appId}\u0000${appSecret}`
    if (gateway && gateway.key === key && !gateway.closed) {
      await waitForGateway(gateway)
      if (!gateway.error) return gateway
      closeGateway()
    }
    closeGateway()
    const state = {
      key,
      appId,
      appSecret,
      token: '',
      socket: null,
      heartbeat: null,
      reconnect: null,
      seq: null,
      ready: false,
      error: null,
      closed: false,
      attempts: 0,
    }
    state.readyPromise = new Promise((resolve, reject) => {
      state.resolve = resolve
      state.reject = reject
    })
    state.readyPromise.catch(() => {})
    gateway = state
    connectGateway(state).catch((error) => {
      state.error = error
      state.reject?.(error)
    })
    await waitForGateway(state)
    if (state.error) throw state.error
    return state
  }

  async function waitForGateway(state) {
    if (state.ready) return
    await Promise.race([
      state.readyPromise,
      new Promise((resolve) => setTimeout(resolve, readyTimeoutMs)),
    ])
  }

  async function listTargets(options = {}) {
    const appId = trimmed(options.appId, 80)
    const appSecret = trimmed(options.appSecret, 200)
    if (!appId) throw new Error('QQ 官方 API 缺少 AppID')
    if (!appSecret) throw new Error('QQ 官方 API 缺少 ClientSecret')
    const state = await ensureGateway(appId, appSecret)
    return {
      ok: true,
      message: state.ready
        ? `QQ 官方事件网关已连接；已知 ${targets.length} 个目标（收到过消息的群/私聊会自动进下拉）。`
        : `QQ 官方事件网关连接中；已知 ${targets.length} 个目标；收到过消息后会自动进下拉。`,
      targets: targets.map((target) => ({
        type: target.type,
        id: target.id,
        label: target.label,
      })),
    }
  }

  publishFields()

  return {
    id: 'qq',
    label: 'QQ Bot（官方 API）',
    description: '腾讯 QQ 官方 Bot API；目标从官方事件网关收集，也可手动填 openid。',
    order: 10,
    fields,
    available: () => true,
    send,
    listTargets,
    async test(options, { signal } = {}) {
      await send(
        {
          text: [
            '🐟 大肥鱼推荐：QQ 官方 API 联调成功',
            new Date().toLocaleString('zh-CN'),
            '收到这条消息，就说明「B站自主刷片 → 腾讯 QQ 官方 Bot」链路通了。',
          ].join('\n'),
        },
        options,
        { signal },
      )
      return { ok: true, message: 'QQ 官方 API 测试成功' }
    },
    dispose() {
      disposed = true
      closeGateway()
    },
  }
}

export function apply(ctx) {
  const service = ctx.biliFavChannels
  let channel = null
  const onFields = (fields) => {
    try {
      service.updateFields?.('qq', fields)
    } catch {
      /* registry not ready */
    }
  }
  channel = createQQChannel({
    dataDir: service?.dataDir || '',
    onFields,
  })
  ctx.effect(() => {
    const unregister = service.register(channel)
    return () => {
      try {
        unregister()
      } catch {
        /* ignore */
      }
      channel.dispose?.()
    }
  }, 'bili-fav-qq: official QQ channel')
}
