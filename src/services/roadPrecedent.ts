import type { RoadData } from './gisService'
import type { TerrainSuitabilityResult } from '../types/terrain'
import { fastBearing } from './fastAlong'
import { getTerrainDirectionAtPoint } from './terrainDirection'

export interface NearbyRoadProfile {
  sampleStreetCount: number
  sampleSegmentCount: number
  dominantBearing: number | null
  secondaryBearing: number | null
  medianSegmentLengthFt: number | null
  medianDeflectionAngleDeg: number | null
  approximateCurvature: number | null
  contourAlignedShare: number
  fallLineAlignedShare: number
  typicalBranchAngleDeg: number | null
  inferredPattern:
    | 'CONTOUR_DOMINANT'
    | 'FALL_LINE_DOMINANT'
    | 'GRID_ORTHOGONAL'
    | 'CURVILINEAR'
    | 'MIXED'
    | 'INSUFFICIENT_DATA'
  confidence: 'HIGH' | 'MODERATE' | 'LOW' | 'UNAVAILABLE'
}

export interface RoadPrecedentScore {
  contourBonus: number
  fallLineBonus: number
  score: number
  confidence: number
}

const ALIGNMENT_TOLERANCE_DEG = 30
const MIN_SAMPLE_SEGMENTS = 4
const HIGHWAY_CFCC = /^[AI]/

function isLikelyHighway(data: RoadData): boolean {
  const cfcc = data.properties?.CE_CFCC
  const name = (data.properties?.ST_FULLNAME ?? '').toUpperCase()
  if (typeof cfcc === 'string' && HIGHWAY_CFCC.test(cfcc)) return true
  if (['INTERSTATE', 'FWY', 'FREEWAY', 'RAMP', 'EXIT'].some(s => name.includes(s))) return true
  return false
}

function segmentBearing(a: number[], b: number[]): number | null {
  if (!a || !b) return null
  return fastBearing(a, b)
}

export function analyzeNearbyRoadPrecedent(
  _mcpi: string,
  nearbyStreets: RoadData[] | null | undefined,
  terrainSuitability: TerrainSuitabilityResult | null | undefined
): NearbyRoadProfile {
  if (!nearbyStreets || nearbyStreets.length === 0) {
    return {
      sampleStreetCount: 0,
      sampleSegmentCount: 0,
      dominantBearing: null,
      secondaryBearing: null,
      medianSegmentLengthFt: null,
      medianDeflectionAngleDeg: null,
      approximateCurvature: null,
      contourAlignedShare: 0,
      fallLineAlignedShare: 0,
      typicalBranchAngleDeg: null,
      inferredPattern: 'INSUFFICIENT_DATA',
      confidence: 'UNAVAILABLE'
    }
  }

  const candidateStreets = nearbyStreets.filter(s => !isLikelyHighway(s))
  const allBearings: number[] = []
  const segmentLengths: number[] = []
  const deflections: number[] = []
  const segmentBearingPairs: { bearing: number; terrainComparable: boolean; contourAligned: boolean; fallLineAligned: boolean }[] = []

  let terrainComparableCount = 0
  let contourAlignedCount = 0
  let fallLineAlignedCount = 0

  for (const street of candidateStreets) {
    const coords = getLineCoords(street.geometry)
    if (!coords || coords.length < 2) continue

    let prevBearing: number | null = null
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i]
      const b = coords[i + 1]
      const brg = segmentBearing(a, b)
      if (brg == null) continue

      const lengthFt = estimateLengthFt(a, b)
      allBearings.push(brg)
      segmentLengths.push(lengthFt)

      if (prevBearing != null) {
        const diff = Math.abs((((brg - prevBearing) % 360) + 540) % 360 - 180)
        deflections.push(diff)
      }
      prevBearing = brg

      const mid: number[] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
      const dir = getTerrainDirectionAtPoint(mid, terrainSuitability)
      const comparable = dir.confidence !== 'UNAVAILABLE' && dir.confidence !== 'LOW'
      let contour = false
      let fall = false
      if (comparable && dir.contourBearing != null && dir.fallLineBearing != null) {
        terrainComparableCount++
        if (orientationWithin(dir.contourBearing, brg, ALIGNMENT_TOLERANCE_DEG)) {
          contour = true
          contourAlignedCount++
        }
        if (orientationWithin(dir.fallLineBearing, brg, ALIGNMENT_TOLERANCE_DEG)) {
          fall = true
          fallLineAlignedCount++
        }
      }
      segmentBearingPairs.push({ bearing: brg, terrainComparable: comparable, contourAligned: contour, fallLineAligned: fall })
    }
  }

  const sampleCount = allBearings.length
  const median = (arr: number[]) => {
    if (arr.length === 0) return null
    const s = [...arr].sort((a, b) => a - b)
    const mid = Math.floor(s.length / 2)
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
  }

  const dominantBearing = deriveDominantBearing(allBearings)
  const secondaryBearing = deriveSecondaryBearing(allBearings, dominantBearing ?? 0)
  const contourShare = terrainComparableCount > 0 ? contourAlignedCount / terrainComparableCount : 0
  const fallShare = terrainComparableCount > 0 ? fallLineAlignedCount / terrainComparableCount : 0
  const pattern = inferPattern(contourShare, fallShare, sampleCount, median(deflections) ?? 0, median(segmentLengths))

  return {
    sampleStreetCount: candidateStreets.length,
    sampleSegmentCount: sampleCount,
    dominantBearing,
    secondaryBearing,
    medianSegmentLengthFt: median(segmentLengths),
    medianDeflectionAngleDeg: median(deflections),
    approximateCurvature: sampleCount > 0 ? deflections.reduce((a, b) => a + b, 0) / deflections.length : null,
    contourAlignedShare: contourShare,
    fallLineAlignedShare: fallShare,
    typicalBranchAngleDeg: estimateTypicalBranchAngle(deflections),
    inferredPattern: pattern,
    confidence: sampleCount >= MIN_SAMPLE_SEGMENTS ? 'HIGH' : sampleCount > 0 ? 'LOW' : 'UNAVAILABLE'
  }
}

export function scorePrecedentForMode(
  mode: 'CONTOUR_FOLLOWING' | 'FALL_LINE' | 'DIRECT_FALLBACK',
  profile: NearbyRoadProfile
): RoadPrecedentScore {
  if (mode === 'DIRECT_FALLBACK' || profile.confidence === 'UNAVAILABLE' || profile.sampleSegmentCount < MIN_SAMPLE_SEGMENTS) {
    return { contourBonus: 0, fallLineBonus: 0, score: 0, confidence: 0 }
  }

  const contour = profile.contourAlignedShare
  const fall = profile.fallLineAlignedShare

  let contourBonus = 0
  let fallBonus = 0
  if (mode === 'CONTOUR_FOLLOWING') {
    contourBonus = contour * 0.05
  } else {
    fallBonus = fall * 0.05
  }
  const score = mode === 'CONTOUR_FOLLOWING' ? contourBonus : fallBonus
  const confidence = profile.confidence === 'HIGH' ? 1.0 : 0.5
  return { contourBonus, fallLineBonus: fallBonus, score, confidence }
}

function getLineCoords(geometry: any): number[][] | null {
  if (!geometry) return null
  if (geometry.type === 'LineString') return geometry.coordinates
  if (geometry.type === 'Feature' && geometry.geometry?.type === 'LineString') return geometry.geometry.coordinates
  if (Array.isArray(geometry.coordinates) && Array.isArray(geometry.coordinates[0])) return geometry.coordinates
  return null
}

function estimateLengthFt(a: number[], b: number[]): number {
  const R = 20902231.76 // earth radius in feet (mean)
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLon = toRad(b[0] - a[0])
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function orientationWithin(b1: number, b2: number, tol: number): boolean {
  const diff = Math.abs((((b1 - b2) % 360) + 540) % 360 - 180)
  return diff <= tol
}

function deriveDominantBearing(bearings: number[]): number | null {
  if (bearings.length === 0) return null
  const buckets: number[] = [0, 0, 0, 0, 0, 0, 0, 0]
  for (const b of bearings) {
    const bin = Math.floor(((b + 22.5) % 360) / 45) % 8
    buckets[bin]++
  }
  const best = buckets.indexOf(Math.max(...buckets))
  const sum = bearings
    .filter(b => {
      const bin = Math.floor(((b + 22.5) % 360) / 45) % 8
      return bin === best
    })
    .reduce((a, b) => a + b, 0)
  const count = buckets[best]
  return sum / count
}

function deriveSecondaryBearing(bearings: number[], dominant: number): number | null {
  if (bearings.length < 2) return null
  const oriented = bearings.map(b => orientationWithin(b, dominant + 90, 22.5) ? b : null).filter(Boolean) as number[]
  if (oriented.length === 0) return null
  const sum = oriented.reduce((a, b) => a + b, 0)
  return sum / oriented.length
}

function inferPattern(
  contourShare: number,
  fallShare: number,
  sampleCount: number,
  medianDeflection: number,
  medianLength: number | null
): NearbyRoadProfile['inferredPattern'] {
  if (sampleCount < MIN_SAMPLE_SEGMENTS) return 'INSUFFICIENT_DATA'
  if (medianLength != null && medianLength > 800 && medianDeflection < 15) return 'GRID_ORTHOGONAL'
  if (contourShare > 0.55 && fallShare < 0.25) return 'CONTOUR_DOMINANT'
  if (fallShare > 0.55 && contourShare < 0.25) return 'FALL_LINE_DOMINANT'
  if (medianDeflection > 25) return 'CURVILINEAR'
  return 'MIXED'
}

function estimateTypicalBranchAngle(deflections: number[]): number | null {
  if (deflections.length === 0) return null
  const s = [...deflections].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  const med = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
  return Math.max(30, Math.min(120, 180 - med))
}
