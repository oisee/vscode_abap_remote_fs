import type { Middleware } from "vscode-languageclient/node"
import { providedConnections } from "./connectionProviders"

// Keep rotated values in memory so delayed results cannot echo an earlier credential.
const secrets = new Set<string>()
const remember = (value: string) => {
  if (value.length >= 8) secrets.add(value)
}
export function rememberProviderHeaders(headers: Record<string, string>) {
  for (const [key, value] of Object.entries(headers)) {
    remember(value)
    if (/^authorization$/i.test(key)) remember(value.replace(/^(?:Bearer|Basic)\s+/i, ""))
    if (/^cookie$/i.test(key))
      for (const cookie of value.split(";")) {
        const separator = cookie.indexOf("=")
        if (separator >= 0) remember(cookie.slice(separator + 1).trim())
      }
  }
}
export function rememberProviderPassword(password: string) {
  remember(password)
}

/** Sanitize before JSON-RPC serialization and tracing, in either direction. */
export function redactProviderProtocol<T>(value: T): T {
  for (const connection of providedConnections.values())
    if (connection.auth.kind === "basic") remember(connection.auth.password)
  const values = [...secrets].sort((a, b) => b.length - a.length)
  const redact = (text: string) =>
    values.reduce((result, secret) => result.split(secret).join("[redacted]"), text)
  const sanitize = (entry: unknown): unknown => {
    if (typeof entry === "string") return redact(entry)
    if (Array.isArray(entry)) return entry.map(sanitize)
    if (entry && typeof entry === "object")
      return Object.fromEntries(
        Object.entries(entry).map(([key, item]) => [redact(key), sanitize(item)])
      )
    return entry
  }
  return sanitize(value) as T
}

export function providerProtocolHandler<A extends unknown[], R>(handler: (...args: A) => R) {
  return async (...args: A) => {
    try {
      return redactProviderProtocol(await handler(...args))
    } catch (error) {
      throw new Error(
        redactProviderProtocol(error instanceof Error ? error.message : "Language request failed")
      )
    }
  }
}

export const providerProtocolMiddleware: Middleware = {
  sendRequest: async (type, params, token, next) =>
    redactProviderProtocol(await next(type, redactProviderProtocol(params), token)),
  sendNotification: (type, next, params) => next(type, redactProviderProtocol(params))
}
