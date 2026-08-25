import { useState, useRef, useEffect } from 'react'
import { Play, Square, Trash2, FileJson, FileSpreadsheet, ChevronDown, ChevronRight, CheckCircle, AlertTriangle, XCircle, Clock, Loader2, Database } from 'lucide-react'
import {
  fetchParcelByMCPI,
  fetchAddressesByMCPI,
  fetchBuildingsByParcel,
  fetchIntersectingStreets,
  fetchNearbyStreets,
  getLayerMetadata,
  ParcelData,
  AddressData,
  BuildingData,
  RoadData
} from '../services/gisService'
import ThemedSelect from './ThemedSelect'

type AuditStatus = 'PASS' | 'WARNING' | 'FAIL' | 'TRUNCATED' | 'ABORTED' | 'PENDING'

interface AuditResult {
  mcpi: string
  status: AuditStatus
  parcelInfo: {
    addressCount: number
    normalizedAddresses: string[]
    normalizedAddressSummary: string
    gisAcreage: number
    legalAcreage: number
    subdivision: string
    platNumber: string
    platLot: string
    parcelType: string
    geometryType: string
    ringCount: number
    totalPointCount: number
    hasHoles: boolean
    isMultipart: boolean
  }
  buildingInfo: {
    queryState: string
    buildingCount: number
    wasTruncated: boolean
    httpStatus: number
    queryDuration: number
    errorMessage?: string
  }
  streetInfo: {
    intersectingQueryState: string
    intersectingSegmentCount: number
    uniqueIntersectingNames: string[]
    totalSegmentCountWithin100ft: number
    additionalNearbyCount: number
    uniqueNamesWithin100ft: string[]
    wasTruncated: boolean
    httpStatuses: number[]
    queryDurations: number[]
    errorMessages: string[]
  }
  generalInfo: {
    totalAnalysisDuration: number
    warnings: string[]
    errors: string[]
  }
  fixtureMatch?: {
    expectedBuildings?: number
    actualBuildings?: number
    expectedIntersectingStreets?: number
    actualIntersectingStreets?: number
    expectedTotalStreets?: number
    actualTotalStreets?: number
    expectedAdditionalStreets?: number
    actualAdditionalStreets?: number
    expectedAddress?: string
    actualAddress?: string
    addressMatch?: boolean
    overallMatch?: boolean
  }
}

interface FixtureTest {
  mcpi: string
  expected: {
    buildings: number
    intersectingStreets: number
    totalStreetsWithin100ft: number
    additionalNearbyStreets: number
    address?: string
  }
}

interface PilotMetadata {
  seed: number
  timestamp: string
  totalParcels: number
  controlParcels: number
  newParcels: number
  stratifiedParcels: number
  geometryComplexityParcels: number
  geographicBands: number[]
  acreageClasses: string[]
  geometryCandidateReason?: string
  geometryCandidateMcpi?: string
  candidatePoolSize: number
  skippedCandidates: number
  candidateDiagnostics?: {
    requestsAttempted: number
    httpStatuses: number[]
    arcgisErrors: any[]
    featuresReturned: number
    responseFormat: string
    validMCPIs: number
    featuresWithGeometry: number
    duplicates: number
    blankMCPIs: number
    uniqueValidCollected: number
    lastOffset: number
  }
  unavailableCombinations: string[]
  errorCombinations: string[]
  fallbackSelections: string[]
  diagnosticCounts: Record<string, number>
  bandAcreageMatrix: Record<string, number>
}

interface SampledParcel {
  mcpi: string
  objectId: number
  geographicBand: number
  acreageClass: string
  selectionSeed: number
  selectionOffset: number
  fallbackUsed: boolean
  sampleRole: 'verified-control' | 'stratified-pilot' | 'geometry-complexity'
  geometrySelectionReason?: string
}

type ManualReviewState = 'Pending' | 'Confirmed' | 'Needs Investigation' | 'Source Difference Accepted'

interface ManualReview {
  mcpi: string
  state: ManualReviewState
  note: string
  reviewedAt: string | null
  reasons: string[]
}

interface PersistedReviewItem {
  mcpi: string
  auditStatus: string
  reviewReasons: string[]
  gisAcreage: number
  legalAcreage: number
  acreageDiff: number
  acreagePctDiff: number
  addressCount: number
  buildingCount: number
  intersectingStreetCount: number
  totalStreetSegmentsWithin100ft: number
  geometryType: string
  ringCount: number
  totalGeometryPoints: number
  manualReviewState: ManualReviewState
  manualReviewNote: string
  reviewedAt: string | null
  isFlaggedParcel: boolean
}

const VERIFIED_FIXTURES: FixtureTest[] = [
  {
    mcpi: '060498809000',
    expected: {
      buildings: 25,
      intersectingStreets: 20,
      totalStreetsWithin100ft: 30,
      additionalNearbyStreets: 10
    }
  },
  {
    mcpi: '059476937000',
    expected: {
      buildings: 1,
      intersectingStreets: 0,
      totalStreetsWithin100ft: 6,
      additionalNearbyStreets: 6,
      address: '20851 CONESUS SQ, ASHBURN'
    }
  },
  {
    mcpi: '087390138000',
    expected: {
      buildings: 0,
      intersectingStreets: 0,
      totalStreetsWithin100ft: 1,
      additionalNearbyStreets: 1
    }
  },
  {
    mcpi: '040261613000',
    expected: {
      buildings: 0,
      intersectingStreets: 0,
      totalStreetsWithin100ft: 14,
      additionalNearbyStreets: 14
    }
  }
]

export default function AuditPage() {
  const [mcpiInput, setMcpiInput] = useState('')
  const [results, setResults] = useState<AuditResult[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [currentMcpi, setCurrentMcpi] = useState('')
  const [completedCount, setCompletedCount] = useState(0)
  const [totalCount, setTotalCount] = useState(0)
  const [expandedRow, setExpandedRow] = useState<string | null>(null)
  const [pilotMetadata, setPilotMetadata] = useState<PilotMetadata | null>(null)
  const [sampledParcels, setSampledParcels] = useState<SampledParcel[]>([])
  const [isGeneratingPilot, setIsGeneratingPilot] = useState(false)
  const [manualReviews, setManualReviews] = useState<Record<string, ManualReview>>({})
  const [persistedReviews, setPersistedReviews] = useState<Record<string, PersistedReviewItem>>({})
  const [showRestoreNotice, setShowRestoreNotice] = useState(false)
  
  const abortControllerRef = useRef<AbortController | null>(null)
  const runningRef = useRef(false)
  const runIdRef = useRef(0)
  
  const REVIEW_QUEUE_STORAGE_KEY = 'subdivmaker-v2-manual-review-queue-v1'
  
  // Load persisted review queue on mount
  useEffect(() => {
    const saved = localStorage.getItem(REVIEW_QUEUE_STORAGE_KEY)
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as Record<string, PersistedReviewItem>
        setPersistedReviews(parsed)
        // Convert persisted reviews back to ManualReview format for current use
        const manualReviews: Record<string, ManualReview> = {}
        Object.entries(parsed).forEach(([mcpi, item]) => {
          manualReviews[mcpi] = {
            mcpi: item.mcpi,
            state: item.manualReviewState,
            note: item.manualReviewNote,
            reviewedAt: item.reviewedAt,
            reasons: item.reviewReasons
          }
        })
        setManualReviews(manualReviews)
        setShowRestoreNotice(true)
      } catch (e) {
        console.error('Failed to load persisted review queue:', e)
      }
    }
  }, [])
  
  // Save persisted review queue when manual reviews change
  useEffect(() => {
    if (Object.keys(manualReviews).length > 0) {
      // Build persisted items from current results if available, otherwise use existing persisted data
      const persisted: Record<string, PersistedReviewItem> = {}
      
      Object.values(manualReviews).forEach(review => {
        const result = results.find(r => r.mcpi === review.mcpi)
        const existingPersisted = persistedReviews[review.mcpi]
        
        const gisAcreage = result?.parcelInfo.gisAcreage ?? existingPersisted?.gisAcreage ?? 0
        const legalAcreage = result?.parcelInfo.legalAcreage ?? existingPersisted?.legalAcreage ?? 0
        const acreageDiff = gisAcreage > 0 && legalAcreage > 0 ? Math.abs(gisAcreage - legalAcreage) : 0
        const acreagePctDiff = legalAcreage > 0 ? (acreageDiff / legalAcreage) * 100 : 0
        
        persisted[review.mcpi] = {
          mcpi: review.mcpi,
          auditStatus: result?.status ?? existingPersisted?.auditStatus ?? 'UNKNOWN',
          reviewReasons: review.reasons,
          gisAcreage,
          legalAcreage,
          acreageDiff,
          acreagePctDiff,
          addressCount: result?.parcelInfo.addressCount ?? existingPersisted?.addressCount ?? 0,
          buildingCount: result?.buildingInfo.buildingCount ?? existingPersisted?.buildingCount ?? 0,
          intersectingStreetCount: result?.streetInfo.intersectingSegmentCount ?? existingPersisted?.intersectingStreetCount ?? 0,
          totalStreetSegmentsWithin100ft: result?.streetInfo.totalSegmentCountWithin100ft ?? existingPersisted?.totalStreetSegmentsWithin100ft ?? 0,
          geometryType: result?.parcelInfo.geometryType ?? existingPersisted?.geometryType ?? 'Unknown',
          ringCount: result?.parcelInfo.ringCount ?? existingPersisted?.ringCount ?? 0,
          totalGeometryPoints: result?.parcelInfo.totalPointCount ?? existingPersisted?.totalGeometryPoints ?? 0,
          manualReviewState: review.state,
          manualReviewNote: review.note,
          reviewedAt: review.reviewedAt,
          isFlaggedParcel: review.reasons.some(r => r.includes('MultiPolygon') || r.includes('acreage'))
        }
      })
      
      setPersistedReviews(persisted)
      localStorage.setItem(REVIEW_QUEUE_STORAGE_KEY, JSON.stringify(persisted))
    }
  }, [manualReviews, results, persistedReviews])

  // Deterministic seeded random function (Mulberry32)
  const seededRandom = (seed: number) => {
    return function() {
      var t = seed += 0x6D2B79F5
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  const normalizeMCPIs = (input: string): string[] => {
    return input
      .split('\n')
      .map(line => line.replace(/^MCPI:\s*/i, '').trim())
      .filter(line => line.length > 0)
      .filter((line, index, self) => self.indexOf(line) === index)
  }

  const loadVerifiedParcels = () => {
    const mcpiList = VERIFIED_FIXTURES.map(f => f.mcpi).join('\n')
    setMcpiInput(mcpiList)
  }

  const generate25ParcelPilot = async () => {
    setIsGeneratingPilot(true)
    const seed = 20260730
    const rng = seededRandom(seed)
    
    // Initialize variables for error handling
    let selectedMcpis = new Set<string>()
    let sampledParcelsList: SampledParcel[] = []
    let unavailableCombinations: string[] = []
    let errorCombinations: string[] = []
    let fallbackSelections: string[] = []
    let diagnosticCounts: Record<string, number> = {}
    let bandAcreageMatrix: Record<string, number> = {}
    let candidatePoolSize = 0
    let skippedCandidates = 0
    let candidateDiagnostics: any = {
      requestsAttempted: 0,
      httpStatuses: [],
      arcgisErrors: [],
      featuresReturned: 0,
      responseFormat: 'unknown',
      validMCPIs: 0,
      featuresWithGeometry: 0,
      duplicates: 0,
      blankMCPIs: 0,
      uniqueValidCollected: 0,
      lastOffset: 0
    }
    
    try {
      // Get parcel layer metadata to confirm fields and extent
      const PARCEL_URL = '/api/loudoun/gis/rest/services/COL/pol_connect/MapServer/3'
      const layerMetadata = await getLayerMetadata(PARCEL_URL)
      
      const extent = layerMetadata.extent
      const spatialReference = extent.spatialReference || layerMetadata.spatialReference || { wkid: 4326 }
      const wkid = spatialReference.wkid
      const xmin = extent.xmin
      const xmax = extent.xmax
      const ymin = extent.ymin
      const ymax = extent.ymax
      const bandWidth = (xmax - xmin) / 5
      
      console.log('Layer Metadata:', {
        id: layerMetadata.id,
        geometryType: layerMetadata.geometryType,
        extent: { xmin, ymin, xmax, ymax },
        spatialReference: wkid,
        supportsPagination: layerMetadata.supportsPagination,
        supportsOrderBy: layerMetadata.supportsOrderBy,
        maxRecordCount: layerMetadata.maxRecordCount
      })
      
      // Acreage classes
      const acreageClasses = [
        { name: 'Tiny', where: 'PA_GIS_ACRE IS NOT NULL AND PA_GIS_ACRE < 0.25' },
        { name: 'Small', where: 'PA_GIS_ACRE >= 0.25 AND PA_GIS_ACRE < 2' },
        { name: 'Medium', where: 'PA_GIS_ACRE >= 2 AND PA_GIS_ACRE < 20' },
        { name: 'Large', where: 'PA_GIS_ACRE >= 20' }
      ]
      
      selectedMcpis = new Set<string>()
      sampledParcelsList = []
      unavailableCombinations = []
      errorCombinations = []
      fallbackSelections = []
      diagnosticCounts = {}
      
      // Diagnostic: Countywide parcel count
      try {
        const countywideParams = new URLSearchParams({
          where: '1=1',
          returnCountOnly: 'true',
          f: 'json'
        })
        const countywideResponse = await fetch(`${PARCEL_URL}/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: countywideParams
        })
        const countywideData = await countywideResponse.json()
        diagnosticCounts['Countywide'] = countywideData.count || 0
        console.log('Countywide count:', diagnosticCounts['Countywide'])
      } catch (e) {
        console.error('Countywide count error:', e)
        diagnosticCounts['Countywide'] = -1
      }
      
      // Diagnostic: Geographic band counts
      const bandCounts: number[] = []
      for (let bandIndex = 0; bandIndex < 5; bandIndex++) {
        const bandXmin = xmin + (bandIndex * bandWidth)
        const bandXmax = bandXmin + bandWidth
        const bandEnvelope = JSON.stringify({
          xmin: bandXmin,
          ymin: ymin,
          xmax: bandXmax,
          ymax: ymax,
          spatialReference: { wkid }
        })
        
        try {
          const bandParams = new URLSearchParams({
            where: '1=1',
            geometry: bandEnvelope,
            geometryType: 'esriGeometryEnvelope',
            inSR: wkid.toString(),
            spatialRel: 'esriSpatialRelIntersects',
            returnCountOnly: 'true',
            f: 'json'
          })
          const bandResponse = await fetch(`${PARCEL_URL}/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: bandParams
          })
          const bandData = await bandResponse.json()
          if (bandData.error) {
            console.error(`Band ${bandIndex + 1} error:`, bandData.error)
            bandCounts.push(-1)
          } else {
            bandCounts.push(bandData.count || 0)
            diagnosticCounts[`Band ${bandIndex + 1}`] = bandCounts[bandIndex]
            console.log(`Band ${bandIndex + 1} count:`, bandCounts[bandIndex])
          }
        } catch (e) {
          console.error(`Band ${bandIndex + 1} query error:`, e)
          bandCounts.push(-1)
          diagnosticCounts[`Band ${bandIndex + 1}`] = -1
        }
      }
      
      // Diagnostic: Band/acreage matrix
      bandAcreageMatrix = {}
      for (let bandIndex = 0; bandIndex < 5; bandIndex++) {
        const bandXmin = xmin + (bandIndex * bandWidth)
        const bandXmax = bandXmin + bandWidth
        const bandEnvelope = JSON.stringify({
          xmin: bandXmin,
          ymin: ymin,
          xmax: bandXmax,
          ymax: ymax,
          spatialReference: { wkid }
        })
        
        for (let classIndex = 0; classIndex < acreageClasses.length; classIndex++) {
          const acreageClass = acreageClasses[classIndex]
          const combinationKey = `Band ${bandIndex + 1} - ${acreageClass.name}`
          
          try {
            const params = new URLSearchParams({
              where: acreageClass.where,
              geometry: bandEnvelope,
              geometryType: 'esriGeometryEnvelope',
              inSR: wkid.toString(),
              spatialRel: 'esriSpatialRelIntersects',
              returnCountOnly: 'true',
              f: 'json'
            })
            const response = await fetch(`${PARCEL_URL}/query`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: params
            })
            const data = await response.json()
            if (data.error) {
              console.error(`${combinationKey} error:`, data.error)
              bandAcreageMatrix[combinationKey] = -1
            } else {
              bandAcreageMatrix[combinationKey] = data.count || 0
              console.log(`${combinationKey} count:`, bandAcreageMatrix[combinationKey])
            }
          } catch (e) {
            console.error(`${combinationKey} query error:`, e)
            bandAcreageMatrix[combinationKey] = -1
          }
        }
      }
      
      // Add verified controls
      for (const fixture of VERIFIED_FIXTURES) {
        selectedMcpis.add(fixture.mcpi)
        sampledParcelsList.push({
          mcpi: fixture.mcpi,
          objectId: 0,
          geographicBand: 0,
          acreageClass: 'control',
          selectionSeed: seed,
          selectionOffset: 0,
          fallbackUsed: false,
          sampleRole: 'verified-control'
        })
      }
      
      // Select stratified parcels (5 bands × 4 acreage classes = 20 parcels)
      for (let bandIndex = 0; bandIndex < 5; bandIndex++) {
        const bandXmin = xmin + (bandIndex * bandWidth)
        const bandXmax = bandXmin + bandWidth
        const bandEnvelope = JSON.stringify({
          xmin: bandXmin,
          ymin: ymin,
          xmax: bandXmax,
          ymax: ymax,
          spatialReference: { wkid }
        })
        
        for (let classIndex = 0; classIndex < acreageClasses.length; classIndex++) {
          const acreageClass = acreageClasses[classIndex]
          const combinationKey = `Band ${bandIndex + 1} - ${acreageClass.name}`
          const candidateCount = bandAcreageMatrix[combinationKey]
          
          // Skip if this combination had an error
          if (candidateCount === -1) {
            errorCombinations.push(combinationKey)
            continue
          }
          
          // Skip if genuinely no parcels available
          if (candidateCount === 0) {
            unavailableCombinations.push(combinationKey)
            // Try adjacent band fallback
            const fallbackBand = bandIndex > 0 ? bandIndex - 1 : bandIndex + 1
            if (fallbackBand < 5) {
              const fallbackXmin = xmin + (fallbackBand * bandWidth)
              const fallbackXmax = fallbackXmin + bandWidth
              const fallbackEnvelope = JSON.stringify({
                xmin: fallbackXmin,
                ymin: ymin,
                xmax: fallbackXmax,
                ymax: ymax,
                spatialReference: { wkid }
              })
              
              try {
                const fallbackParams = new URLSearchParams({
                  where: acreageClass.where,
                  geometry: fallbackEnvelope,
                  geometryType: 'esriGeometryEnvelope',
                  inSR: wkid.toString(),
                  spatialRel: 'esriSpatialRelIntersects',
                  outFields: 'OBJECTID,PA_MCPI,PA_GIS_ACRE',
                  returnGeometry: 'false',
                  orderByFields: 'OBJECTID ASC',
                  f: 'json'
                })
                
                const fallbackResponse = await fetch(`${PARCEL_URL}/query`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                  body: fallbackParams
                })
                
                if (!fallbackResponse.ok) {
                  throw new Error(`Fallback query failed: ${fallbackResponse.statusText}`)
                }
                
                const fallbackData = await fallbackResponse.json()
                if (fallbackData.error) {
                  throw new Error(`Fallback ArcGIS error: ${fallbackData.error.message}`)
                }
                
                const fallbackFeatures = (fallbackData.features || []).filter((f: any) => 
                  f.attributes.PA_MCPI && !selectedMcpis.has(f.attributes.PA_MCPI)
                )
                
                if (fallbackFeatures.length > 0) {
                  const deterministicOffset = Math.floor(rng() * fallbackFeatures.length)
                  const selected = fallbackFeatures[deterministicOffset]
                  selectedMcpis.add(selected.attributes.PA_MCPI)
                  sampledParcelsList.push({
                    mcpi: selected.attributes.PA_MCPI,
                    objectId: selected.attributes.OBJECTID,
                    geographicBand: fallbackBand + 1,
                    acreageClass: acreageClass.name,
                    selectionSeed: seed,
                    selectionOffset: deterministicOffset,
                    fallbackUsed: true,
                    sampleRole: 'stratified-pilot'
                  })
                  fallbackSelections.push(combinationKey)
                }
              } catch (e) {
                console.error(`Fallback error for ${combinationKey}:`, e)
              }
            }
            continue
          }
          
          try {
            // Query available parcels in this band and acreage class with offset
            const deterministicOffset = Math.floor(rng() * candidateCount)
            const params = new URLSearchParams({
              where: acreageClass.where,
              geometry: bandEnvelope,
              geometryType: 'esriGeometryEnvelope',
              inSR: wkid.toString(),
              spatialRel: 'esriSpatialRelIntersects',
              outFields: 'OBJECTID,PA_MCPI,PA_GIS_ACRE',
              returnGeometry: 'false',
              orderByFields: 'OBJECTID ASC',
              resultOffset: deterministicOffset.toString(),
              resultRecordCount: '1',
              f: 'json'
            })
            
            const response = await fetch(`${PARCEL_URL}/query`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: params
            })
            
            if (!response.ok) {
              throw new Error(`Query failed: ${response.statusText}`)
            }
            
            const data = await response.json()
            if (data.error) {
              throw new Error(`ArcGIS error: ${data.error.message}`)
            }
            
            const features = data.features || []
            const availableParcels = features.filter((f: any) => 
              f.attributes.PA_MCPI && !selectedMcpis.has(f.attributes.PA_MCPI)
            )
            
            if (availableParcels.length > 0) {
              const selected = availableParcels[0]
              selectedMcpis.add(selected.attributes.PA_MCPI)
              sampledParcelsList.push({
                mcpi: selected.attributes.PA_MCPI,
                objectId: selected.attributes.OBJECTID,
                geographicBand: bandIndex + 1,
                acreageClass: acreageClass.name,
                selectionSeed: seed,
                selectionOffset: deterministicOffset,
                fallbackUsed: false,
                sampleRole: 'stratified-pilot'
              })
            } else {
              // Offset landed on already selected parcel, try next available
              const fallbackParams = new URLSearchParams({
                where: acreageClass.where,
                geometry: bandEnvelope,
                geometryType: 'esriGeometryEnvelope',
                inSR: wkid.toString(),
                spatialRel: 'esriSpatialRelIntersects',
                outFields: 'OBJECTID,PA_MCPI,PA_GIS_ACRE',
                returnGeometry: 'false',
                orderByFields: 'OBJECTID ASC',
                f: 'json'
              })
              
              const fallbackResponse = await fetch(`${PARCEL_URL}/query`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: fallbackParams
              })
              
              const fallbackData = await fallbackResponse.json()
              const allFeatures = (fallbackData.features || []).filter((f: any) => 
                f.attributes.PA_MCPI && !selectedMcpis.has(f.attributes.PA_MCPI)
              )
              
              if (allFeatures.length > 0) {
                const selected = allFeatures[0]
                selectedMcpis.add(selected.attributes.PA_MCPI)
                sampledParcelsList.push({
                  mcpi: selected.attributes.PA_MCPI,
                  objectId: selected.attributes.OBJECTID,
                  geographicBand: bandIndex + 1,
                  acreageClass: acreageClass.name,
                  selectionSeed: seed,
                  selectionOffset: 0,
                  fallbackUsed: false,
                  sampleRole: 'stratified-pilot'
                })
              }
            }
            
          } catch (e) {
            console.error(`Error selecting parcel for ${combinationKey}:`, e)
            errorCombinations.push(combinationKey)
          }
        }
      }
      
      // Helper functions for ArcGIS/GeoJSON compatibility
      const getFeatureMCPI = (feature: any): string | null => {
        const mcpi = feature.attributes?.PA_MCPI || feature.properties?.PA_MCPI
        if (mcpi === null || mcpi === undefined) return null
        const str = String(mcpi).trim()
        return str.length > 0 ? str : null
      }
      
      const getFeatureObjectId = (feature: any): number | null => {
        const oid = feature.attributes?.OBJECTID || feature.properties?.OBJECTID || feature.id
        if (oid === null || oid === undefined) return null
        const num = Number(oid)
        return isNaN(num) ? null : num
      }
      
      const getFeatureGeometry = (feature: any): any => {
        return feature.geometry || null
      }
      
      const analyzeArcGISRings = (rings: number[][][]): { ringCount: number; totalPointCount: number; hasHoles: boolean; isMultipart: boolean } => {
        const ringCount = rings.length
        const totalPointCount = rings.reduce((sum, ring) => sum + ring.length, 0)
        
        // In ArcGIS, holes are typically rings with clockwise orientation
        // Outer rings are counterclockwise
        let hasHoles = false
        for (const ring of rings) {
          if (ring.length < 4) continue
          // Calculate signed area to determine orientation
          let area = 0
          for (let i = 0; i < ring.length - 1; i++) {
            area += (ring[i][0] * ring[i + 1][1]) - (ring[i + 1][0] * ring[i][1])
          }
          // Clockwise (hole) if area > 0 in typical coordinate systems
          if (area > 0) {
            hasHoles = true
            break
          }
        }
        
        // Multipart if more than one ring (could be hole or separate polygon)
        const isMultipart = ringCount > 1
        
        return { ringCount, totalPointCount, hasHoles, isMultipart }
      }
      
      // Select geometry-complexity parcel (only after 20 stratified parcels selected)
      let geometryCandidate = null
      let geometryReason = ''
      let candidatePoolSize = 0
      let skippedCandidates = 0
      let candidateDiagnostics: any = {
        requestsAttempted: 0,
        httpStatuses: [],
        arcgisErrors: [],
        featuresReturned: 0,
        responseFormat: 'unknown',
        validMCPIs: 0,
        featuresWithGeometry: 0,
        duplicates: 0,
        blankMCPIs: 0,
        uniqueValidCollected: 0,
        lastOffset: 0
      }
      
      if (sampledParcelsList.length >= 24) {
        try {
          // Build a reliable unique candidate pool using ArcGIS JSON
          const uniqueCandidates: any[] = []
          let offset = 0
          const maxCandidates = 10
          const maxOffset = 5000
          
          while (uniqueCandidates.length < maxCandidates && offset < maxOffset) {
            candidateDiagnostics.requestsAttempted++
            candidateDiagnostics.lastOffset = offset
            
            const candidateParams = new URLSearchParams({
              where: 'PA_MCPI IS NOT NULL',
              outFields: 'OBJECTID,PA_MCPI,PA_GIS_ACRE,PA_LEGAL_ACRE',
              returnGeometry: 'true',
              outSR: wkid.toString(),
              orderByFields: 'OBJECTID ASC',
              resultOffset: offset.toString(),
              resultRecordCount: '50',
              f: 'json'
            })
            
            const candidateResponse = await fetch(`${PARCEL_URL}/query`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: candidateParams
            })
            
            candidateDiagnostics.httpStatuses.push(candidateResponse.status)
            
            const candidateData = await candidateResponse.json()
            
            if (candidateData.error) {
              candidateDiagnostics.arcgisErrors.push(candidateData.error)
              console.error('ArcGIS error in candidate query:', candidateData.error)
              break
            }
            
            const features = candidateData.features || []
            candidateDiagnostics.featuresReturned += features.length
            candidatePoolSize += features.length
            
            // Detect response format
            if (features.length > 0) {
              if (features[0].attributes) {
                candidateDiagnostics.responseFormat = 'ArcGIS JSON'
              } else if (features[0].properties) {
                candidateDiagnostics.responseFormat = 'GeoJSON'
              }
            }
            
            for (const f of features) {
              const mcpi = getFeatureMCPI(f)
              if (!mcpi) {
                candidateDiagnostics.blankMCPIs++
                skippedCandidates++
                continue
              }
              candidateDiagnostics.validMCPIs++
              
              if (selectedMcpis.has(mcpi)) {
                candidateDiagnostics.duplicates++
                skippedCandidates++
                continue
              }
              
              if (uniqueCandidates.some(c => getFeatureMCPI(c) === mcpi)) {
                candidateDiagnostics.duplicates++
                skippedCandidates++
                continue
              }
              
              const geom = getFeatureGeometry(f)
              if (!geom) {
                skippedCandidates++
                continue
              }
              candidateDiagnostics.featuresWithGeometry++
              
              uniqueCandidates.push(f)
              if (uniqueCandidates.length >= maxCandidates) break
            }
            
            offset += 50
            if (features.length < 50) break // Exhausted pool
          }
          
          candidateDiagnostics.uniqueValidCollected = uniqueCandidates.length
          
          console.log(`Geometry candidate diagnostics:`, candidateDiagnostics)
          console.log(`Geometry candidate pool: ${uniqueCandidates.length} unique, ${skippedCandidates} skipped, ${candidatePoolSize} total`)
          
          // Analyze geometry using ArcGIS rings or GeoJSON coordinates
          let bestCandidate = null
          let bestReason = ''
          let maxPoints = 0
          
          for (const candidate of uniqueCandidates) {
            const geom = getFeatureGeometry(candidate)
            let analysis: any = null
            
            if (geom.rings) {
              // ArcGIS JSON format
              analysis = analyzeArcGISRings(geom.rings)
            } else if (geom.coordinates) {
              // GeoJSON format
              let ringCount = 0
              let totalPointCount = 0
              let hasHoles = false
              let isMultipart = false
              
              if (geom.type === 'Polygon') {
                ringCount = geom.coordinates.length
                totalPointCount = geom.coordinates.reduce((sum: number, ring: number[][]) => sum + ring.length, 0)
                hasHoles = ringCount > 1
                isMultipart = ringCount > 1
              } else if (geom.type === 'MultiPolygon') {
                isMultipart = true
                for (const poly of geom.coordinates) {
                  ringCount += poly.length
                  totalPointCount += poly.reduce((sum: number, ring: number[][]) => sum + ring.length, 0)
                  if (poly.length > 1) hasHoles = true
                }
              }
              
              analysis = { ringCount, totalPointCount, hasHoles, isMultipart }
            }
            
            if (!analysis) continue
            
            // Priority: multipart > holes > multiple rings > highest point count
            if (analysis.isMultipart && !bestReason.includes('multipart')) {
              bestCandidate = candidate
              bestReason = 'Multipart geometry'
              maxPoints = analysis.totalPointCount
            } else if (analysis.hasHoles && !bestReason.includes('multipart') && !bestReason.includes('holes')) {
              bestCandidate = candidate
              bestReason = 'Polygon with holes'
              maxPoints = analysis.totalPointCount
            } else if (analysis.ringCount > 1 && !bestReason.includes('multipart') && !bestReason.includes('holes') && !bestReason.includes('multiple rings')) {
              bestCandidate = candidate
              bestReason = 'Multiple rings'
              maxPoints = analysis.totalPointCount
            } else if (analysis.totalPointCount > maxPoints) {
              bestCandidate = candidate
              bestReason = `Highest point count (${analysis.totalPointCount})`
              maxPoints = analysis.totalPointCount
            }
          }
          
          // Guaranteed fallback: select highest point count if we have any valid candidates
          if (!bestCandidate && uniqueCandidates.length > 0) {
            bestCandidate = uniqueCandidates[0]
            bestReason = 'Highest point count in deterministic candidate pool'
          }
          
          if (bestCandidate) {
            geometryCandidate = bestCandidate
            geometryReason = bestReason
            selectedMcpis.add(getFeatureMCPI(geometryCandidate)!)
            sampledParcelsList.push({
              mcpi: getFeatureMCPI(geometryCandidate)!,
              objectId: getFeatureObjectId(geometryCandidate)!,
              geographicBand: 0,
              acreageClass: 'geometry-complexity',
              selectionSeed: seed,
              selectionOffset: 0,
              fallbackUsed: false,
              sampleRole: 'geometry-complexity',
              geometrySelectionReason: geometryReason
            })
          } else {
            throw new Error(`No valid unique geometry candidate found. Diagnostics: ${JSON.stringify(candidateDiagnostics)}`)
          }
          
        } catch (e) {
          console.error('Error selecting geometry-complexity parcel:', e)
          throw new Error(`Geometry selection failed: ${e}`)
        }
      }
      
      // Final validation before state update
      const controlCount = sampledParcelsList.filter(p => p.sampleRole === 'verified-control').length
      const stratifiedCount = sampledParcelsList.filter(p => p.sampleRole === 'stratified-pilot').length
      const geometryCount = sampledParcelsList.filter(p => p.sampleRole === 'geometry-complexity').length
      const uniqueMcpis = new Set(sampledParcelsList.map(p => p.mcpi))
      
      if (controlCount !== 4) {
        throw new Error(`Validation failed: Expected 4 controls, got ${controlCount}`)
      }
      if (stratifiedCount !== 20) {
        throw new Error(`Validation failed: Expected 20 stratified parcels, got ${stratifiedCount}`)
      }
      if (geometryCount !== 1) {
        throw new Error(`Validation failed: Expected 1 geometry-complexity parcel, got ${geometryCount}`)
      }
      if (sampledParcelsList.length !== 25) {
        throw new Error(`Validation failed: Expected 25 total parcels, got ${sampledParcelsList.length}`)
      }
      if (uniqueMcpis.size !== 25) {
        throw new Error(`Validation failed: Expected 25 unique MCPIs, got ${uniqueMcpis.size}`)
      }
      if (sampledParcelsList.some(p => !p.mcpi || p.mcpi.trim() === '')) {
        throw new Error('Validation failed: Found blank MCPI')
      }
      
      // Set metadata
      const geometryParcel = sampledParcelsList.find(p => p.sampleRole === 'geometry-complexity')
      const metadata: PilotMetadata = {
        seed,
        timestamp: new Date().toISOString(),
        totalParcels: selectedMcpis.size,
        controlParcels: VERIFIED_FIXTURES.length,
        newParcels: selectedMcpis.size - VERIFIED_FIXTURES.length,
        stratifiedParcels: stratifiedCount,
        geometryComplexityParcels: geometryCount,
        geographicBands: [...new Set(sampledParcelsList.filter(p => p.sampleRole === 'stratified-pilot').map(p => p.geographicBand))],
        acreageClasses: [...new Set(sampledParcelsList.filter(p => p.sampleRole === 'stratified-pilot').map(p => p.acreageClass))],
        geometryCandidateReason: geometryParcel?.geometrySelectionReason,
        geometryCandidateMcpi: geometryParcel?.mcpi,
        candidatePoolSize,
        skippedCandidates,
        candidateDiagnostics,
        unavailableCombinations,
        errorCombinations,
        fallbackSelections,
        diagnosticCounts,
        bandAcreageMatrix
      }
      
      setPilotMetadata(metadata)
      setSampledParcels(sampledParcelsList)
      
      // Order: controls first, then stratified by band/class, then geometry
      const orderedParcels = [
        ...sampledParcelsList.filter(p => p.sampleRole === 'verified-control'),
        ...sampledParcelsList.filter(p => p.sampleRole === 'stratified-pilot').sort((a, b) => {
          if (a.geographicBand !== b.geographicBand) return a.geographicBand - b.geographicBand
          return a.geographicBand - b.geographicBand
        }),
        ...sampledParcelsList.filter(p => p.sampleRole === 'geometry-complexity')
      ]
      
      const mcpiList = orderedParcels.map(p => p.mcpi).join('\n')
      setMcpiInput(mcpiList)
      
    } catch (e) {
      console.error('Error generating pilot:', e)
      // Preserve diagnostics for inspection even on failure
      const errorMetadata: PilotMetadata = {
        seed,
        timestamp: new Date().toISOString(),
        totalParcels: sampledParcelsList.length,
        controlParcels: VERIFIED_FIXTURES.length,
        newParcels: sampledParcelsList.length - VERIFIED_FIXTURES.length,
        stratifiedParcels: sampledParcelsList.filter(p => p.sampleRole === 'stratified-pilot').length,
        geometryComplexityParcels: sampledParcelsList.filter(p => p.sampleRole === 'geometry-complexity').length,
        geographicBands: [...new Set(sampledParcelsList.filter(p => p.sampleRole === 'stratified-pilot').map(p => p.geographicBand))],
        acreageClasses: [...new Set(sampledParcelsList.filter(p => p.sampleRole === 'stratified-pilot').map(p => p.acreageClass))],
        candidatePoolSize,
        skippedCandidates,
        candidateDiagnostics,
        unavailableCombinations,
        errorCombinations,
        fallbackSelections,
        diagnosticCounts,
        bandAcreageMatrix
      }
      setPilotMetadata(errorMetadata)
      // Do not populate textarea on failure
      // Do not enable Run Audit on failure
      alert(`Failed to generate pilot: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setIsGeneratingPilot(false)
    }
  }

  const calculateGeometryStats = (geometry: any): { ringCount: number; totalPointCount: number; hasHoles: boolean; isMultipart: boolean } => {
    let ringCount = 0
    let totalPointCount = 0
    let hasHoles = false
    let isMultipart = false

    if (!geometry) {
      return { ringCount: 0, totalPointCount: 0, hasHoles: false, isMultipart: false }
    }

    if (geometry.type === 'Polygon') {
      isMultipart = false
      ringCount = geometry.coordinates.length
      hasHoles = ringCount > 1
      geometry.coordinates.forEach((ring: number[][]) => {
        totalPointCount += ring.length
      })
    } else if (geometry.type === 'MultiPolygon') {
      isMultipart = true
      geometry.coordinates.forEach((polygon: number[][][]) => {
        ringCount += polygon.length
        hasHoles = hasHoles || polygon.length > 1
        polygon.forEach((ring: number[][]) => {
          totalPointCount += ring.length
        })
      })
    }

    return { ringCount, totalPointCount, hasHoles, isMultipart }
  }

  const auditSingleParcel = async (mcpi: string, abortSignal?: AbortSignal): Promise<AuditResult> => {
    const startTime = Date.now()
    const warnings: string[] = []
    const errors: string[] = []
    let status: AuditStatus = 'PASS'

    // Parcel lookup
    let parcel: ParcelData | null = null
    try {
      parcel = await fetchParcelByMCPI(mcpi, abortSignal)
    } catch (e) {
      errors.push(`Parcel lookup failed: ${e instanceof Error ? e.message : String(e)}`)
      return {
        mcpi,
        status: 'FAIL',
        parcelInfo: {
          addressCount: 0,
          normalizedAddresses: [],
          normalizedAddressSummary: '',
          gisAcreage: 0,
          legalAcreage: 0,
          subdivision: '',
          platNumber: '',
          platLot: '',
          parcelType: '',
          geometryType: '',
          ringCount: 0,
          totalPointCount: 0,
          hasHoles: false,
          isMultipart: false
        },
        buildingInfo: {
          queryState: 'failed',
          buildingCount: 0,
          wasTruncated: false,
          httpStatus: 0,
          queryDuration: 0,
          errorMessage: 'Parcel lookup failed'
        },
        streetInfo: {
          intersectingQueryState: 'not_attempted',
          intersectingSegmentCount: 0,
          uniqueIntersectingNames: [],
          totalSegmentCountWithin100ft: 0,
          additionalNearbyCount: 0,
          uniqueNamesWithin100ft: [],
          wasTruncated: false,
          httpStatuses: [],
          queryDurations: [],
          errorMessages: ['Parcel lookup failed']
        },
        generalInfo: {
          totalAnalysisDuration: Date.now() - startTime,
          warnings,
          errors
        }
      }
    }

    if (!parcel) {
      errors.push('Parcel not found')
      return {
        mcpi,
        status: 'FAIL',
        parcelInfo: {
          addressCount: 0,
          normalizedAddresses: [],
          normalizedAddressSummary: '',
          gisAcreage: 0,
          legalAcreage: 0,
          subdivision: '',
          platNumber: '',
          platLot: '',
          parcelType: '',
          geometryType: '',
          ringCount: 0,
          totalPointCount: 0,
          hasHoles: false,
          isMultipart: false
        },
        buildingInfo: {
          queryState: 'not_attempted',
          buildingCount: 0,
          wasTruncated: false,
          httpStatus: 0,
          queryDuration: 0
        },
        streetInfo: {
          intersectingQueryState: 'not_attempted',
          intersectingSegmentCount: 0,
          uniqueIntersectingNames: [],
          totalSegmentCountWithin100ft: 0,
          additionalNearbyCount: 0,
          uniqueNamesWithin100ft: [],
          wasTruncated: false,
          httpStatuses: [],
          queryDurations: [],
          errorMessages: []
        },
        generalInfo: {
          totalAnalysisDuration: Date.now() - startTime,
          warnings,
          errors
        }
      }
    }

    // Address lookup
    let addresses: AddressData[] = []
    try {
      addresses = await fetchAddressesByMCPI(mcpi, abortSignal)
    } catch (e) {
      warnings.push(`Address lookup failed: ${e instanceof Error ? e.message : String(e)}`)
    }

    // Normalize addresses
    const extractAddress = (a: any): string | null => {
      // Handle direct strings
      if (typeof a === 'string' && a.trim().length > 0) {
        return a.trim()
      }
      
      // Handle GeoJSON features with properties
      if (a.properties?.FULL_ADDRESS) {
        return a.properties.FULL_ADDRESS.trim()
      }
      if (a.properties?.ADDRESS) {
        return a.properties.ADDRESS.trim()
      }
      
      // Handle direct property objects (AddressData structure)
      if (a.FULL_ADDRESS) {
        return a.FULL_ADDRESS.trim()
      }
      if (a.ADDRESS) {
        return a.ADDRESS.trim()
      }
      
      // No supported string field found
      return null
    }

    const normalizedAddresses = addresses
      .map(a => extractAddress(a))
      .filter((addr): addr is string => addr !== null)
      .filter((addr, index, self) => self.indexOf(addr) === index)

    const props = parcel.properties
    const geometryStats = calculateGeometryStats(parcel.geometry)

    // Check for warnings
    if (addresses.length === 0) {
      warnings.push('No addresses returned')
    }
    if (props.PA_GIS_ACRE && props.PA_LEGAL_ACRE && Math.abs(props.PA_GIS_ACRE - props.PA_LEGAL_ACRE) > 0.01) {
      warnings.push(`GIS acreage (${props.PA_GIS_ACRE}) differs from legal acreage (${props.PA_LEGAL_ACRE})`)
    }
    if (geometryStats.isMultipart) {
      warnings.push('Multipart geometry detected')
    }
    if (geometryStats.hasHoles) {
      warnings.push('Geometry contains holes')
    }

    // Building query
    let buildingCount = 0
    let buildingQueryState = 'success'
    let buildingWasTruncated = false
    let buildingHttpStatus = 200
    let buildingDuration = 0
    let buildingError: string | undefined

    try {
      const buildingStart = Date.now()
      const buildings = await fetchBuildingsByParcel(parcel.geometry, abortSignal) as BuildingData[]
      buildingDuration = Date.now() - buildingStart
      buildingCount = buildings.length
      buildingHttpStatus = 200
    } catch (e) {
      buildingQueryState = 'failed'
      buildingError = e instanceof Error ? e.message : String(e)
      errors.push(`Building query failed: ${buildingError}`)
    }

    if (buildingCount === 0) {
      warnings.push('No buildings found')
    }

    // Street queries
    let intersectingSegments: RoadData[] = []
    let nearbySegments: RoadData[] = []
    let intersectingQueryState = 'success'
    let streetWasTruncated = false
    let streetHttpStatuses: number[] = []
    let streetDurations: number[] = []
    let streetErrors: string[] = []

    try {
      const intersectingStart = Date.now()
      intersectingSegments = await fetchIntersectingStreets(parcel.geometry, abortSignal) as RoadData[]
      streetDurations.push(Date.now() - intersectingStart)
      streetHttpStatuses.push(200)
    } catch (e) {
      intersectingQueryState = 'failed'
      streetErrors.push(`Intersecting streets query failed: ${e instanceof Error ? e.message : String(e)}`)
      errors.push(streetErrors[streetErrors.length - 1])
    }

    try {
      const nearbyStart = Date.now()
      nearbySegments = await fetchNearbyStreets(parcel.geometry, abortSignal) as RoadData[]
      streetDurations.push(Date.now() - nearbyStart)
      streetHttpStatuses.push(200)
    } catch (e) {
      streetErrors.push(`Nearby streets query failed: ${e instanceof Error ? e.message : String(e)}`)
      errors.push(streetErrors[streetErrors.length - 1])
    }

    // Calculate additional nearby streets using OBJECTID deduplication
    const intersectingObjectIds = new Set(intersectingSegments.map(s => s.properties?.OBJECTID))
    const additionalNearby = nearbySegments.filter(s => !intersectingObjectIds.has(s.properties?.OBJECTID))
    const additionalNearbyCount = additionalNearby.length

    // Extract unique street names from ST_FULLNAME or construct from components
    const getStreetName = (s: RoadData): string => {
      const props = s.properties
      if (props.ST_FULLNAME) return props.ST_FULLNAME.trim()
      // Construct from components if ST_FULLNAME not available
      const parts = [props.ST_DIR_PREF, props.ST_STR_NAME, props.ST_DIR_SUF, props.ST_STR_TYPE]
        .filter(Boolean)
        .map(p => p.trim())
      return parts.join(' ')
    }

    const uniqueIntersectingNames = [...new Set(
      intersectingSegments
        .map(getStreetName)
        .filter(name => name.length > 0)
    )]
    const uniqueNamesWithin100ft = [...new Set(
      nearbySegments
        .map(getStreetName)
        .filter(name => name.length > 0)
    )]

    if (intersectingSegments.length === 0 && nearbySegments.length === 0) {
      warnings.push('No streets found')
    }

    // Determine final status
    if (errors.length > 0) {
      status = 'FAIL'
    } else if (warnings.length > 0) {
      status = 'WARNING'
    }

    // Check fixture match
    const fixture = VERIFIED_FIXTURES.find(f => f.mcpi === mcpi)
    let fixtureMatch: AuditResult['fixtureMatch']
    if (fixture) {
      const actualAddress = normalizedAddresses.length > 0 ? normalizedAddresses[0] : ''
      const addressMatch = fixture.expected.address 
        ? actualAddress.toUpperCase().trim() === fixture.expected.address.toUpperCase().trim()
        : undefined
      
      const buildingMatch = buildingCount === fixture.expected.buildings
      const intersectingMatch = intersectingSegments.length === fixture.expected.intersectingStreets
      const totalMatch = nearbySegments.length === fixture.expected.totalStreetsWithin100ft
      const additionalMatch = additionalNearbyCount === fixture.expected.additionalNearbyStreets
      
      // Overall match requires all individual matches
      // If address is expected, it must also match
      const overallMatch = buildingMatch && intersectingMatch && totalMatch && additionalMatch &&
        (fixture.expected.address ? addressMatch : true)
      
      fixtureMatch = {
        expectedBuildings: fixture.expected.buildings,
        actualBuildings: buildingCount,
        expectedIntersectingStreets: fixture.expected.intersectingStreets,
        actualIntersectingStreets: intersectingSegments.length,
        expectedTotalStreets: fixture.expected.totalStreetsWithin100ft,
        actualTotalStreets: nearbySegments.length,
        expectedAdditionalStreets: fixture.expected.additionalNearbyStreets,
        actualAdditionalStreets: additionalNearbyCount,
        overallMatch
      }
      if (fixture.expected.address) {
        fixtureMatch.expectedAddress = fixture.expected.address
        fixtureMatch.actualAddress = actualAddress
        fixtureMatch.addressMatch = addressMatch
      }
    }

    return {
      mcpi,
      status,
      parcelInfo: {
        addressCount: normalizedAddresses.length,
        normalizedAddresses: normalizedAddresses,
        normalizedAddressSummary: normalizedAddresses.join('; '),
        gisAcreage: props.PA_GIS_ACRE || 0,
        legalAcreage: props.PA_LEGAL_ACRE || 0,
        subdivision: props.PA_SUBD_NAME || '',
        platNumber: props.PA_PLAT_NUM || '',
        platLot: props.PA_PLAT_LOT || '',
        parcelType: props.PA_TYPE || '',
        geometryType: parcel.geometry?.type || '',
        ...geometryStats
      },
      buildingInfo: {
        queryState: buildingQueryState,
        buildingCount,
        wasTruncated: buildingWasTruncated,
        httpStatus: buildingHttpStatus,
        queryDuration: buildingDuration,
        errorMessage: buildingError
      },
      streetInfo: {
        intersectingQueryState: intersectingQueryState,
        intersectingSegmentCount: intersectingSegments.length,
        uniqueIntersectingNames,
        totalSegmentCountWithin100ft: nearbySegments.length,
        additionalNearbyCount,
        uniqueNamesWithin100ft,
        wasTruncated: streetWasTruncated,
        httpStatuses: streetHttpStatuses,
        queryDurations: streetDurations,
        errorMessages: streetErrors
      },
      generalInfo: {
        totalAnalysisDuration: Date.now() - startTime,
        warnings,
        errors
      },
      fixtureMatch
    }
  }

  const runAudit = async () => {
    const mcpiList = normalizeMCPIs(mcpiInput)
    if (mcpiList.length === 0) return

    // Increment run ID to prevent stale promises from updating this run
    const currentRunId = ++runIdRef.current

    setIsRunning(true)
    setResults([])
    setCompletedCount(0)
    setTotalCount(mcpiList.length)
    runningRef.current = true
    abortControllerRef.current = new AbortController()

    const maxConcurrency = 2
    const resultsMap = new Map<string, AuditResult>()
    let nextIndex = 0

    const processNext = async (): Promise<void> => {
      // Check if this run is still active
      if (!runningRef.current || runIdRef.current !== currentRunId) return

      // Get the next MCPI to process
      const currentIndex = nextIndex++
      if (currentIndex >= mcpiList.length) return

      const mcpi = mcpiList[currentIndex]
      setCurrentMcpi(mcpi)

      try {
        const result = await auditSingleParcel(mcpi, abortControllerRef.current?.signal)
        
        // Only update if this run is still active
        if (runIdRef.current === currentRunId) {
          resultsMap.set(mcpi, result)
          // Convert map to array preserving input order
          const orderedResults = mcpiList.map(m => resultsMap.get(m)).filter((r): r is AuditResult => r !== undefined)
          setResults(orderedResults)
          setCompletedCount(orderedResults.length)
        }
      } catch (e) {
        // Only update if this run is still active
        if (runIdRef.current === currentRunId) {
          let status: AuditStatus = 'FAIL'
          let errorMessage = e instanceof Error ? e.message : String(e)

          if (e instanceof Error && e.name === 'AbortError') {
            status = 'ABORTED'
            errorMessage = 'Audit aborted by user'
          }

          const result: AuditResult = {
            mcpi,
            status,
            parcelInfo: {
              addressCount: 0,
              normalizedAddresses: [],
              normalizedAddressSummary: '',
              gisAcreage: 0,
              legalAcreage: 0,
              subdivision: '',
              platNumber: '',
              platLot: '',
              parcelType: '',
              geometryType: '',
              ringCount: 0,
              totalPointCount: 0,
              hasHoles: false,
              isMultipart: false
            },
            buildingInfo: {
              queryState: status === 'ABORTED' ? 'aborted' : 'failed',
              buildingCount: 0,
              wasTruncated: false,
              httpStatus: 0,
              queryDuration: 0,
              errorMessage: status === 'ABORTED' ? undefined : errorMessage
            },
            streetInfo: {
              intersectingQueryState: status === 'ABORTED' ? 'aborted' : 'not_attempted',
              intersectingSegmentCount: 0,
              uniqueIntersectingNames: [],
              totalSegmentCountWithin100ft: 0,
              additionalNearbyCount: 0,
              uniqueNamesWithin100ft: [],
              wasTruncated: false,
              httpStatuses: [],
              queryDurations: [],
              errorMessages: status === 'ABORTED' ? [] : [errorMessage]
            },
            generalInfo: {
              totalAnalysisDuration: 0,
              warnings: [],
              errors: status === 'ABORTED' ? [] : [errorMessage]
            }
          }

          resultsMap.set(mcpi, result)
          const orderedResults = mcpiList.map(m => resultsMap.get(m)).filter((r): r is AuditResult => r !== undefined)
          setResults(orderedResults)
          setCompletedCount(orderedResults.length)
        }
      }

      // Continue to next parcel if this run is still active
      if (runningRef.current && runIdRef.current === currentRunId) {
        await processNext()
      }
    }

    // Start initial workers
    const initialWorkers = Math.min(maxConcurrency, mcpiList.length)
    const workers: Promise<void>[] = []
    for (let i = 0; i < initialWorkers; i++) {
      workers.push(processNext())
    }

    await Promise.all(workers)

    // Only mark as complete if this run is still active
    if (runIdRef.current === currentRunId) {
      setIsRunning(false)
      setCurrentMcpi('')
      runningRef.current = false
    }
  }

  const stopAudit = () => {
    // Invalidate run ID to prevent stale promises from updating
    runIdRef.current++
    
    runningRef.current = false
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    setIsRunning(false)
    
    // Mark any unprocessed parcels as ABORTED
    setResults(prevResults => {
      const mcpiList = normalizeMCPIs(mcpiInput)
      const processedMcpis = new Set(prevResults.map(r => r.mcpi))
      
      // Add ABORTED entries for unprocessed parcels
      const abortedEntries = mcpiList
        .filter(mcpi => !processedMcpis.has(mcpi))
        .map(mcpi => ({
          mcpi,
          status: 'ABORTED' as AuditStatus,
          parcelInfo: {
            addressCount: 0,
            normalizedAddresses: [],
            normalizedAddressSummary: '',
            gisAcreage: 0,
            legalAcreage: 0,
            subdivision: '',
            platNumber: '',
            platLot: '',
            parcelType: '',
            geometryType: '',
            ringCount: 0,
            totalPointCount: 0,
            hasHoles: false,
            isMultipart: false
          },
          buildingInfo: {
            queryState: 'aborted',
            buildingCount: 0,
            wasTruncated: false,
            httpStatus: 0,
            queryDuration: 0
          },
          streetInfo: {
            intersectingQueryState: 'aborted',
            intersectingSegmentCount: 0,
            uniqueIntersectingNames: [],
            totalSegmentCountWithin100ft: 0,
            additionalNearbyCount: 0,
            uniqueNamesWithin100ft: [],
            wasTruncated: false,
            httpStatuses: [],
            queryDurations: [],
            errorMessages: []
          },
          generalInfo: {
            totalAnalysisDuration: 0,
            warnings: [],
            errors: []
          }
        }))
      
      // Preserve input order
      const orderedResults = mcpiList.map(m => 
        prevResults.find(r => r.mcpi === m) || abortedEntries.find(r => r.mcpi === m)
      ).filter((r): r is AuditResult => r !== undefined)
      
      setCompletedCount(orderedResults.length)
      return orderedResults
    })
  }

  const clearResults = () => {
    setResults([])
    setCompletedCount(0)
    setTotalCount(0)
    setCurrentMcpi('')
    setExpandedRow(null)
  }

  const exportJSON = () => {
    const exportData = {
      pilotMetadata,
      sampledParcels,
      results: results.map(r => {
        const sampled = sampledParcels.find(s => s.mcpi === r.mcpi)
        const review = manualReviews[r.mcpi]
        return {
          ...r,
          pilotInfo: sampled ? {
            sampleRole: sampled.sampleRole,
            geographicBand: sampled.geographicBand,
            acreageClass: sampled.acreageClass,
            selectionSeed: sampled.selectionSeed,
            selectionOffset: sampled.selectionOffset,
            fallbackUsed: sampled.fallbackUsed,
            geometrySelectionReason: sampled.geometrySelectionReason
          } : undefined,
          manualReview: review ? {
            manualReviewRequired: review.reasons.length > 0,
            manualReviewReasons: review.reasons,
            manualReviewState: review.state,
            manualReviewNote: review.note,
            reviewedAt: review.reviewedAt
          } : undefined
        }
      })
    }
    const data = JSON.stringify(exportData, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `subdivmaker-loudoun-25-parcel-pilot-${new Date().toISOString().split('T')[0]}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const exportCSV = () => {
    const headers = [
      'MCPI',
      'Status',
      'Sample Role',
      'Geographic Band',
      'Acreage Class',
      'Selection Seed',
      'Selection Offset',
      'Fallback Used',
      'GIS Acreage',
      'Legal Acreage',
      'Address Count',
      'Address Summary',
      'Buildings',
      'Intersecting Streets',
      'Unique Intersecting Street Names',
      'Total Streets (100ft)',
      'Unique Street Names Within 100 ft',
      'Additional Nearby Streets',
      'Geometry Type',
      'Ring Count',
      'Total Points',
      'Has Holes',
      'Is Multipart',
      'Duration (ms)',
      'Warnings',
      'Errors',
      'Manual Review Required',
      'Manual Review Reasons',
      'Manual Review State',
      'Manual Review Note',
      'Reviewed At'
    ]

    const rows = results.map(r => {
      const sampled = sampledParcels.find(s => s.mcpi === r.mcpi)
      const review = manualReviews[r.mcpi]
      return [
        r.mcpi,
        r.status,
        sampled?.sampleRole || '',
        sampled?.geographicBand || '',
        sampled?.acreageClass || '',
        sampled?.selectionSeed || '',
        sampled?.selectionOffset || '',
        sampled?.fallbackUsed ? 'Yes' : 'No',
        r.parcelInfo.gisAcreage,
        r.parcelInfo.legalAcreage,
        r.parcelInfo.addressCount,
        r.parcelInfo.normalizedAddressSummary,
        r.buildingInfo.buildingCount,
        r.streetInfo.intersectingSegmentCount,
        r.streetInfo.uniqueIntersectingNames.join(' | '),
        r.streetInfo.totalSegmentCountWithin100ft,
        r.streetInfo.uniqueNamesWithin100ft.join(' | '),
        r.streetInfo.additionalNearbyCount,
        r.parcelInfo.geometryType,
        r.parcelInfo.ringCount,
        r.parcelInfo.totalPointCount,
        r.parcelInfo.hasHoles,
        r.parcelInfo.isMultipart,
        r.generalInfo.totalAnalysisDuration,
        r.generalInfo.warnings.join(' | '),
        r.generalInfo.errors.join(' | '),
        review?.reasons.length > 0 ? 'Yes' : 'No',
        review?.reasons.join(' | ') || '',
        review?.state || '',
        review?.note || '',
        review?.reviewedAt || ''
      ]
    })

    const csv = [headers.join(','), ...rows.map(row => row.map(cell => `"${cell}"`).join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `subdivmaker-loudoun-25-parcel-pilot-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }
  
  const copyMCPI = (mcpi: string) => {
    navigator.clipboard.writeText(mcpi)
  }
  
  const openInMainMap = (mcpi: string) => {
    window.open(`/?mcpi=${mcpi}`, '_blank')
  }
  
  const updateManualReview = (mcpi: string, updates: Partial<ManualReview>) => {
    setManualReviews(prev => ({
      ...prev,
      [mcpi]: {
        ...prev[mcpi],
        mcpi,
        state: updates.state || prev[mcpi]?.state || 'Pending',
        note: updates.note !== undefined ? updates.note : prev[mcpi]?.note || '',
        reviewedAt: updates.reviewedAt !== undefined ? updates.reviewedAt : prev[mcpi]?.reviewedAt || null,
        reasons: updates.reasons || prev[mcpi]?.reasons || []
      }
    }))
  }
  
  const initializeReviewQueue = () => {
    const flaggedMCPIs = ['040261613000', '648284336000', '648388776000', '303169888000', '035279859000']
    
    // Get PASS parcels for controls
    const passResults = results.filter(r => r.status === 'PASS')
    
    // Select one tiny, one medium, one large PASS parcel (avoiding flagged parcels)
    const tiny = passResults.find(r => r.parcelInfo.gisAcreage < 0.25 && !flaggedMCPIs.includes(r.mcpi))
    const medium = passResults.find(r => r.parcelInfo.gisAcreage >= 2 && r.parcelInfo.gisAcreage < 20 && !flaggedMCPIs.includes(r.mcpi))
    const large = passResults.find(r => r.parcelInfo.gisAcreage >= 20 && !flaggedMCPIs.includes(r.mcpi))
    
    const controlMCPIs = [tiny?.mcpi, medium?.mcpi, large?.mcpi].filter((m): m is string => m !== undefined)
    
    const reviews: Record<string, ManualReview> = {}
    
    flaggedMCPIs.forEach(mcpi => {
      const reasons: string[] = []
      
      if (mcpi === '040261613000') {
        reasons.push('MultiPolygon geometry')
      } else {
        reasons.push('GIS/legal acreage difference greater than 5%')
      }
      
      reviews[mcpi] = {
        mcpi,
        state: 'Pending',
        note: '',
        reviewedAt: null,
        reasons
      }
    })
    
    controlMCPIs.forEach(mcpi => {
      reviews[mcpi] = {
        mcpi,
        state: 'Pending',
        note: '',
        reviewedAt: null,
        reasons: ['Control inspection']
      }
    })
    
    setManualReviews(reviews)
  }
  
  const resetReviewQueue = () => {
    if (confirm('Are you sure you want to reset the review queue? This will delete all review notes and states.')) {
      setManualReviews({})
      setPersistedReviews({})
      localStorage.removeItem(REVIEW_QUEUE_STORAGE_KEY)
      setShowRestoreNotice(false)
    }
  }

  const getStatusIcon = (status: AuditStatus) => {
    switch (status) {
      case 'PASS':
        return <CheckCircle className="w-5 h-5 text-green-400" />
      case 'WARNING':
        return <AlertTriangle className="w-5 h-5 text-yellow-400" />
      case 'FAIL':
        return <XCircle className="w-5 h-5 text-red-400" />
      case 'TRUNCATED':
        return <Clock className="w-5 h-5 text-orange-400" />
      case 'ABORTED':
        return <Square className="w-5 h-5 text-gray-400" />
      default:
        return <Loader2 className="w-5 h-5 text-blue-400 animate-spin" />
    }
  }

  const getStatusColor = (status: AuditStatus) => {
    switch (status) {
      case 'PASS':
        return 'text-green-400'
      case 'WARNING':
        return 'text-yellow-400'
      case 'FAIL':
        return 'text-red-400'
      case 'TRUNCATED':
        return 'text-orange-400'
      case 'ABORTED':
        return 'text-gray-400'
      default:
        return 'text-blue-400'
    }
  }

  return (
    <div className="min-h-screen p-6" style={{ background: 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)' }}>
      <div className="max-w-7xl mx-auto">
        <div className="mb-6">
          <h1 className="text-3xl font-bold mb-2" style={{ color: '#ffffff' }}>GIS Reliability Audit Tool</h1>
          <p className="text-sm" style={{ color: 'var(--soft-seafoam)' }}>Development-only tool for testing Loudoun County GIS pipeline</p>
        </div>

        {/* Input Section */}
        <div className="rounded-lg p-6 mb-6 border" style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--seafoam)' }}>
              MCPIs (one per line)
            </label>
            <textarea
              value={mcpiInput}
              onChange={(e) => setMcpiInput(e.target.value)}
              className="w-full px-3 py-2 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[#93E9BE] focus:border-[#93E9BE] resize-none"
              style={{ background: '#0B211B', border: '1px solid #40826D', color: '#ffffff', minHeight: '120px' }}
              placeholder="Enter MCPIs, one per line..."
              disabled={isRunning}
            />
          </div>

          <div className="flex flex-wrap gap-2 mb-4">
            <button
              onClick={loadVerifiedParcels}
              className="px-4 py-2 rounded-md text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[#93E9BE]"
              style={{ background: '#0B211B', border: '1px solid #40826D', color: 'var(--seafoam)' }}
              disabled={isRunning}
            >
              Load Four Verified Parcels
            </button>
            <button
              onClick={generate25ParcelPilot}
              disabled={isRunning || isGeneratingPilot}
              className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[#93E9BE]"
              style={{ background: '#0B211B', border: '1px solid #40826D', color: 'var(--seafoam)', opacity: (isRunning || isGeneratingPilot) ? 0.5 : 1 }}
            >
              {isGeneratingPilot ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Database className="w-4 h-4" />
                  Generate 25-Parcel Pilot
                </>
              )}
            </button>
            <button
              onClick={runAudit}
              disabled={isRunning || !mcpiInput.trim()}
              className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[#93E9BE]"
              style={{ background: 'var(--button-gradient)', color: 'var(--brand-black)', opacity: (isRunning || !mcpiInput.trim()) ? 0.5 : 1 }}
            >
              <Play className="w-4 h-4" />
              Run Audit
            </button>
            <button
              onClick={stopAudit}
              disabled={!isRunning}
              className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[#93E9BE]"
              style={{ background: '#0B211B', border: '1px solid #40826D', color: '#ffffff', opacity: !isRunning ? 0.5 : 1 }}
            >
              <Square className="w-4 h-4" />
              Stop Audit
            </button>
            <button
              onClick={clearResults}
              disabled={isRunning}
              className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[#93E9BE]"
              style={{ background: '#0B211B', border: '1px solid #40826D', color: '#ffffff', opacity: isRunning ? 0.5 : 1 }}
            >
              <Trash2 className="w-4 h-4" />
              Clear Results
            </button>
            <button
              onClick={exportJSON}
              disabled={results.length === 0}
              className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[#93E9BE]"
              style={{ background: '#0B211B', border: '1px solid #40826D', color: '#ffffff', opacity: results.length === 0 ? 0.5 : 1 }}
            >
              <FileJson className="w-4 h-4" />
              Export JSON
            </button>
            <button
              onClick={exportCSV}
              disabled={results.length === 0}
              className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[#93E9BE]"
              style={{ background: '#0B211B', border: '1px solid #40826D', color: '#ffffff', opacity: results.length === 0 ? 0.5 : 1 }}
            >
              <FileSpreadsheet className="w-4 h-4" />
              Export CSV
            </button>
          </div>

          {/* Progress */}
          {isRunning && (
            <div className="flex items-center gap-3 p-3 rounded-md" style={{ background: 'rgba(64, 130, 109, 0.2)', border: '1px solid #40826D' }}>
              <Loader2 className="w-5 h-5 text-[#93E9BE] animate-spin" />
              <div className="flex-1">
                <div className="text-sm font-medium" style={{ color: '#ffffff' }}>
                  Running audit: {completedCount} / {totalCount}
                </div>
                <div className="text-xs" style={{ color: 'var(--soft-seafoam)' }}>
                  Current: {currentMcpi}
                </div>
              </div>
            </div>
          )}

          {/* Pilot Generation Summary */}
          {pilotMetadata && (
            <div className="p-3 rounded-md" style={{ background: 'rgba(64, 130, 109, 0.2)', border: '1px solid #40826D' }}>
              <h4 className="text-sm font-medium mb-2" style={{ color: 'var(--seafoam)' }}>Pilot Generation Summary</h4>
              <div className="grid grid-cols-2 gap-2 text-xs mb-3">
                <div><span style={{ color: 'var(--text-secondary)' }}>Seed:</span> <span style={{ color: '#ffffff' }}>{pilotMetadata.seed}</span></div>
                <div><span style={{ color: 'var(--text-secondary)' }}>Total:</span> <span style={{ color: '#ffffff' }}>{pilotMetadata.totalParcels}</span></div>
                <div><span style={{ color: 'var(--text-secondary)' }}>Controls:</span> <span style={{ color: '#ffffff' }}>{pilotMetadata.controlParcels}</span></div>
                <div><span style={{ color: 'var(--text-secondary)' }}>New:</span> <span style={{ color: '#ffffff' }}>{pilotMetadata.newParcels}</span></div>
                <div><span style={{ color: 'var(--text-secondary)' }}>Stratified:</span> <span style={{ color: '#ffffff' }}>{pilotMetadata.stratifiedParcels}</span></div>
                <div><span style={{ color: 'var(--text-secondary)' }}>Geometry:</span> <span style={{ color: '#ffffff' }}>{pilotMetadata.geometryComplexityParcels}</span></div>
                <div><span style={{ color: 'var(--text-secondary)' }}>Bands:</span> <span style={{ color: '#ffffff' }}>{pilotMetadata.geographicBands.join(', ')}</span></div>
                <div><span style={{ color: 'var(--text-secondary)' }}>Acreage:</span> <span style={{ color: '#ffffff' }}>{pilotMetadata.acreageClasses.join(', ')}</span></div>
                {pilotMetadata.geometryCandidateMcpi && (
                  <div className="col-span-2"><span style={{ color: 'var(--text-secondary)' }}>Geometry MCPI:</span> <span style={{ color: '#ffffff' }}>{pilotMetadata.geometryCandidateMcpi}</span></div>
                )}
                {pilotMetadata.geometryCandidateReason && (
                  <div className="col-span-2"><span style={{ color: 'var(--text-secondary)' }}>Geometry Reason:</span> <span style={{ color: '#ffffff' }}>{pilotMetadata.geometryCandidateReason}</span></div>
                )}
                <div><span style={{ color: 'var(--text-secondary)' }}>Pool Size:</span> <span style={{ color: '#ffffff' }}>{pilotMetadata.candidatePoolSize}</span></div>
                <div><span style={{ color: 'var(--text-secondary)' }}>Skipped:</span> <span style={{ color: '#ffffff' }}>{pilotMetadata.skippedCandidates}</span></div>
              </div>
              
              {/* Candidate Diagnostics */}
              {pilotMetadata.candidateDiagnostics && (
                <div className="mb-3 p-2 rounded" style={{ background: 'rgba(0, 0, 0, 0.2)' }}>
                  <div className="text-xs font-medium mb-1" style={{ color: 'var(--seafoam)' }}>Candidate Diagnostics</div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div><span style={{ color: 'var(--text-secondary)' }}>Requests:</span> <span style={{ color: '#ffffff' }}>{pilotMetadata.candidateDiagnostics.requestsAttempted}</span></div>
                    <div><span style={{ color: 'var(--text-secondary)' }}>Format:</span> <span style={{ color: '#ffffff' }}>{pilotMetadata.candidateDiagnostics.responseFormat}</span></div>
                    <div><span style={{ color: 'var(--text-secondary)' }}>Features:</span> <span style={{ color: '#ffffff' }}>{pilotMetadata.candidateDiagnostics.featuresReturned}</span></div>
                    <div><span style={{ color: 'var(--text-secondary)' }}>Valid MCPIs:</span> <span style={{ color: '#ffffff' }}>{pilotMetadata.candidateDiagnostics.validMCPIs}</span></div>
                    <div><span style={{ color: 'var(--text-secondary)' }}>With Geometry:</span> <span style={{ color: '#ffffff' }}>{pilotMetadata.candidateDiagnostics.featuresWithGeometry}</span></div>
                    <div><span style={{ color: 'var(--text-secondary)' }}>Collected:</span> <span style={{ color: '#ffffff' }}>{pilotMetadata.candidateDiagnostics.uniqueValidCollected}</span></div>
                    <div><span style={{ color: 'var(--text-secondary)' }}>Duplicates:</span> <span style={{ color: '#ffffff' }}>{pilotMetadata.candidateDiagnostics.duplicates}</span></div>
                    <div><span style={{ color: 'var(--text-secondary)' }}>Blank MCPIs:</span> <span style={{ color: '#ffffff' }}>{pilotMetadata.candidateDiagnostics.blankMCPIs}</span></div>
                    <div><span style={{ color: 'var(--text-secondary)' }}>Last Offset:</span> <span style={{ color: '#ffffff' }}>{pilotMetadata.candidateDiagnostics.lastOffset}</span></div>
                    {pilotMetadata.candidateDiagnostics.arcgisErrors.length > 0 && (
                      <div className="col-span-2"><span style={{ color: 'var(--text-secondary)' }}>ArcGIS Errors:</span> <span style={{ color: '#ff6b6b' }}>{pilotMetadata.candidateDiagnostics.arcgisErrors.length}</span></div>
                    )}
                  </div>
                </div>
              )}
              
              {/* Diagnostic Counts */}
              <div className="mb-3 p-2 rounded" style={{ background: 'rgba(0, 0, 0, 0.2)' }}>
                <div className="text-xs font-medium mb-1" style={{ color: 'var(--seafoam)' }}>Diagnostic Counts</div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div><span style={{ color: 'var(--text-secondary)' }}>Countywide:</span> <span style={{ color: pilotMetadata.diagnosticCounts['Countywide'] > 0 ? '#93E9BE' : '#ff6b6b' }}>{pilotMetadata.diagnosticCounts['Countywide'] || 0}</span></div>
                  {pilotMetadata.diagnosticCounts['Band 1'] !== undefined && (
                    <div><span style={{ color: 'var(--text-secondary)' }}>Band 1:</span> <span style={{ color: pilotMetadata.diagnosticCounts['Band 1'] > 0 ? '#93E9BE' : '#ff6b6b' }}>{pilotMetadata.diagnosticCounts['Band 1']}</span></div>
                  )}
                  {pilotMetadata.diagnosticCounts['Band 2'] !== undefined && (
                    <div><span style={{ color: 'var(--text-secondary)' }}>Band 2:</span> <span style={{ color: pilotMetadata.diagnosticCounts['Band 2'] > 0 ? '#93E9BE' : '#ff6b6b' }}>{pilotMetadata.diagnosticCounts['Band 2']}</span></div>
                  )}
                  {pilotMetadata.diagnosticCounts['Band 3'] !== undefined && (
                    <div><span style={{ color: 'var(--text-secondary)' }}>Band 3:</span> <span style={{ color: pilotMetadata.diagnosticCounts['Band 3'] > 0 ? '#93E9BE' : '#ff6b6b' }}>{pilotMetadata.diagnosticCounts['Band 3']}</span></div>
                  )}
                  {pilotMetadata.diagnosticCounts['Band 4'] !== undefined && (
                    <div><span style={{ color: 'var(--text-secondary)' }}>Band 4:</span> <span style={{ color: pilotMetadata.diagnosticCounts['Band 4'] > 0 ? '#93E9BE' : '#ff6b6b' }}>{pilotMetadata.diagnosticCounts['Band 4']}</span></div>
                  )}
                  {pilotMetadata.diagnosticCounts['Band 5'] !== undefined && (
                    <div><span style={{ color: 'var(--text-secondary)' }}>Band 5:</span> <span style={{ color: pilotMetadata.diagnosticCounts['Band 5'] > 0 ? '#93E9BE' : '#ff6b6b' }}>{pilotMetadata.diagnosticCounts['Band 5']}</span></div>
                  )}
                </div>
              </div>
              
              {/* Band/Acreage Matrix */}
              {Object.keys(pilotMetadata.bandAcreageMatrix).length > 0 && (
                <div className="mb-3 p-2 rounded" style={{ background: 'rgba(0, 0, 0, 0.2)' }}>
                  <div className="text-xs font-medium mb-1" style={{ color: 'var(--seafoam)' }}>Band/Acreage Matrix</div>
                  <div className="grid grid-cols-4 gap-1 text-xs">
                    {Object.entries(pilotMetadata.bandAcreageMatrix).map(([key, count]) => (
                      <div key={key}>
                        <span style={{ color: 'var(--text-secondary)' }}>{key}:</span>{' '}
                        <span style={{ color: count === -1 ? '#ff6b6b' : count === 0 ? '#fbbf24' : '#93E9BE' }}>
                          {count === -1 ? 'ERROR' : count}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {pilotMetadata.errorCombinations.length > 0 && (
                <div className="mb-2">
                  <span style={{ color: 'var(--text-secondary)' }}>Errors:</span>{' '}
                  <span style={{ color: '#ff6b6b' }}>{pilotMetadata.errorCombinations.join(', ')}</span>
                </div>
              )}
              {pilotMetadata.unavailableCombinations.length > 0 && (
                <div className="mb-2">
                  <span style={{ color: 'var(--text-secondary)' }}>Unavailable:</span>{' '}
                  <span style={{ color: '#fbbf24' }}>{pilotMetadata.unavailableCombinations.join(', ')}</span>
                </div>
              )}
              {pilotMetadata.fallbackSelections.length > 0 && (
                <div>
                  <span style={{ color: 'var(--text-secondary)' }}>Fallbacks:</span>{' '}
                  <span style={{ color: '#ff6b6b' }}>{pilotMetadata.fallbackSelections.join(', ')}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Pilot Summary Panel */}
        {results.length > 0 && pilotMetadata && (
          <div className="rounded-lg p-6 mb-6 border" style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}>
            <h3 className="text-lg font-medium mb-4" style={{ color: 'var(--seafoam)' }}>Pilot Summary</h3>
            <div className="grid grid-cols-4 gap-4 text-sm">
              <div>
                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>Completed</div>
                <div className="text-lg font-bold" style={{ color: '#ffffff' }}>{results.filter(r => r.status !== 'ABORTED').length}</div>
              </div>
              <div>
                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>PASS</div>
                <div className="text-lg font-bold" style={{ color: '#93E9BE' }}>{results.filter(r => r.status === 'PASS').length}</div>
              </div>
              <div>
                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>WARNING</div>
                <div className="text-lg font-bold" style={{ color: '#fbbf24' }}>{results.filter(r => r.status === 'WARNING').length}</div>
              </div>
              <div>
                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>FAIL</div>
                <div className="text-lg font-bold" style={{ color: '#ff6b6b' }}>{results.filter(r => r.status === 'FAIL').length}</div>
              </div>
              <div>
                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>TRUNCATED</div>
                <div className="text-lg font-bold" style={{ color: '#f97316' }}>{results.filter(r => r.status === 'TRUNCATED').length}</div>
              </div>
              <div>
                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>ABORTED</div>
                <div className="text-lg font-bold" style={{ color: '#9ca3af' }}>{results.filter(r => r.status === 'ABORTED').length}</div>
              </div>
              <div>
                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>Parcel Success</div>
                <div className="text-lg font-bold" style={{ color: '#ffffff' }}>{Math.round((results.filter(r => r.status !== 'FAIL').length / results.length) * 100)}%</div>
              </div>
              <div>
                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>Avg Duration</div>
                <div className="text-lg font-bold" style={{ color: '#ffffff' }}>{Math.round(results.reduce((sum, r) => sum + r.generalInfo.totalAnalysisDuration, 0) / results.length)}ms</div>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-4 gap-4 text-xs" style={{ color: 'var(--text-secondary)' }}>
              <div>Polygon: {results.filter(r => r.parcelInfo.geometryType === 'Polygon').length}</div>
              <div>MultiPolygon: {results.filter(r => r.parcelInfo.geometryType === 'MultiPolygon').length}</div>
              <div>With Holes: {results.filter(r => r.parcelInfo.hasHoles).length}</div>
              <div>No Addresses: {results.filter(r => r.parcelInfo.addressCount === 0).length}</div>
              <div>No Buildings: {results.filter(r => r.buildingInfo.buildingCount === 0).length}</div>
              <div>No Streets: {results.filter(r => r.streetInfo.intersectingSegmentCount === 0).length}</div>
              <div>No 100ft Streets: {results.filter(r => r.streetInfo.totalSegmentCountWithin100ft === 0).length}</div>
              <div>Fallback Used: {sampledParcels.filter(p => p.fallbackUsed).length}</div>
            </div>
          </div>
        )}

        {/* Manual Review Queue */}
        {(results.length > 0 || Object.keys(persistedReviews).length > 0) && (
          <div className="rounded-lg p-6 mb-6 border" style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium" style={{ color: 'var(--seafoam)' }}>Manual Review Queue</h3>
              <div className="flex items-center gap-2">
                {Object.keys(manualReviews).length > 0 && (
                  <button
                    onClick={resetReviewQueue}
                    className="px-3 py-1 text-xs rounded"
                    style={{ background: 'rgba(255, 107, 107, 0.3)', color: '#ff6b6b' }}
                  >
                    Reset Review Queue
                  </button>
                )}
                {Object.keys(manualReviews).length === 0 && results.length > 0 && (
                  <button
                    onClick={initializeReviewQueue}
                    className="px-3 py-1 text-xs rounded"
                    style={{ background: 'rgba(64, 130, 109, 0.3)', color: 'var(--seafoam)' }}
                  >
                    Initialize Review Queue
                  </button>
                )}
              </div>
            </div>
            
            {showRestoreNotice && (
              <div className="mb-4 p-3 rounded text-xs" style={{ background: 'rgba(251, 191, 36, 0.2)', color: '#fbbf24' }}>
                Restored saved manual-review queue. Audit results are not currently loaded.
              </div>
            )}
            
            {Object.keys(manualReviews).length === 0 ? (
              <div className="text-sm p-4 rounded" style={{ background: 'rgba(64, 130, 109, 0.1)', color: 'var(--soft-seafoam)' }}>
                <p className="mb-2">Click "Initialize Review Queue" to create review items for flagged parcels and control inspections.</p>
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  This will create 8 review items: 5 flagged parcels (MultiPolygon and acreage differences) and 3 PASS control parcels (tiny, medium, large).
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {Object.values(manualReviews).map(review => {
                  const result = results.find(r => r.mcpi === review.mcpi)
                  const persisted = persistedReviews[review.mcpi]
                  
                  // Use result data if available, otherwise use persisted data
                  const gisAcreage = result?.parcelInfo.gisAcreage ?? persisted?.gisAcreage ?? 0
                  const legalAcreage = result?.parcelInfo.legalAcreage ?? persisted?.legalAcreage ?? 0
                  const acreageDiff = persisted?.acreageDiff ?? (gisAcreage > 0 && legalAcreage > 0 ? Math.abs(gisAcreage - legalAcreage) : 0)
                  const acreagePctDiff = persisted?.acreagePctDiff ?? (legalAcreage > 0 ? (acreageDiff / legalAcreage) * 100 : 0)
                  const auditStatus = result?.status ?? persisted?.auditStatus ?? 'UNKNOWN'
                  const addressCount = result?.parcelInfo.addressCount ?? persisted?.addressCount ?? 0
                  const buildingCount = result?.buildingInfo.buildingCount ?? persisted?.buildingCount ?? 0
                  const intersectingStreetCount = result?.streetInfo.intersectingSegmentCount ?? persisted?.intersectingStreetCount ?? 0
                  const totalStreetSegmentsWithin100ft = result?.streetInfo.totalSegmentCountWithin100ft ?? persisted?.totalStreetSegmentsWithin100ft ?? 0
                  const geometryType = result?.parcelInfo.geometryType ?? persisted?.geometryType ?? 'Unknown'
                  const ringCount = result?.parcelInfo.ringCount ?? persisted?.ringCount ?? 0
                  const totalPoints = result?.parcelInfo.totalPointCount ?? persisted?.totalGeometryPoints ?? 0
                  
                  return (
                    <div key={review.mcpi} className="p-4 rounded" style={{ background: 'rgba(64, 130, 109, 0.1)' }}>
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <span className="text-sm font-medium" style={{ color: '#ffffff' }}>{review.mcpi}</span>
                          <div className="flex gap-1 flex-wrap">
                            {review.reasons.map(reason => (
                              <span key={reason} className="px-2 py-1 text-xs rounded" style={{ background: 'rgba(255, 107, 107, 0.2)', color: '#ff6b6b' }}>
                                {reason}
                              </span>
                            ))}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <ThemedSelect
                            value={review.state}
                            onChange={(state) => updateManualReview(review.mcpi, { 
                              state: state as ManualReviewState,
                              reviewedAt: state !== 'Pending' ? new Date().toISOString() : null
                            })}
                            options={[
                              { value: 'Pending', label: 'Pending' },
                              { value: 'Confirmed', label: 'Confirmed' },
                              { value: 'Needs Investigation', label: 'Needs Investigation' },
                              { value: 'Source Difference Accepted', label: 'Source Difference Accepted' },
                            ]}
                            className="w-fit px-2 py-1 text-xs rounded"
                          />
                        </div>
                      </div>
                      
                      <div className="grid grid-cols-4 gap-2 text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>
                        <div><span style={{ color: 'var(--soft-seafoam)' }}>Status:</span> {auditStatus}</div>
                        <div><span style={{ color: 'var(--soft-seafoam)' }}>GIS Acreage:</span> {gisAcreage.toFixed(2)}</div>
                        <div><span style={{ color: 'var(--soft-seafoam)' }}>Legal Acreage:</span> {legalAcreage.toFixed(2)}</div>
                        <div><span style={{ color: 'var(--soft-seafoam)' }}>Acreage Diff:</span> {acreagePctDiff.toFixed(1)}%</div>
                        <div><span style={{ color: 'var(--soft-seafoam)' }}>Address Count:</span> {addressCount}</div>
                        <div><span style={{ color: 'var(--soft-seafoam)' }}>Building Count:</span> {buildingCount}</div>
                        <div><span style={{ color: 'var(--soft-seafoam)' }}>Intersecting Streets:</span> {intersectingStreetCount}</div>
                        <div><span style={{ color: 'var(--soft-seafoam)' }}>Total Streets (100ft):</span> {totalStreetSegmentsWithin100ft}</div>
                        <div><span style={{ color: 'var(--soft-seafoam)' }}>Geometry Type:</span> {geometryType}</div>
                        <div><span style={{ color: 'var(--soft-seafoam)' }}>Ring Count:</span> {ringCount}</div>
                        <div><span style={{ color: 'var(--soft-seafoam)' }}>Total Points:</span> {totalPoints}</div>
                        <div><span style={{ color: 'var(--soft-seafoam)' }}>Reviewed At:</span> {review.reviewedAt ? new Date(review.reviewedAt).toLocaleString() : 'Not reviewed'}</div>
                      </div>
                      
                      {acreagePctDiff > 5 && (
                        <div className="mb-3 text-xs" style={{ color: '#fbbf24' }}>
                          GIS acreage and legal acreage may legitimately differ. This flag requires source review and does not automatically indicate incorrect data.
                        </div>
                      )}
                      
                      <div className="flex items-center gap-2 mb-3">
                        <input
                          type="text"
                          placeholder="Add review note..."
                          value={review.note}
                          onChange={(e) => updateManualReview(review.mcpi, { note: e.target.value })}
                          className="flex-1 px-2 py-1 text-xs rounded"
                          style={{ background: 'rgba(0, 0, 0, 0.3)', color: '#ffffff', border: '1px solid #40826D' }}
                        />
                      </div>
                      
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => copyMCPI(review.mcpi)}
                          className="px-3 py-1 text-xs rounded"
                          style={{ background: 'rgba(64, 130, 109, 0.3)', color: 'var(--seafoam)' }}
                        >
                          Copy MCPI
                        </button>
                        <button
                          onClick={() => openInMainMap(review.mcpi)}
                          className="px-3 py-1 text-xs rounded"
                          style={{ background: 'rgba(64, 130, 109, 0.3)', color: 'var(--seafoam)' }}
                        >
                          Open in Main Map
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Results Table */}
        {results.length > 0 && (
          <div className="rounded-lg border overflow-hidden" style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr style={{ background: 'rgba(64, 130, 109, 0.3)' }}>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--seafoam)' }}>
                      MCPI
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--seafoam)' }}>
                      Status
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--seafoam)' }}>
                      Acreage
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--seafoam)' }}>
                      Addresses
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--seafoam)' }}>
                      Buildings
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--seafoam)' }}>
                      Intersecting
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--seafoam)' }}>
                      Total (100ft)
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--seafoam)' }}>
                      Additional
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--seafoam)' }}>
                      Geometry
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--seafoam)' }}>
                      Duration
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--seafoam)' }}>
                      Warnings
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--seafoam)' }}>
                      Errors
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--seafoam)' }}>
                      Details
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((result) => (
                    <>
                      <tr
                        key={result.mcpi}
                        className="border-t hover:bg-opacity-50 transition-colors"
                        style={{ borderColor: 'rgba(64, 130, 109, 0.3)' }}
                      >
                        <td className="px-4 py-3 text-sm font-medium" style={{ color: '#ffffff' }}>
                          {result.mcpi}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            {getStatusIcon(result.status)}
                            <span className={`text-sm font-medium ${getStatusColor(result.status)}`}>
                              {result.status}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
                          {result.parcelInfo.gisAcreage.toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
                          {result.parcelInfo.addressCount}
                        </td>
                        <td className="px-4 py-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
                          {result.buildingInfo.buildingCount}
                        </td>
                        <td className="px-4 py-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
                          {result.streetInfo.intersectingSegmentCount}
                        </td>
                        <td className="px-4 py-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
                          {result.streetInfo.totalSegmentCountWithin100ft}
                        </td>
                        <td className="px-4 py-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
                          {result.streetInfo.additionalNearbyCount}
                        </td>
                        <td className="px-4 py-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
                          {result.parcelInfo.geometryType}
                        </td>
                        <td className="px-4 py-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
                          {result.generalInfo.totalAnalysisDuration}ms
                        </td>
                        <td className="px-4 py-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
                          {result.generalInfo.warnings.length}
                        </td>
                        <td className="px-4 py-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
                          {result.generalInfo.errors.length}
                        </td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => setExpandedRow(expandedRow === result.mcpi ? null : result.mcpi)}
                            className="p-1 rounded hover:bg-opacity-50 transition-colors"
                            style={{ color: 'var(--seafoam)' }}
                          >
                            {expandedRow === result.mcpi ? (
                              <ChevronDown className="w-5 h-5" />
                            ) : (
                              <ChevronRight className="w-5 h-5" />
                            )}
                          </button>
                        </td>
                      </tr>
                      {expandedRow === result.mcpi && (
                        <tr style={{ background: 'rgba(64, 130, 109, 0.1)' }}>
                          <td colSpan={13} className="px-4 py-4">
                            <div className="space-y-4">
                              {/* Fixture Match */}
                              {result.fixtureMatch && (
                                <div className="p-3 rounded-md" style={{ background: 'rgba(64, 130, 109, 0.2)', border: '1px solid #40826D' }}>
                                  <h4 className="text-sm font-medium mb-2" style={{ color: 'var(--seafoam)' }}>Fixture Comparison</h4>
                                  {result.fixtureMatch.overallMatch !== undefined && (
                                    <div className="mb-2 pb-2 border-b" style={{ borderColor: 'rgba(64, 130, 109, 0.3)' }}>
                                      <span style={{ color: 'var(--text-secondary)' }}>Overall: </span>
                                      <span className={`font-bold ${result.fixtureMatch.overallMatch ? 'text-green-400' : 'text-red-400'}`}>
                                        {result.fixtureMatch.overallMatch ? 'MATCH' : 'MISMATCH'}
                                      </span>
                                    </div>
                                  )}
                                  <div className="grid grid-cols-2 gap-2 text-sm">
                                    {result.fixtureMatch.expectedBuildings !== undefined && (
                                      <div>
                                        <span style={{ color: 'var(--text-secondary)' }}>Buildings: </span>
                                        <span style={{ color: result.fixtureMatch.expectedBuildings === result.fixtureMatch.actualBuildings ? '#93E9BE' : '#ff6b6b' }}>
                                          Expected: {result.fixtureMatch.expectedBuildings}, Actual: {result.fixtureMatch.actualBuildings}
                                          {result.fixtureMatch.expectedBuildings === result.fixtureMatch.actualBuildings ? ' ✓' : ' ✗'}
                                        </span>
                                      </div>
                                    )}
                                    {result.fixtureMatch.expectedIntersectingStreets !== undefined && (
                                      <div>
                                        <span style={{ color: 'var(--text-secondary)' }}>Intersecting: </span>
                                        <span style={{ color: result.fixtureMatch.expectedIntersectingStreets === result.fixtureMatch.actualIntersectingStreets ? '#93E9BE' : '#ff6b6b' }}>
                                          Expected: {result.fixtureMatch.expectedIntersectingStreets}, Actual: {result.fixtureMatch.actualIntersectingStreets}
                                          {result.fixtureMatch.expectedIntersectingStreets === result.fixtureMatch.actualIntersectingStreets ? ' ✓' : ' ✗'}
                                        </span>
                                      </div>
                                    )}
                                    {result.fixtureMatch.expectedTotalStreets !== undefined && (
                                      <div>
                                        <span style={{ color: 'var(--text-secondary)' }}>Total (100ft): </span>
                                        <span style={{ color: result.fixtureMatch.expectedTotalStreets === result.fixtureMatch.actualTotalStreets ? '#93E9BE' : '#ff6b6b' }}>
                                          Expected: {result.fixtureMatch.expectedTotalStreets}, Actual: {result.fixtureMatch.actualTotalStreets}
                                          {result.fixtureMatch.expectedTotalStreets === result.fixtureMatch.actualTotalStreets ? ' ✓' : ' ✗'}
                                        </span>
                                      </div>
                                    )}
                                    {result.fixtureMatch.expectedAdditionalStreets !== undefined && (
                                      <div>
                                        <span style={{ color: 'var(--text-secondary)' }}>Additional: </span>
                                        <span style={{ color: result.fixtureMatch.expectedAdditionalStreets === result.fixtureMatch.actualAdditionalStreets ? '#93E9BE' : '#ff6b6b' }}>
                                          Expected: {result.fixtureMatch.expectedAdditionalStreets}, Actual: {result.fixtureMatch.actualAdditionalStreets}
                                          {result.fixtureMatch.expectedAdditionalStreets === result.fixtureMatch.actualAdditionalStreets ? ' ✓' : ' ✗'}
                                        </span>
                                      </div>
                                    )}
                                    {result.fixtureMatch.expectedAddress !== undefined && (
                                      <div className="col-span-2">
                                        <span style={{ color: 'var(--text-secondary)' }}>Address: </span>
                                        <span style={{ color: result.fixtureMatch.expectedAddress === result.fixtureMatch.actualAddress ? '#93E9BE' : '#ff6b6b' }}>
                                          Expected: {result.fixtureMatch.expectedAddress}, Actual: {result.fixtureMatch.actualAddress}
                                          {result.fixtureMatch.expectedAddress === result.fixtureMatch.actualAddress ? ' ✓' : ' ✗'}
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}

                              {/* Parcel Details */}
                              <div>
                                <h4 className="text-sm font-medium mb-2" style={{ color: 'var(--seafoam)' }}>Parcel Details</h4>
                                <div className="grid grid-cols-2 gap-2 text-sm">
                                  <div><span style={{ color: 'var(--text-secondary)' }}>Subdivision:</span> <span style={{ color: '#ffffff' }}>{result.parcelInfo.subdivision}</span></div>
                                  <div><span style={{ color: 'var(--text-secondary)' }}>Plat Number:</span> <span style={{ color: '#ffffff' }}>{result.parcelInfo.platNumber}</span></div>
                                  <div><span style={{ color: 'var(--text-secondary)' }}>Plat Lot:</span> <span style={{ color: '#ffffff' }}>{result.parcelInfo.platLot}</span></div>
                                  <div><span style={{ color: 'var(--text-secondary)' }}>Parcel Type:</span> <span style={{ color: '#ffffff' }}>{result.parcelInfo.parcelType}</span></div>
                                  <div><span style={{ color: 'var(--text-secondary)' }}>Ring Count:</span> <span style={{ color: '#ffffff' }}>{result.parcelInfo.ringCount}</span></div>
                                  <div><span style={{ color: 'var(--text-secondary)' }}>Total Points:</span> <span style={{ color: '#ffffff' }}>{result.parcelInfo.totalPointCount}</span></div>
                                  <div><span style={{ color: 'var(--text-secondary)' }}>Has Holes:</span> <span style={{ color: '#ffffff' }}>{result.parcelInfo.hasHoles ? 'Yes' : 'No'}</span></div>
                                  <div><span style={{ color: 'var(--text-secondary)' }}>Is Multipart:</span> <span style={{ color: '#ffffff' }}>{result.parcelInfo.isMultipart ? 'Yes' : 'No'}</span></div>
                                </div>
                              </div>

                              {/* Building Details */}
                              <div>
                                <h4 className="text-sm font-medium mb-2" style={{ color: 'var(--seafoam)' }}>Building Query</h4>
                                <div className="text-sm">
                                  <div><span style={{ color: 'var(--text-secondary)' }}>State:</span> <span style={{ color: '#ffffff' }}>{result.buildingInfo.queryState}</span></div>
                                  <div><span style={{ color: 'var(--text-secondary)' }}>Duration:</span> <span style={{ color: '#ffffff' }}>{result.buildingInfo.queryDuration}ms</span></div>
                                  {result.buildingInfo.errorMessage && (
                                    <div><span style={{ color: 'var(--text-secondary)' }}>Error:</span> <span style={{ color: '#ff6b6b' }}>{result.buildingInfo.errorMessage}</span></div>
                                  )}
                                </div>
                              </div>

                              {/* Street Details */}
                              <div>
                                <h4 className="text-sm font-medium mb-2" style={{ color: 'var(--seafoam)' }}>Street Queries</h4>
                                <div className="text-sm">
                                  <div><span style={{ color: 'var(--text-secondary)' }}>Intersecting State:</span> <span style={{ color: '#ffffff' }}>{result.streetInfo.intersectingQueryState}</span></div>
                                  <div><span style={{ color: 'var(--text-secondary)' }}>Unique Intersecting Names:</span> <span style={{ color: '#ffffff' }}>{result.streetInfo.uniqueIntersectingNames.join(', ')}</span></div>
                                  <div><span style={{ color: 'var(--text-secondary)' }}>Unique Names (100ft):</span> <span style={{ color: '#ffffff' }}>{result.streetInfo.uniqueNamesWithin100ft.join(', ')}</span></div>
                                  <div><span style={{ color: 'var(--text-secondary)' }}>Durations:</span> <span style={{ color: '#ffffff' }}>{result.streetInfo.queryDurations.join('ms, ')}ms</span></div>
                                  {result.streetInfo.errorMessages.length > 0 && (
                                    <div><span style={{ color: 'var(--text-secondary)' }}>Errors:</span> <span style={{ color: '#ff6b6b' }}>{result.streetInfo.errorMessages.join(', ')}</span></div>
                                  )}
                                </div>
                              </div>

                              {/* Warnings */}
                              {result.generalInfo.warnings.length > 0 && (
                                <div>
                                  <h4 className="text-sm font-medium mb-2" style={{ color: 'var(--seafoam)' }}>Warnings</h4>
                                  <ul className="list-disc list-inside text-sm space-y-1">
                                    {result.generalInfo.warnings.map((warning, idx) => (
                                      <li key={idx} style={{ color: '#f59e0b' }}>{warning}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}

                              {/* Errors */}
                              {result.generalInfo.errors.length > 0 && (
                                <div>
                                  <h4 className="text-sm font-medium mb-2" style={{ color: 'var(--seafoam)' }}>Errors</h4>
                                  <ul className="list-disc list-inside text-sm space-y-1">
                                    {result.generalInfo.errors.map((error, idx) => (
                                      <li key={idx} style={{ color: '#ff6b6b' }}>{error}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
