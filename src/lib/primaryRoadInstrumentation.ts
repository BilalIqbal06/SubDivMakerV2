/// <reference types="vite/client" />

import { turfCounter, turfPerformance, setOnNearestPointOnLine, setOnFeatureCollection } from './perf'

type LoopRecord = {
  executionCount: number
  iterations: number
  totalMs: number
  maxMs: number
  turfMs: number
  nonTurfMs: number
  earlyRejectedCount: number
  passedCount: number
}

type JsRecord = { calls: number; totalMs: number; maxMs: number }

type CallerFeature = { calls: number; totalMs: number }

type FeatureAssembly = {
  featureCollectionCalls: number
  featureCollectionTurfMs: number
  featureArrayAssemblyCalls: number
  featureArrayAssemblyMs: number
  geoJsonObjectAssemblyCalls: number
  geoJsonObjectAssemblyMs: number
  coordinateArrayAssemblyCalls: number
  coordinateArrayAssemblyMs: number
  bboxAssemblyCalls: number
  bboxAssemblyMs: number
  callers: Record<string, CallerFeature>
}

type ComplexityRecord = {
  outerLabel: string
  outerCount: number
  innerLabel: string
  averageInnerCount: number
  estimatedPairEvaluations: number
  actualPairEvaluations: number
  totalMs: number
  avgPairMs: number
}

type LogicalCaller = {
  turfCalls: number
  turfMs: number
  jsMs: number
  totalMs: number
  calls: number
}

function round3(n: number) { return Math.round(n * 1000) / 1000 }

export function getTurfStageTotal(): number {
  const stage = turfPerformance.getByStage()['primaryRoad'] || {}
  return Object.values(stage).reduce((s, o: any) => s + (o.totalMs || 0), 0)
}

let activeInstrument: PrimaryRoadInstrumentation | null = null
let jsPatched = false
let asyncPatched = false

export function getActivePrimaryRoadInstrumentation(): PrimaryRoadInstrumentation | null {
  return activeInstrument
}

function wrap<T>(op: string, fn: () => T): T {
  const inst = activeInstrument
  if (!inst || !inst.isActive()) return fn()
  const rec = inst.js[op] = inst.js[op] || { calls: 0, totalMs: 0, maxMs: 0 }
  rec.calls++
  const t0 = performance.now()
  try {
    return fn()
  } finally {
    const ms = performance.now() - t0
    rec.totalMs += ms
    rec.maxMs = Math.max(rec.maxMs, ms)
  }
}

let originalJSONStringify: typeof JSON.stringify
let originalStructuredClone: any
let originalArrayFrom: typeof Array.from
let originalArraySort: any
let originalArrayFlat: any
let originalArrayFlatMap: any

function patchJsOnce() {
  if (jsPatched) return
  jsPatched = true

  originalJSONStringify = JSON.stringify
  JSON.stringify = (...args: any[]) => wrap('JSON.stringify', () => originalJSONStringify.apply(JSON, args as any))

  if (typeof (globalThis as any).structuredClone === 'function') {
    originalStructuredClone = (globalThis as any).structuredClone
    ;(globalThis as any).structuredClone = (value: any, transfer?: any[]) =>
      wrap('structuredClone', () => originalStructuredClone(value, transfer))
  }

  originalArrayFrom = Array.from
  Array.from = (...args: any[]) => wrap('Array.from', () => originalArrayFrom.apply(Array, args as any))

  originalArraySort = Array.prototype.sort
  Array.prototype.sort = function (this: any[], ...args: any[]) {
    return wrap('Array.sort', () => originalArraySort.apply(this, args as any))
  }

  originalArrayFlat = Array.prototype.flat
  ;(Array.prototype as any).flat = function (this: any[], ...args: any[]) {
    return wrap('Array.flat', () => originalArrayFlat.apply(this, args as any))
  }

  originalArrayFlatMap = Array.prototype.flatMap
  Array.prototype.flatMap = function (this: any[], ...args: any[]) {
    return wrap('Array.flatMap', () => originalArrayFlatMap.apply(this, args as any))
  }
}

let originalSetTimeout: typeof window.setTimeout
let originalSetInterval: typeof window.setInterval
let originalRequestAnimationFrame: typeof window.requestAnimationFrame
let originalFetch: typeof window.fetch
let originalQueueMicrotask: typeof window.queueMicrotask

function patchAsyncOnce() {
  if (asyncPatched || typeof window === 'undefined') return
  asyncPatched = true

  originalSetTimeout = window.setTimeout
  window.setTimeout = (...args: any[]) => {
    if (activeInstrument && activeInstrument.isActive()) activeInstrument.async.setTimeoutCount++
    return originalSetTimeout.apply(window, args as any)
  }

  originalSetInterval = window.setInterval
  window.setInterval = (...args: any[]) => {
    if (activeInstrument && activeInstrument.isActive()) activeInstrument.async.setIntervalCount++
    return originalSetInterval.apply(window, args as any)
  }

  if (typeof window.requestAnimationFrame === 'function') {
    originalRequestAnimationFrame = window.requestAnimationFrame
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      if (activeInstrument && activeInstrument.isActive()) activeInstrument.async.animationFrameCount++
      return originalRequestAnimationFrame(cb)
    }
  }

  if (typeof window.fetch === 'function') {
    originalFetch = window.fetch
    window.fetch = (...args: any[]) => {
      if (activeInstrument && activeInstrument.isActive()) activeInstrument.async.networkCalls++
      return originalFetch.apply(window, args as any)
    }
  }

  originalQueueMicrotask = window.queueMicrotask
  window.queueMicrotask = (cb: VoidFunction) => {
    if (activeInstrument && activeInstrument.isActive()) activeInstrument.async.microtaskCount++
    originalQueueMicrotask(cb)
  }
}

export class PrimaryRoadInstrumentation {
  active = false
  loops: Record<string, LoopRecord> = {}
  js: Record<string, JsRecord> = {}
  feature: FeatureAssembly = {
    featureCollectionCalls: 0,
    featureCollectionTurfMs: 0,
    featureArrayAssemblyCalls: 0,
    featureArrayAssemblyMs: 0,
    geoJsonObjectAssemblyCalls: 0,
    geoJsonObjectAssemblyMs: 0,
    coordinateArrayAssemblyCalls: 0,
    coordinateArrayAssemblyMs: 0,
    bboxAssemblyCalls: 0,
    bboxAssemblyMs: 0,
    callers: {}
  }
  searchSpace: Record<string, any> = {}
  complexity: Record<string, ComplexityRecord> = {}
  async = {
    hasAwait: false,
    awaitCount: 0,
    promiseCount: 0,
    networkCalls: 0,
    setTimeoutCount: 0,
    setIntervalCount: 0,
    animationFrameCount: 0,
    microtaskCount: 0
  }
  nearestPoint = {
    calls: 0,
    unique: 0,
    duplicate: 0,
    pairs: new Map<string, number>()
  }
  logicalCallers: Record<string, LogicalCaller> = {}
  callerStack: string[] = []
  callerTurfStart = 0
  callerStart = 0

  constructor() {
    activeInstrument = this
    setOnNearestPointOnLine(this.recordNearestPoint.bind(this))
    setOnFeatureCollection(this.recordFeatureCollection.bind(this))
    if (import.meta.env.DEV) {
      patchJsOnce()
      patchAsyncOnce()
    }
  }

  isActive() { return this.active }
  setActive(v: boolean) { this.active = v }

  recordAwait() { this.async.hasAwait = true; this.async.awaitCount++ }
  recordPromise() { this.async.promiseCount++ }

  pushLogicalCaller(label: string) {
    if (!this.active) return
    const now = performance.now()
    if (this.callerStack.length > 0) {
      const current = this.callerStack[this.callerStack.length - 1]
      const c = this.logicalCallers[current] = this.logicalCallers[current] || { turfCalls: 0, turfMs: 0, jsMs: 0, totalMs: 0, calls: 0 }
      c.calls++
      c.totalMs += now - this.callerStart
      const turfNow = getTurfStageTotal()
      c.turfMs += turfNow - this.callerTurfStart
      c.jsMs += (now - this.callerStart) - (turfNow - this.callerTurfStart)
      const byCaller = turfCounter.getByCaller()[current] || {}
      c.turfCalls += Object.values(byCaller).reduce((s, v: any) => s + (typeof v === 'number' ? v : 0), 0)
    }
    this.callerStack.push(label)
    turfCounter.setCaller(label)
    this.callerStart = now
    this.callerTurfStart = getTurfStageTotal()
  }

  popLogicalCaller() {
    if (!this.active) return
    const now = performance.now()
    const current = this.callerStack.pop()
    if (current) {
      const c = this.logicalCallers[current] = this.logicalCallers[current] || { turfCalls: 0, turfMs: 0, jsMs: 0, totalMs: 0, calls: 0 }
      c.calls++
      c.totalMs += now - this.callerStart
      const turfNow = getTurfStageTotal()
      c.turfMs += turfNow - this.callerTurfStart
      c.jsMs += (now - this.callerStart) - (turfNow - this.callerTurfStart)
      const byCaller = turfCounter.getByCaller()[current] || {}
      c.turfCalls += Object.values(byCaller).reduce((s, v: any) => s + (typeof v === 'number' ? v : 0), 0)
    }
    const parent = this.callerStack[this.callerStack.length - 1] || 'primaryRoad'
    turfCounter.setCaller(parent)
    this.callerStart = now
    this.callerTurfStart = getTurfStageTotal()
  }

  setLogicalCaller(label: string) {
    this.callerStack = [label]
    this.pushLogicalCaller(label)
  }

  markLoop(label: string, iterations: number, startMs: number, turfBefore: number, earlyRejected = 0, passed = 0) {
    if (!this.active) return
    const now = performance.now()
    const totalMs = now - startMs
    const turfMs = getTurfStageTotal() - turfBefore
    const rec = this.loops[label] = this.loops[label] || { executionCount: 0, iterations: 0, totalMs: 0, maxMs: 0, turfMs: 0, nonTurfMs: 0, earlyRejectedCount: 0, passedCount: 0 }
    rec.executionCount++
    rec.iterations += iterations
    rec.totalMs += totalMs
    rec.maxMs = Math.max(rec.maxMs, totalMs)
    rec.turfMs += turfMs
    rec.nonTurfMs += totalMs - turfMs
    rec.earlyRejectedCount += earlyRejected
    rec.passedCount += passed
  }

  recordJs(op: string, ms: number) {
    const rec = this.js[op] = this.js[op] || { calls: 0, totalMs: 0, maxMs: 0 }
    rec.calls++
    rec.totalMs += ms
    rec.maxMs = Math.max(rec.maxMs, ms)
  }

  recordNonTurf(label: string) {
    const t0 = performance.now()
    return () => {
      const ms = performance.now() - t0
      this.recordJs(label, ms)
    }
  }

  recordFeatureCollection(turfMs: number, _arrayAssemblyMs = 0, _objectAssemblyMs = 0) {
    if (!this.active) return
    const caller = this.callerStack[this.callerStack.length - 1] || 'unknown'
    this.feature.featureCollectionCalls++
    this.feature.featureCollectionTurfMs += turfMs
    const c = this.feature.callers[caller] = this.feature.callers[caller] || { calls: 0, totalMs: 0 }
    c.calls++
    c.totalMs += turfMs
  }

  recordCoordinateArray(ms: number, caller?: string) {
    if (!this.active) return
    this.feature.coordinateArrayAssemblyCalls++
    this.feature.coordinateArrayAssemblyMs += ms
    const c = this.feature.callers[caller || this.callerStack[this.callerStack.length - 1] || 'unknown'] = this.feature.callers[caller || this.callerStack[this.callerStack.length - 1] || 'unknown'] || { calls: 0, totalMs: 0 }
    c.calls++
    c.totalMs += ms
  }

  recordBbox(ms: number, caller?: string) {
    if (!this.active) return
    this.feature.bboxAssemblyCalls++
    this.feature.bboxAssemblyMs += ms
    const c = this.feature.callers[caller || this.callerStack[this.callerStack.length - 1] || 'unknown'] = this.feature.callers[caller || this.callerStack[this.callerStack.length - 1] || 'unknown'] || { calls: 0, totalMs: 0 }
    c.calls++
    c.totalMs += ms
  }

  setSearchSpace(field: string, value: any) { this.searchSpace[field] = value }

  recordComplexity(outerLabel: string, outerCount: number, innerLabel: string, averageInnerCount: number, estimated: number, actual: number, ms: number) {
    if (!this.active) return
    const key = `${outerLabel}×${innerLabel}`
    this.complexity[key] = this.complexity[key] || {
      outerLabel,
      outerCount,
      innerLabel,
      averageInnerCount,
      estimatedPairEvaluations: 0,
      actualPairEvaluations: 0,
      totalMs: 0,
      avgPairMs: 0
    }
    const rec = this.complexity[key]
    rec.outerCount = outerCount
    rec.averageInnerCount = averageInnerCount
    rec.estimatedPairEvaluations += estimated
    rec.actualPairEvaluations += actual
    rec.totalMs += ms
    rec.avgPairMs = rec.actualPairEvaluations > 0 ? round3(rec.totalMs / rec.actualPairEvaluations) : 0
  }

  recordNearestPoint(pointKey: string, roadKey: string) {
    if (!this.active) return
    this.nearestPoint.calls++
    const key = `${pointKey}|${roadKey}`
    const prev = this.nearestPoint.pairs.get(key) || 0
    if (prev === 0) this.nearestPoint.unique++
    else this.nearestPoint.duplicate++
    this.nearestPoint.pairs.set(key, prev + 1)
  }

  getAudits(primaryRoadMs: number) {
    const loopArr = Object.entries(this.loops).map(([label, r]) => ({
      loopLabel: label,
      executionCount: r.executionCount,
      iterations: r.iterations,
      totalMs: round3(r.totalMs),
      avgIterationMs: r.iterations > 0 ? round3(r.totalMs / r.iterations) : 0,
      maxIterationMs: round3(r.maxMs),
      turfMsInsideLoop: round3(r.turfMs),
      nonTurfMsInsideLoop: round3(r.nonTurfMs),
      earlyRejectedCount: r.earlyRejectedCount,
      passedCount: r.passedCount
    })).sort((a, b) => b.totalMs - a.totalMs)

    const jsArr = Object.entries(this.js).map(([op, r]) => ({
      operation: op,
      calls: r.calls,
      totalMs: round3(r.totalMs),
      avgMs: r.calls > 0 ? round3(r.totalMs / r.calls) : 0,
      maxMs: round3(r.maxMs)
    })).sort((a, b) => b.totalMs - a.totalMs)

    const logicalArr = Object.entries(this.logicalCallers).map(([caller, r]) => ({
      caller,
      calls: r.calls,
      turfCalls: r.turfCalls,
      turfMs: round3(r.turfMs),
      jsMs: round3(r.jsMs),
      totalMs: round3(r.totalMs)
    })).sort((a, b) => b.totalMs - a.totalMs)

    const topRepeatedPairs = [...this.nearestPoint.pairs.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([key, count]) => {
        const [point, road] = key.split('|')
        return { roadId: road, pointKey: point, repeatCount: count }
      })

    const featureCallers = Object.entries(this.feature.callers)
      .map(([caller, c]) => ({ caller, calls: c.calls, totalMs: round3(c.totalMs) }))
      .sort((a, b) => b.totalMs - a.totalMs)

    return {
      loopAudit: {
        primaryRoadMs,
        loops: loopArr,
        rankedLoops: loopArr
      },
      jsAudit: {
        primaryRoadMs,
        operations: jsArr,
        rankedOperations: jsArr
      },
      featureAssemblyAudit: {
        featureCollectionCalls: this.feature.featureCollectionCalls,
        featureCollectionTurfMs: round3(this.feature.featureCollectionTurfMs),
        featureArrayAssemblyCalls: this.feature.featureArrayAssemblyCalls,
        featureArrayAssemblyMs: round3(this.feature.featureArrayAssemblyMs),
        geoJsonObjectAssemblyCalls: this.feature.geoJsonObjectAssemblyCalls,
        geoJsonObjectAssemblyMs: round3(this.feature.geoJsonObjectAssemblyMs),
        coordinateArrayAssemblyCalls: this.feature.coordinateArrayAssemblyCalls,
        coordinateArrayAssemblyMs: round3(this.feature.coordinateArrayAssemblyMs),
        bboxAssemblyCalls: this.feature.bboxAssemblyCalls,
        bboxAssemblyMs: round3(this.feature.bboxAssemblyMs),
        totalFeatureAssemblyMs: round3(
          this.feature.featureCollectionTurfMs +
          this.feature.featureArrayAssemblyMs +
          this.feature.geoJsonObjectAssemblyMs +
          this.feature.coordinateArrayAssemblyMs +
          this.feature.bboxAssemblyMs
        ),
        topFeatureCollectionCallers: featureCallers,
        topFeatureArrayCallers: featureCallers,
        topGeoJsonObjectCallers: featureCallers,
        topCoordinateArrayCallers: featureCallers,
        topBboxCallers: featureCallers
      },
      searchSpaceAudit: { ...this.searchSpace },
      complexityAudit: {
        relationships: Object.values(this.complexity),
        rankedComplexitySources: Object.values(this.complexity).sort((a: any, b: any) => b.totalMs - a.totalMs)
      },
      asyncAudit: {
        ...this.async,
        executionModel: this.async.hasAwait || this.async.promiseCount || this.async.networkCalls
          ? 'mixed'
          : 'synchronous-cpu-bound'
      },
      nearestPointAudit: {
        calls: this.nearestPoint.calls,
        uniquePointRoadPairs: this.nearestPoint.unique,
        duplicatePointRoadPairs: this.nearestPoint.duplicate,
        duplicatePercent: this.nearestPoint.calls > 0 ? round3((this.nearestPoint.duplicate / this.nearestPoint.calls) * 100) : 0,
        topRepeatedPairs
      },
      logicalCallerAudit: {
        callers: logicalArr,
        rankedCallers: logicalArr
      },
      measuredTurfMs: round3(getTurfStageTotal()),
      measuredJsMs: round3(jsArr.reduce((s, o) => s + o.totalMs, 0)),
      measuredLoopMs: round3(loopArr.reduce((s, o) => s + o.totalMs, 0))
    }
  }

  getReconciliation(primaryRoadMs: number) {
    const a = this.getAudits(primaryRoadMs)
    const nonTurfFeatureAssemblyMs = round3(a.featureAssemblyAudit.totalFeatureAssemblyMs - a.featureAssemblyAudit.featureCollectionTurfMs)
    const exclusiveKnown = a.measuredTurfMs + a.measuredJsMs + nonTurfFeatureAssemblyMs
    const inclusive = {
      loopMs: a.measuredLoopMs,
      callerMs: round3(Object.values(this.logicalCallers).reduce((s, c: any) => s + c.totalMs, 0)),
      phaseMs: primaryRoadMs
    }
    return {
      primaryRoadWallClockMs: primaryRoadMs,
      measuredTurfMs: a.measuredTurfMs,
      measuredExclusiveJsMs: a.measuredJsMs,
      featureAssemblyExclusiveMs: nonTurfFeatureAssemblyMs,
      knownMeasuredExclusiveMs: round3(exclusiveKnown),
      remainingUninstrumentedMs: round3(Math.max(0, primaryRoadMs - exclusiveKnown)),
      measurementCoveragePercent: primaryRoadMs > 0 ? round3((exclusiveKnown / primaryRoadMs) * 100) : 0,
      inclusiveDiagnosticViews: inclusive,
      exclusiveAccounting: {
        turfMs: a.measuredTurfMs,
        jsMs: a.measuredJsMs,
        featureAssemblyMs: nonTurfFeatureAssemblyMs,
        remainingMs: round3(Math.max(0, primaryRoadMs - exclusiveKnown))
      }
    }
  }
}
