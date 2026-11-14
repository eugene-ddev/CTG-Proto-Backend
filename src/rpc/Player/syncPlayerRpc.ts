import { protectedRpc } from '@lib/protectedRpc'
import { GRPCErrorCode, makeErrorResponse } from '@lib/response'
import { STATE_VERSION, type PlayerState } from '@shared/core/state'
import { readOrCreatePlayer, toPlayerView, writePlayer } from '../../entities/Player/storage'

interface ISyncPlayerPayload {
  state: PlayerState
  rev: number
}

const MAX_STATE_BYTES = 200000

function isValidState(state: PlayerState): boolean {
  return (
    !!state &&
    state.version === STATE_VERSION &&
    Array.isArray(state.inventory) &&
    Array.isArray(state.characters) &&
    Array.isArray(state.unlockedBlueprints) &&
    typeof state.nextUid === 'number'
  )
}

export const syncPlayerRpc = protectedRpc('player/sync', (userId, payload, _ctx, logger, nk) => {
  if (payload.length > MAX_STATE_BYTES) {
    return makeErrorResponse('State is too large', GRPCErrorCode.INVALID_ARGUMENT)
  }
  const input = JSON.parse(payload) as ISyncPlayerPayload
  if (!isValidState(input.state) || typeof input.rev !== 'number') {
    return makeErrorResponse('Invalid state', GRPCErrorCode.INVALID_ARGUMENT)
  }

  const stored = readOrCreatePlayer(nk, userId)
  if (stored.record.rev !== input.rev) {
    logger.info(`[player/sync] Conflict user=${userId} client=${input.rev} server=${stored.record.rev}`)
    return JSON.stringify({ conflict: true, ...toPlayerView(stored.record) })
  }

  const record = { ...stored.record, state: input.state, rev: stored.record.rev + 1, updatedAt: Date.now() }
  writePlayer(nk, userId, record, stored.version)
  return JSON.stringify({ conflict: false, rev: record.rev, serverTime: record.updatedAt })
})
