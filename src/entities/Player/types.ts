import type { PlayerState } from '@shared/core/state'

export const PLAYER_COLLECTION = 'player'
export const PLAYER_STATE_KEY = 'state'

export interface IPlayerRecord {
  state: PlayerState
  rev: number
  createdAt: number
  updatedAt: number
}

export interface IPlayerView {
  state: PlayerState
  rev: number
  serverTime: number
  server: string
  protocol: number
  shared: { proto: string; digest: string }
}
