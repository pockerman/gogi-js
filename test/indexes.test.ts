import { status } from '@grpc/grpc-js'
import { afterEach, describe, expect, it } from 'vitest'
import { IndexMemberRole, IndexServiceService } from '../src/generated/gogi/v1/data/index_service'
import { FakeGateway, fail } from './server'

const aeronautics = {
  id: 'id-1',
  indexName: 'maria--aeronautics',
  owner: 'maria',
  createdAt: '2026-10-17T10:00:00Z',
  lastUpdatedAt: '2026-10-17T10:00:00Z',
  members: [
    { user: 'maria', role: IndexMemberRole.INDEX_MEMBER_ROLE_OWNER },
    { user: 'tom', role: IndexMemberRole.INDEX_MEMBER_ROLE_READER },
  ],
}

describe('indexes', () => {
  let gateway: FakeGateway
  afterEach(() => gateway?.stop())

  it('creates an index, routed to the indexes service', async () => {
    let created: unknown
    gateway = new FakeGateway().add(IndexServiceService, {
      createIndex: ({ request }: { request: unknown }, callback: (...a: unknown[]) => void) => {
        created = request
        callback(null, aeronautics)
      },
    })
    const gogi = await gateway.start()

    const index = await gogi.indexes.create('maria--aeronautics', 'maria')

    expect(created).toEqual({ indexName: 'maria--aeronautics', owner: 'maria' })
    expect(index.members).toEqual({ maria: 'owner', tom: 'reader' })
    expect(gateway.routes).toEqual(['indexes'])
  })

  it('gets null for an index that does not exist', async () => {
    gateway = new FakeGateway().add(IndexServiceService, {
      getIndexByName: (_: unknown, callback: (...a: unknown[]) => void) => callback(fail(status.NOT_FOUND, 'no index')),
    })
    const gogi = await gateway.start()

    expect(await gogi.indexes.get('missing')).toBeNull()
  })

  it('sets a member with a role', async () => {
    let request: { role?: number } = {}
    gateway = new FakeGateway().add(IndexServiceService, {
      setIndexMember: (call: { request: { role: number } }, callback: (...a: unknown[]) => void) => {
        request = call.request
        callback(null, aeronautics)
      },
    })
    const gogi = await gateway.start()

    await gogi.indexes.setMember('maria--aeronautics', 'tom', 'reader')

    expect(request.role).toBe(IndexMemberRole.INDEX_MEMBER_ROLE_READER)
  })
})
