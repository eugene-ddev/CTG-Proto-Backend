import { pingRpc } from '@rpc/System/pingRpc'
import { readPlayerRpc } from '@rpc/Player/readPlayerRpc'
import { actRpc } from '@rpc/Player/actRpc'
import { resetPlayerRpc } from '@rpc/Player/resetPlayerRpc'
import { initPlayer } from './hooks/initPlayer'
import { opponentsRpc } from '@rpc/Arena/opponentsRpc'
import { challengeRpc } from '@rpc/Arena/challengeRpc'
import { leaderboardRpc } from '@rpc/Arena/leaderboardRpc'
import { ensureRatingLeaderboard } from './entities/Arena/leaderboard'
import { SERVER_VERSION, SHARED_VERSION } from '@lib/version'
import { runSelfTest } from '@lib/selfTest'

const InitModule: nkruntime.InitModule = function (_ctx, logger, nk, initializer) {
  ensureRatingLeaderboard(nk, logger)

  initializer.registerAfterAuthenticateDevice(initPlayer)

  initializer.registerRpc('system/ping', pingRpc)
  initializer.registerRpc('player/read', readPlayerRpc)
  initializer.registerRpc('player/act', actRpc)
  initializer.registerRpc('player/reset', resetPlayerRpc)
  initializer.registerRpc('arena/opponents', opponentsRpc)
  initializer.registerRpc('arena/challenge', challengeRpc)
  initializer.registerRpc('arena/leaderboard', leaderboardRpc)

  const check = runSelfTest(42)
  logger.info(
    `CTG-Proto-Backend ${SERVER_VERSION} ready, core ${SHARED_VERSION.proto} (${SHARED_VERSION.digest}), self-test: ${check.winner} in ${check.turns} turns`,
  )
}

// eslint-disable-next-line
// @ts-ignore
!InitModule && InitModule.bind(null)
