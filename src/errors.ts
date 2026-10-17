import { status, type ServiceError } from '@grpc/grpc-js'

/** The platform failed or refused a call. `code` is the gRPC status, e.g. `NOT_FOUND` or `UNAVAILABLE`. */
export class GogiError extends Error {
  readonly code: string
  readonly details: string

  constructor(code: string, details: string) {
    super(`${code}: ${details}`)
    this.name = 'GogiError'
    this.code = code
    this.details = details
  }

  static fromServiceError(error: ServiceError): GogiError {
    return new GogiError(status[error.code] ?? String(error.code), error.details || error.message)
  }
}

export function isServiceError(error: unknown): error is ServiceError {
  return typeof error === 'object' && error !== null && 'code' in error && 'details' in error && 'metadata' in error
}
