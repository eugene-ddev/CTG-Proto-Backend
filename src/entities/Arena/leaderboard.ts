import { RATING_START } from '@shared/core/rating'
import type { PlayerState } from '@shared/core/state'
import { RATING_LEADERBOARD } from './constants'

export function ensureRatingLeaderboard(nk: nkruntime.Nakama, logger: nkruntime.Logger): void {
  try {
    nk.leaderboardCreate(RATING_LEADERBOARD, true, 'descending' as nkruntime.SortOrder, 'set' as nkruntime.Operator)
  } catch (error) {
    logger.error(`[leaderboard] create failed: ${(error as Error).message}`)
  }
}

export const ratingOf = (state: PlayerState): number => (typeof state.rating === 'number' ? state.rating : RATING_START)

export function writeRating(nk: nkruntime.Nakama, userId: string, username: string, state: PlayerState): void {
  const stats = state.pvp || { wins: 0, losses: 0 }
  nk.leaderboardRecordWrite(RATING_LEADERBOARD, userId, username, ratingOf(state), 0, { wins: stats.wins, losses: stats.losses })
}
