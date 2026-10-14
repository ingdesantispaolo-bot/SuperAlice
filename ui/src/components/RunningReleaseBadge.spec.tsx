import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { VersionInfo } from '../api/types'
import { i18n } from '../i18n'

const mocks = vi.hoisted(() => ({ info: null as VersionInfo | null, error: null as string | null }))
vi.mock('../hooks/useUpdateLifecycle', () => ({ useUpdateLifecycle: () => ({ versionInfo: mocks.info, versionError: mocks.error }) }))
import { RunningReleaseBadge } from './RunningReleaseBadge'

beforeAll(async () => { await i18n.changeLanguage('en') })
beforeEach(() => {
  mocks.error = null
  mocks.info = {
    current: '0.95.0-beta', channel: 'dev', updateAuthority: 'source',
    runningBuild: { commit: 'a'.repeat(40), committedAt: '2026-10-12T15:14:00.000Z', dirty: false },
    latest: '0.96.0-beta', hasUpdate: true, decision: null, releaseUrl: null,
    releaseNotes: null, publishedAt: '2026-11-01T12:00:00.000Z', error: null,
  }
})
afterEach(cleanup)

it('shows the running revision and its date instead of the available remote release', () => {
  render(<RunningReleaseBadge />)
  const badge = screen.getByRole('region', { name: 'Running version' })
  expect(badge.textContent).toContain('SuperAlice · v0.95.0-beta')
  expect(badge.textContent).toContain('aaaaaaaa')
  expect(badge.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-12T15:14:00.000Z')
  expect(badge.textContent).not.toContain('0.96.0-beta')
  expect(badge.textContent).not.toContain('Local changes')
})

it('makes an uncommitted checkout visible', () => {
  mocks.info!.runningBuild!.dirty = true
  render(<RunningReleaseBadge />)
  expect(screen.getByText('Local changes')).toBeTruthy()
})

it.each([undefined, null])('shows an unavailable date on older or packaged backends (%s)', (build) => {
  mocks.info!.runningBuild = build
  render(<RunningReleaseBadge />)
  expect(screen.getByText('Update date unavailable')).toBeTruthy()
  expect(screen.getByRole('region').querySelector('time')).toBeNull()
})

it('does not display identity from an unavailable backend', () => {
  mocks.error = 'Backend unavailable'
  render(<RunningReleaseBadge />)
  expect(screen.queryByRole('region')).toBeNull()
})

it('handles invalid timestamps without showing an invalid date', () => {
  mocks.info!.runningBuild!.committedAt = 'invalid'
  render(<RunningReleaseBadge />)
  expect(screen.getByText('Update date unavailable')).toBeTruthy()
})
