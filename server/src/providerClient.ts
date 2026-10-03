import { ADTClient, session_types } from "abap-adt-api"
import type { HttpClientOptions } from "abap-adt-api/build/AdtHTTP.js"
import {
  Methods,
  type ClientConfiguration,
  type ProviderRequest,
  type ProviderResponse
} from "vscode-abap-remote-fs-sharedapi"

type Send = (method: Methods, request: ProviderRequest) => Promise<ProviderResponse>
/** Provider headers stay in the extension host; every HTTP attempt verifies snapshot ownership. */
export function createLanguageProviderClient(
  id: string,
  config: ClientConfiguration,
  send: Send
): ADTClient {
  const session = config.providerTransport!.session
  const http = {
    request: async (options: HttpClientOptions) => {
      const result = await send(Methods.providerRequest, {
        id,
        session,
        options: { ...options, auth: undefined }
      })
      if ("response" in result) return result.response
      const { status, csrf, withdrawn } = result.failure
      throw Object.assign(
        new Error(
          withdrawn
            ? "Provider connection withdrawn or changed; reconnect to use language features"
            : "Provider language request failed"
        ),
        {
          typeID: Symbol.for(csrf ? "BAD CSRF" : "ADT EXCEPTION"),
          status,
          err: status ?? 0
        }
      )
    }
  }
  class ProviderClient extends ADTClient {
    private clone?: ADTClient
    constructor(private readonly isClone = false) {
      super(http, config.username, "", config.client, config.language)
    }
    override get baseUrl() {
      return config.url
    }
    override get statelessClone(): ADTClient {
      if (this.isClone) return this
      return (this.clone ??= new ProviderClient(true))
    }
    override get stateful() {
      return super.stateful
    }
    override set stateful(value: session_types) {
      if (this.isClone) throw new Error("Stateful sessions not allowed in stateless clones")
      super.stateful = value
    }
  }
  return new ProviderClient()
}
