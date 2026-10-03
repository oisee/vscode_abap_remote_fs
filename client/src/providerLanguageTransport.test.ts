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
vi.mock("../../server/node_modules/vscode-languageserver/lib/main.js", async importOriginal => ({
  ...(await importOriginal<
    typeof import("../../server/node_modules/vscode-languageserver/lib/main.js")
  >()),
  createConnection: () => ({ sendRequest }),
  ProposedFeatures: { all: {} }
}))
import { getOrCreateClient } from "./adt/conections"
import { providedConnections, type ProvidedConnection } from "./connectionProviders"
import { providerProtocolHandler, providerProtocolMiddleware } from "./providerRedaction"
import { createProviderClient } from "./providerClient"
import { providerTransportConfig, languageProviderRequest } from "./providerLanguageTransport"
import { PassThrough } from "node:stream"
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  Trace
} from "../../server/node_modules/vscode-languageserver-protocol/node.js"
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
  it.each(["provider", "basicHeader", "basic"] as const)(
    "keeps credential components out of serialized responses and verbose RPC traces (%s)",
    async kind => {
      const secrets = [
        "PRIVATE_BEARER_TOKEN",
        "PRIVATE_COOKIE_VALUE",
        "PRIVATE_HEADER_VALUE",
        "PRIVATE_BASIC_TOKEN",
        'PRIVATE_PASSWORD_"quoted'
      ]
      const owner: ProvidedConnection = {
        ...connection,
        auth:
          kind === "basic"
            ? { kind, password: secrets[4] }
            : {
                kind: "provider",
                getHeaders: async () => ({
                  Authorization:
                    kind === "basicHeader" ? `Basic ${secrets[3]}` : `Bearer ${secrets[0]}`,
                  Cookie: `gateway=${secrets[1]}; short=abc`,
                  "X-Private": secrets[2],
                  "X-Short": "short",
                  "X-Empty": ""
                })
              }
      }
      providedConnections.set("osd", owner)
      const host = createProviderClient(owner)
      vi.mocked(getOrCreateClient).mockResolvedValue(host)
      const upstream = new PassThrough(),
        downstream = new PassThrough()
      const wire: string[] = [],
        traces: string[] = []
      for (const stream of [upstream, downstream])
        stream.on("data", data => wire.push(data.toString()))
      const sender = createMessageConnection(
        new StreamMessageReader(downstream),
        new StreamMessageWriter(upstream)
      )
      const receiver = createMessageConnection(
        new StreamMessageReader(upstream),
        new StreamMessageWriter(downstream)
      )
      const tracer = { log: (message: string, data?: string) => traces.push(message, data ?? "") }
      sender.trace(Trace.Verbose, tracer)
      receiver.trace(Trace.Verbose, tracer)
      receiver.onRequest(Methods.providerRequest, providerProtocolHandler(languageProviderRequest))
      sender.listen()
      receiver.listen()
      try {
        const exposed =
          kind === "basic"
            ? [secrets[4]]
            : [kind === "basicHeader" ? secrets[3] : secrets[0], ...secrets.slice(1, 3)]
        request.mockResolvedValueOnce({
          ...ok(exposed.join(" ") + " short abc"),
          statusText: exposed.join(" "),
          headers: { Echo: exposed.join(" ") }
        })
        const payload = {
          id: "osd",
          session: providerTransportConfig("osd")!.session,
          options: { url: "/sap/bc/adt/test" }
        }
        const result = await sender.sendRequest(Methods.providerRequest, payload)
        expect(JSON.stringify(result)).toContain("[redacted]")
        expect(JSON.stringify(result)).toContain("short abc")
        expect(traces.join(" ")).toContain("[redacted]")
        for (const secret of exposed)
          for (const output of [JSON.stringify(result), wire.join(""), traces.join(" ")]) {
            expect(output).not.toContain(secret)
            expect(output).not.toContain(JSON.stringify(secret).slice(1, -1))
          }
        receiver.onRequest(
          "echo",
          providerProtocolHandler((params: unknown) => params)
        )
        // Model an editor/source payload returning to the server after an echoed response.
        const echo = await providerProtocolMiddleware.sendRequest!(
          "echo",
          { source: exposed.join(" ") },
          undefined,
          (_type, params) => sender.sendRequest("echo", params)
        )
        expect(JSON.stringify(echo)).toContain("[redacted]")
        const notified = new Promise<unknown>(resolve =>
          receiver.onNotification("echoNotify", resolve)
        )
        await providerProtocolMiddleware.sendNotification!(
          "echoNotify",
          (_type, params) => sender.sendNotification("echoNotify", params),
          { source: exposed.join(" ") }
        )
        expect(JSON.stringify(await notified)).toContain("[redacted]")
        receiver.onRequest(
          "handlerError",
          providerProtocolHandler(() => {
            throw new Error(exposed.join(" "))
          })
        )
        await expect(sender.sendRequest("handlerError")).rejects.toThrow(/redacted/)
        request.mockRejectedValueOnce(new Error(exposed.join(" ")))
        const failure = await sender.sendRequest(Methods.providerRequest, payload)
        expect(failure).toHaveProperty("failure")
        for (const secret of exposed)
          for (const output of [wire.join(""), traces.join(" ")]) {
            expect(output).not.toContain(secret)
            expect(output).not.toContain(JSON.stringify(secret).slice(1, -1))
          }
      } finally {
        sender.dispose()
        receiver.dispose()
        upstream.destroy()
        downstream.destroy()
      }
    }
  )
  it("renews an expired provider language session once and keeps an unchanged snapshot usable", async () => {
    const { server } = await setup()
    await server.login()
    const expired = {
      status: 403,
      statusText: "Forbidden",
      body: "expired",
      headers: { "x-csrf-token": "Required" }
    }
    const completion = () =>
      server.codeCompletion("/sap/bc/adt/programs/programs/ztest/source/main", "WR", 1, 2)
    const result = ok(
      "<asx:abap><asx:values><DATA><SCC_COMPLETION><IDENTIFIER>WRITE</IDENTIFIER></SCC_COMPLETION></DATA></asx:values></asx:abap>"
    )
    for (let attempt = 0; attempt < 2; attempt++) {
      request.mockClear()
      request
        .mockResolvedValueOnce(expired)
        .mockResolvedValueOnce(ok())
        .mockResolvedValueOnce(result)
      expect((await completion())[0].IDENTIFIER).toBe("WRITE")
      expect(request).toHaveBeenCalledTimes(3)
      expect(request.mock.calls[1][0].url).toBe("/sap/bc/adt/compatibility/graph")
      expect(await clientFromKey("osd")).toBe(server)
    }
    request.mockClear()
    request.mockResolvedValue(expired)
    await expect(completion()).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(2)
  })
  it("stops CSRF renewal when the provider is withdrawn", async () => {
    const { server, cancellation } = await setup()
    await server.login()
    request.mockClear()
    request.mockImplementationOnce(async () => {
      providedConnections.delete("osd")
      cancellation.abort()
      return {
        status: 403,
        statusText: "Forbidden",
        body: "",
        headers: { "x-csrf-token": "Required" }
      }
    })
    await expect(server.codeCompletion("/sap/bc/adt/test", "WR", 1, 2)).rejects.toThrow(/withdrawn/)
    expect(request).toHaveBeenCalledOnce()
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
