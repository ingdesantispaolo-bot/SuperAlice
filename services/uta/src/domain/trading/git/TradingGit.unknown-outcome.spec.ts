import { describe, it, expect, vi } from 'vitest'
import Decimal from 'decimal.js'
import { Contract, Order } from '@traderalice/ibkr'
import {
  TradingGit,
  DispatchOutcomeUnknownError,
  UnresolvedOutcomeError,
  isUnresolvedOutcome,
} from './TradingGit.js'
import type { TradingGitConfig } from './interfaces.js'
import type { Operation, GitState, GitExportState } from './types.js'
import '../contract-ext.js'

// ==================== Helpers ====================

function makeGitState(): GitState {
  return {
    totalCashValue: '100000',
    netLiquidation: '100000',
    unrealizedPnL: '0',
    realizedPnL: '0',
    positions: [],
    pendingOrders: [],
  }
}

function buyOp(symbol = 'AAPL', qty = 10): Operation {
  const contract = new Contract()
  contract.aliceId = `mock-paper|${symbol}`
  contract.symbol = symbol
  contract.secType = 'STK'
  contract.currency = 'USD'
  const order = new Order()
  order.action = 'BUY'
  order.orderType = 'MKT'
  order.totalQuantity = new Decimal(qty)
  return { action: 'placeOrder', contract, order }
}

function makeConfig(overrides: Partial<TradingGitConfig> = {}): TradingGitConfig {
  return {
    executeOperation: vi.fn().mockResolvedValue({ success: true, orderId: 'ord-1' }),
    getGitState: vi.fn().mockResolvedValue(makeGitState()),
    ...overrides,
  }
}

/** Stage, commit and push one operation; returns the push result. */
async function pushOne(git: TradingGit, op: Operation = buyOp(), message = 'buy AAPL') {
  git.add(op)
  const { hash } = git.commit(message)
  return git.push(hash)
}

/** Persistence double: keeps a JSON copy of every write, like the file persister. */
function memoryStore() {
  const writes: GitExportState[] = []
  const write = vi.fn(async (state: GitExportState) => {
    writes.push(JSON.parse(JSON.stringify(state)))
  })
  return { writes, write, last: () => writes.at(-1)! }
}

// ==================== Tests ====================

describe('TradingGit — unknown dispatch outcomes', () => {
  describe('recording', () => {
    it('records a DispatchOutcomeUnknownError as unknown, not rejected', async () => {
      const git = new TradingGit(makeConfig({
        executeOperation: vi.fn().mockRejectedValue(new DispatchOutcomeUnknownError('ack lost')),
      }))

      const result = await pushOne(git)

      expect(result.unresolved).toHaveLength(1)
      expect(result.unresolved[0]).toMatchObject({ status: 'unknown', success: false, error: 'ack lost' })
      expect(result.rejected).toHaveLength(0)
      expect(result.submitted).toHaveLength(0)
      expect(git.status().unresolved).toHaveLength(1)
    })

    it('keeps a plain thrown error as rejected (callers that do not classify)', async () => {
      const git = new TradingGit(makeConfig({
        executeOperation: vi.fn().mockRejectedValue(new Error('boom')),
      }))

      const result = await pushOne(git)

      expect(result.rejected).toHaveLength(1)
      expect(result.rejected[0].status).toBe('rejected')
      expect(result.unresolved).toHaveLength(0)
      expect(git.getUnresolved()).toHaveLength(0)
    })

    it('records a broker outcomeUnknown result as unknown and keeps its orderId', async () => {
      const git = new TradingGit(makeConfig({
        executeOperation: vi.fn().mockResolvedValue({ success: false, outcomeUnknown: true, orderId: '42', error: 'timed out' }),
      }))

      const result = await pushOne(git)

      expect(result.unresolved[0]).toMatchObject({ status: 'unknown', orderId: '42', error: 'timed out' })
      expect(git.getUnresolved()[0]).toMatchObject({ orderId: '42', symbol: 'AAPL', aliceId: 'mock-paper|AAPL' })
      // An unknown with an orderId is pending: sync can resolve it.
      expect(git.getPendingOrderIds()).toEqual([
        expect.objectContaining({ orderId: '42', status: 'unknown' }),
      ])
    })

    it('a definitive success:false result is still a rejection', async () => {
      const git = new TradingGit(makeConfig({
        executeOperation: vi.fn().mockResolvedValue({ success: false, error: 'insufficient funds' }),
      }))

      const result = await pushOne(git)

      expect(result.rejected).toHaveLength(1)
      expect(git.getUnresolved()).toHaveLength(0)
    })
  })

  describe('blocking', () => {
    it('refuses to stage or push while an outcome is unresolved', async () => {
      const executeOperation = vi.fn()
        .mockRejectedValueOnce(new DispatchOutcomeUnknownError('ack lost'))
        .mockResolvedValue({ success: true, orderId: 'ord-2' })
      const git = new TradingGit(makeConfig({ executeOperation }))

      await pushOne(git)

      expect(() => git.add(buyOp())).toThrow(UnresolvedOutcomeError)
      expect(executeOperation).toHaveBeenCalledTimes(1)
    })

    it('the refusal carries the unresolved list and a stable code', async () => {
      const git = new TradingGit(makeConfig({
        executeOperation: vi.fn().mockRejectedValue(new DispatchOutcomeUnknownError('ack lost')),
      }))
      const { hash } = await pushOne(git)

      let error: unknown
      try { git.add(buyOp()) } catch (err) { error = err }

      expect(isUnresolvedOutcome(error)).toBe(true)
      expect((error as UnresolvedOutcomeError).unresolved[0]).toMatchObject({ commitHash: hash, operationIndex: 0 })
    })

    it('observation and sync writes are not blocked', async () => {
      const git = new TradingGit(makeConfig({
        executeOperation: vi.fn().mockResolvedValue({ success: false, outcomeUnknown: true, orderId: '42' }),
      }))
      await pushOne(git)

      const synced = await git.sync(
        [{ orderId: '42', symbol: 'AAPL', previousStatus: 'unknown', currentStatus: 'filled', filledQty: '10', filledPrice: '150' }],
        makeGitState(),
      )

      expect(synced.updatedCount).toBe(1)
      // Broker evidence for the same orderId resolves the unknown outcome.
      expect(git.getUnresolved()).toHaveLength(0)
      expect(() => git.add(buyOp())).not.toThrow()
    })
  })

  describe('resolveOutcome', () => {
    async function blockedGit() {
      const git = new TradingGit(makeConfig({
        executeOperation: vi.fn().mockRejectedValue(new DispatchOutcomeUnknownError('ack lost')),
      }))
      const { hash } = await pushOne(git)
      return { git, hash }
    }

    it('not-placed clears the block and appends a commit without rewriting history', async () => {
      const { git, hash } = await blockedGit()
      const before = git.show(hash)

      await git.resolveOutcome({ commitHash: hash, operationIndex: 0, outcome: 'not-placed', note: 'no order or fill at broker' })

      expect(git.getUnresolved()).toHaveLength(0)
      expect(git.show(hash)).toEqual(before)
      expect(git.log({ limit: 1 })[0].message).toMatch(/^\[resolve\] .*not-placed: no order or fill at broker/)
      expect(() => git.add(buyOp())).not.toThrow()
    })

    it('placed with an orderId hands the order to sync', async () => {
      const { git, hash } = await blockedGit()

      await git.resolveOutcome({ commitHash: hash, operationIndex: 0, outcome: 'placed', orderId: 'ord-9', note: 'found in TWS order history' })

      expect(git.getUnresolved()).toHaveLength(0)
      expect(git.getPendingOrderIds()).toEqual([
        expect.objectContaining({ orderId: 'ord-9', symbol: 'AAPL', aliceId: 'mock-paper|AAPL', status: 'submitted' }),
      ])
    })

    it('placed with fill evidence records the fill once', async () => {
      const { git, hash } = await blockedGit()

      const resolution = await git.resolveOutcome({
        commitHash: hash, operationIndex: 0, outcome: 'placed', filledQty: '10', filledPrice: '150.25', note: 'execution in broker statement',
      })

      const commit = git.show(resolution)!
      expect(commit.results[0]).toMatchObject({ success: true, status: 'filled', filledQty: '10', filledPrice: '150.25' })
      expect(commit.operations[0]).toMatchObject({ action: 'resolveOutcome', original: { action: 'placeOrder' } })
    })

    it('refuses a resolution without evidence', async () => {
      const { git, hash } = await blockedGit()

      await expect(git.resolveOutcome({ commitHash: hash, operationIndex: 0, outcome: 'not-placed', note: '  ' }))
        .rejects.toThrow(/note describing the broker evidence/)
      await expect(git.resolveOutcome({ commitHash: hash, operationIndex: 0, outcome: 'placed', note: 'seen' }))
        .rejects.toThrow(/requires orderId, or both filledQty and filledPrice/)
      await expect(git.resolveOutcome({ commitHash: hash, operationIndex: 0, outcome: 'placed', filledQty: '-1', filledPrice: '1', note: 'x' }))
        .rejects.toThrow(/filledQty must be a positive decimal/)
      expect(git.getUnresolved()).toHaveLength(1)
    })

    it('refuses to resolve an operation that is not unresolved', async () => {
      const { git, hash } = await blockedGit()
      await git.resolveOutcome({ commitHash: hash, operationIndex: 0, outcome: 'not-placed', note: 'checked' })

      await expect(git.resolveOutcome({ commitHash: hash, operationIndex: 0, outcome: 'not-placed', note: 'again' }))
        .rejects.toThrow(/no unresolved operation/)
    })

    it('concurrent resolutions of the same operation append exactly one commit', async () => {
      const { git, hash } = await blockedGit()
      const params = { commitHash: hash, operationIndex: 0, outcome: 'not-placed' as const, note: 'checked' }

      const settled = await Promise.allSettled([git.resolveOutcome(params), git.resolveOutcome(params)])

      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1)
      expect(git.log({ limit: 10 }).filter((c) => c.message.startsWith('[resolve]'))).toHaveLength(1)
    })

    it('refuses an orderId that contradicts the one recorded', async () => {
      const git = new TradingGit(makeConfig({
        executeOperation: vi.fn().mockResolvedValue({ success: false, outcomeUnknown: true, orderId: '42' }),
      }))
      const { hash } = await pushOne(git)

      await expect(git.resolveOutcome({ commitHash: hash, operationIndex: 0, outcome: 'placed', orderId: '43', note: 'x' }))
        .rejects.toThrow(/does not match the order 42/)
    })
  })

  describe('durable dispatch intent and recovery', () => {
    it('persists the intent before dispatch and clears it once committed', async () => {
      const store = memoryStore()
      let seenBeforeDispatch: GitExportState | undefined
      const git = new TradingGit(makeConfig({
        persistInflight: store.write,
        onCommit: store.write,
        executeOperation: vi.fn(async () => {
          seenBeforeDispatch = store.last()
          return { success: true, orderId: 'ord-1' }
        }),
      }))

      await pushOne(git)

      expect(seenBeforeDispatch?.inflight).toMatchObject({ dispatchIndex: 0, results: [], message: 'buy AAPL' })
      expect(store.last().inflight).toBeUndefined()
      expect(store.last().commits).toHaveLength(1)
    })

    it('calls onCommit once per push (dispatch intent goes through persistInflight)', async () => {
      const onCommit = vi.fn()
      const persistInflight = vi.fn()
      const git = new TradingGit(makeConfig({ onCommit, persistInflight }))

      await pushOne(git)

      expect(onCommit).toHaveBeenCalledTimes(1)
      expect(persistInflight).toHaveBeenCalledTimes(2)
    })

    it('does not dispatch when the intent cannot be persisted', async () => {
      const executeOperation = vi.fn()
      const git = new TradingGit(makeConfig({
        executeOperation,
        persistInflight: vi.fn().mockRejectedValue(new Error('disk full')),
      }))

      const result = await pushOne(git)

      expect(executeOperation).not.toHaveBeenCalled()
      expect(result.rejected[0].error).toMatch(/not dispatched: could not persist dispatch intent \(disk full\)/)
      expect(git.getUnresolved()).toHaveLength(0)
    })

    it('recovers a push interrupted mid-dispatch as unknown, never re-dispatching', async () => {
      const store = memoryStore()
      const first = new TradingGit(makeConfig({
        persistInflight: store.write,
        onCommit: store.write,
        // Process "dies" during the second broker call: it never returns.
        executeOperation: vi.fn()
          .mockResolvedValueOnce({ success: true, orderId: 'ord-1' })
          .mockImplementationOnce(() => new Promise(() => {})),
      }))
      first.add(buyOp('AAPL'))
      first.add(buyOp('MSFT'))
      first.add(buyOp('NVDA'))
      const { hash } = first.commit('rebalance')
      void first.push(hash)
      await vi.waitFor(() => expect(store.last().inflight?.dispatchIndex).toBe(1))

      const onDisk = store.last()
      const executeAfterRestart = vi.fn()
      const restarted = TradingGit.restore(onDisk, makeConfig({ executeOperation: executeAfterRestart }))

      const recovered = restarted.show(hash)!
      expect(recovered.message).toBe('rebalance [recovered: process stopped during push]')
      expect(recovered.results.map((r) => r.status)).toEqual(['submitted', 'unknown', 'rejected'])
      expect(recovered.results[2].error).toMatch(/not dispatched/)
      expect(restarted.getUnresolved()).toEqual([
        expect.objectContaining({ commitHash: hash, operationIndex: 1, symbol: 'MSFT' }),
      ])
      expect(() => restarted.add(buyOp())).toThrow(UnresolvedOutcomeError)
      expect(executeAfterRestart).not.toHaveBeenCalled()

      // Deterministic: restoring the same file again yields the same commit.
      const again = TradingGit.restore(onDisk, makeConfig())
      expect(again.show(hash)).toEqual(recovered)
    })

    it('keeps the results of operations already sent when the post-push state read fails', async () => {
      const executeOperation = vi.fn().mockResolvedValue({ success: true, orderId: 'ord-1' })
      const git = new TradingGit(makeConfig({
        executeOperation,
        getGitState: vi.fn().mockRejectedValue(new Error('broker read failed')),
      }))

      const result = await pushOne(git)

      expect(result.submitted).toHaveLength(1)
      expect(git.status().staged).toHaveLength(0)
      expect(git.status().pendingHash).toBeNull()
      expect(executeOperation).toHaveBeenCalledTimes(1)
    })
  })
})
