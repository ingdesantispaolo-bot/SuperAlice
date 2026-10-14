import { describe, expect, it, vi } from 'vitest'
import { SnapshotBudget, twsSnapshotBudget } from './snapshot-budget.js'

describe('shared TWS snapshot budget', () => {
  it('caps concurrent consumers, hands the slot to the first waiter and releases only once', async () => {
    const budget = new SnapshotBudget(2)
    const a = await budget.acquire()
    const b = await budget.acquire()
    const granted: number[] = []
    const c = budget.acquire().then(release => { granted.push(3); return release })
    const d = budget.acquire().then(release => { granted.push(4); return release })
    await Promise.resolve()
    expect(granted).toEqual([])
    a(); a()
    const releaseC = await c
    expect(granted).toEqual([3])
    b()
    const releaseD = await d
    expect(granted).toEqual([3, 4])
    releaseC(); releaseD()
  })
  it('expired waiters do not consume slots or block recovery', async () => {
    vi.useFakeTimers()
    try {
      const budget = new SnapshotBudget(1, 100)
      const release = await budget.acquire()
      const pending = expect(budget.acquire()).rejects.toThrow('capacity wait timed out')
      await vi.advanceTimersByTimeAsync(101)
      await pending
      release()
      const recovered = await budget.acquire()
      recovered()
    } finally { vi.useRealTimers() }
  })
  it('shares a budget across clients of one endpoint, separates TWS ports', () => {
    expect(twsSnapshotBudget('localhost', 7497)).toBe(twsSnapshotBudget('127.0.0.1', 7497))
    expect(twsSnapshotBudget('127.0.0.1', 7497)).not.toBe(twsSnapshotBudget('127.0.0.1', 7496))
  })
})
