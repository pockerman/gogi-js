import { status } from '@grpc/grpc-js'
import { afterEach, describe, expect, it } from 'vitest'
import { LLMModelServerService } from '../src/generated/gogi/v1/llm_model_service'
import { GogiError } from '../src'
import { FakeGateway, fail } from './server'

type Call = { request: unknown; metadata: { get(key: string): unknown[] } }

describe('embedding models', () => {
  let gateway: FakeGateway
  afterEach(() => gateway?.stop())

  it('lists the models the application can use, routed to the llms service', async () => {
    gateway = new FakeGateway().add(LLMModelServerService, {
      listEmbeddingModels: (_: Call, callback: (...a: unknown[]) => void) =>
        callback(null, {
          models: [
            { name: 'bge-small-en-v1.5', dimensions: 384, maxInputTokens: 512, url: '', credentialRef: '', available: true },
            { name: 'text-embedding-3-small', dimensions: 1536, maxInputTokens: 8191, url: '', credentialRef: 'openai', available: false },
          ],
        }),
    })
    const gogi = await gateway.start()

    const models = await gogi.embeddings.list()

    expect(models.map((model) => [model.name, model.available])).toEqual([
      ['bge-small-en-v1.5', true],
      ['text-embedding-3-small', false],
    ])
    expect(gateway.routes).toEqual(['llms'])
  })

  it('registers a model the application hosts', async () => {
    let registered: unknown
    gateway = new FakeGateway().add(LLMModelServerService, {
      registerEmbeddingModel: (call: Call, callback: (...a: unknown[]) => void) => {
        registered = call.request
        callback(null, { name: 'nomic', dimensions: 768, maxInputTokens: 512, url: 'https://models.example.org/v1', credentialRef: 'models-key', available: true })
      },
    })
    const gogi = await gateway.start()

    const model = await gogi.embeddings.register({
      name: 'nomic',
      url: 'https://models.example.org/v1',
      servedName: 'nomic-embed-text',
      credentialRef: 'models-key',
    })

    expect(model).toMatchObject({ name: 'nomic', dimensions: 768 })
    expect(registered).toEqual({
      name: 'nomic',
      url: 'https://models.example.org/v1',
      servedName: 'nomic-embed-text',
      credentialRef: 'models-key',
      maxInputTokens: 0,
    })
  })

  it('embeds texts in their order', async () => {
    gateway = new FakeGateway().add(LLMModelServerService, {
      embed: (call: { request: { inputs: string[] } }, callback: (...a: unknown[]) => void) =>
        callback(null, { model: 'bge-small-en-v1.5', embeddings: call.request.inputs.map((_, i) => ({ values: [i, 0.5] })) }),
    })
    const gogi = await gateway.start()

    expect(await gogi.embeddings.embed('bge-small-en-v1.5', ['wing flutter', 'hull'])).toEqual([
      [0, 0.5],
      [1, 0.5],
    ])
  })

  it('says when there is no such model', async () => {
    gateway = new FakeGateway().add(LLMModelServerService, {
      embed: (_: Call, callback: (...a: unknown[]) => void) => callback(fail(status.NOT_FOUND, 'there is no embedding model "clip"')),
    })
    const gogi = await gateway.start({ maxAttempts: 1 })

    const error = await gogi.embeddings.embed('clip', ['hull']).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(GogiError)
    expect(error).toMatchObject({ code: 'NOT_FOUND' })
  })
})
