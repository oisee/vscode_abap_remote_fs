import { ADTClient, createSSLConfig, session_types } from "abap-adt-api"
import { AxiosHttpClient } from "abap-adt-api/build/AxiosHttpClient.js"
import type { ProvidedConnection } from "./connectionProviders"

function isUnauthorized(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const failure = error as { status?: number; response?: { status?: number } }
  return failure.status === 401 || failure.response?.status === 401
}

/** Fresh headers on every request, shared by stateful and stateless sessions. */
export function createProviderClient(connection: ProvidedConnection): ADTClient {
  const ssl = connection.url.startsWith("https:")
    ? createSSLConfig(!!connection.allowSelfSigned)
    : {}
  const transport = new AxiosHttpClient(connection.url, ssl)
  const http = {
    request: async (options: Parameters<AxiosHttpClient["request"]>[0]) => {
      const send = async () => {
        const headers =
          connection.auth.kind === "provider" ? await connection.auth.getHeaders() : {}
        const mergedHeaders = { ...options.headers, ...headers }
        const cookieKey = Object.keys(headers).find(key => key.toLowerCase() === "cookie")
        if (cookieKey && options.headers?.Cookie) {
          delete mergedHeaders[cookieKey]
          mergedHeaders.Cookie = `${options.headers.Cookie}; ${headers[cookieKey]}`
        }
        return transport.request({
          ...options,
          ...(connection.auth.kind === "provider" ? { auth: undefined } : {}),
          timeout: options.timeout ?? 30000,
          headers: mergedHeaders
        })
      }
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          let response
          try {
            response = await send()
          } catch (error) {
            if (attempt === 0 && connection.auth.kind === "provider" && isUnauthorized(error))
              continue
            throw error
          }
          if (attempt === 0 && response.status === 401 && connection.auth.kind === "provider")
            continue
          // Do not let ADT's response parser expose a body that echoes an authentication header.
          if (response.status >= 400) throw new Error("ADT request failed")
          return response
        }
        throw new Error("ADT authentication failed")
      } catch {
        // HTTP errors can contain request headers and passwords. Never expose them to logs.
        throw new Error(`ADT request failed for provider connection ${connection.id}`)
      }
    }
  }
  class ProviderClient extends ADTClient {
    private clone?: ADTClient
    constructor(private readonly isClone = false) {
      super(
        http,
        connection.user,
        connection.auth.kind === "basic" ? connection.auth.password : "",
        connection.client,
        connection.language
      )
    }
    override get stateful() {
      return super.stateful
    }
    override set stateful(value: session_types) {
      if (this.isClone) throw new Error("Stateful sessions not allowed in stateless clones")
      super.stateful = value
    }
    override get baseUrl() {
      return connection.url
    }
    override get statelessClone(): ADTClient {
      if (this.isClone) return this
      return (this.clone ??= new ProviderClient(true))
    }
  }
  return new ProviderClient()
}
