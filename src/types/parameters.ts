// Parameter data model for SubDivMaker V2 Phase 1

import type { ConceptualAccessAssessment } from '../services/conceptualAccessSuitability'
import type { RoadTerrainProfile, PrimaryRoadTerrainScoring } from './terrain'

export type ProjectMode = 
  | 'greenfield'
  | 'infill'
  | 'selective-redevelopment'
  | 'full-redevelopment'

export type BuildingTreatment = 
  | 'preserve-all'
  | 'select-individually'
  | 'allow-removal'
  | 'remove-all'

export type RoadTreatment = 
  | 'preserve-all'
  | 'extend-existing'
  | 'select-modify'
  | 'complete-redesign'

export type RoadNetworkPreference = 
  | 'connected-grid'
  | 'modified-grid'
  | 'loop-road'
  | 'loop-culdesacs'
  | 'branching'
  | 'minimize-new'
  | 'extend-existing'
  | 'propose-alternatives'

export type ParkingType = 
  | 'surface'
  | 'garage'
  | 'structured'
  | 'on-street'
  | 'mixed'

export type Priority = 'low' | 'medium' | 'high'

export type StandardsSource = 
  | 'detected-zoning'
  | 'custom'
  | 'detected-with-overrides'

export interface DevelopmentUse {
  id: string
  category: 'residential' | 'commercial' | 'civic'
  useType: string
  enabled: boolean
  targetCount?: number
  minCount?: number
  maxCount?: number
  priority: Priority
  notes?: string
}

export interface ExistingFeaturePreferences {
  buildingTreatment: BuildingTreatment
  roadTreatment: RoadTreatment
  preserveParking: boolean
  preservePonds: boolean
  preserveStreams: boolean
  preserveParks: boolean
  preserveTreeCover: boolean
  preserveUtilities: boolean
}

export type DevelopmentApproach = 'NEW_DEVELOPMENT' | 'REDEVELOPMENT'

export type RedevelopmentBuildingTreatment =
  | 'PRESERVE_ALL'
  | 'SELECTIVE_REPLACEMENT'
  | 'BROAD_REDEVELOPMENT'

export type RedevelopmentPavementTreatment =
  | 'PRESERVE_ALL'
  | 'SELECTIVE_RECONFIGURATION'
  | 'BROAD_REDEVELOPMENT'

export type RedevelopmentInternalRoadTreatment =
  | 'PRESERVE_ACCESS'
  | 'ALLOW_RECONFIGURATION'

export interface RedevelopmentPreferences {
  buildingTreatment: RedevelopmentBuildingTreatment
  pavementTreatment: RedevelopmentPavementTreatment
  internalRoadTreatment: RedevelopmentInternalRoadTreatment
}

export interface BuildingClassificationResult {
  buildingTreatment: RedevelopmentBuildingTreatment | null
  totalBuildingCount: number
  preservedBuildingCount: number
  redevelopmentEligibleBuildingCount: number
  preservedBuildingObjectIds: (string | number)[]
  redevelopmentEligibleObjectIds: (string | number)[]
  preservedBuildingReasons: string[]
  redevelopmentEligibleBuildingReasons: string[]
  largestBuildingAreaSqFt: number
  preservedBuildingAreaSqFt: number
  redevelopmentEligibleBuildingAreaSqFt: number
}

export interface ZoningLotParameters {
  standardsSource: StandardsSource
  minLotArea?: number // square feet
  minLotWidth?: number // feet
  minFrontage?: number // feet
  frontSetback?: number // feet
  rearSetback?: number // feet
  sideSetback?: number // feet
  maxLotCoverage?: number // percentage
  floorAreaRatio?: number
  maxBuildingHeight?: number // feet
  maxStories?: number
  buildingFootprintPreference?: string
  buildingSeparation?: number // feet
  targetDensity?: number // units per acre
}

export interface RoadParameters {
  networkPreference: RoadNetworkPreference
  rightOfWayWidth?: number // feet
  pavementWidth?: number // feet
  designSpeed?: number // mph
  maxRoadGrade?: number // percentage
  crossSlope?: number // percentage
  minCenterlineRadius?: number // feet
  curbReturnRadius?: number // feet
  culdesacRadius?: number // feet
  sidewalkWidth?: number // feet
  trailWidth?: number // feet
  onStreetParking?: boolean
  roadsidePlantingStrip?: boolean
  externalConnections?: number
  prioritizeExistingConnections: boolean
  avoidSteepSlopes: boolean
  minimizeStreamCrossings: boolean
  minimizeTotalPavement: boolean
  emergencyAccessPreference: Priority
}

export interface ParkingParameters {
  parkingType: ParkingType
  spacesPerResidentialUnit?: number
  spacesPer1000CommercialSqft?: number
  accessibleSpaceTarget?: number
  garagePreference?: string
  surfaceParkingMax?: number // percentage
  sharedParkingAllowed: boolean
  bicycleParking?: boolean
  evReadyPercentage?: number // percentage
}

export interface AmenityParameters {
  minOpenSpaceAcreage?: number
  minOpenSpacePercentage?: number
  park: boolean
  playground: boolean
  trailNetwork: boolean
  communityGreen: boolean
  retentionPond: boolean
  detentionFacility: boolean
  bioretention: boolean
  preservedForest: boolean
  landscapingBuffer: boolean
  treeCanopyTarget?: number // percentage
  streamBuffer: boolean
  wetlandBuffer: boolean
}

export interface TerrainDetectedValues {
  minElevation?: number
  maxElevation?: number
  totalRelief?: number
  averageSlope?: number
  maxSlope?: number
  steepSlopeArea?: number // acres
  floodplainOverlap?: number // acres
  streamOverlap?: number // acres
  waterBodyOverlap?: number // acres
  existingBuildingCoverage?: number // percentage
  existingImperviousCoverage?: number // percentage
}

export interface TerrainConstraintPreferences {
  detected: TerrainDetectedValues
  maxDevelopableSlope?: number // percentage
  maxPreferredRoadGrade?: number // percentage
  avoidFloodplain: boolean
  avoidWetlands: boolean
  avoidStreams: boolean
  avoidSteepSlopes: boolean
  minimizeCutAndFill: boolean
  balanceCutAndFill: boolean
  preserveLowImpactAreas: boolean
}

export interface GenerationPriorities {
  maxUnitYield: Priority
  minGrading: Priority
  minRoadLength: Priority
  maxOpenSpace: Priority
  preserveExistingDevelopment: Priority
  walkability: Priority
  roadConnectivity: Priority
  stormwaterEfficiency: Priority
  buildingViewsOrientation: Priority
  lowestConstructionImpact: Priority
}

export type EligibilityState = 
  | 'analysis-required'
  | 'potential-candidate'
  | 'no-meaningful-developable-area'
  | 'constraints-prevent-development'
  | 'developable-area-identified'

export type QueryState = 
  | 'idle'
  | 'loading'
  | 'success'
  | 'success-zero'
  | 'error'
  | 'aborted'
  | 'truncated'

export interface ExistingConditionsData {
  mcpi?: string
  selectionRequestId?: number
  buildings: {
    state: QueryState
    mcpi?: string
    selectionRequestId?: number
    count: number
    features: any[]
    timestamp?: string
    error?: string
  }
  intersectingStreets: {
    state: QueryState
    mcpi?: string
    selectionRequestId?: number
    count: number
    features: any[]
    uniqueNames: string[]
    timestamp?: string
    error?: string
  }
  nearbyStreets: {
    state: QueryState
    mcpi?: string
    selectionRequestId?: number
    count: number
    additionalCount: number
    features: any[]
    uniqueNames: string[]
    timestamp?: string
    error?: string
  }
  hydrology: {
    state: QueryState
    mcpi?: string
    selectionRequestId?: number
    count: number
    waterFeatureCount: number
    wetlandFeatureCount: number
    streamDrainCount: number
    hydrologyCoverageAvailable: boolean
    features: any
    timestamp?: string
    error?: string
  }
  pavement: {
    state: QueryState
    mcpi?: string
    selectionRequestId?: number
    count: number
    parkingLotFeatureCount: number
    drivewayFeatureCount: number
    pavementCoverageAvailable: boolean
    features: any
    timestamp?: string
    error?: string
  }
  parcelBoundary: {
    state: QueryState
    mcpi?: string
    selectionRequestId?: number
    parcelAreaAcres?: number
    timestamp?: string
    error?: string
  }
  analysisTimestamp: string
}

export interface SelectedSiteInfo {
  mcpi: string
  selectionRequestId?: number
  addresses: string[]
  gisAcreage?: number
  legalAcreage?: number
  subdivision?: string
  platNumber?: string
  platLot?: string
  parcelType?: string
  geometryStatus: string
  hasParcel: boolean
  eligibilityState: EligibilityState
  existingConditions?: ExistingConditionsData
}

export interface ProjectParameters {
  schemaVersion: 1
  parcelId: string
  projectMode: ProjectMode
  developmentApproach: DevelopmentApproach
  redevelopment: RedevelopmentPreferences
  existingFeatures: ExistingFeaturePreferences
  developmentProgram: DevelopmentUse[]
  zoningAndLots: ZoningLotParameters
  roads: RoadParameters
  parking: ParkingParameters
  amenities: AmenityParameters
  terrainConstraints: TerrainConstraintPreferences
  priorities: GenerationPriorities
  notes: string
  updatedAt: string
}

export type CandidateOpenAreaStatus = 'loaded' | 'warning' | 'empty' | 'failed'

export interface CandidateOpenAreaResult {
  mcpi: string
  analysisRunId: number
  status: 'loaded' | 'warning' | 'empty' | 'failed'
  parcelAreaSqFt: number
  parcelAreaAcres: number
  gisAcreage: number | null
  buildingAreaSqFt: number
  buildingAreaAcres: number
  roadAreaSqFt: number
  roadAreaAcres: number
  buildingRoadOverlapSqFt: number
  totalLockedAreaSqFt: number
  totalLockedAreaAcres: number
  candidateAreaSqFt: number
  candidateAreaAcres: number
  candidatePercent: number
  componentCount: number
  largestComponentSqFt: number
  largestComponentAcres: number
  smallestComponentSqFt: number
  geometryType: 'Polygon' | 'MultiPolygon' | 'Empty'
  totalPointCount: number
  roadHalfWidthFeet: number
  conservationDifferenceSqFt: number
  conservationWithinTolerance: boolean
  warnings: string[]
  errors: string[]
  calculatedAt: string
  buildingClassification?: BuildingClassificationResult
  candidateGeometry?: GeoJSON.Feature<GeoJSON.Geometry>
  buildingUnionGeometry?: GeoJSON.Feature<GeoJSON.Geometry>
  roadCorridorGeometry?: GeoJSON.Feature<GeoJSON.Geometry>
  hydrologyGeometry?: GeoJSON.Feature<GeoJSON.Geometry>
  hydrologyAreaSqFt: number
  hydrologyAreaAcres: number
  hydrologyCoverageAvailable: boolean
  waterFeatureCount: number
  wetlandFeatureCount: number
  streamFeatureCount: number
  pavementGeometry?: GeoJSON.Feature<GeoJSON.Geometry>
  pavementAreaSqFt: number
  pavementAreaAcres: number
  parkingLotFeatureCount: number
  drivewayFeatureCount: number
  pavementFeatureCount: number
  pavementCoverageAvailable: boolean
  hydrologyConstraintResult?: HydrologyConstraintResult
}

export type HydrologyConstraintClass =
  | 'OPEN_WATER_HARD_AVOID'
  | 'MAJOR_WATERWAY_CORRIDOR'
  | 'STREAM_CORRIDOR'
  | 'WETLAND_HIGH_CONSTRAINT'
  | 'UNCERTAIN_HYDROLOGY'

export interface ClassifiedHydrologyFeature {
  source: 'water' | 'wetland' | 'stream'
  constraintClass: HydrologyConstraintClass
  rawProperties: Record<string, any>
  feature: GeoJSON.Feature
}

export interface HydrologyConstraintResult {
  combinedHardObstacleGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null
  waterBodiesGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null
  wetlandsGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null
  streamCorridorGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null
  classifiedFeatures: ClassifiedHydrologyFeature[]
  waterBodyCount: number
  wetlandCount: number
  streamFeatureCount: number
  classCounts: Record<HydrologyConstraintClass, number>
  distinctWaterBodyTypes: (string | number | null | undefined)[]
  distinctWetlandTypes: (string | number | null | undefined)[]
  distinctDrainTypes: (string | number | null | undefined)[]
  distinctDrainClasses: (string | number | null | undefined)[]
}

// Submitted parameter snapshot for tracking analysis inputs
export interface SubmittedParameters {
  parameters: ProjectParameters
  mcpi: string
  analysisRunId: number
  submittedAt: string
}

export type ConceptualRoadSkeletonStatus =
  | 'generated'
  | 'warning'
  | 'empty'
  | 'failed'

export interface ConceptualRoadSkeletonResult {
  status: ConceptualRoadSkeletonStatus
  mcpi: string
  analysisRunId: number
  generationRunId: number
  generatedAt: string
  templateName: string
  candidateComponentUsed: {
    index: number
    areaSqFt: number
    areaAcres: number
  }
  proposedAccessPoint: GeoJSON.Feature<GeoJSON.Point> | null
  proposedRoadCenterline: GeoJSON.Feature<GeoJSON.LineString> | null
  proposedRightOfWay: GeoJSON.Feature<GeoJSON.Geometry> | null
  residualDevelopmentArea: GeoJSON.Feature<GeoJSON.Geometry> | null
  proposedRoadLengthFeet: number
  proposedRightOfWayWidthFeet: number
  candidateAreaAcres: number
  rightOfWayAreaAcres: number
  residualDevelopmentAreaAcres: number
  warnings: string[]
  errorMessage: string | null
  buildingIntersectionCount?: number
  rightOfWayBuildingIntersectionCount?: number
  validObstacleClearanceMeters?: number
  connectionType?: string
  connectionStreetName?: string | null
  connectionMethod?: 'internal-stub' | 'internal-T-intersection' | 'adjacent' | 'nearby' | 'existing-intersection'
  initialDepartureAngle?: number
  rawIntersectionAngle?: number
  tIntersectionAngleError?: number
  routeEfficiencyRatio?: number
  nearParallelFraction?: number
  targetBearingError?: number
  initialRouteBearingError?: number
  interiorTarget?: GeoJSON.Feature<GeoJSON.Point>
  connectionGroup?: 'internal' | 'adjacent' | 'nearby' | 'existing'
  networkDegree?: number
  networkContinuity?: 'STRONG' | 'MODERATE' | 'WEAK'
  distanceToNearestIntersectionFt?: number
  trueStub?: boolean
  accessPointScore?: number
  roadDesignScore?: number
  availablePenetrationMeters?: number
  averageCorridorWidthMeters?: number
  servedDevelopableAreaSqFt?: number
  edgePocketPenalty?: number
  accessCandidatesTested?: number
  waterIntersectionCount?: number
  rightOfWayWaterIntersectionCount?: number
  hydrologyObstaclesGeometry?: GeoJSON.Feature<GeoJSON.Geometry>
  pavementIntersectionCount?: number
  rightOfWayPavementIntersectionCount?: number
  pavementObstaclesGeometry?: GeoJSON.Feature<GeoJSON.Geometry>
  componentServiceRatio?: number
  penetrationRatio?: number
  achievedPenetrationMeters?: number
  initialTangentLengthFeet?: number
  desiredTangentFt?: number
  preferredMinimumTangentFt?: number
  availableStraightTangentFt?: number
  actualTangentFt?: number
  tangentLimitingReason?: string
  tangentLimitingObstacleType?: string
  tangentDesiredMet?: boolean
  tangentMinimumMet?: boolean
  initialPointInside?: boolean
  initialPointInsideStrict?: boolean
  initialPointOnBoundary?: boolean
  initialPointDistanceToFreeSpaceBoundaryMeters?: number
  tangentStepAudits?: { lengthFt: number; feasible: boolean; startPoint: number[]; endPoint: number[] }[]
  proposedDepartureBearing?: number
  developmentEntryPoint?: number[]
  rawDevelopmentEntryPoint?: number[]
  canonicalDevelopmentEntryPoint?: number[]
  boundaryToleranceMeters?: number
  boundaryToleranceApplied?: boolean
  entrySnapDistanceMeters?: number
  forwardInteriorProbeSucceeded?: boolean
  forwardInteriorProbeDistanceMeters?: number | null
  boundaryPointAudit?: Record<string, any> | null
  vertexCount?: number
  bendCount?: number
  maxDeflectionAngle?: number
  totalAbsoluteDeflection?: number
  rawAStarVertexCount?: number
  simplifiedVertexCount?: number
  developmentFeasibility?: {
    selectedComponentIndex: number
    selectedOverallStatus: string
    selectedLandOpportunity: string
    selectedAccessFeasibility: string
    selectedPrimaryRoadQuality: string
    selectionReason: string
    rankedFeasibleComponents: any[]
    latentLandOpportunities: any[]
    constrainedComponents: any[]
    unsupportedComponents: any[]
  }
  simplificationUsed?: boolean
  dominatedByTargetDistanceFt?: number | null
  serviceDominated?: boolean
  serviceDominatedByTargetDistanceFt?: number | null
  serviceDominanceReasons?: string[]
  accessSuitability?: ConceptualAccessAssessment
  primarySpineAdequacy?: PrimarySpineAdequacy
  terrainProfile?: RoadTerrainProfile
  terrainAlternatives?: any[] | null
  terrainSelectionReason?: string | null
  terrainWaypointInventory?: any | null
  adaptiveTerrainRouteSearch?: any | null
  terrainRoadScore?: number
  terrainPenalty?: number
  terrainSuitabilityScoring?: PrimaryRoadTerrainScoring | null
  terrainRoadMode?: 'CONTOUR_FOLLOWING' | 'FALL_LINE' | 'DIRECT_FALLBACK'
  terrainAlignmentScore?: number | null
  roadPrecedentScore?: number | null
  roadPrecedentPattern?: 'CONTOUR_DOMINANT' | 'FALL_LINE_DOMINANT' | 'GRID_ORTHOGONAL' | 'CURVILINEAR' | 'MIXED' | 'INSUFFICIENT_DATA'
  roadPrecedentConfidence?: 'HIGH' | 'MODERATE' | 'LOW' | 'UNAVAILABLE'
  primaryRoadRowSafety?: import('./terrain').PrimaryRoadRowSafety | null
  terrainFallbackReason?: 'TERRAIN_DATA_UNAVAILABLE' | 'SAFE_CENTERLINE_AREA_UNAVAILABLE' | 'NO_VALID_TERRAIN_CANDIDATES' | 'TERRAIN_CANDIDATES_MATERIALLY_INFERIOR' | null
  terrainFallbackReasonDetail?: string | null
}

export interface PrimarySpineAdequacy {
  status: 'MEANINGFUL_PRIMARY_SPINE' | 'LIMITED_PRIMARY_SPINE' | 'ACCESS_STUB' | 'INVALID'
  baseAdequacy: 'MEANINGFUL_PRIMARY_SPINE' | 'LIMITED_PRIMARY_SPINE' | 'ACCESS_STUB' | 'INVALID'
  finalAdequacy: 'MEANINGFUL_PRIMARY_SPINE' | 'LIMITED_PRIMARY_SPINE' | 'ACCESS_STUB' | 'INVALID'
  reasons: string[]
  geometryQualityPassed: boolean
  geometryQualityReasons: string[]
  achievedPenetrationMeters: number
  availablePenetrationMeters: number
  penetrationRatio: number
  averageCorridorWidthMeters: number
  servedDevelopableAreaSqFt: number
  componentServiceRatio: number
  bendCount: number
  maxDeflectionAngle: number
  totalAbsoluteDeflection: number
  routeEfficiencyRatio: number
  initialTangentLengthFt: number
}

export type SecondaryRoadTemplateType = 'simple-branch' | 't-branch' | 'small-loop'

export type SecondaryRoadStatus = 'valid' | 'invalid' | 'rejected'

export interface SecondaryRoad {
  id: string
  templateType: SecondaryRoadTemplateType
  centerlineGeometry: GeoJSON.Feature<GeoJSON.LineString> | null
  rightOfWayGeometry: GeoJSON.Feature<GeoJSON.Geometry> | null
  lengthFt: number
  newlyServedAreaSqFt: number
  incrementalServiceRatio: number
  routeEfficiencyRatio: number
  bendCount: number
  maximumDeflectionAngle: number
  totalAbsoluteDeflection: number
  junctionPoint: number[] | null
  junctionAngle: number
  obstacleConflictCounts: {
    buildings: number
    hydrology: number
    pavement: number
    primaryROW: number
    parcelBoundary: number
    otherSecondaryROW: number
  }
  selectionReason: string
  junctionIndex?: number
  stopReason?: string
  terrainProfile?: RoadTerrainProfile
  terrainRoadScore?: number
  terrainPenalty?: number
  grammarPenalty?: number
  terrainSuitabilityScoring?: import('./terrain').PrimaryRoadTerrainScoring | null
}

export interface SecondaryRoadNetworkResult {
  status: 'generated' | 'empty' | 'unavailable'
  mcpi: string
  primaryRoadUsed: {
    mcpi: string
    roadLengthFt: number
    connectionMethod: string
  } | null
  secondaryRoadCount: number
  totalSecondaryRoadLengthFt: number
  totalSecondaryROWAreaSqFt: number
  primaryServedAreaSqFt: number
  secondaryNewlyServedAreaSqFt: number
  totalNetworkServedAreaSqFt: number
  totalNetworkServiceRatio: number
  residualUnservedDevelopableAreaSqFt: number
  roads: SecondaryRoad[]
  warnings: string[]
  explanation: string
}

export type DevelopmentOpportunityClassification = 'HIGH' | 'MODERATE' | 'LOW' | 'RESIDUAL'
export type DevelopmentOpportunityAccessState = 'ROAD_SERVEABLE' | 'NEAR_NETWORK' | 'LATENT_NO_NETWORK_ACCESS'

export interface DevelopmentOpportunityBlockInteriorSurvival {
  bufferFeet: number
  survivingAreaSqFt: number
  survivalPercent: number
}

export interface DevelopmentOpportunityBlockConstraintProximities {
  nearestBuildingFt: number | null
  nearestHydrologyFt: number | null
  nearestPavementFt: number | null
}

export interface DevelopmentOpportunityBlockRoadRelationship {
  touchesPrimaryROW: boolean
  touchesSecondaryROW: boolean
  touchesAnyProposedROW: boolean
  distanceToProposedRoadFt: number
  nearestRoadType: 'primary' | 'secondary' | 'none'
}

export interface DevelopmentOpportunityBlock {
  id: string
  rank: number
  classification: DevelopmentOpportunityClassification
  geometry: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>
  areaSqFt: number
  areaAcres: number
  perimeterFt: number
  compactness: number
  interiorSurvival: DevelopmentOpportunityBlockInteriorSurvival[]
  roadRelationship: DevelopmentOpportunityBlockRoadRelationship
  constraintProximities: DevelopmentOpportunityBlockConstraintProximities
  accessState: DevelopmentOpportunityAccessState
  opportunityScore: number
  reasons: string[]
}

export interface DevelopmentOpportunityBlockResult {
  mcpi: string
  status: 'generated' | 'empty' | 'latent' | 'unavailable'
  blockCount: number
  highCount: number
  moderateCount: number
  lowCount: number
  residualCount: number
  candidateOpenAreaSqFt: number
  proposedROWInsideCOASqFt: number
  opportunityBlocksSqFt: number
  conservationDifferenceSqFt: number
  conservationToleranceSqFt: number
  conservationPassed: boolean
  totalBlockAreaAcres: number
  roadServeableAreaAcres: number
  nearNetworkAreaAcres: number
  latentNoNetworkAreaAcres: number
  largestBlockAcres: number
  blocks: DevelopmentOpportunityBlock[]
  warnings: string[]
  explanation: string
}
