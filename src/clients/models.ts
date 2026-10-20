import type { ContentPart as ProtoPart } from '../generated/gogi/v1/llm_message'
import { LLMModelServerClient, type LLMRunRequest, type TokenUsage } from '../generated/gogi/v1/llm_model_service'
import { promised, streamed, type Connection } from '../connection'

const SERVICE = 'llms'

export type Role = 'system' | 'user' | 'assistant' | 'tool'

/**
 * An image for a model: its bytes, or a document of the platform's (e.g. a photo uploaded without embedding
 * models), which the platform reads itself, so a large image needn't travel in the request. The media type (image/jpeg,
 * image/png, image/gif or image/webp) is worked out from the image if it isn't given.
 */
export type Image =
  | { data: Uint8Array; mediaType?: string }
  | { indexName: string; documentId: string; mediaType?: string }

/** A part of a user message's content: text or an image. */
export type ContentPart = { text: string } | { image: Image }

export type Message = {
  role: Role
  content: string
  /** a user message's text and images, in order, after its content */
  parts?: ContentPart[]
  /** for a tool message: the call it answers */
  toolCallId?: string
  name?: string
}

/** A user message asking about images, e.g. "What defects do you see?" and a photo. */
export function userWithImages(content: string, images: Image[]): Message {
  return { role: 'user', content, parts: images.map((image) => ({ image })) }
}

function toPart(part: ContentPart): ProtoPart {
  if ('text' in part) return { text: part.text }
  const image = part.image
  const mediaType = image.mediaType ?? ''
  if ('data' in image) return { image: { data: Buffer.from(image.data), mediaType } }
  return { image: { document: { indexName: image.indexName, documentId: image.documentId }, mediaType } }
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
      parts: (message.parts ?? []).map(toPart),
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
