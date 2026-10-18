import {
  credentials,
  Metadata,
  status,
  type CallOptions,
  type ChannelCredentials,
  type ClientReadableStream,
  type ServiceError,
} from '@grpc/grpc-js'
import { readFileSync } from 'node:fs'
import { GogiError } from './errors'

/** How the SDK reaches the platform's gateway. */
export type GogiOptions = {
  /** e.g. "localhost:50051"; defaults to GOGI_GATEWAY_URL, then localhost:50051 */
  gatewayUrl?: string
  /** plaintext gRPC; defaults to true for localhost and when GOGI_GATEWAY_INSECURE=1, else TLS */
  insecure?: boolean
  /**
   * the key gogi gave the application, sent with every call; defaults to GOGI_API_KEY. Not needed where gogi
   * runs without keys
   */
  apiKey?: string
  /**
   * PEM certificates to check the gateway's certificate against instead of the system's, e.g. the certificate
   * authority of a deployment without a domain; defaults to the file GOGI_GATEWAY_CA_FILE
   */
  rootCertificates?: Buffer
  /** how long a call may take before it fails with DEADLINE_EXCEEDED; none by default */
  timeoutMs?: number
  /** how many times a call is tried when the platform is briefly unavailable */
  maxAttempts?: number
}

// transient trouble between the SDK and the gateway; anything else is the platform's answer
const RETRYABLE = new Set([status.UNAVAILABLE, status.DEADLINE_EXCEEDED, status.RESOURCE_EXHAUSTED])
const BASE_BACKOFF_MS = 100

/** A message over gRPC's size limit fails as RESOURCE_EXHAUSTED, the same way every time. */
function isTooLarge(error: ServiceError): boolean {
  return error.code === status.RESOURCE_EXHAUSTED && /larger than max/.test(error.details ?? '')
}

export class Connection {
  readonly gatewayUrl: string
  readonly credentials: ChannelCredentials
  private readonly timeoutMs?: number
  private readonly maxAttempts: number
  private readonly apiKey?: string

  constructor(options: GogiOptions = {}) {
    this.gatewayUrl = options.gatewayUrl ?? process.env.GOGI_GATEWAY_URL ?? 'localhost:50051'
    const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(this.gatewayUrl)
    const insecure = options.insecure ?? (local || process.env.GOGI_GATEWAY_INSECURE === '1')
    const caFile = process.env.GOGI_GATEWAY_CA_FILE
    const rootCertificates = options.rootCertificates ?? (caFile ? readFileSync(caFile) : undefined)
    this.credentials = insecure ? credentials.createInsecure() : credentials.createSsl(rootCertificates)
    this.apiKey = options.apiKey || process.env.GOGI_API_KEY || undefined
    this.timeoutMs = options.timeoutMs
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3)
  }

  /**
   * The metadata that routes a call through the gateway to a service, e.g. "documents", and says which
   * application it is for, with the application's key.
   */
  metadata(service: string): Metadata {
    const metadata = new Metadata()
    metadata.set('x-target-service', service)
    if (this.apiKey) metadata.set('authorization', `Bearer ${this.apiKey}`)
    return metadata
  }

  options(timeoutMs = this.timeoutMs): CallOptions {
    return timeoutMs ? { deadline: Date.now() + timeoutMs } : {}
  }

  /**
   * Makes a unary call, retrying it with exponential backoff while the platform is briefly unavailable, and
   * turns gRPC errors into GogiErrors.
   */
  async unary<T>(service: string, call: (metadata: Metadata, options: CallOptions) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call(this.metadata(service), this.options())
      } catch (error) {
        const serviceError = error as ServiceError
        const retry = RETRYABLE.has(serviceError.code) && !isTooLarge(serviceError) && attempt < this.maxAttempts
        if (!retry) throw toGogiError(error)
        await new Promise((resolve) => setTimeout(resolve, BASE_BACKOFF_MS * 2 ** (attempt - 1)))
      }
    }
  }
}

export function toGogiError(error: unknown): unknown {
  const serviceError = error as ServiceError
  return typeof serviceError?.code === 'number' ? GogiError.fromServiceError(serviceError) : error
}

/** A unary call of a generated client as a promise. */
export function promised<Req, Res>(
  method: (
    request: Req,
    metadata: Metadata,
    options: Partial<CallOptions>,
    callback: (error: ServiceError | null, response: Res) => void,
  ) => unknown,
  self: unknown,
): (request: Req, metadata: Metadata, options: CallOptions) => Promise<Res> {
  return (request, metadata, options) =>
    new Promise((resolve, reject) => {
      method.call(self, request, metadata, options, (error, response) => (error ? reject(error) : resolve(response)))
    })
}

/** The messages of a server stream, turning gRPC errors into GogiErrors. */
export async function* streamed<T>(stream: ClientReadableStream<T>): AsyncGenerator<T> {
  try {
    for await (const message of stream) yield message as T
  } catch (error) {
    throw toGogiError(error)
  }
}
