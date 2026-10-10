import { describe, it, expect } from 'vitest'
import { Contract, Order, OrderState } from '@traderalice/ibkr'
import { latestPerOrder } from './request-bridge.js'

function collected(orderId: number, permId: number, status: string) {
  const order = Object.assign(new Order(), { orderId, permId })
  const orderState = Object.assign(new OrderState(), { status })
  return { contract: new Contract(), order, orderState }
}

describe('latestPerOrder', () => {
  it('collapses repeated openOrder messages for one order, keeping the latest state', () => {
    const result = latestPerOrder([collected(1, 900, 'PreSubmitted'), collected(1, 900, 'Submitted')])
    expect(result).toHaveLength(1)
    expect(result[0].orderState.status).toBe('Submitted')
  })

  it('keeps distinct orders, including manual TWS orders that share orderId 0', () => {
    const result = latestPerOrder([collected(1, 900, 'Submitted'), collected(0, 901, 'Submitted'), collected(0, 902, 'Submitted')])
    expect(result).toHaveLength(3)
  })
})
