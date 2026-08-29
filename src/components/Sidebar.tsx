import { useState, useEffect, useRef } from 'react'
import { Search, MapPin, Settings, Download, Copy, ChevronDown, Layers, Bookmark } from 'lucide-react'
import L from 'leaflet'
import { ParcelData } from '../services/gisService'
import { ConceptualRoadSkeletonResult, SecondaryRoadNetworkResult, DevelopmentOpportunityBlockResult } from '../types/parameters'
import type { ConceptualDevelopmentProgramResult } from '../services/conceptualDevelopmentProgram'
import type { ConceptualDevelopmentLayoutResult } from '../services/conceptualDevelopmentLayout'
import type { ParcelFeasibilityAssessment } from '../services/parcelFeasibilityService'
import type { TerrainSuitabilityResult } from '../types/terrain'
import type { ConceptAlternativeResult, ConceptStrategy } from '../types/conceptAlternatives'
import type { RedevelopmentImpactMetrics } from '../lib/redevelopmentContext'
import GenerateExportPanel from './GenerateExportPanel'
import ParcelFeasibilityCard from './ParcelFeasibilityCard'

interface SelectedParcel {
  id: string
  feature: ParcelData
  details: any
  addresses: any[]
}

interface SidebarProps {
  selectedParcel: SelectedParcel | null
  onParcelSelect: (parcel: ParcelData) => void
  currentStep: string
  onStepChange: (step: string) => void
  canGenerate?: boolean
  onGenerateRoadSkeleton?: () => void
  conceptualRoadResult?: ConceptualRoadSkeletonResult | null
  secondaryRoadNetworkResult?: SecondaryRoadNetworkResult | null
  developmentOpportunityBlockResult?: DevelopmentOpportunityBlockResult | null
  isRoadGenerating?: boolean
  roadGenerationError?: string | null
  conceptualProgram?: ConceptualDevelopmentProgramResult | null
  conceptualLayout?: ConceptualDevelopmentLayoutResult | null
  redevelopmentImpact?: RedevelopmentImpactMetrics | null
  terrainSuitability?: TerrainSuitabilityResult | null
  parcelFeasibilityAssessment?: ParcelFeasibilityAssessment | null
  parentParcelAreaAcres?: number | null
  conceptAlternatives?: ConceptAlternativeResult[] | null
  recommendedAlternativeId?: ConceptStrategy | null
  authoritativeAlternativeId?: ConceptStrategy | null
  generatingAlternativeId?: ConceptStrategy | null
  isAlternativeGenerating?: boolean
  onSelectAlternative?: (id: ConceptStrategy) => void
}

export default function Sidebar({
  selectedParcel,
  currentStep,
  onStepChange,
  canGenerate = false,
  onGenerateRoadSkeleton,
  conceptualRoadResult,
  secondaryRoadNetworkResult,
  developmentOpportunityBlockResult,
  isRoadGenerating = false,
  roadGenerationError,
  conceptualProgram = null,
  conceptualLayout = null,
  redevelopmentImpact = null,
  terrainSuitability = null,
  parcelFeasibilityAssessment = null,
  parentParcelAreaAcres = null,
  conceptAlternatives = null,
  recommendedAlternativeId = null,
  authoritativeAlternativeId = null,
  generatingAlternativeId = null,
  isAlternativeGenerating = false,
  onSelectAlternative
}: SidebarProps) {
  const [showDetails, setShowDetails] = useState(false)
  const [showAllAddresses, setShowAllAddresses] = useState(false)
  const sidebarRef = useRef<HTMLDivElement>(null)

  // Disable Leaflet event propagation on sidebar
  useEffect(() => {
    if (sidebarRef.current) {
      L.DomEvent.disableClickPropagation(sidebarRef.current)
      L.DomEvent.disableScrollPropagation(sidebarRef.current)
    }
  }, [])

  const handleCopyMCPI = () => {
    if (selectedParcel?.feature?.properties?.PA_MCPI) {
      navigator.clipboard.writeText(selectedParcel.feature.properties.PA_MCPI)
    }
  }

  const steps = [
    { id: 'explore', title: 'Explore Map', icon: Search },
    { id: 'select', title: 'Selected Parcel', icon: MapPin },
    { id: 'parameters', title: 'Parameters', icon: Settings },
    { id: 'generate', title: 'Generate & Export', icon: Download }
  ]

  const firstAddress = selectedParcel?.addresses?.[0]?.properties?.FULL_ADDRESS
  const extraAddresses = (selectedParcel?.addresses?.length ?? 0) - 1

  return (
    <div ref={sidebarRef} className="flex flex-col w-[380px] min-w-[380px] h-full overflow-y-auto border-r" style={{ background: 'var(--sidebar-gradient)', borderRight: '1px solid rgba(64, 130, 109, 0.35)', zIndex: 800, scrollbarWidth: 'thin', scrollbarColor: '#40826D #0B211B' }} data-map-ui="true">
      <div className="p-4 h-full overflow-y-auto">
        <h2 className="text-[18px] font-bold mb-4 leading-[1.45]" style={{ color: 'var(--text-primary)' }}>Workflow</h2>

        {/* Step Indicators */}
        <div className="space-y-2 mb-6">
          {steps.map((step) => (
            <button
              key={step.id}
              onClick={() => {
                if (step.id === 'select' && !selectedParcel) return
                if (step.id === 'parameters' && !parcelFeasibilityAssessment) return
                if (step.id === 'generate' && !canGenerate) return
                onStepChange(step.id)
              }}
              disabled={(step.id === 'select' && !selectedParcel) || (step.id === 'parameters' && !parcelFeasibilityAssessment) || (step.id === 'generate' && !canGenerate)}
              className="w-full flex items-center gap-3 p-3 rounded-lg transition-all"
              style={
                currentStep === step.id
                  ? { background: 'linear-gradient(90deg, rgba(64,130,109,0.78), rgba(147,233,190,0.88))', border: '1px solid var(--seafoam)' }
                  : ((step.id === 'select' && !selectedParcel) || (step.id === 'parameters' && !parcelFeasibilityAssessment) || (step.id === 'generate' && !canGenerate))
                  ? { background: 'transparent', border: '1px solid rgba(64, 130, 109, 0.45)', opacity: 0.5, cursor: 'not-allowed' }
                  : { background: 'transparent', border: '1px solid rgba(64, 130, 109, 0.45)', color: 'var(--text-secondary)' }
              }
              onMouseEnter={(e) => {
                if (currentStep !== step.id && !(step.id === 'select' && !selectedParcel) && !(step.id === 'parameters' && !parcelFeasibilityAssessment) && !(step.id === 'generate' && !canGenerate)) {
                  e.currentTarget.style.background = 'rgba(64, 130, 109, 0.13)'
                  e.currentTarget.style.borderColor = 'var(--viridian)'
                }
              }}
              onMouseLeave={(e) => {
                if (currentStep !== step.id) {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.borderColor = 'rgba(64, 130, 109, 0.45)'
                }
              }}
            >
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center"
                style={{ background: currentStep === step.id ? 'transparent' : 'transparent' }}
              >
                <step.icon className="w-4 h-4" style={{ color: currentStep === step.id ? 'var(--brand-black)' : 'var(--viridian)' }} />
              </div>
              <div className="text-left">
                <p className="text-[15px] font-semibold leading-[1.45]" style={{ color: currentStep === step.id ? 'var(--brand-black)' : 'var(--text-secondary)' }}>
                  {step.title}
                </p>
              </div>
            </button>
          ))}
        </div>

        {/* Explore / parcel selection */}
        {!selectedParcel && currentStep === 'explore' && (
          <div className="rounded-lg p-4 border mb-4" style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}>
            <h3 className="text-[16px] font-bold mb-1" style={{ color: 'var(--text-primary)' }}>Select a parcel</h3>
            <p className="text-[13px] leading-[1.4] mb-3" style={{ color: 'var(--text-secondary)' }}>
              Zoom in and click any parcel to view its summary.
            </p>

            <div className="mb-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>Map tools</p>
              <div className="flex gap-2">
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px]" style={{ background: 'rgba(64, 130, 109, 0.12)', color: 'var(--soft-seafoam)', border: '1px solid rgba(64, 130, 109, 0.35)' }}>
                  <Layers className="w-3.5 h-3.5" />
                  Basemap
                </div>
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px]" style={{ background: 'rgba(64, 130, 109, 0.12)', color: 'var(--soft-seafoam)', border: '1px solid rgba(64, 130, 109, 0.35)' }}>
                  <Bookmark className="w-3.5 h-3.5" />
                  Saved Drafts
                </div>
              </div>
            </div>

            <p className="text-[11px] leading-[1.4]" style={{ color: 'var(--text-muted)' }}>
              Use the map search to locate an address or MCPI.
            </p>
          </div>
        )}

        {/* Selected Parcel Summary */}
        {selectedParcel && currentStep === 'select' && (
          <div className="rounded-lg p-4 border" style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[15px] font-bold leading-[1.45]" style={{ color: 'var(--text-primary)' }}>Selected Parcel Summary</h3>
              <span
                className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide"
                style={{ background: 'var(--seafoam)', color: 'var(--brand-black)' }}
              >
                Selected
              </span>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between p-2.5 rounded-md" style={{ background: 'rgba(5, 8, 7, 0.55)' }}>
                <span className="text-[13px]" style={{ color: 'var(--text-muted)' }}>MCPI</span>
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{selectedParcel?.feature?.properties?.PA_MCPI || 'N/A'}</span>
                  {selectedParcel?.feature?.properties?.PA_MCPI && (
                    <button
                      onClick={handleCopyMCPI}
                      title="Copy MCPI"
                      className="p-1 rounded transition-colors"
                      style={{ color: 'var(--seafoam)' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(64, 130, 109, 0.2)' }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="p-2.5 rounded-md" style={{ background: 'rgba(5, 8, 7, 0.55)' }}>
                  <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>GIS acres</p>
                  <p className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{selectedParcel?.feature?.properties?.PA_GIS_ACRE || '—'}</p>
                </div>
                <div className="p-2.5 rounded-md" style={{ background: 'rgba(5, 8, 7, 0.55)' }}>
                  <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Legal acres</p>
                  <p className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{selectedParcel?.feature?.properties?.PA_LEGAL_ACRE || '—'}</p>
                </div>
              </div>

              {firstAddress && (
                <div className="p-2.5 rounded-md" style={{ background: 'rgba(5, 8, 7, 0.55)' }}>
                  <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Location</p>
                  <p className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                    {firstAddress}
                    {extraAddresses > 0 && (
                      <span className="text-[11px] ml-1" style={{ color: 'var(--text-muted)' }}>+{extraAddresses} more</span>
                    )}
                  </p>
                </div>
              )}
            </div>

            {/* Additional details, collapsed by default */}
            <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--card-border)' }}>
              <button
                onClick={() => setShowDetails(s => !s)}
                className="w-full flex items-center justify-between text-[13px] font-semibold transition-colors"
                style={{ color: 'var(--seafoam)' }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)' }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--seafoam)' }}
              >
                <span>{showDetails ? 'Hide parcel details' : 'View parcel details'}</span>
                <ChevronDown className={`w-4 h-4 transition-transform ${showDetails ? 'rotate-180' : ''}`} />
              </button>

              {showDetails && (
                <div className="mt-3 space-y-2 text-[13px]">
                  {selectedParcel?.addresses && selectedParcel.addresses.length > 0 && (
                    <div style={{ borderBottom: '1px solid rgba(64, 130, 109, 0.3)', paddingBottom: '12px' }}>
                      <span className="text-[12px] leading-[1.45] block mb-1" style={{ color: 'var(--seafoam)' }}>Address{selectedParcel.addresses.length > 1 ? 'es' : ''}:</span>
                      <div className={showAllAddresses ? 'max-h-60 overflow-y-auto' : ''}>
                        {selectedParcel.addresses.slice(0, showAllAddresses ? undefined : 3).map((addr: any, idx: number) => (
                          <div key={idx} className="text-[14px] font-medium leading-[1.45] mb-1" style={{ color: 'var(--text-primary)' }}>
                            {addr.properties?.FULL_ADDRESS || 'N/A'}
                          </div>
                        ))}
                      </div>
                      {selectedParcel.addresses.length > 3 && (
                        <button
                          onClick={() => setShowAllAddresses(!showAllAddresses)}
                          className="text-[12px] font-medium leading-[1.45] mt-2 transition-colors"
                          style={{ color: 'var(--seafoam)' }}
                          onMouseEnter={(e) => e.currentTarget.style.color = '#ffffff'}
                          onMouseLeave={(e) => e.currentTarget.style.color = 'var(--seafoam)'}
                        >
                          {showAllAddresses ? 'Show less' : `Show all ${selectedParcel.addresses.length} addresses`}
                          <ChevronDown className={`w-3 h-3 inline ml-1 ${showAllAddresses ? 'rotate-180' : ''}`} />
                        </button>
                      )}
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <span className="text-[12px] block" style={{ color: 'var(--text-muted)' }}>Subdivision</span>
                      <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{selectedParcel?.feature?.properties?.PA_SUBD_NAME || 'N/A'}</span>
                    </div>
                    <div>
                      <span className="text-[12px] block" style={{ color: 'var(--text-muted)' }}>Plat Number</span>
                      <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{selectedParcel?.feature?.properties?.PA_PLAT_NUM || 'N/A'}</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <span className="text-[12px] block" style={{ color: 'var(--text-muted)' }}>Plat Lot</span>
                      <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{selectedParcel?.feature?.properties?.PA_PLAT_LOT || 'N/A'}</span>
                    </div>
                    <div>
                      <span className="text-[12px] block" style={{ color: 'var(--text-muted)' }}>Parcel Type</span>
                      <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{selectedParcel?.feature?.properties?.PA_TYPE || 'N/A'}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Parcel Feasibility */}
            {selectedParcel && (
              <div className="mt-4">
                <ParcelFeasibilityCard
                  assessment={parcelFeasibilityAssessment}
                  isAnalyzing={!parcelFeasibilityAssessment}
                  onContinue={() => onStepChange('parameters')}
                />
              </div>
            )}
          </div>
        )}

        {/* Placeholder content for other steps */}
        {currentStep === 'parameters' && (
          <div className="rounded-lg p-4 border" style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}>
            <h3 className="text-[16px] font-bold mb-3 leading-[1.45]" style={{ color: '#ffffff' }}>Parameters</h3>
            <p className="text-[15px] leading-[1.45]" style={{ color: 'var(--text-secondary)' }}>Parameter configuration coming soon.</p>
          </div>
        )}

        {currentStep === 'generate' && (
          <div className="rounded-lg p-4 border" style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}>
            <GenerateExportPanel
              canGenerate={canGenerate}
              onGenerateRoadSkeleton={onGenerateRoadSkeleton || (() => {})}
              conceptualRoadResult={conceptualRoadResult}
              secondaryRoadNetworkResult={secondaryRoadNetworkResult ?? null}
              developmentOpportunityBlockResult={developmentOpportunityBlockResult ?? null}
              isRoadGenerating={isRoadGenerating}
              roadGenerationError={roadGenerationError ?? null}
              conceptualProgram={conceptualProgram}
              conceptualLayout={conceptualLayout}
              redevelopmentImpact={redevelopmentImpact}
              terrainSuitability={terrainSuitability}
              parentParcelAreaAcres={parentParcelAreaAcres}
              conceptAlternatives={conceptAlternatives}
              recommendedAlternativeId={recommendedAlternativeId}
              authoritativeAlternativeId={authoritativeAlternativeId}
              generatingAlternativeId={generatingAlternativeId}
              isAlternativeGenerating={isAlternativeGenerating}
              onSelectAlternative={onSelectAlternative}
            />
          </div>
        )}
      </div>
    </div>
  )
}
