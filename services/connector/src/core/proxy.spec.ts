import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { getGlobalDispatcher, request as discordRequest } from 'undici6'
import { request as slackRequest } from 'undici'

import {
  installConnectorProxyTransport,
  proxyUrlFor,
  resolveConnectorProxySettings,
  type ConnectorProxyTransport,
} from './proxy.js'

describe('Connector proxy transport', () => {
  const transports: ConnectorProxyTransport[] = []

  afterEach(async () => {
    await Promise.all(transports.splice(0).map((transport) => transport.close()))
  })

  it('normalizes upper/lower-case proxy env with standard fallbacks', () => {
    expect(resolveConnectorProxySettings({
      http_proxy: 'http://http-proxy:8080',
      HTTPS_PROXY: 'https://https-proxy:8443',
      no_proxy: 'localhost,.internal.test',
    })).toEqual({
      httpProxy: 'http://http-proxy:8080',
      httpsProxy: 'https://https-proxy:8443',
      noProxy: 'localhost,.internal.test',
    })
    expect(resolveConnectorProxySettings({ ALL_PROXY: 'http://shared:7890' })).toEqual({
      httpProxy: 'http://shared:7890',
      httpsProxy: 'http://shared:7890',
    })
  })

  it('ignores malformed and unsupported proxy protocols', () => {
    expect(resolveConnectorProxySettings({ ALL_PROXY: 'socks5://127.0.0.1:1080' })).toEqual({})
    expect(resolveConnectorProxySettings({ HTTPS_PROXY: 'not a URL' })).toEqual({})
  })

  it('honors NO_PROXY host, subdomain, and port rules', () => {
    const settings = {
      httpProxy: 'http://proxy:7890',
      httpsProxy: 'http://proxy:7890',
      noProxy: 'localhost,.internal.test,api.example:8443',
    }
    expect(proxyUrlFor('http://localhost/health', settings)).toBe('')
    expect(proxyUrlFor('https://worker.internal.test/task', settings)).toBe('')
    expect(proxyUrlFor('https://api.example:8443/task', settings)).toBe('')
    expect(proxyUrlFor('https://api.example/task', settings)).toBe('http://proxy:7890')
  })

  it('installs and restores the Connector process dispatcher', async () => {
    const previous = getGlobalDispatcher()
    const transport = installConnectorProxyTransport({ HTTPS_PROXY: 'http://proxy:7890' })
    transports.push(transport)
    expect(transport.active).toBe(true)
    expect(getGlobalDispatcher()).toBe(transport.dispatcher)
    expect(transport.nodeFetchAgent?.(new URL('https://api.telegram.org'))).toBeDefined()
    await transport.close()
    expect(getGlobalDispatcher()).toBe(previous)
  })

  it('honors NO_PROXY with both SDK dispatchers and closes their connections', async () => {
    const server = createServer((_req, res) => res.end('local fixture'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const transport = installConnectorProxyTransport({
      HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '*',
    })
    transports.push(transport)
    try {
      const url = `http://127.0.0.1:${address.port}`
      const discord = await discordRequest(url, { dispatcher: transport.dispatcher })
      expect(await discord.body.text()).toBe('local fixture')
      const slack = await slackRequest(url, { dispatcher: transport.slackDispatcher })
      expect(await slack.body.text()).toBe('local fixture')
    } finally {
      await transport.close()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})
