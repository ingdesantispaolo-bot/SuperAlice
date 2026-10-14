# Collected news and event evidence

For news/catalyst questions, inspect the available monitor news archive through
`alice monitor news-stats` and the subscribed RSS archive with `alice rss`.
The alice-analysis Skill's references/monitor-news.md owns IBKR search, articles,
analyst actions and durable cursors. Supplement gaps with authoritative web.
The collector ingests feeds independently of the model; new items do not
automatically start an agent or enter its context.

Use `glob` for titles, `grep` for title/body mentions, `window` for date-bounded
event timelines, then `read --id <id>` for the saved feed content and link.
Inspect live `--help` for filters, dates and output limits. Search results are
oldest-first; a cap can omit later matching items. Narrow the window or raise
the limit before claiming a complete timeline. window reports omitted matches.

Search covers the available recent index, bounded by collector settings, not
the complete disk archive or all news on the internet. A saved ID can still be
read after index eviction. An empty search means no matching collected item
was found, not that no event happened. Feed text may be only a summary;
`read` does not fetch the original article. Read the publisher page separately
when needed and accessible, and distinguish article content from feed excerpts.

Preserve source, link, article ID and times with research evidence. Collection
time differs from publication time; if a feed has no valid publication date,
the collector currently substitutes ingestion time. Do not claim that this is
a verified publication timestamp. Duplicate filtering uses GUID, then link,
then a title/content hash; it does not establish independent corroboration.

News Sources settings persist feed configuration; the running collector reads
it at startup. Defaults are 10-minute polling, 2,000 indexed items and a 7-day
restart recovery window. retentionDays does not delete the append-only JSONL
archive. UI positive/negative/important views filter supplied category tags,
not a model's sentiment analysis. Cite facts separately from your interpretation.
