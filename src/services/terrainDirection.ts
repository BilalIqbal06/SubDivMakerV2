import { getTerrainSuitabilityAtPoint } from './terrainSuitabilityQuery'
import type { TerrainSuitabilityResult } from '../types/terrain'
import { fastRhumbDestinationCoord } from './fastAlong'

const OFFSET_FT = 50
const CACHE = new Map<string, TerrainDirectionResult>()

export interface TerrainDirectionResult {
  fallLineBearing: number | null
  contourBearing: number | null
  slopePct: number | null
  confidence: 'HIGH' | 'MODERATE' | 'LOW' | 'UNAVAILABLE'
}

function cacheKey(coord: number[]): string {
  const lon = Math.round(coord[0] * 10000)
  const lat = Math.round(coord[1] * 10000)
  return `${lon},${lat}`
}

function normalizeBearing(b: number): number {
  return ((b % 360) + 360) % 360
}

export function blendBearings(bearings: number[], weights: number[]): number {
  let x = 0
  let y = 0
  for (let i = 0; i < bearings.length; i++) {
    const r = (bearings[i] * Math.PI) / 180
    x += Math.sin(r) * weights[i]
    y += Math.cos(r) * weights[i]
  }
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum === 0) return 0
  const brg = ((Math.atan2(x / sum, y / sum) * 180) / Math.PI + 360) % 360
  return brg
}

export function limitBearingChange(previousBearing: number, desiredBearing: number, maxChangeDeg: number): number {
  const diff = (((desiredBearing - previousBearing + 540) % 360) - 180)
  const clamped = Math.max(-maxChangeDeg, Math.min(maxChangeDeg, diff))
  return (previousBearing + clamped + 360) % 360
}

export function getTerrainDirectionAtPoint(
  coord: number[],
  terrainSuitability: TerrainSuitabilityResult | null | undefined
): TerrainDirectionResult {
  const key = cacheKey(coord)
  const cached = CACHE.get(key)
  if (cached) return cached

  const result = computeTerrainDirection(coord, terrainSuitability)
  CACHE.set(key, result)
  return result
}

export function clearTerrainDirectionCache(): void {
  CACHE.clear()
}

function computeTerrainDirection(
  coord: number[],
  terrainSuitability: TerrainSuitabilityResult | null | undefined
): TerrainDirectionResult {
  if (!terrainSuitability) {
    return { fallLineBearing: null, contourBearing: null, slopePct: null, confidence: 'UNAVAILABLE' }
  }

  const north = fastRhumbDestinationCoord(coord, OFFSET_FT, 'feet', 0)
  const east = fastRhumbDestinationCoord(coord, OFFSET_FT, 'feet', 90)
  const south = fastRhumbDestinationCoord(coord, OFFSET_FT, 'feet', 180)
  const west = fastRhumbDestinationCoord(coord, OFFSET_FT, 'feet', 270)

  const samples = [north, east, south, west].filter(Boolean) as number[][]
  if (samples.length < 4) {
    return { fallLineBearing: null, contourBearing: null, slopePct: null, confidence: 'LOW' }
  }

  const [n, e, s, w] = [north, east, south, west].map(pt =>
    pt ? getTerrainSuitabilityAtPoint(pt, terrainSuitability).elevationFt : null
  )

  if (n == null || e == null || s == null || w == null) {
    return { fallLineBearing: null, contourBearing: null, slopePct: null, confidence: 'LOW' }
  }

  const offsetM = OFFSET_FT * 0.3048
  const dzEast = (e - w) / (2 * offsetM)
  const dzNorth = (n - s) / (2 * offsetM)

  const fallBearing = normalizeBearing((Math.atan2(dzEast, dzNorth) * 180) / Math.PI)
  const contourBearing = normalizeBearing(fallBearing + 90)
  const slope = Math.sqrt(dzEast * dzEast + dzNorth * dzNorth) * 100

  return {
    fallLineBearing: fallBearing,
    contourBearing,
    slopePct: slope,
    confidence: slope > 0 ? 'HIGH' : 'MODERATE'
  }
}
