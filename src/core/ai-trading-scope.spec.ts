import { describe, it, expect } from 'vitest'
import { aiTradingAllowed } from './ai-trading-scope.js'

describe('aiTradingAllowed', () => {
  it('allows only listed accounts while the switch is on', () => {
    const agent = { allowAiTrading: true, aiTradingAccounts: ['ibkr-paper'] }
    expect(aiTradingAllowed(agent, 'ibkr-paper')).toBe(true)
    expect(aiTradingAllowed(agent, 'ibkr-live')).toBe(false)
  })

  it('denies every account when the list is missing or empty', () => {
    expect(aiTradingAllowed({ allowAiTrading: true }, 'ibkr-paper')).toBe(false)
    expect(aiTradingAllowed({ allowAiTrading: true, aiTradingAccounts: [] }, 'ibkr-paper')).toBe(false)
  })

  it('denies everything while the switch is off, list or not', () => {
    expect(aiTradingAllowed({ allowAiTrading: false, aiTradingAccounts: ['ibkr-paper'] }, 'ibkr-paper')).toBe(false)
    expect(aiTradingAllowed({ aiTradingAccounts: ['ibkr-paper'] }, 'ibkr-paper')).toBe(false)
  })
})
