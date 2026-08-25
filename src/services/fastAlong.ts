const EARTH_RADIUS_METERS = 6371000
const DEG_TO_RAD = Math.PI / 180

function toRad(deg: number): number { return deg * DEG_TO_RAD }

function haversineMeters(a: number[], b: number[]): number {
  const dLat = toRad(b[1] - a[1])
  const dLon = toRad(b[0] - a[0])
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)))
}

const alongCache = new WeakMap<GeoJSON.Feature<GeoJSON.LineString> | GeoJSON.LineString, number[]>()

export function fastAlong(
  line: GeoJSON.Feature<GeoJSON.LineString> | GeoJSON.LineString | null | undefined,
  distance: number,
  units: 'meters' | 'feet' = 'meters'
): GeoJSON.Feature<GeoJSON.Point> | null {
  if (!line) return null
  const target = (line as any).geometry ?? (line as any)
  if (!target || target.type !== 'LineString' || !Array.isArray(target.coordinates) || target.coordinates.length < 2) {
    return null
  }
  const coords = target.coordinates as number[][]
  let cumulative = alongCache.get(line as any) ?? alongCache.get(target)
  if (!cumulative) {
    cumulative = [0]
    for (let i = 1; i < coords.length; i++) {
      cumulative.push(cumulative[i - 1] + haversineMeters(coords[i - 1], coords[i]))
    }
    alongCache.set(line as any, cumulative)
  }
  const totalM = cumulative[cumulative.length - 1]
  const distanceM = units === 'feet' ? distance * 0.3048 : distance
  if (totalM <= 0) {
    return { type: 'Feature', geometry: { type: 'Point', coordinates: coords[0] }, properties: {} } as any
  }
  if (distanceM <= 0) {
    return { type: 'Feature', geometry: { type: 'Point', coordinates: coords[0] }, properties: {} } as any
  }
  if (distanceM >= totalM) {
    return { type: 'Feature', geometry: { type: 'Point', coordinates: coords[coords.length - 1] }, properties: {} } as any
  }
  for (let i = 1; i < cumulative.length; i++) {
    if (distanceM <= cumulative[i]) {
      const segLen = cumulative[i] - cumulative[i - 1]
      if (segLen <= 0) {
        return { type: 'Feature', geometry: { type: 'Point', coordinates: coords[i] }, properties: {} } as any
      }
      const t = (distanceM - cumulative[i - 1]) / segLen
      const p0 = coords[i - 1]
      const p1 = coords[i]
      const x = p0[0] + (p1[0] - p0[0]) * t
      const y = p0[1] + (p1[1] - p0[1]) * t
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [x, y] }, properties: {} } as any
    }
  }
  return { type: 'Feature', geometry: { type: 'Point', coordinates: coords[coords.length - 1] }, properties: {} } as any
}

function getCoord(point: any): number[] | null {
  if (!point) return null
  if (Array.isArray(point)) {
    if (point.length >= 2 && typeof point[0] === 'number' && typeof point[1] === 'number') return point
    return null
  }
  const c = point.geometry?.coordinates ?? point.coordinates
  if (Array.isArray(c) && c.length >= 2 && typeof c[0] === 'number' && typeof c[1] === 'number') return c
  return null
}

function toDeg(rad: number): number { return rad / DEG_TO_RAD }

function rhumbDestinationCoord(coord: number[], distanceM: number, bearingDeg: number): number[] {
  const φ1 = toRad(coord[1])
  const λ1 = toRad(coord[0])
  const θ = toRad(bearingDeg)
  const δ = distanceM / EARTH_RADIUS_METERS
  const Δφ = δ * Math.cos(θ)
  const φ2 = φ1 + Δφ
  const d1 = φ1 / 2 + Math.PI / 4
  const d2 = φ2 / 2 + Math.PI / 4
  const Δψ = Math.log(Math.abs(Math.tan(d2) / Math.tan(d1)))
  const q = Math.abs(Δψ) > 1e-12 ? Δφ / Δψ : Math.cos(φ1)
  const Δλ = (δ * Math.sin(θ)) / q
  const λ2 = λ1 + Δλ
  return [toDeg(λ2), toDeg(φ2)]
}

export function fastRhumbDestination(
  point: any,
  distance: number,
  units: 'meters' | 'feet',
  bearing: number
): GeoJSON.Feature<GeoJSON.Point> | null {
  const coord = getCoord(point)
  if (!coord) return null
  const dM = units === 'feet' ? distance * 0.3048 : distance
  const dest = rhumbDestinationCoord(coord, dM, bearing)
  return { type: 'Feature', geometry: { type: 'Point', coordinates: dest }, properties: {} } as any
}

export function fastRhumbDestinationCoord(
  point: any,
  distance: number,
  units: 'meters' | 'feet',
  bearing: number
): number[] | null {
  const coord = getCoord(point)
  if (!coord) return null
  const dM = units === 'feet' ? distance * 0.3048 : distance
  return rhumbDestinationCoord(coord, dM, bearing)
}

export function fastBearing(from: any, to: any): number | null {
  const a = getCoord(from)
  const b = getCoord(to)
  if (!a || !b) return null
  const φ1 = toRad(a[1])
  const φ2 = toRad(b[1])
  const Δλ = toRad(b[0] - a[0])
  const x = Math.sin(Δλ) * Math.cos(φ2)
  const y = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  const θ = Math.atan2(x, y)
  let deg = toDeg(θ)
  deg = ((deg % 360) + 360) % 360
  return deg
}
