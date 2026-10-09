/**
 * Guard Pipeline
 *
 * The only place that touches the account: assembles a GuardContext,
 * then passes it through the guard chain. Guards themselves never
 * see the account.
 */

import type { Operation } from '../git/types.js'
import type { IBroker, OpenOrder, Quote } from '../brokers/types.js'
import type { OperationGuard, GuardContext } from './types.js'

/** Extra, caller-owned context (account id, clock, durable counters). */
export type GuardContextExtras = Pick<GuardContext, 'accountId' | 'now' | 'placedOrdersOn'>

export function createGuardPipeline(
  dispatcher: (op: Operation) => Promise<unknown>,
  account: IBroker,
  guards: OperationGuard[],
  extras?: () => GuardContextExtras,
): (op: Operation) => Promise<unknown> {
  if (guards.length === 0) return dispatcher
  const needsQuote = guards.some((g) => g.needs?.quote)
  const needsOpenOrders = guards.some((g) => g.needs?.openOrders)

  return async (op: Operation): Promise<unknown> => {
    const [positions, accountInfo] = await Promise.all([
      account.getPositions(),
      account.getAccount(),
    ])

    // Placement-only reads. A failure leaves the field absent; each guard
    // decides whether that is acceptable (the risk guards fail closed).
    let quote: Quote | undefined
    let openOrders: OpenOrder[] | undefined
    if (op.action === 'placeOrder' && (needsQuote || needsOpenOrders)) {
      const [quoteRead, ordersRead] = await Promise.allSettled([
        needsQuote ? account.getQuote(op.contract) : Promise.reject(new Error('not requested')),
        needsOpenOrders && account.getOpenOrders ? account.getOpenOrders() : Promise.reject(new Error('not available')),
      ])
      if (quoteRead.status === 'fulfilled') quote = quoteRead.value
      if (ordersRead.status === 'fulfilled') openOrders = ordersRead.value
    }

    const ctx: GuardContext = {
      operation: op,
      positions,
      account: accountInfo,
      now: new Date(),
      ...(extras?.() ?? {}),
      ...(quote && { quote }),
      ...(openOrders && { openOrders }),
    }

    for (const guard of guards) {
      const rejection = await guard.check(ctx)
      if (rejection != null) {
        return { success: false, error: `[guard:${guard.name}] ${rejection}` }
      }
    }

    return dispatcher(op)
  }
}
