import { afterEach, describe, expect, it, vi } from 'vitest'
import { CredentialServerService } from '../src/generated/gogi/v1/credential_service'
import { IndexServiceService } from '../src/generated/gogi/v1/data/index_service'
import { Gogi } from '../src'
import { FakeGateway } from './server'

type Call = { request: unknown; metadata: { get(key: string): unknown[] } }

describe('applications and their credentials', () => {
  let gateway: FakeGateway
  afterEach(() => {
    gateway?.stop()
    vi.unstubAllEnvs()
  })

  it('stores a credential, routed to the llms service with the application key', async () => {
    let stored: Call | undefined
    gateway = new FakeGateway().add(CredentialServerService, {
      storeCredential: (call: Call, callback: (...a: unknown[]) => void) => {
        stored = call
        callback(null, { credential: { name: 'anthropic', createdAt: '2026-10-18T10:00:00Z', updatedAt: '2026-10-18T11:00:00Z' } })
      },
    })
    const gogi = await gateway.start({ apiKey: 'gogi_key' })

    const credential = await gogi.credentials.store('anthropic', 'sk-ant-secret')

    expect(stored?.request).toEqual({ name: 'anthropic', value: 'sk-ant-secret' })
    expect(stored?.metadata.get('authorization')).toEqual(['Bearer gogi_key'])
    expect(credential).toEqual({ name: 'anthropic', createdAt: '2026-10-18T10:00:00Z', updatedAt: '2026-10-18T11:00:00Z' })
    expect(gateway.routes).toEqual(['llms'])
  })

  it('lists the credentials without their values', async () => {
    gateway = new FakeGateway().add(CredentialServerService, {
      listCredentials: (_: Call, callback: (...a: unknown[]) => void) =>
        callback(null, { credentials: [{ name: 'anthropic', createdAt: '', updatedAt: '' }] }),
    })
    const gogi = await gateway.start()

    expect(await gogi.credentials.list()).toEqual([{ name: 'anthropic', createdAt: '', updatedAt: '' }])
  })

  it('sends the key of GOGI_API_KEY with every call, and none without one', async () => {
    const authorizations: unknown[][] = []
    gateway = new FakeGateway().add(IndexServiceService, {
      listIndexes: (call: Call, callback: (...a: unknown[]) => void) => {
        authorizations.push(call.metadata.get('authorization'))
        callback(null, { indexes: [] })
      },
    })
    const withoutKey = await gateway.start()
    await withoutKey.indexes.listForMember('maria')

    vi.stubEnv('GOGI_API_KEY', 'gogi_from_env')
    const withKey = new Gogi({ gatewayUrl: withoutKey.connection.gatewayUrl })
    await withKey.indexes.listForMember('maria')

    expect(authorizations).toEqual([[], ['Bearer gogi_from_env']])
  })
})
