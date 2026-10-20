import type { ServiceError } from '@grpc/grpc-js'
import {
  DocumentServerClient,
  type DocumentMetadata,
  type DocumentSection as ProtoSection,
  type IngestDocumentJobResponse,
  type IngestDocumentRequest,
} from '../generated/gogi/v1/data/document_service'
import { promised, streamed, toGogiError, type Connection } from '../connection'
import { GogiError } from '../errors'

const SERVICE = 'documents'
/** each part of an upload stays well under gRPC's 4 MB message limit */
export const UPLOAD_CHUNK_BYTES = 1024 * 1024

export type JobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

export type DocumentInfo = {
  documentId: string
  indexName: string
  filename: string
  contentType: string
  /** the metadata it was ingested with; each of its chunks has it too */
  metadata: Record<string, string>
  /** the status of its ingestion */
  status: JobStatus | ''
  /** the job that ingested its current content; changes when the content is replaced */
  jobId: string
  sizeBytes: number
  /** the models that have embedded it: a search with one of them can find it */
  embeddingModels: string[]
  /** its chunks, of every model */
  chunkCount: number
  pageCount: number
  wordCount: number
  createdAt?: Date
}

export type IngestRequest = {
  indexName: string
  filename: string
  content: Uint8Array
  contentType: string
  metadata?: Record<string, string>
  /** chosen by the platform if not given */
  documentId?: string
  /**
   * the models that embed its chunks, each into a collection of its own, e.g. ['bge-small-en-v1.5']; with none the
   * document is only stored, e.g. a video, and can be ingested later with ingestStored
   */
  embeddingModels?: string[]
  chunkStrategy?: string
  batchSize?: number
  /** replace the content of the existing document of documentId, e.g. after it was edited */
  replace?: boolean
}

export type IngestStoredRequest = {
  indexName: string
  documentId: string
  /** one or more */
  embeddingModels: string[]
  chunkStrategy?: string
  batchSize?: number
}

export type IngestJob = {
  jobId: string
  indexName: string
  documentId: string
  filename: string
  status: JobStatus
  progress: number
  errorMessage: string
}

export type SearchRequest = {
  indexName: string
  query: string
  topK?: number
  /** one of the models the documents were ingested with; only what it embedded is searched */
  embeddingModel: string
  documentIds?: string[]
  /** only chunks whose metadata has all of these keys and values */
  metadataFilter?: Record<string, string>
}

export type Chunk = {
  chunkId: string
  documentId: string
  indexName: string
  content: string
  score: number
  metadata: Record<string, string>
}

export type DocumentSection = {
  /** 1-based, in the order of the document */
  position: number
  /** empty for text before a document's first heading */
  title: string
  /** 1 for a chapter, 2 for a heading within it, and so on */
  level: number
  pageStart?: number
  pageEnd?: number
}

export type SectionText = { section: DocumentSection; content: string }

function toDocument(document: DocumentMetadata): DocumentInfo {
  return {
    documentId: document.documentId,
    indexName: document.indexName,
    filename: document.filename,
    contentType: document.contentType,
    metadata: { ...document.metadata },
    status: document.status as JobStatus | '',
    jobId: document.jobId,
    sizeBytes: document.sizeBytes,
    embeddingModels: [...document.embeddingModels],
    chunkCount: document.chunkCount,
    pageCount: document.pageCount,
    wordCount: document.wordCount,
    createdAt: document.createdAt ? new Date(document.createdAt) : undefined,
  }
}

function toJob(job: IngestDocumentJobResponse): IngestJob {
  return { ...job, status: job.status as JobStatus }
}

function toSection(section: ProtoSection): DocumentSection {
  return {
    position: section.position,
    title: section.title,
    level: section.level,
    pageStart: section.pageStart || undefined,
    pageEnd: section.pageEnd || undefined,
  }
}

/** Documents: ingesting them into an index, finding, reading, downloading and deleting them, and search. */
export class DocumentsClient {
  private readonly stub: DocumentServerClient

  constructor(private readonly connection: Connection) {
    this.stub = new DocumentServerClient(connection.gatewayUrl, connection.credentials)
  }

  /**
   * Uploads a document to an index and ingests it with the embedding models the request names: the platform
   * stores it and, in the background, chunks it for each model and embeds the chunks. With no models it is only
   * stored. A model gogi neither provides nor has registered for the application is refused. The content is streamed in parts, so documents larger than a gRPC message can be ingested, up to the
   * platform's upload limit. Follow the returned job with getIngestJob or waitForIngestion.
   */
  async ingest(request: IngestRequest): Promise<IngestJob> {
    const info: IngestDocumentRequest = {
      indexName: request.indexName,
      filename: request.filename,
      content: Buffer.alloc(0),
      contentType: request.contentType,
      metadata: request.metadata ?? {},
      documentId: request.documentId ?? '',
      chunkStrategy: request.chunkStrategy ?? '',
      embeddingModels: request.embeddingModels ?? [],
      batchSize: request.batchSize ?? 0,
      replace: request.replace ?? false,
    }
    const content = Buffer.from(request.content)
    const job = await new Promise<IngestDocumentJobResponse>((resolve, reject) => {
      const upload = this.stub.uploadDocument(
        this.connection.metadata(SERVICE),
        this.connection.options(),
        (error: ServiceError | null, response: IngestDocumentJobResponse) => (error ? reject(error) : resolve(response)),
      )
      upload.write({ info })
      for (let start = 0; start < content.length; start += UPLOAD_CHUNK_BYTES) {
        upload.write({ chunk: content.subarray(start, start + UPLOAD_CHUNK_BYTES) })
      }
      upload.end()
    }).catch((error) => {
      throw toGogiError(error)
    })
    return toJob(job)
  }

  /**
   * Chunks a document the index already has and embeds it with the models, e.g. one stored without models, or one to
   * embed with another model too. Ingesting again with a model replaces what that model embedded of it; a running
   * ingestion of the document is stopped.
   */
  async ingestStored(request: IngestStoredRequest): Promise<IngestJob> {
    const ingest = promised(this.stub.ingestStoredDocument, this.stub)
    const job = await this.connection.unary(SERVICE, (m, o) =>
      ingest(
        {
          indexName: request.indexName,
          documentId: request.documentId,
          embeddingModels: request.embeddingModels,
          chunkStrategy: request.chunkStrategy ?? '',
          batchSize: request.batchSize ?? 0,
        },
        m,
        o,
      ),
    )
    return toJob(job)
  }

  async getIngestJob(jobId: string): Promise<IngestJob> {
    const get = promised(this.stub.getDocumentIngestJob, this.stub)
    return toJob(await this.connection.unary(SERVICE, (m, o) => get({ jobId }, m, o)))
  }

  /** Polls the job until it has completed, failed or been cancelled. */
  async waitForIngestion(jobId: string, { intervalMs = 1000, timeoutMs = 10 * 60_000 } = {}): Promise<IngestJob> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const job = await this.getIngestJob(jobId)
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) return job
      if (Date.now() > deadline) throw new GogiError('DEADLINE_EXCEEDED', `job ${jobId} is still ${job.status}`)
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  /** The documents of the index whose metadata has every key and value of metadataFilter. */
  async list(indexName: string, metadataFilter: Record<string, string> = {}): Promise<DocumentInfo[]> {
    const list = promised(this.stub.listDocuments, this.stub)
    const response = await this.connection.unary(SERVICE, (m, o) => list({ indexName, metadataFilter }, m, o))
    return response.documents.map(toDocument)
  }

  /** The document, or null if the index has none of the id. */
  async get(indexName: string, documentId: string): Promise<DocumentInfo | null> {
    const get = promised(this.stub.getDocument, this.stub)
    try {
      const response = await this.connection.unary(SERVICE, (m, o) => get({ indexName, documentId }, m, o))
      return response.document ? toDocument(response.document) : null
    } catch (error) {
      if (error instanceof GogiError && error.code === 'NOT_FOUND') return null
      throw error
    }
  }

  /** Deletes the document with its chunks and file; returns whether there was one. */
  async delete(indexName: string, documentId: string): Promise<boolean> {
    const remove = promised(this.stub.deleteDocument, this.stub)
    try {
      await this.connection.unary(SERVICE, (m, o) => remove({ indexName, documentId }, m, o))
      return true
    } catch (error) {
      if (error instanceof GogiError && error.code === 'NOT_FOUND') return false
      throw error
    }
  }

  /** The chunks most similar to the query, of the documents the request's embedding model embedded. */
  async search(request: SearchRequest): Promise<Chunk[]> {
    const search = promised(this.stub.searchDocuments, this.stub)
    const response = await this.connection.unary(SERVICE, (m, o) =>
      search(
        {
          indexName: request.indexName,
          query: request.query,
          topK: request.topK ?? 5,
          embeddingModel: request.embeddingModel,
          documentIds: request.documentIds ?? [],
          metadataFilter: request.metadataFilter ?? {},
        },
        m,
        o,
      ),
    )
    return response.chunks.map((chunk) => ({ ...chunk, metadata: { ...chunk.metadata } }))
  }

  /** The document's sections in order; a document has none until its ingestion has completed. */
  async listSections(indexName: string, documentId: string): Promise<DocumentSection[]> {
    const list = promised(this.stub.listDocumentSections, this.stub)
    const response = await this.connection.unary(SERVICE, (m, o) => list({ indexName, documentId }, m, o))
    return response.sections.map(toSection)
  }

  /** The text of the section at the position, followed by its subsections' if includeSubsections. */
  async getSection(indexName: string, documentId: string, position: number, includeSubsections = true): Promise<SectionText[]> {
    const get = promised(this.stub.getDocumentSection, this.stub)
    const response = await this.connection.unary(SERVICE, (m, o) =>
      get({ indexName, documentId, position, includeSubsections }, m, o),
    )
    return response.sections.map((part) => ({ section: toSection(part.section!), content: part.content }))
  }

  /** The document and its file: whole, or length bytes from offset (to the end if length is 0). */
  async download(
    indexName: string,
    documentId: string,
    { offset = 0, length = 0 } = {},
  ): Promise<{ document: DocumentInfo; content: Buffer }> {
    const stream = this.stub.downloadDocument(
      { indexName, documentId, offset, length },
      this.connection.metadata(SERVICE),
      this.connection.options(),
    )
    let document: DocumentInfo | undefined
    const parts: Buffer[] = []
    for await (const message of streamed(stream)) {
      if (message.document) document = toDocument(message.document)
      else if (message.chunk) parts.push(message.chunk)
    }
    if (!document) throw new GogiError('INTERNAL', `the download of ${documentId} did not say what it is`)
    return { document, content: Buffer.concat(parts) }
  }
}
