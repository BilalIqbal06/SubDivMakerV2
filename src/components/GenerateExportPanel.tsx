import { useEffect, useState } from 'react'
import { FileJson, Globe, ArrowLeft, Save, Loader, CheckCircle2, AlertTriangle, ChevronDown } from 'lucide-react'
import type { ConceptAlternativeResult, ConceptAlternativeMetricSources, ConceptStrategy, ConceptAlternativeMetricSource } from '../types/conceptAlternatives'
import { ConceptualRoadSkeletonResult, SecondaryRoadNetworkResult, DevelopmentOpportunityBlockResult, SubmittedParameters, CandidateOpenAreaResult } from '../types/parameters'
import type { TerrainSuitabilityResult } from '../types/terrain'
import type { ConceptualDevelopmentProgramResult } from '../services/conceptualDevelopmentProgram'
import { canonicalUseType, type ConceptualDevelopmentLayoutResult } from '../services/conceptualDevelopmentLayout'
import { getRecommendationScore } from '../lib/conceptAlternativesService'
import type { LocalStreetNetworkResult } from '../types/localStreets'
import type { ParcelFeasibilityAssessment } from '../services/parcelFeasibilityService'
import type { RedevelopmentImpactMetrics } from '../lib/redevelopmentContext'

interface GenerateExportPanelProps {
  canGenerate: boolean
  onGenerateRoadSkeleton: () => void
  conceptualRoadResult?: ConceptualRoadSkeletonResult | null
  secondaryRoadNetworkResult?: SecondaryRoadNetworkResult | null
  isRoadGenerating: boolean
  roadGenerationError?: string | null
  onBackToParameters?: () => void
  developmentOpportunityBlockResult?: DevelopmentOpportunityBlockResult | null
  conceptualProgram?: ConceptualDevelopmentProgramResult | null
  conceptualLayout?: ConceptualDevelopmentLayoutResult | null
  redevelopmentImpact?: RedevelopmentImpactMetrics | null
  localStreetNetworkResult?: LocalStreetNetworkResult | null
  // Optional GeoJSON / parent parcel sources (passed from App.tsx if available)
  parentParcelAreaAcres?: number | null
  selectedParcel?: GeoJSON.Feature<GeoJSON.Geometry> | null
  candidateOpenArea?: GeoJSON.Feature<GeoJSON.Geometry> | GeoJSON.FeatureCollection<GeoJSON.Geometry> | null
  candidateOpenAreaResult?: CandidateOpenAreaResult | null
  existingBuildings?: GeoJSON.Feature<GeoJSON.Geometry> | GeoJSON.FeatureCollection<GeoJSON.Geometry> | null
  waterWetlands?: GeoJSON.Feature<GeoJSON.Geometry> | GeoJSON.FeatureCollection<GeoJSON.Geometry> | null
  existingPavement?: GeoJSON.Feature<GeoJSON.Geometry> | GeoJSON.FeatureCollection<GeoJSON.Geometry> | null
  conceptAlternatives?: ConceptAlternativeResult[] | null
  recommendedAlternativeId?: ConceptStrategy | null
  authoritativeAlternativeId?: ConceptStrategy | null
  generatingAlternativeId?: ConceptStrategy | null
  isAlternativeGenerating?: boolean
  onSelectAlternative?: (id: ConceptStrategy) => void
  parcelFeasibilityAssessment?: ParcelFeasibilityAssessment | null
  terrainSuitability?: TerrainSuitabilityResult | null
  submittedParameters?: SubmittedParameters | null
  onSaveDraft?: () => void
}

const SQFT_PER_ACRE = 43560
const SCHEMA_VERSION = '1.0.0'
const PROJECT_NAME = 'SubDivMaker V2'

const STRATEGY_LABELS: Record<ConceptStrategy, string> = {
  'MAX_YIELD': 'Max Yield',
  'BALANCED': 'Balanced',
  'CONSTRAINT_CONSERVATIVE': 'Constraint Conservative'
}

const STRATEGY_PURPOSE: Record<ConceptStrategy, string> = {
  'MAX_YIELD': 'Best for highest conceptual yield.',
  'BALANCED': 'Best overall tradeoff.',
  'CONSTRAINT_CONSERVATIVE': 'Best for lowest site-impact approach.'
}

function getWhyRecommended(): string {
  return 'Recommended because it has the highest score after applying site-condition weighting to the comparison score.'
}

function getTradeoffs(alt: ConceptAlternativeResult, alternatives: ConceptAlternativeResult[]): { plus: string[]; minus: string[] } {
  const m = alt.metrics
  const plus: string[] = []
  const minus: string[] = []

  const sortedUnits = [...alternatives].filter(a => a.metrics.conceptualUnits != null).sort((a, b) => (b.metrics.conceptualUnits ?? 0) - (a.metrics.conceptualUnits ?? 0))
  const sortedServed = [...alternatives].filter(a => a.metrics.networkServedAcres != null).sort((a, b) => (b.metrics.networkServedAcres ?? 0) - (a.metrics.networkServedAcres ?? 0))
  const sortedRoad = [...alternatives].filter(a => a.metrics.totalRoadLengthFt != null).sort((a, b) => (a.metrics.totalRoadLengthFt ?? Infinity) - (b.metrics.totalRoadLengthFt ?? Infinity))
  const sortedRemaining = [...alternatives].filter(a => a.metrics.remainingOpportunityAcres != null).sort((a, b) => (b.metrics.remainingOpportunityAcres ?? 0) - (a.metrics.remainingOpportunityAcres ?? 0))

  if (sortedUnits[0]?.id === alt.id) plus.push('Highest units')
  if (sortedServed[0]?.id === alt.id) plus.push('Largest served area')
  if (sortedRoad[0]?.id === alt.id) plus.push('Shortest road network')
  if (sortedRemaining[0]?.id === alt.id) plus.push('Most remaining opportunity')
  if (m.constraintImpact === 'LOW') plus.push('Lowest constraint impact')
  if (m.feasibilityStatus === 'FAVORABLE') plus.push('Best feasibility')

  if (m.constraintImpact === 'HIGH') minus.push('Higher constraint exposure')
  if (sortedRoad[sortedRoad.length - 1]?.id === alt.id) minus.push('More total road')
  if (sortedUnits[sortedUnits.length - 1]?.id === alt.id) minus.push('Lower units')
  if (m.constraintImpact === 'MODERATE') minus.push('Moderate constraint exposure')

  if (plus.length === 0) plus.push('Distinct strategy profile')
  if (minus.length === 0) {
    if (m.feasibilityStatus === 'CHALLENGING') minus.push('Challenging feasibility')
    else if (sortedServed[sortedServed.length - 1]?.id === alt.id) minus.push('Less land served')
    else if (sortedRemaining[sortedRemaining.length - 1]?.id === alt.id) minus.push('Less remaining opportunity')
    else minus.push('Moderate tradeoffs')
  }

  return { plus: plus.slice(0, 3), minus: minus.slice(0, 1) }
}

function fmtMetricValue(value: number | null, source: ConceptAlternativeMetricSource, mode: 'count' | 'ac' | 'ft'): string {
  if (value == null || source === 'UNAVAILABLE' || isNaN(value ?? NaN)) return '—'
  if (mode === 'count') return source === 'ESTIMATE' ? `${Math.round(value).toLocaleString()} est.` : Math.round(value).toLocaleString()
  if (mode === 'ac') return source === 'ESTIMATE' ? `${Number(value).toFixed(2)} ac est.` : `${Number(value).toFixed(2)} ac`
  if (mode === 'ft') return source === 'ESTIMATE' ? `${Math.round(value).toLocaleString()} ft est.` : `${Math.round(value).toLocaleString()} ft`
  return '—'
}

function fmtMetricText(value: string | null, source: ConceptAlternativeMetricSource): string {
  if (!value || source === 'UNAVAILABLE') return '—'
  return source === 'ESTIMATE' ? `${value} est.` : value
}

function StrategyStatusBadge({ status }: { status: string }) {
  const base = 'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide'
  const isSelected = status === 'SELECTED'
  const isRecommended = status === 'RECOMMENDED'
  const isGenerated = status === 'GENERATED'
  const isEstimate = status === 'ESTIMATE'
  const isLimited = status === 'LIMITED'

  const style: React.CSSProperties = isSelected
    ? { background: 'var(--seafoam)', color: 'var(--brand-black)', border: '1px solid var(--seafoam)' }
    : isRecommended
      ? { background: 'rgba(64, 130, 109, 0.2)', color: 'var(--seafoam)', border: '1px solid var(--viridian)' }
      : isLimited
        ? { background: 'rgba(245, 158, 11, 0.12)', color: '#fbbf24', border: '1px solid #f59e0b' }
        : isGenerated
          ? { background: 'rgba(64, 130, 109, 0.12)', color: 'var(--soft-seafoam)', border: '1px solid rgba(64, 130, 109, 0.45)' }
          : isEstimate
            ? { background: 'rgba(255,255,255,0.04)', color: 'var(--text-secondary)', border: '1px solid rgba(255,255,255,0.12)' }
            : { background: 'rgba(64, 130, 109, 0.1)', color: 'var(--soft-seafoam)', border: '1px solid var(--viridian)' }

  return <span className={base} style={style}>{status}</span>
}

function displayUnits(n?: number | null): number | null { return n != null ? Math.round(n) : null }
function displayRoadFt(n?: number | null): number | null { return n != null ? Math.round(n) : null }
function displayAcres(n?: number | null): number | null { return n != null ? Number(n.toFixed(2)) : null }

function diffPhrase(
  alt: number,
  rec: number,
  same: string,
  more: (v: number) => string,
  less: (v: number) => string
): string {
  const d = alt - rec
  if (d === 0) return same
  return d > 0 ? more(d) : less(Math.abs(d))
}

function buildComparisonSentence(alt: ConceptAlternativeResult, rec: ConceptAlternativeResult): string | null {
  const uAlt = displayUnits(alt.metrics.conceptualUnits)
  const uRec = displayUnits(rec.metrics.conceptualUnits)
  const sAlt = displayAcres(alt.metrics.networkServedAcres)
  const sRec = displayAcres(rec.metrics.networkServedAcres)
  const rAlt = displayRoadFt(alt.metrics.totalRoadLengthFt)
  const rRec = displayRoadFt(rec.metrics.totalRoadLengthFt)
  const oAlt = displayAcres(alt.metrics.remainingOpportunityAcres)
  const oRec = displayAcres(rec.metrics.remainingOpportunityAcres)

  if (uAlt == null || uRec == null || sAlt == null || sRec == null || rAlt == null || rRec == null || oAlt == null || oRec == null) {
    return null
  }

  const unitPhrase = diffPhrase(
    uAlt, uRec,
    'keeps units the same',
    v => `increases units by ${v.toLocaleString()}`,
    v => `reduces units by ${v.toLocaleString()}`
  )
  const servedPhrase = diffPhrase(
    sAlt, sRec,
    'serves the same developable area',
    v => `serves ${v.toFixed(2)} ac more developable area`,
    v => `serves ${v.toFixed(2)} ac less developable area`
  )
  const roadPhrase = diffPhrase(
    rAlt, rRec,
    'uses the same total road length',
    v => `uses ${v.toLocaleString()} ft more total road`,
    v => `uses ${v.toLocaleString()} ft less total road`
  )
  const oppPhrase = diffPhrase(
    oAlt, oRec,
    'preserves the same opportunity',
    v => `preserves ${v.toFixed(2)} ac more opportunity`,
    v => `leaves ${v.toFixed(2)} ac less opportunity`
  )

  return `${alt.label} ${unitPhrase}, ${servedPhrase}, ${roadPhrase}, and ${oppPhrase} compared to ${rec.shortLabel}.`
}

function ConceptComparisonSummary({
  alternatives,
  recommendedAlternativeId,
  parcelFeasibilityAssessment
}: {
  alternatives: ConceptAlternativeResult[]
  recommendedAlternativeId?: ConceptStrategy | null
  parcelFeasibilityAssessment?: ParcelFeasibilityAssessment | null
}) {
  const [open, setOpen] = useState(false)
  const rec = alternatives.find(a => a.id === recommendedAlternativeId)
  const maxYield = alternatives.find(a => a.id === 'MAX_YIELD')
  const conservative = alternatives.find(a => a.id === 'CONSTRAINT_CONSERVATIVE')
  if (!rec) return null

  const adjustedScore = getRecommendationScore(rec, parcelFeasibilityAssessment ?? null)
  const primaryReasons = getTradeoffs(rec, alternatives).plus.slice(0, 3)
  if (primaryReasons.length === 0) {
    primaryReasons.push(`Highest weighted site-condition score (${adjustedScore.toFixed(4)})`)
  }

  const maxYieldSentence = rec.id !== 'MAX_YIELD' && maxYield ? buildComparisonSentence(maxYield, rec) : null
  const conservativeSentence = rec.id !== 'CONSTRAINT_CONSERVATIVE' && conservative ? buildComparisonSentence(conservative, rec) : null
  const tradeoffSentence = [maxYieldSentence, conservativeSentence].filter(Boolean).join(' ')

  return (
    <div className="rounded p-3 border mt-3" style={{ background: 'rgba(64, 130, 109, 0.08)', borderColor: 'rgba(64, 130, 109, 0.35)' }}>
      <h5 className="text-[14px] font-bold mb-2" style={{ color: '#ffffff' }}>Concept Comparison</h5>
      <p className="text-[13px] font-semibold mb-1" style={{ color: 'var(--soft-seafoam)' }}>Recommended: {rec.label}</p>
      <ul className="text-[12px] space-y-0.5 mb-2 list-disc list-inside" style={{ color: 'var(--soft-seafoam)' }}>
        {primaryReasons.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide transition-colors hover:opacity-80"
        style={{ color: 'var(--seafoam)' }}
      >
        {open ? 'Hide Comparison Details' : 'View Comparison Details'}
        <ChevronDown className="w-3 h-3" style={{ transform: open ? 'rotate(180deg)' : undefined }} />
      </button>

      {open && (
        <div className="mt-2 pt-2 border-t space-y-2" style={{ borderColor: 'rgba(64, 130, 109, 0.25)' }}>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>Weighted score</span>
              <span className="text-[13px] font-semibold" style={{ color: '#ffffff' }}>{adjustedScore.toFixed(4)}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>Served acres</span>
              <span className="text-[13px] font-semibold" style={{ color: '#ffffff' }}>{fmtMetricValue(rec.metrics.networkServedAcres, rec.metrics.metricSources.networkServedAcres, 'ac')}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>Conceptual units</span>
              <span className="text-[13px] font-semibold" style={{ color: '#ffffff' }}>{fmtMetricValue(rec.metrics.conceptualUnits, rec.metrics.metricSources.conceptualUnits, 'count')}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>Road length</span>
              <span className="text-[13px] font-semibold" style={{ color: '#ffffff' }}>{fmtMetricValue(rec.metrics.totalRoadLengthFt, rec.metrics.metricSources.totalRoadLengthFt, 'ft')}</span>
            </div>
          </div>
          {tradeoffSentence && (
            <p className="text-[12px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
              <span style={{ color: 'var(--soft-seafoam)' }}>Tradeoff: </span>
              {tradeoffSentence}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

type ConstraintStatus = 'CLEAR' | 'PRESENT' | 'LIMITING' | 'REVIEW'

function fmtFt(n?: number | null): string {
  if (n == null || isNaN(n)) return 'Not available'
  return `${Math.round(n).toLocaleString()} ft`
}

function fmtAc(n?: number | null): string {
  if (n == null || isNaN(n)) return 'Not available'
  return `${Number(n).toFixed(2)} ac`
}

function fmtCount(n?: number | null): string {
  if (n == null || isNaN(n)) return 'Not available'
  return `${Math.round(n).toLocaleString()}`
}

function fmtLabel(label: string, value: string): JSX.Element {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-[12px] leading-tight" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span className="text-[13px] font-semibold leading-tight text-right ml-3" style={{ color: '#ffffff' }}>{value}</span>
    </div>
  )
}

const STATUS_STYLES: Record<ConstraintStatus, { text: string; color: string }> = {
  CLEAR: { text: 'Clear', color: 'var(--soft-seafoam)' },
  PRESENT: { text: 'Present', color: '#fbbf24' },
  LIMITING: { text: 'Limiting', color: '#f87171' },
  REVIEW: { text: 'Review', color: '#fbbf24' }
}

function statusBadge(status: ConstraintStatus): JSX.Element {
  const style = STATUS_STYLES[status]
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wide"
      style={{ background: 'rgba(255,255,255,0.08)', color: style.color, border: `1px solid ${style.color}` }}
    >
      {style.text}
    </span>
  )
}

function terrainStatus(profile: ConceptualRoadSkeletonResult['terrainProfile']): ConstraintStatus {
  if (!profile) return 'REVIEW'
  if (profile.terrainAssessment === 'FAVORABLE') return 'CLEAR'
  if (profile.terrainAssessment === 'MODERATE') return 'PRESENT'
  if (profile.terrainAssessment === 'CHALLENGING') return 'LIMITING'
  return 'REVIEW'
}

const GEOJSON_GEOMETRY_TYPES = ['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon', 'GeometryCollection']

function toFeatures(input: any): Array<GeoJSON.Feature<GeoJSON.Geometry>> {
  if (!input) return []

  // GeoJSON FeatureCollection
  if (input.type === 'FeatureCollection' || (input.features && Array.isArray(input.features))) {
    return (input.features || [])
      .filter((f: any) => f && (f.geometry || GEOJSON_GEOMETRY_TYPES.includes(f.type)))
      .map((f: any) => {
        if (f.type === 'Feature') return f
        if (GEOJSON_GEOMETRY_TYPES.includes(f.type)) return { type: 'Feature', geometry: f, properties: {} }
        if (f.geometry) return { type: 'Feature', geometry: f.geometry, properties: f.properties || {} }
        return null
      })
      .filter(Boolean) as any
  }

  // GeoJSON Feature
  if (input.type === 'Feature' && input.geometry) return [input]

  // Raw GeoJSON Geometry (Polygon, MultiPolygon, etc.)
  if (GEOJSON_GEOMETRY_TYPES.includes(input.type)) {
    return [{ type: 'Feature', geometry: input, properties: {} }]
  }

  // Array of features/geometries
  if (Array.isArray(input)) {
    return input
      .filter((x: any) => x && (x.geometry || GEOJSON_GEOMETRY_TYPES.includes(x.type)))
      .map((x: any) => {
        if (x.type === 'Feature') return x
        if (GEOJSON_GEOMETRY_TYPES.includes(x.type)) return { type: 'Feature', geometry: x, properties: {} }
        if (x.geometry) return { type: 'Feature', geometry: x.geometry, properties: x.properties || {} }
        return null
      })
      .filter(Boolean) as any
  }

  return []
}

function CollapsibleSection({
  id,
  title,
  defaultOpen = false,
  children
}: {
  id: string
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div
      id={id}
      className="rounded-lg p-4 border"
      style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between text-left group"
      >
        <h4 className="text-[15px] font-bold" style={{ color: '#ffffff' }}>{title}</h4>
        <ChevronDown
          className="w-4 h-4 transition-transform duration-200"
          style={{
            color: 'var(--soft-seafoam)',
            transform: open ? 'rotate(180deg)' : undefined
          }}
        />
      </button>
      {open && (
        <div className="mt-3 pt-3 border-t space-y-1" style={{ borderColor: 'var(--card-border)' }}>
          {children}
        </div>
      )}
    </div>
  )
}

export default function GenerateExportPanel({
  canGenerate,
  onGenerateRoadSkeleton,
  conceptualRoadResult: propConceptualRoadResult,
  secondaryRoadNetworkResult: propSecondaryRoadNetworkResult,
  isRoadGenerating,
  roadGenerationError,
  onBackToParameters,
  developmentOpportunityBlockResult,
  conceptualProgram: propConceptualProgram,
  conceptualLayout: propConceptualLayout,
  redevelopmentImpact,
  localStreetNetworkResult: propLocalStreetNetworkResult,
  parentParcelAreaAcres,
  selectedParcel,
  candidateOpenArea,
  candidateOpenAreaResult,
  existingBuildings,
  waterWetlands,
  existingPavement,
  conceptAlternatives,
  recommendedAlternativeId,
  authoritativeAlternativeId,
  generatingAlternativeId,
  isAlternativeGenerating,
  onSelectAlternative,
  parcelFeasibilityAssessment,
  terrainSuitability,
  submittedParameters,
  onSaveDraft
}: GenerateExportPanelProps) {
  const authoritativeAlternative = conceptAlternatives?.find(a => a.id === authoritativeAlternativeId) ?? null
  const activeStrategy = authoritativeAlternative?.strategy ?? 'BALANCED'
  const selectedAlternative = authoritativeAlternative

  const conceptualRoadResult = selectedAlternative?.primaryRoadResult ?? propConceptualRoadResult
  const secondaryRoadNetworkResult = selectedAlternative?.secondaryRoadResult ?? propSecondaryRoadNetworkResult
  const conceptualProgram = selectedAlternative?.conceptualProgram ?? propConceptualProgram
  const conceptualLayout = selectedAlternative?.developmentLayout ?? propConceptualLayout
  const localStreetNetworkResult = selectedAlternative?.localStreetResult ?? propLocalStreetNetworkResult

  const hasResult = !!conceptualRoadResult && (conceptualRoadResult.status === 'generated' || conceptualRoadResult.status === 'warning')
  const mcpi = conceptualRoadResult?.mcpi ?? ''
  const [openConceptDetails, setOpenConceptDetails] = useState<Record<string, boolean>>({})


  // --- Feasibility Overview values ---
  const parentParcelArea = parentParcelAreaAcres ?? null
  const candidateArea = conceptualProgram?.programmableAreaAcres ?? (conceptualRoadResult?.candidateAreaAcres ?? null)
  const networkServed =
    conceptualProgram?.actualTotalNetworkServedAreaAcres ??
    (secondaryRoadNetworkResult ? secondaryRoadNetworkResult.totalNetworkServedAreaSqFt / SQFT_PER_ACRE : null)
  const unserved =
    secondaryRoadNetworkResult?.residualUnservedDevelopableAreaSqFt != null
      ? secondaryRoadNetworkResult.residualUnservedDevelopableAreaSqFt / SQFT_PER_ACRE
      : (conceptualProgram?.residualAreaAcres ?? null)
  const primaryLength = conceptualRoadResult?.proposedRoadLengthFeet ?? null
  const secondaryCount = secondaryRoadNetworkResult?.secondaryRoadCount ?? null
  const secondaryLength = secondaryRoadNetworkResult?.totalSecondaryRoadLengthFt ?? null
  const localCount = localStreetNetworkResult?.localStreetCount ?? null
  const localLength = localStreetNetworkResult?.totalLocalStreetLengthFt ?? null

  // --- Constraint status logic ---
  const constraintExists = (nearestKey: keyof NonNullable<DevelopmentOpportunityBlockResult['blocks'][0]['constraintProximities']>) =>
    (developmentOpportunityBlockResult?.blocks || []).some(
      b => b.constraintProximities && typeof b.constraintProximities[nearestKey] === 'number' && b.constraintProximities[nearestKey]! >= 0
    )

  const buildingConflicts =
    (conceptualRoadResult?.buildingIntersectionCount ?? 0) +
    (conceptualRoadResult?.rightOfWayBuildingIntersectionCount ?? 0) +
    (conceptualLayout?.audit?.buildingConflictSqFt ?? 0)
  const waterConflicts =
    (conceptualRoadResult?.waterIntersectionCount ?? 0) +
    (conceptualRoadResult?.rightOfWayWaterIntersectionCount ?? 0) +
    (conceptualLayout?.audit?.hydrologyConflictSqFt ?? 0)
  const pavementConflicts =
    (conceptualRoadResult?.pavementIntersectionCount ?? 0) +
    (conceptualRoadResult?.rightOfWayPavementIntersectionCount ?? 0) +
    (conceptualLayout?.audit?.pavementConflictSqFt ?? 0)

  const buildingStatus: ConstraintStatus = buildingConflicts > 0
    ? 'LIMITING'
    : constraintExists('nearestBuildingFt')
    ? 'PRESENT'
    : 'CLEAR'

  const waterStatus: ConstraintStatus = waterConflicts > 0
    ? 'LIMITING'
    : constraintExists('nearestHydrologyFt')
    ? 'PRESENT'
    : 'CLEAR'

  const pavementStatus: ConstraintStatus = pavementConflicts > 0
    ? 'LIMITING'
    : constraintExists('nearestPavementFt')
    ? 'PRESENT'
    : 'CLEAR'

  const terrain = terrainStatus(conceptualRoadResult?.terrainProfile)

  const accessStatus: ConstraintStatus =
    conceptualRoadResult?.connectionMethod && conceptualRoadResult?.primarySpineAdequacy
      ? conceptualRoadResult.primarySpineAdequacy.status === 'MEANINGFUL_PRIMARY_SPINE'
        ? 'CLEAR'
        : conceptualRoadResult.primarySpineAdequacy.status === 'LIMITED_PRIMARY_SPINE'
        ? 'REVIEW'
        : 'LIMITING'
      : conceptualRoadResult?.connectionMethod
      ? 'CLEAR'
      : 'LIMITING'

  const primaryRoadConflictStatus: ConstraintStatus =
    buildingConflicts > 0 || waterConflicts > 0 || pavementConflicts > 0
      ? 'LIMITING'
      : constraintExists('nearestBuildingFt') || constraintExists('nearestHydrologyFt') || constraintExists('nearestPavementFt')
      ? 'PRESENT'
      : 'CLEAR'

  const otherHardStatus: ConstraintStatus =
    (conceptualLayout?.audit?.buildingConflictSqFt ?? 0) +
      (conceptualLayout?.audit?.hydrologyConflictSqFt ?? 0) +
      (conceptualLayout?.audit?.pavementConflictSqFt ?? 0) >
    0
      ? 'LIMITING'
      : constraintExists('nearestBuildingFt') || constraintExists('nearestHydrologyFt') || constraintExists('nearestPavementFt')
      ? 'PRESENT'
      : 'CLEAR'

  // --- Primary constraint ---
  const constraintItems: { label: string; status: ConstraintStatus }[] = [
    { label: 'Existing buildings', status: buildingStatus },
    { label: 'Water / wetlands', status: waterStatus },
    { label: 'Existing pavement', status: pavementStatus },
    { label: 'Terrain', status: terrain },
    { label: 'Access', status: accessStatus }
  ]
  const worstLevel = (['LIMITING', 'PRESENT', 'REVIEW'] as const).find(level => constraintItems.some(c => c.status === level))
  const primaryConstraint = worstLevel
    ? constraintItems.find(c => c.status === worstLevel)?.label ?? 'No major mapped constraint'
    : 'No major mapped constraint'

  // --- Recommended concept ---
  const accessMethod = conceptualRoadResult?.connectionMethod
    ? conceptualRoadResult.connectionMethod.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    : 'internal access'
  const accessLabel = conceptualRoadResult?.connectionStreetName ?? accessMethod
  const primaryFeet = primaryLength ?? 0
  const secondaryCnt = secondaryCount ?? 0
  const secondaryFt = secondaryLength ?? 0
  const localCnt = localCount ?? 0
  const localFt = localLength ?? 0

  const secondaryPhrase =
    secondaryCnt > 0
      ? `, plus ${secondaryCnt} secondary road${secondaryCnt === 1 ? '' : 's'} totaling ${fmtFt(secondaryFt)}`
      : ''
  const localPhrase =
    localCnt > 0
      ? ` ${localCnt} local street${localCnt === 1 ? '' : 's'} further extends frontage and unit yield.`
      : ''
  const conflictAvoidance =
    buildingConflicts + waterConflicts + pavementConflicts === 0
      ? ' The road network avoids mapped buildings, wetlands, and pavement.'
      : ''
  const developmentStrategy =
    `Access from the ${accessLabel} frontage. ` +
    `A ${fmtFt(primaryFeet)} primary spine serves the developable parcel${secondaryPhrase}.` +
    `${localPhrase}${conflictAvoidance}`

  const whyThisConcept: string[] = []
  if (conceptualRoadResult?.connectionMethod && conceptualRoadResult.connectionMethod !== 'internal-stub') {
    whyThisConcept.push('Provides direct access from existing public road frontage')
  }
  if ((networkServed ?? 0) > 0) {
    whyThisConcept.push(`Extends access to approximately ${(networkServed as number).toFixed(2)} acres of developable land`)
  }
  if (buildingConflicts === 0 && waterConflicts === 0 && pavementConflicts === 0) {
    whyThisConcept.push('Avoids mapped building/wetland/pavement conflicts')
  }
  const residualAcres = (conceptualProgram?.residualAreaAcres ?? (unserved ?? 0))
  if (residualAcres > 0) {
    whyThisConcept.push(`Retains approximately ${residualAcres.toFixed(2)} acres for future development`)
  }
  if (conceptualProgram?.selectedDevelopmentTypes?.some(t => /single|townhome|multi|duplex|cottage/i.test(t))) {
    whyThisConcept.push('Supports the selected residential program')
  }

  // --- Strengths / considerations ---
  const strengths: string[] = parcelFeasibilityAssessment?.positiveFactors?.length
    ? parcelFeasibilityAssessment.positiveFactors
    : whyThisConcept.length
      ? whyThisConcept
      : ['Selected concept is consistent with the screened site conditions']

  const considerations: string[] = parcelFeasibilityAssessment?.concernFactors?.length
    ? parcelFeasibilityAssessment.concernFactors
    : buildingConflicts + waterConflicts + pavementConflicts > 0
      ? ['Generated geometry intersects mapped hard constraints']
      : primaryConstraint !== 'No major mapped constraint'
        ? [`Primary constraint: ${primaryConstraint}`]
        : ['No major mapped constraints identified at this screening level']

  // --- Development Yield values (from the authoritative selected concept) ---
  const selectedConcept = authoritativeAlternative
  const selectedProgram = selectedConcept?.conceptualProgram
  const selectedLayout = selectedConcept?.developmentLayout

  const selectedUses =
    selectedProgram?.selectedDevelopmentTypes?.join(', ') ||
    selectedLayout?.selectedDevelopmentTypes?.join(', ') ||
    (selectedConcept?.parametersUsed?.developmentProgram
      ?.filter(u => u.enabled)
      .map(u => u.useType)
      .join(', ')) ||
    '—'
  const zoneCount = selectedProgram?.zones?.length ?? selectedLayout?.assignedZoneCount ?? null
  const padCount = selectedLayout?.developmentPadCount ?? null
  const townhomeRows = selectedLayout?.townhomeGenerationResult?.rowCount ?? null
  const townhomeUnits = selectedLayout?.townhomeGenerationResult?.unitCount ?? null
  const townhomeTarget = selectedLayout?.townhomeInputs?.targetUnitCount ?? null
  const townhomeShortfall = (townhomeTarget != null && townhomeUnits != null && townhomeUnits < townhomeTarget) ? townhomeTarget - townhomeUnits : 0
  const layoutArea = selectedLayout?.layoutAreaAcres ?? null
  const remainingOpportunity = selectedConcept?.metrics?.remainingOpportunityAcres ?? null
  const remainingOpportunitySource = selectedConcept?.metrics?.metricSources?.remainingOpportunityAcres ?? 'UNAVAILABLE'
  const estimatedUnits = selectedConcept?.metrics?.conceptualUnits ?? null
  const estimatedUnitsSource = selectedConcept?.metrics?.metricSources?.conceptualUnits ?? 'UNAVAILABLE'
  const hasTownhomeGeneration = selectedLayout?.townhomeGenerationResult?.status === 'generated'
  const singleFamilyHomes = selectedLayout?.singleFamilyGenerationResult?.homeCount ?? null
  const singleFamilyLots = selectedLayout?.singleFamilyGenerationResult?.lotCount ?? null
  const singleFamilyTarget = selectedLayout?.singleFamilyGenerationResult?.targetUnitCount ?? null
  const singleFamilyShortfall = (singleFamilyTarget != null && singleFamilyHomes != null && singleFamilyHomes < singleFamilyTarget) ? singleFamilyTarget - singleFamilyHomes : 0
  const hasSingleFamilyGeneration = selectedLayout?.singleFamilyGenerationResult?.status === 'generated'
  const apartmentResult = selectedLayout?.apartmentGenerationResult
  const commercialResult = selectedLayout?.commercialGenerationResult
  const hasApartmentGeneration = apartmentResult?.status === 'generated'
  const hasCommercialGeneration = commercialResult?.status === 'generated'
  const potentialSelectedTypes = selectedLayout?.selectedDevelopmentTypes ?? []
  const potentialResidentialUses = new Set(potentialSelectedTypes.map(canonicalUseType).filter(u => u === 'single-family' || u === 'townhomes'))
  const potentialActiveResidential = potentialResidentialUses.size === 1 ? [...potentialResidentialUses][0] : null
  const showTownhomeSection = hasTownhomeGeneration && potentialActiveResidential === 'townhomes'
  const showSingleFamilySection = hasSingleFamilyGeneration && potentialActiveResidential === 'single-family'
  const showApartmentSection = hasApartmentGeneration
  const showCommercialSection = hasCommercialGeneration

  // --- Feasibility / Confidence ---
  const feasibilityStatus = ((): 'FAVORABLE' | 'MODERATE' | 'CHALLENGING' => {
    if (!hasResult) return 'CHALLENGING'
    const capacity = conceptualProgram?.capacityStatus
    const terrainAssess = conceptualRoadResult?.terrainProfile?.terrainAssessment
    const hardConflicts =
      (conceptualLayout?.audit?.buildingConflictSqFt ?? 0) +
      (conceptualLayout?.audit?.hydrologyConflictSqFt ?? 0) +
      (conceptualLayout?.audit?.pavementConflictSqFt ?? 0)
    if (capacity === 'ROAD_SUPPORTED' && terrainAssess === 'FAVORABLE' && hardConflicts === 0) return 'FAVORABLE'
    if (capacity === 'LATENT_ACCESS_CONSTRAINED' || capacity === 'UNAVAILABLE' || terrainAssess === 'CHALLENGING' || hardConflicts > 0) return 'CHALLENGING'
    return 'MODERATE'
  })()

  const confidence = ((): 'HIGH' | 'MEDIUM' | 'LOW' => {
    if (!hasResult) return 'LOW'
    const terrainConf = conceptualRoadResult?.terrainProfile?.confidence
    if (
      conceptualLayout?.status === 'generated' &&
      conceptualProgram?.capacityStatus === 'ROAD_SUPPORTED' &&
      (terrainConf === 'HIGH' || terrainConf === 'MODERATE') &&
      roadGenerationError == null
    ) return 'HIGH'
    if (conceptualProgram?.capacityStatus === 'PARTIALLY_NETWORK_SUPPORTED' || terrainConf === 'LOW') return 'MEDIUM'
    return 'LOW'
  })()

  const buttonLabel = isRoadGenerating
    ? 'Generating…'
    : hasResult
    ? 'Road Concept Generated'
    : 'Generate Road Concept'

  const isSelectedAuthoritative = selectedAlternative?.metrics.isAuthoritative === true
  const isGeoJsonExportEnabled = hasResult && isSelectedAuthoritative
  const fileBase = `SubDivMakerV2_${(mcpi || 'site').replace(/[^a-zA-Z0-9_-]/g, '_')}_${activeStrategy}`

  // --- Exports ---
  function downloadJSON(payload: any, filename: string) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  function exportFeasibilitySummary() {
    const safe = (n?: number | null) => (n == null || isNaN(n) ? null : Number(n.toFixed(4)))
    const safePct = (n?: number | null) => (n == null || isNaN(n) ? null : Number(n.toFixed(2)))
    const generatedAt = new Date().toISOString()
    const selectedUseTypes = conceptualProgram?.selectedDevelopmentTypes ?? conceptualLayout?.selectedDevelopmentTypes ?? []

    const alternativesPayload = conceptAlternatives?.map(alt => {
      const status: 'AUTHORITATIVE' | 'ESTIMATE' | 'UNAVAILABLE' =
        alt.metrics.isAuthoritative ? 'AUTHORITATIVE' : alt.status === 'limited' ? 'UNAVAILABLE' : 'ESTIMATE'
      return {
        strategy: alt.strategy,
        status,
        comparisonScore: safe(alt.comparisonScore),
        conceptualUnits: { value: safe(alt.metrics.conceptualUnits), source: alt.metrics.metricSources.conceptualUnits },
        networkServedAcres: { value: safe(alt.metrics.networkServedAcres), source: alt.metrics.metricSources.networkServedAcres },
        totalRoadLengthFt: { value: safe(alt.metrics.totalRoadLengthFt), source: alt.metrics.metricSources.totalRoadLengthFt },
        remainingOpportunityAcres: { value: safe(alt.metrics.remainingOpportunityAcres), source: alt.metrics.metricSources.remainingOpportunityAcres }
      }
    }) ?? []

    const redevelopmentPayload = (() => {
      if (submittedParameters?.parameters?.developmentApproach !== 'REDEVELOPMENT') {
        return null
      }
      const bc = candidateOpenAreaResult?.buildingClassification
      const pc = candidateOpenAreaResult?.pavementClassification
      const ic = candidateOpenAreaResult?.internalRoadClassification
      return {
        developmentApproach: 'REDEVELOPMENT',
        buildingTreatment: submittedParameters.parameters.redevelopment.buildingTreatment,
        pavementTreatment: submittedParameters.parameters.redevelopment.pavementTreatment,
        internalRoadTreatment: submittedParameters.parameters.redevelopment.internalRoadTreatment,
        buildings: bc ? {
          totalMappedCount: bc.totalBuildingCount,
          preservedCount: bc.preservedBuildingCount,
          redevelopmentEligibleCount: bc.redevelopmentEligibleBuildingCount,
          totalMappedAreaSqFt: safe(bc.preservedBuildingAreaSqFt + bc.redevelopmentEligibleBuildingAreaSqFt),
          preservedAreaSqFt: safe(bc.preservedBuildingAreaSqFt),
          redevelopmentEligibleAreaSqFt: safe(bc.redevelopmentEligibleBuildingAreaSqFt)
        } : null,
        pavement: pc ? {
          totalMappedCount: pc.totalPavementCount,
          preservedCount: pc.preservedPavementCount,
          reconfigurationEligibleCount: pc.reconfigurationEligiblePavementCount,
          totalMappedAreaSqFt: safe(pc.preservedPavementAreaSqFt + pc.reconfigurationEligiblePavementAreaSqFt),
          preservedAreaSqFt: safe(pc.preservedPavementAreaSqFt),
          reconfigurationEligibleAreaSqFt: safe(pc.reconfigurationEligiblePavementAreaSqFt)
        } : null,
        internalRoads: ic ? {
          classificationBasis: ic.classificationBasis,
          protectedExternalRoadCount: ic.protectedExternalRoadCount,
          reconfigurationEligibleInternalRoadCount: ic.reconfigurationEligibleInternalRoadCount,
          protectedExternalRoadLengthFt: safe(ic.protectedExternalRoadLengthFt),
          reconfigurationEligibleInternalRoadLengthFt: safe(ic.reconfigurationEligibleInternalRoadLengthFt)
        } : null
      }
    })()

    const payload = {
      project: {
        name: PROJECT_NAME,
        schemaVersion: SCHEMA_VERSION,
        generatedAt,
        conceptualOnly: true,
        developmentApproach: submittedParameters?.parameters?.developmentApproach ?? 'NEW_DEVELOPMENT',
        redevelopment: redevelopmentPayload
      },
      parcel: {
        mcpi,
        parentParcelAreaAcres: parentParcelArea,
        candidateOpenAreaAcres: safe(candidateArea),
        networkServedAreaAcres: safe(networkServed),
        candidateOpenAreaPercent: parentParcelArea && parentParcelArea > 0 ? safePct((candidateArea ?? 0) / parentParcelArea * 100) : null
      },
      screening: {
        scope: 'parcelPreGeneration',
        overallRating: parcelFeasibilityAssessment?.overallRating ?? 'INSUFFICIENT DATA',
        confidence: parcelFeasibilityAssessment?.confidence ?? 'LOW',
        dominantConstraint: parcelFeasibilityAssessment?.dominantConstraint ?? primaryConstraint,
        strengths,
        considerations
      },
      selectedConcept: {
        alternativeId: authoritativeAlternativeId ?? 'BALANCED',
        strategy: activeStrategy,
        strategyLabel: STRATEGY_LABELS[activeStrategy],
        isAuthoritative: isSelectedAuthoritative,
        isRecommended: authoritativeAlternativeId === recommendedAlternativeId,
        recommendedAlternativeId,
        recommendedStrategy: recommendedAlternativeId ? STRATEGY_LABELS[recommendedAlternativeId] : null,
        comparisonScore: safe(selectedAlternative?.comparisonScore ?? null),
        accessPoint: accessLabel,
        primaryRoadLengthFt: primaryLength,
        secondaryRoadCount: secondaryCount,
        secondaryRoadLengthFt: secondaryLength,
        localStreetCount: localCount,
        localStreetLengthFt: localLength,
        feasibilityStatus,
        confidence,
        description: developmentStrategy,
        roadGrammar: {
          terrainRoadMode: conceptualRoadResult?.terrainRoadMode ?? 'DIRECT_FALLBACK',
          terrainAlignmentScore: safe(conceptualRoadResult?.terrainAlignmentScore ?? null),
          roadPrecedentPattern: conceptualRoadResult?.roadPrecedentPattern ?? 'INSUFFICIENT_DATA',
          roadPrecedentConfidence: conceptualRoadResult?.roadPrecedentConfidence ?? 'UNAVAILABLE',
          roadPrecedentScore: safe(conceptualRoadResult?.roadPrecedentScore ?? null),
          hierarchy: {
            secondaryOrientationPreference: conceptualRoadResult?.terrainRoadMode === 'CONTOUR_FOLLOWING'
              ? 'FALL_LINE_BIASED'
              : conceptualRoadResult?.terrainRoadMode === 'FALL_LINE'
                ? 'CONTOUR_BIASED'
                : 'EXISTING_LOGIC',
            localOrientationPreference: conceptualRoadResult?.terrainRoadMode === 'CONTOUR_FOLLOWING'
              ? 'FRONTAGE_WITH_CONTOUR_BIAS'
              : conceptualRoadResult?.terrainRoadMode === 'FALL_LINE'
                ? 'FRONTAGE_WITH_CROSS_CONTOUR_BIAS'
                : 'EXISTING_LOGIC'
          }
        }
      },
      constraints: {
        existingBuildings: buildingStatus,
        waterWetlands: waterStatus,
        existingPavement: pavementStatus,
        terrain,
        access: accessStatus,
        primaryRoadConflicts: primaryRoadConflictStatus,
        otherHardConstraints: otherHardStatus,
        hardConflictSummary: {
          buildingSqFt: safe(conceptualLayout?.audit?.buildingConflictSqFt),
          hydrologySqFt: safe(conceptualLayout?.audit?.hydrologyConflictSqFt),
          pavementSqFt: safe(conceptualLayout?.audit?.pavementConflictSqFt)
        }
      },
      roads: {
        primary: {
          connectionStreet: conceptualRoadResult?.connectionStreetName ?? null,
          connectionType: conceptualRoadResult?.connectionMethod ?? null,
          lengthFt: primaryLength
        },
        secondary: {
          count: secondaryCount,
          totalLengthFt: secondaryLength
        },
        local: {
          count: localCount,
          totalLengthFt: localLength
        },
        totalRoadLengthFt: safe(selectedAlternative?.metrics.totalRoadLengthFt ?? null)
      },
      development: {
        selectedUses: selectedUseTypes,
        developmentZoneCount: zoneCount,
        developmentPadCount: padCount,
        townhomeRowCount: townhomeRows,
        townhomeUnitCount: townhomeUnits,
        conceptualUnitCount: safe(selectedAlternative?.metrics.conceptualUnits ?? null),
        layoutAreaAcres: safe(layoutArea),
        remainingOpportunityAcres: safe(selectedAlternative?.metrics.remainingOpportunityAcres ?? null),
        redevelopmentImpact: submittedParameters?.parameters?.developmentApproach === 'REDEVELOPMENT' && redevelopmentImpact ? {
          impactLevel: redevelopmentImpact.redevelopmentImpactLevel,
          eligibleBuildingAreaImpactedSqFt: safe(redevelopmentImpact.eligibleBuildingAreaImpactedSqFt),
          eligiblePavementAreaImpactedSqFt: safe(redevelopmentImpact.eligiblePavementAreaImpactedSqFt),
          estimatedBuildingFootprintImpacted: redevelopmentImpact.estimatedBuildingFootprintImpacted,
          estimatedPavementFootprintImpacted: redevelopmentImpact.estimatedPavementFootprintImpacted,
          notes: 'Conceptual estimate of disturbance to mapped redevelopment-eligible features under the selected site treatment.'
        } : null
      },
      comparison: {
        recommendedStrategy: recommendedAlternativeId,
        selectedAlternativeId: authoritativeAlternativeId,
        alternatives: alternativesPayload
      },
      assumptions: {
        source: 'GIS and parameter inputs',
        coordinateReferenceSystem: 'EPSG:4326',
        conceptualOnly: true,
        engineeringReviewRequired: true,
        notes: 'Densities, setbacks, and yield are planning-level estimates and must be verified during civil design and entitlements.'
      },
      disclaimer:
        'Conceptual feasibility output only. Not construction-ready. Geometry should be reviewed and refined by a licensed civil engineer before survey, entitlement, permitting, or construction use.'
    }

    downloadJSON(payload, `${fileBase}_Feasibility.json`)
  }

  function exportGeoJSON() {
    if (!isGeoJsonExportEnabled) {
      if (import.meta.env.DEV) console.warn('[ExportConsistencyAudit] GeoJSON export blocked: selected concept is not fully generated', { authoritativeAlternativeId, isSelectedAuthoritative, hasResult })
      return
    }

    const features: GeoJSON.Feature<GeoJSON.Geometry>[] = []
    const generatedAt = new Date().toISOString()
    const developmentApproach = submittedParameters?.parameters?.developmentApproach ?? 'NEW_DEVELOPMENT'

    const commonProps: Record<string, any> = {
      project: PROJECT_NAME,
      schemaVersion: SCHEMA_VERSION,
      mcpi,
      alternativeId: authoritativeAlternativeId ?? 'BALANCED',
      strategy: activeStrategy,
      featureType: null,
      conceptualOnly: true,
      developmentApproach,
      coordinateReferenceSystem: 'EPSG:4326',
      generatedAt
    }

    function pushLayer(input: any, extraProps: Record<string, any>) {
      toFeatures(input).forEach(f => {
        features.push({
          type: 'Feature',
          geometry: f.geometry,
          properties: { ...(f.properties || {}), ...commonProps, ...extraProps }
        })
      })
    }

    pushLayer(selectedParcel, { featureType: 'selected_parent_parcel' })
    pushLayer(candidateOpenArea, { featureType: 'candidate_open_area' })
    pushLayer(existingBuildings, { featureType: 'existing_building' })
    pushLayer(waterWetlands, { featureType: 'water_wetland' })
    pushLayer(existingPavement, { featureType: 'existing_pavement' })

    pushLayer(conceptualRoadResult?.proposedRoadCenterline, {
      featureType: 'primary_road_centerline',
      roadType: 'primary',
      lengthFt: primaryLength,
      rowWidthFt: (conceptualRoadResult as any)?.proposedRoadWidthFt ?? null
    })
    pushLayer(conceptualRoadResult?.proposedRightOfWay, {
      featureType: 'primary_road_row',
      roadType: 'primary',
      lengthFt: primaryLength,
      rowWidthFt: (conceptualRoadResult as any)?.proposedRoadWidthFt ?? null
    })

    secondaryRoadNetworkResult?.roads?.forEach(r => {
      pushLayer(r.centerlineGeometry, { featureType: 'secondary_road_centerline', roadType: 'secondary', roadId: r.id, lengthFt: r.lengthFt ?? null, rowWidthFt: (r as any).rightOfWayWidthFt ?? null })
      pushLayer(r.rightOfWayGeometry, { featureType: 'secondary_road_row', roadType: 'secondary', roadId: r.id, lengthFt: r.lengthFt ?? null, rowWidthFt: (r as any).rightOfWayWidthFt ?? null })
    })

    localStreetNetworkResult?.localStreets?.forEach(s => {
      pushLayer(s.centerlineGeometry, { featureType: 'local_street_centerline', roadType: 'local', roadId: s.id, lengthFt: s.lengthFt ?? null, rowWidthFt: (s as any).rightOfWayWidthFt ?? null })
      pushLayer(s.rightOfWayGeometry, { featureType: 'local_street_row', roadType: 'local', roadId: s.id, lengthFt: s.lengthFt ?? null, rowWidthFt: (s as any).rightOfWayWidthFt ?? null })
    })

    conceptualProgram?.zones?.forEach(z => {
      pushLayer(z.geometry, { featureType: 'development_zone', zoneId: z.id, useType: z.bestCompatibleUse, developmentUse: z.bestCompatibleUse })
    })

    conceptualLayout?.developmentPads?.forEach(p => {
      const padFeatureType =
        p.useType === 'commercial' ? 'commercial_pad' :
        p.useType === 'multifamily' ? 'apartment_pad' :
        'development_pad'
      pushLayer(p.geometry, { featureType: padFeatureType, padId: p.id, useType: p.useType, developmentUse: p.useType })
    })

    conceptualLayout?.townhomeGenerationResult?.rows?.forEach(r => {
      pushLayer(r.geometry, { featureType: 'townhome_row', rowId: r.id, roadType: r.frontageRoadType, unitCount: r.unitCount, developmentUse: (r as any).useType ?? null })
      r.unitEnvelopes?.forEach(u => {
        pushLayer(u.geometry, { featureType: 'townhome_unit', rowId: r.id, unitId: u.id, developmentUse: (r as any).useType ?? null })
      })
    })

    conceptualLayout?.lotCells?.forEach(l => {
      pushLayer(l.geometry, { featureType: 'single_family_lot', lotId: l.id, zoneId: l.zoneId, servingRoadType: l.frontageRoadId, developmentUse: l.useType })
    })

    conceptualLayout?.buildingEnvelopes?.forEach(e => {
      const parentPad = conceptualLayout?.developmentPads?.find(p => p.id === e.parentLotId)
      const buildingFeatureType =
        parentPad?.useType === 'commercial' ? 'commercial_building' :
        parentPad?.useType === 'multifamily' ? 'apartment_building' :
        'single_family_building'
      const developmentUse = parentPad?.useType ?? 'single-family'
      pushLayer(e.geometry, { featureType: buildingFeatureType, buildingId: e.id, parentLotId: e.parentLotId, developmentUse })
    })

    const featureCounts: Record<string, number> = {}
    const allTypes = [
      'selected_parent_parcel', 'candidate_open_area', 'existing_building', 'water_wetland', 'existing_pavement',
      'primary_road_centerline', 'primary_road_row', 'secondary_road_centerline', 'secondary_road_row',
      'local_street_centerline', 'local_street_row', 'development_zone', 'development_pad',
      'apartment_pad', 'apartment_building', 'commercial_pad', 'commercial_building',
      'townhome_row', 'townhome_unit',
      'single_family_lot', 'single_family_building'
    ]
    allTypes.forEach(t => { featureCounts[t] = 0 })
    features.forEach(f => {
      const t = f.properties?.featureType as string
      if (t) featureCounts[t] = (featureCounts[t] ?? 0) + 1
    })

    const visibleMetrics = {
      candidateOpenAreaAcres: candidateArea,
      networkServedAcres: networkServed,
      primaryRoadLengthFt: primaryLength,
      secondaryRoadCount: secondaryCount,
      secondaryRoadLengthFt: secondaryLength,
      localStreetCount: localCount,
      localStreetLengthFt: localLength,
      developmentZoneCount: zoneCount,
      developmentPadCount: padCount,
      townhomeRowCount: townhomeRows,
      townhomeUnitCount: townhomeUnits,
      remainingOpportunityAcres: remainingOpportunity
    }

    const exportMismatches: string[] = []
    if (townhomeRows != null && featureCounts.townhome_row !== townhomeRows) {
      exportMismatches.push(`townhome_row count ${featureCounts.townhome_row} !== townhomeRowCount ${townhomeRows}`)
    }
    if (townhomeUnits != null && featureCounts.townhome_unit !== townhomeUnits) {
      exportMismatches.push(`townhome_unit count ${featureCounts.townhome_unit} !== townhomeUnitCount ${townhomeUnits}`)
    }
    if (padCount != null && featureCounts.development_pad !== padCount) {
      exportMismatches.push(`development_pad count ${featureCounts.development_pad} !== developmentPadCount ${padCount}`)
    }
    if (zoneCount != null && featureCounts.development_zone !== zoneCount) {
      exportMismatches.push(`development_zone count ${featureCounts.development_zone} !== developmentZoneCount ${zoneCount}`)
    }
    if (localCount != null && featureCounts.local_street_centerline !== localCount) {
      exportMismatches.push(`local_street_centerline count ${featureCounts.local_street_centerline} !== localStreetCount ${localCount}`)
    }
    if (secondaryCount != null && featureCounts.secondary_road_centerline !== secondaryCount) {
      exportMismatches.push(`secondary_road_centerline count ${featureCounts.secondary_road_centerline} !== secondaryRoadCount ${secondaryCount}`)
    }
    if (import.meta.env.DEV && exportMismatches.length > 0) {
      console.warn('[ExportIntegrityAssertion] DEV mismatch:', { mcpi, activeStrategy, mismatches: exportMismatches })
    }

    const collection: any = { type: 'FeatureCollection', features, coordinateReferenceSystem: 'EPSG:4326' }
    if (developmentApproach === 'REDEVELOPMENT' && redevelopmentImpact) {
      collection.redevelopment = {
        impactLevel: redevelopmentImpact.redevelopmentImpactLevel,
        eligibleBuildingAreaImpactedSqFt: redevelopmentImpact.eligibleBuildingAreaImpactedSqFt,
        eligiblePavementAreaImpactedSqFt: redevelopmentImpact.eligiblePavementAreaImpactedSqFt,
        estimatedBuildingFootprintImpacted: redevelopmentImpact.estimatedBuildingFootprintImpacted,
        estimatedPavementFootprintImpacted: redevelopmentImpact.estimatedPavementFootprintImpacted,
        notes: 'Collection-level conceptual estimate of disturbance to mapped redevelopment-eligible features.'
      }
    }
    downloadJSON(collection, `${fileBase}_Concept.geojson`)
  }

  return (
    <div className="space-y-5">
      {onBackToParameters && (
        <button
          type="button"
          onClick={() => onBackToParameters && onBackToParameters()}
          className="flex items-center gap-2 text-[13px] font-medium transition-colors hover:opacity-80"
          style={{ color: 'var(--soft-seafoam)' }}
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Parameters
        </button>
      )}

      <div>
        <h3 className="text-[18px] font-bold leading-[1.3]" style={{ color: '#ffffff' }}>Generate & Export</h3>
        <p className="text-[13px] leading-[1.45]" style={{ color: 'var(--text-secondary)' }}>
          Concept feasibility memo and handoff exports
        </p>
      </div>

      <CollapsibleSection id="dev-approach" title="Development Approach" defaultOpen={false}>
        {fmtLabel('Development approach', submittedParameters?.parameters?.developmentApproach?.replace(/_/g, ' ') ?? 'New Development')}
        {submittedParameters?.parameters?.developmentApproach === 'REDEVELOPMENT' && (
          <CollapsibleSection id="redevelopment-treatment" title="Existing Site Treatment" defaultOpen={false}>
            <div className="space-y-0.5">
              {fmtLabel('Existing building treatment', submittedParameters.parameters.redevelopment.buildingTreatment.replace(/_/g, ' '))}
              {fmtLabel('Existing pavement treatment', submittedParameters.parameters.redevelopment.pavementTreatment.replace(/_/g, ' '))}
              {fmtLabel('Internal road treatment', submittedParameters.parameters.redevelopment.internalRoadTreatment.replace(/_/g, ' '))}
            </div>

            {candidateOpenAreaResult && (
              <div className="mt-2 p-2 rounded space-y-2" style={{ background: 'rgba(5, 8, 7, 0.55)' }}>
                <p className="text-[10px] uppercase text-slate-400 mb-1">Redevelopment Effect</p>
                <p className="text-[11px] leading-[1.3]" style={{ color: 'var(--text-secondary)' }}>
                  Redevelopment treatment changes which mapped existing features act as hard constraints. Original mapped features remain visible and exportable.
                </p>

                {candidateOpenAreaResult.buildingClassification && (
                  <div className="space-y-0.5">
                    {fmtLabel('Building treatment applied', candidateOpenAreaResult.buildingClassification.buildingTreatment?.replace(/_/g, ' ') ?? '—')}
                    {fmtLabel('Buildings preserved', fmtCount(candidateOpenAreaResult.buildingClassification.preservedBuildingCount))}
                    {fmtLabel('Buildings redevelopment-eligible', fmtCount(candidateOpenAreaResult.buildingClassification.redevelopmentEligibleBuildingCount))}
                    {fmtLabel('Building area preserved', fmtAc(candidateOpenAreaResult.buildingClassification.preservedBuildingAreaSqFt / SQFT_PER_ACRE))}
                    {fmtLabel('Building area released', fmtAc(candidateOpenAreaResult.buildingClassification.redevelopmentEligibleBuildingAreaSqFt / SQFT_PER_ACRE))}
                  </div>
                )}

                {candidateOpenAreaResult.pavementClassification && (
                  <div className="space-y-0.5">
                    {fmtLabel('Pavement treatment applied', candidateOpenAreaResult.pavementClassification.pavementTreatment?.replace(/_/g, ' ') ?? '—')}
                    {fmtLabel('Pavement preserved', fmtCount(candidateOpenAreaResult.pavementClassification.preservedPavementCount))}
                    {fmtLabel('Pavement reconfig-eligible', fmtCount(candidateOpenAreaResult.pavementClassification.reconfigurationEligiblePavementCount))}
                    {fmtLabel('Pavement area preserved', fmtAc(candidateOpenAreaResult.pavementClassification.preservedPavementAreaSqFt / SQFT_PER_ACRE))}
                    {fmtLabel('Pavement area released', fmtAc(candidateOpenAreaResult.pavementClassification.reconfigurationEligiblePavementAreaSqFt / SQFT_PER_ACRE))}
                  </div>
                )}

                {candidateOpenAreaResult.internalRoadClassification && (
                  <div className="space-y-0.5">
                    {fmtLabel('Internal road treatment applied', candidateOpenAreaResult.internalRoadClassification.internalRoadTreatment?.replace(/_/g, ' ') ?? '—')}
                    {fmtLabel('Protected external roads', `${fmtCount(candidateOpenAreaResult.internalRoadClassification.protectedExternalRoadCount)} (${fmtFt(candidateOpenAreaResult.internalRoadClassification.protectedExternalRoadLengthFt)})`)}
                    {fmtLabel('Reconfig-eligible internal roads', `${fmtCount(candidateOpenAreaResult.internalRoadClassification.reconfigurationEligibleInternalRoadCount)} (${fmtFt(candidateOpenAreaResult.internalRoadClassification.reconfigurationEligibleInternalRoadLengthFt)})`)}
                    {candidateOpenAreaResult.internalRoadClassification.classificationBasis === 'CONSERVATIVE_NO_RELIABLE_INTERNAL_CLASSIFICATION' && (
                      <p className="text-[11px] leading-[1.3] mt-1" style={{ color: 'var(--text-secondary)' }}>
                        Internal road reconfiguration requested, but current GIS data cannot reliably distinguish private/internal circulation from the public road network. External/public access constraints remain protected.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </CollapsibleSection>
        )}
      </CollapsibleSection>

      {!hasResult && (
        <button
          onClick={() => {
            if (!isRoadGenerating && !hasResult && canGenerate) {
              onGenerateRoadSkeleton()
            }
          }}
          disabled={!canGenerate || isRoadGenerating || hasResult}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-[15px] font-bold leading-[1.45] transition-all"
          style={{
            background: !canGenerate || isRoadGenerating || hasResult ? 'rgba(64, 130, 109, 0.2)' : 'var(--button-gradient)',
            color: !canGenerate || isRoadGenerating || hasResult ? 'var(--text-secondary)' : 'var(--brand-black)',
            border: '1px solid var(--viridian)',
            opacity: !canGenerate ? 0.6 : 1
          }}
        >
          {isRoadGenerating ? (
            <><Loader className="w-4 h-4 animate-spin" />{buttonLabel}</>
          ) : hasResult ? (
            <><CheckCircle2 className="w-4 h-4" />{buttonLabel}</>
          ) : (
            <>{buttonLabel}<ArrowLeft className="w-4 h-4 rotate-180" /></>
          )}
        </button>
      )}

      {!canGenerate && (
        <p className="text-[13px] leading-[1.45]" style={{ color: 'var(--text-secondary)' }}>
          Run the Candidate Open Area analysis first to enable the feasibility concept.
        </p>
      )}

      {roadGenerationError && (
        <div
          className="flex items-start gap-2 rounded-lg p-3 border text-[13px] leading-[1.45]"
          style={{ background: 'rgba(245, 158, 11, 0.08)', borderColor: '#f59e0b', color: '#fbbf24' }}
        >
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span className="whitespace-pre-line">{roadGenerationError}</span>
        </div>
      )}

      {hasResult && (
        <>
          {/* Concept Options */}
          {conceptAlternatives && conceptAlternatives.length > 0 && (
            <div className="rounded-lg p-4 border" style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}>
              <h4 className="text-[15px] font-bold mb-2" style={{ color: '#ffffff' }}>Concept Options</h4>
              <div className="space-y-2">
                {conceptAlternatives.map((alt) => {
                  const isSelected = alt.id === authoritativeAlternativeId
                  const isGenerating = alt.id === generatingAlternativeId
                  const isRecommended = alt.id === recommendedAlternativeId
                  const isLimited = alt.status === 'limited'
                  const isFull = alt.metrics.isAuthoritative
                  const m = alt.metrics
                  const selectedForCard = alt.developmentLayout?.selectedDevelopmentTypes ?? []
                  const cardResidentialUses = new Set(selectedForCard.map(canonicalUseType).filter(u => u === 'single-family' || u === 'townhomes'))
                  const cardActiveResidential = cardResidentialUses.size === 1 ? [...cardResidentialUses][0] : null
                  const thResult = alt.developmentLayout?.townhomeGenerationResult
                  const thInputs = alt.developmentLayout?.townhomeInputs
                  const showGeneratedUnits = isFull && cardActiveResidential === 'townhomes' && thResult?.status === 'generated'
                  const generatedUnits = showGeneratedUnits ? thResult!.unitCount : null
                  const targetUnits = showGeneratedUnits ? (thInputs?.targetUnitCount ?? null) : null
                  const isPartialPlacement = showGeneratedUnits && generatedUnits != null && targetUnits != null && generatedUnits < targetUnits
                  const sfResult = alt.developmentLayout?.singleFamilyGenerationResult
                  const showGeneratedHomes = isFull && cardActiveResidential === 'single-family' && sfResult?.status === 'generated'
                  const generatedHomes = showGeneratedHomes ? sfResult!.homeCount : null
                  const targetHomes = showGeneratedHomes ? (sfResult?.targetUnitCount ?? null) : null
                  const isPartialHomes = showGeneratedHomes && generatedHomes != null && targetHomes != null && generatedHomes < targetHomes
                  const cardApt = alt.developmentLayout?.apartmentGenerationResult
                  const cardComm = alt.developmentLayout?.commercialGenerationResult
                  const showApartmentBuildings = isFull && cardApt?.status === 'generated'
                  const generatedAptBuildings = showApartmentBuildings ? cardApt!.buildingCount : null
                  const aptCapacity = showApartmentBuildings ? (cardApt!.targetCapacity ?? null) : null
                  const showCommercialBuildings = isFull && cardComm?.status === 'generated'
                  const generatedCommBuildings = showCommercialBuildings ? cardComm!.buildingCount : null
                  const tradeoffs = getTradeoffs(alt, conceptAlternatives)
                  const status: string = isSelected ? 'SELECTED' : isLimited ? 'LIMITED' : isFull ? 'GENERATED' : 'ESTIMATE'
                  const detailsOpen = !!openConceptDetails[alt.id]
                  return (
                    <div
                      key={alt.id}
                      className="rounded-lg p-2.5 border transition-all"
                      style={{
                        background: isSelected ? 'rgba(64, 130, 109, 0.18)' : 'rgba(5, 8, 7, 0.55)',
                        borderColor: isSelected ? 'var(--viridian)' : 'rgba(64, 130, 109, 0.45)'
                      }}
                    >
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                            <span className="text-[14px] font-bold" style={{ color: '#ffffff' }}>{alt.label}</span>
                            <StrategyStatusBadge status={status} />
                            {isRecommended && <StrategyStatusBadge status="RECOMMENDED" />}
                          </div>
                          <p className="text-[11px] leading-snug" style={{ color: 'var(--soft-seafoam)' }}>
                            {STRATEGY_PURPOSE[alt.id]}
                          </p>
                        </div>
                        <button
                          type="button"
                          disabled={isAlternativeGenerating || isSelected || isLimited}
                          onClick={() => onSelectAlternative && onSelectAlternative(alt.id)}
                          className="shrink-0 px-2.5 py-1.5 rounded text-[11px] font-semibold transition-all disabled:opacity-60"
                          style={{
                            background: isSelected ? 'transparent' : 'var(--button-gradient)',
                            color: isSelected ? 'var(--soft-seafoam)' : 'var(--brand-black)',
                            border: `1px solid var(--viridian)`
                          }}
                        >
                          {isGenerating ? (
                            <span className="flex items-center gap-1"><Loader className="w-3 h-3 animate-spin" /> Generating…</span>
                          ) : isSelected ? (
                            'Selected'
                          ) : isLimited ? (
                            'Limited'
                          ) : isFull ? (
                            'View Concept'
                          ) : (
                            'Generate Full Concept'
                          )}
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-2 mt-2.5">
                        <div className="flex flex-col">
                          <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>Conceptual Units</span>
                          <span className="text-[13px] font-semibold" style={{ color: '#ffffff' }}>
                            {showGeneratedHomes ? fmtCount(generatedHomes) : showGeneratedUnits ? fmtCount(generatedUnits) : showApartmentBuildings ? fmtCount(generatedAptBuildings) : showCommercialBuildings ? fmtCount(generatedCommBuildings) : fmtMetricValue(m.conceptualUnits, m.metricSources.conceptualUnits, 'count')}
                          </span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>Served Area</span>
                          <span className="text-[13px] font-semibold" style={{ color: '#ffffff' }}>{fmtMetricValue(m.networkServedAcres, m.metricSources.networkServedAcres, 'ac')}</span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>Road Length</span>
                          <span className="text-[13px] font-semibold" style={{ color: '#ffffff' }}>{fmtMetricValue(m.totalRoadLengthFt, m.metricSources.totalRoadLengthFt, 'ft')}</span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>Constraint Impact</span>
                          <span className="text-[13px] font-semibold" style={{ color: '#ffffff' }}>{fmtMetricText(m.constraintImpact, m.metricSources.constraintImpact)}</span>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => setOpenConceptDetails(prev => ({ ...prev, [alt.id]: !detailsOpen }))}
                        className="mt-2 flex items-center gap-1 text-[11px] font-semibold transition-colors hover:opacity-80"
                        style={{ color: 'var(--seafoam)' }}
                      >
                        {detailsOpen ? 'Hide Details' : 'View Details'}
                        <ChevronDown className="w-3 h-3" style={{ transform: detailsOpen ? 'rotate(180deg)' : undefined }} />
                      </button>

                      {detailsOpen && (
                        <div className="mt-2 pt-2 border-t space-y-2" style={{ borderColor: 'var(--card-border)' }}>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="flex flex-col">
                              <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>Remaining opportunity</span>
                              <span className="text-[13px] font-semibold" style={{ color: '#ffffff' }}>{fmtMetricValue(m.remainingOpportunityAcres, m.metricSources.remainingOpportunityAcres, 'ac')}</span>
                            </div>
                            <div className="flex flex-col">
                              <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>Concept feasibility</span>
                              <span className="text-[13px] font-semibold" style={{ color: '#ffffff' }}>{fmtMetricText(m.feasibilityStatus, m.metricSources.feasibilityStatus)}</span>
                            </div>
                          </div>

                          {showGeneratedHomes ? (
                            <div className="space-y-1 text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>
                              <div className="flex justify-between">
                                <span>Generated homes</span>
                                <span className="font-semibold" style={{ color: '#ffffff' }}>{fmtCount(generatedHomes)}</span>
                              </div>
                              {targetHomes != null && (
                                <div className="flex justify-between text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                                  <span>Target</span>
                                  <span>{fmtCount(targetHomes)}</span>
                                </div>
                              )}
                              {isPartialHomes && (
                                <div className="text-[11px]" style={{ color: 'var(--soft-seafoam)' }}>
                                  {generatedHomes} of {targetHomes} target homes placed
                                </div>
                              )}
                            </div>
                          ) : showGeneratedUnits ? (
                            <div className="space-y-1 text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>
                              <div className="flex justify-between">
                                <span>Generated townhome units</span>
                                <span className="font-semibold" style={{ color: '#ffffff' }}>{fmtCount(generatedUnits)}</span>
                              </div>
                              {targetUnits != null && (
                                <div className="flex justify-between text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                                  <span>Target</span>
                                  <span>{fmtCount(targetUnits)}</span>
                                </div>
                              )}
                              {isPartialPlacement && (
                                <div className="text-[11px]" style={{ color: 'var(--soft-seafoam)' }}>
                                  {generatedUnits} of {targetUnits} target units placed
                                </div>
                              )}
                            </div>
                          ) : showApartmentBuildings ? (
                            <div className="space-y-1 text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>
                              <div className="flex justify-between">
                                <span>Generated apartment buildings</span>
                                <span className="font-semibold" style={{ color: '#ffffff' }}>{fmtCount(generatedAptBuildings)}</span>
                              </div>
                              {aptCapacity != null && aptCapacity > 0 && (
                                <div className="flex justify-between text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                                  <span>Conceptual unit capacity</span>
                                  <span>{fmtCount(aptCapacity)}</span>
                                </div>
                              )}
                            </div>
                          ) : showCommercialBuildings ? (
                            <div className="space-y-1 text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>
                              <div className="flex justify-between">
                                <span>Generated commercial buildings</span>
                                <span className="font-semibold" style={{ color: '#ffffff' }}>{fmtCount(generatedCommBuildings)}</span>
                              </div>
                            </div>
                          ) : null}

                          {!isLimited && (
                            <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                              {isFull ? 'Full concept generated.' : 'Comparison estimate — full geometry has not been generated yet.'}
                            </p>
                          )}

                          {isRecommended && (
                            <p className="text-[11px]" style={{ color: '#ffffff' }}>
                              {getWhyRecommended()}
                            </p>
                          )}

                          <div className="space-y-0.5">
                            {tradeoffs.plus.map((t, i) => (
                              <div key={i} className="text-[11px] flex items-center gap-1.5" style={{ color: 'var(--soft-seafoam)' }}>
                                <span style={{ color: 'var(--seafoam)' }}>+</span>
                                <span>{t}</span>
                              </div>
                            ))}
                            {tradeoffs.minus.map((t, i) => (
                              <div key={i} className="text-[11px] flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
                                <span style={{ color: '#f87171' }}>–</span>
                                <span>{t}</span>
                              </div>
                            ))}
                          </div>

                          {isLimited && (
                            <p className="text-[11px]" style={{ color: '#fbbf24' }}>
                              {alt.errorMessage || 'A higher-intensity concept could not be produced without violating mapped hard constraints.'}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              <ConceptComparisonSummary
                alternatives={conceptAlternatives}
                recommendedAlternativeId={recommendedAlternativeId}
                parcelFeasibilityAssessment={parcelFeasibilityAssessment}
              />
            </div>
          )}

          {/* A. Site Overview */}
          <CollapsibleSection id="site-overview" title="A. Site Overview" defaultOpen={true}>
            <div className="space-y-1">
              {fmtLabel('Parcel MCPI', mcpi || 'Not available')}
              {fmtLabel('Parent parcel area', fmtAc(parentParcelArea))}
              {fmtLabel('Candidate developable area', fmtAc(candidateArea))}
              {fmtLabel('Network-served area', fmtAc(networkServed))}
              {fmtLabel('Unserved developable area', fmtAc(unserved))}
            </div>
          </CollapsibleSection>

          {/* B. Terrain Suitability (Phase 7A) */}
          {terrainSuitability && terrainSuitability.status === 'completed' && (
            <CollapsibleSection id="terrain-analysis" title="B. Terrain Analysis" defaultOpen={false}>
              <div className="space-y-1 text-[13px]" style={{ color: 'var(--soft-seafoam)' }}>
                <div className="flex justify-between"><span>Preferred</span><span className="font-semibold" style={{ color: '#4ade80' }}>{terrainSuitability.preferredAreaAcres.toFixed(1)} ac</span></div>
                <div className="flex justify-between"><span>Moderate</span><span className="font-semibold" style={{ color: '#facc15' }}>{terrainSuitability.moderateAreaAcres.toFixed(1)} ac</span></div>
                <div className="flex justify-between"><span>Challenging</span><span className="font-semibold" style={{ color: '#fb923c' }}>{terrainSuitability.challengingAreaAcres.toFixed(1)} ac</span></div>
                <div className="flex justify-between"><span>Avoid</span><span className="font-semibold" style={{ color: '#f87171' }}>{terrainSuitability.avoidAreaAcres.toFixed(1)} ac</span></div>
                <div className="flex justify-between"><span>Dominant terrain</span><span className="font-semibold" style={{ color: '#ffffff' }}>{terrainSuitability.dominantClass}</span></div>
                {terrainSuitability.meanSampledSlopePct !== null && (
                  <div className="flex justify-between"><span>Mean slope</span><span className="font-semibold" style={{ color: '#ffffff' }}>{terrainSuitability.meanSampledSlopePct.toFixed(1)}%</span></div>
                )}
              </div>
            </CollapsibleSection>
          )}

          {/* C. Site & Concept Constraints */}
          <CollapsibleSection id="site-constraints" title="C. Site & Concept Constraints" defaultOpen={false}>
            <p className="text-[11px] leading-[1.4] mb-2" style={{ color: 'var(--text-secondary)' }}>
              Mixes mapped parcel constraints with conflicts encountered by the selected generated concept. Parcel screening is assessed separately.
            </p>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>Existing buildings</span>
                {statusBadge(buildingStatus)}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>Water / wetlands</span>
                {statusBadge(waterStatus)}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>Existing pavement</span>
                {statusBadge(pavementStatus)}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>Terrain</span>
                {statusBadge(terrain)}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>Concept access</span>
                {statusBadge(accessStatus)}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>Primary-road conflicts</span>
                {statusBadge(primaryRoadConflictStatus)}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>Other hard constraints</span>
                {statusBadge(otherHardStatus)}
              </div>
              {fmtLabel('Primary concept constraint', primaryConstraint)}
            </div>
          </CollapsibleSection>

          {/* D. Selected Concept */}
          <CollapsibleSection id="selected-concept" title="D. Selected Concept" defaultOpen={true}>
            <div className="space-y-1.5" style={{ color: 'var(--soft-seafoam)' }}>
              <div className="flex justify-between">
                <span className="text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>Selected strategy</span>
                <span className="text-[13px] font-semibold text-right" style={{ color: '#ffffff' }}>{authoritativeAlternative?.label ?? STRATEGY_LABELS[activeStrategy]}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>Recommended strategy</span>
                <span className="text-[13px] font-semibold text-right" style={{ color: '#ffffff' }}>{authoritativeAlternativeId === recommendedAlternativeId ? 'Yes — this is the recommended concept' : (conceptAlternatives?.find(a => a.id === recommendedAlternativeId)?.label ?? 'No')}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>Primary access</span>
                <span className="text-[13px] font-semibold text-right" style={{ color: '#ffffff' }}>{accessLabel}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>Primary road</span>
                <span className="text-[13px] font-semibold text-right" style={{ color: '#ffffff' }}>{fmtFt(primaryFeet)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>Secondary roads</span>
                <span className="text-[13px] font-semibold text-right" style={{ color: '#ffffff' }}>{fmtCount(secondaryCnt)} branches / {fmtFt(secondaryFt)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>Local streets</span>
                <span className="text-[13px] font-semibold text-right" style={{ color: '#ffffff' }}>{fmtCount(localCnt)} streets / {fmtFt(localFt)}</span>
              </div>
            </div>
            <p className="text-[13px] leading-[1.5] mt-3" style={{ color: 'var(--soft-seafoam)' }}>
              {developmentStrategy}
            </p>

            <div className="mt-3 pt-2 border-t" style={{ borderColor: 'var(--card-border)' }}>
              <h5 className="text-[13px] font-semibold mb-1" style={{ color: '#ffffff' }}>Why this concept?</h5>
              <ul className="list-disc pl-4 space-y-0.5 text-[13px]" style={{ color: 'var(--soft-seafoam)' }}>
                {whyThisConcept.slice(0, 4).map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          </CollapsibleSection>

          {/* E. Development Potential */}
          <CollapsibleSection id="development-potential" title="E. Development Potential" defaultOpen={false}>
            <div className="space-y-1.5">
              {fmtLabel('Selected land-use types', selectedUses)}
              {fmtLabel('Development zones', fmtCount(zoneCount))}
              {fmtLabel('Development pads', fmtCount(padCount))}
              {showTownhomeSection && fmtLabel('Conceptual townhome rows', fmtCount(townhomeRows))}
              {showTownhomeSection && fmtLabel('Conceptual townhome capacity', fmtCount(townhomeTarget))}
              {showSingleFamilySection && fmtLabel('Conceptual lots generated', fmtCount(singleFamilyLots))}
              {showSingleFamilySection && fmtLabel('Conceptual unit capacity', fmtCount(singleFamilyTarget))}
              {!showTownhomeSection && !showSingleFamilySection && fmtLabel('Conceptual unit capacity', fmtMetricValue(estimatedUnits, estimatedUnitsSource, 'count'))}
              {showTownhomeSection && (
                <div className="flex items-center justify-between">
                  <span className="text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>Generated townhome units</span>
                  <span className="text-[13px] font-semibold" style={{ color: '#ffffff' }}>{fmtCount(townhomeUnits)}</span>
                </div>
              )}
              {showTownhomeSection && townhomeShortfall > 0 && (
                <p className="text-[11px] leading-[1.4]" style={{ color: 'var(--text-secondary)' }}>
                  {townhomeUnits} of {townhomeTarget} target townhomes were spatially placed within the available development zones.
                </p>
              )}
              {showSingleFamilySection && (
                <div className="flex items-center justify-between">
                  <span className="text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>Generated single-family homes</span>
                  <span className="text-[13px] font-semibold" style={{ color: '#ffffff' }}>{fmtCount(singleFamilyHomes)}</span>
                </div>
              )}
              {showSingleFamilySection && singleFamilyShortfall > 0 && (
                <p className="text-[11px] leading-[1.4]" style={{ color: 'var(--text-secondary)' }}>
                  {singleFamilyHomes} of {singleFamilyTarget} target homes were spatially placed within valid conceptual lots.
                </p>
              )}
              {showApartmentSection && (
                <div className="flex items-center justify-between">
                  <span className="text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>Generated apartment buildings</span>
                  <span className="text-[13px] font-semibold" style={{ color: '#ffffff' }}>{fmtCount(apartmentResult?.buildingCount)}</span>
                </div>
              )}
              {showApartmentSection && (apartmentResult?.targetCapacity ?? 0) > 0 && (
                <p className="text-[11px] leading-[1.4]" style={{ color: 'var(--text-secondary)' }}>
                  Conceptual unit capacity {fmtCount(apartmentResult?.targetCapacity)}.
                </p>
              )}
              {showCommercialSection && (
                <div className="flex items-center justify-between">
                  <span className="text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>Generated commercial buildings</span>
                  <span className="text-[13px] font-semibold" style={{ color: '#ffffff' }}>{fmtCount(commercialResult?.buildingCount)}</span>
                </div>
              )}
              {fmtLabel('Approx. acreage used by layout', fmtAc(layoutArea))}
              {fmtLabel('Remaining opportunity acreage', fmtMetricValue(remainingOpportunity, remainingOpportunitySource, 'ac'))}

              {submittedParameters?.parameters?.developmentApproach === 'REDEVELOPMENT' && redevelopmentImpact && (
                <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--card-border)' }}>
                  <h5 className="text-[13px] font-bold mb-2" style={{ color: '#ffffff' }}>Redevelopment Impact</h5>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>Impact level</span>
                      <span
                        className="text-[13px] font-semibold"
                        style={{
                          color:
                            redevelopmentImpact.redevelopmentImpactLevel === 'LOW'
                              ? 'var(--soft-seafoam)'
                              : redevelopmentImpact.redevelopmentImpactLevel === 'MODERATE'
                                ? '#fbbf24'
                                : '#f87171'
                        }}
                      >
                        {redevelopmentImpact.redevelopmentImpactLevel}
                      </span>
                    </div>
                    {fmtLabel('Eligible building area affected', fmtAc(redevelopmentImpact.eligibleBuildingAreaImpactedSqFt / SQFT_PER_ACRE) + ` (${Math.round(redevelopmentImpact.eligibleBuildingAreaImpactedSqFt).toLocaleString()} sq ft)`)}
                    {fmtLabel('Eligible pavement affected', fmtAc(redevelopmentImpact.eligiblePavementAreaImpactedSqFt / SQFT_PER_ACRE) + ` (${Math.round(redevelopmentImpact.eligiblePavementAreaImpactedSqFt).toLocaleString()} sq ft)`)}
                    {fmtLabel('Building footprints affected', redevelopmentImpact.estimatedBuildingFootprintImpacted ? 'Yes' : 'No')}
                    {fmtLabel('Pavement footprints affected', redevelopmentImpact.estimatedPavementFootprintImpacted ? 'Yes' : 'No')}
                  </div>
                  <p className="text-[10px] leading-[1.4] mt-2" style={{ color: 'var(--text-secondary)' }}>
                    Estimated disturbance to mapped features classified as redevelopment-eligible under the selected site treatment.
                  </p>
                </div>
              )}
            </div>
            {(!selectedLayout || selectedLayout?.status !== 'generated') && (
              <p className="text-[11px] leading-[1.4] mt-3" style={{ color: 'var(--text-secondary)' }}>
                Values are planning-level estimates. Full layout generation is required for authoritative pad and unit counts.
              </p>
            )}
          </CollapsibleSection>

          {/* F. Concept Feasibility */}
          <CollapsibleSection id="concept-feasibility" title="F. Concept Feasibility" defaultOpen={false}>
            <p className="text-[11px] leading-[1.4] mb-2" style={{ color: 'var(--text-secondary)' }}>
              Evaluates the currently selected generated concept. Parcel screening is assessed separately before generation.
            </p>
            <div className="space-y-1.5">
              {fmtLabel('Concept feasibility', feasibilityStatus)}
              {fmtLabel('Confidence', confidence)}
              {fmtLabel('Primary concept constraint', primaryConstraint)}
              <div className="mt-2">
                <h5 className="text-[13px] font-semibold mb-1" style={{ color: '#ffffff' }}>Strengths</h5>
                <ul className="list-disc pl-4 space-y-0.5 text-[13px]" style={{ color: 'var(--soft-seafoam)' }}>
                  {strengths.slice(0, 3).map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </div>
              <div className="mt-2">
                <h5 className="text-[13px] font-semibold mb-1" style={{ color: '#ffffff' }}>Considerations</h5>
                <ul className="list-disc pl-4 space-y-0.5 text-[13px]" style={{ color: 'var(--soft-seafoam)' }}>
                  {considerations.slice(0, 3).map((c, i) => <li key={i}>{c}</li>)}
                </ul>
              </div>
            </div>
          </CollapsibleSection>

          {/* G. Export & Handoff */}
          <CollapsibleSection id="export-handoff" title="G. Export & Handoff" defaultOpen={true}>
            <div className="space-y-2">
              <button
                type="button"
                onClick={exportFeasibilitySummary}
                title="Downloads the selected concept's feasibility memo and metrics."
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-[14px] font-bold transition-all"
                style={{ background: 'var(--button-gradient)', color: 'var(--brand-black)', border: '1px solid var(--viridian)' }}
              >
                <FileJson className="w-4 h-4" />
                Export Feasibility Summary
              </button>
              <button
                type="button"
                onClick={exportGeoJSON}
                disabled={!isGeoJsonExportEnabled}
                title={isGeoJsonExportEnabled ? "Downloads mapped geometry for the currently selected fully generated concept." : "Generate the full concept before exporting geometry."}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-[14px] font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: 'transparent', color: 'var(--soft-seafoam)', border: '1px solid var(--viridian)' }}
              >
                <Globe className="w-4 h-4" />
                Export GeoJSON
              </button>
              {!isGeoJsonExportEnabled && (
                <p className="text-[11px] leading-[1.4]" style={{ color: 'var(--text-secondary)' }}>
                  Generate the full concept before exporting geometry.
                </p>
              )}
              <div className="grid grid-cols-2 gap-2 pt-1">
                {onBackToParameters && (
                  <button
                    type="button"
                    onClick={() => onBackToParameters && onBackToParameters()}
                    className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-[13px] font-medium transition-all"
                    style={{ background: 'transparent', color: 'var(--soft-seafoam)', border: '1px solid var(--viridian)' }}
                  >
                    <ArrowLeft className="w-4 h-4" />
                    Back to Parameters
                  </button>
                )}
                <button
                  type="button"
                  disabled={!onSaveDraft}
                  onClick={() => onSaveDraft?.()}
                  className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-[13px] font-medium transition-all ${
                    onSaveDraft ? '' : 'opacity-60 cursor-not-allowed'
                  }`}
                  style={{ background: 'transparent', color: 'var(--soft-seafoam)', border: '1px solid var(--viridian)' }}
                  title={onSaveDraft ? 'Save the current project parameters to drafts' : 'Save draft is not available'}
                >
                  <Save className="w-4 h-4" />
                  Save Draft
                </button>
              </div>
            </div>
            <p className="text-[11px] leading-[1.4] mt-3" style={{ color: 'var(--text-secondary)' }}>
              Exports the feasibility memo as JSON and the conceptual geometry as a GeoJSON feature collection. Save Draft stores the current parcel and parameter state; generated geometry is not persisted and can be recreated by re-running the workflow. All output is conceptual and must be reviewed by a licensed civil engineer before survey, entitlement, permitting, or construction use.
            </p>
          </CollapsibleSection>
        </>
      )}
    </div>
  )
}
