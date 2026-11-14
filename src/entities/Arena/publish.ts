import { activeCharacter, snapshotOf, type FighterSnapshot } from '@shared/core/arena'
import type { PlayerState } from '@shared/core/state'
import type { IPlayerRecord } from '../Player/types'
import { FIGHTER_COLLECTION, FIGHTER_KEY } from './constants'
import { ratingOf, writeRating } from './leaderboard'

export interface IFighterRecord {
  snapshot: FighterSnapshot | null
  updatedAt: number
}

const publicKey = (state: PlayerState, username: string): string => {
  const fighter = activeCharacter(state)
  const stats = state.pvp || { wins: 0, losses: 0 }
  return JSON.stringify([username, ratingOf(state), stats.wins, stats.losses, fighter ? snapshotOf(fighter) : null])
}

export function withPublished(nk: nkruntime.Nakama, userId: string, username: string, record: IPlayerRecord): IPlayerRecord {
  const key = publicKey(record.state, username)
  if (record.pub === key) return record
  const fighter = activeCharacter(record.state)
  const value: IFighterRecord = { snapshot: fighter ? snapshotOf(fighter) : null, updatedAt: Date.now() }
  nk.storageWrite([
    {
      collection: FIGHTER_COLLECTION,
      key: FIGHTER_KEY,
      userId,
      value: value as unknown as { [key: string]: unknown },
      permissionRead: 2,
      permissionWrite: 0,
    },
  ])
  writeRating(nk, userId, username, record.state)
  return { ...record, pub: key }
}

export function readSnapshots(nk: nkruntime.Nakama, userIds: string[]): { [userId: string]: FighterSnapshot } {
  const found: { [userId: string]: FighterSnapshot } = {}
  if (!userIds.length) return found
  const objects = nk.storageRead(userIds.map((userId) => ({ collection: FIGHTER_COLLECTION, key: FIGHTER_KEY, userId })))
  for (const object of objects) {
    const value = JSON.parse(JSON.stringify(object.value)) as IFighterRecord
    if (value.snapshot) found[object.userId] = value.snapshot
  }
  return found
}
