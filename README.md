# gogi-js

TypeScript SDK for the [gogi](https://github.com/pockerman/gogi) AI platform, for Node.js applications. It talks
gRPC to gogi's gateway, using clients generated from [gogi-protos](https://github.com/pockerman/gogi-protos), with
a promise-based API, retries while the platform is briefly unavailable, and errors you can catch.

## Install

```bash
npm install github:pockerman/gogi-js
```

Building needs `protoc` on the `PATH`: the clients are generated from the protos when the package is built.

## Use

```ts
import { Gogi, GogiError } from 'gogi-js'

const gogi = new Gogi({ gatewayUrl: 'localhost:50051' })

// the platform's health
const health = await gogi.health.status()

// an index, and a document ingested into it
await gogi.indexes.create('elena--surveys', 'elena')
const job = await gogi.documents.ingest({
  indexName: 'elena--surveys',
  filename: 'hull-guidance.md',
  content: await fs.readFile('hull-guidance.md'),
  contentType: 'text/markdown',
  metadata: { topic: 'hull' },
  chunkStrategy: 'fixed',
  embeddingsModel: 'clip',
  embeddingsClient: 'sentence-transformer',
})
await gogi.documents.waitForIngestion(job.jobId)

// read it by section, search it, download it
const sections = await gogi.documents.listSections('elena--surveys', job.documentId)
const chunks = await gogi.documents.search({
  indexName: 'elena--surveys',
  query: 'corrosion limits',
  embeddingsModel: 'clip',
  embeddingsClient: 'sentence-transformer',
})

// run a model, or stream its answer, or ask for JSON
const answer = await gogi.models.run({
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  messages: [{ role: 'user', content: 'What causes pitting corrosion?' }],
})
for await (const chunk of gogi.models.runStream({ provider: 'anthropic', model: 'claude-sonnet-5-5', messages })) {
  process.stdout.write(chunk.token)
}

try {
  await gogi.indexes.removeMember('elena--surveys', 'elena')
} catch (error) {
  if (error instanceof GogiError) console.log(error.code, error.details) // e.g. FAILED_PRECONDITION
}
```

| Client | What it does |
|---|---|
| `gogi.health` | The gateway's and every service's health |
| `gogi.indexes` | Indexes and their members (owners and readers) |
| `gogi.documents` | Ingesting (streamed, so large files work), listing by metadata, sections, download (whole or a byte range), search, delete |
| `gogi.models` | Running a model, streaming its answer, JSON answers matching a schema |

### Options

| Option | Default |
|---|---|
| `gatewayUrl` | `GOGI_GATEWAY_URL`, then `localhost:50051` |
| `insecure` | plaintext for `localhost` and when `GOGI_GATEWAY_INSECURE=1`, else TLS |
| `timeoutMs` | none |
| `maxAttempts` | 3, for calls failing with `UNAVAILABLE`, `DEADLINE_EXCEEDED` or `RESOURCE_EXHAUSTED` |

## Develop

```bash
git submodule update --init   # the protos, in vendor/protos/gogi
npm install                   # builds too, generating src/generated
npm test                      # against an in-process fake gateway
npm run typecheck && npm run lint
```

To pick up proto changes, move the submodule to the gogi-protos commit you need and run `npm run build`.
