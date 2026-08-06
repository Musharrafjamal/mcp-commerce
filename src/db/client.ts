import { MongoClient, type Db } from 'mongodb'

export const DB_NAME = process.env.MONGODB_DB?.trim() || 'opscopilot'

// Cached on globalThis in BOTH dev and production. Not just a dev-reload guard:
// Next can instantiate a module more than once across bundles, and every extra
// MongoClient is another connection against an Atlas tier that caps them.
declare global {
  // eslint-disable-next-line no-var
  var __opsCopilotMongo: Promise<MongoClient> | undefined
}

function connect(): Promise<MongoClient> {
  // trim(): env vars set through a CLI pipe pick up a trailing newline, which turns a
  // valid connection string into an unresolvable host.
  const uri = process.env.MONGODB_URI?.trim()
  if (!uri) throw new Error('MONGODB_URI is not set')

  return new MongoClient(uri, {
    maxPoolSize: 10,
    minPoolSize: 0,
    maxIdleTimeMS: 30_000,
    // A free-tier cluster auto-pauses. Fail fast with a legible error instead of
    // hanging for 30s inside the reviewer's MCP client, which reads as a broken server.
    serverSelectionTimeoutMS: 5_000,
    retryWrites: true,
    w: 'majority',
  }).connect()
}

export const clientPromise: Promise<MongoClient> = (globalThis.__opsCopilotMongo ??= connect())

export async function getDb(): Promise<Db> {
  return (await clientPromise).db(DB_NAME)
}
