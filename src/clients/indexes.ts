import {
  IndexMemberRole,
  IndexServiceClient,
  type IndexResponse,
} from '../generated/gogi/v1/data/index_service'
import { promised, type Connection } from '../connection'
import { GogiError } from '../errors'

const SERVICE = 'indexes'

export type MemberRole = 'owner' | 'reader'

export type GogiIndex = {
  id: string
  name: string
  /** the user who created it; one of its owners until they're removed */
  owner: string
  /** everyone with a role on the index, the creator included */
  members: Record<string, MemberRole>
  createdAt: string
  lastUpdatedAt: string
}

const ROLES: Record<number, MemberRole> = {
  [IndexMemberRole.INDEX_MEMBER_ROLE_OWNER]: 'owner',
  [IndexMemberRole.INDEX_MEMBER_ROLE_READER]: 'reader',
}

function toIndex(response: IndexResponse): GogiIndex {
  return {
    id: response.id,
    name: response.indexName,
    owner: response.owner,
    members: Object.fromEntries(response.members.map((m) => [m.user, ROLES[m.role] ?? 'reader'])),
    createdAt: response.createdAt,
    lastUpdatedAt: response.lastUpdatedAt,
  }
}

/** Indexes: named collections of documents, with members who are owners or readers. */
export class IndexesClient {
  private readonly stub: IndexServiceClient

  constructor(private readonly connection: Connection) {
    this.stub = new IndexServiceClient(connection.gatewayUrl, connection.credentials)
  }

  /** Creates the index, with `owner` as its first owner; returns the existing one if it exists. */
  async create(name: string, owner: string): Promise<GogiIndex> {
    const create = promised(this.stub.createIndex, this.stub)
    return toIndex(await this.connection.unary(SERVICE, (m, o) => create({ indexName: name, owner }, m, o)))
  }

  /** The index, or null if there's none of the name. */
  async get(name: string): Promise<GogiIndex | null> {
    const get = promised(this.stub.getIndexByName, this.stub)
    try {
      return toIndex(await this.connection.unary(SERVICE, (m, o) => get({ indexName: name }, m, o)))
    } catch (error) {
      if (error instanceof GogiError && error.code === 'NOT_FOUND') return null
      throw error
    }
  }

  /** The indexes the user created. */
  async listForOwner(owner: string): Promise<GogiIndex[]> {
    return this.list({ ownerName: owner, member: '' })
  }

  /** The indexes the user has any role on. */
  async listForMember(member: string): Promise<GogiIndex[]> {
    return this.list({ ownerName: '', member })
  }

  async setMember(name: string, user: string, role: MemberRole): Promise<GogiIndex> {
    const set = promised(this.stub.setIndexMember, this.stub)
    const value = role === 'owner' ? IndexMemberRole.INDEX_MEMBER_ROLE_OWNER : IndexMemberRole.INDEX_MEMBER_ROLE_READER
    return toIndex(await this.connection.unary(SERVICE, (m, o) => set({ indexName: name, user, role: value }, m, o)))
  }

  /** Removes the user from the index; an index always keeps an owner, so removing the last one fails. */
  async removeMember(name: string, user: string): Promise<GogiIndex> {
    const remove = promised(this.stub.removeIndexMember, this.stub)
    return toIndex(await this.connection.unary(SERVICE, (m, o) => remove({ indexName: name, user }, m, o)))
  }

  /** Deletes the index with its documents; returns whether there was one. */
  async delete(name: string): Promise<boolean> {
    const remove = promised(this.stub.deleteIndexByName, this.stub)
    return (await this.connection.unary(SERVICE, (m, o) => remove({ indexName: name }, m, o))).success
  }

  private async list(request: { ownerName: string; member: string }): Promise<GogiIndex[]> {
    const list = promised(this.stub.listIndexes, this.stub)
    return (await this.connection.unary(SERVICE, (m, o) => list(request, m, o))).indexes.map(toIndex)
  }
}
