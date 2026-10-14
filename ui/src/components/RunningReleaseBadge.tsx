import { useTranslation } from 'react-i18next'
import { useUpdateLifecycle } from '../hooks/useUpdateLifecycle'
import { getIntlLocale } from '../lib/intl'

/** Running backend identity, independent of the remote update candidate. */
export function RunningReleaseBadge() {
  const { t } = useTranslation()
  const updates = useUpdateLifecycle({ optional: true })
  const info = updates?.versionInfo
  if (!info || updates.versionError) return null
  const build = info.runningBuild
  const timestamp = build?.committedAt && Number.isFinite(Date.parse(build.committedAt)) ? build.committedAt : null
  const date = timestamp ? new Intl.DateTimeFormat(getIntlLocale(), {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    second: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  }).format(new Date(timestamp)) : null
  return (
    <section aria-label={t('runningRelease.label')} className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/55 px-4 py-2 text-xs text-muted-foreground sm:px-6">
      <span className="font-medium text-foreground">SuperAlice · v{info.current}</span>
      {timestamp ? (
        <span>{t('runningRelease.updated')} <time dateTime={timestamp} className="tabular-nums">{date}</time></span>
      ) : <span>{t('runningRelease.dateUnavailable')}</span>}
      {build && <span>{t('runningRelease.revision')} <code title={build.commit}>{build.commit.slice(0, 8)}</code></span>}
      {build?.dirty && <span>{t('runningRelease.localChanges')}</span>}
    </section>
  )
}
