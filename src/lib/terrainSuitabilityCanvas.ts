// Display-only canvas renderer for the terrain suitability surface.
// Keeps the authoritative TerrainSuitabilityResult untouched.

import * as turf from '@turf/turf'

export interface TerrainSuitabilityCanvasSpec {
  dataUrl: string
  bounds: [[number, number], [number, number]] // [[south, west], [north, east]]
  width: number
  height: number
}

const CLASS_COLORS = {
  PREFERRED: [22, 163, 74] as [number, number, number],
  MODERATE: [234, 179, 8] as [number, number, number],
  CHALLENGING: [249, 115, 22] as [number, number, number],
  AVOID: [220, 38, 38] as [number, number, number],
  INSUFFICIENT: [100, 116, 139] as [number, number, number]
}

const SLOPE_STOPS = [
  { slope: 0, color: CLASS_COLORS.PREFERRED },
  { slope: 5, color: CLASS_COLORS.PREFERRED },
  { slope: 10, color: CLASS_COLORS.MODERATE },
  { slope: 15, color: CLASS_COLORS.CHALLENGING },
  { slope: 20, color: CLASS_COLORS.AVOID },
  { slope: 40, color: CLASS_COLORS.AVOID }
]

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function lerpColor(
  a: [number, number, number],
  b: [number, number, number],
  t: number
): [number, number, number] {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t))
  ]
}

function slopeToColor(slopePct: number | null, terrainClass: string): string {
  if (slopePct == null || terrainClass === 'INSUFFICIENT_DATA') {
    return 'rgba(100,116,139,0.45)'
  }
  for (let i = 1; i < SLOPE_STOPS.length; i++) {
    const a = SLOPE_STOPS[i - 1]
    const b = SLOPE_STOPS[i]
    if (slopePct <= b.slope) {
      const t = (slopePct - a.slope) / (b.slope - a.slope)
      const c = lerpColor(a.color, b.color, t)
      return `rgba(${c[0]},${c[1]},${c[2]},0.72)`
    }
  }
  const last = SLOPE_STOPS[SLOPE_STOPS.length - 1].color
  return `rgba(${last[0]},${last[1]},${last[2]},0.72)`
}

function projectCoord(
  coord: number[],
  west: number,
  south: number,
  widthDeg: number,
  heightDeg: number,
  width: number,
  height: number
): { x: number; y: number } {
  return {
    x: ((coord[0] - west) / widthDeg) * width,
    y: height - ((coord[1] - south) / heightDeg) * height
  }
}

function featureToPath(
  ctx: CanvasRenderingContext2D,
  feature: any,
  project: (coord: number[]) => { x: number; y: number }
): void {
  if (!feature?.geometry) return
  const g = feature.geometry
  const rings: number[][][] = []

  if (g.type === 'Polygon') {
    rings.push(...g.coordinates)
  } else if (g.type === 'MultiPolygon') {
    for (const poly of g.coordinates) rings.push(...poly)
  } else if (g.type === 'GeometryCollection') {
    for (const gm of g.geometries) {
      if (gm.type === 'Polygon') rings.push(...gm.coordinates)
      else if (gm.type === 'MultiPolygon') {
        for (const poly of gm.coordinates) rings.push(...poly)
      }
    }
  }

  for (const ring of rings) {
    if (!ring?.length) continue
    const projected = ring.map(project)
    if (projected.length === 0) continue
    ctx.moveTo(projected[0].x, projected[0].y)
    for (let i = 1; i < projected.length; i++) {
      ctx.lineTo(projected[i].x, projected[i].y)
    }
    ctx.closePath()
  }
}

export function renderTerrainSuitabilityCanvas(
  suitabilityFeatures: any,
  candidateGeometry: any,
  hydrologyGeometry: any,
  maxDimension = 512
): TerrainSuitabilityCanvasSpec | null {
  if (!suitabilityFeatures?.features?.length) return null

  let bbox: [number, number, number, number] = turf.bbox(suitabilityFeatures) as [number, number, number, number]
  if (candidateGeometry) {
    try {
      const candidateBbox = turf.bbox(candidateGeometry) as [number, number, number, number]
      bbox = candidateBbox
    } catch {
      // fall back to suitability features bbox
    }
  }
  const [west, south, east, north] = bbox
  const widthDeg = Math.max(east - west, 1e-9)
  const heightDeg = Math.max(north - south, 1e-9)
  const aspect = widthDeg / heightDeg

  let width: number
  let height: number
  if (aspect >= 1) {
    width = Math.min(maxDimension, 768)
    height = Math.max(1, Math.min(Math.round(width / aspect), 768))
  } else {
    height = Math.min(maxDimension, 768)
    width = Math.max(1, Math.min(Math.round(height * aspect), 768))
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: false })
  if (!ctx) return null

  const project = (coord: number[]) =>
    projectCoord(coord, west, south, widthDeg, heightDeg, width, height)

  if (candidateGeometry) {
    ctx.save()
    ctx.beginPath()
    featureToPath(ctx, candidateGeometry, project)
    ctx.clip()
  }

  // Soft blur smooths cell boundaries while keeping local slope changes intact.
  ctx.filter = 'blur(2px)'
  for (const f of suitabilityFeatures.features) {
    const cls = f?.properties?.terrainClass ?? 'INSUFFICIENT_DATA'
    const slope = f?.properties?.slopePct ?? null
    ctx.fillStyle = slopeToColor(slope, cls)
    ctx.beginPath()
    featureToPath(ctx, f, project)
    ctx.fill()
  }
  ctx.filter = 'none'

  if (candidateGeometry) {
    ctx.restore()
  }

  if (hydrologyGeometry) {
    ctx.globalCompositeOperation = 'destination-out'
    ctx.beginPath()
    featureToPath(ctx, hydrologyGeometry, project)
    ctx.fill('evenodd')
    ctx.globalCompositeOperation = 'source-over'
  }

  const dataUrl = canvas.toDataURL('image/png')
  return {
    dataUrl,
    bounds: [
      [south, west],
      [north, east]
    ],
    width,
    height
  }
}
