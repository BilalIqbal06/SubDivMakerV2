import * as turf from '@turf/turf'
import { ExistingConditionsData } from '../types/parameters'
import { networkCounter } from '../lib/perf'
import type { TerrainData } from '../types/terrain'

const M2_PER_ACRE = 4046.8564224

export type ParcelFeasibilityRating = 'FAVORABLE' | 'MODERATE' | 'CHALLENGING' | 'INSUFFICIENT DATA'
export type ParcelFeasibilityConfidence = 'HIGH' | 'MEDIUM' | 'LOW'
export type ParcelConstraintStatus = 'NONE' | 'PRESENT' | 'SIGNIFICANT' | 'UNKNOWN'
export type ParcelAccessStatus = 'GOOD' | 'LIMITED' | 'CONSTRAINED' | 'UNKNOWN'

export interface ParcelFeasibilityAssessment {
  mcpi: string
  overallRating: ParcelFeasibilityRating
  confidence: ParcelFeasibilityConfidence
  parcelAreaAcres: number | null
  developableAreaAcres: number | null
  developablePercent: number | null
  buildingStatus: ParcelConstraintStatus
  hydrologyStatus: ParcelConstraintStatus
  pavementStatus: ParcelConstraintStatus
  terrainStatus: 'FAVORABLE' | 'MODERATE' | 'CHALLENGING' | 'UNKNOWN'
  accessStatus: ParcelAccessStatus
  frontageStatus: ParcelAccessStatus
  dominantConstraint: string
  positiveFactors: string[]
  concernFactors: string[]
  summary: string
  calculationMs: number
}

function areaAcres(geometry: any): number {
  if (!geometry) return 0
  try {
    return turf.area(geometry) / M2_PER_ACRE
  } catch {
    return 0
  }
}

function toFeature(geometry: any): GeoJSON.Feature | null {
  if (!geometry) return null
  if (geometry.type === 'Feature') return geometry as GeoJSON.Feature
  if (geometry.type) return { type: 'Feature', geometry, properties: {} }
  return null
}

function toPolygonFeatures(features: any[]): GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>[] {
  return features
    .map(toFeature)
    .filter((f): f is GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> => {
      if (!f) return false
      return f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon'
    })
}

function unionFeatures(features: any[]): GeoJSON.Feature<GeoJSON.Geometry> | null {
  const polys = toPolygonFeatures(features)
  if (polys.length === 0) return null
  if (polys.length === 1) return polys[0]
  try {
    return turf.union(turf.featureCollection(polys)) as GeoJSON.Feature<GeoJSON.Geometry> | null
  } catch {
    return null
  }
}

function differenceFromParcel(parcel: GeoJSON.Feature, constraint: GeoJSON.Feature<GeoJSON.Geometry> | null): GeoJSON.Feature | null {
  if (!constraint) return parcel
  try {
    const result = turf.difference(turf.featureCollection([parcel, constraint]) as any) as GeoJSON.Feature<GeoJSON.Geometry> | null
    if (!result) return parcel
    return result as GeoJSON.Feature
  } catch {
    return parcel
  }
}

function intersectWithParcel(feature: GeoJSON.Feature<GeoJSON.Geometry> | null, parcel: GeoJSON.Feature): GeoJSON.Feature<GeoJSON.Geometry> | null {
  if (!feature) return null
  try {
    return turf.intersect(turf.featureCollection([feature, parcel]) as any) as GeoJSON.Feature<GeoJSON.Geometry> | null
  } catch {
    return null
  }
}

function bufferedRoadFeature(streetFeatures: any[], parcel: GeoJSON.Feature, halfWidthFeet: number): GeoJSON.Feature<GeoJSON.Geometry> | null {
  const lines = streetFeatures
    .map(toFeature)
    .filter((f): f is GeoJSON.Feature<GeoJSON.LineString | GeoJSON.MultiLineString> => {
      if (!f) return false
      return f.geometry?.type === 'LineString' || f.geometry?.type === 'MultiLineString'
    })
  if (lines.length === 0) return null

  const buffers: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>[] = []
  for (const line of lines) {
    try {
      const buf = turf.buffer(line, halfWidthFeet * 0.3048, { units: 'meters' }) as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>
      if (buf && (buf.geometry?.type === 'Polygon' || buf.geometry?.type === 'MultiPolygon')) {
        buffers.push(buf)
      }
    } catch {
      // Ignore failed buffers
    }
  }
  if (buffers.length === 0) return null

  const unioned = buffers.length === 1 ? buffers[0] : (turf.union(turf.featureCollection(buffers)) as GeoJSON.Feature<GeoJSON.Geometry> | null)
  if (!unioned) return null

  return intersectWithParcel(unioned, parcel)
}


export interface CalculateParcelFeasibilityInput {
  mcpi: string
  parcelFeature: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>
  existingConditions: ExistingConditionsData
  terrainData?: TerrainData | null
  candidateOpenAreaResult?: { candidateAreaAcres?: number | null } | null
  roadHalfWidthFeet?: number
}

export type TerrainScreeningStatus = 'pending' | 'complete' | 'unavailable'

export interface ParcelScreeningInput {
  mcpi: string
  existingConditions: ExistingConditionsData
  terrainData?: TerrainData | null
  candidateOpenAreaResult?: { candidateAreaAcres?: number | null; status?: string } | null
  terrainScreeningStatus?: TerrainScreeningStatus
}

export interface ParcelScreeningReadiness {
  ready: boolean
  blockingReasons: string[]
}

export function getParcelScreeningReadiness(
  existingConditions: ExistingConditionsData | null,
  candidateOpenAreaResult: { status: string } | null,
  terrainScreeningStatus: TerrainScreeningStatus
): ParcelScreeningReadiness {
  const blockingReasons: string[] = []

  if (!existingConditions) {
    blockingReasons.push('existingConditions is null')
  } else {
    const layers = [
      { name: 'buildings', state: existingConditions.buildings?.state },
      { name: 'hydrology', state: existingConditions.hydrology?.state },
      { name: 'pavement', state: existingConditions.pavement?.state },
      { name: 'intersectingStreets', state: existingConditions.intersectingStreets?.state },
      { name: 'nearbyStreets', state: existingConditions.nearbyStreets?.state },
      { name: 'parcelBoundary', state: existingConditions.parcelBoundary?.state }
    ]
    for (const layer of layers) {
      if (layer.state === 'loading' || layer.state == null) {
        blockingReasons.push(`${layer.name} is ${layer.state ?? 'missing'}`)
      }
    }
  }

  if (!candidateOpenAreaResult) {
    blockingReasons.push('candidateOpenAreaResult is null')
  } else if (candidateOpenAreaResult.status === 'loading' || candidateOpenAreaResult.status == null) {
    blockingReasons.push(`candidateOpenAreaResult status is ${candidateOpenAreaResult.status ?? 'missing'}`)
  }

  if (terrainScreeningStatus === 'pending') {
    blockingReasons.push('terrainScreeningStatus is pending')
  }

  return { ready: blockingReasons.length === 0, blockingReasons }
}

export function isParcelScreeningReady(
  existingConditions: ExistingConditionsData | null,
  candidateOpenAreaResult: { status: string } | null,
  terrainScreeningStatus: TerrainScreeningStatus
): boolean {
  return getParcelScreeningReadiness(existingConditions, candidateOpenAreaResult, terrainScreeningStatus).ready
}

export function buildParcelScreeningInputSignature(input: ParcelScreeningInput): string {
  const e = input.existingConditions
  const c = input.candidateOpenAreaResult
  const t = input.terrainData
  const sig = {
    mcpi: input.mcpi,
    b: e.buildings?.state,
    h: e.hydrology?.state,
    hc: e.hydrology?.hydrologyCoverageAvailable,
    p: e.pavement?.state,
    pc: e.pavement?.pavementCoverageAvailable,
    i: e.intersectingStreets?.state,
    n: e.nearbyStreets?.state,
    pb: e.parcelBoundary?.state,
    pa: e.parcelBoundary?.parcelAreaAcres,
    cStatus: c?.status,
    ca: c?.candidateAreaAcres,
    tc: t?.coverageAvailable,
    te: t?.elevationRangeFt,
    ts: input.terrainScreeningStatus
  }
  return JSON.stringify(sig)
}

export function calculateParcelFeasibility(input: CalculateParcelFeasibilityInput): ParcelFeasibilityAssessment {
  const start = performance.now()
  const { mcpi, parcelFeature, existingConditions, terrainData, candidateOpenAreaResult, roadHalfWidthFeet = 25 } = input

  // Base parcel area (prefer cached, otherwise compute)
  const parcelAreaAcres =
    existingConditions?.parcelBoundary?.parcelAreaAcres ?? areaAcres(parcelFeature.geometry)

  // Compute constraint union
  const buildingUnion = unionFeatures(existingConditions.buildings.features)
  const hydrologyFeatures = [
    ...(existingConditions.hydrology?.features?.waterBodyFeatures || []),
    ...(existingConditions.hydrology?.features?.wetlandFeatures || []),
    ...(existingConditions.hydrology?.features?.streamDrainFeatures || [])
  ]
  const hydrologyUnion = unionFeatures(hydrologyFeatures)
  const pavementUnion = unionFeatures(existingConditions.pavement?.features?.features || [])
  const roadBuffer = bufferedRoadFeature(
    [...existingConditions.intersectingStreets.features, ...existingConditions.nearbyStreets.features],
    parcelFeature,
    roadHalfWidthFeet
  )

  const lockedGeometries: (GeoJSON.Feature<GeoJSON.Geometry> | null)[] = [
    buildingUnion,
    hydrologyUnion,
    pavementUnion,
    roadBuffer
  ].filter(Boolean) as GeoJSON.Feature<GeoJSON.Geometry>[]

  // Compute screening candidate open area only if a valid parcel and existing conditions are present
  let developableAreaAcres: number | null = null
  if (candidateOpenAreaResult?.candidateAreaAcres != null) {
    developableAreaAcres = candidateOpenAreaResult.candidateAreaAcres
  } else if (parcelAreaAcres > 0 && existingConditions) {
    let remainder: GeoJSON.Feature | null = parcelFeature
    for (const locked of lockedGeometries) {
      if (!remainder) break
      if (locked) {
        remainder = differenceFromParcel(remainder, locked)
      }
    }
    if (remainder && remainder.geometry) {
      developableAreaAcres = areaAcres(remainder.geometry)
    }
  }

  const developablePercent = parcelAreaAcres > 0 && developableAreaAcres != null
    ? (developableAreaAcres / parcelAreaAcres) * 100
    : null

  // Constraint area shares
  const buildingArea = buildingUnion ? areaAcres(buildingUnion.geometry) : 0
  const hydrologyArea = hydrologyUnion ? areaAcres(hydrologyUnion.geometry) : 0
  const pavementArea = pavementUnion ? areaAcres(pavementUnion.geometry) : 0

  const buildingPct = parcelAreaAcres > 0 ? (buildingArea / parcelAreaAcres) * 100 : 0
  const hydrologyPct = parcelAreaAcres > 0 ? (hydrologyArea / parcelAreaAcres) * 100 : 0
  const pavementPct = parcelAreaAcres > 0 ? (pavementArea / parcelAreaAcres) * 100 : 0

  const constraintStatus = (pct: number): ParcelConstraintStatus => {
    if (pct === 0) return 'NONE'
    if (pct >= 10) return 'SIGNIFICANT'
    return 'PRESENT'
  }

  const buildingStatus: ParcelConstraintStatus = buildingPct === 0 && existingConditions.buildings.count === 0 ? 'NONE' : constraintStatus(buildingPct)
  const hydrologyStatus: ParcelConstraintStatus = hydrologyPct === 0 && existingConditions.hydrology.count === 0 ? 'NONE' : constraintStatus(hydrologyPct)
  const pavementStatus: ParcelConstraintStatus = pavementPct === 0 && existingConditions.pavement.count === 0 ? 'NONE' : constraintStatus(pavementPct)

  // Terrain status
  let terrainStatus: 'FAVORABLE' | 'MODERATE' | 'CHALLENGING' | 'UNKNOWN' = 'UNKNOWN'
  if (terrainData && terrainData.coverageAvailable && terrainData.contourCount > 0 && terrainData.elevationRangeFt != null) {
    const range = terrainData.elevationRangeFt
    if (range <= 15) terrainStatus = 'FAVORABLE'
    else if (range <= 40) terrainStatus = 'MODERATE'
    else terrainStatus = 'CHALLENGING'
  }

  // Access and frontage
  const intersectingCount = existingConditions.intersectingStreets.count ?? 0
  const nearbyCount = existingConditions.nearbyStreets.count ?? 0
  let accessStatus: ParcelAccessStatus = 'UNKNOWN'
  let frontageStatus: ParcelAccessStatus = 'UNKNOWN'
  if (intersectingCount > 0) {
    accessStatus = 'GOOD'
    frontageStatus = 'GOOD'
  } else if (nearbyCount > 0) {
    accessStatus = 'LIMITED'
    frontageStatus = 'LIMITED'
  } else if (existingConditions.intersectingStreets.state === 'success' || existingConditions.nearbyStreets.state === 'success') {
    accessStatus = 'CONSTRAINED'
    frontageStatus = 'CONSTRAINED'
  }

  // Score
  let score = 0
  if (accessStatus === 'GOOD') score += 2
  if (frontageStatus === 'GOOD') score += 0 // Covered by access
  if (developablePercent != null) {
    if (developablePercent >= 60) score += 2
    else if (developablePercent >= 40) score += 1
    if (developablePercent < 20) score -= 2
  }
  if (terrainStatus === 'FAVORABLE') score += 1
  if (buildingStatus === 'NONE') score += 1
  if (pavementStatus === 'NONE') score += 1
  if (accessStatus === 'CONSTRAINED') score -= 2
  if (accessStatus === 'LIMITED') score -= 1
  if (hydrologyStatus === 'SIGNIFICANT') score -= 2
  if (hydrologyStatus === 'PRESENT') score -= 0.5
  if (terrainStatus === 'CHALLENGING') score -= 1
  if (buildingStatus === 'SIGNIFICANT') score -= 1
  if (pavementStatus === 'SIGNIFICANT') score -= 1
  if (developablePercent != null && developablePercent < 30) score -= 1

  let overallRating: ParcelFeasibilityRating = 'INSUFFICIENT DATA'
  let confidence: ParcelFeasibilityConfidence = 'LOW'
  if (parcelAreaAcres != null && parcelAreaAcres > 0 && existingConditions?.parcelBoundary?.state === 'success') {
    if (score >= 4) overallRating = 'FAVORABLE'
    else if (score >= 1 && score <= 3) overallRating = 'MODERATE'
    else overallRating = 'CHALLENGING'

    const hasErrors =
      existingConditions.buildings?.state === 'error' ||
      existingConditions.hydrology?.state === 'error' ||
      existingConditions.pavement?.state === 'error'
    const inputsReady =
      existingConditions.buildings?.state === 'success' &&
      existingConditions.hydrology?.hydrologyCoverageAvailable !== false &&
      existingConditions.pavement?.pavementCoverageAvailable !== false
    if (terrainData?.coverageAvailable && inputsReady && !hasErrors) {
      confidence = 'HIGH'
    } else if (inputsReady || !hasErrors) {
      confidence = 'MEDIUM'
    } else {
      confidence = 'LOW'
    }
  }

  // Dominant constraint
  const candidates: { key: string; priority: number }[] = []
  if (hydrologyStatus === 'SIGNIFICANT') candidates.push({ key: 'Water / wetlands', priority: 5 })
  if (buildingStatus === 'SIGNIFICANT') candidates.push({ key: 'Existing buildings', priority: 4 })
  if (pavementStatus === 'SIGNIFICANT') candidates.push({ key: 'Existing pavement', priority: 4 })
  if (terrainStatus === 'CHALLENGING') candidates.push({ key: 'Terrain', priority: 3 })
  if (accessStatus === 'CONSTRAINED') candidates.push({ key: 'Access', priority: 5 })
  if (accessStatus === 'LIMITED') candidates.push({ key: 'Limited road frontage', priority: 2 })
  if (developablePercent != null && developablePercent < 25 && developablePercent > 0) candidates.push({ key: 'Fragmented developable area', priority: 2 })

  const dominantConstraint = candidates.length > 0
    ? candidates.sort((a, b) => b.priority - a.priority)[0].key
    : 'No major mapped constraint'

  // Positive factors
  const positiveFactors: string[] = []
  if (developablePercent != null && developablePercent >= 50) positiveFactors.push('Large candidate developable area')
  if (terrainStatus === 'FAVORABLE') positiveFactors.push('Favorable terrain')
  if (accessStatus === 'GOOD') positiveFactors.push('Existing public-road frontage')
  if (buildingStatus === 'NONE') positiveFactors.push('Limited existing development')
  if (pavementStatus === 'NONE') positiveFactors.push('Low pavement coverage')

  // Concern factors
  const concernFactors: string[] = []
  if (hydrologyStatus !== 'NONE') concernFactors.push('Wetlands reduce flexibility in part of the parcel')
  if (buildingStatus !== 'NONE') concernFactors.push('Existing buildings occupy part of the site')
  if (accessStatus === 'LIMITED') concernFactors.push('Limited road frontage')
  if (accessStatus === 'CONSTRAINED') concernFactors.push('No usable access identified')
  if (terrainStatus === 'CHALLENGING') concernFactors.push('Terrain may constrain road placement')
  if (developablePercent != null && developablePercent < 30) concernFactors.push('Candidate open area is fragmented')

  if (positiveFactors.length === 0 && concernFactors.length === 0) {
    positiveFactors.push('No major mapped constraints identified at this screening level')
  }

  // Summary
  let summary = ''
  if (overallRating === 'INSUFFICIENT DATA') {
    summary = 'This parcel cannot be screened with available data. Complete the existing conditions analysis to proceed.'
  } else if (overallRating === 'FAVORABLE') {
    const positive = positiveFactors[0]?.toLowerCase() || 'a large candidate developable area'
    summary = `This parcel shows favorable development potential. It offers ${positive}, and ${dominantConstraint.toLowerCase()} does not materially constrain the site.`
  } else if (overallRating === 'CHALLENGING') {
    summary = `This parcel shows challenging development potential. ${dominantConstraint} reduces the usable developable area and may limit layout flexibility.`
  } else {
    const strength = positiveFactors[0]?.toLowerCase() || 'some candidate open area'
    const concern = concernFactors[0]?.toLowerCase() || `mapped ${dominantConstraint.toLowerCase()}`
    summary = `This parcel shows moderate development potential. It contains ${strength}, but ${concern} reduces flexibility.`
  }

  const result: ParcelFeasibilityAssessment = {
    mcpi,
    overallRating,
    confidence,
    parcelAreaAcres,
    developableAreaAcres,
    developablePercent,
    buildingStatus,
    hydrologyStatus,
    pavementStatus,
    terrainStatus,
    accessStatus,
    frontageStatus: accessStatus,
    dominantConstraint,
    positiveFactors: positiveFactors.slice(0, 3),
    concernFactors: concernFactors.slice(0, 3),
    summary,
    calculationMs: Math.round(performance.now() - start)
  }

  if (import.meta.env.DEV) {
    const net = networkCounter.get()
    const byMs = net.byCategoryMs
    const gisFetchMs = byMs['parcel'] ?? 0
    const buildingsMs = byMs['buildings'] ?? 0
    const hydrologyMs = byMs['hydrology'] ?? 0
    const pavementMs = byMs['pavement'] ?? 0
    const roadsMs = byMs['roads'] ?? 0
    const terrainFetchMs = byMs['terrain/contours'] ?? 0
    const candidateOpenAreaMs = byMs['candidateOpenArea'] ?? null
    const networkTotalMs = Object.values(byMs).reduce((a, b) => a + b, 0)
    const duplicateFetchCount = Object.values(net.duplicates).reduce((a, b) => a + b, 0)
    const slowestStage = net.slowestCategory
    const slowestStageMs = (slowestStage ? (byMs[slowestStage] ?? 0) : 0)

    console.log('[ParcelFeasibilityAudit]', {
      mcpi,
      parcelAreaAcres,
      candidateOpenAreaAcres: developableAreaAcres,
      developablePercent,
      buildingStatus,
      hydrologyStatus,
      pavementStatus,
      terrainStatus,
      accessStatus,
      score,
      overallRating,
      confidence,
      dominantConstraint,
      positiveFactors: result.positiveFactors,
      concernFactors: result.concernFactors,
      calculationMs: result.calculationMs
    })

    console.log('[ParcelFeasibilityPerformanceAudit]', {
      mcpi,
      totalMs: Math.round(result.calculationMs + networkTotalMs),
      gisFetchMs,
      buildingsMs,
      hydrologyMs,
      pavementMs,
      roadsMs,
      terrainFetchMs,
      candidateOpenAreaMs,
      feasibilityComputeMs: result.calculationMs,
      otherMs: null,
      duplicateFetchCount,
      slowestStage,
      slowestStageMs
    })
  }

  return result
}
