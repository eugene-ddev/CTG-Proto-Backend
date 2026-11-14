import { PROTOCOL_VERSION, SERVER_VERSION, SHARED_VERSION } from '@lib/version'
import { GRPCErrorCode, makeErrorResponse } from '@lib/response'
import { runSelfTest } from '@lib/selfTest'

interface IPingPayload {
  selfTest?: boolean
  seed?: number
}

export const pingRpc: nkruntime.RpcFunction = (ctx, logger, _nk, payload) => {
  logger.info(`[system/ping] Called user=${ctx.userId} payload=${payload}`)
  try {
    const input = (payload ? JSON.parse(payload) : {}) as IPingPayload
    const response = {
      server: SERVER_VERSION,
      protocol: PROTOCOL_VERSION,
      shared: SHARED_VERSION,
      time: Date.now(),
      selfTest: input.selfTest ? runSelfTest(input.seed ?? 42) : undefined,
    }
    logger.info(`[system/ping] Done user=${ctx.userId}`)
    return JSON.stringify(response)
  } catch (error) {
    logger.error(`[system/ping] Failed: ${(error as Error).message}`)
    return makeErrorResponse('Ping failed', GRPCErrorCode.INTERNAL)
  }
}
