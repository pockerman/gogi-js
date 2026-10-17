// Generates the TypeScript messages and gRPC clients of the gogi protos (vendor/protos/gogi, a submodule of
// gogi-protos) and of grpc.health.v1 into src/generated, with ts-proto. Needs protoc on PATH.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const out = join(root, 'src/generated')
const roots = [join(root, 'vendor/protos/gogi'), join(root, 'protos')]

function protos(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return protos(path)
    return name.endsWith('.proto') ? [path] : []
  })
}

const files = [...protos(join(roots[0], 'gogi')), ...protos(join(roots[1], 'grpc'))]
if (files.length === 0) {
  console.error('no protos found: run git submodule update --init')
  process.exit(1)
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
execFileSync(
  'protoc',
  [
    `--plugin=protoc-gen-ts_proto=${join(root, 'node_modules/.bin/protoc-gen-ts_proto')}`,
    `--ts_proto_out=${out}`,
    '--ts_proto_opt=outputServices=grpc-js,esModuleInterop=true,env=node,forceLong=number,useExactTypes=false',
    ...roots.map((dir) => `--proto_path=${dir}`),
    ...files,
  ],
  { stdio: 'inherit' },
)
console.log(`generated ${files.length} protos into src/generated`)
