/**
 * Cooperative scheduler helper for long-running CPU-heavy generation loops.
 * Allows the browser event loop to process rendering, scrolling, map interaction,
 * and button updates between batches without changing computation order.
 *
 * yieldIfNeeded uses a 12 ms CPU-slice budget to avoid event-loop round trips
 * inside tight inner loops. Stages still explicitly call yieldToMainThread.
 */

let yieldCount = 0
let yieldWallClockMs = 0
let cpuSliceStart = 0
const YIELD_BUDGET_MS = 12

export function startCpuSlice(): void {
  cpuSliceStart = performance.now()
}

export function shouldYield(): boolean {
  return performance.now() - cpuSliceStart > YIELD_BUDGET_MS
}

export async function yieldToMainThread(): Promise<void> {
  yieldCount += 1
  const t = performance.now()
  const result = new Promise<void>(resolve => setTimeout(resolve, 0))
  yieldWallClockMs += performance.now() - t
  return result
}

export async function yieldIfNeeded(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  if (!shouldYield()) return
  await yieldToMainThread()
  startCpuSlice()
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
}

export function getYieldCount(): number {
  return yieldCount
}

export function getYieldWallClockMs(): number {
  return yieldWallClockMs
}

export function resetYieldCount(): void {
  yieldCount = 0
  yieldWallClockMs = 0
  startCpuSlice()
}
