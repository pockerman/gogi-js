import { status } from '@grpc/grpc-js'
import { afterEach, describe, expect, it } from 'vitest'
import { Gogi } from '../src'
import { HealthCheckResponse_ServingStatus, HealthService } from '../src/generated/grpc/health/v1/health'
import { FakeGateway, fail } from './server'

describe('health', () => {
  let gateway: FakeGateway
  afterEach(() => gateway?.stop())

  it('reports the gateway and every service', async () => {
    gateway = new FakeGateway().add(HealthService, {
      check: ({ request }: { request: { service: string } }, callback: (...args: unknown[]) => void) => {
        if (request.service === 'workflows') return callback(fail(status.NOT_FOUND, 'unknown service'))
        const serving = request.service === 'llms' ? 'NOT_SERVING' : 'SERVING'
        callback(null, { status: HealthCheckResponse_ServingStatus[serving] })
      },
    })
    const gogi = await gateway.start()

    const health = await gogi.health.status()

    expect(health.reachable).toBe(true)
    expect(health.services.gateway).toBe('SERVING')
    expect(health.services.llms).toBe('NOT_SERVING')
    expect(health.services.workflows).toBe('SERVICE_UNKNOWN')
    expect(health.services.documents).toBe('SERVING')
    expect(new Set(gateway.routes)).toEqual(new Set(['gateway']))
  })

  it('says why the gateway cannot be reached, without throwing', async () => {
    const gogi = new Gogi({ gatewayUrl: '127.0.0.1:1', maxAttempts: 1 })

    const health = await gogi.health.status()

    expect(health.reachable).toBe(false)
    expect(health.error).toMatch(/^UNAVAILABLE/)
  })
})
