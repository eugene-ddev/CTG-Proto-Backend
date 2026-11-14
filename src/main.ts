import { pingRpc } from '@rpc/System/pingRpc'
import { SERVER_VERSION, SHARED_VERSION } from '@lib/version'
import { runSelfTest } from '@lib/selfTest'

const InitModule: nkruntime.InitModule = function (_ctx, logger, _nk, initializer) {
  initializer.registerRpc('system/ping', pingRpc)

  const check = runSelfTest(42)
  logger.info(
    `CTG-Proto-Backend ${SERVER_VERSION} ready, core ${SHARED_VERSION.proto} (${SHARED_VERSION.digest}), self-test: ${check.winner} in ${check.turns} turns`,
  )
}

// eslint-disable-next-line
// @ts-ignore
!InitModule && InitModule.bind(null)
