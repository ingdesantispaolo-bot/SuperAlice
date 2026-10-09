import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGitFileWriter } from './git-persistence.js'
import type { GitExportState } from './git/types.js'

function stateWithHead(head: string): GitExportState {
  return { commits: [], head }
}

describe('createGitFileWriter', () => {
  let dir: string

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'uta-git-writer-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('writes the state and leaves no temporary file behind', async () => {
    const file = join(dir, 'trading', 'acc', 'commit.json')
    await createGitFileWriter(file)(stateWithHead('aaaa1111'))

    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual(stateWithHead('aaaa1111'))
    expect(await readdir(join(dir, 'trading', 'acc'))).toEqual(['commit.json'])
  })

  it('serializes overlapping writes so the last state wins', async () => {
    const file = join(dir, 'commit.json')
    const write = createGitFileWriter(file)

    await Promise.all(['h1', 'h2', 'h3', 'h4'].map((head) => write(stateWithHead(head))))

    expect(JSON.parse(await readFile(file, 'utf-8')).head).toBe('h4')
    expect(await readdir(dir)).toEqual(['commit.json'])
  })
})
