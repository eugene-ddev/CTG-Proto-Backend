import { PROTOCOL_VERSION, SERVER_VERSION, SHARED_VERSION } from '@lib/version'
import { GRPCErrorCode, makeErrorResponse } from '@lib/response'
import { runSelfTest } from '@lib/selfTest'

interface IPingPayload {
  selfTest?: boolean
  seed?: number
  /** Проверить базу: выкладка (deploy/update.sh) так убеждается, что сервер не просто запущен, а работает. */
  db?: boolean
}

/** База отвечает? Ошибка — текстом (её видно в логе выкладки). */
const checkDb = (nk: nkruntime.Nakama): true | string => {
  try {
    nk.sqlQuery('SELECT 1')
    return true
  } catch (error) {
    return (error as Error).message || String(error)
  }
}

export const pingRpc: nkruntime.RpcFunction = (ctx, logger, nk, payload) => {
  logger.info(`[system/ping] Called user=${ctx.userId} payload=${payload}`)
  try {
    const input = (payload ? JSON.parse(payload) : {}) as IPingPayload
    const response = {
      server: SERVER_VERSION,
      protocol: PROTOCOL_VERSION,
      shared: SHARED_VERSION,
      time: Date.now(),
      selfTest: input.selfTest ? runSelfTest(input.seed ?? 42) : undefined,
      db: input.db ? checkDb(nk) : undefined,
    }
    logger.info(`[system/ping] Done user=${ctx.userId}`)
    return JSON.stringify(response)
  } catch (error) {
    logger.error(`[system/ping] Failed: ${(error as Error).message}`)
    return makeErrorResponse('Ping failed', GRPCErrorCode.INTERNAL)
  }
}
