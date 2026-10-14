import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface RunningBuildInfo {
  commit: string
  committedAt: string
  dirty: boolean
}

interface SnapshotOptions {
  appRoot: string
  env: Readonly<Record<string, string | undefined>>
  runGit?: (args: readonly string[]) => string
}

/** Capture once when the backend loads. Reading HEAD on every HTTP request
 * would falsely label an old process with a newer checkout's identity. */
export function captureRunningBuild({ appRoot, env, runGit }: SnapshotOptions): Readonly<RunningBuildInfo> | null {
  const profile = env.OPENALICE_RUNTIME_PROFILE ?? env.OPENALICE_LAUNCHER
  // A compiled bundle may run inside a newer checkout. Only the explicit
  // source-development launcher proves that Git describes the loaded source.
  if (profile !== 'dev' || env.OPENALICE_INSTALL_SOURCE) return null
  if (!runGit && !existsSync(resolve(appRoot, '.git'))) return null
  const git = runGit ?? ((args: readonly string[]) => execFileSync('git', ['-C', appRoot, ...args], {
    encoding: 'utf8', timeout: 1500, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  }))
  try {
    const [commit, committedAt] = git(['show', '-s', '--format=%H%n%cI', 'HEAD']).trim().split(/\r?\n/)
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit ?? '') || !Number.isFinite(Date.parse(committedAt ?? ''))) return null
    const dirty = git(['status', '--porcelain', '--untracked-files=normal']).trim().length > 0
    return Object.freeze({ commit, committedAt: new Date(committedAt).toISOString(), dirty })
  } catch {
    return null
  }
}

// Version reads must not initialize user-data paths before runtime ownership
// and test fixtures choose their home. Resolve only this module's app source.
export const runningBuild = captureRunningBuild({
  appRoot: process.env.OPENALICE_APP_HOME ?? fileURLToPath(new URL('../../', import.meta.url)),
  env: process.env,
})
