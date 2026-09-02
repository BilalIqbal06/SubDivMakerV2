import { useState } from 'react'
import { Check, AlertCircle, ArrowRight, Loader, ChevronDown } from 'lucide-react'
import type { ParcelFeasibilityAssessment } from '../services/parcelFeasibilityService'

interface ParcelFeasibilityCardProps {
  assessment: ParcelFeasibilityAssessment | null
  isAnalyzing?: boolean
  onContinue?: () => void
}

const RATING_COLORS: Record<string, string> = {
  'FAVORABLE': '#4ade80',
  'MODERATE': '#fbbf24',
  'CHALLENGING': '#f87171',
  'INSUFFICIENT DATA': '#94a3b8'
}

const RATING_BG: Record<string, string> = {
  'FAVORABLE': 'rgba(74, 222, 128, 0.12)',
  'MODERATE': 'rgba(251, 191, 36, 0.12)',
  'CHALLENGING': 'rgba(248, 113, 113, 0.12)',
  'INSUFFICIENT DATA': 'rgba(148, 163, 184, 0.12)'
}

const CONFIDENCE_COLORS: Record<string, string> = {
  'HIGH': '#4ade80',
  'MEDIUM': '#fbbf24',
  'LOW': '#f87171'
}

function fmtAc(n: number | null): string {
  return n == null || isNaN(n) ? '—' : `${n.toFixed(1)} ac`
}

function fmtPct(n: number | null): string {
  return n == null || isNaN(n) ? '—' : `${Math.round(n)}%`
}

export default function ParcelFeasibilityCard({ assessment, isAnalyzing, onContinue }: ParcelFeasibilityCardProps) {
  const [showDetails, setShowDetails] = useState(false)

  const continueButton = onContinue ? (
    <button
      onClick={onContinue}
      disabled={!assessment}
      className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-[14px] font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      style={{
        background: assessment ? 'var(--button-gradient)' : 'rgba(64, 130, 109, 0.2)',
        color: assessment ? 'var(--brand-black)' : 'var(--text-secondary)',
        border: '1px solid var(--viridian)'
      }}
      onMouseEnter={(e) => {
        if (!assessment) return
        e.currentTarget.style.transform = 'translateY(-1px)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)'
      }}
    >
      Continue to Parameters
      <ArrowRight className="w-4 h-4" />
    </button>
  ) : null

  if (isAnalyzing || !assessment) {
    return (
      <div className="rounded-lg p-4 border" style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}>
        <h3 className="text-[15px] font-bold mb-3" style={{ color: 'var(--text-primary)' }}>Parcel Feasibility</h3>
        <div className="flex items-center gap-3 p-3 rounded-md" style={{ background: 'rgba(64, 130, 109, 0.12)' }}>
          <Loader className="w-5 h-5 animate-spin" style={{ color: 'var(--seafoam)' }} />
          <div>
            <p className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>Assessing parcel…</p>
            <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>Screening parcel constraints and buildable area.</p>
          </div>
        </div>
        {continueButton}
      </div>
    )
  }

  const statusColor = RATING_COLORS[assessment.overallRating] || '#ffffff'
  const statusBg = RATING_BG[assessment.overallRating] || 'rgba(255,255,255,0.08)'
  const confidenceColor = CONFIDENCE_COLORS[assessment.confidence] || '#ffffff'
  const strengths = assessment.positiveFactors.slice(0, 3)
  const considerations = assessment.concernFactors.slice(0, 3)

  return (
    <div className="rounded-lg p-4 border" style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}>
      <h3 className="text-[15px] font-bold mb-3" style={{ color: 'var(--text-primary)' }}>Parcel Feasibility</h3>

      {/* Prominent status */}
      <div className="flex items-center gap-2 mb-3">
        <span
          className="px-2.5 py-1 rounded text-[13px] font-bold uppercase tracking-wide"
          style={{ background: statusBg, color: statusColor, border: `1px solid ${statusColor}` }}
        >
          {assessment.overallRating}
        </span>
        <span
          className="px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wide"
          style={{ background: 'rgba(255,255,255,0.08)', color: confidenceColor, border: `1px solid ${confidenceColor}` }}
        >
          {assessment.confidence} confidence
        </span>
      </div>

      {/* Compact metric group */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="p-2 rounded-md" style={{ background: 'rgba(5, 8, 7, 0.55)' }}>
          <p className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Developable</p>
          <p className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{fmtAc(assessment.developableAreaAcres)}</p>
        </div>
        <div className="p-2 rounded-md" style={{ background: 'rgba(5, 8, 7, 0.55)' }}>
          <p className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Usable</p>
          <p className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{fmtPct(assessment.developablePercent)}</p>
        </div>
        <div className="p-2 rounded-md" style={{ background: 'rgba(5, 8, 7, 0.55)' }}>
          <p className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Constraint</p>
          <p className="text-[13px] font-semibold text-right truncate" style={{ color: 'var(--text-primary)' }} title={assessment.dominantConstraint}>{assessment.dominantConstraint}</p>
        </div>
      </div>

      {/* Strengths / considerations */}
      {strengths.length > 0 && (
        <div className="mb-3">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--seafoam)' }}>Strengths</h4>
          <ul className="space-y-1">
            {strengths.map((factor, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px]" style={{ color: 'var(--text-primary)' }}>
                <Check className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'var(--soft-seafoam)' }} />
                {factor}
              </li>
            ))}
          </ul>
        </div>
      )}

      {considerations.length > 0 && (
        <div className="mb-3">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--seafoam)' }}>Considerations</h4>
          <ul className="space-y-1">
            {considerations.map((factor, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px]" style={{ color: 'var(--text-primary)' }}>
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'var(--text-secondary)' }} />
                {factor}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Expandable assessment details */}
      <div className="border-t pt-2 mb-3" style={{ borderColor: 'var(--card-border)' }}>
        <button
          onClick={() => setShowDetails(s => !s)}
          className="w-full flex items-center justify-between text-[13px] font-semibold transition-colors"
          style={{ color: 'var(--seafoam)' }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--seafoam)' }}
        >
          <span>View assessment details</span>
          <ChevronDown className={`w-4 h-4 transition-transform ${showDetails ? 'rotate-180' : ''}`} />
        </button>

        {showDetails && (
          <p className="text-[12px] leading-[1.45] mt-2" style={{ color: 'var(--text-secondary)' }}>
            {assessment.summary}
          </p>
        )}
      </div>

      {/* Continue CTA */}
      {continueButton}

      <p className="text-[11px] leading-[1.4] mt-3" style={{ color: 'var(--text-muted)' }}>
        Preliminary GIS screening only. This assessment does not replace survey, zoning, environmental, utility, geotechnical, or engineering due diligence.
      </p>
    </div>
  )
}
