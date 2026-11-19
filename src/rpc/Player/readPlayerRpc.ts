import { protectedRpc } from '@lib/protectedRpc'
import { isDebugMode } from '@lib/debug'
import { forfeitIfInBattle, lobbyRegen } from '@shared/core/arena'
import { withClock } from '@shared/core/clock'
import { normalizeState } from '@shared/core/state'
import { readOrCreatePlayer, toPlayerView } from '../../entities/Player/storage'
import { commitPlayer } from '../../entities/Player/commit'
import { ensureProfile } from '../../entities/Arena/profile'

export const readPlayerRpc = protectedRpc('player/read', (userId, _payload, ctx, logger, nk) => {
  const stored = readOrCreatePlayer(nk, userId)
  const now = Date.now()
  const state = withClock(now, () => lobbyRegen(forfeitIfInBattle(normalizeState(stored.record.state)), now))
  let record = stored.record
  if (state !== stored.record.state) {
    record = { ...stored.record, state, rev: stored.record.rev + 1, updatedAt: now }
  }
  if (record !== stored.record || !stored.record.pub) {
    record = commitPlayer(nk, logger, userId, ctx.username || '', record, stored.version).record
  }
  const legacy = record.state as unknown as { rating?: number; pvp?: { wins: number; losses: number } }
  const arena = ensureProfile(nk, userId, ctx.username || '', legacy)
  return JSON.stringify({ ...toPlayerView(record, isDebugMode(ctx)), arena })
})
