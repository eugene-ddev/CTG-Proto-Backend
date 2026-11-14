import { protectedRpc } from '@lib/protectedRpc'
import { ratingDeltas } from '@shared/core/rating'
import { OPPONENTS_LIMIT, OPPONENTS_SCAN, RATING_LEADERBOARD } from '../../entities/Arena/constants'
import { ensureProfile } from '../../entities/Arena/profile'
import { readSnapshots } from '../../entities/Arena/publish'

export const opponentsRpc = protectedRpc('arena/opponents', (userId, _payload, ctx, _logger, nk) => {
  const me = ensureProfile(nk, userId, ctx.username || '')
  const myRating = me.rating
  const list = nk.leaderboardRecordsList(RATING_LEADERBOARD, undefined, OPPONENTS_SCAN)
  const records = (list.records || []).filter((record) => record.ownerId !== userId)
  const snapshots = readSnapshots(
    nk,
    records.map((record) => record.ownerId),
  )
  const opponents = records
    .filter((record) => !!snapshots[record.ownerId])
    .map((record) => {
      const deltas = ratingDeltas(myRating, record.score)
      const metadata = record.metadata || {}
      return {
        userId: record.ownerId,
        name: record.username,
        rating: record.score,
        wins: Number(metadata.wins) || 0,
        losses: Number(metadata.losses) || 0,
        winDelta: deltas.win,
        loseDelta: deltas.lose,
        snapshot: snapshots[record.ownerId],
      }
    })
    .sort((first, second) => Math.abs(first.rating - myRating) - Math.abs(second.rating - myRating))
    .slice(0, OPPONENTS_LIMIT)
  return JSON.stringify({ me, opponents })
})
