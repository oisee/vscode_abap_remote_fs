import { ADTClient, createSSLConfig, session_types } from "abap-adt-api"
import { AxiosHttpClient } from "abap-adt-api/build/AxiosHttpClient.js"
import type { ProvidedConnection } from "./connectionProviders"

/** Fresh headers on every request, shared by stateful and stateless sessions. */
export function createProviderClient(connection: ProvidedConnection): ADTClient {
  const ssl = connection.url.startsWith("https:")
    ? createSSLConfig(!!connection.allowSelfSigned)
    : {}
  const transport = new AxiosHttpClient(connection.url, ssl)
  const http = {
    request: async (options: Parameters<AxiosHttpClient["request"]>[0]) => {
      try {
        const headers =
          connection.auth.kind === "provider" ? await connection.auth.getHeaders() : {}
        const mergedHeaders = { ...options.headers, ...headers }
        const cookieKey = Object.keys(headers).find(key => key.toLowerCase() === "cookie")
        if (cookieKey && options.headers?.Cookie) {
          delete mergedHeaders[cookieKey]
          mergedHeaders.Cookie = `${options.headers.Cookie}; ${headers[cookieKey]}`
        }
        return await transport.request({
          ...options,
          ...(connection.auth.kind === "provider" ? { auth: undefined } : {}),
          timeout: options.timeout ?? 30000,
          headers: mergedHeaders
        })
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
