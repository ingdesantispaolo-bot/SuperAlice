/**
 * Which accounts an AI-initiated push may target. Deny by default: the
 * global switch alone grants nothing — every account must be listed in
 * `agent.aiTradingAccounts`. Upstream treated a missing list as "all
 * accounts", so enabling AI trading for a paper test would also have opened
 * any live account configured later.
 */
export function aiTradingAllowed(
  agent: { allowAiTrading?: boolean; aiTradingAccounts?: readonly string[] },
  accountId: string,
): boolean {
  return agent.allowAiTrading === true && (agent.aiTradingAccounts ?? []).includes(accountId)
}
