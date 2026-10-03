import { providedConnections } from "../connectionProviders"
import { untilCancelled } from "../providerTransport"
import { createProviderClient } from "../providerClient"
import { connected, disconnected } from "../apiEvents"
import { RemoteManager, createClient, createAuthenticatedClient } from "../config"
import { AFsService, Root } from "abapfs"
import { Uri, FileSystemError, workspace } from "vscode"
import { ADTClient } from "abap-adt-api"
import { LogOutPendingDebuggers } from "./debugger"
import { SapSystemValidator } from "../services/sapSystemValidator"
import { LocalFsProvider } from "../fs/LocalFsProvider"
import { log } from "../lib"
export const ADTSCHEME = "adt"
export const ADTURIPATTERN = /\/sap\/bc\/adt\//

const roots = new Map<string, Root>()
const clients = new Map<string, ADTClient>()
const cancellations = new Map<string, AbortController>()
const creations = new Map<string, Promise<void>>()
const revisions = new Map<string, number>()
const removals = new Map<string, Promise<void>>()
export const clientIsConnected = (id: string) => clients.has(id.toLowerCase())

const missing = (connId: string) => {
  return FileSystemError.FileNotFound(`No ABAP server defined for ${connId}`)
}

export const abapUri = (u?: Uri) => u?.scheme === ADTSCHEME && !LocalFsProvider.useLocalStorage(u)

async function create(connId: string, cancellation: AbortController) {
  const revision = revisions.get(connId)
  const provided = providedConnections.get(connId)
  const manager = RemoteManager.get()
  const connection = await manager.byIdAsync(connId)
  if (!connection) throw Error(`Connection not found ${connId}`)

  // 🔐 VALIDATE SYSTEM ACCESS BEFORE CLIENT CREATION
  log(`🔍 Validating SAP system access for connection: ${connId}`)
  const validator = SapSystemValidator.getInstance()
  await validator.validateSystemAccess(
    connection.url,
    connection.sapGui?.server,
    connection.username
  )
  log(`✅ SAP system validation passed for: ${connId}`)

  const authMethod = (connection as any).authMethod || "basic"
  const validAuthMethods = ["basic", "cert", "kerberos", "browser_sso", "oauth_onprem"]
  if (!validAuthMethods.includes(authMethod)) {
    log(`⚠️ Unknown authMethod '${authMethod}' for ${connId} — falling back to basic auth`)
  }
  log.debug(
    `[connect] Creating client for ${connId}: authMethod=${authMethod}, hasOAuth=${!!connection.oauth}, hasPassword=${!!connection.password}`
  )
  let client: ADTClient

  if (provided) {
    cancellation.signal.throwIfAborted()
    client = createProviderClient(provided, cancellation.signal)
    try {
      await untilCancelled(client.login(), cancellation.signal)
      await untilCancelled(client.statelessClone.login(), cancellation.signal)
    } catch {
      if (!cancellation.signal.aborted)
        await boundedCleanup(Promise.allSettled([client.logout(), client.statelessClone.logout()]))
      throw new Error(`Unable to connect to provider connection ${connId}`)
    }
  } else if (authMethod !== "basic" && validAuthMethods.includes(authMethod)) {
    log.debug(`[connect] Using createAuthenticatedClient for ${connId} (${authMethod})`)
    client = await createAuthenticatedClient(connection)
    await client.login()
    log.debug(`[connect] client.login() succeeded for ${connId}`)
    await client.statelessClone.login()
    log.debug(`[connect] statelessClone.login() succeeded for ${connId}`)
  } else if (connection.oauth || connection.password) {
    client = createClient(connection)
    await client.login() // raise exception for login issues
    await client.statelessClone.login()
  } else {
    const password = (await manager.askPassword(connection.name)) || ""
    if (!password) throw Error("Can't connect without a password")
    client = await createClient({ ...connection, password })
    await client.login() // raise exception for login issues
    await client.statelessClone.login()
    connection.password = password
    const { name, username } = connection
    await manager.savePassword(name, username, password)
  }

  if (
    revisions.get(connId) !== revision ||
    (provided && providedConnections.get(connId) !== provided)
  ) {
    await Promise.allSettled([client.logout(), client.statelessClone.logout()])
    throw new Error(`Connection removed or changed during login: ${connId}`)
  }
  // @ts-ignore
  const service = new AFsService(client)
  const newRoot = new Root(connId, service)
  roots.set(connId, newRoot)
  clients.set(connId, client)
  connected.fire(connId)
}

// Track connections that failed with non-retryable errors (e.g. SSO timeout, auth rejection)
// to prevent VS Code filesystem from triggering infinite retry loops
const failedConnections = new Map<string, string>() // connId → error message

function createIfMissing(connId: string) {
  if (roots.get(connId)) return
  // If connection previously failed with a non-retryable error, don't retry
  const failReason = failedConnections.get(connId)
  if (failReason) {
    return Promise.reject(new Error(failReason))
  }
  let creation = creations.get(connId)
  if (!creation) {
    const cancellation = new AbortController()
    if (providedConnections.has(connId)) cancellations.set(connId, cancellation)
    creation = (
      providedConnections.has(connId)
        ? untilCancelled(create(connId, cancellation), cancellation.signal)
        : create(connId, cancellation)
    ).catch(err => {
      // Mark as permanently failed if it's an interactive/auth error
      // so VS Code filesystem doesn't keep triggering retry loops
      const msg = String(err?.message || err)
      if (
        msg.includes("timed out") ||
        msg.includes("SSO") ||
        msg.includes("authentication") ||
        msg.includes("OAuth") ||
        msg.includes("401") ||
        msg.includes("403") ||
        msg.includes("cancelled") ||
        msg.includes("Can't connect without a password")
      ) {
        log.debug(`[connect] Marking ${connId} as failed (no auto-retry): ${msg.substring(0, 100)}`)
        failedConnections.set(
          connId,
          `Connection failed: ${msg}. Disconnect and reconnect to retry.`
        )
      }
      throw err
    })
    creations.set(connId, creation)
    void creation.then(
      () => creations.delete(connId),
      () => creations.delete(connId)
    )
  }
  return creation
}

/** Clear the failed state for a connection (called on disconnect/reconnect). */
export function clearConnectionFailure(connId: string) {
  failedConnections.delete(connId)
}

export async function getOrCreateClient(connId: string, clone = true) {
  connId = connId.toLowerCase()
  await removals.get(connId)
  if (!clients.has(connId)) {
    try {
      await createIfMissing(connId)
    } catch (error) {
      // Re-throw validation errors with original message instead of generic "missing" error
      throw error // Preserve the original validation error message
    }
  }
  return getClient(connId, clone)
}

export function getClient(connId: string, clone = true) {
  const client = clients.get(connId.toLowerCase())
  if (client) return clone ? client.statelessClone : client

  // If client doesn't exist, this means validation failed or connection was never established
  // Instead of generic "missing" error, provide more helpful feedback
  throw new Error(
    `SAP system '${connId}' is not accessible. This may be due to whitelist restrictions or connection issues. Check the extension logs for validation details.`
  )
}

export const getRoot = (connId: string) => {
  const root = roots.get(connId.toLowerCase())
  if (root) return root
  throw missing(connId)
}

export const uriRoot = (uri: Uri) => {
  if (abapUri(uri)) return getRoot(uri.authority)
  throw missing(uri.toString())
}

export const getOrCreateRoot = async (connId: string) => {
  connId = connId.toLowerCase()
  await removals.get(connId)
  if (!roots.has(connId)) await createIfMissing(connId)
  return getRoot(connId)
}

export function hasLocks() {
  for (const root of roots.values()) if (root.lockManager.lockedPaths().next().value) return true
}
function boundedCleanup(work: Promise<unknown>): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, 1000)
    work
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer)
        resolve()
      })
  })
}
/** Immediately invalidate provider operations; bound cleanup independently of callbacks. */
export function disconnectConnection(id: string): Promise<void> {
  const connId = id.toLowerCase()
  const previous = removals.get(connId)
  if (previous) return previous
  revisions.set(connId, (revisions.get(connId) || 0) + 1)
  const provider = cancellations.get(connId)
  provider?.abort()
  cancellations.delete(connId)
  const client = clients.get(connId)
  const root = roots.get(connId)
  clients.delete(connId)
  roots.delete(connId)
  failedConnections.delete(connId)
  const cleanup = (async () => {
    await creations.get(connId)?.catch(() => undefined)
    await Promise.allSettled(LogOutPendingDebuggers(connId))
    if (root) await root.lockManager.dropall()?.catch(() => undefined)
    if (client) await Promise.allSettled([client.logout(), client.statelessClone.logout()])
  })()
  const removal = provider ? boundedCleanup(cleanup) : cleanup
  removals.set(connId, removal)
  if (client) disconnected.fire(connId)
  void removal.then(
    () => {
      removals.delete(connId)
      revisions.delete(connId)
      failedConnections.delete(connId)
    },
    () => {
      removals.delete(connId)
      revisions.delete(connId)
      failedConnections.delete(connId)
    }
  )
  return removal
}

export async function disconnect() {
  await Promise.all(
    [...new Set([...clients.keys(), ...creations.keys()]).values()].map(disconnectConnection)
  )
  await Promise.all(LogOutPendingDebuggers())
  failedConnections.clear()
}

export const rootIsConnected = (connId: string) =>
  !!workspace.workspaceFolders?.find(
    f => f.uri.scheme === ADTSCHEME && f.uri.authority === connId?.toLowerCase()
  )
