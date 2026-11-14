import { protectedRpc } from '@lib/protectedRpc'
import { GRPCErrorCode, makeErrorResponse } from '@lib/response'
import { isDebugMode } from '@lib/debug'
import { makeFreshState } from '../../entities/Player/makeFreshState'
import { readOrCreatePlayer, toPlayerView } from '../../entities/Player/storage'
import { commitPlayer } from '../../entities/Player/commit'

export const resetPlayerRpc = protectedRpc('player/reset', (userId, _payload, ctx, logger, nk) => {
  if (!isDebugMode(ctx)) {
    return makeErrorResponse('Reset is available in debug mode only', GRPCErrorCode.FAILED_PRECONDITION)
  }
  const stored = readOrCreatePlayer(nk, userId)
  const record = commitPlayer(
    nk,
    logger,
    userId,
    ctx.username || '',
    { ...stored.record, state: makeFreshState(), rev: stored.record.rev + 1, updatedAt: Date.now() },
    stored.version,
  )
  return JSON.stringify(toPlayerView(record, true))
})
