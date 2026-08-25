/// <reference types="vite/client" />

export const ENABLE_EXPENSIVE_PERFORMANCE_DIAGNOSTICS =
  import.meta.env.DEV &&
  import.meta.env.VITE_ENABLE_EXPENSIVE_PERFORMANCE_DIAGNOSTICS === 'true'

// Dev-only verbose GIS diagnostics flag. Set VITE_VERBOSE_GIS_DIAGNOSTICS=true
// in the Vite dev environment to enable detailed per-candidate/per-feature logs.
export const VERBOSE_GIS_DIAGNOSTICS =
  import.meta.env.DEV &&
  import.meta.env.VITE_VERBOSE_GIS_DIAGNOSTICS === 'true'

export function isVerboseGisDiagnostics(): boolean {
  return VERBOSE_GIS_DIAGNOSTICS
}

// Default DEV-level compact log (kept in normal DEV output)
export function devLog(tag: string, payload?: unknown): void {
  if (!import.meta.env.DEV) return
  console.log(tag, payload)
}

// Verbose DEV log (only when VITE_VERBOSE_GIS_DIAGNOSTICS is true)
export function verboseLog(tag: string, payload?: unknown): void {
  if (!VERBOSE_GIS_DIAGNOSTICS) return
  console.log(tag, payload)
}

export function devError(tag: string, payload?: unknown): void {
  if (!import.meta.env.DEV) return
  console.error(tag, payload)
}

export function devWarn(tag: string, payload?: unknown): void {
  if (!import.meta.env.DEV) return
  console.warn(tag, payload)
}

// Stage-level performance tracker
export interface StageTimings {
  [stage: string]: number
}

class PerformanceTracker {
  private starts: Record<string, number> = {}
  private timings: StageTimings = {}
  private maxTimings: StageTimings = {}
  private totalStart = 0

  reset(): void {
    this.starts = {}
    this.timings = {}
    this.maxTimings = {}
    this.totalStart = 0
  }

  start(stage: string): void {
    this.starts[stage] = performance.now()
  }

  finish(stage: string): void {
    const start = this.starts[stage]
    if (start === undefined) return
    const ms = performance.now() - start
    this.timings[stage] = (this.timings[stage] || 0) + ms
    this.maxTimings[stage] = Math.max(this.maxTimings[stage] || 0, ms)
    delete this.starts[stage]
  }

  set(stage: string, ms: number): void {
    this.timings[stage] = (this.timings[stage] || 0) + ms
  }

  get(): StageTimings {
    return { ...this.timings }
  }

  getMax(): StageTimings {
    return { ...this.maxTimings }
  }

  startTotal(): void {
    this.totalStart = performance.now()
  }

  getTotalMs(): number {
    if (this.totalStart === 0) return 0
    return performance.now() - this.totalStart
  }
}

export const generationPerformance = new PerformanceTracker()

// Recompute counter for the expensive production generators
class RecomputeCounter {
  private counts: Record<string, number> = {}
  private semanticKeys: Record<string, Set<string>> = {}
  private perKey: Record<string, Record<string, { count: number; causes: { strictModeReplay: number; stateDependencyRecompute: number; actualProductionDuplicate: number } }>> = {}

  reset(_workflowRunId: number | string = ''): void {
    this.counts = {}
    this.semanticKeys = {}
    this.perKey = {}
  }

  setWorkflowRunId(_workflowRunId: number | string): void {
    // no-op; workflowRunId is part of the external semantic key when needed
  }

  increment(generator: string, semanticKey?: string, cause: 'strictModeReplay' | 'stateDependencyRecompute' | 'actualProductionDuplicate' = 'actualProductionDuplicate'): void {
    this.counts[generator] = (this.counts[generator] || 0) + 1
    if (semanticKey) {
      if (!this.semanticKeys[generator]) {
        this.semanticKeys[generator] = new Set<string>()
      }
      this.semanticKeys[generator].add(semanticKey)
      if (!this.perKey[generator]) {
        this.perKey[generator] = {}
      }
      if (!this.perKey[generator][semanticKey]) {
        this.perKey[generator][semanticKey] = { count: 0, causes: { strictModeReplay: 0, stateDependencyRecompute: 0, actualProductionDuplicate: 0 } }
      }
      this.perKey[generator][semanticKey].count++
      this.perKey[generator][semanticKey].causes[cause]++
    }
  }

  isFirstTime(generator: string, semanticKey: string): boolean {
    return !this.perKey[generator]?.[semanticKey]
  }

  getCauseBreakdown(generator: string): { strictModeReplay: number; stateDependencyRecompute: number; actualProductionDuplicate: number } {
    const g = this.perKey[generator]
    if (!g) return { strictModeReplay: 0, stateDependencyRecompute: 0, actualProductionDuplicate: 0 }
    return Object.values(g).reduce((s, k) => {
      s.strictModeReplay += k.causes.strictModeReplay
      s.stateDependencyRecompute += k.causes.stateDependencyRecompute
      s.actualProductionDuplicate += k.causes.actualProductionDuplicate
      return s
    }, { strictModeReplay: 0, stateDependencyRecompute: 0, actualProductionDuplicate: 0 })
  }

  get(): Record<string, number> {
    return { ...this.counts }
  }

  snapshot(): Record<string, number> {
    return { ...this.counts }
  }

  getUniqueCount(generator: string): number {
    return this.semanticKeys[generator]?.size ?? 0
  }

  getUniqueKeys(generator: string): string[] {
    return [...(this.semanticKeys[generator] ?? new Set<string>())]
  }

  getAll(): Record<string, { requestCount: number; uniqueSemanticRequestCount: number; actualGeneratorExecutionCount: number; cacheHitCount: number; uniqueKeys: string[]; duplicateSemanticExecutionCount: number; strictModeReplayCount: number; stateDependencyRecomputeCount: number; actualProductionDuplicateCount: number; causes: { strictModeReplay: number; stateDependencyRecompute: number; actualProductionDuplicate: number } }> {
    const result: Record<string, { requestCount: number; uniqueSemanticRequestCount: number; actualGeneratorExecutionCount: number; cacheHitCount: number; uniqueKeys: string[]; duplicateSemanticExecutionCount: number; strictModeReplayCount: number; stateDependencyRecomputeCount: number; actualProductionDuplicateCount: number; causes: { strictModeReplay: number; stateDependencyRecompute: number; actualProductionDuplicate: number } }> = {}
    const allGenerators = new Set([...Object.keys(this.counts), ...Object.keys(this.semanticKeys)])
    for (const g of allGenerators) {
      const requests = this.counts[g] || 0
      const unique = this.getUniqueCount(g)
      const causes = this.getCauseBreakdown(g)
      result[g] = {
        requestCount: requests,
        uniqueSemanticRequestCount: unique,
        actualGeneratorExecutionCount: unique,
        cacheHitCount: Math.max(0, requests - unique),
        uniqueKeys: this.getUniqueKeys(g),
        duplicateSemanticExecutionCount: Math.max(0, requests - unique),
        strictModeReplayCount: causes.strictModeReplay,
        stateDependencyRecomputeCount: causes.stateDependencyRecompute,
        actualProductionDuplicateCount: causes.actualProductionDuplicate,
        causes
      }
    }
    return result
  }
}

export const recomputeCounter = new RecomputeCounter()

// Network request counter
class NetworkRequestCounter {
  private byCategory: Record<string, number> = {}
  private byCategoryMs: Record<string, number> = {}
  private byCategoryMaxMs: Record<string, number> = {}
  private duplicates: Record<string, number> = {}
  private seen = new Set<string>()
  private slowestCategory = ''
  private slowestMs = 0
  private starts: Record<string, number> = {}

  reset(): void {
    this.byCategory = {}
    this.byCategoryMs = {}
    this.byCategoryMaxMs = {}
    this.duplicates = {}
    this.seen = new Set<string>()
    this.slowestCategory = ''
    this.slowestMs = 0
    this.starts = {}
  }

  start(category: string, key: string): void {
    this.starts[key] = performance.now()
    const seenKey = `${category}|${key}`
    if (this.seen.has(seenKey)) {
      this.duplicates[category] = (this.duplicates[category] || 0) + 1
    } else {
      this.seen.add(seenKey)
    }
  }

  finish(category: string, key: string): void {
    const start = this.starts[key]
    if (start === undefined) return
    const ms = performance.now() - start
    this.byCategory[category] = (this.byCategory[category] || 0) + 1
    this.byCategoryMs[category] = (this.byCategoryMs[category] || 0) + ms
    this.byCategoryMaxMs[category] = Math.max(this.byCategoryMaxMs[category] || 0, ms)
    if (ms > this.slowestMs) {
      this.slowestMs = ms
      this.slowestCategory = category
    }
    delete this.starts[key]
  }

  count(category: string, ms: number = 0): void {
    this.byCategory[category] = (this.byCategory[category] || 0) + 1
    this.byCategoryMs[category] = (this.byCategoryMs[category] || 0) + ms
    this.byCategoryMaxMs[category] = Math.max(this.byCategoryMaxMs[category] || 0, ms)
    if (ms > this.slowestMs) {
      this.slowestMs = ms
      this.slowestCategory = category
    }
  }

  get(): { byCategory: Record<string, number>; byCategoryMs: Record<string, number>; byCategoryMaxMs: Record<string, number>; duplicates: Record<string, number>; slowestCategory: string } {
    return {
      byCategory: { ...this.byCategory },
      byCategoryMs: { ...this.byCategoryMs },
      byCategoryMaxMs: { ...this.byCategoryMaxMs },
      duplicates: { ...this.duplicates },
      slowestCategory: this.slowestCategory
    }
  }
}

export const networkCounter = new NetworkRequestCounter()

class MapRenderPerformance {
  private renderStart = 0
  private featureCounts: Record<string, number> = {}
  private layerTimings: Record<string, number> = {}

  reset(): void {
    this.renderStart = 0
    this.featureCounts = {}
    this.layerTimings = {}
  }

  start(): void {
    this.renderStart = performance.now()
  }

  finish(): number {
    const ms = this.renderStart === 0 ? 0 : performance.now() - this.renderStart
    this.renderStart = 0
    return ms
  }

  setFeatureCounts(counts: Record<string, number>): void {
    this.featureCounts = { ...counts }
  }

  recordLayer(label: string, ms: number): void {
    this.layerTimings[label] = (this.layerTimings[label] || 0) + ms
  }

  get(): { renderMs: number; featureCounts: Record<string, number>; layerTimings: Record<string, number> } {
    return {
      renderMs: this.renderStart === 0 ? 0 : performance.now() - this.renderStart,
      featureCounts: { ...this.featureCounts },
      layerTimings: { ...this.layerTimings }
    }
  }
}

export const mapRenderPerformance = new MapRenderPerformance()

const emittedLogKeys = new Set<string>()

export function devLogOnce(key: string, tag: string, payload?: unknown): void {
  if (!import.meta.env.DEV) return
  if (emittedLogKeys.has(key)) return
  emittedLogKeys.add(key)
  console.log(tag, payload)
}

// Workflow timeline marker collection
class WorkflowTimeline {
  private marks: Record<string, number> = {}
  private start = 0

  reset(): void {
    this.marks = {}
    this.start = 0
  }

  mark(label: string): void {
    if (this.start === 0) this.start = performance.now()
    this.marks[label] = performance.now()
  }

  get(): { marks: Record<string, number>; gaps: { between: [string, string]; ms: number }[]; largestGapMs: number; largestGapBetween: [string, string] } {
    const keys = Object.keys(this.marks)
    const gaps: { between: [string, string]; ms: number }[] = []
    let largestGapMs = 0
    let largestGapBetween: [string, string] = ['', '']
    for (let i = 1; i < keys.length; i++) {
      const ms = this.marks[keys[i]] - this.marks[keys[i - 1]]
      gaps.push({ between: [keys[i - 1], keys[i]], ms })
      if (ms > largestGapMs) {
        largestGapMs = ms
        largestGapBetween = [keys[i - 1], keys[i]]
      }
    }
    return { marks: { ...this.marks }, gaps, largestGapMs, largestGapBetween }
  }
}

export const workflowTimeline = new WorkflowTimeline()

// Authoritative end-to-end critical path tracker (interval-based, overlap-aware)
interface CriticalPathInterval {
  start: number
  ready: number | null
  durationMs: number
}

class WorkflowCriticalPath {
  private intervals: Record<string, CriticalPathInterval[]> = {}
  private order: string[] = []
  private active: Record<string, number> = {}

  reset(): void {
    this.intervals = {}
    this.order = []
    this.active = {}
  }

  start(stage: string, ts = performance.now()): void {
    if (!this.intervals[stage]) {
      this.order.push(stage)
      this.intervals[stage] = []
    }
    this.active[stage] = ts
  }

  ready(stage: string, ts = performance.now()): void {
    const start = this.active[stage]
    if (start === undefined) return
    this.intervals[stage].push({ start, ready: ts, durationMs: ts - start })
    delete this.active[stage]
  }

  mark(stage: string, ts = performance.now()): void {
    if (!this.intervals[stage]) {
      this.order.push(stage)
      this.intervals[stage] = []
    }
    this.intervals[stage].push({ start: ts, ready: ts, durationMs: 0 })
  }

  private stageUnion(intervals: CriticalPathInterval[]): { start: number; ready: number; durationMs: number } {
    if (intervals.length === 0) return { start: 0, ready: 0, durationMs: 0 }
    const sorted = [...intervals].sort((a, b) => a.start - b.start)
    let start = sorted[0].start
    let ready = sorted[0].ready ?? start
    let duration = 0
    let curStart = start
    let curReady = ready
    for (let i = 1; i < sorted.length; i++) {
      const iv = sorted[i]
      const ivReady = iv.ready ?? iv.start
      if (iv.start <= curReady) {
        curReady = Math.max(curReady, ivReady)
      } else {
        duration += curReady - curStart
        curStart = iv.start
        curReady = ivReady
      }
    }
    duration += curReady - curStart
    return { start, ready: curReady, durationMs: duration }
  }

  private allIntervalsSorted(): { stage: string; start: number; ready: number }[] {
    const all: { stage: string; start: number; ready: number }[] = []
    for (const [stage, ivs] of Object.entries(this.intervals)) {
      for (const iv of ivs) {
        if (iv.ready === null) continue
        all.push({ stage, start: iv.start, ready: iv.ready })
      }
    }
    return all.sort((a, b) => a.start - b.start)
  }

  private unionOfIntervals(intervals: { start: number; ready: number }[]): { start: number; ready: number; durationMs: number; merged: { start: number; ready: number }[] } {
    if (intervals.length === 0) return { start: 0, ready: 0, durationMs: 0, merged: [] }
    const sorted = [...intervals].sort((a, b) => a.start - b.start)
    const merged: { start: number; ready: number }[] = []
    let cur = { ...sorted[0] }
    for (let i = 1; i < sorted.length; i++) {
      const iv = sorted[i]
      if (iv.start <= cur.ready) {
        cur.ready = Math.max(cur.ready, iv.ready)
      } else {
        merged.push({ ...cur })
        cur = { ...iv }
      }
    }
    merged.push({ ...cur })
    const duration = merged.reduce((s, m) => s + (m.ready - m.start), 0)
    return { start: merged[0].start, ready: merged[merged.length - 1].ready, durationMs: duration, merged }
  }

  private overlaps(intervals: { stage: string; start: number; ready: number }[]): { stages: string[]; start: number; end: number; overlapMs: number }[] {
    if (intervals.length === 0) return []
    const events: { t: number; stage: string; type: 'start' | 'ready' }[] = []
    for (const iv of intervals) {
      events.push({ t: iv.start, stage: iv.stage, type: 'start' })
      events.push({ t: iv.ready, stage: iv.stage, type: 'ready' })
    }
    events.sort((a, b) => a.t - b.t || (a.type === 'ready' ? -1 : 1))
    let active = new Set<string>()
    let prevT = 0
    let first = true
    const overlaps: { stages: string[]; start: number; end: number; overlapMs: number }[] = []
    for (const e of events) {
      if (!first && active.size > 1 && e.t > prevT) {
        overlaps.push({ stages: [...active], start: prevT, end: e.t, overlapMs: e.t - prevT })
      }
      if (e.type === 'start') active.add(e.stage)
      else active.delete(e.stage)
      prevT = e.t
      first = false
    }
    return overlaps
  }

  getStageTimestamps(): Record<string, { start: number; ready: number; durationMs: number }> {
    const out: Record<string, { start: number; ready: number; durationMs: number }> = {}
    for (const stage of this.order) {
      out[stage] = this.stageUnion(this.intervals[stage] ?? [])
    }
    return out
  }

  get(): Record<string, any> {
    const allSorted = this.allIntervalsSorted()
    const union = this.unionOfIntervals(allSorted)
    const overlapping = this.overlaps(allSorted)
    const overlappingMeasuredMs = round3(overlapping.reduce((s, o) => s + o.overlapMs, 0))

    const stageDurations: { stage: string; start: number; ready: number; durationMs: number }[] = []
    for (const stage of this.order) {
      const u = this.stageUnion(this.intervals[stage] ?? [])
      if (u.durationMs > 0 || u.ready > 0) {
        stageDurations.push({ stage, start: u.start, ready: u.ready, durationMs: round3(u.durationMs) })
      }
    }
    const stagesSortedDescending = [...stageDurations].sort((a, b) => b.durationMs - a.durationMs)

    const timestamps: Record<string, { start: number; ready: number | null; durationMs: number }> = {}
    for (const stage of this.order) {
      const ivs = this.intervals[stage] ?? []
      timestamps[stage] = ivs.length > 0
        ? { start: ivs[0].start, ready: ivs[ivs.length - 1].ready, durationMs: round3(ivs.reduce((s, iv) => s + (iv.ready ? iv.ready - iv.start : 0), 0)) }
        : { start: 0, ready: null, durationMs: 0 }
    }

    const merged = union.merged
    const gaps: { between: string[]; start: number; ready: number; ms: number }[] = []
    let largestGapMs = 0
    let largestGapBetween: string[] = []
    for (let i = 1; i < merged.length; i++) {
      const ms = merged[i].start - merged[i - 1].ready
      if (ms >= 0) {
        gaps.push({ between: [`idle-gap-${i - 1}`, `idle-gap-${i}`], start: merged[i - 1].ready, ready: merged[i].start, ms })
        if (ms > largestGapMs) {
          largestGapMs = ms
          largestGapBetween = [`idle-gap-${i - 1}`, `idle-gap-${i}`]
        }
      }
    }

    const totalWorkflowWallClockMs = union.ready - union.start
    const accountedWallClockMs = round3(union.durationMs)
    const unaccountedWallClockMs = Math.max(0, round3(totalWorkflowWallClockMs - accountedWallClockMs))
    const accountedPercent = totalWorkflowWallClockMs > 0 ? (accountedWallClockMs / totalWorkflowWallClockMs) * 100 : 0

    return {
      timestamps,
      totalWorkflowWallClockMs: round3(totalWorkflowWallClockMs),
      stageDurations,
      stagesSortedDescending,
      gaps,
      largestGapMs: round3(largestGapMs),
      largestGapBetween,
      accountedWallClockMs,
      unaccountedWallClockMs,
      accountedPercent: round3(accountedPercent),
      overlappingMeasuredMs,
      overlaps: overlapping
    }
  }
}

export const workflowCriticalPath = new WorkflowCriticalPath()

// Tracks the true user-perceived wall clock from button click to export ready
class UserPerceivedWorkflow {
  private userAnalyzeClick = 0
  private generateExportReady = 0

  markUserAnalyzeClick(ts = performance.now()): void {
    this.userAnalyzeClick = ts
  }

  markGenerateExportReady(ts = performance.now()): void {
    this.generateExportReady = ts
  }

  get(): { userAnalyzeClickTimestamp: number; generateExportReadyTimestamp: number; userPerceivedWallClockMs: number } {
    return {
      userAnalyzeClickTimestamp: this.userAnalyzeClick,
      generateExportReadyTimestamp: this.generateExportReady,
      userPerceivedWallClockMs: this.generateExportReady - this.userAnalyzeClick
    }
  }
}

export const userPerceivedWorkflow = new UserPerceivedWorkflow()

// Helper to round to 3 decimals for audit reports
export const round3 = (n: number) => Math.round(n * 1000) / 1000

// Per-workflow deterministic result cache to avoid repeating identical
// expensive synchronous generator work in React StrictMode.
class WorkflowResultCache {
  private cache: Record<string, { result: any; ms: number; stage: string; semanticKey: string; workflowRunId: string; resultIdentityVerified: boolean }> = {}
  private stats: Record<string, { requests: number; hits: number; msAvoided: number }> = {}

  reset(_workflowRunId: number | string = ''): void {
    this.cache = {}
    this.stats = {}
  }

  setWorkflowRunId(_workflowRunId: number | string): void {
    // no-op; workflowRunId is part of the cache key string
  }

  private key(workflowRunId: number | string, stage: string, semanticKey: string): string {
    return `${String(workflowRunId)}|${stage}|${semanticKey}`
  }

  get(workflowRunId: number | string, stage: string, semanticKey: string): { result: any; ms: number; cached: boolean; resultIdentityVerified: boolean } | null {
    this.stats[stage] = this.stats[stage] || { requests: 0, hits: 0, msAvoided: 0 }
    this.stats[stage].requests++
    const entry = this.cache[this.key(workflowRunId, stage, semanticKey)]
    if (!entry) return null
    this.stats[stage].hits++
    this.stats[stage].msAvoided += entry.ms
    return { result: entry.result, ms: entry.ms, cached: true, resultIdentityVerified: entry.resultIdentityVerified }
  }

  set(workflowRunId: number | string, stage: string, semanticKey: string, result: any, ms: number, resultIdentityVerified = true): void {
    this.cache[this.key(workflowRunId, stage, semanticKey)] = { result, ms, stage, semanticKey, workflowRunId: String(workflowRunId), resultIdentityVerified }
    this.stats[stage] = this.stats[stage] || { requests: 0, hits: 0, msAvoided: 0 }
  }

  getAudit(): Record<string, { requests: number; uniqueSemanticRequests: number; cacheHits: number; actualExecutions: number; msAvoided: number; resultIdentityVerified: boolean }> {
    const byStage: Record<string, { requests: number; uniqueSemanticRequests: number; cacheHits: number; actualExecutions: number; msAvoided: number; resultIdentityVerified: boolean }> = {}
    for (const entry of Object.values(this.cache)) {
      if (!byStage[entry.stage]) {
        byStage[entry.stage] = { requests: 0, uniqueSemanticRequests: 0, cacheHits: 0, actualExecutions: 0, msAvoided: 0, resultIdentityVerified: true }
      }
      byStage[entry.stage].uniqueSemanticRequests++
      byStage[entry.stage].actualExecutions++
    }
    for (const [stage, stat] of Object.entries(this.stats)) {
      if (!byStage[stage]) {
        byStage[stage] = { requests: stat.requests, uniqueSemanticRequests: 0, cacheHits: stat.hits, actualExecutions: 0, msAvoided: stat.msAvoided, resultIdentityVerified: true }
      } else {
        byStage[stage].requests = stat.requests
        byStage[stage].cacheHits = stat.hits
        byStage[stage].msAvoided = stat.msAvoided
      }
    }
    return byStage
  }
}

export const workflowResultCache = new WorkflowResultCache()

// Simple diagnostic overhead tracker for audit construction and console serialization.
class DiagnosticOverheadTracker {
  private auditConstructionMs = 0
  private consoleSerializationMs = 0
  private auditEmissionCount = 0

  reset(): void {
    this.auditConstructionMs = 0
    this.consoleSerializationMs = 0
    this.auditEmissionCount = 0
  }

  start(): number {
    return performance.now()
  }

  recordAuditConstruction(start: number): void {
    this.auditConstructionMs += performance.now() - start
    this.auditEmissionCount++
  }

  recordConsoleSerialization(start: number): void {
    this.consoleSerializationMs += performance.now() - start
  }

  get(): { auditObjectConstructionMs: number; consoleSerializationMs: number; auditEmissionCount: number } {
    return {
      auditObjectConstructionMs: round3(this.auditConstructionMs),
      consoleSerializationMs: round3(this.consoleSerializationMs),
      auditEmissionCount: this.auditEmissionCount
    }
  }
}

export const diagnosticOverhead = new DiagnosticOverheadTracker()

// Counted Turf proxy with stage/caller context for per-stage billing
class TurfOperationCounter {
  private counts: Record<string, number> = {}
  private byStage: Record<string, Record<string, number>> = {}
  private byCaller: Record<string, Record<string, number>> = {}
  private activeStage = ''
  private activeCaller = ''

  reset(): void {
    this.counts = {}
    this.byStage = {}
    this.byCaller = {}
    this.activeStage = ''
    this.activeCaller = ''
  }

  increment(op: string): void {
    this.counts[op] = (this.counts[op] || 0) + 1
    if (this.activeStage) {
      this.byStage[this.activeStage] = this.byStage[this.activeStage] || {}
      this.byStage[this.activeStage][op] = (this.byStage[this.activeStage][op] || 0) + 1
    }
    if (this.activeCaller) {
      this.byCaller[this.activeCaller] = this.byCaller[this.activeCaller] || {}
      this.byCaller[this.activeCaller][op] = (this.byCaller[this.activeCaller][op] || 0) + 1
    }
  }

  startStage(stage: string): void {
    this.activeStage = stage
  }

  endStage(): void {
    this.activeStage = ''
  }

  setCaller(caller: string): void {
    this.activeCaller = caller
  }

  clearCaller(): void {
    this.activeCaller = ''
  }

  get(): Record<string, number> {
    return { ...this.counts }
  }

  getByStage(): Record<string, Record<string, number>> {
    return JSON.parse(JSON.stringify(this.byStage))
  }

  getByCaller(): Record<string, Record<string, number>> {
    return JSON.parse(JSON.stringify(this.byCaller))
  }

  total(): number {
    return Object.values(this.counts).reduce((s, v) => s + v, 0)
  }

  getActiveStage(): string {
    return this.activeStage
  }

  getActiveCaller(): string {
    return this.activeCaller
  }
}

export const turfCounter = new TurfOperationCounter()

import * as rawTurf from '@turf/turf'

// Point-in-polygon cache with bbox short-circuit for primary-road optimization
export class PipCache {
  private pointCache = new Map<string, GeoJSON.Feature<GeoJSON.Point>>()
  private pipCache = new WeakMap<object, Map<string, boolean>>()
  private bboxes = new WeakMap<object, { minX: number; minY: number; maxX: number; maxY: number }>()
  private nearestCache = new Map<string, GeoJSON.Feature<GeoJSON.Point>>()
  private distanceCache = new Map<string, number>()
  stats = {
    pointCalls: 0,
    pointUnique: 0,
    pointReuse: 0,
    pointMs: 0,
    pointMaxMs: 0,
    pipCalls: 0,
    pipUnique: 0,
    pipHits: 0,
    pipMisses: 0,
    pipMs: 0,
    pipMaxMs: 0,
    bboxRejected: 0,
    booleanPipExecuted: 0,
    pointAllocationsSaved: 0
  }

  private getPointKey(coords: number[], props?: any): string {
    return `${coords[0]},${coords[1]}${props ? ':' + JSON.stringify(props) : ''}`
  }

  private getBbox(polygon: any) {
    if (!this.bboxes.has(polygon)) {
      const box = rawTurf.bbox(polygon) as number[]
      this.bboxes.set(polygon, { minX: box[0], minY: box[1], maxX: box[2], maxY: box[3] })
    }
    return this.bboxes.get(polygon)!
  }

  getPoint(coords: number[], props?: any): GeoJSON.Feature<GeoJSON.Point> {
    if (VERBOSE_GIS_DIAGNOSTICS) this.stats.pointCalls++
    const key = this.getPointKey(coords, props)
    const cached = this.pointCache.get(key)
    if (cached) {
      if (VERBOSE_GIS_DIAGNOSTICS) {
        this.stats.pointReuse++
        this.stats.pointAllocationsSaved++
      }
      return cached
    }
    const pt = rawTurf.point(coords, props)
    this.pointCache.set(key, pt)
    if (VERBOSE_GIS_DIAGNOSTICS) this.stats.pointUnique++
    return pt
  }

  getNearestPointOnLine(line: any, point: any): GeoJSON.Feature<GeoJSON.Point> {
    const lineKey = makeRoadKey(line)
    const ptKey = makePointKey(point)
    const key = `${lineKey}|${ptKey}`
    const cached = this.nearestCache.get(key)
    if (cached) return cached
    const result = rawTurf.nearestPointOnLine(line, point)
    this.nearestCache.set(key, result)
    return result
  }

  getDistance(a: any, b: any, units?: any): number {
    const aKey = makePointKey(a)
    const bKey = makePointKey(b)
    const pair = aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`
    const key = `${pair}|${String(units ?? '')}`
    const cached = this.distanceCache.get(key)
    if (cached !== undefined) return cached
    const result = rawTurf.distance(a, b, units)
    this.distanceCache.set(key, result)
    return result
  }

  getBooleanPointInPolygon(point: any, polygon: any, options?: any): boolean {
    if (VERBOSE_GIS_DIAGNOSTICS) this.stats.pipCalls++
    const polygonCache = this.pipCache.get(polygon) ?? new Map<string, boolean>()
    if (!this.pipCache.has(polygon)) {
      this.pipCache.set(polygon, polygonCache)
    }

    const coords = point?.geometry?.coordinates ?? point
    const [x, y] = Array.isArray(coords) && typeof coords[0] === 'number' ? [coords[0], coords[1]] : [coords[0], coords[1]]
    const optionKey = options?.ignoreBoundary ? 'i' : 'd'
    const key = `${x},${y}|${optionKey}`

    if (polygonCache.has(key)) {
      if (VERBOSE_GIS_DIAGNOSTICS) this.stats.pipHits++
      return polygonCache.get(key)!
    }

    const bbox = this.getBbox(polygon)
    if (x < bbox.minX || x > bbox.maxX || y < bbox.minY || y > bbox.maxY) {
      if (VERBOSE_GIS_DIAGNOSTICS) this.stats.bboxRejected++
      polygonCache.set(key, false)
      return false
    }

    const result = rawTurf.booleanPointInPolygon(point, polygon, options)
    polygonCache.set(key, result)
    return result
  }

  getStats() {
    return { ...this.stats }
  }
}

let activePipCache: PipCache | null = null

export function setActivePipCache(cache: PipCache | null) {
  activePipCache = cache
}

class TurfPerformanceTracker {
  private totals: Record<string, { calls: number; totalMs: number; maxMs: number }> = {}
  private byStage: Record<string, Record<string, { calls: number; totalMs: number; maxMs: number }>> = {}
  private byCaller: Record<string, Record<string, { calls: number; totalMs: number; maxMs: number }>> = {}

  reset(): void {
    this.totals = {}
    this.byStage = {}
    this.byCaller = {}
  }

  record(op: string, ms: number): void {
    if (!import.meta.env.DEV) return
    const stage = turfCounter.getActiveStage()
    const caller = turfCounter.getActiveCaller()

    this.totals[op] = this.totals[op] || { calls: 0, totalMs: 0, maxMs: 0 }
    this.totals[op].calls++
    this.totals[op].totalMs += ms
    this.totals[op].maxMs = Math.max(this.totals[op].maxMs, ms)

    if (stage) {
      this.byStage[stage] = this.byStage[stage] || {}
      this.byStage[stage][op] = this.byStage[stage][op] || { calls: 0, totalMs: 0, maxMs: 0 }
      this.byStage[stage][op].calls++
      this.byStage[stage][op].totalMs += ms
      this.byStage[stage][op].maxMs = Math.max(this.byStage[stage][op].maxMs, ms)
    }

    if (caller) {
      this.byCaller[caller] = this.byCaller[caller] || {}
      this.byCaller[caller][op] = this.byCaller[caller][op] || { calls: 0, totalMs: 0, maxMs: 0 }
      this.byCaller[caller][op].calls++
      this.byCaller[caller][op].totalMs += ms
      this.byCaller[caller][op].maxMs = Math.max(this.byCaller[caller][op].maxMs, ms)
    }
  }

  get(): Record<string, { calls: number; totalMs: number; maxMs: number }> {
    return JSON.parse(JSON.stringify(this.totals))
  }

  getByStage(): Record<string, Record<string, { calls: number; totalMs: number; maxMs: number }>> {
    return JSON.parse(JSON.stringify(this.byStage))
  }

  getByCaller(): Record<string, Record<string, { calls: number; totalMs: number; maxMs: number }>> {
    return JSON.parse(JSON.stringify(this.byCaller))
  }

  top(n = 10): { op: string; calls: number; totalMs: number; maxMs: number; avgMs: number }[] {
    return Object.entries(this.totals)
      .map(([op, s]) => ({ op, calls: s.calls, totalMs: s.totalMs, maxMs: s.maxMs, avgMs: s.calls > 0 ? s.totalMs / s.calls : 0 }))
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, n)
  }
}

export const turfPerformance = new TurfPerformanceTracker()

let onNearestPointOnLine: ((pointKey: string, roadKey: string) => void) | null = null
let onFeatureCollection: ((turfMs: number) => void) | null = null

export function setOnNearestPointOnLine(cb: ((pointKey: string, roadKey: string) => void) | null) {
  onNearestPointOnLine = cb
}

export function setOnFeatureCollection(cb: ((turfMs: number) => void) | null) {
  onFeatureCollection = cb
}

function makePointKey(arg: any): string {
  if (arg && Array.isArray(arg.coordinates)) return `${arg.coordinates[0]},${arg.coordinates[1]}`
  if (arg && Array.isArray(arg.geometry?.coordinates)) return `${arg.geometry.coordinates[0]},${arg.geometry.coordinates[1]}`
  if (Array.isArray(arg)) return `${arg[0]},${arg[1]}`
  return String(arg)
}

function makeRoadKey(arg: any): string {
  if (arg && arg.id) return String(arg.id)
  if (arg && arg.properties && arg.properties.id) return String(arg.properties.id)
  if (arg && arg.properties && arg.properties.name) return String(arg.properties.name)
  if (arg && arg.geometry && Array.isArray(arg.geometry.coordinates)) {
    const cs = arg.geometry.coordinates
    if (cs.length === 0) return 'road:empty'
    const first = String(cs[0])
    const last = String(cs[cs.length - 1])
    return `road:${first}:${last}:${cs.length}`
  }
  return 'road'
}

const bufferCache = new WeakMap<any, Map<string, any>>()
const lengthCache = new WeakMap<any, Map<string, number>>()
const areaCache = new WeakMap<any, number>()
const bboxCache = new WeakMap<any, number[]>()
const polygonToLineCache = new WeakMap<any, any>()
const intersectCache = new WeakMap<any, WeakMap<any, any>>()
const differenceCache = new WeakMap<any, WeakMap<any, any>>()
const booleanIntersectsCache = new WeakMap<any, WeakMap<any, boolean>>()
const booleanPointInPolygonCache = new WeakMap<any, Map<string, boolean>>()
const signatureBufferCache = new Map<string, any>()

function getLineStringCoordinates(value: any): number[][] | number[][][] | null {
  if (value.geometry?.type === 'LineString' && Array.isArray(value.geometry.coordinates)) {
    return value.geometry.coordinates as number[][]
  }
  if (value.geometry?.type === 'MultiLineString' && Array.isArray(value.geometry.coordinates)) {
    return value.geometry.coordinates as number[][][]
  }
  if (value.type === 'LineString' && Array.isArray(value.coordinates)) {
    return value.coordinates as number[][]
  }
  if (value.type === 'MultiLineString' && Array.isArray(value.coordinates)) {
    return value.coordinates as number[][][]
  }
  return null
}

function makeLineSignature(coords: number[][] | number[][][] | null): string | null {
  if (!coords || !Array.isArray(coords) || coords.length === 0) return null
  const round = (n: number) => Math.round(n * 1e7) / 1e7
  if (typeof coords[0][0] === 'number') {
    return (coords as number[][]).map(c => `${round(c[0])},${round(c[1])}`).join('|')
  }
  return (coords as number[][][]).map(r => r.map(c => `${round(c[0])},${round(c[1])}`).join(';')).join('||')
}

function bboxesOverlap(a: number[] | null, b: number[] | null): boolean {
  if (!a || !b || a.length < 4 || b.length < 4) return true
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
}

function makeBufferKey(args: any[]): string {
  const radius = args[1]
  const units = (args[2] && args[2].units) ? args[2].units : 'meters'
  return `${radius}:${units}`
}

function makeLengthKey(args: any[]): string {
  const units = (args[1] && args[1].units) ? args[1].units : 'default'
  return units
}

export const turfc = new Proxy(rawTurf as any, {
  get(target: any, prop: string | symbol) {
    const val = target[prop]
    if (typeof val === 'function') {
      return (...args: any[]) => {
        if (!VERBOSE_GIS_DIAGNOSTICS) {
          if (activePipCache && prop === 'point' && args.length >= 1 && Array.isArray(args[0])) {
            return activePipCache.getPoint(args[0], args[1])
          }
          if (activePipCache && prop === 'nearestPointOnLine' && args.length >= 2) {
            return activePipCache.getNearestPointOnLine(args[0], args[1])
          }
          if (activePipCache && prop === 'booleanPointInPolygon' && args.length >= 2) {
            return activePipCache.getBooleanPointInPolygon(args[0], args[1], args[2])
          }
          if (activePipCache && prop === 'distance' && args.length >= 2) {
            return activePipCache.getDistance(args[0], args[1], args[2])
          }

          const first = args[0]
          if (first && typeof first === 'object') {
            if (prop === 'buffer' && args.length >= 2) {
              const signatureKey = (() => {
                const coords = getLineStringCoordinates(first)
                if (!coords) return null
                const sig = makeLineSignature(coords)
                if (!sig) return null
                return `${sig}:${makeBufferKey(args)}`
              })()
              let sub = bufferCache.get(first)
              if (!sub) {
                sub = new Map<string, any>()
                bufferCache.set(first, sub)
              }
              const key = makeBufferKey(args)
              if (sub.has(key)) return sub.get(key)
              if (signatureKey && signatureBufferCache.has(signatureKey)) {
                const cached = signatureBufferCache.get(signatureKey)
                sub.set(key, cached)
                return cached
              }
              const r = val.apply(target, args)
              sub.set(key, r)
              if (signatureKey) {
                signatureBufferCache.set(signatureKey, r)
                if (signatureBufferCache.size > 20000) {
                  const oldest = signatureBufferCache.keys().next().value
                  if (oldest) signatureBufferCache.delete(oldest)
                }
              }
              return r
            }
            if (prop === 'length' && (first.geometry?.type === 'LineString' || first.geometry?.type === 'MultiLineString' || first.type === 'LineString' || first.type === 'MultiLineString')) {
              let sub = lengthCache.get(first)
              if (!sub) {
                sub = new Map<string, number>()
                lengthCache.set(first, sub)
              }
              const key = makeLengthKey(args)
              if (sub.has(key)) return sub.get(key)
              const r = val.apply(target, args)
              sub.set(key, r)
              return r
            }
            if (prop === 'area' && (first.geometry?.type?.includes('Polygon') || first.type?.includes('Polygon'))) {
              if (areaCache.has(first)) return areaCache.get(first)
              const r = val.apply(target, args)
              areaCache.set(first, r)
              return r
            }
            if (prop === 'bbox') {
              if (bboxCache.has(first)) return bboxCache.get(first)
              const r = val.apply(target, args)
              bboxCache.set(first, r)
              return r
            }
            if (prop === 'polygonToLine' && (first.geometry?.type?.includes('Polygon') || first.type?.includes('Polygon'))) {
              if (polygonToLineCache.has(first)) return polygonToLineCache.get(first)
              const r = val.apply(target, args)
              polygonToLineCache.set(first, r)
              return r
            }
            if ((prop === 'intersect' || prop === 'difference') && args.length >= 1 && args[0] && typeof args[0] === 'object') {
              const fc = args[0]
              const features = Array.isArray(fc?.features) ? fc.features : (args.length >= 2 && args[1] && typeof args[1] === 'object' ? [fc, args[1]] : [fc, fc])
              const first = features[0]
              const second = features[1]
              if (first && typeof first === 'object' && second && typeof second === 'object') {
                const aBbox = safeTurfOp(() => (rawTurf as any).bbox(first), null)
                const bBbox = safeTurfOp(() => (rawTurf as any).bbox(second), null)
                if (!bboxesOverlap(aBbox, bBbox)) {
                  if (prop === 'intersect') return null
                  if (prop === 'difference') return first
                }
                if (prop === 'intersect') {
                  const aSub = intersectCache.get(first)
                  if (aSub && aSub.has(second)) return aSub.get(second)
                  const bSub = intersectCache.get(second)
                  if (bSub && bSub.has(first)) return bSub.get(first)
                  const r = val.apply(target, args)
                  let aMap = intersectCache.get(first)
                  if (!aMap) { aMap = new WeakMap(); intersectCache.set(first, aMap) }
                  aMap.set(second, r)
                  let bMap = intersectCache.get(second)
                  if (!bMap) { bMap = new WeakMap(); intersectCache.set(second, bMap) }
                  bMap.set(first, r)
                  return r
                }
                if (prop === 'difference') {
                  const aSub = differenceCache.get(first)
                  if (aSub && aSub.has(second)) return aSub.get(second)
                  const r = val.apply(target, args)
                  let aMap = differenceCache.get(first)
                  if (!aMap) { aMap = new WeakMap(); differenceCache.set(first, aMap) }
                  aMap.set(second, r)
                  return r
                }
              }
            }
            if (prop === 'booleanIntersects' && args.length >= 2 && args[1] && typeof args[1] === 'object') {
              const second = args[1]
              const aSub = booleanIntersectsCache.get(first)
              if (aSub && aSub.has(second)) return aSub.get(second)
              const bSub = booleanIntersectsCache.get(second)
              if (bSub && bSub.has(first)) return bSub.get(first)
              const r = val.apply(target, args)
              let aMap = booleanIntersectsCache.get(first)
              if (!aMap) { aMap = new WeakMap(); booleanIntersectsCache.set(first, aMap) }
              aMap.set(second, r)
              let bMap = booleanIntersectsCache.get(second)
              if (!bMap) { bMap = new WeakMap(); booleanIntersectsCache.set(second, bMap) }
              bMap.set(first, r)
              return r
            }
            if (prop === 'booleanPointInPolygon' && args.length >= 2 && args[1] && typeof args[1] === 'object') {
              const pt = args[0]
              const poly = args[1]
              const ptCoords = pt?.geometry?.coordinates ?? pt?.coordinates
              if (Array.isArray(ptCoords) && ptCoords.length >= 2) {
                const opts = args[2] ? JSON.stringify(args[2]) : 'default'
                const key = `${ptCoords[0].toFixed(7)},${ptCoords[1].toFixed(7)}:${opts}`
                const sub = booleanPointInPolygonCache.get(poly)
                if (sub && sub.has(key)) return sub.get(key)
                const r = val.apply(target, args)
                if (!booleanPointInPolygonCache.has(poly)) {
                  booleanPointInPolygonCache.set(poly, new Map())
                }
                booleanPointInPolygonCache.get(poly)!.set(key, r)
                return r
              }
            }
          }

          return val.apply(target, args)
        }

        const start = performance.now()
        if (import.meta.env.DEV) turfCounter.increment(String(prop))

        if (activePipCache && prop === 'point' && args.length >= 1 && Array.isArray(args[0])) {
          const r = activePipCache.getPoint(args[0], args[1])
          turfPerformance.record(String(prop), performance.now() - start)
          return r
        }

        if (activePipCache && prop === 'booleanPointInPolygon' && args.length >= 2) {
          const r = activePipCache.getBooleanPointInPolygon(args[0], args[1], args[2])
          turfPerformance.record(String(prop), performance.now() - start)
          return r
        }

        const r = val.apply(target, args)
        const ms = performance.now() - start
        turfPerformance.record(String(prop), ms)

        if (prop === 'nearestPointOnLine' && onNearestPointOnLine) {
          const pt = args[0]
          const line = args[1]
          onNearestPointOnLine(makePointKey(pt), makeRoadKey(line))
        }

        if (prop === 'featureCollection' && onFeatureCollection) {
          onFeatureCollection(ms)
        }

        return r
      }
    }
    return val
  }
})

export function safeTurfOp<T>(op: () => T, fallback: T, opName?: string): T {
  try {
    if (opName && import.meta.env.DEV) turfCounter.increment(opName)
    return op()
  } catch {
    return fallback
  }
}
