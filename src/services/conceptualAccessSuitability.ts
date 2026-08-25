// Conceptual access-suitability classifier for SubDivMaker V2
// This is a feasibility / jurisdiction-awareness layer, not a legal or entitlement decision.
// It uses whatever ArcGIS street-centerline attributes are actually present and does NOT
// invent missing values.

export type ConceptualAccessSuitability =
  | 'preferred'
  | 'conditional'
  | 'discouraged'
  | 'excluded'

export interface ConceptualAccessAssessment {
  suitability: ConceptualAccessSuitability
  reasons: string[]
  reviewRequired: boolean
  roadClass?: string | number | null
  owner?: string | null
  routeNumber?: string | null
  speedLimit?: string | number | null
  oneWay?: string | null
  streetType?: string | null
  dataComplete: boolean
}

export interface AssessAccessSuitabilityOptions {
  roadClass?: string | number | null
  owner?: string | null
  routeNumber?: string | null
  speedLimit?: string | number | null
  oneWay?: string | null
  streetType?: string | null
  streetFullName?: string | null
  jurisdiction?: string | null
}

function normalizeString(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function parseSpeedLimit(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return isNaN(parsed) ? null : parsed
}

/**
 * Determine whether a GIS road feature appears to be a plausible conceptual
 * development access candidate. This is deliberately conservative and
 * feasibility-oriented, and it must NOT be treated as a legal/entitlement
 * decision.
 */
export function assessConceptualAccessSuitability(
  options: AssessAccessSuitabilityOptions
): ConceptualAccessAssessment {
  const roadClass = normalizeString(options.roadClass)
  const owner = normalizeString(options.owner)
  const speedLimit = parseSpeedLimit(options.speedLimit)
  const oneWay = normalizeString(options.oneWay)
  const streetType = normalizeString(options.streetType)
  const streetFullName = normalizeString(options.streetFullName)

  const roadClassUpper = roadClass.toUpperCase()
  const ownerUpper = owner.toUpperCase()

  const hasRoadClass = roadClass.length > 0
  const hasOwner = owner.length > 0
  const hasSpeed = speedLimit !== null
  const hasOneWay = oneWay.length > 0
  const hasStreetType = streetType.length > 0

  const dataComplete = hasRoadClass && hasOwner && hasSpeed

  const reasons: string[] = []

  const isOneWay = hasOneWay && oneWay !== 'NULL' && oneWay !== ''
  const isPublic =
    ownerUpper.includes('VDOT') ||
    ownerUpper.includes('COUNTY') ||
    ownerUpper.includes('STATE') ||
    ownerUpper.includes('PUBLIC') ||
    ownerUpper.includes('TOWN') ||
    ownerUpper.includes('MUNICIPAL')
  const isPrivate =
    ownerUpper.includes('PRIVATE') ||
    ownerUpper.includes('DEVELOPER') ||
    ownerUpper.includes('FUTURE') ||
    ownerUpper.includes('HOMEOWNERS') ||
    ownerUpper.includes('HOA')

  const isLocal = roadClassUpper.includes('LOCAL') || roadClassUpper.includes('RESIDENTIAL')
  const isCollector = roadClassUpper.includes('COLLECTOR')
  const isArterial = roadClassUpper.includes('ARTERIAL')
  const isHighwayOrMajor =
    roadClassUpper.includes('HIGHWAY') ||
    roadClassUpper.includes('PARKWAY') ||
    roadClassUpper.includes('MAJOR') ||
    roadClassUpper.includes('PRINCIPAL')
  const isControlled =
    roadClassUpper.includes('INTERSTATE') ||
    roadClassUpper.includes('FREEWAY') ||
    roadClassUpper.includes('TURNPIKE') ||
    roadClassUpper.includes('CONTROLLED') ||
    roadClassUpper.includes('LIMITED') ||
    roadClassUpper.includes('RAMP') ||
    roadClassUpper.includes('ACCESS-CONTROLLED')

  let suitability: ConceptualAccessSuitability = 'conditional'
  let reviewRequired = true

  if (!dataComplete) {
    suitability = 'conditional'
    reasons.push('Insufficient GIS data to confirm access suitability')
  }

  if (isControlled) {
    suitability = 'excluded'
    reviewRequired = false
    reasons.push('Limited/controlled-access roadway in GIS; not a candidate for automatic subdivision entrance')
    return buildAssessment()
  }

  if (isArterial || (isHighwayOrMajor && !isLocal && !isCollector)) {
    suitability = 'discouraged'
    reasons.push('Major arterial / parkway / highway class; access management and spacing review required')
  } else if (isCollector) {
    suitability = 'conditional'
    reasons.push('Collector roadway; access spacing / location / agency review may be required')
  } else if (isLocal) {
    suitability = 'conditional'
    reasons.push('Local/residential roadway; generally favorable geometry for conceptual neighborhood access')
    // A public, non-one-way local road with a low speed limit is the closest to preferred.
    if (isPublic && !isOneWay && hasSpeed && speedLimit !== null && speedLimit <= 35) {
      suitability = 'preferred'
      reviewRequired = false
      reasons.push('Public local roadway, not one-way, with low speed limit')
    }
  } else if (!hasRoadClass) {
    suitability = 'conditional'
    reasons.push('Road classification not available or unrecognized; assuming conditional')
  }

  if (isOneWay) {
    if (suitability === 'preferred') {
      suitability = 'conditional'
    }
    reasons.push('One-way roadway; directionality and paired access review required')
  }

  if (isPrivate) {
    if (suitability === 'preferred') {
      suitability = 'conditional'
    }
    reasons.push('Ownership/access verification required')
  } else if (isPublic) {
    reasons.push('Public/VDOT/state/county ownership; agency access-management review may apply')
  } else if (hasOwner) {
    reasons.push('Owner classification unclear; verify access rights')
  }

  if (speedLimit !== null && speedLimit >= 45) {
    if (suitability === 'preferred') {
      suitability = 'conditional'
    }
    reasons.push('Speed limit suggests higher-class roadway; access may require geometric review')
  }

  if (!hasOneWay) {
    reasons.push('One-way status not provided in GIS; verify directionality')
  }

  if (!hasStreetType) {
    reasons.push('Street type not provided in GIS')
  }

  if (streetFullName && streetFullName.toUpperCase().includes('PKWY') && !isLocal && !isCollector) {
    // Parkway without a clear local/collector class is uncertain.
    if (suitability === 'preferred') {
      suitability = 'conditional'
    }
    reasons.push('Parkway-type name without clear local/collector classification; verify road hierarchy')
  }

  return buildAssessment()

  function buildAssessment(): ConceptualAccessAssessment {
    return {
      suitability,
      reasons,
      reviewRequired,
      roadClass: options.roadClass,
      owner: options.owner,
      routeNumber: options.routeNumber,
      speedLimit: options.speedLimit,
      oneWay: options.oneWay,
      streetType: options.streetType,
      dataComplete
    }
  }
}

/**
 * Convenience wrapper that extracts the real-world GIS fields from a
 * street-centerline feature and runs the classifier.
 */
export function assessStreetFeatureAccessSuitability(streetFeature: any): ConceptualAccessAssessment {
  const p = streetFeature?.properties || {}
  return assessConceptualAccessSuitability({
    roadClass: p.CE_RD_CLASS,
    owner: p.CE_OWNER,
    routeNumber: p.CE_RTNO,
    speedLimit: p.CE_SPEED_LMT,
    oneWay: p.CE_ONE_WAY,
    streetType: p.ST_STR_TYPE,
    streetFullName: p.ST_FULLNAME,
    jurisdiction: p.ST_JURIS
  })
}
