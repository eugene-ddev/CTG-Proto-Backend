import { protectedRpc } from '@lib/protectedRpc'
import { makeFreshState } from '../../entities/Player/makeFreshState'
import { readOrCreatePlayer, toPlayerView, writePlayer } from '../../entities/Player/storage'

export const resetPlayerRpc = protectedRpc('player/reset', (userId, _payload, _ctx, _logger, nk) => {
  const stored = readOrCreatePlayer(nk, userId)
  const record = { ...stored.record, state: makeFreshState(), rev: stored.record.rev + 1, updatedAt: Date.now() }
  writePlayer(nk, userId, record, stored.version)
  return JSON.stringify(toPlayerView(record))
})
