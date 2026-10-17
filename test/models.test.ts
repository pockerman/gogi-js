import { status, type ServerWritableStream } from '@grpc/grpc-js'
import { afterEach, describe, expect, it } from 'vitest'
import { GogiError } from '../src'
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
