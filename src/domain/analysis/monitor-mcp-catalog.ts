/** Reviewed data-only contract. New remote capabilities require an explicit review. */
export const MONITOR_MCP_COMMANDS = {
  status: 'monitor_status', context: 'monitor_context', 'metric-catalog': 'metric_catalog',
  'market-state-history': 'market_state_history', 'alerts-recent': 'alerts_recent',
  'instruments-list': 'instruments_list', 'instrument-resolve': 'instrument_resolve',
  'instrument-track': 'instrument_track', 'history-request': 'history_request',
  'history-request-status': 'history_request_status', 'history-daily': 'history_daily',
  'history-intraday': 'history_intraday', 'data-status': 'data_status',
  'correlation-matrix': 'correlation_matrix', 'relation-pair': 'relation_pair',
  'news-search': 'news_search', 'news-latest': 'news_latest',
  'news-article': 'news_article', 'news-stats': 'news_stats',
  'analyst-actions': 'analyst_actions',
} as const
export const MONITOR_EVIDENCE_KEY = 'ibivmonitor/sha256'
