import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, createQQChannel, inject } from '../index.js'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeFetch({ token = 'tok', tokenError = null, sendBody = { id: 'msg' } } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    if (url.endsWith('/app/getAppAccessToken')) {
      return jsonResponse(tokenError || { access_token: token, expires_in: '7200' })
    }
    return jsonResponse(sendBody)
  }
  return { fetchImpl, calls }
}

test('adapter registers the official QQ channel', () => {
  let registered = null
  const ctx = {
    effect(fn) {
      return fn()
    },
    biliFavChannels: {
      register(channel) {
        registered = channel
        return () => {}
      },
    },
  }
  apply(ctx)
  assert.deepEqual(inject, ['biliFavChannels'])
  assert.equal(registered.id, 'qq')
  assert.match(registered.label, /官方 API/)
  assert.equal(registered.available(), true)
  assert.deepEqual(
    registered.fields.map((field) => field.key),
    ['appId', 'appSecret', 'target', 'targetManual', 'targetType', 'msgId'],
  )
})

test('gets a token and sends a c2c text message', async () => {
  const { fetchImpl, calls } = makeFetch()
  const channel = createQQChannel({ fetchImpl })
  const result = await channel.send(
    { text: 'hello official api' },
    {
      appId: 'app-1',
      appSecret: 'secret-1',
      target: 'F7064591749C2E1DDDD98D73CC209517',
      targetType: 'c2c',
    },
  )
  assert.equal(result.message, '已发送到私聊（QQ 官方 API）')
  assert.equal(calls.length, 2)
  assert.match(calls[0].url, /\/app\/getAppAccessToken$/)
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    appId: 'app-1',
    clientSecret: 'secret-1',
  })
  assert.equal(
    calls[1].url,
    'https://api.bot.qq.com/v2/users/F7064591749C2E1DDDD98D73CC209517/messages',
  )
  assert.equal(calls[1].init.headers.authorization, 'QQBot tok')
  assert.match(calls[1].init.headers['content-type'], /application\/json/)
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    msg_type: 0,
    content: 'hello official api',
  })
})

test('sends group messages, reuses the token, and includes passive msg_id', async () => {
  const { fetchImpl, calls } = makeFetch()
  const channel = createQQChannel({ fetchImpl })
  const options = {
    appId: 'app-1',
    appSecret: 'secret-1',
    target: 'group-openid',
    targetType: 'group',
    msgId: 'ROBOT1.0_inbound',
  }
  await channel.send({ text: 'first' }, options)
  await channel.send({ text: 'second' }, options)
  assert.equal(calls.filter((call) => call.url.endsWith('/getAppAccessToken')).length, 1)
  const sends = calls.filter((call) => !call.url.endsWith('/getAppAccessToken'))
  assert.equal(sends.length, 2)
  assert.equal(sends[0].url, 'https://api.bot.qq.com/v2/groups/group-openid/messages')
  const first = JSON.parse(sends[0].init.body)
  const second = JSON.parse(sends[1].init.body)
  assert.equal(first.msg_id, 'ROBOT1.0_inbound')
  assert.equal(second.msg_id, 'ROBOT1.0_inbound')
  assert.notEqual(first.msg_seq, second.msg_seq)
})

test('accepts the legacy scope field and sends a test message', async () => {
  const { fetchImpl, calls } = makeFetch()
  const channel = createQQChannel({ fetchImpl })
  const result = await channel.test({
    appId: 'app-1',
    appSecret: 'secret-1',
    target: 'user-openid',
    scope: 'c2c',
  })
  assert.equal(result.message, 'QQ 官方 API 测试成功')
  assert.equal(
    calls[1].url,
    'https://api.bot.qq.com/v2/users/user-openid/messages',
  )
  assert.match(JSON.parse(calls[1].init.body).content, /QQ 官方 API 联调成功/)
})

test('surfaces official token and send errors', async () => {
  const tokenFailure = makeFetch({
    tokenError: { code: 100016, message: 'invalid appid or secret' },
  })
  await assert.rejects(
    () =>
      createQQChannel({ fetchImpl: tokenFailure.fetchImpl }).send(
        { text: 'x' },
        { appId: 'a', appSecret: 'b', target: 't', targetType: 'c2c' },
      ),
    /100016.*invalid appid or secret/,
  )

  const sendFailure = makeFetch({
    sendBody: { err_code: 40034105, message: '主动消息发送失败，无权限' },
  })
  await assert.rejects(
    () =>
      createQQChannel({ fetchImpl: sendFailure.fetchImpl }).send(
        { text: 'x' },
        { appId: 'a', appSecret: 'b', target: 't', targetType: 'c2c' },
      ),
    /40034105.*无权限/,
  )
})

test('validates required configuration before calling the network', async () => {
  const channel = createQQChannel()
  await assert.rejects(() => channel.send({ text: 'x' }, {}), /AppID/)
  await assert.rejects(
    () => channel.send({ text: 'x' }, { appId: 'a' }),
    /ClientSecret/,
  )
  await assert.rejects(
    () => channel.send({ text: 'x' }, { appId: 'a', appSecret: 'b' }),
    /目标 openid/,
  )
  await assert.rejects(
    () =>
      channel.send(
        { text: '   ' },
        { appId: 'a', appSecret: 'b', target: 't', targetType: 'c2c' },
      ),
    /没有可发送/,
  )
})
