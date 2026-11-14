import { protectedRpc } from '@lib/protectedRpc'
import { readOrCreatePlayer, toPlayerView } from '../../entities/Player/storage'

export const readPlayerRpc = protectedRpc('player/read', (userId, _payload, _ctx, _logger, nk) =>
  JSON.stringify(toPlayerView(readOrCreatePlayer(nk, userId).record)),
)
