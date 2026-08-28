/**
 * Cooperative scheduler helper for long-running CPU-heavy generation loops.
 * Allows the browser event loop to process rendering, scrolling, map interaction,
 * and button updates between batches without changing computation order.
 *
 * yieldIfNeeded uses a 12 ms CPU-slice budget to avoid event-loop round trips
 * inside tight inner loops. Stages still explicitly call yieldToMainThread.
 *
 * Background-tab safety: when document is hidden, yieldToMainThread resolves
 * through MessageChannel (not throttled). Visible tabs prefer scheduler.yield(),
 * falling back to MessageChannel and finally setTimeout(0).
 *
 * This module never pauses, suspends, or restarts generation based on visibility.
 * document.visibilityState is evaluated on every yield to choose the most
 * reliable scheduling primitive for the current tab state.
 */

let yieldCount = 0
let yieldWallClockMs = 0
let cpuSliceStart = 0
const YIELD_BUDGET_MS = 12

type YieldStrategy = 'scheduler.yield' | 'messageChannel' | 'setTimeout'

const hasSchedulerYield = typeof (globalThis as any).scheduler?.yield === 'function'
const hasMessageChannel = typeof MessageChannel !== 'undefined'

// Reusable MessageChannel for repeated background-tab yields.
// One port is kept open; onmessage drains a queue of pending resolvers.
let messageChannel: MessageChannel | null = null
let pendingResolvers: Array<(() => void) | null> = []

function ensureMessageChannel(): MessageChannel | null {
  if (!hasMessageChannel) return null
  if (messageChannel) return messageChannel
  try {
    const mc = new MessageChannel()
    mc.port1.onmessage = () => {
      const resolve = pendingResolvers.shift()
      if (resolve) resolve()
    }
    messageChannel = mc
    return mc
  } catch {
    return null
  }
}

export function startCpuSlice(): void {
  cpuSliceStart = performance.now()
}

export function shouldYield(): boolean {
  return performance.now() - cpuSliceStart > YIELD_BUDGET_MS
}

function getVisibilityAwareStrategy(): YieldStrategy {
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'

  if (hidden) {
    // Hidden tabs: never use scheduler.yield() because it can be throttled.
    if (hasMessageChannel) return 'messageChannel'
    if (hasSchedulerYield) return 'scheduler.yield'
    return 'setTimeout'
  }

  // Visible tabs: prefer scheduler.yield() (cleanest), then MessageChannel.
  if (hasSchedulerYield) return 'scheduler.yield'
  if (hasMessageChannel) return 'messageChannel'
  return 'setTimeout'
}

export function getActiveYieldStrategy(): YieldStrategy {
  return getVisibilityAwareStrategy()
}

export async function yieldToMainThread(): Promise<void> {
  yieldCount += 1
  const t = performance.now()

  await new Promise<void>((resolve) => {
    const strategy = getVisibilityAwareStrategy()

    if (strategy === 'scheduler.yield') {
      (globalThis as any).scheduler
        .yield()
        .then(() => resolve())
        .catch(() => resolve())
      return
    }

    if (strategy === 'messageChannel') {
      const mc = ensureMessageChannel()
      if (mc) {
        pendingResolvers.push(resolve)
        mc.port2.postMessage(null)
        return
      }
      // MessageChannel failed (e.g. in an unexpected context) - fall through.
    }

    setTimeout(resolve, 0)
  })

  yieldWallClockMs += performance.now() - t
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
