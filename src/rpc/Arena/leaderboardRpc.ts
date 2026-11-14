import { protectedRpc } from '@lib/protectedRpc'
import { RATING_LEADERBOARD } from '../../entities/Arena/constants'

const TOP_LIMIT = 50
const AROUND_LIMIT = 7

const toRow = (record: nkruntime.LeaderboardRecord, userId: string) => {
  const metadata = record.metadata || {}
  return {
    rank: record.rank,
    userId: record.ownerId,
    name: record.username,
    rating: record.score,
    wins: Number(metadata.wins) || 0,
    losses: Number(metadata.losses) || 0,
    me: record.ownerId === userId,
  }
}

export const leaderboardRpc = protectedRpc('arena/leaderboard', (userId, _payload, _ctx, _logger, nk) => {
  const top = nk.leaderboardRecordsList(RATING_LEADERBOARD, [userId], TOP_LIMIT)
  const mine = (top.ownerRecords || [])[0]
  const rows = (top.records || []).map((record) => toRow(record, userId))
  const inTop = rows.some((row) => row.me)
  const around =
    mine && !inTop
      ? (nk.leaderboardRecordsHaystack(RATING_LEADERBOARD, userId, AROUND_LIMIT, '', 0).records || []).map((record) =>
          toRow(record, userId),
        )
      : []
  const ranked = rows.concat(around).filter((row) => row.me)[0]
  const me = ranked || (mine ? toRow(mine, userId) : null)
  return JSON.stringify({ total: top.rankCount || rows.length, me, top: rows, around })
})
