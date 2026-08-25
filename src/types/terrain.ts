// Terrain evidence types for SubDivMaker V2 Phase 2E.
// These are conceptual early-stage terrain estimates, not survey-grade elevations.

export interface TerrainContour {
  type: 'Feature'
  geometry: GeoJSON.LineString
  properties: {
    OBJECTID: number
    elevationFt: number
    contourType?: string
    updateDate?: string
  }
}

export interface TerrainData {
  mcpi: string
  coverageAvailable: boolean
  contourCount: number
  minElevationFt: number | null
  maxElevationFt: number | null
  elevationRangeFt: number | null
  contours: TerrainContour[]
  source: string
  warnings: string[]
  fetchError?: string
}

export interface TerrainSample {
  coordinate: number[] // [longitude, latitude]
  elevationFt: number | null
  confidence: 'HIGH' | 'MODERATE' | 'LOW' | 'UNAVAILABLE'
  nearestContourDistanceFt: number
  lowerContourFt: number | null
  upperContourFt: number | null
}

export interface TerrainProfilePoint extends TerrainSample {
  distanceAlongRoadFt: number
}

export interface TerrainProfile {
  sampleSpacingFt: number
  points: TerrainProfilePoint[]
}

export type TerrainAssessment = 'FAVORABLE' | 'MODERATE' | 'CHALLENGING' | 'INSUFFICIENT_DATA'

export interface RoadTerrainProfile {
  roadId: string
  roadType: 'primary' | 'secondary'
  street: string | null
  roadLengthFt: number
  profileSampleCount: number
  terrainCoveragePercent: number
  startElevationFt: number | null
  endElevationFt: number | null
  minElevationFt: number | null
  maxElevationFt: number | null
  totalElevationChangeFt: number
  netElevationChangeFt: number
  averageGradePercent: number
  maximumSegmentGradePercent: number
  steepSegmentCount: number
  terrainAssessment: TerrainAssessment
  terrainAssessmentReason: string
  profile: TerrainProfile
  confidence: 'HIGH' | 'MODERATE' | 'LOW' | 'UNAVAILABLE'
}

export type TerrainRoadAlternativeFamily =
  | 'BASELINE'
  | 'TERRAIN_LEFT'
  | 'TERRAIN_RIGHT'
  | 'TERRAIN_INTERIOR'
  | 'CONSTRAINT_ADJUSTED'
  | 'ADAPTIVE_1'
  | 'ADAPTIVE_2'

export interface TerrainRoutingMetrics {
  roadLengthFt: number
  straightLineLengthFt: number
  routeEfficiencyRatio: number
  bendCount: number
  maxDeflectionAngle: number
  totalAbsoluteDeflection: number
  initialTangentLengthFt: number
  averageGradePercent: number
  maximumSegmentGradePercent: number
  steepSegmentCount: number
  totalElevationChangeFt: number
  netElevationChangeFt: number
  terrainCoveragePercent: number
  terrainConfidence: 'HIGH' | 'MODERATE' | 'LOW' | 'UNAVAILABLE'
  terrainAssessment: TerrainAssessment
  servedDevelopableAreaSqFt: number
  componentServiceRatio: number
}

export interface TerrainRoadAlternative {
  id: string
  family: TerrainRoadAlternativeFamily
  hardValid: boolean
  rejectionReason: string | null
  centerline: GeoJSON.Feature<GeoJSON.LineString>
  rightOfWay: GeoJSON.Feature<GeoJSON.Geometry> | null
  residual: GeoJSON.Feature<GeoJSON.Geometry> | null
  lengthFt: number
  terrainProfile: RoadTerrainProfile
  metrics: TerrainRoutingMetrics
  selected: boolean
  terrainRoadMode?: 'CONTOUR_FOLLOWING' | 'FALL_LINE' | 'DIRECT_FALLBACK'
  terrainAlignmentScore?: number | null
  roadPrecedentScore?: number | null
  roadPrecedentPattern?: 'CONTOUR_DOMINANT' | 'FALL_LINE_DOMINANT' | 'GRID_ORTHOGONAL' | 'CURVILINEAR' | 'MIXED' | 'INSUFFICIENT_DATA'
  roadPrecedentConfidence?: 'HIGH' | 'MODERATE' | 'LOW' | 'UNAVAILABLE'
  rejectionCategory?: string
}

export interface PrimaryRoadRowSafety {
  primaryRowWidthFt: number
  requiredCenterlineInsetFt: number
  safeCenterlineAreaAvailable: boolean
  safeCenterlineMethod: 'NEGATIVE_BUFFER' | 'BOUNDARY_DISTANCE_FALLBACK' | 'UNAVAILABLE'
  safeCenterlineAreaGeometryType: string | null
  safeCenterlineAreaSqFt: number | null
  safeCenterlineFailureReason: string | null
}

export interface TerrainRoadAlternativeResult {
  mcpi: string
  baseline: TerrainRoadAlternative
  alternatives: TerrainRoadAlternative[]
  selected: TerrainRoadAlternative
  selectionReason: string
  fallbackReason: 'TERRAIN_DATA_UNAVAILABLE' | 'SAFE_CENTERLINE_AREA_UNAVAILABLE' | 'NO_VALID_TERRAIN_CANDIDATES' | 'TERRAIN_CANDIDATES_MATERIALLY_INFERIOR' | null
  fallbackReasonDetail: string | null
  rowSafety: PrimaryRoadRowSafety
  waypointInventory?: any
  routeSearch?: any
}

export type TerrainSuitabilityClass = 'PREFERRED' | 'MODERATE' | 'CHALLENGING' | 'AVOID' | 'INSUFFICIENT_DATA'

export interface TerrainSuitabilityCellProperties {
  terrainClass: TerrainSuitabilityClass
  slopePct: number | null
  elevationFt: number | null
  confidence: TerrainSample['confidence'] | null
  conceptualOnly: true
}

export interface TerrainSuitabilityAudit {
  mcpi: string
  candidateAreaAcres: number
  requestedSampleSpacingFt: number
  effectiveSampleSpacingFt: number
  sampledPointCount: number
  validSampleCount: number
  unavailableSampleCount: number
  preferredAreaAcres: number
  moderateAreaAcres: number
  challengingAreaAcres: number
  avoidAreaAcres: number
  insufficientDataAreaAcres: number
  preferredPercent: number
  moderatePercent: number
  challengingPercent: number
  avoidPercent: number
  insufficientDataPercent: number
  meanSlopePct: number | null
  medianSlopePct: number | null
  maxSlopePct: number | null
  dominantClass: TerrainSuitabilityClass
  cacheHit: boolean
  processingMs: number
  percentReconciliation: number
  invariantRespected: boolean
  gridGenerationMs: number
  terrainSamplingMs: number
  slopeComputationMs: number
  cellGeometryMs: number
  areaAggregationMs: number
  totalProcessingMs: number
  terrainSampleRequests: number
  uniqueTerrainSamplePoints: number
  terrainCacheHits: number
  terrainCacheMisses: number
  terrainCacheHitPercent: number
  contourFeatureCount: number
  boundaryCellCount: number
  interiorCellCount: number
  clippedCellCount: number
}

export interface TerrainSuitabilityResult {
  mcpi: string
  status: 'completed' | 'skipped' | 'failed'
  sampleSpacingFt: number
  sampledPointCount: number
  validSampleCount: number
  unavailableSampleCount: number
  preferredAreaAcres: number
  moderateAreaAcres: number
  challengingAreaAcres: number
  avoidAreaAcres: number
  insufficientDataAreaAcres: number
  preferredPercent: number
  moderatePercent: number
  challengingPercent: number
  avoidPercent: number
  insufficientDataPercent: number
  dominantClass: TerrainSuitabilityClass
  maxSampledSlopePct: number | null
  meanSampledSlopePct: number | null
  medianSampledSlopePct: number | null
  suitabilityFeatures: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, TerrainSuitabilityCellProperties>
  audit: TerrainSuitabilityAudit
}

export interface TerrainPointQueryResult {
  available: boolean
  class: TerrainSuitabilityClass
  slopePct: number | null
  elevationFt: number | null
  confidence: TerrainSample['confidence'] | null
  sourceCellIndex: number | null
}

export interface TerrainGeometryQueryResult {
  available: boolean
  preferredPercent: number
  moderatePercent: number
  challengingPercent: number
  avoidPercent: number
  insufficientDataPercent: number
  dominantClass: TerrainSuitabilityClass
  meanSlopePct: number | null
  maxSlopePct: number | null
  sampledCellCount: number
  intersectedCellCount: number
}

export interface TerrainLineQueryResult {
  available: boolean
  preferredFraction: number
  moderateFraction: number
  challengingFraction: number
  avoidFraction: number
  insufficientDataFraction: number
  dominantClass: TerrainSuitabilityClass
  meanSlopePct: number | null
  maxSlopePct: number | null
  sampleCount: number
  sampleSpacingFt: number
}

export interface TerrainPlacementEvaluation {
  available: boolean
  dominantClass: TerrainSuitabilityClass
  preferredPercent: number
  moderatePercent: number
  challengingPercent: number
  avoidPercent: number
  insufficientDataPercent: number
  placementScore: number
  avoidRejection: boolean
  warning?: string
}

export interface PrimaryRoadTerrainScoring {
  available: boolean
  dominantClass: TerrainSuitabilityClass
  preferredFraction: number
  moderateFraction: number
  challengingFraction: number
  avoidFraction: number
  insufficientDataFraction: number
  meanSlopePct: number | null
  maxSlopePct: number | null
  terrainRoadScore: number
  rawWeightedScore: number
  slopePenalty: number
  avoidPenalty: number
  sampleCount: number
  queryMs: number
}
