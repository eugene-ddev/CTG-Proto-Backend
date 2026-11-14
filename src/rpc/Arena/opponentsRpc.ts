import { protectedRpc } from '@lib/protectedRpc'
import { ratingDeltas } from '@shared/core/rating'
import { OPPONENTS_LIMIT, OPPONENTS_SCAN, RATING_LEADERBOARD } from '../../entities/Arena/constants'
import { ratingOf } from '../../entities/Arena/leaderboard'
import { readSnapshots } from '../../entities/Arena/publish'
import { readOrCreatePlayer } from '../../entities/Player/storage'

export const opponentsRpc = protectedRpc('arena/opponents', (userId, _payload, _ctx, _logger, nk) => {
  const mine = readOrCreatePlayer(nk, userId).record.state
  const myRating = ratingOf(mine)
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
  const stats = mine.pvp || { wins: 0, losses: 0 }
  return JSON.stringify({ me: { rating: myRating, wins: stats.wins, losses: stats.losses }, opponents })
})
