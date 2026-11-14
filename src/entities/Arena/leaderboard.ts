import { RATING_LEADERBOARD } from './constants'

export function ensureRatingLeaderboard(nk: nkruntime.Nakama, logger: nkruntime.Logger): void {
  try {
    nk.leaderboardCreate(RATING_LEADERBOARD, true, 'descending' as nkruntime.SortOrder, 'set' as nkruntime.Operator)
  } catch (error) {
    logger.error(`[leaderboard] create failed: ${(error as Error).message}`)
  }
}
