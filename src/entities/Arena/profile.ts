import { freshArenaProfile, type ArenaProfile } from '@shared/core/arena'
import { RATING_START } from '@shared/core/rating'
import { RATING_LEADERBOARD } from './constants'

export const ARENA_COLLECTION = 'arena'
export const ARENA_PROFILE_KEY = 'profile'
const WRITE_ATTEMPTS = 4

interface IStoredProfile {
  profile: ArenaProfile
  version: string
}

function normalize(value: Partial<ArenaProfile>): ArenaProfile {
  return {
    rating: typeof value.rating === 'number' ? value.rating : RATING_START,
    wins: Number(value.wins) || 0,
    losses: Number(value.losses) || 0,
    inbox: Array.isArray(value.inbox) ? value.inbox : [],
  }
}

function readStored(nk: nkruntime.Nakama, userId: string): IStoredProfile | null {
  const [found] = nk.storageRead([{ collection: ARENA_COLLECTION, key: ARENA_PROFILE_KEY, userId }])
  if (!found) return null
  return { profile: normalize(JSON.parse(JSON.stringify(found.value)) as Partial<ArenaProfile>), version: found.version }
}

function writeStored(nk: nkruntime.Nakama, userId: string, profile: ArenaProfile, version: string): void {
  nk.storageWrite([
    {
      collection: ARENA_COLLECTION,
      key: ARENA_PROFILE_KEY,
      userId,
      value: profile as unknown as { [key: string]: unknown },
      version,
      permissionRead: 1,
      permissionWrite: 0,
    },
  ])
}

function writeLeaderboard(nk: nkruntime.Nakama, userId: string, username: string, profile: ArenaProfile): void {
  nk.leaderboardRecordWrite(RATING_LEADERBOARD, userId, username, profile.rating, 0, {
    wins: profile.wins,
    losses: profile.losses,
  })
}

export function readProfile(nk: nkruntime.Nakama, userId: string): ArenaProfile {
  const stored = readStored(nk, userId)
  return stored ? stored.profile : freshArenaProfile()
}

export function ensureProfile(
  nk: nkruntime.Nakama,
  userId: string,
  username: string,
  legacy?: { rating?: number; pvp?: { wins: number; losses: number }; inbox?: ArenaProfile['inbox'] },
): ArenaProfile {
  const stored = readStored(nk, userId)
  if (stored) return stored.profile
  const profile = normalize({
    rating: legacy && legacy.rating,
    wins: legacy && legacy.pvp ? legacy.pvp.wins : 0,
    losses: legacy && legacy.pvp ? legacy.pvp.losses : 0,
    inbox: legacy && legacy.inbox,
  })
  try {
    writeStored(nk, userId, profile, '*')
  } catch (error) {
    return readProfile(nk, userId)
  }
  writeLeaderboard(nk, userId, username, profile)
  return profile
}

export function updateProfile(
  nk: nkruntime.Nakama,
  userId: string,
  username: string,
  change: (profile: ArenaProfile) => ArenaProfile,
): ArenaProfile {
  let lastError = ''
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const stored = readStored(nk, userId)
    const next = change(stored ? stored.profile : freshArenaProfile())
    try {
      writeStored(nk, userId, next, stored ? stored.version : '*')
      writeLeaderboard(nk, userId, username, next)
      return next
    } catch (error) {
      lastError = (error as Error).message
    }
  }
  throw new Error(`Arena profile of ${userId} not updated: ${lastError}`)
}
