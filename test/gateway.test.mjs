import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQQChannel } from '../index.js'

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

class FakeWebSocket {
  static instances = []

  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.listeners = {}
    FakeWebSocket.instances.push(this)
  }

  addEventListener(name, fn) {
    ;(this.listeners[name] ||= []).push(fn)
  }

  emit(name, event) {
    for (const fn of this.listeners[name] || []) fn(event)
  }

  send(data) {
    this.sent.push(data)
  }

  open() {
    this.readyState = 1
    this.emit('open', {})
  }

  message(payload) {
    this.emit('message', { data: JSON.stringify(payload) })
  }

  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close', {})
  }

  static reset() {
    this.instances = []
  }
}

function makeFetch() {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    if (url.endsWith('/app/getAppAccessToken')) {
      return json({ access_token: 'tok', expires_in: '7200' })
    }
    if (url.endsWith('/gateway')) return json({ url: 'wss://gateway.example' })
    return json({ id: 'outbound-msg' })
  }
  return { fetchImpl, calls }
}

async function waitFor(predicate, timeout = 1000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('official gateway events fill the target dropdown and persist', async () => {
  FakeWebSocket.reset()
  const { fetchImpl } = makeFetch()
  const dir = mkdtempSync(join(tmpdir(), 'bili-fav-qq-'))
  let fields = null
  const channel = createQQChannel({
    fetchImpl,
    webSocketImpl: FakeWebSocket,
    dataDir: dir,
    readyTimeoutMs: 100,
    reconnectDelayMs: 10,
    onFields: (next) => {
      fields = next
    },
  })
  try {
    const pending = channel.listTargets({ appId: 'app', appSecret: 'secret' })
    await waitFor(() => FakeWebSocket.instances.length === 1)
    const socket = FakeWebSocket.instances[0]
    socket.open()
    socket.message({ op: 10, d: { heartbeat_interval: 60_000 } })
    const identify = socket.sent
      .map((frame) => JSON.parse(frame))
      .find((frame) => frame.op === 2)
    assert.equal(identify.d.token, 'QQBot tok')
    assert.equal(identify.d.intents, 1 << 25)

    socket.message({ op: 0, t: 'READY', d: {} })
    socket.message({
      op: 0,
      t: 'C2C_MESSAGE_CREATE',
      d: { id: 'm1', author: { user_openid: 'user1', username: 'Alice' } },
    })
    socket.message({
      op: 0,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'm2',
        group_openid: 'group1',
        author: { member_openid: 'member1', username: 'Bob' },
      },
    })

    const result = await pending
    assert.equal(result.targets.length, 2)
    assert.deepEqual(
      result.targets.map((target) => `${target.type}|${target.id}`).sort(),
      ['c2c|user1', 'group|group1'],
    )
    const targetField = fields.find((field) => field.key === 'target')
    assert.ok(targetField.options.some((option) => option.value === 'c2c|user1'))
    assert.ok(targetField.options.some((option) => option.value === 'group|group1'))
    assert.ok(targetField.options.some((option) => option.value === '__manual__'))

    const reloaded = createQQChannel({ fetchImpl, webSocketImpl: FakeWebSocket, dataDir: dir })
    const reloadedTargets = reloaded.fields.find((field) => field.key === 'target').options
    assert.ok(reloadedTargets.some((option) => option.value === 'c2c|user1'))
    assert.ok(reloadedTargets.some((option) => option.value === 'group|group1'))
    reloaded.dispose()
  } finally {
    channel.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('learned msg_id is reused for a passive reply; empty target falls back to last', async () => {
  const { fetchImpl, calls } = makeFetch()
  const dir = mkdtempSync(join(tmpdir(), 'bili-fav-qq-'))
  writeFileSync(
    join(dir, 'qq-targets.json'),
    JSON.stringify({
      targets: [
        {
          type: 'c2c',
          id: 'user1',
          label: 'Alice',
          msgId: 'm1',
          msgAt: Date.now(),
          lastAt: Date.now(),
        },
      ],
      lastTarget: { type: 'c2c', id: 'user1' },
    }),
  )
  const channel = createQQChannel({ fetchImpl, webSocketImpl: FakeWebSocket, dataDir: dir })
  try {
    const result = await channel.send(
      { text: 'hello' },
      { appId: 'app', appSecret: 'secret', target: '', targetType: 'c2c' },
    )
    assert.match(result.message, /QQ 官方 API/)
    const sendCall = calls.find((call) => call.url.includes('/v2/users/user1/messages'))
    const body = JSON.parse(sendCall.init.body)
    assert.equal(body.msg_id, 'm1')
    assert.ok(body.msg_seq >= 1)
  } finally {
    channel.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('manual target is stored and becomes the last-target fallback', async () => {
  const { fetchImpl, calls } = makeFetch()
  const dir = mkdtempSync(join(tmpdir(), 'bili-fav-qq-'))
  const channel = createQQChannel({ fetchImpl, webSocketImpl: FakeWebSocket, dataDir: dir })
  try {
    await channel.send(
      { text: 'first' },
      {
        appId: 'app',
        appSecret: 'secret',
        target: '__manual__',
        targetManual: 'manual-user',
        targetType: 'c2c',
      },
    )
    await channel.send(
      { text: 'second' },
      { appId: 'app', appSecret: 'secret', target: '', targetType: 'c2c' },
    )
    const sends = calls.filter((call) => !call.url.endsWith('/getAppAccessToken'))
    assert.equal(sends.length, 2)
    assert.ok(sends.every((call) => call.url.includes('/v2/users/manual-user/messages')))
    assert.equal(JSON.parse(sends[0].init.body).msg_id, undefined)
  } finally {
    channel.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
