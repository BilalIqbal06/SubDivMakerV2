import { Coordinate, CoordinateSystem } from '../types/gis'

/**
 * Coordinate System Transformations
 * Handles conversions between different coordinate reference systems
 */

// WGS84 (EPSG:4326) - Standard GPS coordinates
export const WGS84: CoordinateSystem = {
  name: 'WGS84',
  epsgCode: 4326,
  isProjected: false,
  units: 'degrees',
  transformToWGS84: (x: number, y: number) => ({ latitude: y, longitude: x }),
  transformFromWGS84: (coord: Coordinate) => ({ x: coord.longitude, y: coord.latitude })
}

// NAD83 Virginia State Plane South (EPSG:2285) - Common in Loudoun County area
export const NAD83_VA_SOUTH: CoordinateSystem = {
  name: 'NAD83 Virginia State Plane South',
  epsgCode: 2285,
  isProjected: true,
  units: 'feet',
  transformToWGS84: (x: number, y: number) => {
    // Simplified transformation - in production use proj4js or similar
    // This is a placeholder for proper coordinate transformation
    const lon = (x / 364000) * 2.5 + 77.5
    const lat = (y / 364000) * 2.0 + 38.5
    return { latitude: lat, longitude: lon }
  },
  transformFromWGS84: (coord: Coordinate) => {
    // Simplified transformation - in production use proj4js or similar
    const x = ((coord.longitude - 77.5) / 2.5) * 364000
    const y = ((coord.latitude - 38.5) / 2.0) * 364000
    return { x, y }
  }
}

// UTM Zone 17N (EPSG:32617) - Covers Virginia area
export const UTM_17N: CoordinateSystem = {
  name: 'UTM Zone 17N',
  epsgCode: 32617,
  isProjected: true,
  units: 'meters',
  transformToWGS84: (x: number, y: number) => {
    // Simplified transformation - in production use proj4js or similar
    const lon = (x - 500000) / 100000 + 81
    const lat = (y - 0) / 110000 + 0
    return { latitude: lat, longitude: lon }
  },
  transformFromWGS84: (coord: Coordinate) => {
    // Simplified transformation - in production use proj4js or similar
    const x = (coord.longitude - 81) * 100000 + 500000
    const y = coord.latitude * 110000
    return { x, y }
  }
}

/**
 * Convert coordinates from one system to another
 */
export function transformCoordinates(
  coord: Coordinate,
  fromSystem: CoordinateSystem,
  toSystem: CoordinateSystem
): Coordinate {
  // Transform to WGS84 first
  const wgs84 = fromSystem.transformToWGS84(coord.longitude, coord.latitude)
  
  // Then transform from WGS84 to target system
  const target = toSystem.transformFromWGS84(wgs84)
  
  // If target is projected, return the projected coordinates as latitude/longitude for storage
  // In production, you'd want to handle this differently
  if (toSystem.isProjected) {
    return { latitude: target.y, longitude: target.x }
  }
  
  // For non-projected systems, the target should already be in lat/lon format
  // but we need to ensure it matches the Coordinate interface
  return { latitude: target.y, longitude: target.x }
}

/**
 * Calculate distance between two coordinates in meters
 * Uses Haversine formula for WGS84 coordinates
 */
export function calculateDistance(coord1: Coordinate, coord2: Coordinate): number {
  const R = 6371000 // Earth's radius in meters
  const φ1 = (coord1.latitude * Math.PI) / 180
  const φ2 = (coord2.latitude * Math.PI) / 180
  const Δφ = ((coord2.latitude - coord1.latitude) * Math.PI) / 180
  const Δλ = ((coord2.longitude - coord1.longitude) * Math.PI) / 180

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return R * c
}

/**
 * Calculate area of a polygon in square meters
 * Uses Shoelace formula
 */
export function calculateArea(coordinates: number[][]): number {
  let area = 0
  const n = coordinates.length

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    area += coordinates[i][0] * coordinates[j][1]
    area -= coordinates[j][0] * coordinates[i][1]
  }

  return Math.abs(area / 2)
}

/**
 * Convert square meters to acres
 */
export function squareMetersToAcres(sqMeters: number): number {
  return sqMeters * 0.000247105
}

/**
 * Convert acres to square meters
 */
export function acresToSquareMeters(acres: number): number {
  return acres / 0.000247105
}

/**
 * Convert feet to meters
 */
export function feetToMeters(feet: number): number {
  return feet * 0.3048
}

/**
 * Convert meters to feet
 */
export function metersToFeet(meters: number): number {
  return meters / 0.3048
}

/**
 * Get coordinate system by EPSG code
 */
export function getCoordinateSystemByEPSG(epsgCode: number): CoordinateSystem | null {
  switch (epsgCode) {
    case 4326:
      return WGS84
    case 2285:
      return NAD83_VA_SOUTH
    case 32617:
      return UTM_17N
    default:
      return null
  }
}
