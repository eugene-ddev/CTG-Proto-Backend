import { BLUEPRINTS, START, maxStackOf } from '@shared/data/catalog'
import { createInitialState, type PlayerState } from '@shared/core/state'

export const makeFreshState = (): PlayerState =>
  createInitialState(
    START,
    BLUEPRINTS.map((blueprint) => blueprint.id),
    (itemId) => maxStackOf(itemId),
  )
