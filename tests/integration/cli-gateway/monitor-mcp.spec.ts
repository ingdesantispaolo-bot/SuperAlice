import { serve } from '@hono/node-server'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { join } from 'node:path'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { expect, it } from 'vitest'
import { ToolCenter } from '../../../src/core/tool-center.js'
import { registerProjectCliRoutes } from '../../../src/server/project-cli.js'
import { createMonitorMcpTools } from '../../../src/tool/monitor-mcp.js'
import type { MonitorMcpClient } from '../../../src/domain/analysis/monitor-mcp.js'

it('preserves monitor evidence and errors through the actual Project CLI with numeric flags', async () => {
  let received: Record<string, unknown> = {}
  const text = '{ "error":"monitor_unavailable", "message":"Monitor stopped" }'
  const result = { content: [{ type: 'text', text }], structuredContent: JSON.parse(text), isError: true,
    _meta: { 'ibivmonitor/sha256': createHash('sha256').update(text).digest('hex') } }
  const fake = {
    discover: async () => [{ name: 'history_daily', description: 'Daily cache', inputSchema: {
      type: 'object', additionalProperties: false, required: ['id'], properties: {
        id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10000, default: 500 },
      },
    } }],
    call: async (_name: string, args: Record<string, unknown>) => { received = args; return result },
  } as unknown as MonitorMcpClient
  const center = new ToolCenter(); center.register(await createMonitorMcpTools(fake), 'monitor-mcp')
  const app = new Hono(); registerProjectCliRoutes(app, center, { id: 'fixture-project' } as never)
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  if (!server.listening) await new Promise<void>(done => server.once('listening', done))
  const address = server.address() as { port: number }
  const execute = (args: string[]) => promisify(execFile)(process.execPath,
    [resolve('src/workspaces/cli/bin/openalice-cli.cjs'), ...args], {
      env: { ...process.env, OPENALICE_CLI_BIN: 'alice', AQ_WS_ID: '', OPENALICE_TOOL_SOCKET: '',
        OPENALICE_PROJECT_ID: 'fixture-project', OPENALICE_TOOL_URL: `http://127.0.0.1:${address.port}/cli` }, timeout: 10_000,
    })
  try {
    expect((await execute(['monitor', 'history-daily', '--help'])).stdout).toContain('--limit')
    const failure = await execute(['monitor', 'history-daily', '--id', 'fixture', '--limit', '300']).catch(e => e)
    expect(failure.code).toBe(1)
    const envelope = JSON.parse(failure.stdout)
    expect(envelope.content).toEqual(result.content)
    expect(envelope._meta).toEqual(result._meta)
    expect(envelope.isError).toBe(true)
    expect(received).toEqual({ id: 'fixture', limit: 300 })
    const invalid = await execute(['monitor', 'history-daily', '--id', 'fixture', '--limit', '10001']).catch(e => e)
    expect(invalid.stderr).toContain('Validation failed')
  } finally {
    if ('closeAllConnections' in server) server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
})

it('persists news pages before the cursor across runs and retains it on errors or damaged evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'monitor-news-reader-'))
  await mkdir(join(root, '.alice'))
  const rows = [1, 2, 3].map(seq => ({seq, provider: 'DJ-N', articleId: `article-${seq}`, at: '2026-10-13T10:00:00Z'}))
  let failure: 'none' | 'remote' | 'hash' = 'none'
  const fake = {
    discover: async () => [{name: 'news_latest', inputSchema: {type: 'object', additionalProperties: false, properties: {
      cursor: {type: 'integer', minimum: 0}, limit: {type: 'integer', minimum: 1, maximum: 1000, default: 200},
      symbols: {type: 'array', items: {type: 'string'}},
    }}}],
    call: async (_name: string, args: {cursor?: number; limit: number}) => {
      const items = rows.filter(row => row.seq > (args.cursor ?? 0)).slice(0, args.limit)
      const payload = failure === 'remote' ? {error: 'news_unavailable'} : {
        schema: 'ibivmonitor.news-latest/1', cursor: args.cursor ?? 0,
        nextCursor: items.at(-1)?.seq ?? args.cursor ?? 0, count: items.length, items, hasMore: items.length === args.limit,
      }
      const text = JSON.stringify(payload)
      return {content: [{type: 'text', text}], structuredContent: payload, isError: failure === 'remote',
        _meta: {'ibivmonitor/sha256': failure === 'hash' ? '0'.repeat(64) : createHash('sha256').update(text).digest('hex')}}
    },
  } as unknown as MonitorMcpClient
  const center = new ToolCenter(); center.register(await createMonitorMcpTools(fake), 'monitor-mcp')
  const app = new Hono(); registerProjectCliRoutes(app, center, {id: 'news-fixture'} as never)
  const server = serve({fetch: app.fetch, hostname: '127.0.0.1', port: 0})
  if (!server.listening) await new Promise<void>(done => server.once('listening', done))
  const script = resolve('default/skills/alice-analysis/scripts/read-monitor-news.mjs')
  const execute = (extra: string[] = []) => promisify(execFile)(process.execPath,
    [script, '--bootstrap', 'all', '--limit', '2', '--max-pages', '1', ...extra], {
      cwd: root, timeout: 10_000, env: {...process.env, AQ_WS_ID: 'project', OPENALICE_PROJECT_ID: 'news-fixture',
        OPENALICE_TOOL_URL: `http://127.0.0.1:${(server.address() as {port: number}).port}/cli`},
    })
  try {
    const first = JSON.parse((await execute()).stdout)
    expect(first).toMatchObject({nextCursor: 2, hasMore: true})
    let saved = JSON.parse(await readFile(join(root, first.cursorFile), 'utf8'))
    expect(saved.nextCursor).toBe(2)
    const firstPage = JSON.parse(await readFile(join(root, first.pages[0]), 'utf8'))
    expect(firstPage.structuredContent.items.map((row: {seq: number}) => row.seq)).toEqual([1, 2])
    failure = 'remote'
    await expect(execute()).rejects.toMatchObject({code: 1})
    expect(JSON.parse(await readFile(join(root, first.cursorFile), 'utf8')).nextCursor).toBe(2)
    failure = 'hash'
    await expect(execute()).rejects.toMatchObject({code: 1})
    expect(JSON.parse(await readFile(join(root, first.cursorFile), 'utf8')).nextCursor).toBe(2)
    failure = 'none'
    const second = JSON.parse((await execute()).stdout)
    expect(second.nextCursor).toBe(3)
    const secondPage = JSON.parse(await readFile(join(root, second.pages[0]), 'utf8'))
    expect(secondPage.structuredContent.items.map((row: {seq: number}) => row.seq)).toEqual([3])
    // Historical backfill is still a new archive arrival; collection must not lose it.
    rows.push({seq: 4, provider: 'DJ-N', articleId: 'older-backfill', at: '2023-10-13T10:00:00Z'})
    const third = JSON.parse((await execute()).stdout)
    expect(third.nextCursor).toBe(4)
    saved = JSON.parse(await readFile(join(root, first.cursorFile), 'utf8'))
    expect(saved.pages).toHaveLength(3)
    const filtered = JSON.parse((await execute(['--symbols', 'JPM'])).stdout)
    expect(filtered.cursorFile).not.toBe(first.cursorFile)
    expect(JSON.parse(await readFile(join(root, first.cursorFile), 'utf8')).nextCursor).toBe(4)
  } finally {
    if ('closeAllConnections' in server) server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
    await rm(root, {recursive: true, force: true})
  }
})
