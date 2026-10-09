/**
 * Git state persistence — load/save Trading-as-Git commit history.
 *
 * Extracted from main.ts. Pure functions + file IO, no instance dependencies.
 */

import { readFile, writeFile, mkdir, rename } from 'fs/promises'
import { dirname } from 'path'
import type { GitExportState } from './git/types.js'
import { dataPath } from '@/core/paths.js'

// ==================== Paths ====================

function gitFilePath(accountId: string): string {
  return dataPath('trading', accountId, 'commit.json')
}

/** Legacy paths for backward compat. TODO: remove before v1.0 */
const LEGACY_GIT_PATHS: Record<string, string> = {
  'bybit-main': dataPath('crypto-trading', 'commit.json'),
  'alpaca-paper': dataPath('securities-trading', 'commit.json'),
  'alpaca-live': dataPath('securities-trading', 'commit.json'),
}

// ==================== Public API ====================

/** Read saved git state from disk, trying primary path then legacy fallback. */
export async function loadGitState(accountId: string): Promise<GitExportState | undefined> {
  const primary = gitFilePath(accountId)
  try {
    return JSON.parse(await readFile(primary, 'utf-8')) as GitExportState
  } catch { /* try legacy */ }
  const legacy = LEGACY_GIT_PATHS[accountId]
  if (legacy) {
    try {
      return JSON.parse(await readFile(legacy, 'utf-8')) as GitExportState
    } catch { /* no saved state */ }
  }
  return undefined
}

/**
 * Create a callback that persists git state to disk on each commit.
 *
 * Write-then-rename: a crash mid-write leaves the previous file intact
 * instead of a truncated one — `loadGitState` would read a truncated file
 * as "no saved state" and the account would restart with an empty log,
 * losing every pending order and unresolved outcome.
 */
export function createGitPersister(accountId: string): (state: GitExportState) => Promise<void> {
  return createGitFileWriter(gitFilePath(accountId))
}

/** Atomic JSON writer for a git state file (exported for tests). Writes are
 *  serialized so overlapping commits never race on the temporary file. */
export function createGitFileWriter(filePath: string): (state: GitExportState) => Promise<void> {
  const tmpPath = `${filePath}.tmp`
  let queue: Promise<void> = Promise.resolve()
  return (state: GitExportState) => {
    const json = JSON.stringify(state, null, 2)
    const write = queue.then(async () => {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(tmpPath, json)
      await rename(tmpPath, filePath)
    })
    queue = write.catch(() => {})
    return write
  }
}
