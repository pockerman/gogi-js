import { status } from '@grpc/grpc-js'
import { afterEach, describe, expect, it } from 'vitest'
import { IndexServiceService } from '../src/generated/gogi/v1/data/index_service'
import { FakeGateway, fail } from './server'

const index = { id: 'id', indexName: 'i', owner: 'o', createdAt: '', lastUpdatedAt: '', members: [] }

function failingThen(errors: Error[]) {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    handler: (_: unknown, callback: (...a: unknown[]) => void) => {
      const error = errors[calls++]
      return error ? callback(error) : callback(null, index)
    },
  }
}

describe('retries', () => {
  let gateway: FakeGateway
  afterEach(() => gateway?.stop())

  it('retries while the platform is briefly unavailable', async () => {
    const service = failingThen([fail(status.UNAVAILABLE, 'down'), fail(status.UNAVAILABLE, 'down')])
    gateway = new FakeGateway().add(IndexServiceService, { createIndex: service.handler })
    const gogi = await gateway.start({ maxAttempts: 3 })

    await gogi.indexes.create('i', 'o')

    expect(service.calls).toBe(3)
  })

  it('does not retry what the platform refuses', async () => {
    const service = failingThen([fail(status.INVALID_ARGUMENT, 'bad name')])
    gateway = new FakeGateway().add(IndexServiceService, { createIndex: service.handler })
    const gogi = await gateway.start({ maxAttempts: 3 })

    await expect(gogi.indexes.create('i', 'o')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(service.calls).toBe(1)
  })

  it('does not retry a message larger than gRPC allows', async () => {
    const service = failingThen([fail(status.RESOURCE_EXHAUSTED, 'Received message larger than max (5 vs. 4)')])
    gateway = new FakeGateway().add(IndexServiceService, { createIndex: service.handler })
    const gogi = await gateway.start({ maxAttempts: 3 })

    await expect(gogi.indexes.create('i', 'o')).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' })
    expect(service.calls).toBe(1)
  })
})
