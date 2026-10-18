import {
  CredentialServerClient,
  type Credential as CredentialMessage,
} from '../generated/gogi/v1/credential_service'
import { promised, type Connection } from '../connection'

// the credentials are held by the llms service
const SERVICE = 'llms'

/** The credentials of the built-in providers: an application's calls to them are made with its own key. */
export const ANTHROPIC = 'anthropic'
export const OPENAI = 'openai'

/** A credential of the application; never its value. */
export type Credential = {
  name: string
  /** RFC 3339 */
  createdAt: string
  updatedAt: string
}

function toCredential(message: CredentialMessage | undefined): Credential {
  return { name: message?.name ?? '', createdAt: message?.createdAt ?? '', updatedAt: message?.updatedAt ?? '' }
}

/**
 * The application's own credentials: its model providers' keys, and the keys its registered models need. A
 * credential's value is kept in gogi's credential store and never given back; another application can't use it.
 */
export class CredentialsClient {
  private readonly stub: CredentialServerClient

  constructor(private readonly connection: Connection) {
    this.stub = new CredentialServerClient(connection.gatewayUrl, connection.credentials)
  }

  /** Stores the credential, e.g. store('anthropic', key); storing one the application has replaces its value. */
  async store(name: string, value: string): Promise<Credential> {
    const store = promised(this.stub.storeCredential, this.stub)
    const response = await this.connection.unary(SERVICE, (m, o) => store({ name, value }, m, o))
    return toCredential(response.credential)
  }

  /** The application's credentials, without their values. */
  async list(): Promise<Credential[]> {
    const list = promised(this.stub.listCredentials, this.stub)
    const response = await this.connection.unary(SERVICE, (m, o) => list({}, m, o))
    return response.credentials.map(toCredential)
  }
}
