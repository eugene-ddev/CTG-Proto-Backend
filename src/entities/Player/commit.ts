import { withPublished } from '../Arena/publish'
import { settleDefender } from '../Arena/settlePvp'
import { writePlayer } from './storage'
import type { IPlayerRecord } from './types'

export function commitPlayer(
  nk: nkruntime.Nakama,
  logger: nkruntime.Logger,
  userId: string,
  username: string,
  record: IPlayerRecord,
  version: string,
): IPlayerRecord {
  const pending = record.state.pvpPending
  const settle = pending && pending.id !== record.pvpDone ? pending : null
  const next = withPublished(nk, userId, username, settle ? { ...record, pvpDone: settle.id } : record)
  writePlayer(nk, userId, next, version)
  if (settle) {
    try {
      settleDefender(nk, logger, username, settle)
    } catch (error) {
      logger.error(`[pvp] settle failed fight=${settle.id}: ${(error as Error).message}`)
    }
  }
  return next
}
