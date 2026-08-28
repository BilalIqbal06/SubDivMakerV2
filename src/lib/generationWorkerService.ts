import type { AuthoritativeConceptInput, AuthoritativeConceptResult } from '../services/authoritativeConceptService'

let worker: Worker | null = null
let workerFailed = false

function getWorker(): Worker | null {
  if (workerFailed) return null
  if (worker) return worker
  if (typeof Worker === 'undefined') {
    workerFailed = true
    if (import.meta.env.DEV) {
      console.log('[GenerationWorkerAudit]', { worker: false, reason: 'Worker not supported in this environment' })
    }
    return null
  }
  try {
    worker = new Worker(new URL('../workers/generation.worker.ts', import.meta.url), { type: 'module' })
    worker.addEventListener('error', () => {
      if (import.meta.env.DEV) {
        console.log('[GenerationWorkerAudit]', { worker: false, reason: 'Worker runtime error; falling back to main thread' })
      }
      worker?.terminate()
      worker = null
      workerFailed = true
    })
    return worker
  } catch (err) {
    workerFailed = true
    if (import.meta.env.DEV) {
      console.log('[GenerationWorkerAudit]', { worker: false, reason: 'Worker construction failed', error: String(err) })
    }
    return null
  }
}

export function terminateGenerationWorker(): void {
  worker?.terminate()
  worker = null
}

export async function generateAuthoritativeConceptInWorker(
  input: AuthoritativeConceptInput,
  signal: AbortSignal | undefined,
  runId: number,
  transactionId: string
): Promise<AuthoritativeConceptResult> {
  const w = getWorker()
  if (!w) throw new Error('Generation Worker unavailable')

  return new Promise<AuthoritativeConceptResult>((resolve, reject) => {
    const onMessage = (event: MessageEvent<any>) => {
      const data = event.data
      if (data?.transactionId !== transactionId) return
      if (data.type === 'SUCCESS') {
        cleanup()
        resolve(data.result as AuthoritativeConceptResult)
      } else if (data.type === 'ERROR') {
        cleanup()
        reject(new Error(data.message ?? 'Generation worker error'))
      }
    }

    const onError = (event: ErrorEvent) => {
      cleanup()
      reject(event.error ?? new Error(event.message ?? 'Worker error'))
    }

    const cleanup = () => {
      w.removeEventListener('message', onMessage)
      w.removeEventListener('error', onError)
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    const onAbort = () => w.postMessage({ type: 'CANCEL', transactionId })

    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    w.addEventListener('message', onMessage)
    w.addEventListener('error', onError)
    w.postMessage({ type: 'GENERATE', transactionId, runId, input })
  })
}
