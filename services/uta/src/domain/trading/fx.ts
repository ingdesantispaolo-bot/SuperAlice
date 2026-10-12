/**
 * Base-currency conversion for execution decisions (rebalance planning and
 * risk guards). Rates come only from the broker's account data
 * (`AccountInfo.fxRates`), the same rates the broker values the account
 * with — never from the display-level FxService. A rate that is not known
 * is `null`, so callers refuse instead of assuming parity.
 */

import Decimal from 'decimal.js'
import type { Contract } from '@traderalice/ibkr'
import type { AccountInfo, Position, Quote } from './brokers/types.js'

type FxAccount = Pick<AccountInfo, 'baseCurrency' | 'fxRates'>

/** True when the broker reports any currency other than the base. */
export function isMultiCurrency(account: FxAccount): boolean {
  return Object.keys(account.fxRates ?? {}).some((c) => c !== account.baseCurrency)
}

/**
 * Units of base currency per unit of `currency`. An unknown currency is the
 * base only on a single-currency account; on a multi-currency account it
 * cannot be assumed and the result is null.
 */
export function rateToBase(account: FxAccount, currency: string | undefined): Decimal | null {
  const ccy = currency?.trim().toUpperCase()
  if (!ccy) return isMultiCurrency(account) ? null : new Decimal(1)
  if (ccy === account.baseCurrency) return new Decimal(1)
  const raw = account.fxRates?.[ccy]
  if (raw == null) return null
  try {
    const rate = new Decimal(raw)
    return rate.isFinite() && rate.gt(0) ? rate : null
  } catch {
    return null
  }
}

/** `amount` (in `currency`) expressed in the base currency, or null. */
export function toBase(account: FxAccount, amount: Decimal, currency: string | undefined): Decimal | null {
  const rate = rateToBase(account, currency)
  return rate ? amount.mul(rate) : null
}

/** Trading currency of an instrument, from the most specific source available. */
export function instrumentCurrency(contract: Contract, quote?: Pick<Quote, 'contract'>, position?: Pick<Position, 'currency'>): string | undefined {
  const pick = (c: string | undefined) => (c && c.trim() ? c.trim().toUpperCase() : undefined)
  return pick(contract.currency) ?? pick(quote?.contract?.currency) ?? pick(position?.currency)
}

/**
 * A currency conversion (IBKR `CASH`, e.g. EUR.USD), not a holding. A
 * contract staged from an aliceId may carry only its conId, so the broker's
 * resolved contract on the quote is consulted too.
 */
export function isFxConversion(contract: Pick<Contract, 'secType'>, quote?: Pick<Quote, 'contract'>): boolean {
  const secType = contract.secType || quote?.contract?.secType || ''
  return secType.toUpperCase() === 'CASH'
}

/**
 * The two legs of a conversion order: IBKR quotes CASH as `symbol.currency`
 * (EUR.USD = price of 1 EUR in USD, quantity in EUR). BUY pays `currency`
 * and receives `symbol`; SELL pays `symbol`.
 */
export function fxLegs(contract: Pick<Contract, 'symbol' | 'currency'>, quote?: Pick<Quote, 'contract'>): { base: string; quoteCurrency: string } | null {
  const base = (contract.symbol || quote?.contract?.symbol || '').trim().toUpperCase()
  const quoteCurrency = (contract.currency || quote?.contract?.currency || '').trim().toUpperCase()
  return base && quoteCurrency ? { base, quoteCurrency } : null
}
