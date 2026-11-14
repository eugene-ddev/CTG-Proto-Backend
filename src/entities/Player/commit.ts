import type { ArenaProfile } from '@shared/core/arena'
import { withPublished } from '../Arena/publish'
import { settlePvp } from '../Arena/settlePvp'
import { writePlayer } from './storage'
import type { IPlayerRecord } from './types'

export interface ICommitResult {
  record: IPlayerRecord
  arena?: ArenaProfile
}

export function commitPlayer(
  nk: nkruntime.Nakama,
  logger: nkruntime.Logger,
  userId: string,
  username: string,
  record: IPlayerRecord,
  version: string,
): ICommitResult {
  const pending = record.state.pvpPending
  const settle = pending && pending.id !== record.pvpDone ? pending : null
  const next = withPublished(nk, userId, settle ? { ...record, pvpDone: settle.id } : record)
  writePlayer(nk, userId, next, version)
  if (!settle) return { record: next }
  try {
    return { record: next, arena: settlePvp(nk, logger, userId, username, settle) }
  } catch (error) {
    logger.error(`[pvp] settle failed fight=${settle.id}: ${(error as Error).message}`)
    return { record: next }
  }
}
