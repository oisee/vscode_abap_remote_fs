import { ADTClient, createSSLConfig, session_types, isCsrfError } from "abap-adt-api"
import { ProviderTransport, untilCancelled } from "./providerTransport"
import type { HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js"
import type { ProvidedConnection } from "./connectionProviders"

const requests = new WeakMap<
  ADTClient,
  (options: HttpClientOptions) => Promise<HttpClientResponse>
>()
export function providerHttpRequest(client: ADTClient, options: HttpClientOptions) {
  const request = requests.get(client)
  if (!request) throw new Error("Provider transport is unavailable")
  return request(options)
}

function isUnauthorized(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const failure = error as { status?: number; response?: { status?: number } }
  return failure.status === 401 || failure.response?.status === 401
}

/** Fresh headers on every request, shared by stateful and stateless sessions. */
export function createProviderClient(
  connection: ProvidedConnection,
  signal = new AbortController().signal
): ADTClient {
  const ssl = connection.url.startsWith("https:")
    ? createSSLConfig(!!connection.allowSelfSigned)
    : {}
  const transport = new ProviderTransport(connection.url, ssl)
  const http = {
    request: async (options: HttpClientOptions, redactResponse = false) => {
      const send = async () => {
        signal.throwIfAborted()
        const headers =
          connection.auth.kind === "provider"
            ? await untilCancelled(connection.auth.getHeaders(), signal)
            : {}
        signal.throwIfAborted()
        const mergedHeaders = { ...options.headers, ...headers }
        const cookieKey = Object.keys(headers).find(key => key.toLowerCase() === "cookie")
        if (cookieKey && options.headers?.Cookie) {
          delete mergedHeaders[cookieKey]
          mergedHeaders.Cookie = `${options.headers.Cookie}; ${headers[cookieKey]}`
        }
        const response = await untilCancelled(
          transport.request(
            {
              ...options,
              auth:
                connection.auth.kind === "provider"
                  ? undefined
                  : (options.auth ?? {
                      username: connection.user,
                      password: connection.auth.password
                    }),
              timeout: options.timeout ?? 30000,
              headers: mergedHeaders
            },
            signal
          ),
          signal
        )
        if (!redactResponse) return response
        // A server parser may report values from a malformed 200 response. Strip only provider
        // secrets before they cross the protocol; headers are never stored in configuration.
        const secrets = Object.values(headers).filter(Boolean)
        const redact = (value: string) =>
          secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), value)
        return {
          ...response,
          request: undefined,
          body: redact(response.body),
          statusText: redact(response.statusText),
          headers: Object.fromEntries(
            Object.entries(response.headers).map(([key, value]) => [
              key,
              typeof value === "string"
                ? redact(value)
                : Array.isArray(value)
                  ? value.map(redact)
                  : value
            ])
          )
        }
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
          if (response.status >= 400) throw safeError(response)
          return response
        }
        throw new Error("ADT authentication failed")
      } catch (error) {
        // HTTP errors can contain request headers and passwords. Never expose them to logs.
        throw safeError(error)
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
      return (this.clone ??= protect(new ProviderClient(true)))
    }
  }
  function protect(client: ADTClient): ADTClient {
    const proxy = new Proxy(client, {
      get(target, key) {
        if (key === "statelessClone" && target.statelessClone === target) return proxy
        const value = Reflect.get(target, key, target)
        if (typeof value !== "function") return value
        return (...args: unknown[]) => {
          try {
            const result = value.apply(target, args)
            return result instanceof Promise
              ? result.catch((error: unknown) => {
                  throw safeError(error)
                })
              : result
          } catch (error) {
            throw safeError(error)
          }
        }
      }
    })
    requests.set(proxy, options => http.request(options, true))
    return proxy
  }
  function safeError(error: unknown) {
    const failure = error as {
      status?: number
      err?: number
      response?: { status?: number; headers?: Record<string, unknown> }
    }
    const response = failure?.response ?? (failure as typeof failure.response)
    const status = failure?.status ?? response?.status ?? failure?.err
    const csrf =
      isCsrfError(error) || (status === 403 && response?.headers?.["x-csrf-token"] === "Required")
    return Object.assign(new Error(`ADT request failed for provider connection ${connection.id}`), {
      typeID: Symbol.for(csrf ? "BAD CSRF" : "ADT EXCEPTION"),
      status: typeof status === "number" ? status : undefined,
      err: typeof status === "number" ? status : 0,
      properties: {},
      response:
        typeof status === "number"
          ? {
              status,
              statusText: "ADT request failed",
              body: "",
              headers: csrf ? { "x-csrf-token": "Required" } : {}
            }
          : undefined
    })
  }
  return protect(new ProviderClient())
}
