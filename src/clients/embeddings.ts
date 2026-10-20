import { LLMModelServerClient, type EmbeddingModel as ProtoModel } from '../generated/gogi/v1/llm_model_service'
import { promised, type Connection } from '../connection'

// the embedding models are served by the llms service
const SERVICE = 'llms'

/**
 * The models gogi provides: the two small ones it runs, and OpenAI's, used with the application's own key, stored as
 * the credential 'openai'.
 */
export const BGE_SMALL = 'bge-small-en-v1.5'
export const MINILM = 'all-MiniLM-L6-v2'
export const OPENAI_SMALL = 'text-embedding-3-small'

/** A text embedding model the application can ingest and search documents with. */
export type EmbeddingModel = {
  name: string
  /** the length of its vectors */
  dimensions: number
  /** the most tokens it reads; a document's chunks for it are shorter */
  maxInputTokens: number
  /** where the application's own model is; empty for the models gogi provides */
  url: string
  /** the credential it is called with, e.g. 'openai'; empty if none */
  credentialRef: string
  /** false for OpenAI's model until the application stores its key */
  available: boolean
}

/** A model the application hosts behind an OpenAI-compatible embeddings endpoint. */
export type HostedModel = {
  /** 2 to 63 lowercase letters, digits and dashes, starting with a letter */
  name: string
  /** the endpoint's base URL, e.g. 'https://models.example.org/v1'; gogi posts to <url>/embeddings */
  url: string
  /** the model's name at the endpoint, if not name */
  servedName?: string
  /** a credential the application stored, sent as a bearer token */
  credentialRef?: string
  /** the most tokens it reads of a text; 512 if not given */
  maxInputTokens?: number
}

function toModel(model: ProtoModel): EmbeddingModel {
  return { ...model }
}

/**
 * The embedding models the application can use: those gogi provides, and those it hosts itself and registers by
 * their URL. Documents are ingested and searched with them by name.
 */
export class EmbeddingsClient {
  private readonly stub: LLMModelServerClient

  constructor(private readonly connection: Connection) {
    this.stub = new LLMModelServerClient(connection.gatewayUrl, connection.credentials)
  }

  /** The models gogi provides and the application's own. */
  async list(): Promise<EmbeddingModel[]> {
    const list = promised(this.stub.listEmbeddingModels, this.stub)
    const response = await this.connection.unary(SERVICE, (m, o) => list({}, m, o))
    return response.models.map(toModel)
  }

  /**
   * Registers a model the application hosts. gogi calls it once to learn its dimensions; a URL on a private network
   * is refused. Registering a name again replaces the registration; only the application can use the model.
   */
  async register(model: HostedModel): Promise<EmbeddingModel> {
    const register = promised(this.stub.registerEmbeddingModel, this.stub)
    const response = await this.connection.unary(SERVICE, (m, o) =>
      register(
        {
          name: model.name,
          url: model.url,
          servedName: model.servedName ?? '',
          credentialRef: model.credentialRef ?? '',
          maxInputTokens: model.maxInputTokens ?? 0,
        },
        m,
        o,
      ),
    )
    return toModel(response)
  }

  /** The vectors of the texts, in their order. */
  async embed(model: string, inputs: string[]): Promise<number[][]> {
    const embed = promised(this.stub.embed, this.stub)
    const response = await this.connection.unary(SERVICE, (m, o) => embed({ model, inputs }, m, o))
    return response.embeddings.map((embedding) => [...embedding.values])
  }
}
