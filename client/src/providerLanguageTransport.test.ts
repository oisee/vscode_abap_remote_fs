import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ClientConfiguration, ProviderResponse } from "vscode-abap-remote-fs-sharedapi"
import { Methods } from "vscode-abap-remote-fs-sharedapi"

const { request, sendRequest } = vi.hoisted(() => ({ request: vi.fn(), sendRequest: vi.fn() }))
vi.mock("./providerTransport", async importOriginal => ({
  ...(await importOriginal<typeof import("./providerTransport")>()),
  ProviderTransport: class {
    request = request
  }
}))
vi.mock("./adt/conections", () => ({ getOrCreateClient: vi.fn() }))
vi.mock("../../server/node_modules/vscode-languageserver/lib/main.js", () => ({
  createConnection: () => ({ sendRequest }),
  ProposedFeatures: { all: {} }
}))
import { getOrCreateClient } from "./adt/conections"
import { providedConnections, type ProvidedConnection } from "./connectionProviders"
import { createProviderClient } from "./providerClient"
import { providerTransportConfig, languageProviderRequest } from "./providerLanguageTransport"
import { clientFromKey } from "../../server/src/clientManager"

const connection: ProvidedConnection = {
  id: "osd",
  name: "OSD",
  url: "http://localhost:5000",
  user: "developer",
  client: "001",
  language: "EN",
  auth: { kind: "provider", getHeaders: async () => ({ Authorization: "token" }) }
}
const configuration = (): ClientConfiguration => ({
  name: "osd",
  url: connection.url,
  username: connection.user,
  password: "",
  client: "001",
  language: "EN",
  allowSelfSigned: false,
  diff_formatter: "ADT formatter",
  providerTransport: providerTransportConfig("osd")
})
const ok = (body = "") => ({
  status: 200,
  statusText: "OK",
  body,
  headers: { "x-csrf-token": "csrf" }
})

describe("language server provider integration", () => {
  beforeEach(() => {
    providedConnections.clear()
    request.mockReset().mockResolvedValue(ok())
    sendRequest.mockReset().mockImplementation(async (method, payload) => {
      if (method === Methods.readConfiguration)
        return providedConnections.has("osd") ? configuration() : undefined
      // Model JSON-RPC serialization in both directions: functions, symbols and credentials cannot cross.
      return JSON.parse(
        JSON.stringify(await languageProviderRequest(JSON.parse(JSON.stringify(payload))))
      ) as ProviderResponse
    })
  })
  async function setup() {
    const getHeaders = vi.fn(async () => ({
      Authorization: `PRIVATE-TOKEN-${getHeaders.mock.calls.length}`
    }))
    const owner = { ...connection, auth: { kind: "provider" as const, getHeaders } }
    providedConnections.set("osd", owner)
    const cancellation = new AbortController()
    const host = createProviderClient(owner, cancellation.signal)
    vi.mocked(getOrCreateClient).mockResolvedValue(host)
    const server = await clientFromKey("osd")
    expect(server).toBeDefined()
    return { server: server!, getHeaders, cancellation }
  }
  it("completes code with fresh provider headers and one retry, without forwarding credentials", async () => {
    const { server, getHeaders } = await setup()
    await server.login()
    request.mockResolvedValueOnce({
      status: 401,
      statusText: "Unauthorized",
      headers: {},
      body: "expired"
    })
    request.mockResolvedValueOnce(
      ok(
        "<asx:abap><asx:values><DATA><SCC_COMPLETION><IDENTIFIER>WRITE</IDENTIFIER></SCC_COMPLETION></DATA></asx:values></asx:abap>"
      )
    )
    const completion = await server.codeCompletion(
      "/sap/bc/adt/programs/programs/ztest/source/main",
      "WR",
      1,
      2
    )
    expect(completion[0].IDENTIFIER).toBe("WRITE")
    expect(getHeaders).toHaveBeenCalledTimes(3)
    expect(request.mock.calls.map(([options]) => options.headers.Authorization)).toEqual([
      "PRIVATE-TOKEN-1",
      "PRIVATE-TOKEN-2",
      "PRIVATE-TOKEN-3"
    ])
    expect(JSON.stringify(sendRequest.mock.calls)).not.toContain("PRIVATE-TOKEN")
    expect(JSON.stringify(configuration())).not.toContain("PRIVATE-TOKEN")
    await server.statelessClone.login()
    expect(getHeaders).toHaveBeenCalledTimes(4)
  })
  it("redacts a malformed HTTP 200 before the language server parses it", async () => {
    const { server } = await setup()
    await server.login()
    request.mockResolvedValueOnce(
      ok(
        '<customizing><exemption><reasons><reason id="test" title="test" justificationMandatory="PRIVATE-TOKEN-2"/></reasons></exemption></customizing>'
      )
    )
    const failure = await server.atcCustomizing().catch(error => error)
    expect(failure).toBeInstanceOf(Error)
    for (const value of [
      failure.message,
      failure.stack,
      JSON.stringify(failure),
      JSON.stringify(sendRequest.mock.calls)
    ])
      expect(value).not.toContain("PRIVATE-TOKEN")
  })
  it("invalidates cached server clients on withdrawal and supports a new snapshot", async () => {
    const { server, cancellation } = await setup()
    await server.login()
    providedConnections.delete("osd")
    cancellation.abort()
    request.mockClear()
    await expect(
      server.getObjectSource("/sap/bc/adt/programs/programs/ztest/source/main")
    ).rejects.toThrow(/withdrawn/)
    expect(request).not.toHaveBeenCalled()
    expect(await clientFromKey("osd")).toBeUndefined()
    const replacement = await setup()
    expect(replacement.server).not.toBe(server)
    await replacement.server.login()
  })
  it("bounds second-401 failures and redacts error payloads", async () => {
    const { server, getHeaders } = await setup()
    request.mockResolvedValue({
      status: 401,
      statusText: "PRIVATE-TOKEN",
      headers: { Authorization: "PRIVATE-TOKEN" },
      body: "PRIVATE-TOKEN"
    })
    const failure = await server.login().catch(error => error)
    expect(failure).toBeInstanceOf(Error)
    expect(getHeaders).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(failure)).not.toContain("PRIVATE-TOKEN")
  })
})
