import { useEffect, useState, useRef, useMemo } from 'react'
import { MapContainer, GeoJSON, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { fetchCountyBoundary, fetchParcesInBounds, fetchParcelByGeometry, ParcelData } from '../services/gisService'
import { ConceptualRoadSkeletonResult, SecondaryRoadNetworkResult, DevelopmentOpportunityBlockResult, DevelopmentOpportunityBlock, CandidateOpenAreaResult } from '../types/parameters'
import { TerrainData, TerrainSuitabilityResult } from '../types/terrain'
import type { ConceptualDevelopmentProgramResult } from '../services/conceptualDevelopmentProgram'
import type { ConceptualDevelopmentLayoutResult } from '../services/conceptualDevelopmentLayout'
import type { LocalStreetNetworkResult } from '../types/localStreets'
import MapControls from './MapControls'
import MapLegend from './MapLegend'
import { renderTerrainSuitabilityCanvas } from '../lib/terrainSuitabilityCanvas'
import { mapRenderPerformance, VERBOSE_GIS_DIAGNOSTICS } from '../lib/perf'

export type BasemapType = 'osm' | 'voyager' | 'aerial'

// Stable basemap configurations
const BASEMAPS: Record<BasemapType, { url: string; options: L.TileLayerOptions }> = {
  voyager: {
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    options: {
      subdomains: 'abcd',
      maxZoom: 20,
      maxNativeZoom: 20,
      detectRetina: true,
      attribution: ' OpenStreetMap contributors CARTO'
    }
  },
  osm: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: {
      maxZoom: 19,
      maxNativeZoom: 19,
      detectRetina: false,
      attribution: ' OpenStreetMap contributors'
    }
  },
  aerial: {
    url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    options: {
      attribution: 'USGS The National Map: Orthoimagery; USDA NAIP',
      maxNativeZoom: 16,
      maxZoom: 21,
      minZoom: 2,
      tileSize: 256,
      zoomOffset: 0,
      detectRetina: false,
      updateWhenIdle: true,
      updateWhenZooming: false,
      keepBuffer: 4,
      crossOrigin: true,
      noWrap: true
    }
  }
}

function BasemapLayer({ basemap }: { basemap: BasemapType }) {
  const map = useMap()
  const tileLayerRef = useRef<L.TileLayer | null>(null)

  useEffect(() => {
    // Remove previous tile layer
    if (tileLayerRef.current) {
      map.removeLayer(tileLayerRef.current)
    }

    // Create and add new tile layer
    const config = BASEMAPS[basemap]
    const nextLayer = L.tileLayer(config.url, config.options)

    nextLayer.addTo(map)
    nextLayer.bringToBack()

    // Add tile error handler
    nextLayer.on('tileerror', (event: any) => {
      console.warn('Satellite tile failed:', {
        url: event.tile?.src,
        zoom: map.getZoom()
      })
    })

    tileLayerRef.current = nextLayer

    // Invalidate size after layer change
    requestAnimationFrame(() => {
      map.invalidateSize()
    })

    // Cleanup
    return () => {
      if (nextLayer && map.hasLayer(nextLayer)) {
        map.removeLayer(nextLayer)
      }
    }
  }, [map, basemap])

  return null
}

interface MapComponentProps {
  onParcelSelect?: (parcel: ParcelData, source?: 'parcel-click' | 'map-point-query' | 'search-result') => void
  selectedParcel?: ParcelData | null
  onZoomChange?: (zoom: number) => void
  onMapReady?: (map: L.Map) => void
  existingConditions?: {
    buildings: any[]
    intersectingStreets: any[]
    nearbyStreets: any[]
    pavement?: any[]
  } | null
  candidateOpenAreaGeometry?: GeoJSON.Feature<GeoJSON.Geometry> | null
  buildingUnionGeometry?: GeoJSON.Feature<GeoJSON.Geometry> | null
  roadCorridorGeometry?: GeoJSON.Feature<GeoJSON.Geometry> | null
  hydrologyGeometry?: GeoJSON.Feature<GeoJSON.Geometry> | null
  pavementGeometry?: GeoJSON.Feature<GeoJSON.Geometry> | null
  showGeneralParcelOutlines?: boolean
  selectedParcelMCPI?: string
  isAnalysisRunning?: boolean
  analysisBundleIsCurrent?: boolean
  candidateOpenAreaResult?: CandidateOpenAreaResult | null
  conceptualRoadResult?: ConceptualRoadSkeletonResult | null
  secondaryRoadNetworkResult?: SecondaryRoadNetworkResult | null
  localStreetNetworkResult?: LocalStreetNetworkResult | null
  developmentOpportunityBlockResult?: DevelopmentOpportunityBlockResult | null
  terrainData?: TerrainData | null
  terrainSuitability?: TerrainSuitabilityResult | null
  conceptualProgram?: ConceptualDevelopmentProgramResult | null
  conceptualLayout?: ConceptualDevelopmentLayoutResult | null
  isRoadGenerating?: boolean
}

function ParcelClickHandler({ onParcelSelected }: { onParcelSelected: (parcel: ParcelData) => void }) {
  const map = useMap()
  const [findingParcel, setFindingParcel] = useState(false)
  const navigationSuppressionRef = useRef(false)

  const handleMapClick = async (event: L.LeafletMouseEvent) => {
    // Guard: Reject clicks from UI controls
    const target = event.originalEvent?.target as HTMLElement | null
    if (
      target?.closest(
        '.leaflet-control, .map-controls, .basemap-control, .search-bar, .search-results, .map-legend, button, input, form, aside, [data-map-ui="true"]'
      )
    ) {
      return
    }

    // Guard: Reject clicks during navigation suppression window
    if (navigationSuppressionRef.current) {
      return
    }

    if (map.getZoom() < 14) {
      return
    }

    const { lat, lng } = event.latlng
    setFindingParcel(true)

    try {
      const parcel = await fetchParcelByGeometry(lng, lat)
      if (parcel?.geometry) {
        onParcelSelected(parcel)
      }
    } catch (error) {
      console.error('Failed to query parcel at point:', error)
    } finally {
      setFindingParcel(false)
    }
  }

  // Set up navigation event suppression
  useMapEvents({
    click: handleMapClick,
    zoomstart: () => {
      navigationSuppressionRef.current = true
    },
    zoomend: () => {
      setTimeout(() => {
        navigationSuppressionRef.current = false
      }, 250)
    },
    dragstart: () => {
      navigationSuppressionRef.current = true
    },
    dragend: () => {
      setTimeout(() => {
        navigationSuppressionRef.current = false
      }, 250)
    }
  })

  return findingParcel ? (
    <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-[1000] bg-[#0f172a] text-[#cbd5e1] px-4 py-2 rounded-lg border border-slate-600 text-[15px] leading-[1.45]">
      Finding parcel...
    </div>
  ) : null
}

function MapController({ onParcelSelect, selectedParcel, onZoomChange, onMapReady, existingConditions, candidateOpenAreaGeometry, buildingUnionGeometry, roadCorridorGeometry, hydrologyGeometry, pavementGeometry, candidateOpenAreaResult = null, showGeneralParcelOutlines = true, selectedParcelMCPI = '', isAnalysisRunning = false, analysisBundleIsCurrent = false, conceptualRoadResult = null, secondaryRoadNetworkResult = null, localStreetNetworkResult = null, developmentOpportunityBlockResult = null, terrainData = null, terrainSuitability = null, conceptualProgram = null, conceptualLayout = null, isRoadGenerating = false }: MapComponentProps) {
  const map = useMap()
  const [zoom, setZoom] = useState(map.getZoom())
  const [countyBoundary, setCountyBoundary] = useState<any>(null)
  const [loadingParcels, setLoadingParcels] = useState(false)
  const [parcelCount, setParcelCount] = useState(0)
  const abortControllerRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mapReadyRef = useRef(false)
  const selectedParcelLayerRef = useRef<L.GeoJSON | null>(null)
  const availableParcelsLayerRef = useRef<L.GeoJSON | null>(null)
  const existingBuildingsLayerRef = useRef<L.GeoJSON | null>(null)
  const buildingUnionLayerRef = useRef<L.GeoJSON | null>(null)
  const roadCorridorLayerRef = useRef<L.GeoJSON | null>(null)
  const intersectingStreetsLayerRef = useRef<L.GeoJSON | null>(null)
  const nearbyStreetsLayerRef = useRef<L.GeoJSON | null>(null)
  const candidateOpenAreaLayerRef = useRef<L.GeoJSON | null>(null)
  const hydrologyLayerRef = useRef<L.GeoJSON | null>(null)
  const pavementLayerRef = useRef<L.GeoJSON | null>(null)
  const proposedResidualAreaLayerRef = useRef<L.GeoJSON | null>(null)
  const proposedRightOfWayLayerRef = useRef<L.GeoJSON | null>(null)
  const proposedRoadCenterlineLayerRef = useRef<L.GeoJSON | null>(null)
  const terrainLayerRef = useRef<L.GeoJSON | null>(null)
  const terrainSuitabilityLayerRef = useRef<L.Layer | null>(null)
  const terrainSuitabilityInputRef = useRef<{ mcpi?: string; features?: any; candidate: any; hydrology: any } | null>(null)
  const proposedAccessPointLayerRef = useRef<L.CircleMarker | null>(null)
  const secondaryRoadCenterlineLayerRef = useRef<L.GeoJSON | null>(null)
  const secondaryRoadRightOfWayLayerRef = useRef<L.GeoJSON | null>(null)
  const developmentOpportunityBlockLayerRef = useRef<L.GeoJSON | null>(null)
  const developmentZoneLayerRef = useRef<L.GeoJSON | null>(null)
  const conceptualLotsLayerRef = useRef<L.GeoJSON | null>(null)
  const buildingEnvelopesLayerRef = useRef<L.GeoJSON | null>(null)
  const developmentPadsLayerRef = useRef<L.GeoJSON | null>(null)
  const localStreetCenterlinesLayerRef = useRef<L.GeoJSON | null>(null)
  const localStreetRowsLayerRef = useRef<L.GeoJSON | null>(null)
  const townhomeRowsLayerRef = useRef<L.GeoJSON | null>(null)
  const townhomeUnitsLayerRef = useRef<L.GeoJSON | null>(null)

  // Toggle states for analysis layers
  const [showBuildings, setShowBuildings] = useState(true)
  const [showRoadCorridors, setShowRoadCorridors] = useState(true)
  const [showCandidateArea, setShowCandidateArea] = useState(true)
  const [showHydrology, setShowHydrology] = useState(true)
  const [showPavement, setShowPavement] = useState(true)
  const [showProposedResidualArea, setShowProposedResidualArea] = useState(true)
  const [showProposedRightOfWay, setShowProposedRightOfWay] = useState(true)
  const [showProposedRoadCenterline, setShowProposedRoadCenterline] = useState(true)
  const [showProposedAccessPoint, setShowProposedAccessPoint] = useState(true)
  const [showSecondaryCenterline, setShowSecondaryCenterline] = useState(true)
  const [showSecondaryRightOfWay, setShowSecondaryRightOfWay] = useState(true)
  const [showDevelopmentOpportunity, setShowDevelopmentOpportunity] = useState(true)
  const toggleDevelopmentOpportunity = () => setShowDevelopmentOpportunity(prev => !prev)
  const [showDevelopmentZones, setShowDevelopmentZones] = useState(true)
  const toggleDevelopmentZones = () => setShowDevelopmentZones(prev => !prev)
  const [showConceptualLots, setShowConceptualLots] = useState(true)
  const toggleConceptualLots = () => setShowConceptualLots(prev => !prev)
  const [showBuildingEnvelopes, setShowBuildingEnvelopes] = useState(true)
  const toggleBuildingEnvelopes = () => setShowBuildingEnvelopes(prev => !prev)
  const [showDevelopmentPads, setShowDevelopmentPads] = useState(true)
  const toggleDevelopmentPads = () => setShowDevelopmentPads(prev => !prev)
  const [showLocalStreetCenterlines, setShowLocalStreetCenterlines] = useState(true)
  const toggleLocalStreetCenterlines = () => setShowLocalStreetCenterlines(prev => !prev)
  const [showLocalStreetRows, setShowLocalStreetRows] = useState(true)
  const toggleLocalStreetRows = () => setShowLocalStreetRows(prev => !prev)
  const [showTownhomeRows, setShowTownhomeRows] = useState(true)
  const toggleTownhomeRows = () => setShowTownhomeRows(prev => !prev)
  const [showTownhomeUnits, setShowTownhomeUnits] = useState(true)
  const toggleTownhomeUnits = () => setShowTownhomeUnits(prev => !prev)

  const buildings = existingConditions?.buildings || []
  const intersectingStreets = existingConditions?.intersectingStreets || []
  const nearbyStreets = existingConditions?.nearbyStreets || []
  const pavement = existingConditions?.pavement || []

  const buildingClassification = candidateOpenAreaResult?.buildingClassification
  const pavementClassification = candidateOpenAreaResult?.pavementClassification
  const preservedBuildingIds = useMemo(() => new Set((buildingClassification?.preservedBuildingObjectIds ?? []).map(String)), [buildingClassification])
  const redevelopmentEligibleBuildingIds = useMemo(() => new Set((buildingClassification?.redevelopmentEligibleObjectIds ?? []).map(String)), [buildingClassification])
  const preservedPavementIds = useMemo(() => new Set((pavementClassification?.preservedPavementObjectIds ?? []).map(String)), [pavementClassification])
  const reconfigurationEligiblePavementIds = useMemo(() => new Set((pavementClassification?.reconfigurationEligiblePavementObjectIds ?? []).map(String)), [pavementClassification])

  const getFeatureObjectId = (f?: any): string | undefined => {
    const p = f?.properties
    const id = p?.OBJECTID ?? p?.objectid ?? p?.id
    return id == null ? undefined : String(id)
  }

  const getBuildingStyle = (f?: any): L.PathOptions => {
    const id = getFeatureObjectId(f)
    if (!id || !buildingClassification) return EXISTING_BUILDING_STYLE
    if (preservedBuildingIds.has(id)) return PRESERVED_BUILDING_STYLE
    if (redevelopmentEligibleBuildingIds.has(id)) return REDEVELOPMENT_ELIGIBLE_BUILDING_STYLE
    return EXISTING_BUILDING_STYLE
  }

  const getPavementStyle = (f?: any): L.PathOptions => {
    const id = getFeatureObjectId(f)
    if (!id || !pavementClassification) return PAVEMENT_STYLE
    if (preservedPavementIds.has(id)) return PRESERVED_PAVEMENT_STYLE
    if (reconfigurationEligiblePavementIds.has(id)) return RECONFIGURATION_ELIGIBLE_PAVEMENT_STYLE
    return PAVEMENT_STYLE
  }

  // Lock all map interactions while a road concept is generating
  useEffect(() => {
    if (!map) return
    if (isRoadGenerating) {
      map.dragging.disable()
      map.scrollWheelZoom.disable()
      map.doubleClickZoom.disable()
      map.touchZoom.disable()
      map.boxZoom.disable()
      map.keyboard.disable()
      if ((map as any).tap) (map as any).tap.disable()
    } else {
      map.dragging.enable()
      map.scrollWheelZoom.enable()
      map.doubleClickZoom.enable()
      map.touchZoom.enable()
      map.boxZoom.enable()
      map.keyboard.enable()
      if ((map as any).tap) (map as any).tap.enable()
    }
  }, [map, isRoadGenerating])

  const localStreetCenterlines = useMemo(() => {
    const streets = localStreetNetworkResult?.localStreets ?? []
    const features = streets.map((s) => s.centerlineGeometry).filter(Boolean) as any[]
    return features.length > 0 ? { type: 'FeatureCollection' as any, features } : null
  }, [localStreetNetworkResult])

  const localStreetRows = useMemo(() => {
    const streets = localStreetNetworkResult?.localStreets ?? []
    const features = streets.map((s) => s.rightOfWayGeometry).filter(Boolean) as any[]
    return features.length > 0 ? { type: 'FeatureCollection' as any, features } : null
  }, [localStreetNetworkResult])

  const townhomeRows = useMemo(() => {
    const rows = conceptualLayout?.townhomeGenerationResult?.rows ?? []
    const features = rows.map((r) => r.geometry).filter(Boolean) as any[]
    return features.length > 0 ? { type: 'FeatureCollection' as any, features } : null
  }, [conceptualLayout])

  const townhomeUnits = useMemo(() => {
    const rows = conceptualLayout?.townhomeGenerationResult?.rows ?? []
    const envelopes = rows.flatMap((r) => r.unitEnvelopes.map((u) => u.geometry))
    const features = envelopes.filter(Boolean) as any[]
    return features.length > 0 ? { type: 'FeatureCollection' as any, features } : null
  }, [conceptualLayout])

  if (VERBOSE_GIS_DIAGNOSTICS) {
    console.log('[LocalStreetMap]', {
      mcpi: localStreetNetworkResult?.mcpi ?? selectedParcelMCPI,
      resultExists: !!localStreetNetworkResult,
      localStreetCount: localStreetNetworkResult?.localStreetCount ?? 0,
      centerlineGeometryCount: localStreetCenterlines?.features?.length ?? 0,
      rowGeometryCount: localStreetRows?.features?.length ?? 0,
      centerlinesVisible: showLocalStreetCenterlines,
      rowVisible: showLocalStreetRows,
      centerlinesPane: !!map?.getPane('localStreetCenterlinesPane'),
      rowPane: !!map?.getPane('localStreetRowsPane')
    })
  }

  if (import.meta.env.DEV && conceptualProgram) {
    console.log('[ConceptualDevelopmentProgram]', {
      mcpi: conceptualProgram.mcpi,
      sourceOpportunityBlockCount: conceptualProgram.sourceOpportunityBlockCount,
      zoneCount: conceptualProgram.zoneCount,
      capacityStatus: conceptualProgram.capacityStatus,
      totalOpportunityBlockAreaAcres: conceptualProgram.totalOpportunityBlockAreaAcres,
      programmableAreaAcres: conceptualProgram.programmableAreaAcres,
      residualAreaAcres: conceptualProgram.residualAreaAcres,
      programmableRoadServedAreaAcres: conceptualProgram.programmableRoadServedAreaAcres,
      programmableNearNetworkAreaAcres: conceptualProgram.programmableNearNetworkAreaAcres,
      programmableLatentAreaAcres: conceptualProgram.programmableLatentAreaAcres,
      programmableAccountingDifferenceSqFt: conceptualProgram.programmableAccountingDifferenceSqFt,
      actualPrimaryServedAreaAcres: conceptualProgram.actualPrimaryServedAreaAcres,
      actualSecondaryNewServedAreaAcres: conceptualProgram.actualSecondaryNewServedAreaAcres,
      actualTotalNetworkServedAreaAcres: conceptualProgram.actualTotalNetworkServedAreaAcres,
      networkServiceDifferenceSqFt: conceptualProgram.networkServiceDifferenceSqFt,
      residentialCompatibleAreaAcres: conceptualProgram.residentialCompatibleAreaAcres,
      commercialCompatibleAreaAcres: conceptualProgram.commercialCompatibleAreaAcres,
      selectedDevelopmentTypes: conceptualProgram.selectedDevelopmentTypes,
      targetDensity: conceptualProgram.targetDensity,
      preferredLotSize: conceptualProgram.preferredLotSize,
      conceptualCapacity: conceptualProgram.conceptualCapacity,
      conservationDifferenceSqFt: conceptualProgram.conservationDifferenceSqFt,
      parametersApplied: conceptualProgram.parametersApplied,
      warnings: conceptualProgram.warnings
    })

    console.log('[DevelopmentZoneAudit]',
      conceptualProgram.zones.map((z) => ({
        zoneId: z.id,
        sourceBlockId: z.sourceBlockId,
        acres: z.areaAcres,
        programStatus: z.programStatus,
        opportunityClass: z.opportunityClass,
        roadRelationship: z.roadRelationship,
        actualRoadServedAreaAcres: z.actualRoadServedAreaAcres,
        roadServedFraction: z.roadServedFraction,
        terrainAssessment: z.terrainAssessment,
        compatibilityByUse: z.compatibilityByUse,
        bestCompatibleUse: z.bestCompatibleUse,
        bestCompatibility: z.bestCompatibility,
        capacityStatus: z.capacityStatus,
        capacity: { densityUnits: z.densityCapacity, lotUnits: z.lotCapacity },
        reason: z.reasons[0]
      }))
    )
  }

  if (import.meta.env.DEV && conceptualLayout) {
    console.log('[DevelopmentLayoutMap]', {
      mcpi: conceptualLayout.mcpi,
      resultExists: true,
      lotGeometryCount: conceptualLayout.lotCells.length,
      buildingEnvelopeGeometryCount: conceptualLayout.buildingEnvelopes.length,
      developmentPadGeometryCount: conceptualLayout.developmentPads.length,
      lotsVisible: showConceptualLots,
      envelopesVisible: showBuildingEnvelopes,
      padsVisible: showDevelopmentPads
    })
  }

  const [showTerrain, setShowTerrain] = useState(() => !!(terrainData && terrainData.contours.length > 0))
  const toggleTerrain = () => setShowTerrain(prev => !prev)
  const [showTerrainSuitability, setShowTerrainSuitability] = useState(true)
  const toggleTerrainSuitability = () => setShowTerrainSuitability(prev => !prev)

  const terrainVisibilityInitializedForMCPI = useRef<string | null>(null)
  useEffect(() => {
    const mcpi = terrainData?.mcpi ?? null
    if (mcpi && terrainVisibilityInitializedForMCPI.current !== mcpi) {
      setShowTerrain(!!(terrainData && terrainData.contours.length > 0))
      terrainVisibilityInitializedForMCPI.current = mcpi
    }
  }, [terrainData])

  const toggleBuildings = () => setShowBuildings(prev => !prev)
  const toggleRoadCorridors = () => setShowRoadCorridors(prev => !prev)
  const toggleCandidateArea = () => setShowCandidateArea(prev => !prev)
  const toggleHydrology = () => setShowHydrology(prev => !prev)
  const togglePavement = () => setShowPavement(prev => !prev)
  const toggleProposedResidualArea = () => setShowProposedResidualArea(prev => !prev)
  const toggleProposedRightOfWay = () => setShowProposedRightOfWay(prev => !prev)
  const toggleProposedRoadCenterline = () => setShowProposedRoadCenterline(prev => !prev)
  const toggleProposedAccessPoint = () => setShowProposedAccessPoint(prev => !prev)
  const toggleSecondaryCenterline = () => setShowSecondaryCenterline(prev => !prev)
  const toggleSecondaryRightOfWay = () => setShowSecondaryRightOfWay(prev => !prev)

  // Get parcel ID for comparison (must be declared before useEffects that reference it)
  const getParcelId = (feature: any): string => {
    return feature.properties?.OBJECTID?.toString() || feature.properties?.PA_MCPI || ''
  }

  const selectedParcelId = selectedParcel ? getParcelId(selectedParcel) : null

  // Reset visibility states when geometries change (new analysis)
  useEffect(() => {
    if (buildingUnionGeometry || roadCorridorGeometry || candidateOpenAreaGeometry) {
      // New analysis result - reset all to visible
      setShowBuildings(true)
      setShowRoadCorridors(true)
      setShowCandidateArea(true)
      setShowPavement(true)
    } else {
      // Analysis cleared - reset to default
      setShowBuildings(true)
      setShowRoadCorridors(true)
      setShowCandidateArea(true)
      setShowPavement(true)
    }
  }, [buildingUnionGeometry, roadCorridorGeometry, candidateOpenAreaGeometry])

  // Centralized parcel style constants
  const PARCEL_BOUNDARY_STYLE: L.PathOptions = {
    color: '#40826D',
    weight: 1,
    opacity: 0.88,
    fill: false,
    fillOpacity: 0,
    interactive: false,
  }

  const SELECTED_PARCEL_STYLE: L.PathOptions = {
    color: '#93E9BE',
    weight: 3,
    opacity: 1,
    fillColor: '#93E9BE',
    fillOpacity: 0.05,
    interactive: false,
  }

  const BUILDING_STYLE: L.PathOptions = {
    fillColor: '#36454F',
    color: '#1E6B50',
    weight: 2,
    fillOpacity: 0.75
  }

  const EXISTING_BUILDING_STYLE: L.PathOptions = {
    fillColor: '#64748b',
    color: '#475569',
    weight: 1,
    fillOpacity: 0.3
  }

  const PRESERVED_BUILDING_STYLE: L.PathOptions = {
    fillColor: '#475569',
    color: '#334155',
    weight: 2,
    fillOpacity: 0.55,
    interactive: false
  }

  const REDEVELOPMENT_ELIGIBLE_BUILDING_STYLE: L.PathOptions = {
    fillColor: '#7c3aed',
    color: '#a78bfa',
    weight: 1,
    fillOpacity: 0.25,
    dashArray: '4, 4',
    interactive: false
  }

  const ROAD_CORRIDOR_STYLE: L.PathOptions = {
    fillColor: '#F59E0B',
    color: '#F59E0B',
    weight: 2,
    fillOpacity: 0.45
  }

  const INTERSECTING_STREET_STYLE: L.PathOptions = {
    color: '#8ED8C0',
    weight: 2.5,
    opacity: 0.8,
    fill: false,
    interactive: false,
  }

  const NEARBY_STREET_STYLE: L.PathOptions = {
    color: '#64748b',
    weight: 1.5,
    opacity: 0.5,
    fill: false,
    interactive: false,
    dashArray: '5, 5'
  }

  const CANDIDATE_OPEN_AREA_STYLE: L.PathOptions = {
    fillColor: '#93E9BE',
    fillOpacity: 0.30,
    stroke: false,
    interactive: false
  }

  const HYDROLOGY_STYLE: L.PathOptions = {
    fillColor: '#0ea5e9',
    fillOpacity: 0.35,
    color: '#0ea5e9',
    weight: 1,
    interactive: false
  }

  const PAVEMENT_STYLE: L.PathOptions = {
    fillColor: '#6b7280',
    fillOpacity: 0.55,
    color: '#4b5563',
    weight: 1,
    interactive: false
  }

  const PRESERVED_PAVEMENT_STYLE: L.PathOptions = {
    fillColor: '#6b7280',
    fillOpacity: 0.55,
    color: '#4b5563',
    weight: 1,
    interactive: false
  }

  const RECONFIGURATION_ELIGIBLE_PAVEMENT_STYLE: L.PathOptions = {
    fillColor: '#8b5cf6',
    fillOpacity: 0.30,
    color: '#c4b5fd',
    weight: 1,
    dashArray: '4, 4',
    interactive: false
  }

  const PROPOSED_RESIDUAL_AREA_STYLE: L.PathOptions = {
    fillColor: '#14b8a6',
    fillOpacity: 0.22,
    color: '#0d9488',
    weight: 1,
    interactive: false
  }

  const PROPOSED_RIGHT_OF_WAY_STYLE: L.PathOptions = {
    fillColor: '#a855f7',
    fillOpacity: 0.35,
    color: '#d8b4fe',
    weight: 2,
    interactive: false
  }

  const PROPOSED_ROAD_CENTERLINE_STYLE: L.PathOptions = {
    color: '#d946ef',
    weight: 3,
    opacity: 1,
    dashArray: '6, 6',
    interactive: false
  }

  const SECONDARY_CENTERLINE_STYLE: L.PathOptions = {
    color: '#34d399',
    weight: 2.5,
    opacity: 1,
    dashArray: '4, 4',
    interactive: false
  }

  const SECONDARY_RIGHT_OF_WAY_STYLE: L.PathOptions = {
    fillColor: '#34d399',
    fillOpacity: 0.35,
    color: '#6ee7b7',
    weight: 1.5,
    opacity: 0.8,
    interactive: false
  }

  const DEVELOPMENT_OPPORTUNITY_STYLES: Record<string, L.PathOptions> = {
    HIGH: { fillColor: '#10b981', fillOpacity: 0.45, color: '#059669', weight: 1.5, interactive: false },
    MODERATE: { fillColor: '#6ee7b7', fillOpacity: 0.35, color: '#34d399', weight: 1.5, interactive: false },
    LOW: { fillColor: '#a7f3d0', fillOpacity: 0.25, color: '#6ee7b7', weight: 1, interactive: false },
    RESIDUAL: { fillColor: '#94a3b8', fillOpacity: 0.15, color: '#64748b', weight: 1, interactive: false }
  }

  const DEVELOPMENT_ZONE_STYLES: Record<string, L.PathOptions> = {
    PRIMARY_FRONTAGE: { fillColor: '#34d399', fillOpacity: 0.42, color: '#10b981', weight: 1.5, interactive: false },
    SECONDARY_FRONTAGE: { fillColor: '#6ee7b7', fillOpacity: 0.36, color: '#34d399', weight: 1.5, interactive: false },
    NEAR_NETWORK: { fillColor: '#a7f3d0', fillOpacity: 0.28, color: '#6ee7b7', weight: 1, interactive: false },
    LATENT: { fillColor: '#94a3b8', fillOpacity: 0.12, color: '#64748b', weight: 1, dashArray: '4 4', interactive: false }
  }

  const CONCEPTUAL_LOT_STYLE: L.PathOptions = {
    fillColor: '#60a5fa',
    color: '#3b82f6',
    weight: 1,
    fillOpacity: 0.35,
    interactive: true
  }

  const BUILDING_ENVELOPE_STYLE: L.PathOptions = {
    fillColor: '#f59e0b',
    color: '#fbbf24',
    weight: 1,
    fillOpacity: 0.45,
    interactive: true
  }

  const DEVELOPMENT_PAD_STYLES: Record<string, L.PathOptions> = {
    commercial: { fillColor: '#a855f7', color: '#d8b4fe', weight: 1.5, fillOpacity: 0.4, interactive: true },
    multifamily: { fillColor: '#ec4899', color: '#f9a8d4', weight: 1.5, fillOpacity: 0.4, interactive: true },
    townhomes: { fillColor: '#a855f7', color: '#d8b4fe', weight: 1.5, fillOpacity: 0.4, interactive: true },
    default: { fillColor: '#9ca3af', color: '#d1d5db', weight: 1, fillOpacity: 0.35, interactive: true }
  }

  const PROPOSED_ACCESS_POINT_STYLE: L.PathOptions = {
    fillColor: '#22d3ee',
    color: '#ffffff',
    weight: 2,
    fillOpacity: 1,
    opacity: 1
  }

  const TERRAIN_CONTOUR_STYLE: L.PathOptions = {
    color: '#d4a373',
    weight: 1,
    opacity: 0.6,
    fill: false,
    interactive: false
  }

  const LOCAL_STREET_CENTERLINE_STYLE: L.PathOptions = {
    color: '#8ED8C0',
    weight: 2,
    opacity: 0.8,
    fill: false,
    interactive: false,
  }

  const LOCAL_STREET_ROW_STYLE: L.PathOptions = {
    fillColor: '#64748b',
    fillOpacity: 0.35,
    color: '#475569',
    weight: 1,
    interactive: false
  }

  const TOWNHOME_ROW_STYLE: L.PathOptions = {
    fillColor: '#A78BFA',
    fillOpacity: 0.35,
    color: '#7C3AED',
    weight: 1,
    interactive: false
  }

  const TOWNHOME_UNIT_STYLE: L.PathOptions = {
    fillColor: '#C4B5FD',
    fillOpacity: 0.25,
    color: '#8B5CF6',
    weight: 1,
    dashArray: '4, 4',
    interactive: false
  }

  // Notify parent when map is ready
  useEffect(() => {
    if (!mapReadyRef.current && onMapReady) {
      onMapReady(map)
      mapReadyRef.current = true

      // Create custom panes for parcels
      if (!map.getPane('countyPane')) {
        map.createPane('countyPane')
        const countyPane = map.getPane('countyPane')
        if (countyPane) {
          countyPane.style.zIndex = '420'
        }
      }

      if (!map.getPane('parcelPane')) {
        map.createPane('parcelPane')
        const parcelPane = map.getPane('parcelPane')
        if (parcelPane) {
          parcelPane.style.zIndex = '450'
          parcelPane.style.pointerEvents = 'none'
        }
      }

      if (!map.getPane('candidateOpenAreaPane')) {
        map.createPane('candidateOpenAreaPane')
        const candidatePane = map.getPane('candidateOpenAreaPane')
        if (candidatePane) {
          candidatePane.style.zIndex = '620'
          candidatePane.style.pointerEvents = 'none'
        }
      }

      if (!map.getPane('proposedResidualAreaPane')) {
        map.createPane('proposedResidualAreaPane')
        const residualPane = map.getPane('proposedResidualAreaPane')
        if (residualPane) {
          residualPane.style.zIndex = '625'
          residualPane.style.pointerEvents = 'none'
        }
      }

      if (!map.getPane('proposedRightOfWayPane')) {
        map.createPane('proposedRightOfWayPane')
        const rowPane = map.getPane('proposedRightOfWayPane')
        if (rowPane) {
          rowPane.style.zIndex = '630'
          rowPane.style.pointerEvents = 'none'
        }
      }

      if (!map.getPane('proposedRoadCenterlinePane')) {
        map.createPane('proposedRoadCenterlinePane')
        const centerlinePane = map.getPane('proposedRoadCenterlinePane')
        if (centerlinePane) {
          centerlinePane.style.zIndex = '635'
          centerlinePane.style.pointerEvents = 'none'
        }
      }

      if (!map.getPane('secondaryRoadCenterlinePane')) {
        map.createPane('secondaryRoadCenterlinePane')
        const secCenterlinePane = map.getPane('secondaryRoadCenterlinePane')
        if (secCenterlinePane) {
          secCenterlinePane.style.zIndex = '636'
          secCenterlinePane.style.pointerEvents = 'none'
        }
      }

      if (!map.getPane('secondaryRoadRightOfWayPane')) {
        map.createPane('secondaryRoadRightOfWayPane')
        const secRowPane = map.getPane('secondaryRoadRightOfWayPane')
        if (secRowPane) {
          secRowPane.style.zIndex = '631'
          secRowPane.style.pointerEvents = 'none'
        }
      }

      if (!map.getPane('developmentOpportunityPane')) {
        map.createPane('developmentOpportunityPane')
        const opportunityPane = map.getPane('developmentOpportunityPane')
        if (opportunityPane) {
          opportunityPane.style.zIndex = '628'
          opportunityPane.style.pointerEvents = 'none'
        }
      }

      if (!map.getPane('proposedAccessPointPane')) {
        map.createPane('proposedAccessPointPane')
        const accessPane = map.getPane('proposedAccessPointPane')
        if (accessPane) {
          accessPane.style.zIndex = '640'
          accessPane.style.pointerEvents = 'none'
        }
      }

      if (!map.getPane('roadCorridorsPane')) {
        map.createPane('roadCorridorsPane')
        const roadCorridorsPane = map.getPane('roadCorridorsPane')
        if (roadCorridorsPane) {
          roadCorridorsPane.style.zIndex = '510'
          roadCorridorsPane.style.pointerEvents = 'none'
        }
      }

      if (!map.getPane('buildingsPane')) {
        map.createPane('buildingsPane')
        const buildingsPane = map.getPane('buildingsPane')
        if (buildingsPane) {
          buildingsPane.style.zIndex = '520'
          buildingsPane.style.pointerEvents = 'none'
        }
      }

      if (!map.getPane('hydrologyPane')) {
        map.createPane('hydrologyPane')
        const hydrologyPane = map.getPane('hydrologyPane')
        if (hydrologyPane) {
          hydrologyPane.style.zIndex = '525'
          hydrologyPane.style.pointerEvents = 'none'
        }
      }

      if (!map.getPane('pavementPane')) {
        map.createPane('pavementPane')
        const pavementPane = map.getPane('pavementPane')
        if (pavementPane) {
          pavementPane.style.zIndex = '527'
          pavementPane.style.pointerEvents = 'none'
        }
      }

      if (!map.getPane('terrainPane')) {
        map.createPane('terrainPane')
        const terrainPane = map.getPane('terrainPane')
        if (terrainPane) {
          terrainPane.style.zIndex = '528'
          terrainPane.style.pointerEvents = 'none'
        }
      }

      if (!map.getPane('terrainSuitabilityPane')) {
        map.createPane('terrainSuitabilityPane')
        const terrainSuitabilityPane = map.getPane('terrainSuitabilityPane')
        if (terrainSuitabilityPane) {
          terrainSuitabilityPane.style.zIndex = '520'
          terrainSuitabilityPane.style.pointerEvents = 'none'
        }
      }

      if (!map.getPane('selectedParcelPane')) {
        map.createPane('selectedParcelPane')
        const selectedPane = map.getPane('selectedParcelPane')
        if (selectedPane) {
          selectedPane.style.zIndex = '650'
          selectedPane.style.pointerEvents = 'none'
          selectedPane.style.filter = 'drop-shadow(0 0 2px rgba(0, 84, 97, 0.65))'
        }
      }

      if (!map.getPane('roadsPane')) {
        map.createPane('roadsPane')
        const roadsPane = map.getPane('roadsPane')
        if (roadsPane) {
          roadsPane.style.zIndex = '480'
          roadsPane.style.pointerEvents = 'none'
        }
      }

      if (!map.getPane('developmentZonesPane')) {
        map.createPane('developmentZonesPane')
        const developmentZonesPane = map.getPane('developmentZonesPane')
        if (developmentZonesPane) {
          developmentZonesPane.style.zIndex = '629'
          developmentZonesPane.style.pointerEvents = 'none'
        }
      }

      if (!map.getPane('conceptualLotsPane')) {
        map.createPane('conceptualLotsPane')
        const lotsPane = map.getPane('conceptualLotsPane')
        if (lotsPane) {
          lotsPane.style.zIndex = '632'
          lotsPane.style.pointerEvents = 'none'
        }
      }

      if (!map.getPane('buildingEnvelopesPane')) {
        map.createPane('buildingEnvelopesPane')
        const envPane = map.getPane('buildingEnvelopesPane')
        if (envPane) {
          envPane.style.zIndex = '633'
          envPane.style.pointerEvents = 'none'
        }
      }

      if (!map.getPane('developmentPadsPane')) {
        map.createPane('developmentPadsPane')
        const padsPane = map.getPane('developmentPadsPane')
        if (padsPane) {
          padsPane.style.zIndex = '634'
          padsPane.style.pointerEvents = 'none'
        }
      }

      if (!map.getPane('localStreetCenterlinesPane')) {
        map.createPane('localStreetCenterlinesPane')
        const localStreetCenterlinesPane = map.getPane('localStreetCenterlinesPane')
        if (localStreetCenterlinesPane) {
          localStreetCenterlinesPane.style.zIndex = '460'
          localStreetCenterlinesPane.style.pointerEvents = 'none'
        }
      }

      if (!map.getPane('localStreetRowsPane')) {
        map.createPane('localStreetRowsPane')
        const localStreetRowsPane = map.getPane('localStreetRowsPane')
        if (localStreetRowsPane) {
          localStreetRowsPane.style.zIndex = '470'
          localStreetRowsPane.style.pointerEvents = 'none'
        }
      }

      if (!map.getPane('townhomeRowsPane')) {
        map.createPane('townhomeRowsPane')
        const townhomeRowsPane = map.getPane('townhomeRowsPane')
        if (townhomeRowsPane) {
          townhomeRowsPane.style.zIndex = '480'
          townhomeRowsPane.style.pointerEvents = 'none'
        }
      }

      if (!map.getPane('townhomeUnitsPane')) {
        map.createPane('townhomeUnitsPane')
        const townhomeUnitsPane = map.getPane('townhomeUnitsPane')
        if (townhomeUnitsPane) {
          townhomeUnitsPane.style.zIndex = '485'
          townhomeUnitsPane.style.pointerEvents = 'none'
        }
      }

      // Invalidate size to ensure proper rendering
      setTimeout(() => {
        map.invalidateSize()
      }, 100)


    }
  }, [map, onMapReady])

  // Load county boundary on mount
  useEffect(() => {
    fetchCountyBoundary()
      .then(data => {
        if (data.features && data.features.length > 0) {
          setCountyBoundary(data.features[0])
        }
      })
      .catch(err => {
        console.error('Failed to load county boundary:', err)
      })
  }, [])

  // Handle existing conditions overlays (buildings and streets)
  useEffect(() => {
    // Remove existing layers
    if (existingBuildingsLayerRef.current) {
      map.removeLayer(existingBuildingsLayerRef.current)
      existingBuildingsLayerRef.current = null
    }
    if (intersectingStreetsLayerRef.current) {
      map.removeLayer(intersectingStreetsLayerRef.current)
      intersectingStreetsLayerRef.current = null
    }
    if (nearbyStreetsLayerRef.current) {
      map.removeLayer(nearbyStreetsLayerRef.current)
      nearbyStreetsLayerRef.current = null
    }

    // Add new layers if data exists
    if (existingConditions) {
      if (buildings && buildings.length > 0) {
        const buildingsGeoJSON = {
          type: 'FeatureCollection' as const,
          features: buildings
        }
        const layer = L.geoJSON(buildingsGeoJSON, {
          style: getBuildingStyle,
          pane: 'buildingsPane'
        })
        existingBuildingsLayerRef.current = layer
      }

      if (intersectingStreets && intersectingStreets.length > 0) {
        const intersectingStreetsGeoJSON = {
          type: 'FeatureCollection' as const,
          features: intersectingStreets
        }
        intersectingStreetsLayerRef.current = L.geoJSON(intersectingStreetsGeoJSON, {
          style: INTERSECTING_STREET_STYLE,
          pane: 'roadsPane'
        }).addTo(map)
      }

      if (nearbyStreets && nearbyStreets.length > 0) {
        const nearbyStreetsGeoJSON = {
          type: 'FeatureCollection' as const,
          features: nearbyStreets
        }
        nearbyStreetsLayerRef.current = L.geoJSON(nearbyStreetsGeoJSON, {
          style: NEARBY_STREET_STYLE,
          pane: 'roadsPane'
        }).addTo(map)
      }
    }

    // Cleanup
    return () => {
      if (existingBuildingsLayerRef.current) {
        map.removeLayer(existingBuildingsLayerRef.current)
      }
      if (intersectingStreetsLayerRef.current) {
        map.removeLayer(intersectingStreetsLayerRef.current)
      }
      if (nearbyStreetsLayerRef.current) {
        map.removeLayer(nearbyStreetsLayerRef.current)
      }
    }
  }, [map, buildings, intersectingStreets, nearbyStreets, buildingClassification])

  // Handle building union overlay (A. Geometry creation lifecycle)
  useEffect(() => {
    if (!map) return

    // Remove old layer if geometry changed or analysis is no longer current
    if (buildingUnionLayerRef.current) {
      map.removeLayer(buildingUnionLayerRef.current)
      buildingUnionLayerRef.current = null
    }

    if (!analysisBundleIsCurrent || !buildingUnionGeometry) {
      return
    }

    // Create stable layer reference
    const layer = L.geoJSON(buildingUnionGeometry, {
      style: BUILDING_STYLE,
      pane: 'buildingsPane'
    })

    buildingUnionLayerRef.current = layer

    // Add to map if visible
    if (showBuildings) {
      layer.addTo(map)
    }

    return () => {
      if (map.hasLayer(layer)) {
        map.removeLayer(layer)
      }
      if (buildingUnionLayerRef.current === layer) {
        buildingUnionLayerRef.current = null
      }
    }
  }, [map, buildingUnionGeometry, analysisBundleIsCurrent])

  // Handle building visibility toggle (B. Visibility lifecycle)
  useEffect(() => {
    const layer = buildingUnionLayerRef.current
    if (!layer || !map) return

    if (showBuildings) {
      if (!map.hasLayer(layer)) {
        layer.addTo(map)
      }
    } else {
      if (map.hasLayer(layer)) {
        map.removeLayer(layer)
      }
    }
  }, [showBuildings, map])

  // Handle existing building visibility toggle (B. Visibility lifecycle)
  useEffect(() => {
    const layer = existingBuildingsLayerRef.current
    if (!layer || !map) return

    if (showBuildings) {
      if (!map.hasLayer(layer)) {
        layer.addTo(map)
      }
    } else {
      if (map.hasLayer(layer)) {
        map.removeLayer(layer)
      }
    }
  }, [showBuildings, map])

  // Handle road corridor overlay (A. Geometry creation lifecycle)
  useEffect(() => {
    if (!map) return

    // Remove old layer if geometry changed or analysis is no longer current
    if (roadCorridorLayerRef.current) {
      map.removeLayer(roadCorridorLayerRef.current)
      roadCorridorLayerRef.current = null
    }

    if (!analysisBundleIsCurrent || !roadCorridorGeometry) {
      return
    }

    // Create stable layer reference
    const layer = L.geoJSON(roadCorridorGeometry, {
      style: ROAD_CORRIDOR_STYLE,
      pane: 'roadCorridorsPane'
    })

    roadCorridorLayerRef.current = layer

    // Add to map if visible
    if (showRoadCorridors) {
      layer.addTo(map)
    }

    return () => {
      if (map.hasLayer(layer)) {
        map.removeLayer(layer)
      }
      if (roadCorridorLayerRef.current === layer) {
        roadCorridorLayerRef.current = null
      }
    }
  }, [map, roadCorridorGeometry, analysisBundleIsCurrent])

  // Handle road corridor visibility toggle (B. Visibility lifecycle)
  useEffect(() => {
    const layer = roadCorridorLayerRef.current
    if (!layer || !map) return

    if (showRoadCorridors) {
      if (!map.hasLayer(layer)) {
        layer.addTo(map)
      }
    } else {
      if (map.hasLayer(layer)) {
        map.removeLayer(layer)
      }
    }
  }, [showRoadCorridors, map])

  // Handle candidate open area overlay (A. Geometry creation lifecycle)
  useEffect(() => {
    if (!map) return

    // Remove old layer if geometry changed or analysis is no longer current
    if (candidateOpenAreaLayerRef.current) {
      map.removeLayer(candidateOpenAreaLayerRef.current)
      candidateOpenAreaLayerRef.current = null
    }

    if (!analysisBundleIsCurrent || !candidateOpenAreaGeometry) {
      return
    }

    // Create stable layer reference
    const layer = L.geoJSON(candidateOpenAreaGeometry, {
      style: CANDIDATE_OPEN_AREA_STYLE,
      pane: 'candidateOpenAreaPane'
    })

    candidateOpenAreaLayerRef.current = layer

    // Add to map if visible
    if (showCandidateArea) {
      layer.addTo(map)
    }

    return () => {
      if (map.hasLayer(layer)) {
        map.removeLayer(layer)
      }
      if (candidateOpenAreaLayerRef.current === layer) {
        candidateOpenAreaLayerRef.current = null
      }
    }
  }, [map, candidateOpenAreaGeometry, analysisBundleIsCurrent])

  // Handle candidate area visibility toggle (B. Visibility lifecycle)
  useEffect(() => {
    const layer = candidateOpenAreaLayerRef.current
    if (!layer || !map) return

    if (showCandidateArea) {
      if (!map.hasLayer(layer)) {
        layer.addTo(map)
      }
    } else {
      if (map.hasLayer(layer)) {
        map.removeLayer(layer)
      }
    }
  }, [showCandidateArea, map])

  // Handle hydrology overlay (A. Geometry creation lifecycle)
  useEffect(() => {
    if (!map) return

    if (hydrologyLayerRef.current) {
      map.removeLayer(hydrologyLayerRef.current)
      hydrologyLayerRef.current = null
    }

    if (!analysisBundleIsCurrent || !hydrologyGeometry) {
      return
    }

    const layer = L.geoJSON(hydrologyGeometry, {
      style: HYDROLOGY_STYLE,
      pane: 'hydrologyPane'
    })

    hydrologyLayerRef.current = layer

    if (showHydrology) layer.addTo(map)

    return () => {
      if (map.hasLayer(layer)) {
        map.removeLayer(layer)
      }
      if (hydrologyLayerRef.current === layer) {
        hydrologyLayerRef.current = null
      }
    }
  }, [map, hydrologyGeometry, analysisBundleIsCurrent])

  // Handle hydrology visibility toggle (B. Visibility lifecycle)
  useEffect(() => {
    const layer = hydrologyLayerRef.current
    if (!layer || !map) return

    if (showHydrology) {
      if (!map.hasLayer(layer)) {
        layer.addTo(map)
      }
    } else {
      if (map.hasLayer(layer)) {
        map.removeLayer(layer)
      }
    }
  }, [showHydrology, map])

  // Handle pavement overlay (A. Geometry creation lifecycle)
  useEffect(() => {
    if (!map) return

    if (pavementLayerRef.current) {
      map.removeLayer(pavementLayerRef.current)
      pavementLayerRef.current = null
    }

    const hasRawPavement = pavement && pavement.length > 0
    if (!analysisBundleIsCurrent || (!hasRawPavement && !pavementGeometry)) {
      return
    }

    const source = hasRawPavement
      ? ({ type: 'FeatureCollection' as const, features: pavement })
      : pavementGeometry

    const layer = L.geoJSON(source, {
      style: getPavementStyle,
      pane: 'pavementPane'
    })

    pavementLayerRef.current = layer

    if (showPavement) layer.addTo(map)

    return () => {
      if (map.hasLayer(layer)) {
        map.removeLayer(layer)
      }
      if (pavementLayerRef.current === layer) {
        pavementLayerRef.current = null
      }
    }
  }, [map, pavement, pavementGeometry, analysisBundleIsCurrent, pavementClassification])

  // Handle pavement visibility toggle (B. Visibility lifecycle)
  useEffect(() => {
    const layer = pavementLayerRef.current
    if (!layer || !map) return

    if (showPavement) {
      if (!map.hasLayer(layer)) {
        layer.addTo(map)
      }
    } else {
      if (map.hasLayer(layer)) {
        map.removeLayer(layer)
      }
    }
  }, [showPavement, map])

  // Handle terrain contour overlay (A. Geometry creation lifecycle)
  useEffect(() => {
    if (!map) return

    if (terrainLayerRef.current) {
      map.removeLayer(terrainLayerRef.current)
      terrainLayerRef.current = null
    }

    if (!analysisBundleIsCurrent || !terrainData?.contours || terrainData.contours.length === 0) {
      return
    }

    const features = terrainData.contours.map(c => ({
      type: 'Feature' as const,
      properties: { elevationFt: c.properties.elevationFt },
      geometry: c.geometry
    }))

    const layer = L.geoJSON(features as any, {
      style: TERRAIN_CONTOUR_STYLE,
      pane: 'terrainPane',
      interactive: false
    })

    terrainLayerRef.current = layer
    if (showTerrain) layer.addTo(map)

    return () => {
      if (map.hasLayer(layer)) {
        map.removeLayer(layer)
      }
      if (terrainLayerRef.current === layer) {
        terrainLayerRef.current = null
      }
    }
  }, [map, terrainData, analysisBundleIsCurrent])

  // Handle terrain visibility toggle (B. Visibility lifecycle)
  useEffect(() => {
    const layer = terrainLayerRef.current
    if (!layer || !map) return

    if (showTerrain) {
      if (!map.hasLayer(layer)) {
        layer.addTo(map)
      }
    } else {
      if (map.hasLayer(layer)) {
        map.removeLayer(layer)
      }
    }
  }, [showTerrain, map])

  // Authoritative terrain-suitability overlay lifecycle.
  // Rebuilds the smooth canvas image only when the underlying data/clip inputs
  // change. Toggling visibility adds or removes the current image overlay
  // without recomputing the canvas.
  useEffect(() => {
    if (!map) return

    const hasData = !!(terrainSuitability?.suitabilityFeatures && terrainSuitability.suitabilityFeatures.features.length > 0)
    const dataChanged = !terrainSuitabilityInputRef.current ||
      terrainSuitabilityInputRef.current.mcpi !== terrainSuitability?.mcpi ||
      terrainSuitabilityInputRef.current.features !== terrainSuitability?.suitabilityFeatures ||
      terrainSuitabilityInputRef.current.candidate !== candidateOpenAreaGeometry ||
      terrainSuitabilityInputRef.current.hydrology !== hydrologyGeometry

    if (import.meta.env.DEV) {
      console.log('[MapLayerLifecycleAudit]', {
        event: 'terrain-suitability-sync',
        mcpi: selectedParcelMCPI,
        showTerrain,
        showTerrainSuitability,
        terrainSuitabilityDataPresent: hasData,
        terrainSuitabilityOverlayRefPresent: !!terrainSuitabilityLayerRef.current,
        terrainSuitabilityOverlayOnMap: !!(terrainSuitabilityLayerRef.current && map.hasLayer(terrainSuitabilityLayerRef.current)),
        terrainSuitabilityDataIdentityChanged: dataChanged,
        canvasRebuilt: false,
        isAnalysisRunning,
        analysisBundleIsCurrent,
        selectedAlternativeId: (conceptualProgram as any)?.alternativeId ?? null
      })
    }

    if (!hasData) {
      if (terrainSuitabilityLayerRef.current) {
        if (map.hasLayer(terrainSuitabilityLayerRef.current)) {
          map.removeLayer(terrainSuitabilityLayerRef.current)
        }
        terrainSuitabilityLayerRef.current = null
      }
      return
    }

    let canvasRebuilt = false

    if (dataChanged) {
      if (terrainSuitabilityLayerRef.current) {
        if (map.hasLayer(terrainSuitabilityLayerRef.current)) {
          map.removeLayer(terrainSuitabilityLayerRef.current)
        }
        terrainSuitabilityLayerRef.current = null
      }

      const spec = renderTerrainSuitabilityCanvas(
        terrainSuitability.suitabilityFeatures as any,
        candidateOpenAreaGeometry,
        hydrologyGeometry,
        512
      )

      if (spec) {
        const layer = L.imageOverlay(spec.dataUrl, spec.bounds, {
          opacity: 1,
          interactive: false,
          pane: 'terrainSuitabilityPane'
        })
        terrainSuitabilityLayerRef.current = layer
        terrainSuitabilityInputRef.current = {
          mcpi: terrainSuitability.mcpi,
          features: terrainSuitability.suitabilityFeatures,
          candidate: candidateOpenAreaGeometry,
          hydrology: hydrologyGeometry
        }
        canvasRebuilt = true
      }
    }

    const layer = terrainSuitabilityLayerRef.current
    if (layer) {
      if (showTerrainSuitability) {
        if (!map.hasLayer(layer)) {
          layer.addTo(map)
        }
      } else {
        if (map.hasLayer(layer)) {
          map.removeLayer(layer)
        }
      }
    }

    if (import.meta.env.DEV) {
      console.log('[MapLayerLifecycleAudit]', {
        event: 'terrain-suitability-sync-end',
        mcpi: selectedParcelMCPI,
        showTerrain,
        showTerrainSuitability,
        terrainSuitabilityDataPresent: hasData,
        terrainSuitabilityOverlayRefPresent: !!terrainSuitabilityLayerRef.current,
        terrainSuitabilityOverlayOnMap: !!(terrainSuitabilityLayerRef.current && map.hasLayer(terrainSuitabilityLayerRef.current)),
        terrainSuitabilityDataIdentityChanged: dataChanged,
        canvasRebuilt,
        isAnalysisRunning,
        analysisBundleIsCurrent,
        selectedAlternativeId: (conceptualProgram as any)?.alternativeId ?? null
      })
    }

    return () => {
      const currentLayer = terrainSuitabilityLayerRef.current
      if (currentLayer && map && map.hasLayer(currentLayer)) {
        map.removeLayer(currentLayer)
      }
    }
  }, [map, terrainSuitability, candidateOpenAreaGeometry, hydrologyGeometry, showTerrainSuitability])


  // Clean up all analysis layers when analysis is no longer current
  useEffect(() => {
    if (!analysisBundleIsCurrent && map) {
      // Remove all analysis layers
      if (buildingUnionLayerRef.current) {
        map.removeLayer(buildingUnionLayerRef.current)
        buildingUnionLayerRef.current = null
      }
      if (roadCorridorLayerRef.current) {
        map.removeLayer(roadCorridorLayerRef.current)
        roadCorridorLayerRef.current = null
      }
      if (candidateOpenAreaLayerRef.current) {
        map.removeLayer(candidateOpenAreaLayerRef.current)
        candidateOpenAreaLayerRef.current = null
      }
      if (hydrologyLayerRef.current) {
        map.removeLayer(hydrologyLayerRef.current)
        hydrologyLayerRef.current = null
      }
      if (pavementLayerRef.current) {
        map.removeLayer(pavementLayerRef.current)
        pavementLayerRef.current = null
      }
    }
  }, [analysisBundleIsCurrent, map])

  // Clean up proposed road layers when the conceptual result is no longer valid
  useEffect(() => {
    if (!conceptualRoadResult && map) {
      if (proposedResidualAreaLayerRef.current) {
        map.removeLayer(proposedResidualAreaLayerRef.current)
        proposedResidualAreaLayerRef.current = null
      }
      if (proposedRightOfWayLayerRef.current) {
        map.removeLayer(proposedRightOfWayLayerRef.current)
        proposedRightOfWayLayerRef.current = null
      }
      if (proposedRoadCenterlineLayerRef.current) {
        map.removeLayer(proposedRoadCenterlineLayerRef.current)
        proposedRoadCenterlineLayerRef.current = null
      }
      if (proposedAccessPointLayerRef.current) {
        map.removeLayer(proposedAccessPointLayerRef.current)
        proposedAccessPointLayerRef.current = null
      }
    }
  }, [conceptualRoadResult, map])

  // Render or update proposed road skeleton layers when a new result arrives
  useEffect(() => {
    if (!conceptualRoadResult || !map || conceptualRoadResult.status === 'failed') {
      return
    }

    const centerline = conceptualRoadResult.proposedRoadCenterline
    const rightOfWay = conceptualRoadResult.proposedRightOfWay
    const residual = conceptualRoadResult.residualDevelopmentArea
    const accessPoint = conceptualRoadResult.proposedAccessPoint

    // Remove stale proposed layers before building new ones
    if (proposedResidualAreaLayerRef.current) {
      map.removeLayer(proposedResidualAreaLayerRef.current)
      proposedResidualAreaLayerRef.current = null
    }
    if (proposedRightOfWayLayerRef.current) {
      map.removeLayer(proposedRightOfWayLayerRef.current)
      proposedRightOfWayLayerRef.current = null
    }
    if (proposedRoadCenterlineLayerRef.current) {
      map.removeLayer(proposedRoadCenterlineLayerRef.current)
      proposedRoadCenterlineLayerRef.current = null
    }
    if (proposedAccessPointLayerRef.current) {
      map.removeLayer(proposedAccessPointLayerRef.current)
      proposedAccessPointLayerRef.current = null
    }

    setShowProposedResidualArea(true)
    setShowProposedRightOfWay(true)
    setShowProposedRoadCenterline(true)
    setShowProposedAccessPoint(true)

    if (residual) {
      const layer = L.geoJSON(residual as any, {
        style: PROPOSED_RESIDUAL_AREA_STYLE,
        pane: 'proposedResidualAreaPane',
        interactive: false
      })
      if (showProposedResidualArea) layer.addTo(map)
      proposedResidualAreaLayerRef.current = layer
    }

    if (rightOfWay) {
      const layer = L.geoJSON(rightOfWay as any, {
        style: PROPOSED_RIGHT_OF_WAY_STYLE,
        pane: 'proposedRightOfWayPane',
        interactive: false
      })
      if (showProposedRightOfWay) layer.addTo(map)
      proposedRightOfWayLayerRef.current = layer
    }

    if (centerline) {
      const layer = L.geoJSON(centerline as any, {
        style: PROPOSED_ROAD_CENTERLINE_STYLE,
        pane: 'proposedRoadCenterlinePane',
        interactive: false
      })
      if (showProposedRoadCenterline) layer.addTo(map)
      layer.bringToFront()
      proposedRoadCenterlineLayerRef.current = layer
    }

    if (accessPoint && accessPoint.geometry) {
      const [lng, lat] = accessPoint.geometry.coordinates
      const marker = L.circleMarker([lat, lng], {
        ...PROPOSED_ACCESS_POINT_STYLE,
        radius: 6,
        pane: 'proposedAccessPointPane'
      })
      if (showProposedAccessPoint) marker.addTo(map)
      marker.bringToFront()
      proposedAccessPointLayerRef.current = marker
    }

    if (VERBOSE_GIS_DIAGNOSTICS) {
      console.log('[Map] Rendered proposed road layers', {
        runId: conceptualRoadResult.generationRunId,
        hasResidual: !!residual,
        hasRightOfWay: !!rightOfWay,
        hasCenterline: !!centerline,
        hasAccessPoint: !!accessPoint
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conceptualRoadResult, map])

  // Toggle proposed residual area visibility
  useEffect(() => {
    if (!proposedResidualAreaLayerRef.current) return
    if (showProposedResidualArea) {
      proposedResidualAreaLayerRef.current.addTo(map)
    } else {
      proposedResidualAreaLayerRef.current.removeFrom(map)
    }
  }, [showProposedResidualArea, map])

  // Toggle proposed right-of-way visibility
  useEffect(() => {
    if (!proposedRightOfWayLayerRef.current) return
    if (showProposedRightOfWay) {
      proposedRightOfWayLayerRef.current.addTo(map)
    } else {
      proposedRightOfWayLayerRef.current.removeFrom(map)
    }
  }, [showProposedRightOfWay, map])

  // Toggle proposed road centerline visibility
  useEffect(() => {
    if (!proposedRoadCenterlineLayerRef.current) return
    if (showProposedRoadCenterline) {
      proposedRoadCenterlineLayerRef.current.addTo(map)
    } else {
      proposedRoadCenterlineLayerRef.current.removeFrom(map)
    }
  }, [showProposedRoadCenterline, map])

  // Toggle proposed access point visibility
  useEffect(() => {
    if (!proposedAccessPointLayerRef.current) return
    if (showProposedAccessPoint) {
      proposedAccessPointLayerRef.current.addTo(map)
    } else {
      proposedAccessPointLayerRef.current.removeFrom(map)
    }
  }, [showProposedAccessPoint, map])

  // Render or update secondary road network layers
  useEffect(() => {
    if (!secondaryRoadNetworkResult || !map || secondaryRoadNetworkResult.status !== 'generated') {
      if (secondaryRoadCenterlineLayerRef.current) {
        map?.removeLayer(secondaryRoadCenterlineLayerRef.current)
        secondaryRoadCenterlineLayerRef.current = null
      }
      if (secondaryRoadRightOfWayLayerRef.current) {
        map?.removeLayer(secondaryRoadRightOfWayLayerRef.current)
        secondaryRoadRightOfWayLayerRef.current = null
      }
      return
    }

    const centerlineFeatures = secondaryRoadNetworkResult.roads
      .map((r) => r.centerlineGeometry)
      .filter((g): g is GeoJSON.Feature<GeoJSON.LineString> => !!g && !!g.geometry)
    const rowFeatures = secondaryRoadNetworkResult.roads
      .map((r) => r.rightOfWayGeometry)
      .filter((g): g is GeoJSON.Feature<GeoJSON.Geometry> => !!g && !!g.geometry)

    if (secondaryRoadCenterlineLayerRef.current) map.removeLayer(secondaryRoadCenterlineLayerRef.current)
    if (secondaryRoadRightOfWayLayerRef.current) map.removeLayer(secondaryRoadRightOfWayLayerRef.current)

    if (centerlineFeatures.length > 0) {
      const centerlineLayer = L.geoJSON(centerlineFeatures as any, {
        style: SECONDARY_CENTERLINE_STYLE,
        pane: 'secondaryRoadCenterlinePane',
        interactive: false
      })
      if (showSecondaryCenterline) centerlineLayer.addTo(map)
      secondaryRoadCenterlineLayerRef.current = centerlineLayer
    }

    if (rowFeatures.length > 0) {
      const rowLayer = L.geoJSON(rowFeatures as any, {
        style: SECONDARY_RIGHT_OF_WAY_STYLE,
        pane: 'secondaryRoadRightOfWayPane',
        interactive: false
      })
      if (showSecondaryRightOfWay) rowLayer.addTo(map)
      secondaryRoadRightOfWayLayerRef.current = rowLayer
    }
  }, [secondaryRoadNetworkResult, map])

  // Toggle secondary centerline visibility
  useEffect(() => {
    if (!secondaryRoadCenterlineLayerRef.current || !map) return
    if (showSecondaryCenterline) {
      if (!map.hasLayer(secondaryRoadCenterlineLayerRef.current)) {
        secondaryRoadCenterlineLayerRef.current.addTo(map)
      }
    } else {
      if (map.hasLayer(secondaryRoadCenterlineLayerRef.current)) {
        map.removeLayer(secondaryRoadCenterlineLayerRef.current)
      }
    }
  }, [showSecondaryCenterline, map])

  // Toggle secondary right-of-way visibility
  useEffect(() => {
    if (!secondaryRoadRightOfWayLayerRef.current || !map) return
    if (showSecondaryRightOfWay) {
      if (!map.hasLayer(secondaryRoadRightOfWayLayerRef.current)) {
        secondaryRoadRightOfWayLayerRef.current.addTo(map)
      }
    } else {
      if (map.hasLayer(secondaryRoadRightOfWayLayerRef.current)) {
        map.removeLayer(secondaryRoadRightOfWayLayerRef.current)
      }
    }
  }, [showSecondaryRightOfWay, map])

  // Render or update development opportunity blocks
  useEffect(() => {
    if (!map) return

    if (developmentOpportunityBlockLayerRef.current) {
      map.removeLayer(developmentOpportunityBlockLayerRef.current)
      developmentOpportunityBlockLayerRef.current = null
    }

    if (!developmentOpportunityBlockResult || developmentOpportunityBlockResult.blockCount === 0) {
      return
    }

    const features = developmentOpportunityBlockResult.blocks
      .filter((b: DevelopmentOpportunityBlock) => b.geometry && b.geometry.geometry)
      .map((b: DevelopmentOpportunityBlock) => ({
        ...b.geometry,
        properties: { ...b.geometry.properties, classification: b.classification, rank: b.rank }
      }))

    if (features.length === 0) return

    const layer = L.geoJSON(features as any, {
      style: (feature: any) => {
        const classification = feature?.properties?.classification || 'RESIDUAL'
        return DEVELOPMENT_OPPORTUNITY_STYLES[classification] || DEVELOPMENT_OPPORTUNITY_STYLES.RESIDUAL
      },
      pane: 'developmentOpportunityPane',
      interactive: false
    })

    developmentOpportunityBlockLayerRef.current = layer
    if (showDevelopmentOpportunity) layer.addTo(map)
  }, [developmentOpportunityBlockResult, map])

  // Toggle development opportunity block visibility
  useEffect(() => {
    if (!developmentOpportunityBlockLayerRef.current || !map) return
    if (showDevelopmentOpportunity) {
      if (!map.hasLayer(developmentOpportunityBlockLayerRef.current)) {
        developmentOpportunityBlockLayerRef.current.addTo(map)
      }
    } else {
      if (map.hasLayer(developmentOpportunityBlockLayerRef.current)) {
        map.removeLayer(developmentOpportunityBlockLayerRef.current)
      }
    }
  }, [showDevelopmentOpportunity, map])

  // Handle development zone overlay (A. Geometry creation lifecycle)
  useEffect(() => {
    if (!map) return

    if (developmentZoneLayerRef.current) {
      map.removeLayer(developmentZoneLayerRef.current)
      developmentZoneLayerRef.current = null
    }

    if (!analysisBundleIsCurrent || !conceptualProgram || conceptualProgram.zoneCount === 0) {
      return
    }

    const features = conceptualProgram.zones
      .filter((z) => z.geometry && z.geometry.geometry)
      .map((z) => ({
        ...z.geometry,
        properties: { ...z.geometry.properties, roadRelationship: z.roadRelationship, bestCompatibility: z.bestCompatibility }
      }))

    if (features.length === 0) return

    const layer = L.geoJSON(features as any, {
      style: (feature: any) => {
        const relationship = feature?.properties?.roadRelationship || 'LATENT'
        return DEVELOPMENT_ZONE_STYLES[relationship] || DEVELOPMENT_ZONE_STYLES.LATENT
      },
      pane: 'developmentZonesPane',
      interactive: false
    })

    developmentZoneLayerRef.current = layer
    if (VERBOSE_GIS_DIAGNOSTICS) {
      console.log('[DevelopmentZonesMap]', {
        mcpi: conceptualProgram.mcpi,
        resultExists: !!conceptualProgram,
        zoneCount: conceptualProgram.zoneCount,
        geometryCount: features.length,
        classifications: conceptualProgram.zones.reduce((acc: Record<string, number>, z) => {
          acc[z.opportunityClass] = (acc[z.opportunityClass] || 0) + 1
          return acc
        }, {}),
        visible: showDevelopmentZones,
        pane: 'developmentZonesPane'
      })
    }
    if (showDevelopmentZones) layer.addTo(map)
  }, [conceptualProgram, map, analysisBundleIsCurrent])

  // Toggle development zone visibility
  useEffect(() => {
    if (!developmentZoneLayerRef.current || !map) return
    if (showDevelopmentZones) {
      if (!map.hasLayer(developmentZoneLayerRef.current)) {
        developmentZoneLayerRef.current.addTo(map)
      }
    } else {
      if (map.hasLayer(developmentZoneLayerRef.current)) {
        map.removeLayer(developmentZoneLayerRef.current)
      }
    }
  }, [showDevelopmentZones, map])

  // Render or update conceptual layout layers
  useEffect(() => {
    if (!map) return

    if (conceptualLotsLayerRef.current) {
      map.removeLayer(conceptualLotsLayerRef.current)
      conceptualLotsLayerRef.current = null
    }
    if (buildingEnvelopesLayerRef.current) {
      map.removeLayer(buildingEnvelopesLayerRef.current)
      buildingEnvelopesLayerRef.current = null
    }
    if (developmentPadsLayerRef.current) {
      map.removeLayer(developmentPadsLayerRef.current)
      developmentPadsLayerRef.current = null
    }

    if (!analysisBundleIsCurrent || !conceptualLayout || conceptualLayout.status !== 'generated') {
      return
    }

    if (conceptualLayout.lotCells.length > 0) {
      const lots = conceptualLayout.lotCells.map((l) => ({
        ...l.geometry,
        properties: { id: l.id, useType: l.useType, areaAcres: l.areaAcres, targetLotAreaSqFt: l.targetLotAreaSqFt, roadRelationship: l.roadRelationship }
      }))
      const layer = L.geoJSON({ type: 'FeatureCollection', features: lots } as any, {
        style: CONCEPTUAL_LOT_STYLE,
        pane: 'conceptualLotsPane',
        onEachFeature: (feature, layer) => {
          layer.bindTooltip(`<div style="font-size:12px;line-height:1.4"><strong>${feature.properties.useType} lot</strong><br/>ID: ${feature.properties.id}<br/>Area: ${feature.properties.areaAcres.toFixed(2)} ac<br/>Target: ${feature.properties.targetLotAreaSqFt.toLocaleString()} sqft<br/>${feature.properties.roadRelationship}</div>`)
        }
      })
      if (showConceptualLots) layer.addTo(map)
      conceptualLotsLayerRef.current = layer
    }

    if (conceptualLayout.buildingEnvelopes.length > 0) {
      const envelopes = conceptualLayout.buildingEnvelopes.map((e) => ({
        ...e.geometry,
        properties: { id: e.id, parentLotId: e.parentLotId, areaAcres: e.areaAcres }
      }))
      const layer = L.geoJSON({ type: 'FeatureCollection', features: envelopes } as any, {
        style: BUILDING_ENVELOPE_STYLE,
        pane: 'buildingEnvelopesPane',
        onEachFeature: (feature, layer) => {
          layer.bindTooltip(`<div style="font-size:12px;line-height:1.4"><strong>Building envelope</strong><br/>ID: ${feature.properties.id}<br/>Area: ${feature.properties.areaAcres.toFixed(3)} ac</div>`)
        }
      })
      if (showBuildingEnvelopes) layer.addTo(map)
      buildingEnvelopesLayerRef.current = layer
    }

    if (conceptualLayout.developmentPads.length > 0) {
      const pads = conceptualLayout.developmentPads.map((p) => ({
        ...p.geometry,
        properties: { id: p.id, useType: p.useType, areaAcres: p.areaAcres, estimatedUnits: p.estimatedUnits, roadRelationship: p.roadRelationship, terrain: p.terrain, compatibility: p.compatibility }
      }))
      const layer = L.geoJSON({ type: 'FeatureCollection', features: pads } as any, {
        style: (feature: any) => DEVELOPMENT_PAD_STYLES[feature?.properties?.useType] || DEVELOPMENT_PAD_STYLES.default,
        pane: 'developmentPadsPane',
        onEachFeature: (feature, layer) => {
          layer.bindTooltip(`<div style="font-size:12px;line-height:1.4"><strong>${feature.properties.useType} pad</strong><br/>ID: ${feature.properties.id}<br/>Area: ${feature.properties.areaAcres.toFixed(2)} ac<br/>Est. units: ${feature.properties.estimatedUnits}<br/>Road: ${feature.properties.roadRelationship}<br/>Terrain: ${feature.properties.terrain}</div>`)
        }
      })
      if (showDevelopmentPads) layer.addTo(map)
      developmentPadsLayerRef.current = layer
    }
  }, [conceptualLayout, map, analysisBundleIsCurrent])

  // Layout map-layer diagnostics
  useEffect(() => {
    if (!import.meta.env.DEV) return
    
  }, [conceptualLayout, showConceptualLots, showBuildingEnvelopes, showDevelopmentPads, map, selectedParcelMCPI])

  // Toggle conceptual lots visibility
  useEffect(() => {
    if (!conceptualLotsLayerRef.current || !map) return
    if (showConceptualLots) {
      if (!map.hasLayer(conceptualLotsLayerRef.current)) {
        conceptualLotsLayerRef.current.addTo(map)
      }
    } else {
      if (map.hasLayer(conceptualLotsLayerRef.current)) {
        map.removeLayer(conceptualLotsLayerRef.current)
      }
    }
  }, [showConceptualLots, map])

  // Toggle building envelopes visibility
  useEffect(() => {
    if (!buildingEnvelopesLayerRef.current || !map) return
    if (showBuildingEnvelopes) {
      if (!map.hasLayer(buildingEnvelopesLayerRef.current)) {
        buildingEnvelopesLayerRef.current.addTo(map)
      }
    } else {
      if (map.hasLayer(buildingEnvelopesLayerRef.current)) {
        map.removeLayer(buildingEnvelopesLayerRef.current)
      }
    }
  }, [showBuildingEnvelopes, map])

  // Toggle development pads visibility
  useEffect(() => {
    if (!developmentPadsLayerRef.current || !map) return
    if (showDevelopmentPads) {
      if (!map.hasLayer(developmentPadsLayerRef.current)) {
        developmentPadsLayerRef.current.addTo(map)
      }
    } else {
      if (map.hasLayer(developmentPadsLayerRef.current)) {
        map.removeLayer(developmentPadsLayerRef.current)
      }
    }
  }, [showDevelopmentPads, map])

  // Handle selected parcel - pan to keep visible (don't auto-zoom excessively)
  useEffect(() => {
    if (selectedParcel && selectedParcel.geometry) {
      // Only pan enough to keep the parcel visible beside the sidebar
      const bounds = L.geoJSON(selectedParcel as any).getBounds()
      map.panTo(bounds.getCenter())
    }
  }, [selectedParcelId, map])

  // Handle map movement and parcel loading
  useEffect(() => {
    const handleMoveEnd = () => {
      const currentZoom = map.getZoom()
      setZoom(currentZoom)
      
      if (onZoomChange) {
        onZoomChange(currentZoom)
      }

      // Clear previous debounce
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }

      // Load parcels at zoom level 15 or greater only if general parcel outlines are enabled
      if (currentZoom >= 15 && showGeneralParcelOutlines) {
        // Debounce the parcel fetch
        debounceRef.current = setTimeout(() => {
          loadParcels(map.getBounds())
        }, 300)
      } else {
        // Clear outline layer when zooming out or when general parcel outlines are disabled
        if (availableParcelsLayerRef.current) {
          map.removeLayer(availableParcelsLayerRef.current)
          availableParcelsLayerRef.current = null
        }
        setParcelCount(0)
        setLoadingParcels(false)
      }
    }

    map.on('moveend', handleMoveEnd)

    // Initial load
    if (map.getZoom() >= 15 && showGeneralParcelOutlines) {
      handleMoveEnd()
    }

    return () => {
      map.off('moveend', handleMoveEnd)
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [map, onZoomChange, showGeneralParcelOutlines])

  const loadParcels = async (bounds: L.LatLngBounds) => {
    // Cancel any ongoing request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    abortControllerRef.current = new AbortController()
    setLoadingParcels(true)

    try {
      let allFeatures: any[] = []
      let offset = 0
      let hasMore = true
      let pageCount = 0

      while (hasMore) {
        pageCount++
        const result = await fetchParcesInBounds(bounds, offset)
        
        allFeatures = [...allFeatures, ...result.features]
        
        if (result.exceededLimit) {
          offset += 2000
        } else {
          hasMore = false
        }
      }

      // Verify valid GeoJSON features
      const validGeoJSONFeatures = allFeatures.filter(f =>
        f.geometry &&
        (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') &&
        f.geometry.coordinates &&
        f.geometry.coordinates.length > 0
      )

      setParcelCount(allFeatures.length)

      // Remove previous available outline layer
      if (availableParcelsLayerRef.current) {
        map.removeLayer(availableParcelsLayerRef.current)
        availableParcelsLayerRef.current = null
      }

      // Create new imperative outline layer
      if (validGeoJSONFeatures.length > 0) {
        const outlineLayer = L.geoJSON(
          { type: 'FeatureCollection', features: validGeoJSONFeatures } as any,
          {
            style: PARCEL_BOUNDARY_STYLE,
            pane: 'parcelPane',
            interactive: false
          }
        ).addTo(map)

        availableParcelsLayerRef.current = outlineLayer

        
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        console.error('Failed to load parcels:', error)
      }
    } finally {
      setLoadingParcels(false)
    }
  }

  // Bring selected parcel to front when it changes
  useEffect(() => {
    if (selectedParcelLayerRef.current) {
      selectedParcelLayerRef.current.bringToFront()
    }
  }, [selectedParcel])

  // Handle local street network data
  useEffect(() => {
    if (!map) return

    if (localStreetCenterlinesLayerRef.current) {
      map.removeLayer(localStreetCenterlinesLayerRef.current)
      localStreetCenterlinesLayerRef.current = null
    }

    if (localStreetRowsLayerRef.current) {
      map.removeLayer(localStreetRowsLayerRef.current)
      localStreetRowsLayerRef.current = null
    }

    if (!localStreetNetworkResult || localStreetNetworkResult.localStreetCount === 0) {
      return
    }

    const centerlineLayer = L.geoJSON(localStreetCenterlines as any, {
      style: LOCAL_STREET_CENTERLINE_STYLE,
      pane: 'localStreetCenterlinesPane',
      interactive: false
    })

    const rowLayer = L.geoJSON(localStreetRows as any, {
      style: LOCAL_STREET_ROW_STYLE,
      pane: 'localStreetRowsPane',
      interactive: false
    })

    localStreetCenterlinesLayerRef.current = centerlineLayer
    localStreetRowsLayerRef.current = rowLayer

    if (showLocalStreetCenterlines) {
      centerlineLayer.addTo(map)
    }
    if (showLocalStreetRows) {
      rowLayer.addTo(map)
    }

    return () => {
      if (map.hasLayer(centerlineLayer)) {
        map.removeLayer(centerlineLayer)
      }
      if (map.hasLayer(rowLayer)) {
        map.removeLayer(rowLayer)
      }
    }
  }, [map, localStreetNetworkResult, showLocalStreetCenterlines, showLocalStreetRows])

  // Toggle local street centerline visibility
  useEffect(() => {
    if (!localStreetCenterlinesLayerRef.current || !map) return

    if (showLocalStreetCenterlines) {
      if (!map.hasLayer(localStreetCenterlinesLayerRef.current)) {
        localStreetCenterlinesLayerRef.current.addTo(map)
      }
    } else {
      if (map.hasLayer(localStreetCenterlinesLayerRef.current)) {
        map.removeLayer(localStreetCenterlinesLayerRef.current)
      }
    }
  }, [showLocalStreetCenterlines, map])

  // Toggle local street ROW visibility
  useEffect(() => {
    if (!localStreetRowsLayerRef.current || !map) return

    if (showLocalStreetRows) {
      if (!map.hasLayer(localStreetRowsLayerRef.current)) {
        localStreetRowsLayerRef.current.addTo(map)
      }
    } else {
      if (map.hasLayer(localStreetRowsLayerRef.current)) {
        map.removeLayer(localStreetRowsLayerRef.current)
      }
    }
  }, [showLocalStreetRows, map])

  // Handle townhome row and unit data
  useEffect(() => {
    if (!map) return

    if (townhomeRowsLayerRef.current) {
      map.removeLayer(townhomeRowsLayerRef.current)
      townhomeRowsLayerRef.current = null
    }
    if (townhomeUnitsLayerRef.current) {
      map.removeLayer(townhomeUnitsLayerRef.current)
      townhomeUnitsLayerRef.current = null
    }

    const result = conceptualLayout?.townhomeGenerationResult
    if (!result || result.rowCount === 0) {
      return
    }

    const rowLayer = L.geoJSON(townhomeRows as any, {
      style: TOWNHOME_ROW_STYLE,
      pane: 'townhomeRowsPane',
      interactive: false
    })

    const unitLayer = L.geoJSON(townhomeUnits as any, {
      style: TOWNHOME_UNIT_STYLE,
      pane: 'townhomeUnitsPane',
      interactive: false
    })

    townhomeRowsLayerRef.current = rowLayer
    townhomeUnitsLayerRef.current = unitLayer

    if (showTownhomeRows) {
      rowLayer.addTo(map)
    }
    if (showTownhomeUnits) {
      unitLayer.addTo(map)
    }

    return () => {
      if (map.hasLayer(rowLayer)) map.removeLayer(rowLayer)
      if (map.hasLayer(unitLayer)) map.removeLayer(unitLayer)
    }
  }, [map, conceptualLayout, townhomeRows, townhomeUnits, showTownhomeRows, showTownhomeUnits])

  // Toggle townhome row visibility
  useEffect(() => {
    if (!townhomeRowsLayerRef.current || !map) return

    if (showTownhomeRows) {
      if (!map.hasLayer(townhomeRowsLayerRef.current)) {
        townhomeRowsLayerRef.current.addTo(map)
      }
    } else {
      if (map.hasLayer(townhomeRowsLayerRef.current)) {
        map.removeLayer(townhomeRowsLayerRef.current)
      }
    }
  }, [showTownhomeRows, map])

  // Toggle townhome unit visibility
  useEffect(() => {
    if (!townhomeUnitsLayerRef.current || !map) return

    if (showTownhomeUnits) {
      if (!map.hasLayer(townhomeUnitsLayerRef.current)) {
        townhomeUnitsLayerRef.current.addTo(map)
      }
    } else {
      if (map.hasLayer(townhomeUnitsLayerRef.current)) {
        map.removeLayer(townhomeUnitsLayerRef.current)
      }
    }
  }, [showTownhomeUnits, map])

  useEffect(() => {
    if (!map || !analysisBundleIsCurrent) return
    mapRenderPerformance.start()
    mapRenderPerformance.setFeatureCounts({
      existingBuildings: existingConditions?.buildings?.length ?? 0,
      nearbyStreets: existingConditions?.nearbyStreets?.length ?? 0,
      buildingUnion: buildingUnionGeometry ? 1 : 0,
      roadCorridor: roadCorridorGeometry ? 1 : 0,
      candidateOpenArea: candidateOpenAreaGeometry ? 1 : 0,
      hydrology: hydrologyGeometry ? 1 : 0,
      pavement: pavementGeometry ? 1 : 0,
      terrainContours: terrainData?.contourCount ?? 0,
      primaryRoadCenterline: conceptualRoadResult?.proposedRoadCenterline ? 1 : 0,
      primaryRoadRow: conceptualRoadResult?.proposedRightOfWay ? 1 : 0,
      secondaryRoads: secondaryRoadNetworkResult?.roads?.length ?? 0,
      localStreets: localStreetNetworkResult?.localStreetCount ?? 0,
      developmentOpportunityBlocks: developmentOpportunityBlockResult?.blockCount ?? 0,
      conceptualLots: conceptualLayout?.lotCount ?? 0,
      buildingEnvelopes: conceptualLayout?.buildingEnvelopeCount ?? 0,
      developmentPads: conceptualLayout?.developmentPadCount ?? 0,
      townhomeRows: conceptualLayout?.townhomeGenerationResult?.rowCount ?? 0,
      townhomeUnits: conceptualLayout?.townhomeGenerationResult?.unitCount ?? 0
    })
    const id = requestAnimationFrame(() => { mapRenderPerformance.finish() })
    return () => cancelAnimationFrame(id)
  }, [
    map,
    analysisBundleIsCurrent,
    existingConditions,
    buildingUnionGeometry,
    roadCorridorGeometry,
    candidateOpenAreaGeometry,
    hydrologyGeometry,
    pavementGeometry,
    terrainData,
    conceptualRoadResult,
    secondaryRoadNetworkResult,
    localStreetNetworkResult,
    developmentOpportunityBlockResult,
    conceptualLayout
  ])

  // Terrain-analysis view mode: de-emphasize competing layers while terrain
  // suitability is ON, then restore their original styles when it is OFF.
  // Placed after all layer creation effects so new layers receive the current
  // dim/restore state immediately when they are built.
  useEffect(() => {
    if (!map) return

    const dim = showTerrainSuitability

    const dimFill = (base: L.PathOptions, target: number): L.PathOptions => ({
      ...base,
      fillOpacity: target,
      opacity: base.opacity !== undefined ? Math.min(base.opacity as number, 0.8) : base.opacity
    })

    candidateOpenAreaLayerRef.current?.setStyle(
      dim
        ? { fillOpacity: 0, fill: false, stroke: true, color: '#8ED8C0', weight: 2, opacity: 0.8, interactive: false }
        : CANDIDATE_OPEN_AREA_STYLE
    )

    existingBuildingsLayerRef.current?.eachLayer((layer: any) => {
      const base = getBuildingStyle(layer.feature)
      layer.setStyle(dim ? dimFill(base, 0.08) : base)
    })
    buildingUnionLayerRef.current?.setStyle(dim ? dimFill(BUILDING_STYLE, 0.10) : BUILDING_STYLE)
    roadCorridorLayerRef.current?.setStyle(dim ? dimFill(ROAD_CORRIDOR_STYLE, 0.10) : ROAD_CORRIDOR_STYLE)
    hydrologyLayerRef.current?.setStyle(dim ? dimFill(HYDROLOGY_STYLE, 0.08) : HYDROLOGY_STYLE)
    pavementLayerRef.current?.eachLayer((layer: any) => {
      const base = getPavementStyle(layer.feature)
      layer.setStyle(dim ? dimFill(base, 0.10) : base)
    })

    proposedResidualAreaLayerRef.current?.setStyle(
      dim ? dimFill(PROPOSED_RESIDUAL_AREA_STYLE, 0.06) : PROPOSED_RESIDUAL_AREA_STYLE
    )
    proposedRightOfWayLayerRef.current?.setStyle(
      dim ? dimFill(PROPOSED_RIGHT_OF_WAY_STYLE, 0.08) : PROPOSED_RIGHT_OF_WAY_STYLE
    )
    proposedRoadCenterlineLayerRef.current?.setStyle(
      dim
        ? { ...PROPOSED_ROAD_CENTERLINE_STYLE, opacity: 0.55, weight: 2.5 }
        : PROPOSED_ROAD_CENTERLINE_STYLE
    )

    secondaryRoadCenterlineLayerRef.current?.setStyle(
      dim
        ? { ...SECONDARY_CENTERLINE_STYLE, opacity: 0.7, weight: 2.5 }
        : SECONDARY_CENTERLINE_STYLE
    )
    secondaryRoadRightOfWayLayerRef.current?.setStyle(
      dim ? dimFill(SECONDARY_RIGHT_OF_WAY_STYLE, 0.08) : SECONDARY_RIGHT_OF_WAY_STYLE
    )

    localStreetCenterlinesLayerRef.current?.setStyle(
      dim
        ? { ...LOCAL_STREET_CENTERLINE_STYLE, opacity: 0.6, weight: 1.5 }
        : LOCAL_STREET_CENTERLINE_STYLE
    )
    localStreetRowsLayerRef.current?.setStyle(
      dim ? dimFill(LOCAL_STREET_ROW_STYLE, 0.08) : LOCAL_STREET_ROW_STYLE
    )

    developmentOpportunityBlockLayerRef.current?.setStyle((feature: any) => {
      const classification = feature?.properties?.classification ?? 'RESIDUAL'
      const base = DEVELOPMENT_OPPORTUNITY_STYLES[classification] || DEVELOPMENT_OPPORTUNITY_STYLES.RESIDUAL
      const dimmed: L.PathOptions = { ...base, fillOpacity: classification === 'HIGH' ? 0.10 : classification === 'MODERATE' ? 0.08 : classification === 'LOW' ? 0.06 : 0.04 }
      return dim ? dimmed : base
    })

    developmentZoneLayerRef.current?.setStyle((feature: any) => {
      const relationship = feature?.properties?.relationship ?? 'LATENT'
      const base = DEVELOPMENT_ZONE_STYLES[relationship] || DEVELOPMENT_ZONE_STYLES.LATENT
      const dimmed: L.PathOptions = { ...base, fillOpacity: relationship === 'PRIMARY_FRONTAGE' ? 0.10 : relationship === 'SECONDARY_FRONTAGE' ? 0.08 : relationship === 'NEAR_NETWORK' ? 0.06 : 0.03 }
      return dim ? dimmed : base
    })

    conceptualLotsLayerRef.current?.setStyle(dim ? dimFill(CONCEPTUAL_LOT_STYLE, 0.10) : CONCEPTUAL_LOT_STYLE)
    buildingEnvelopesLayerRef.current?.setStyle(dim ? dimFill(BUILDING_ENVELOPE_STYLE, 0.12) : BUILDING_ENVELOPE_STYLE)
    developmentPadsLayerRef.current?.setStyle((feature: any) => {
      const useType = feature?.properties?.useType ?? 'default'
      const base = DEVELOPMENT_PAD_STYLES[useType] || DEVELOPMENT_PAD_STYLES.default
      const dimmed: L.PathOptions = { ...base, fillOpacity: 0.10 }
      return dim ? dimmed : base
    })

    townhomeRowsLayerRef.current?.setStyle(dim ? dimFill(TOWNHOME_ROW_STYLE, 0.10) : TOWNHOME_ROW_STYLE)
    townhomeUnitsLayerRef.current?.setStyle(dim ? dimFill(TOWNHOME_UNIT_STYLE, 0.08) : TOWNHOME_UNIT_STYLE)
  }, [showTerrainSuitability, map, existingConditions, buildingUnionGeometry, roadCorridorGeometry, candidateOpenAreaGeometry, hydrologyGeometry, pavementGeometry, conceptualRoadResult, secondaryRoadNetworkResult, localStreetNetworkResult, developmentOpportunityBlockResult, conceptualLayout, conceptualProgram])

  return (
    <>
      {/* Generation lock overlay */}
      {isRoadGenerating && (
        <div className="absolute inset-0 z-[1001] bg-[#0f172a]/60 flex flex-col items-center justify-center pointer-events-auto">
          <div className="w-12 h-12 border-4 border-[#8ED8C0] border-t-transparent rounded-full animate-spin mb-4" />
          <div className="text-[#ffffff] text-[18px] font-semibold text-center px-6">Generating feasibility concept…</div>
          <div className="text-[#cbd5e1] text-[14px] mt-2 text-center px-6">Evaluating access, road network, and conceptual development layout.</div>
        </div>
      )}

      {/* County Boundary */}
      {countyBoundary && (
        <GeoJSON
          data={countyBoundary}
          style={{
            color: '#8ED8C0',
            weight: 2,
            opacity: 0.75,
            fillOpacity: 0
          }}
          pane="countyPane"
        />
      )}

      {/* Selected Parcel (separate persistent layer) */}
      {selectedParcel && (
        <GeoJSON
          key={`selected-${selectedParcelId}`}
          data={selectedParcel as any}
          style={SELECTED_PARCEL_STYLE}
          pane="selectedParcelPane"
          interactive={false}
          ref={(ref) => {
            if (ref) {
              selectedParcelLayerRef.current = ref
              ref.bringToFront()
            }
          }}
        />
      )}

      {/* Loading parcels indicator */}
      {loadingParcels && (
        <div className="absolute bottom-4 left-4 z-[1000] bg-[#0f172a] text-[#cbd5e1] px-4 py-2 rounded-lg border border-slate-600 text-[15px] leading-[1.45]">
          Loading parcels...
        </div>
      )}

      {/* Map Legend */}
      <MapLegend 
        zoom={zoom} 
        parcelCount={parcelCount} 
        loading={loadingParcels}
        hasAnalysisLayers={!!(buildingUnionGeometry || roadCorridorGeometry || candidateOpenAreaGeometry || hydrologyGeometry || pavementGeometry)}
        showCandidateArea={showCandidateArea}
        showBuildings={showBuildings}
        showRoadCorridors={showRoadCorridors}
        showHydrology={showHydrology}
        showPavement={showPavement}
        onToggleCandidateArea={toggleCandidateArea}
        onToggleBuildings={toggleBuildings}
        onToggleRoadCorridors={toggleRoadCorridors}
        onToggleHydrology={toggleHydrology}
        onTogglePavement={togglePavement}
        hasTerrainLayers={!!(terrainData && terrainData.contours.length > 0)}
        showTerrain={showTerrain}
        onToggleTerrain={toggleTerrain}
        hasTerrainSuitabilityLayers={!!(terrainSuitability && terrainSuitability.suitabilityFeatures.features.length > 0)}
        showTerrainSuitability={showTerrainSuitability}
        onToggleTerrainSuitability={toggleTerrainSuitability}
        terrainSuitabilitySummary={terrainSuitability ? {
          preferred: terrainSuitability.preferredAreaAcres,
          moderate: terrainSuitability.moderateAreaAcres,
          challenging: terrainSuitability.challengingAreaAcres,
          avoid: terrainSuitability.avoidAreaAcres,
          insufficient: terrainSuitability.insufficientDataAreaAcres,
          dominant: terrainSuitability.dominantClass
        } : null}
        isExploreMode={showGeneralParcelOutlines}
        selectedParcelMCPI={selectedParcelMCPI}
        isAnalysisRunning={isAnalysisRunning}
        hasRoadLayers={!!(conceptualRoadResult && (conceptualRoadResult.status === 'generated' || conceptualRoadResult.status === 'warning'))}
        showProposedAccessPoint={showProposedAccessPoint}
        showProposedRoadCenterline={showProposedRoadCenterline}
        showProposedRightOfWay={showProposedRightOfWay}
        showProposedResidualArea={showProposedResidualArea}
        onToggleProposedAccessPoint={toggleProposedAccessPoint}
        onToggleProposedRoadCenterline={toggleProposedRoadCenterline}
        onToggleProposedRightOfWay={toggleProposedRightOfWay}
        onToggleProposedResidualArea={toggleProposedResidualArea}
        hasSecondaryRoadLayers={!!(secondaryRoadNetworkResult && (secondaryRoadNetworkResult.status === 'generated' || secondaryRoadNetworkResult.status === 'empty'))}
        showSecondaryCenterline={showSecondaryCenterline}
        showSecondaryRightOfWay={showSecondaryRightOfWay}
        onToggleSecondaryCenterline={toggleSecondaryCenterline}
        onToggleSecondaryRightOfWay={toggleSecondaryRightOfWay}
        hasDevelopmentOpportunityLayers={!!(developmentOpportunityBlockResult && developmentOpportunityBlockResult.blockCount > 0)}
        showDevelopmentOpportunity={showDevelopmentOpportunity}
        developmentOpportunityCounts={{
          HIGH: developmentOpportunityBlockResult?.highCount ?? 0,
          MODERATE: developmentOpportunityBlockResult?.moderateCount ?? 0,
          LOW: developmentOpportunityBlockResult?.lowCount ?? 0,
          RESIDUAL: developmentOpportunityBlockResult?.residualCount ?? 0
        }}
        onToggleDevelopmentOpportunity={toggleDevelopmentOpportunity}
        hasDevelopmentZones={!!conceptualProgram && conceptualProgram.zoneCount > 0}
        showDevelopmentZones={showDevelopmentZones}
        onToggleDevelopmentZones={toggleDevelopmentZones}
        hasDevelopmentLayout={!!conceptualLayout && (conceptualLayout.lotCount > 0 || conceptualLayout.buildingEnvelopeCount > 0 || conceptualLayout.developmentPadCount > 0)}
        conceptualLotCount={conceptualLayout?.lotCount ?? 0}
        buildingEnvelopeCount={conceptualLayout?.buildingEnvelopeCount ?? 0}
        developmentPadCount={conceptualLayout?.developmentPadCount ?? 0}
        showConceptualLots={showConceptualLots}
        showBuildingEnvelopes={showBuildingEnvelopes}
        showDevelopmentPads={showDevelopmentPads}
        onToggleConceptualLots={toggleConceptualLots}
        onToggleBuildingEnvelopes={toggleBuildingEnvelopes}
        onToggleDevelopmentPads={toggleDevelopmentPads}
        hasLocalStreetLayers={!!localStreetNetworkResult}
        localStreetCount={localStreetNetworkResult?.localStreetCount ?? 0}
        localStreetStopReason={localStreetNetworkResult?.stopReason}
        showLocalStreetCenterlines={showLocalStreetCenterlines}
        showLocalStreetRows={showLocalStreetRows}
        onToggleLocalStreetCenterlines={toggleLocalStreetCenterlines}
        onToggleLocalStreetRows={toggleLocalStreetRows}
        hasTownhomeLayers={!!conceptualLayout?.townhomeGenerationResult && conceptualLayout.townhomeGenerationResult.rowCount > 0}
        townhomeRowCount={conceptualLayout?.townhomeGenerationResult?.rowCount ?? 0}
        townhomeUnitCount={conceptualLayout?.townhomeGenerationResult?.unitCount ?? 0}
        showTownhomeRows={showTownhomeRows}
        showTownhomeUnits={showTownhomeUnits}
        onToggleTownhomeRows={toggleTownhomeRows}
        onToggleTownhomeUnits={toggleTownhomeUnits}
        redevelopmentBuildingClassification={buildingClassification}
        redevelopmentPavementClassification={pavementClassification}
      />

      {/* Parcel Click Handler for point-and-click selection */}
      <ParcelClickHandler onParcelSelected={onParcelSelect || (() => {})} />
    </>
  )
}

export default function MapComponent({ onParcelSelect, selectedParcel, onZoomChange, onMapReady, existingConditions, candidateOpenAreaGeometry, buildingUnionGeometry, roadCorridorGeometry, hydrologyGeometry, pavementGeometry, candidateOpenAreaResult = null, showGeneralParcelOutlines, selectedParcelMCPI, isAnalysisRunning, analysisBundleIsCurrent, conceptualRoadResult, secondaryRoadNetworkResult = null, localStreetNetworkResult = null, developmentOpportunityBlockResult = null, terrainData = null, terrainSuitability = null, conceptualProgram = null, conceptualLayout = null, isRoadGenerating = false }: MapComponentProps) {
  const [basemap, setBasemap] = useState<BasemapType>('osm')
  const loudounCenter: [number, number] = [39.09, -77.64]
  const loudounBounds: L.LatLngBoundsExpression = [
    [38.8443, -77.9634],
    [39.3262, -77.3240]
  ]

  return (
    <div className="w-full h-full">
      <MapContainer
        center={loudounCenter}
        zoom={10}
        bounds={loudounBounds}
        className="w-full h-full parcel-map"
        zoomControl={false}
        doubleClickZoom={false}
      >
        {/* Base map tiles */}
        <BasemapLayer basemap={basemap} />

        <MapController
          onParcelSelect={onParcelSelect}
          selectedParcel={selectedParcel}
          onZoomChange={onZoomChange}
          onMapReady={onMapReady}
          existingConditions={existingConditions}
          candidateOpenAreaGeometry={candidateOpenAreaGeometry}
          buildingUnionGeometry={buildingUnionGeometry}
          roadCorridorGeometry={roadCorridorGeometry}
          hydrologyGeometry={hydrologyGeometry}
          pavementGeometry={pavementGeometry}
          candidateOpenAreaResult={candidateOpenAreaResult}
          showGeneralParcelOutlines={showGeneralParcelOutlines}
          selectedParcelMCPI={selectedParcelMCPI}
          isAnalysisRunning={isAnalysisRunning}
          analysisBundleIsCurrent={analysisBundleIsCurrent}
          conceptualRoadResult={conceptualRoadResult}
          secondaryRoadNetworkResult={secondaryRoadNetworkResult}
          localStreetNetworkResult={localStreetNetworkResult}
          developmentOpportunityBlockResult={developmentOpportunityBlockResult}
          terrainData={terrainData}
          terrainSuitability={terrainSuitability}
          conceptualProgram={conceptualProgram}
          conceptualLayout={conceptualLayout}
          isRoadGenerating={isRoadGenerating}
        />
        <MapControls basemap={basemap} onBasemapChange={setBasemap} isRoadGenerating={isRoadGenerating} />
      </MapContainer>
    </div>
  )
}
