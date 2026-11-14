import { protectedRpc } from '@lib/protectedRpc'
import { isDebugMode } from '@lib/debug'
import { forfeitIfInBattle, lobbyRegen } from '@shared/core/arena'
import { withClock } from '@shared/core/clock'
import { readOrCreatePlayer, toPlayerView, writePlayer } from '../../entities/Player/storage'

export const readPlayerRpc = protectedRpc('player/read', (userId, _payload, ctx, _logger, nk) => {
  const stored = readOrCreatePlayer(nk, userId)
  const now = Date.now()
  const state = withClock(now, () => lobbyRegen(forfeitIfInBattle(stored.record.state), now))
  let record = stored.record
  if (state !== stored.record.state) {
    record = { ...stored.record, state, rev: stored.record.rev + 1, updatedAt: now }
    writePlayer(nk, userId, record, stored.version)
  }
  return JSON.stringify(toPlayerView(record, isDebugMode(ctx)))
})
