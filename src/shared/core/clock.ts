// Часы логики. Действие исполняется дважды — на клиенте (сразу) и на сервере (подтверждение) — и должно дать
// одно и то же состояние, поэтому «сейчас» внутри действия берётся отсюда: applyAction (core/actions.ts) ставит
// время действия на время его исполнения. Вне действий — обычные часы.
let fixed: number | null = null;

export const clockNow = (): number => fixed ?? Date.now();

/** Исполнить fn с фиксированным «сейчас». */
export function withClock<T>(now: number, fn: () => T): T {
  const prev = fixed;
  fixed = now;
  try {
    return fn();
  } finally {
    fixed = prev;
  }
}
