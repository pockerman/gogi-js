import { Server, ServerCredentials, status, type ServiceDefinition, type UntypedServiceImplementation } from '@grpc/grpc-js'
import { Gogi } from '../src'

/** A fake gateway: an in-process gRPC server with the services a test gives it, and the routes calls asked for. */
export class FakeGateway {
  readonly server = new Server()
  readonly routes: string[] = []
  gogi!: Gogi

  // handlers are typed loosely: each test declares only what it uses of the call
  add(service: ServiceDefinition, implementation: Record<string, (...args: never[]) => unknown>): this {
    // every handler records the service the call was routed to
    const recording = Object.fromEntries(
      Object.entries(implementation).map(([name, handler]) => [
        name,
        (call: { metadata: { get(key: string): unknown[] } }, ...rest: unknown[]) => {
          this.routes.push(String(call.metadata.get('x-target-service')[0]))
          return (handler as (...args: unknown[]) => unknown)(call, ...rest)
        },
      ]),
    )
    this.server.addService(service, recording as UntypedServiceImplementation)
    return this
  }

  async start(options: { maxAttempts?: number; apiKey?: string } = {}): Promise<Gogi> {
    const port = await new Promise<number>((resolve, reject) =>
      this.server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, port) =>
        error ? reject(error) : resolve(port),
      ),
    )
    this.gogi = new Gogi({ gatewayUrl: `127.0.0.1:${port}`, ...options })
    return this.gogi
  }

  stop(): void {
    this.server.forceShutdown()
  }
}

export function fail(code: status, details: string) {
  return Object.assign(new Error(details), { code, details })
}
