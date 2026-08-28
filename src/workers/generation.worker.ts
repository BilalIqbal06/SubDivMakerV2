import { runAuthoritativeConceptTransaction, type AuthoritativeConceptInput, type AuthoritativeConceptResult } from '../services/authoritativeConceptService'

type InMessage =
  | { type: 'GENERATE'; transactionId: string; runId: number; input: AuthoritativeConceptInput }
  | { type: 'CANCEL'; transactionId: string }

const workerContext: any = self
const abortControllers = new Map<string, AbortController>()

workerContext.onmessage = (event: MessageEvent<InMessage>) => {
  const data = event.data

  if (data.type === 'CANCEL') {
    const controller = abortControllers.get(data.transactionId)
    if (controller) controller.abort()
    return
  }

  if (data.type === 'GENERATE') {
    const { transactionId, runId, input } = data
    const controller = new AbortController()
    abortControllers.set(transactionId, controller)

    runAuthoritativeConceptTransaction(runId, input, controller.signal)
      .then((result: AuthoritativeConceptResult) => {
        workerContext.postMessage({ type: 'SUCCESS', transactionId, result })
      })
      .catch((error: any) => {
        const message = error instanceof Error ? error.message : String(error)
        const name = error instanceof Error ? error.name : 'Error'
        const stack = error instanceof Error ? error.stack : undefined
        workerContext.postMessage({ type: 'ERROR', transactionId, message, name, stack })
      })
      .finally(() => {
        abortControllers.delete(transactionId)
      })
  }
}
