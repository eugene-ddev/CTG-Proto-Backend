export enum GRPCErrorCode {
  INVALID_ARGUMENT = 3,
  NOT_FOUND = 5,
  FAILED_PRECONDITION = 9,
  INTERNAL = 13,
  UNAUTHENTICATED = 16,
}

export const makeErrorResponse = (message: string, code: GRPCErrorCode): string => JSON.stringify({ error: { message, code } })
