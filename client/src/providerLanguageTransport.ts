import { randomUUID } from "node:crypto"
import { isCsrfError } from "abap-adt-api"
import type { ProviderRequest, ProviderResponse } from "vscode-abap-remote-fs-sharedapi"
import { providedConnections, type ProvidedConnection } from "./connectionProviders"
import { getOrCreateClient } from "./adt/conections"
import { providerHttpRequest } from "./providerClient"

const sessions = new WeakMap<ProvidedConnection, string>()
export function providerTransportConfig(id: string) {
  const connection = providedConnections.get(id.toLowerCase())
  if (!connection) return undefined
  let session = sessions.get(connection)
  if (!session) sessions.set(connection, (session = randomUUID()))
  return { session }
}

/** Keep the HTTP operation in the host that owns provider authentication and cancellation. */
export async function languageProviderRequest(request: ProviderRequest): Promise<ProviderResponse> {
  const id = request.id.toLowerCase()
  const owner = providedConnections.get(id)
  if (!owner || providerTransportConfig(id)?.session !== request.session)
    return { failure: { csrf: false, withdrawn: true } }
  try {
    const client = await getOrCreateClient(id, false)
    if (providedConnections.get(id) !== owner) return { failure: { csrf: false, withdrawn: true } }
    const response = await providerHttpRequest(client, request.options)
    if (providedConnections.get(id) !== owner) return { failure: { csrf: false, withdrawn: true } }
    return { response }
  } catch (error) {
    const status = (error as { status?: number }).status
    return {
      failure: {
        status: typeof status === "number" ? status : undefined,
        csrf: isCsrfError(error),
        withdrawn: providedConnections.get(id) !== owner
      }
    }
  }
}
