import { status, type ServerWritableStream, type ServerReadableStream } from '@grpc/grpc-js'
import { afterEach, describe, expect, it } from 'vitest'
import { UPLOAD_CHUNK_BYTES } from '../src'
import {
  DocumentServerService,
  type DownloadDocumentResponse,
  type UploadDocumentRequest,
} from '../src/generated/gogi/v1/data/document_service'
import { FakeGateway, fail } from './server'

const document = {
  documentId: 'fem-notes',
  indexName: 'maria--aeronautics',
  filename: 'fem-notes.md',
  chunkCount: 3,
  pageCount: 0,
  wordCount: 120,
  metadata: { subject: 'numerical-methods' },
  contentType: 'text/markdown',
  status: 'COMPLETED',
  jobId: 'job-1',
  createdAt: '2026-10-17T10:00:00Z',
  sizeBytes: 42,
  embeddingModels: ['bge-small-en-v1.5'],
}

describe('documents', () => {
  let gateway: FakeGateway
  afterEach(() => gateway?.stop())

  it('ingests a document in parts under the message limit: its details, then its content', async () => {
    const received: UploadDocumentRequest[] = []
    gateway = new FakeGateway().add(DocumentServerService, {
      uploadDocument: (call: ServerReadableStream<UploadDocumentRequest, unknown>, callback: (...a: unknown[]) => void) => {
        call.on('data', (part: UploadDocumentRequest) => received.push(part))
        call.on('end', () =>
          callback(null, { jobId: 'job-1', indexName: 'maria--aeronautics', documentId: 'fem-notes', filename: 'fem-notes.md', status: 'PENDING', progress: 0, errorMessage: '' }),
        )
      },
    })
    const gogi = await gateway.start()
    const content = Buffer.alloc(2 * UPLOAD_CHUNK_BYTES + 10, 'x')

    const job = await gogi.documents.ingest({
      indexName: 'maria--aeronautics',
      filename: 'fem-notes.md',
      content,
      contentType: 'text/markdown',
      metadata: { subject: 'numerical-methods' },
      embeddingModels: ['bge-small-en-v1.5', 'all-MiniLM-L6-v2'],
    })

    expect(job).toMatchObject({ jobId: 'job-1', status: 'PENDING' })
    expect(received[0].info).toMatchObject({
      indexName: 'maria--aeronautics',
      filename: 'fem-notes.md',
      metadata: { subject: 'numerical-methods' },
      embeddingModels: ['bge-small-en-v1.5', 'all-MiniLM-L6-v2'],
    })
    const chunks = received.slice(1).map((part) => part.chunk!)
    expect(chunks.every((chunk) => chunk.length <= UPLOAD_CHUNK_BYTES)).toBe(true)
    expect(Buffer.concat(chunks).equals(content)).toBe(true)
    expect(gateway.routes).toEqual(['documents'])
  })

  it('lists documents by their metadata', async () => {
    let filter: unknown
    gateway = new FakeGateway().add(DocumentServerService, {
      listDocuments: (call: { request: { metadataFilter: unknown } }, callback: (...a: unknown[]) => void) => {
        filter = call.request.metadataFilter
        callback(null, { documents: [document] })
      },
    })
    const gogi = await gateway.start()

    const [found] = await gogi.documents.list('maria--aeronautics', { subject: 'numerical-methods' })

    expect(filter).toEqual({ subject: 'numerical-methods' })
    expect(found).toMatchObject({ documentId: 'fem-notes', status: 'COMPLETED', sizeBytes: 42, embeddingModels: ['bge-small-en-v1.5'] })
    expect(found.createdAt).toEqual(new Date('2026-10-17T10:00:00Z'))
  })

  it('downloads a document, joining its parts', async () => {
    let range: unknown
    gateway = new FakeGateway().add(DocumentServerService, {
      downloadDocument: (call: ServerWritableStream<{ offset: number; length: number }, DownloadDocumentResponse>) => {
        range = { offset: call.request.offset, length: call.request.length }
        call.write({ document })
        call.write({ chunk: Buffer.from('# 1 Intro') })
        call.write({ chunk: Buffer.from('duction\n') })
        call.end()
      },
    })
    const gogi = await gateway.start()

    const downloaded = await gogi.documents.download('maria--aeronautics', 'fem-notes', { offset: 0, length: 0 })

    expect(downloaded.document.filename).toBe('fem-notes.md')
    expect(downloaded.content.toString()).toBe('# 1 Introduction\n')
    expect(range).toEqual({ offset: 0, length: 0 })
  })

  it('reads a section with its subsections', async () => {
    gateway = new FakeGateway().add(DocumentServerService, {
      getDocumentSection: (_: unknown, callback: (...a: unknown[]) => void) =>
        callback(null, {
          sections: [
            { section: { position: 2, title: '2 Shape functions', level: 1, pageStart: 0, pageEnd: 0 }, content: 'shape' },
            { section: { position: 3, title: '2.1 Linear', level: 2, pageStart: 0, pageEnd: 0 }, content: 'linear' },
          ],
        }),
    })
    const gogi = await gateway.start()

    const parts = await gogi.documents.getSection('maria--aeronautics', 'fem-notes', 2)

    expect(parts.map((p) => [p.section.title, p.content])).toEqual([
      ['2 Shape functions', 'shape'],
      ['2.1 Linear', 'linear'],
    ])
    expect(parts[0].section.pageStart).toBeUndefined()
  })

  it('says whether there was a document to delete', async () => {
    gateway = new FakeGateway().add(DocumentServerService, {
      deleteDocument: (_: unknown, callback: (...a: unknown[]) => void) => callback(fail(status.NOT_FOUND, 'no document')),
    })
    const gogi = await gateway.start()

    expect(await gogi.documents.delete('maria--aeronautics', 'missing')).toBe(false)
  })

  it('ingests a stored document later, with the models named', async () => {
    let request: unknown
    gateway = new FakeGateway().add(DocumentServerService, {
      ingestStoredDocument: (call: { request: unknown }, callback: (...a: unknown[]) => void) => {
        request = call.request
        callback(null, { jobId: 'job-2', indexName: 'maria--aeronautics', documentId: 'lecture-3', filename: '', status: 'PENDING', progress: 0, errorMessage: '' })
      },
    })
    const gogi = await gateway.start()

    const job = await gogi.documents.ingestStored({ indexName: 'maria--aeronautics', documentId: 'lecture-3', embeddingModels: ['all-MiniLM-L6-v2'] })

    expect(job).toMatchObject({ jobId: 'job-2', status: 'PENDING' })
    expect(request).toMatchObject({ indexName: 'maria--aeronautics', documentId: 'lecture-3', embeddingModels: ['all-MiniLM-L6-v2'] })
    expect(gateway.routes).toEqual(['documents'])
  })

  it('searches with the embedding model named', async () => {
    let request: unknown
    gateway = new FakeGateway().add(DocumentServerService, {
      searchDocuments: (call: { request: unknown }, callback: (...a: unknown[]) => void) => {
        request = call.request
        callback(null, { chunks: [{ chunkId: 'c-1', documentId: 'fem-notes', indexName: 'maria--aeronautics', content: 'shape', score: 0.9, metadata: {} }] })
      },
    })
    const gogi = await gateway.start()

    const chunks = await gogi.documents.search({ indexName: 'maria--aeronautics', query: 'shape functions', embeddingModel: 'bge-small-en-v1.5' })

    expect(chunks.map((chunk) => chunk.chunkId)).toEqual(['c-1'])
    expect(request).toMatchObject({ query: 'shape functions', embeddingModel: 'bge-small-en-v1.5', topK: 5 })
  })
})
