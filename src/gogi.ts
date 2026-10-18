import { CredentialsClient } from './clients/credentials'
import { DocumentsClient } from './clients/documents'
import { HealthClient } from './clients/health'
import { IndexesClient } from './clients/indexes'
import { ModelsClient } from './clients/models'
import { Connection, type GogiOptions } from './connection'

/**
 * The gogi platform, reached through its gateway. Each service's client is created when first used.
 *
 *   const gogi = new Gogi({ gatewayUrl: 'localhost:50051' })
 *   const health = await gogi.health.status()
 *
 * Where gogi serves many applications, every call carries the key gogi gave the application:
 *
 *   const gogi = new Gogi({ gatewayUrl: 'gogi.example.org:443', apiKey: 'gogi_...' })
 */
export class Gogi {
  readonly connection: Connection
  private clients = new Map<string, unknown>()

  constructor(options: GogiOptions = {}) {
    this.connection = new Connection(options)
  }

  get health(): HealthClient {
    return this.client('health', () => new HealthClient(this.connection))
  }

  get indexes(): IndexesClient {
    return this.client('indexes', () => new IndexesClient(this.connection))
  }

  get documents(): DocumentsClient {
    return this.client('documents', () => new DocumentsClient(this.connection))
  }

  get models(): ModelsClient {
    return this.client('models', () => new ModelsClient(this.connection))
  }

  /** The application's own credentials, e.g. its model providers' keys. */
  get credentials(): CredentialsClient {
    return this.client('credentials', () => new CredentialsClient(this.connection))
  }

  private client<T>(name: string, create: () => T): T {
    if (!this.clients.has(name)) this.clients.set(name, create())
    return this.clients.get(name) as T
  }
}
