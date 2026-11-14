import { createBattle, runToEnd } from '@shared/core/battle'
import { generateOpponent } from '@shared/core/opponent'

export interface ISelfTestResult {
  seed: number
  winner: string
  turns: number
  events: number
  playerAlive: number
  enemyAlive: number
}

export function runSelfTest(seed: number): ISelfTestResult {
  const player = generateOpponent(seed + 1, { level: 1 })
  const enemy = generateOpponent(seed + 2, { level: 1, player })
  const battle = runToEnd(createBattle(seed, player, enemy))
  return {
    seed,
    winner: battle.over ? battle.over.winner : 'none',
    turns: battle.turn,
    events: battle.log.length,
    playerAlive: battle.player.aliveBlocks,
    enemyAlive: battle.enemy.aliveBlocks,
  }
}
