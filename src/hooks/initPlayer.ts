import { createPlayer, readPlayer } from '../entities/Player/storage'

export const initPlayer: nkruntime.AfterHookFunction<nkruntime.Session, nkruntime.AuthenticateDeviceRequest> = (
  ctx,
  logger,
  nk,
  _session,
) => {
  if (!ctx.userId) return
  if (readPlayer(nk, ctx.userId)) return
  createPlayer(nk, ctx.userId)
  logger.info(`[initPlayer] Player created user=${ctx.userId} name=${ctx.username}`)
}
