import type { ConceptualDevelopmentLayoutResult } from '../services/conceptualDevelopmentLayout'

export type LocalStreetStatus = 'generated' | 'empty' | 'unavailable'
export type LocalStreetStopReason =
  | 'NO_BASELINE_ACCESS'
  | 'NO_CANDIDATE_ORIGINS'
  | 'NO_TARGET_BLOCKS'
  | 'NO_VALID_CANDIDATES'
  | 'NO_MARGINAL_BENEFIT'
  | 'MAX_LOCAL_STREETS_REACHED'
  | 'INSUFFICIENT_REMAINING_PROGRAMMABLE'
  | 'HYDROLOGY_CROSSING_REQUIRED'

export interface ConceptualLocalStreet {
  id: string
  originRoadId: string
  originRoadType: 'primary' | 'secondary' | 'existing'
  centerlineGeometry: GeoJSON.Feature<GeoJSON.LineString>
  rightOfWayGeometry: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>
  lengthFt: number
  rightOfWayWidthFt: number
  rowAreaAcres: number
  targetBlockId: string
  bendCount: number
  terrainInfluence: 'USED' | 'INSUFFICIENT_DATA'
  terrainRoadScore?: number
  terrainPenalty?: number
  localGrammarPenalty?: number
  terrainSuitabilityScoring?: import('./terrain').PrimaryRoadTerrainScoring | null
  conflictCounts: {
    buildings: number
    hydrology: number
    pavement: number
    parcelBoundary: number
    otherRoadRow: number
  }
  selectionReason: string
}

export interface LocalStreetCandidate {
  id: string
  originRoadId: string
  originRoadType: 'primary' | 'secondary'
  originType: 'secondary-node' | 'secondary-segment' | 'secondary-endpoint' | 'primary-segment'
  targetBlockId: string
  centerlineGeometry: GeoJSON.Feature<GeoJSON.LineString>
  rightOfWayGeometry: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>
  lengthFt: number
  rightOfWayWidthFt: number
  rowAreaAcres: number
  bendCount: number
  newTrueFrontageFt: number
  estimatedNewServedAreaAcres: number
  existingScore?: number
  terrainRoadScore?: number
  terrainPenalty?: number
  localGrammarPenalty?: number
  finalScore?: number
  terrainSuitabilityScoring?: import('./terrain').PrimaryRoadTerrainScoring | null
  accepted: boolean
  rejectionReason: LocalStreetStopReason | string
  conflictCounts: ConceptualLocalStreet['conflictCounts']
  terrainInfluence: 'USED' | 'INSUFFICIENT_DATA'
}

export interface LocalStreetMarginalBenefit {
  candidateId: string
  baselineLotCount: number
  finalLotCount: number
  incrementalLots: number
  baselineDrawableCapacity: number
  finalDrawableCapacity: number
  incrementalDrawableCapacity: number
  baselineLayoutAreaAcres: number
  finalLayoutAreaAcres: number
  incrementalLayoutAreaAcres: number
  baselineUnusedProgrammableAcres: number
  finalUnusedProgrammableAcres: number
  newlyUsedProgrammableAcres: number
  newTrueFrontageFt: number
  roadLengthFt: number
  roadEfficiencyLotsPer100Ft: number
  roadEfficiencyFrontagePerFt: number
}

export interface LocalStreetCandidateAudit {
  id: string
  originRoad: string
  originType: string
  targetBlockId: string
  roadLengthFt: number
  bendCount: number
  rowAreaAcres: number
  newTrueFrontageFt: number
  newlyServedAreaAcres: number
  additionalDrawableUnits: number
  additionalPads: number
  newlyUsedLayoutAreaAcres: number
  efficiency: number
  terrainAssessment: 'USED' | 'INSUFFICIENT_DATA'
  conflictCounts: ConceptualLocalStreet['conflictCounts']
  accepted: boolean
  rejectionReason: string
  score: number
}

export interface LocalStreetSelectionAuditItem {
  iteration: number
  selectedCandidateId: string
  origin: string
  targetBlock: string
  roadLengthFt: number
  newFrontageFt: number
  newDrawableUnits: number
  newUsedAcres: number
  remainingUnusedAcres: number
  marginalEfficiency: number
  selectionReason: string
}

export interface LocalStreetNetworkResult {
  mcpi: string
  status: LocalStreetStatus
  localStreetCount: number
  totalLocalStreetLengthFt: number
  localRowAreaAcres: number
  baselineLotCount: number
  finalLotCount: number
  baselineDrawableCapacity: number
  finalDrawableCapacity: number
  incrementalDrawableCapacity: number
  baselineLayoutAreaAcres: number
  finalLayoutAreaAcres: number
  incrementalLayoutAreaAcres: number
  baselineUnusedProgrammableAcres: number
  finalUnusedProgrammableAcres: number
  totalNewTrueFrontageFt: number
  stopReason: LocalStreetStopReason
  localStreets: ConceptualLocalStreet[]
  candidateAudits: LocalStreetCandidateAudit[]
  selectionAudits: LocalStreetSelectionAuditItem[]
  warnings: string[]
}

export interface LocalStreetExpansionResult {
  localStreetNetworkResult: LocalStreetNetworkResult
  finalLayout: ConceptualDevelopmentLayoutResult
}
