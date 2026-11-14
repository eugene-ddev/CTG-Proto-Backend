import { protectedRpc } from '@lib/protectedRpc'
import { GRPCErrorCode, makeErrorResponse } from '@lib/response'
import { isDebugMode } from '@lib/debug'
import { applyAction, isAction, isDebugAction, isServerSeeded, stateHash, type ActionCall } from '@shared/core/actions'
import { readOrCreatePlayer, writePlayer } from '../../entities/Player/storage'

interface IActPayload {
  rev: number
  actions: ActionCall[]
}

const makeSeed = (nk: nkruntime.Nakama): number => parseInt(nk.uuidv4().replace(/-/g, '').slice(0, 8), 16) >>> 0

const MAX_ACTIONS = 200
const CLOCK_TOLERANCE_MS = 10000

export const actRpc = protectedRpc('player/act', (userId, payload, ctx, logger, nk) => {
  const input = JSON.parse(payload) as IActPayload
  if (typeof input.rev !== 'number' || !Array.isArray(input.actions) || !input.actions.length) {
    return makeErrorResponse('rev and actions are required', GRPCErrorCode.INVALID_ARGUMENT)
  }
  if (input.actions.length > MAX_ACTIONS) {
    return makeErrorResponse('Too many actions', GRPCErrorCode.INVALID_ARGUMENT)
  }

  const stored = readOrCreatePlayer(nk, userId)
  if (stored.record.rev !== input.rev) {
    logger.info(`[player/act] Conflict user=${userId} client=${input.rev} server=${stored.record.rev}`)
    return JSON.stringify({ ok: false, reason: 'conflict', state: stored.record.state, rev: stored.record.rev })
  }

  const debug = isDebugMode(ctx)
  const serverNow = Date.now()
  let state = stored.record.state
  let seededByServer = false
  for (const call of input.actions) {
    const name = String(call && call.name)
    const allowed = isAction(name) && (debug || !isDebugAction(name)) && Array.isArray(call.args)
    const now = typeof call.now === 'number' && Math.abs(call.now - serverNow) <= CLOCK_TOLERANCE_MS ? call.now : serverNow
    const serverSeeded = isServerSeeded(name)
    seededByServer = seededByServer || serverSeeded
    const seed = serverSeeded ? makeSeed(nk) : typeof call.seed === 'number' ? call.seed >>> 0 : 0
    const next = allowed ? applyAction(state, name, call.args, { now, seed }) : null
    if (!next) {
      logger.info(`[player/act] Rejected user=${userId} action=${name}`)
      return JSON.stringify({ ok: false, reason: 'rejected', action: name, state: stored.record.state, rev: stored.record.rev })
    }
    state = next
  }

  const record = { ...stored.record, state, rev: stored.record.rev + 1, updatedAt: serverNow }
  writePlayer(nk, userId, record, stored.version)
  logger.info(`[player/act] Applied user=${userId} actions=${input.actions.map((call) => call.name).join(',')} rev=${record.rev}`)
  return JSON.stringify({ ok: true, rev: record.rev, hash: stateHash(state), state: seededByServer ? state : undefined })
})
