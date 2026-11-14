import { protectedRpc } from '@lib/protectedRpc'
import { grantReward, type InboxEntry } from '@shared/core/arena'
import { updateProfile } from '../../entities/Arena/profile'
import { readOrCreatePlayer } from '../../entities/Player/storage'
import { commitPlayer } from '../../entities/Player/commit'

const WRITE_ATTEMPTS = 3

export const claimInboxRpc = protectedRpc('arena/claimInbox', (userId, _payload, ctx, logger, nk) => {
  let taken: InboxEntry[] = []
  const arena = updateProfile(nk, userId, ctx.username || '', (profile) => {
    taken = profile.inbox
    return { ...profile, inbox: [] }
  })
  const rewards = taken.filter((entry) => !!entry.reward)
  let stored = readOrCreatePlayer(nk, userId)
  if (rewards.length) {
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      stored = readOrCreatePlayer(nk, userId)
      let state = stored.record.state
      for (const entry of rewards) state = grantReward(state, entry.reward!)
      try {
        const committed = commitPlayer(
          nk,
          logger,
          userId,
          ctx.username || '',
          { ...stored.record, state, rev: stored.record.rev + 1, updatedAt: Date.now() },
          stored.version,
        )
        logger.info(`[arena/claimInbox] Granted ${rewards.length} rewards user=${userId}`)
        return JSON.stringify({ state: committed.record.state, rev: committed.record.rev, arena })
      } catch (error) {
        logger.info(`[arena/claimInbox] Write conflict attempt=${attempt + 1}: ${(error as Error).message}`)
      }
    }
    logger.error(`[arena/claimInbox] Rewards lost user=${userId} count=${rewards.length}`)
  }
  return JSON.stringify({ state: stored.record.state, rev: stored.record.rev, arena })
})
