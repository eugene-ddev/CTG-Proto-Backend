import { protectedRpc } from '@lib/protectedRpc'
import { GRPCErrorCode, makeErrorResponse } from '@lib/response'
import { startPvp } from '@shared/core/arena'
import { ratingOf } from '../../entities/Arena/leaderboard'
import { readSnapshots } from '../../entities/Arena/publish'
import { readOrCreatePlayer, readPlayer } from '../../entities/Player/storage'
import { commitPlayer } from '../../entities/Player/commit'

interface IChallengePayload {
  userId: string
  charUid: string
}

export const challengeRpc = protectedRpc('arena/challenge', (userId, payload, ctx, logger, nk) => {
  const input = JSON.parse(payload) as IChallengePayload
  if (typeof input.userId !== 'string' || typeof input.charUid !== 'string' || input.userId === userId) {
    return makeErrorResponse('Opponent and character are required', GRPCErrorCode.INVALID_ARGUMENT)
  }
  const rivalStored = readPlayer(nk, input.userId)
  const snapshot = readSnapshots(nk, [input.userId])[input.userId]
  const users = nk.usersGetId([input.userId])
  if (!rivalStored || !snapshot || !users.length) {
    return makeErrorResponse('Opponent not found', GRPCErrorCode.NOT_FOUND)
  }

  const stored = readOrCreatePlayer(nk, userId)
  const seed = parseInt(nk.uuidv4().replace(/-/g, '').slice(0, 8), 16) >>> 0
  const rival = {
    userId: input.userId,
    name: users[0].username,
    rating: ratingOf(rivalStored.record.state),
    myRating: ratingOf(stored.record.state),
    snapshot,
  }
  const state = startPvp(stored.record.state, input.charUid, rival, seed)
  if (!state) {
    logger.info(`[arena/challenge] Rejected user=${userId} opponent=${input.userId}`)
    return makeErrorResponse('Cannot challenge now', GRPCErrorCode.FAILED_PRECONDITION)
  }
  const record = commitPlayer(
    nk,
    logger,
    userId,
    ctx.username || '',
    { ...stored.record, state, rev: stored.record.rev + 1, updatedAt: Date.now() },
    stored.version,
  )
  return JSON.stringify({ state: record.state, rev: record.rev })
})
