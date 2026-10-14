import { describe, expect, it, vi } from 'vitest'
import { captureRunningBuild } from './running-build.js'

describe('running source build identity', () => {
  it('keeps the captured identity when HEAD moves without a backend reload', () => {
    let head = 'a'.repeat(40)
    const runGit = vi.fn((args: readonly string[]) => args[0] === 'show'
      ? `${head}\n2026-10-12T17:14:00+02:00\n` : '')
    const snapshot = captureRunningBuild({ appRoot: '/source', env: { OPENALICE_LAUNCHER: 'dev' }, runGit })
    head = 'b'.repeat(40)
    expect(snapshot).toEqual({ commit: 'a'.repeat(40), committedAt: '2026-10-12T15:14:00.000Z', dirty: false })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(runGit).toHaveBeenCalledTimes(2)
  })

  it('marks local changes instead of presenting the checkout as a clean release', () => {
    const runGit = (args: readonly string[]) => args[0] === 'show'
      ? `${'a'.repeat(40)}\n2026-10-12T15:14:00Z\n` : ' M src/main.ts\n?? src/new-feature.ts\n'
    expect(captureRunningBuild({ appRoot: '/source', env: { OPENALICE_LAUNCHER: 'dev' }, runGit })?.dirty).toBe(true)
  })

  it.each([
    { OPENALICE_RUNTIME_PROFILE: 'electron-packaged' },
    { OPENALICE_RUNTIME_PROFILE: 'docker' },
    { OPENALICE_RUNTIME_PROFILE: 'cli-server' },
    {},
    { OPENALICE_INSTALL_SOURCE: '/installed/receipt.json' },
  ])('does not use surrounding Git metadata for an installed runtime (%j)', (env) => {
    const runGit = vi.fn()
    expect(captureRunningBuild({ appRoot: '/installed', env, runGit })).toBeNull()
    expect(runGit).not.toHaveBeenCalled()
  })

  it.each(['bad\n2026-10-12T15:14:00Z', `${'a'.repeat(40)}\nnot-a-date`])('does not invent missing identity or dates', (output) => {
    expect(captureRunningBuild({ appRoot: '/source', env: { OPENALICE_LAUNCHER: 'dev' }, runGit: () => output })).toBeNull()
  })

  it('tolerates missing Git without replacing the date with the startup time', () => {
    expect(captureRunningBuild({ appRoot: '/source', env: { OPENALICE_LAUNCHER: 'dev' }, runGit: () => { throw new Error('git unavailable') } })).toBeNull()
  })
})
