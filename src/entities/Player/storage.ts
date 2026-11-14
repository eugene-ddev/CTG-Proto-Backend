import { makeFreshState } from './makeFreshState'
import { IPlayerRecord, IPlayerView, PLAYER_COLLECTION, PLAYER_STATE_KEY } from './types'
import { PROTOCOL_VERSION, SERVER_VERSION, SHARED_VERSION } from '@lib/version'

export interface IStoredPlayer {
  record: IPlayerRecord
  version: string
}

export function readPlayer(nk: nkruntime.Nakama, userId: string): IStoredPlayer | null {
  const [found] = nk.storageRead([{ collection: PLAYER_COLLECTION, key: PLAYER_STATE_KEY, userId }])
  if (!found) return null
  const record = JSON.parse(JSON.stringify(found.value)) as IPlayerRecord
  return { record, version: found.version }
}

export function writePlayer(nk: nkruntime.Nakama, userId: string, record: IPlayerRecord, version: string): void {
  nk.storageWrite([
    {
      collection: PLAYER_COLLECTION,
      key: PLAYER_STATE_KEY,
      userId,
      value: record as unknown as { [key: string]: unknown },
      version,
      permissionRead: 1,
      permissionWrite: 0,
    },
  ])
}

export function createPlayer(nk: nkruntime.Nakama, userId: string): IPlayerRecord {
  const now = Date.now()
  const record: IPlayerRecord = { state: makeFreshState(), rev: 1, createdAt: now, updatedAt: now }
  writePlayer(nk, userId, record, '*')
  return record
}

export function readOrCreatePlayer(nk: nkruntime.Nakama, userId: string): IStoredPlayer {
  const stored = readPlayer(nk, userId)
  if (stored) return stored
  createPlayer(nk, userId)
  return readPlayer(nk, userId) as IStoredPlayer
}

export const toPlayerView = (record: IPlayerRecord, debug: boolean): IPlayerView => ({
  state: record.state,
  rev: record.rev,
  serverTime: Date.now(),
  server: SERVER_VERSION,
  protocol: PROTOCOL_VERSION,
  shared: SHARED_VERSION,
  debug,
})
