import { ARENA } from '@shared/data/catalog'
import { rollSeriesReward, type ArenaProfile, type InboxEntry, type PvpPending } from '@shared/core/arena'
import { ratingAfter } from '@shared/core/rating'
import { updateProfile } from './profile'

const MAX_INBOX = 30

export function settlePvp(
  nk: nkruntime.Nakama,
  logger: nkruntime.Logger,
  attackerId: string,
  attackerName: string,
  pending: PvpPending,
): ArenaProfile {
  const attacker = updateProfile(nk, attackerId, attackerName, (profile) => ({
    ...profile,
    rating: ratingAfter(profile.rating, pending.delta),
    wins: profile.wins + (pending.win ? 1 : 0),
    losses: profile.losses + (pending.win ? 0 : 1),
  }))

  const users = nk.usersGetId([pending.opponentId])
  if (!users.length) {
    logger.info(`[pvp] Defender ${pending.opponentId} not found, fight ${pending.id}`)
    return attacker
  }
  const defenderWon = !pending.win
  const entry: InboxEntry = { at: Date.now(), attacker: attackerName, won: defenderWon, ratingDelta: -pending.delta }
  if (defenderWon && ARENA.defenseReward) {
    entry.reward = rollSeriesReward(pending.seed ^ 0x0def, {
      ...ARENA,
      reward: { cubes: ARENA.defenseReward.cubes, drops: ARENA.reward.drops },
    })
  }
  updateProfile(nk, pending.opponentId, users[0].username, (profile) => ({
    ...profile,
    rating: ratingAfter(profile.rating, -pending.delta),
    wins: profile.wins + (defenderWon ? 1 : 0),
    losses: profile.losses + (defenderWon ? 0 : 1),
    inbox: profile.inbox.concat([entry]).slice(-MAX_INBOX),
  }))
  logger.info(`[pvp] Settled fight=${pending.id} attacker=${attackerId} defender=${pending.opponentId} win=${pending.win} delta=${pending.delta}`)
  return attacker
}
