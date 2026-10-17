import { status, type ServerWritableStream } from '@grpc/grpc-js'
import { afterEach, describe, expect, it } from 'vitest'
import { GogiError, userWithImages } from '../src'
import { LLMModelServerService, type LLMRunRequest } from '../src/generated/gogi/v1/llm_model_service'
import { FakeGateway, fail } from './server'

const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 }

describe('models', () => {
  let gateway: FakeGateway
  afterEach(() => gateway?.stop())

  it('runs a model', async () => {
    let request: LLMRunRequest | undefined
    gateway = new FakeGateway().add(LLMModelServerService, {
      run: (call: { request: LLMRunRequest }, callback: (...a: unknown[]) => void) => {
        request = call.request
        callback(null, { content: 'Corrosion.', model: 'claude-sonnet-5-5', provider: 'anthropic', usage, toolCalls: [], finishReason: 'stop' })
      },
    })
    const gogi = await gateway.start()

    const response = await gogi.models.run({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      messages: [
        { role: 'system', content: 'You are a marine surveyor.' },
        { role: 'user', content: 'What is this?' },
      ],
      maxTokens: 200,
    })

    expect(response).toEqual({ content: 'Corrosion.', provider: 'anthropic', model: 'claude-sonnet-5-5', finishReason: 'stop', usage })
    expect(request?.config).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5', maxTokens: 200 })
    expect(request?.messages.map((m) => [m.role, m.content])).toEqual([
      ['system', 'You are a marine surveyor.'],
      ['user', 'What is this?'],
    ])
    expect(gateway.routes).toEqual(['llms'])
  })

  it('asks for a JSON answer matching a schema, and parses it', async () => {
    let format: unknown
    gateway = new FakeGateway().add(LLMModelServerService, {
      run: (call: { request: LLMRunRequest }, callback: (...a: unknown[]) => void) => {
        format = call.request.responseFormat
        callback(null, { content: '{"defects":["corrosion"]}', model: 'm', provider: 'p', usage, toolCalls: [], finishReason: 'stop' })
      },
    })
    const gogi = await gateway.start()
    const schema = { type: 'object', properties: { defects: { type: 'array', items: { type: 'string' } } } }

    const answer = await gogi.models.runJson<{ defects: string[] }>({
      provider: 'p',
      model: 'm',
      messages: [{ role: 'user', content: 'List the defects.' }],
      responseFormat: { type: 'json_schema', schema },
    })

    expect(answer.defects).toEqual(['corrosion'])
    expect(format).toEqual({ type: 'json_schema', schemaJson: JSON.stringify(schema) })
  })

  it('streams the answer', async () => {
    gateway = new FakeGateway().add(LLMModelServerService, {
      runStream: (call: ServerWritableStream<unknown, unknown>) => {
        call.write({ token: 'Corr', model: 'm', provider: 'p', toolCalls: [] })
        call.write({ token: 'osion.', model: 'm', provider: 'p', toolCalls: [], finishReason: 'stop', usage })
        call.end()
      },
    })
    const gogi = await gateway.start()

    const chunks = []
    for await (const chunk of gogi.models.runStream({ provider: 'p', model: 'm', messages: [{ role: 'user', content: 'Hi' }] })) {
      chunks.push(chunk)
    }

    expect(chunks.map((c) => c.token).join('')).toBe('Corrosion.')
    expect(chunks.at(-1)).toMatchObject({ finishReason: 'stop', usage })
  })

  it('turns the platform refusing a call into a GogiError', async () => {
    gateway = new FakeGateway().add(LLMModelServerService, {
      run: (_: unknown, callback: (...a: unknown[]) => void) => callback(fail(status.INVALID_ARGUMENT, 'unknown provider')),
    })
    const gogi = await gateway.start()

    const error = await gogi.models.run({ provider: 'x', model: 'm', messages: [] }).catch((e) => e)

    expect(error).toBeInstanceOf(GogiError)
    expect(error).toMatchObject({ code: 'INVALID_ARGUMENT', details: 'unknown provider' })
  })
})

describe('images', () => {
  let gateway: FakeGateway
  afterEach(() => gateway?.stop())

  it('sends images with a message: their bytes, or a document of the platform', async () => {
    let request: LLMRunRequest | undefined
    gateway = new FakeGateway().add(LLMModelServerService, {
      run: (call: { request: LLMRunRequest }, callback: (...a: unknown[]) => void) => {
        request = call.request
        callback(null, { content: 'Corrosion.', model: 'm', provider: 'p', usage, toolCalls: [], finishReason: 'stop' })
      },
    })
    const gogi = await gateway.start()
    const photo = Buffer.from([0x89, 0x50, 0x4e, 0x47])

    await gogi.models.run({
      provider: 'ollama',
      model: 'moondream:latest',
      messages: [
        userWithImages('What defects do you see?', [
          { data: photo, mediaType: 'image/png' },
          { indexName: 'elena--surveys', documentId: 'hull-port-bow' },
        ]),
      ],
    })

    const message = request!.messages[0]
    expect(message.content).toBe('What defects do you see?')
    expect(message.parts[0].image?.data?.equals(photo)).toBe(true)
    expect(message.parts[0].image?.mediaType).toBe('image/png')
    expect(message.parts[1].image?.document).toEqual({ indexName: 'elena--surveys', documentId: 'hull-port-bow' })
  })
})
