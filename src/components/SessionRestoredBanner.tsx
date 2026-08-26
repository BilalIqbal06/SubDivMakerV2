import { RefreshCcw } from 'lucide-react'

interface SessionRestoredBannerProps {
  onStartFresh: () => void
  onDismiss?: () => void
  requiresRegeneration?: boolean
}

export default function SessionRestoredBanner({
  onStartFresh,
  onDismiss,
  requiresRegeneration = false
}: SessionRestoredBannerProps) {
  return (
    <div
      className="pointer-events-auto rounded-lg border px-4 py-3 shadow-lg"
      style={{
        background: 'var(--sidebar-gradient)',
        borderColor: 'var(--card-border)',
        color: 'var(--text-secondary)',
        minWidth: '260px'
      }}
    >
      <div className="flex items-start gap-3">
        <RefreshCcw className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--seafoam)' }} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            Previous session restored
          </p>
          {requiresRegeneration && (
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Generated geometry is not stored; press <span className="font-semibold" style={{ color: 'var(--seafoam)' }}>Generate</span> to recreate it.
            </p>
          )}
          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              onClick={onStartFresh}
              className="text-xs font-medium px-2.5 py-1 rounded transition-colors hover:opacity-90"
              style={{
                background: 'var(--brand-black)',
                color: 'var(--seafoam)',
                border: '1px solid var(--viridian)'
              }}
            >
              Start Fresh
            </button>
            {onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                className="text-xs px-2 py-1 rounded transition-colors"
                style={{
                  color: 'var(--text-muted)'
                }}
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
