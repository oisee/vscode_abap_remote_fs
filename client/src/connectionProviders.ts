import type { Disposable, Event } from "vscode"

export interface ProvidedConnection {
  id: string
  name: string
  url: string
  client: string
  language: string
  user: string
  auth:
    | { kind: "basic"; password: string }
    | { kind: "provider"; getHeaders: () => Promise<Record<string, string>> }
  /** Connect and mount automatically while this connection is in the snapshot. */
  autoConnect?: boolean
  allowSelfSigned?: boolean
}

export interface ConnectionProvider {
  /** Return the current snapshot. IDs are case insensitive and must be unique. */
  getConnections(): readonly ProvidedConnection[]
  onDidChange?: Event<void>
}

export const providedConnections = new Map<string, ProvidedConnection>()
const listeners = new Set<() => void>()
export function onProvidersChanged(listener: () => void): Disposable {
  listeners.add(listener)
  return {
    dispose: () => {
      listeners.delete(listener)
    }
  }
}

export function registerProvider(
  provider: ConnectionProvider,
  configuredIds: () => string[],
  remove: (id: string) => void,
  autoConnect: (connection: ProvidedConnection) => void = () => {}
): Disposable {
  let disposed = false
  let owned = new Map<string, ProvidedConnection>()
  const refresh = () => {
    if (disposed) return
    const incoming = new Map<string, ProvidedConnection>()
    const configured = new Set(configuredIds().map(id => id.toLowerCase()))
    for (const connection of provider.getConnections()) {
      const id = connection.id.toLowerCase()
      let url: URL
      try {
        url = new URL(connection.url)
      } catch {
        throw new Error("Invalid provider connection URL")
      }
      if (
        !/^[\w-]+$/.test(id) ||
        !connection.name ||
        !connection.user ||
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error(
          "Invalid provider connection: use a safe ID and an HTTP(S) URL without credentials, query or fragment"
        )
      if (incoming.has(id) || configured.has(id) || (providedConnections.has(id) && !owned.has(id)))
        throw new Error(`Connection ID already in use: ${id}`)
      const previous = owned.get(id)
      // Preserve unchanged snapshots even when a provider returns new objects.
      const unchanged =
        previous &&
        previous.name === connection.name &&
        previous.url === connection.url &&
        previous.client === connection.client &&
        previous.language === connection.language &&
        previous.user === connection.user &&
        previous.allowSelfSigned === connection.allowSelfSigned &&
        previous.autoConnect === connection.autoConnect &&
        previous.auth.kind === connection.auth.kind &&
        (previous.auth.kind === "basic" && connection.auth.kind === "basic"
          ? previous.auth.password === connection.auth.password
          : previous.auth.kind === "provider" &&
            connection.auth.kind === "provider" &&
            previous.auth.getHeaders === connection.auth.getHeaders)
      incoming.set(id, unchanged ? previous : { ...connection, id, auth: { ...connection.auth } })
    }
    for (const [id, old] of owned) {
      if (incoming.get(id) !== old) {
        providedConnections.delete(id)
        remove(id)
      }
    }
    owned = incoming
    for (const [id, connection] of owned) providedConnections.set(id, connection)
    for (const listener of listeners) listener()
    for (const connection of owned.values()) {
      if (connection.autoConnect) autoConnect(connection)
    }
  }
  refresh()
  const subscription = provider.onDidChange?.(refresh)
  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      subscription?.dispose()
      for (const id of owned.keys()) {
        providedConnections.delete(id)
        remove(id)
      }
      owned.clear()
      for (const listener of listeners) listener()
    }
  }
}
