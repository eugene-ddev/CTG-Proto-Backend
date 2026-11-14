import { pingRpc } from '@rpc/System/pingRpc'
import { readPlayerRpc } from '@rpc/Player/readPlayerRpc'
import { syncPlayerRpc } from '@rpc/Player/syncPlayerRpc'
import { resetPlayerRpc } from '@rpc/Player/resetPlayerRpc'
import { initPlayer } from './hooks/initPlayer'
import { SERVER_VERSION, SHARED_VERSION } from '@lib/version'
import { runSelfTest } from '@lib/selfTest'

const InitModule: nkruntime.InitModule = function (_ctx, logger, _nk, initializer) {
  initializer.registerAfterAuthenticateDevice(initPlayer)

  initializer.registerRpc('system/ping', pingRpc)
  initializer.registerRpc('player/read', readPlayerRpc)
  initializer.registerRpc('player/sync', syncPlayerRpc)
  initializer.registerRpc('player/reset', resetPlayerRpc)

  const check = runSelfTest(42)
  logger.info(
    `CTG-Proto-Backend ${SERVER_VERSION} ready, core ${SHARED_VERSION.proto} (${SHARED_VERSION.digest}), self-test: ${check.winner} in ${check.turns} turns`,
  )
}

// eslint-disable-next-line
// @ts-ignore
!InitModule && InitModule.bind(null)
