import { transportValidators } from "./adt/AdtTransports"
import { type Disposable, type CancellationToken, type Event, Uri, workspace, window } from "vscode"
import {
  type ConnectionProvider,
  registerProvider,
  providedConnections
} from "./connectionProviders"
import {
  connected,
  disconnected,
  savedObject,
  activatedObject,
  type ObjectEvent
} from "./apiEvents"
import { RemoteManager } from "./config"
import {
  getOrCreateRoot,
  getClient,
  clientIsConnected,
  disconnectConnection
} from "./adt/conections"
import { isAbapFile } from "abapfs"
import { AdtObjectFinder } from "./adt/operations/AdtObjectFinder"
import { IncludeService } from "./adt/includes/service"
import { AdtObjectActivator } from "./adt/operations/AdtObjectActivator"
import { UnitTestRunner, type UnitTestResults } from "./adt/operations/UnitTestRunner"

export type { ConnectionProvider, ProvidedConnection } from "./connectionProviders"
export type { ObjectEvent } from "./apiEvents"
export type {
  UnitTestResults,
  TestClassResult,
  TestMethodResult
} from "./adt/operations/UnitTestRunner"

export type TransportValidator = (
  transport: string,
  type: string,
  name: string,
  devClass: string,
  token?: CancellationToken
) => Promise<boolean>

function registerTransportValidator(v: TransportValidator) {
  if (transportValidators.indexOf(v) < 0) transportValidators.push(v)
  return {
    dispose: () => {
      const idx = transportValidators.indexOf(v)
      if (idx >= 0) transportValidators.splice(idx, 1)
    }
  }
}

export interface AbapFsApi {
  readonly version: 2
  registerTransportValidator(v: TransportValidator): Disposable
  registerConnectionProvider(provider: ConnectionProvider): Disposable
  connect(id: string): Promise<void>
  isConnected(id: string): boolean
  readonly onDidConnect: Event<string>
  readonly onDidDisconnect: Event<string>
  readonly onDidSaveObject: Event<ObjectEvent>
  readonly onDidActivate: Event<ObjectEvent>
  toAdtUri(fsUri: Uri): Promise<string>
  fromAdtUri(connId: string, adtUri: string): Promise<Uri>
  openObject(connId: string, objectType: string, name: string): Promise<Uri>
  runUnitTests(connId: string, uri: Uri): Promise<UnitTestResults>
}

/** Release operation caches when a command or API request disconnects a session. */
export function initializeApi(): Disposable {
  return disconnected.event(id => {
    IncludeService.forget(id)
    AdtObjectActivator.forget(id)
    UnitTestRunner.forget(id)
  })
}

// VS Code only accepts another edit after onDidChangeWorkspaceFolders fires.
let workspaceChanges = Promise.resolve()
function queueWorkspaceChange(change: () => Promise<void>): Promise<void> {
  const pending = workspaceChanges.then(change)
  workspaceChanges = pending.catch(() => undefined)
  return pending
}
function updateFolders(
  signal: AbortSignal | undefined,
  start: number,
  count: number,
  ...folders: { uri: Uri; name: string }[]
): Promise<void> {
  const expected = [...(workspace.workspaceFolders || [])]
  expected.splice(start, count, ...folders.map((folder, index) => ({ ...folder, index })))
  const matches = () => {
    const actual = workspace.workspaceFolders || []
    return (
      actual.length === expected.length &&
      actual.every((folder, index) => folder.uri.toString() === expected[index].uri.toString())
    )
  }
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer)
      subscription.dispose()
      signal?.removeEventListener("abort", cancel)
      if (error) reject(error)
      else resolve()
    }
    const cancel = () => finish(new Error("Connection removed or changed during workspace update"))
    const subscription = workspace.onDidChangeWorkspaceFolders(() => {
      if (matches()) finish()
    })
    const timer = setTimeout(() => {
      // Some accepted edits finish without an event; trust the actual folder state.
      finish(matches() ? undefined : new Error("ABAP workspace folder update timed out"))
    }, 10000)
    signal?.addEventListener("abort", cancel, { once: true })
    if (signal?.aborted) return cancel()
    try {
      if (!workspace.updateWorkspaceFolders(start, count, ...folders))
        finish(new Error("Unable to mount ABAP workspace folders"))
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Unable to mount ABAP workspace folders"))
    }
  })
}
const unmounts = new Set<string>()
function scheduleUnmount(id: string) {
  const scheduled = unmounts.size > 0
  unmounts.add(id)
  if (scheduled) return
  queueMicrotask(() => {
    void queueWorkspaceChange(async () => {
      const folders = workspace.workspaceFolders || []
      const remaining = folders.filter(
        f =>
          f.uri.scheme !== "adt" ||
          !unmounts.has(f.uri.authority.toLowerCase()) ||
          (providedConnections.has(f.uri.authority.toLowerCase()) &&
            clientIsConnected(f.uri.authority))
      )
      unmounts.clear()
      if (remaining.length !== folders.length)
        await updateFolders(undefined, 0, folders.length, ...remaining)
    }).catch(() => undefined)
  })
}

const mountCancellations = new Map<string, AbortController>()
const mounts = new Map<string, Promise<void>>()
async function connect(id: string): Promise<void> {
  id = id.toLowerCase()
  const pending = mounts.get(id)
  if (pending) return pending
  const cancellation = new AbortController()
  mountCancellations.set(id, cancellation)
  const owner = providedConnections.get(id)
  const current = () => clientIsConnected(id) && (!owner || providedConnections.get(id) === owner)
  const mount = (async () => {
    await getOrCreateRoot(id)
    await queueWorkspaceChange(async () => {
      if (!current()) throw new Error(`Connection removed or changed: ${id}`)
      if (workspace.workspaceFolders?.some(f => f.uri.scheme === "adt" && f.uri.authority === id))
        return
      await updateFolders(cancellation.signal, workspace.workspaceFolders?.length || 0, 0, {
        uri: Uri.parse(`adt://${id}`),
        name: `${id}(ABAP)`
      })
      if (!current()) {
        const folders = workspace.workspaceFolders || []
        const remaining = folders.filter(f => f.uri.scheme !== "adt" || f.uri.authority !== id)
        if (remaining.length !== folders.length)
          await updateFolders(undefined, 0, folders.length, ...remaining)
        throw new Error(`Connection removed or changed: ${id}`)
      }
    })
  })()
  mounts.set(id, mount)
  try {
    await mount
  } finally {
    mounts.delete(id)
    mountCancellations.delete(id)
  }
}

function requireFsUri(uri: Uri, connId = uri.authority) {
  if (uri.scheme !== "adt" || uri.authority.toLowerCase() !== connId.toLowerCase())
    throw new Error("Expected an ABAP FS URI for this connection")
}

export const api: AbapFsApi = {
  version: 2,
  registerTransportValidator,
  registerConnectionProvider: provider =>
    registerProvider(
      provider,
      () => Object.keys(workspace.getConfiguration("abapfs").remote || {}),
      id => {
        mountCancellations.get(id)?.abort()
        IncludeService.forget(id)
        AdtObjectActivator.forget(id)
        UnitTestRunner.forget(id)
        RemoteManager.get().forget(id)
        void disconnectConnection(id).catch(() => undefined)
        scheduleUnmount(id)
      },
      connection => {
        void (async () => {
          // Wait for a previous mount to settle before reconnecting a changed snapshot.
          await mounts.get(connection.id)?.catch(() => undefined)
          if (providedConnections.get(connection.id) !== connection) return
          await connect(connection.id)
        })().catch(() => undefined) // Automatic connections never prompt or expose provider errors.
      }
    ),
  connect,
  isConnected: clientIsConnected,
  onDidConnect: connected.event,
  onDidDisconnect: disconnected.event,
  onDidSaveObject: savedObject.event,
  onDidActivate: activatedObject.event,
  async toAdtUri(uri) {
    requireFsUri(uri)
    const root = await getOrCreateRoot(uri.authority)
    const node = await root.getNodeAsync(uri.path)
    if (!isAbapFile(node)) throw new Error("Expected an ABAP source file")
    await node.object.loadStructure()
    return node.object.contentsPath() + (uri.fragment ? `#${uri.fragment}` : "")
  },
  async fromAdtUri(connId, adtUri) {
    connId = connId.toLowerCase()
    await getOrCreateRoot(connId)
    const parsed = Uri.parse(adtUri.startsWith("/") ? `adt://placeholder${adtUri}` : adtUri)
    if (parsed.scheme && !["http", "https", "adt"].includes(parsed.scheme))
      throw new Error("Expected an ADT URI")
    const path = parsed.path + (parsed.query ? `?${parsed.query}` : "")
    if (!path.startsWith("/sap/bc/adt/")) throw new Error("Expected an ADT object path")
    const result = await new AdtObjectFinder(connId).vscodeRange(
      path + (parsed.fragment ? `#${parsed.fragment}` : "")
    )
    return Uri.parse(result.uri).with({ fragment: parsed.fragment })
  },
  async openObject(connId, objectType, name) {
    connId = connId.toLowerCase()
    await connect(connId)
    const results = await getClient(connId).searchObject(name.toUpperCase(), objectType)
    const result = results.find(
      r =>
        r["adtcore:type"] === objectType && r["adtcore:name"].toUpperCase() === name.toUpperCase()
    )
    if (!result) throw new Error(`ABAP object not found: ${objectType} ${name}`)
    const uri = await api.fromAdtUri(connId, result["adtcore:uri"])
    await window.showTextDocument(await workspace.openTextDocument(uri))
    return uri
  },
  async runUnitTests(connId, uri) {
    requireFsUri(uri, connId)
    await connect(connId)
    return UnitTestRunner.get(connId.toLowerCase()).addResultsWithReturn(uri)
  }
}
