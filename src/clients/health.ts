import { HealthCheckResponse_ServingStatus, HealthClient as HealthStub } from '../generated/grpc/health/v1/health'
import { promised, type Connection } from '../connection'
import { GogiError } from '../errors'

export const GATEWAY = 'gateway'

/** The services behind the gateway, by the names it routes them under. */
export const PLATFORM_SERVICES = [
  'documents',
  'indexes',
  'llms',
  'prompts',
  'llm-sessions',
  'workflows',
  'llm-tools',
  'guardrails',
  'observability',
] as const

export type ServingStatus = 'SERVING' | 'NOT_SERVING' | 'SERVICE_UNKNOWN' | 'UNKNOWN'

export type PlatformHealth = {
  reachable: boolean
  /** service name to its status, the gateway's included */
  services: Record<string, ServingStatus>
  /** why the gateway can't be reached */
  error?: string
}

/** The platform's health, from the gateway's gRPC health service (grpc.health.v1). */
export class HealthClient {
  private readonly stub: HealthStub

  constructor(
    private readonly connection: Connection,
    private readonly timeoutMs = 5000,
  ) {
    this.stub = new HealthStub(connection.gatewayUrl, connection.credentials)
  }

  /** The status of one service, e.g. "llms", or of the gateway. Throws GogiError NOT_FOUND for an unknown one. */
  async check(service: string = GATEWAY): Promise<ServingStatus> {
    try {
      const check = promised(this.stub.check, this.stub)
      const response = await check(
        { service: service === GATEWAY ? '' : service },
        this.connection.metadata(GATEWAY),
        this.connection.options(this.timeoutMs),
      )
      return (HealthCheckResponse_ServingStatus[response.status] as ServingStatus) ?? 'UNKNOWN'
    } catch (error) {
      throw GogiError.fromServiceError(error as never)
    }
  }

  /** The status of the gateway and of every service. Doesn't throw if the gateway can't be reached. */
  async status(): Promise<PlatformHealth> {
    let gateway: ServingStatus
    try {
      gateway = await this.check(GATEWAY)
    } catch (error) {
      return { reachable: false, services: {}, error: (error as Error).message }
    }
    const statuses = await Promise.all(
      PLATFORM_SERVICES.map((service) =>
        this.check(service).catch((error: GogiError): ServingStatus =>
          error.code === 'NOT_FOUND' ? 'SERVICE_UNKNOWN' : 'UNKNOWN',
        ),
      ),
    )
    return {
      reachable: true,
      services: { [GATEWAY]: gateway, ...Object.fromEntries(PLATFORM_SERVICES.map((s, i) => [s, statuses[i]])) },
    }
  }
}
