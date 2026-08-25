// Core GIS types for SubDivMaker V2

export interface Coordinate {
  latitude: number
  longitude: number
}

export interface BoundingBox {
  north: number
  south: number
  east: number
  west: number
}

export interface ParcelGeometry {
  type: 'Polygon' | 'MultiPolygon'
  coordinates: number[][][] | number[][][][]
}

export interface Parcel {
  id: string
  parcelId: string
  address: string
  owner?: string
  acreage: number
  geometry: ParcelGeometry
  centroid: Coordinate
  boundingBox: BoundingBox
  jurisdiction: string
  zoningCode?: string
  zoningDescription?: string
  lastUpdated: string
  sourceUrl?: string
}

export interface ZoningDistrict {
  id: string
  code: string
  name: string
  description: string
  geometry: ParcelGeometry
  regulations: ZoningRegulations
}

export interface ZoningRegulations {
  minLotSize: number // in acres
  maxLotSize?: number // in acres
  minFrontage: number // in feet
  maxHeight: number // in feet
  maxCoverage: number // percentage
  setbacks: {
    front: number
    side: number
    rear: number
  }
  allowedUses: string[]
}

export interface JurisdictionConnector {
  name: string
  jurisdiction: string
  searchParcels: (query: string) => Promise<Parcel[]>
  getParcelById: (parcelId: string) => Promise<Parcel | null>
  getZoningForParcel: (parcelId: string) => Promise<ZoningDistrict | null>
  getParcelGeometry: (parcelId: string) => Promise<ParcelGeometry | null>
}

export interface SearchResult {
  parcel: Parcel
  matchScore: number
}

export interface SubdivisionParameters {
  numLots: number
  minLotSize: number
  targetLotSize: number
  preserveFeatures: string[]
  roadAccess: boolean
  utilityAccess: boolean
  setbacks: {
    front: number
    side: number
    rear: number
  }
}

export interface CoordinateSystem {
  name: string
  epsgCode: number
  isProjected: boolean
  units: 'meters' | 'feet' | 'degrees'
  transformToWGS84: (x: number, y: number) => Coordinate
  transformFromWGS84: (coord: Coordinate) => { x: number; y: number }
}
