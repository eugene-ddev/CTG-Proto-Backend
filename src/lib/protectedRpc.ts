import { GRPCErrorCode, makeErrorResponse } from '@lib/response'

type Handler = (userId: string, payload: string, ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama) => string

export function protectedRpc(name: string, handler: Handler): nkruntime.RpcFunction {
  return (ctx, logger, nk, payload) => {
    if (!ctx.userId) {
      return makeErrorResponse('Unauthenticated', GRPCErrorCode.UNAUTHENTICATED)
    }
    logger.info(`[${name}] Called user=${ctx.userId} bytes=${payload ? payload.length : 0}`)
    try {
      const response = handler(ctx.userId, payload || '{}', ctx, logger, nk)
      logger.info(`[${name}] Done user=${ctx.userId}`)
      return response
    } catch (error) {
      logger.error(`[${name}] Failed user=${ctx.userId}: ${(error as Error).message}`)
      return makeErrorResponse(`${name} failed`, GRPCErrorCode.INTERNAL)
    }
  }
}
