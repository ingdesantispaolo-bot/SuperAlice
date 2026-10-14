import { BrokerError } from '../types.js'

/** One budget per TWS endpoint in this UTA process, including option mark overlays. */
export class SnapshotBudget {
  private active = 0
  private readonly waiting: Array<{ grant: () => void; timer: ReturnType<typeof setTimeout> }> = []
  constructor(private readonly limit = 10, private readonly waitMs = 25_000) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) this.active++
    else {
      if (this.waiting.length >= 100) throw new BrokerError('NETWORK', 'IBKR snapshot capacity queue is full')
      await new Promise<void>((resolve, reject) => {
        const entry = {
          grant: resolve,
          timer: setTimeout(() => {
            const index = this.waiting.indexOf(entry)
            if (index >= 0) this.waiting.splice(index, 1)
            reject(new BrokerError('NETWORK', 'IBKR snapshot capacity wait timed out'))
          }, this.waitMs),
        }
        this.waiting.push(entry)
      })
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiting.shift()
      if (next) { clearTimeout(next.timer); next.grant() }
      else this.active--
    }
  }
}

const budgets = new Map<string, SnapshotBudget>()
export function twsSnapshotBudget(host: string, port: number): SnapshotBudget {
  // localhost and IPv4 loopback identify the same local TWS in the standard setup.
  const key = `${host.toLowerCase() === 'localhost' ? '127.0.0.1' : host.toLowerCase()}:${port}`
  let budget = budgets.get(key)
  if (!budget) { budget = new SnapshotBudget(); budgets.set(key, budget) }
  return budget
}
