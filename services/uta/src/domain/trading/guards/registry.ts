import type { OperationGuard, GuardRegistryEntry } from './types.js'
import { MaxPositionSizeGuard } from './max-position-size.js'
import { CooldownGuard } from './cooldown.js'
import { SymbolWhitelistGuard } from './symbol-whitelist.js'
import { LongOnlyGuard } from './long-only.js'
import { MaxGrossExposureGuard } from './max-gross-exposure.js'
import { MinCashGuard } from './min-cash.js'
import { MaxOrdersPerDayGuard } from './max-orders-per-day.js'
import { QuoteFreshnessGuard } from './quote-freshness.js'
import { MaxDailyLossGuard } from './max-daily-loss.js'

const builtinGuards: GuardRegistryEntry[] = [
  { type: 'max-position-size',  create: (opts) => new MaxPositionSizeGuard(opts) },
  { type: 'cooldown',           create: (opts) => new CooldownGuard(opts) },
  { type: 'symbol-whitelist',   create: (opts) => new SymbolWhitelistGuard(opts) },
  { type: 'long-only',          create: () => new LongOnlyGuard() },
  { type: 'max-gross-exposure', create: (opts) => new MaxGrossExposureGuard(opts) },
  { type: 'min-cash',           create: (opts) => new MinCashGuard(opts) },
  { type: 'max-orders-per-day', create: (opts) => new MaxOrdersPerDayGuard(opts) },
  { type: 'quote-freshness',    create: (opts) => new QuoteFreshnessGuard(opts) },
  { type: 'max-daily-loss',     create: (opts) => new MaxDailyLossGuard(opts) },
]

const registry = new Map<string, GuardRegistryEntry['create']>(
  builtinGuards.map(g => [g.type, g.create]),
)

/** Register a custom guard type (for third-party extensions). */
export function registerGuard(entry: GuardRegistryEntry): void {
  registry.set(entry.type, entry.create)
}

/** Resolve config entries into guard instances via the registry. */
export function resolveGuards(
  configs: Array<{ type: string; options?: Record<string, unknown> }>,
): OperationGuard[] {
  const guards: OperationGuard[] = []
  for (const cfg of configs) {
    const factory = registry.get(cfg.type)
    if (!factory) {
      console.warn(`guard: unknown type "${cfg.type}", skipped`)
      continue
    }
    guards.push(factory(cfg.options ?? {}))
  }
  return guards
}
