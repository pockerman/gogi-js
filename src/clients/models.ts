import { LLMModelServerClient, type LLMRunRequest, type TokenUsage } from '../generated/gogi/v1/llm_model_service'
import { promised, streamed, type Connection } from '../connection'

const SERVICE = 'llms'

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export type Message = {
  role: Role
  content: string
  /** for a tool message: the call it answers */
  toolCallId?: string
  name?: string
}

/** Asks for an answer that is a JSON object: any object, or one matching a JSON schema. */
export type ResponseFormat = { type: 'json_object' } | { type: 'json_schema'; schema: Record<string, unknown> }

export type RunRequest = {
  /** e.g. "anthropic" or "openai", or a provider registered with the platform */
  provider: string
  model: string
  messages: Message[]
  maxTokens?: number
  temperature?: number
  topP?: number
  stopSequences?: string[]
  /** the name of a prompt registered with the platform, used as the system prompt */
  systemPromptName?: string
  responseFormat?: ResponseFormat
}

export type Usage = { promptTokens: number; completionTokens: number; totalTokens: number }

export type RunResponse = {
  content: string
  /** which provider and model answered; they differ from the request's after a fallback */
  provider: string
  model: string
  finishReason: string
  usage: Usage
}

export type StreamChunk = {
  /** the next part of the answer */
  token: string
  provider: string
  model: string
  /** with the last chunk */
  finishReason?: string
  usage?: Usage
}

function toUsage(usage: TokenUsage | undefined): Usage {
  return {
    promptTokens: usage?.promptTokens ?? 0,
    completionTokens: usage?.completionTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
  }
}

function toProto(request: RunRequest): LLMRunRequest {
  const format = request.responseFormat
  return {
    config: {
      provider: request.provider,
      model: request.model,
      maxTokens: request.maxTokens ?? 1000,
      temperature: request.temperature ?? 0,
      topP: request.topP ?? 0,
      stopSequences: request.stopSequences ?? [],
      frequencyPenalty: 0,
      presencePenalty: 0,
      systemPromptName: request.systemPromptName ?? '',
    },
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
      toolCalls: [],
      toolCallId: message.toolCallId,
      name: message.name,
      timestamp: 0,
    })),
    tools: [],
    responseFormat: format && {
      type: format.type,
      schemaJson: format.type === 'json_schema' ? JSON.stringify(format.schema) : '',
    },
  }
}

/** Models: running a model through the platform, which picks the provider, retries and falls back. */
export class ModelsClient {
  private readonly stub: LLMModelServerClient

  constructor(private readonly connection: Connection) {
    this.stub = new LLMModelServerClient(connection.gatewayUrl, connection.credentials)
  }

  async run(request: RunRequest): Promise<RunResponse> {
    const run = promised(this.stub.run, this.stub)
    const response = await this.connection.unary(SERVICE, (m, o) => run(toProto(request), m, o))
    return {
      content: response.content,
      provider: response.provider,
      model: response.model,
      finishReason: response.finishReason,
      usage: toUsage(response.usage),
    }
  }

  /** Runs the model with a JSON response format and parses the answer. */
  async runJson<T = unknown>(request: RunRequest & { responseFormat: ResponseFormat }): Promise<T> {
    return JSON.parse((await this.run(request)).content) as T
  }

  /** The answer as it's written, chunk by chunk. */
  async *runStream(request: RunRequest): AsyncGenerator<StreamChunk> {
    const stream = this.stub.runStream(toProto(request), this.connection.metadata(SERVICE), this.connection.options())
    for await (const chunk of streamed(stream)) {
      yield {
        token: chunk.token,
        provider: chunk.provider,
        model: chunk.model,
        finishReason: chunk.finishReason,
        usage: chunk.usage && toUsage(chunk.usage),
      }
    }
  }
}
