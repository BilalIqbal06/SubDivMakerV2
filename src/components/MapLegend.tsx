import { useCallback, useRef } from 'react'
import L from 'leaflet'

interface MapLegendProps {
  zoom: number;
  parcelCount: number;
  loading: boolean;
  hasAnalysisLayers?: boolean;
  showCandidateArea?: boolean;
  showBuildings?: boolean;
  showRoadCorridors?: boolean;
  showHydrology?: boolean;
  showPavement?: boolean;
  onToggleCandidateArea?: () => void;
  onToggleBuildings?: () => void;
  onToggleRoadCorridors?: () => void;
  onToggleHydrology?: () => void;
  onTogglePavement?: () => void;
  hasTerrainLayers?: boolean;
  showTerrain?: boolean;
  onToggleTerrain?: () => void;
  hasTerrainSuitabilityLayers?: boolean;
  showTerrainSuitability?: boolean;
  onToggleTerrainSuitability?: () => void;
  terrainSuitabilitySummary?: { preferred: number; moderate: number; challenging: number; avoid: number; insufficient: number; dominant: string } | null;
  isExploreMode?: boolean;
  selectedParcelMCPI?: string;
  isAnalysisRunning?: boolean;
  hasRoadLayers?: boolean;
  showProposedAccessPoint?: boolean;
  showProposedRoadCenterline?: boolean;
  showProposedRightOfWay?: boolean;
  showProposedResidualArea?: boolean;
  onToggleProposedAccessPoint?: () => void;
  onToggleProposedRoadCenterline?: () => void;
  onToggleProposedRightOfWay?: () => void;
  onToggleProposedResidualArea?: () => void;
  hasSecondaryRoadLayers?: boolean;
  showSecondaryCenterline?: boolean;
  showSecondaryRightOfWay?: boolean;
  onToggleSecondaryCenterline?: () => void;
  onToggleSecondaryRightOfWay?: () => void;
  hasDevelopmentOpportunityLayers?: boolean;
  showDevelopmentOpportunity?: boolean;
  developmentOpportunityCounts?: { HIGH: number; MODERATE: number; LOW: number; RESIDUAL: number };
  onToggleDevelopmentOpportunity?: () => void;
  hasDevelopmentZones?: boolean;
  showDevelopmentZones?: boolean;
  onToggleDevelopmentZones?: () => void;
  hasDevelopmentLayout?: boolean
  showConceptualLots?: boolean
  showBuildingEnvelopes?: boolean
  showDevelopmentPads?: boolean
  conceptualLotCount?: number
  buildingEnvelopeCount?: number
  developmentPadCount?: number
  onToggleConceptualLots?: () => void
  onToggleBuildingEnvelopes?: () => void
  onToggleDevelopmentPads?: () => void
  hasLocalStreetLayers?: boolean
  localStreetCount?: number
  localStreetStopReason?: string | null
  showLocalStreetCenterlines?: boolean
  showLocalStreetRows?: boolean
  onToggleLocalStreetCenterlines?: () => void
  onToggleLocalStreetRows?: () => void
  hasTownhomeLayers?: boolean
  townhomeRowCount?: number
  townhomeUnitCount?: number
  showTownhomeRows?: boolean
  showTownhomeUnits?: boolean
  onToggleTownhomeRows?: () => void
  onToggleTownhomeUnits?: () => void
}

export default function MapLegend({
  zoom,
  parcelCount,
  loading,
  hasAnalysisLayers,
  showCandidateArea = true,
  showBuildings = true,
  showRoadCorridors = true,
  showHydrology = true,
  showPavement = true,
  onToggleCandidateArea,
  onToggleBuildings,
  onToggleRoadCorridors,
  onToggleHydrology,
  onTogglePavement,
  hasTerrainLayers = false,
  showTerrain = false,
  onToggleTerrain,
  hasTerrainSuitabilityLayers = false,
  showTerrainSuitability = true,
  onToggleTerrainSuitability,
  terrainSuitabilitySummary = null,
  isExploreMode = true,
  selectedParcelMCPI = '',
  isAnalysisRunning = false,
  hasRoadLayers = false,
  showProposedAccessPoint = true,
  showProposedRoadCenterline = true,
  showProposedRightOfWay = true,
  showProposedResidualArea = true,
  onToggleProposedAccessPoint,
  onToggleProposedRoadCenterline,
  onToggleProposedRightOfWay,
  onToggleProposedResidualArea,
  hasSecondaryRoadLayers = false,
  showSecondaryCenterline = true,
  showSecondaryRightOfWay = true,
  onToggleSecondaryCenterline,
  onToggleSecondaryRightOfWay,
  hasDevelopmentOpportunityLayers = false,
  showDevelopmentOpportunity = true,
  developmentOpportunityCounts = { HIGH: 0, MODERATE: 0, LOW: 0, RESIDUAL: 0 },
  onToggleDevelopmentOpportunity,
  hasDevelopmentZones = false,
  showDevelopmentZones = true,
  onToggleDevelopmentZones,
  hasDevelopmentLayout = false,
  showConceptualLots = true,
  showBuildingEnvelopes = true,
  showDevelopmentPads = true,
  conceptualLotCount = 0,
  buildingEnvelopeCount = 0,
  developmentPadCount = 0,
  onToggleConceptualLots,
  onToggleBuildingEnvelopes,
  onToggleDevelopmentPads,
  hasLocalStreetLayers = false,
  localStreetCount = 0,
  localStreetStopReason = null,
  showLocalStreetCenterlines = true,
  showLocalStreetRows = true,
  onToggleLocalStreetCenterlines,
  onToggleLocalStreetRows,
  hasTownhomeLayers = false,
  townhomeRowCount = 0,
  townhomeUnitCount = 0,
  showTownhomeRows = true,
  showTownhomeUnits = true,
  onToggleTownhomeRows,
  onToggleTownhomeUnits
}: MapLegendProps) {
  const attachedLegendNodes = useRef<WeakSet<HTMLDivElement>>(new WeakSet())

  const setLegendRef = useCallback((el: HTMLDivElement | null) => {
    if (el && !attachedLegendNodes.current.has(el)) {
      L.DomEvent.disableClickPropagation(el)
      L.DomEvent.disableScrollPropagation(el)
      attachedLegendNodes.current.add(el)
    }
  }, [])


  const getStatusMessage = () => {
    if (loading) return 'Requesting parcel boundaries…'
    if (zoom < 15) return 'Zoom in to view parcel boundaries'
    if (parcelCount === 0) return 'Parcel boundaries unavailable — Retry'
    return `${parcelCount.toLocaleString()} parcel outlines visible`
  }

  // State 0: Hide legend when no parcel is selected
  if (!selectedParcelMCPI) {
    return null
  }

  return (
    <div 
      ref={setLegendRef}
      data-map-ui="true"
      className="map-legend absolute bottom-4 left-4 z-[1000] px-4 py-3 rounded-lg border text-[15px] leading-[1.45] overflow-y-auto overflow-x-hidden overscroll-contain touch-pan-y pointer-events-auto"
      style={{
        background: 'var(--sidebar-gradient)',
        borderColor: 'var(--card-border)',
        color: '#ffffff',
        minWidth: '200px',
        maxHeight: 'calc(100% - 2rem)'
      }}
    >
      <h4 className="font-bold mb-2" style={{ color: '#ffffff' }}>Legend</h4>

      {/* State 1 & 2: Selected Parcel entry (always shown when parcel is selected) */}
      <div className="mb-3 pb-2 border-b" style={{ borderColor: 'var(--card-border)' }}>
        <div className="flex items-center gap-2 mb-1">
          <div className="w-4 h-4 border-2" style={{ borderColor: '#93E9BE', backgroundColor: 'rgba(147, 233, 190, 0.12)' }}></div>
          <span style={{ color: 'var(--soft-seafoam)' }}>Selected Parcel</span>
        </div>
        <div className="text-xs text-slate-400 ml-6">MCPI: {selectedParcelMCPI}</div>
      </div>

      {/* State 2: Analysis running indicator */}
      {isAnalysisRunning && (
        <div className="mb-3 pb-2 border-b" style={{ borderColor: 'var(--card-border)' }}>
          <div className="text-xs text-yellow-400">Analysis: Running…</div>
        </div>
      )}

      {/* Status indicator - only show in Explore mode */}
      {isExploreMode && (
        <div className="mb-3 pb-2 border-b" style={{ borderColor: 'var(--card-border)' }}>
          <span style={{ color: 'var(--soft-seafoam)', fontSize: '13px' }}>{getStatusMessage()}</span>
        </div>
      )}

      {/* Parcel states - only show in Explore mode when parcels are loaded */}
      {isExploreMode && zoom >= 15 && parcelCount > 0 && (
        <div className="space-y-2 mb-3">
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 border-2 bg-transparent" style={{ borderColor: '#40826D' }}></div>
            <span style={{ color: 'var(--soft-seafoam)' }}>Parcel boundary</span>
          </div>
        </div>
      )}

      {/* State 3: Analysis layers - only show when analysis is complete and not running */}
      {hasAnalysisLayers && !isAnalysisRunning && (
        <div className="space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider pt-1" style={{ color: 'var(--text-secondary)' }}>Existing Conditions</div>
          {/* Locked building footprint */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 border-2" style={{ borderColor: '#64748b', backgroundColor: 'rgba(71, 85, 105, 0.3)' }}></div>
              <span style={{ color: 'var(--soft-seafoam)' }}>Locked building footprint</span>
            </div>
            {onToggleBuildings && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (onToggleBuildings) onToggleBuildings()
                }}
                className="text-xs px-2 py-1 rounded"
                style={{ 
                  background: showBuildings ? 'var(--seafoam)' : 'transparent',
                  color: showBuildings ? 'var(--brand-black)' : 'var(--text-secondary)',
                  border: '1px solid var(--viridian)'
                }}
              >
                {showBuildings ? 'On' : 'Off'}
              </button>
            )}
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 border-2" style={{ borderColor: '#f59e0b', backgroundColor: 'rgba(245, 158, 11, 0.15)' }}></div>
              <span style={{ color: 'var(--soft-seafoam)' }}>Estimated road corridor</span>
            </div>
            {onToggleRoadCorridors && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (onToggleRoadCorridors) onToggleRoadCorridors()
                }}
                className="text-xs px-2 py-1 rounded"
                style={{ 
                  background: showRoadCorridors ? 'var(--seafoam)' : 'transparent',
                  color: showRoadCorridors ? 'var(--brand-black)' : 'var(--text-secondary)',
                  border: '1px solid var(--viridian)'
                }}
              >
                {showRoadCorridors ? 'On' : 'Off'}
              </button>
            )}
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 border-2" style={{ borderColor: '#93E9BE', backgroundColor: 'rgba(147, 233, 190, 0.25)' }}></div>
              <span style={{ color: 'var(--soft-seafoam)' }}>Candidate Open Area</span>
            </div>
            {onToggleCandidateArea && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (onToggleCandidateArea) onToggleCandidateArea()
                }}
                className="text-xs px-2 py-1 rounded"
                style={{ 
                  background: showCandidateArea ? 'var(--seafoam)' : 'transparent',
                  color: showCandidateArea ? 'var(--brand-black)' : 'var(--text-secondary)',
                  border: '1px solid var(--viridian)'
                }}
              >
                {showCandidateArea ? 'On' : 'Off'}
              </button>
            )}
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 border-2" style={{ borderColor: '#0ea5e9', backgroundColor: 'rgba(14, 165, 233, 0.35)' }}></div>
              <span style={{ color: 'var(--soft-seafoam)' }}>Water / wetlands</span>
            </div>
            {onToggleHydrology && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (onToggleHydrology) onToggleHydrology()
                }}
                className="text-xs px-2 py-1 rounded"
                style={{ 
                  background: showHydrology ? 'var(--seafoam)' : 'transparent',
                  color: showHydrology ? 'var(--brand-black)' : 'var(--text-secondary)',
                  border: '1px solid var(--viridian)'
                }}
              >
                {showHydrology ? 'On' : 'Off'}
              </button>
            )}
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 border-2" style={{ borderColor: '#9ca3af', backgroundColor: 'rgba(156, 163, 175, 0.45)' }}></div>
              <span style={{ color: 'var(--soft-seafoam)' }}>Existing pavement</span>
            </div>
            {onTogglePavement && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (onTogglePavement) onTogglePavement()
                }}
                className="text-xs px-2 py-1 rounded"
                style={{ 
                  background: showPavement ? 'var(--seafoam)' : 'transparent',
                  color: showPavement ? 'var(--brand-black)' : 'var(--text-secondary)',
                  border: '1px solid var(--viridian)'
                }}
              >
                {showPavement ? 'On' : 'Off'}
              </button>
            )}
          </div>
          {hasTerrainLayers && (
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 border-2" style={{ borderColor: '#d4a373', backgroundColor: 'rgba(212, 163, 115, 0.1)' }}></div>
                <span style={{ color: 'var(--soft-seafoam)' }}>Terrain contours</span>
              </div>
              {onToggleTerrain && (
                <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleTerrain() }}
                                className="text-xs px-2 py-1 rounded"
                    style={{ background: showTerrain ? 'var(--seafoam)' : 'transparent', color: showTerrain ? 'var(--brand-black)' : 'var(--text-secondary)', border: '1px solid var(--viridian)' }}
                  >
                    {showTerrain ? 'On' : 'Off'}
                  </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Terrain suitability legend */}
      {hasTerrainSuitabilityLayers && terrainSuitabilitySummary && (
        <div className="space-y-2 mt-3 pt-3 border-t" style={{ borderColor: 'var(--card-border)' }}>
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Terrain Suitability</div>
            {onToggleTerrainSuitability && (
              <button
                type="button"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleTerrainSuitability() }}
                className="text-xs px-2 py-1 rounded"
                style={{ background: showTerrainSuitability ? 'var(--seafoam)' : 'transparent', color: showTerrainSuitability ? 'var(--brand-black)' : 'var(--text-secondary)', border: '1px solid var(--viridian)' }}
              >
                {showTerrainSuitability ? 'On' : 'Off'}
              </button>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 text-[13px]">
            <div className="flex items-center gap-2"><div className="w-4 h-4" style={{ backgroundColor: '#16a34a' }}></div><span style={{ color: 'var(--soft-seafoam)' }}>Preferred</span></div>
            <span style={{ color: 'var(--text-secondary)' }}>{terrainSuitabilitySummary.preferred.toFixed(1)} ac</span>
          </div>
          <div className="flex items-center justify-between gap-2 text-[13px]">
            <div className="flex items-center gap-2"><div className="w-4 h-4" style={{ backgroundColor: '#eab308' }}></div><span style={{ color: 'var(--soft-seafoam)' }}>Moderate</span></div>
            <span style={{ color: 'var(--text-secondary)' }}>{terrainSuitabilitySummary.moderate.toFixed(1)} ac</span>
          </div>
          <div className="flex items-center justify-between gap-2 text-[13px]">
            <div className="flex items-center gap-2"><div className="w-4 h-4" style={{ backgroundColor: '#f97316' }}></div><span style={{ color: 'var(--soft-seafoam)' }}>Challenging</span></div>
            <span style={{ color: 'var(--text-secondary)' }}>{terrainSuitabilitySummary.challenging.toFixed(1)} ac</span>
          </div>
          <div className="flex items-center justify-between gap-2 text-[13px]">
            <div className="flex items-center gap-2"><div className="w-4 h-4" style={{ backgroundColor: '#dc2626' }}></div><span style={{ color: 'var(--soft-seafoam)' }}>Avoid</span></div>
            <span style={{ color: 'var(--text-secondary)' }}>{terrainSuitabilitySummary.avoid.toFixed(1)} ac</span>
          </div>
          <div className="flex items-center justify-between gap-2 text-[13px]">
            <div className="flex items-center gap-2"><div className="w-4 h-4" style={{ backgroundColor: '#64748b' }}></div><span style={{ color: 'var(--soft-seafoam)' }}>Insufficient data</span></div>
            <span style={{ color: 'var(--text-secondary)' }}>{terrainSuitabilitySummary.insufficient.toFixed(1)} ac</span>
          </div>
          <div className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>Dominant: {terrainSuitabilitySummary.dominant}</div>
        </div>
      )}

      {/* Proposed road skeleton layers */}
      {hasRoadLayers && (
        <div className="space-y-2 mt-3 pt-3 border-t" style={{ borderColor: 'var(--card-border)' }}>
          <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Road Concept</div>
          <div className="text-[13px] font-medium mb-1" style={{ color: '#ffffff' }}>Primary Road</div>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full" style={{ backgroundColor: '#22d3ee', border: '2px solid #ffffff' }}></div>
              <span style={{ color: 'var(--soft-seafoam)' }}>Access point</span>
            </div>
            {onToggleProposedAccessPoint && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (onToggleProposedAccessPoint) onToggleProposedAccessPoint()
                }}
                className="text-xs px-2 py-1 rounded"
                style={{ background: showProposedAccessPoint ? 'var(--seafoam)' : 'transparent', color: showProposedAccessPoint ? 'var(--brand-black)' : 'var(--text-secondary)', border: '1px solid var(--viridian)' }}
              >
                {showProposedAccessPoint ? 'On' : 'Off'}
              </button>
            )}
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="w-4 h-0.5" style={{ backgroundColor: '#d946ef' }}></div>
              <span style={{ color: 'var(--soft-seafoam)' }}>Road centerline</span>
            </div>
            {onToggleProposedRoadCenterline && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (onToggleProposedRoadCenterline) onToggleProposedRoadCenterline()
                }}
                className="text-xs px-2 py-1 rounded"
                style={{ background: showProposedRoadCenterline ? 'var(--seafoam)' : 'transparent', color: showProposedRoadCenterline ? 'var(--brand-black)' : 'var(--text-secondary)', border: '1px solid var(--viridian)' }}
              >
                {showProposedRoadCenterline ? 'On' : 'Off'}
              </button>
            )}
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 border-2" style={{ borderColor: '#d8b4fe', backgroundColor: 'rgba(168, 85, 247, 0.3)' }}></div>
              <span style={{ color: 'var(--soft-seafoam)' }}>Proposed right-of-way</span>
            </div>
            {onToggleProposedRightOfWay && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (onToggleProposedRightOfWay) onToggleProposedRightOfWay()
                }}
                className="text-xs px-2 py-1 rounded"
                style={{ background: showProposedRightOfWay ? 'var(--seafoam)' : 'transparent', color: showProposedRightOfWay ? 'var(--brand-black)' : 'var(--text-secondary)', border: '1px solid var(--viridian)' }}
              >
                {showProposedRightOfWay ? 'On' : 'Off'}
              </button>
            )}
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 border-2" style={{ borderColor: '#0d9488', backgroundColor: 'rgba(20, 184, 166, 0.22)' }}></div>
              <span style={{ color: 'var(--soft-seafoam)' }}>Residual development area</span>
            </div>
            {onToggleProposedResidualArea && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (onToggleProposedResidualArea) onToggleProposedResidualArea()
                }}
                className="text-xs px-2 py-1 rounded"
                style={{ background: showProposedResidualArea ? 'var(--seafoam)' : 'transparent', color: showProposedResidualArea ? 'var(--brand-black)' : 'var(--text-secondary)', border: '1px solid var(--viridian)' }}
              >
                {showProposedResidualArea ? 'On' : 'Off'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Secondary road network layers */}
      {hasSecondaryRoadLayers && (
        <div className="space-y-2 mt-3 pt-3 border-t" style={{ borderColor: 'var(--card-border)' }}>
          <div className="text-[13px] font-medium mb-1" style={{ color: '#ffffff' }}>Secondary Roads</div>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="w-4 h-0.5" style={{ backgroundColor: '#34d399' }}></div>
              <span style={{ color: 'var(--soft-seafoam)' }}>Secondary centerlines</span>
            </div>
            {onToggleSecondaryCenterline && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (onToggleSecondaryCenterline) onToggleSecondaryCenterline()
                }}
                className="text-xs px-2 py-1 rounded"
                style={{ background: showSecondaryCenterline ? 'var(--seafoam)' : 'transparent', color: showSecondaryCenterline ? 'var(--brand-black)' : 'var(--text-secondary)', border: '1px solid var(--viridian)' }}
              >
                {showSecondaryCenterline ? 'On' : 'Off'}
              </button>
            )}
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 border-2" style={{ borderColor: '#6ee7b7', backgroundColor: 'rgba(52, 211, 153, 0.22)' }}></div>
              <span style={{ color: 'var(--soft-seafoam)' }}>Secondary right-of-way</span>
            </div>
            {onToggleSecondaryRightOfWay && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (onToggleSecondaryRightOfWay) onToggleSecondaryRightOfWay()
                }}
                className="text-xs px-2 py-1 rounded"
                style={{ background: showSecondaryRightOfWay ? 'var(--seafoam)' : 'transparent', color: showSecondaryRightOfWay ? 'var(--brand-black)' : 'var(--text-secondary)', border: '1px solid var(--viridian)' }}
              >
                {showSecondaryRightOfWay ? 'On' : 'Off'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Conceptual Local Street Network */}
      {hasLocalStreetLayers && (
        <div className="space-y-2 mt-3 pt-3 border-t" style={{ borderColor: 'var(--card-border)' }}>
          <div className="text-[13px] font-medium mb-1" style={{ color: '#ffffff' }}>Local Street</div>

          {localStreetCount === 0 ? (
            <div className="text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>
              {localStreetStopReason
                ? `Status: ${localStreetStopReason.replace(/_/g, ' ').toLowerCase()}`
                : 'Status: 0 local streets'}
            </div>
          ) : (
            <>
              <div className="text-[12px] mb-1" style={{ color: 'var(--text-secondary)' }}>{localStreetCount} local street{localStreetCount !== 1 ? 's' : ''}</div>

              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 border-2" style={{ borderColor: '#8ED8C0', backgroundColor: 'rgba(142, 216, 192, 0.25)' }}></div>
                  <span style={{ color: 'var(--soft-seafoam)' }}>Local street centerlines</span>
                </div>
                {onToggleLocalStreetCenterlines && (
                  <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleLocalStreetCenterlines() }}
                                className="text-xs px-2 py-1 rounded"
                    style={{ background: showLocalStreetCenterlines ? 'var(--seafoam)' : 'transparent', color: showLocalStreetCenterlines ? 'var(--brand-black)' : 'var(--text-secondary)', border: '1px solid var(--viridian)' }}
                  >
                    {showLocalStreetCenterlines ? 'On' : 'Off'}
                  </button>
                )}
              </div>

              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4" style={{ borderColor: '#8ED8C0', backgroundColor: 'rgba(100, 116, 139, 0.35)' }}></div>
                  <span style={{ color: 'var(--soft-seafoam)' }}>Local street right-of-way</span>
                </div>
                {onToggleLocalStreetRows && (
                  <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleLocalStreetRows() }}
                                className="text-xs px-2 py-1 rounded"
                    style={{ background: showLocalStreetRows ? 'var(--seafoam)' : 'transparent', color: showLocalStreetRows ? 'var(--brand-black)' : 'var(--text-secondary)', border: '1px solid var(--viridian)' }}
                  >
                    {showLocalStreetRows ? 'On' : 'Off'}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {(hasDevelopmentOpportunityLayers || hasDevelopmentZones || hasDevelopmentLayout || hasTownhomeLayers) && (
        <div className="text-[11px] font-semibold uppercase tracking-wider pt-2" style={{ color: 'var(--text-secondary)' }}>Development Concept</div>
      )}

      {/* Development opportunity blocks */}
      {hasDevelopmentOpportunityLayers && (
        <div className="space-y-2 mt-3 pt-3 border-t" style={{ borderColor: 'var(--card-border)' }}>
          <div className="flex items-center justify-between gap-2">
            <div className="text-[13px] font-medium" style={{ color: '#ffffff' }}>Development Opportunity</div>
            {onToggleDevelopmentOpportunity && (
              <button
                type="button"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleDevelopmentOpportunity() }}
                className="text-xs px-2 py-1 rounded"
                style={{ background: showDevelopmentOpportunity ? 'var(--seafoam)' : 'transparent', color: showDevelopmentOpportunity ? 'var(--brand-black)' : 'var(--text-secondary)', border: '1px solid var(--viridian)' }}
              >
                {showDevelopmentOpportunity ? 'On' : 'Off'}
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs" style={{ color: 'var(--soft-seafoam)' }}>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: '#10b981', opacity: 0.75 }}></div>
              <span>High ({developmentOpportunityCounts.HIGH})</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: '#6ee7b7', opacity: 0.75 }}></div>
              <span>Moderate ({developmentOpportunityCounts.MODERATE})</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: '#a7f3d0', opacity: 0.75 }}></div>
              <span>Low ({developmentOpportunityCounts.LOW})</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: '#94a3b8', opacity: 0.75 }}></div>
              <span>Residual ({developmentOpportunityCounts.RESIDUAL})</span>
            </div>
          </div>
        </div>
      )}

      {hasDevelopmentZones && (
        <div className="mt-2 pt-2 border-t" style={{ borderColor: 'var(--card-border)' }}>
          <p className="text-[13px] font-medium mb-2" style={{ color: '#ffffff' }}>Conceptual Development Zones</p>
          <div className="space-y-1 text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 border-2" style={{ borderColor: '#10b981', backgroundColor: 'rgba(16, 185, 129, 0.35)' }}></div>
                <span style={{ color: 'var(--soft-seafoam)' }}>Development zones</span>
              </div>
              {onToggleDevelopmentZones && (
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleDevelopmentZones() }}
                        className="text-xs px-2 py-1 rounded"
                  style={{ background: showDevelopmentZones ? 'var(--seafoam)' : 'transparent', color: showDevelopmentZones ? 'var(--brand-black)' : 'var(--text-secondary)', border: '1px solid var(--viridian)' }}
                >
                  {showDevelopmentZones ? 'On' : 'Off'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {hasDevelopmentLayout && (
        <div className="mt-2 pt-2 border-t" style={{ borderColor: 'var(--card-border)' }}>
          <p className="text-[13px] font-medium mb-2" style={{ color: '#ffffff' }}>Conceptual Development Layout</p>
          <div className="space-y-2 text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>
            {conceptualLotCount > 0 && onToggleConceptualLots && (
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 border-2" style={{ borderColor: '#3b82f6', backgroundColor: 'rgba(96, 165, 250, 0.35)' }}></div>
                  <span>Conceptual lots ({conceptualLotCount})</span>
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleConceptualLots() }}
                        className="text-xs px-2 py-1 rounded"
                  style={{ background: showConceptualLots ? 'var(--seafoam)' : 'transparent', color: showConceptualLots ? 'var(--brand-black)' : 'var(--text-secondary)', border: '1px solid var(--viridian)' }}
                >
                  {showConceptualLots ? 'On' : 'Off'}
                </button>
              </div>
            )}
            {buildingEnvelopeCount > 0 && onToggleBuildingEnvelopes && (
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 border-2" style={{ borderColor: '#fbbf24', backgroundColor: 'rgba(245, 158, 11, 0.35)' }}></div>
                  <span>Building envelopes ({buildingEnvelopeCount})</span>
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleBuildingEnvelopes() }}
                        className="text-xs px-2 py-1 rounded"
                  style={{ background: showBuildingEnvelopes ? 'var(--seafoam)' : 'transparent', color: showBuildingEnvelopes ? 'var(--brand-black)' : 'var(--text-secondary)', border: '1px solid var(--viridian)' }}
                >
                  {showBuildingEnvelopes ? 'On' : 'Off'}
                </button>
              </div>
            )}
            {developmentPadCount > 0 && onToggleDevelopmentPads && (
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 border-2" style={{ borderColor: '#d8b4fe', backgroundColor: 'rgba(168, 85, 247, 0.35)' }}></div>
                  <span>Development pads ({developmentPadCount})</span>
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleDevelopmentPads() }}
                        className="text-xs px-2 py-1 rounded"
                  style={{ background: showDevelopmentPads ? 'var(--seafoam)' : 'transparent', color: showDevelopmentPads ? 'var(--brand-black)' : 'var(--text-secondary)', border: '1px solid var(--viridian)' }}
                >
                  {showDevelopmentPads ? 'On' : 'Off'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {hasTownhomeLayers && (
        <div className="mt-2 pt-2 border-t" style={{ borderColor: 'var(--card-border)' }}>
          <p className="text-[13px] font-medium mb-2" style={{ color: '#ffffff' }}>Conceptual Townhomes</p>
          <div className="space-y-2 text-[12px]" style={{ color: 'var(--soft-seafoam)' }}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 border-2" style={{ borderColor: '#7C3AED', backgroundColor: 'rgba(167, 139, 250, 0.35)' }}></div>
                <span>Townhome rows ({townhomeRowCount})</span>
              </div>
              {onToggleTownhomeRows && (
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleTownhomeRows() }}
                        className="text-xs px-2 py-1 rounded"
                  style={{ background: showTownhomeRows ? 'var(--seafoam)' : 'transparent', color: showTownhomeRows ? 'var(--brand-black)' : 'var(--text-secondary)', border: '1px solid var(--viridian)' }}
                >
                  {showTownhomeRows ? 'On' : 'Off'}
                </button>
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 border-2" style={{ borderColor: '#8B5CF6', backgroundColor: 'rgba(196, 181, 253, 0.25)' }}></div>
                <span>Unit envelopes ({townhomeUnitCount})</span>
              </div>
              {onToggleTownhomeUnits && (
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleTownhomeUnits() }}
                        className="text-xs px-2 py-1 rounded"
                  style={{ background: showTownhomeUnits ? 'var(--seafoam)' : 'transparent', color: showTownhomeUnits ? 'var(--brand-black)' : 'var(--text-secondary)', border: '1px solid var(--viridian)' }}
                >
                  {showTownhomeUnits ? 'On' : 'Off'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
