import { ARENA } from '@shared/data/catalog'
import { grantReward, rollSeriesReward, type InboxEntry, type PvpPending } from '@shared/core/arena'
import { ratingAfter } from '@shared/core/rating'
import { readPlayer, writePlayer } from '../Player/storage'
import { ratingOf } from './leaderboard'
import { withPublished } from './publish'

const MAX_INBOX = 30
const WRITE_ATTEMPTS = 3

export function settleDefender(
  nk: nkruntime.Nakama,
  logger: nkruntime.Logger,
  attackerName: string,
  pending: PvpPending,
): void {
  const users = nk.usersGetId([pending.opponentId])
  const defenderName = users.length ? users[0].username : ''
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const stored = readPlayer(nk, pending.opponentId)
    if (!stored) {
      logger.info(`[pvp] Defender ${pending.opponentId} not found, fight ${pending.id}`)
      return
    }
    const defenderWon = !pending.win
    let state = stored.record.state
    const stats = state.pvp || { wins: 0, losses: 0 }
    const entry: InboxEntry = { at: Date.now(), attacker: attackerName, won: defenderWon, ratingDelta: -pending.delta }
    if (defenderWon && ARENA.defenseReward) {
      const reward = rollSeriesReward(pending.seed ^ 0x0def, {
        ...ARENA,
        reward: { cubes: ARENA.defenseReward.cubes, drops: ARENA.reward.drops },
      })
      state = grantReward(state, reward)
      entry.reward = reward
    }
    state = {
      ...state,
      rating: ratingAfter(ratingOf(state), -pending.delta),
      pvp: { wins: stats.wins + (defenderWon ? 1 : 0), losses: stats.losses + (defenderWon ? 0 : 1) },
      inbox: (state.inbox || []).concat([entry]).slice(-MAX_INBOX),
    }
    const record = withPublished(nk, pending.opponentId, defenderName, {
      ...stored.record,
      state,
      rev: stored.record.rev + 1,
      updatedAt: Date.now(),
    })
    try {
      writePlayer(nk, pending.opponentId, record, stored.version)
      logger.info(`[pvp] Defender ${pending.opponentId} settled fight=${pending.id} won=${defenderWon} delta=${-pending.delta}`)
      return
    } catch (error) {
      logger.info(`[pvp] Defender write conflict attempt=${attempt + 1}: ${(error as Error).message}`)
    }
  }
  logger.error(`[pvp] Defender ${pending.opponentId} not settled, fight ${pending.id}`)
}
