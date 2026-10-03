import { afterEach, describe, it, expect, vi } from "vitest"
import type { ProvidedConnection } from "./connectionProviders"

const { request, extensionLog, telemetry, communicationLog } = vi.hoisted(() => ({
  extensionLog: Object.assign(vi.fn(), { debug: vi.fn() }),
  telemetry: vi.fn(),
  communicationLog: vi.fn(),
  request: vi.fn(async (_options: unknown) => ({
    body: "",
    status: 200,
    statusText: "OK",
    headers: { "x-csrf-token": "token" } as Record<string, string | string[]>
  }))
}))
vi.mock("./lib", () => ({ log: extensionLog }))
vi.mock("./services/telemetry", () => ({ logTelemetry: telemetry }))
vi.mock("./adt/adtCommLog", () => ({
  CallLogger: { get: () => ({ add: communicationLog }) }
}))
vi.mock("./providerTransport", async importOriginal => ({
  ...(await importOriginal<typeof import("./providerTransport")>()),
  ProviderTransport: class {
    request = request
  }
}))
import { session_types, isCsrfError } from "abap-adt-api"
import { createProviderClient } from "./providerClient"

const connection: ProvidedConnection = {
  id: "osd",
  name: "Local ABAP",
  url: "http://127.0.0.1:5000",
  user: "developer",
  client: "001",
  language: "EN",
  auth: { kind: "basic", password: "secret" }
}

describe("provider ADT transport", () => {
  afterEach(() => vi.restoreAllMocks())
  it("uses fresh headers on each request for both sessions without basic auth", async () => {
    request.mockClear()
    const getHeaders = vi.fn(async () => ({
      Authorization: `Bearer token-${getHeaders.mock.calls.length}`
    }))
    const client = createProviderClient({ ...connection, auth: { kind: "provider", getHeaders } })
    expect(client.baseUrl).toBe(connection.url)
    expect(client.statelessClone.baseUrl).toBe(connection.url)
    expect(client.statelessClone.statelessClone).toBe(client.statelessClone)
    await client.login()
    await client.statelessClone.login()
    expect(getHeaders).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[0][0]).toMatchObject({
      auth: undefined,
      headers: { Authorization: "Bearer token-1" }
    })
    expect(request.mock.calls[1][0]).toMatchObject({
      auth: undefined,
      headers: { Authorization: "Bearer token-2" }
    })
    await client.logout()
    await client.statelessClone.logout()
  })
  it.each(["status", "response", "returned"])(
    "refreshes headers once after a 401 (%s)",
    async shape => {
      request.mockClear()
      if (shape === "returned")
        request.mockResolvedValueOnce({
          status: 401,
          body: "expired",
          headers: {},
          statusText: "Unauthorized"
        })
      else
        request.mockRejectedValueOnce(
          shape === "status" ? { status: 401 } : { response: { status: 401 } }
        )
      const getHeaders = vi.fn(async () => ({
        Authorization: `Bearer token-${getHeaders.mock.calls.length}`
      }))
      const client = createProviderClient({ ...connection, auth: { kind: "provider", getHeaders } })
      await client.login()
      expect(getHeaders).toHaveBeenCalledTimes(2)
      expect(request).toHaveBeenCalledTimes(2)
      expect(request.mock.calls[1][0]).toMatchObject({
        auth: undefined,
        headers: { Authorization: "Bearer token-2" }
      })
      await client.logout()
    }
  )
  it("fails cleanly after a second 401 without leaking headers to errors or logging", async () => {
    request.mockClear()
    const logs = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "debug")
    ]
    const token = "PRIVATE-PER-START-TOKEN"
    const getHeaders = vi.fn(async () => ({ Authorization: token, "X-Local-Token": token }))
    request.mockRejectedValueOnce({
      status: 401,
      message: token,
      config: { headers: { Authorization: token } }
    })
    request.mockResolvedValueOnce({
      status: 401,
      body: token,
      statusText: token,
      headers: { Authorization: token }
    })
    const client = createProviderClient({ ...connection, auth: { kind: "provider", getHeaders } })
    const failure = await client.login().catch(error => error)
    expect(String(failure)).toContain("ADT request failed for provider connection osd")
    expect(String(failure)).not.toContain(token)
    expect(JSON.stringify(failure)).not.toContain(token)
    expect(getHeaders).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenCalledTimes(2)
    for (const logger of [...logs, extensionLog, extensionLog.debug, telemetry, communicationLog])
      expect(logger).not.toHaveBeenCalled()
    expect(Reflect.get(client, "debugCallback")).toBeUndefined()
    expect(Reflect.get(client.statelessClone, "debugCallback")).toBeUndefined()
  })
  it.each([false, true])("redacts malformed successful responses (clone=%s)", async clone => {
    const token = "PRIVATE-ECHOED-TOKEN"
    const logs = [
      vi.spyOn(console, "error"),
      vi.spyOn(console, "log"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "debug")
    ]
    const client = createProviderClient({
      ...connection,
      auth: { kind: "provider", getHeaders: async () => ({ Authorization: token }) }
    })
    const session = clone ? client.statelessClone : client
    await session.login()
    request.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      headers: {},
      body: `<customizing><exemption><reasons><reason id="test" title="test" justificationMandatory="${token}"/></reasons></exemption></customizing>`
    })
    const failure = await session.atcCustomizing().catch(error => error)
    expect(failure).toBeInstanceOf(Error)
    for (const value of [failure.message, failure.stack, JSON.stringify(failure)])
      expect(value).not.toContain(token)
    for (const logger of [...logs, extensionLog, extensionLog.debug, telemetry, communicationLog])
      expect(logger).not.toHaveBeenCalled()
  })
  it("preserves session expiry classification and recovers a stateless session", async () => {
    const client = createProviderClient({
      ...connection,
      auth: { kind: "provider", getHeaders: async () => ({ Authorization: "PRIVATE-CSRF-TOKEN" }) }
    })
    await client.login()
    request.mockClear()
    const expired = {
      status: 403,
      statusText: "PRIVATE-CSRF-TOKEN",
      body: "PRIVATE-CSRF-TOKEN",
      headers: { "x-csrf-token": "Required", Authorization: "PRIVATE-CSRF-TOKEN" }
    }
    await client.statelessClone.login()
    request.mockClear()
    request.mockResolvedValueOnce(expired)
    request.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      body: "",
      headers: { "x-csrf-token": "renewed" }
    })
    request.mockResolvedValueOnce({ status: 200, statusText: "OK", body: "source", headers: {} })
    expect(
      await client.statelessClone.getObjectSource("/sap/bc/adt/programs/programs/ztest/source/main")
    ).toBe("source")
    expect(request).toHaveBeenCalledTimes(3)
    client.stateful = session_types.stateful
    request.mockResolvedValueOnce(expired)
    const failure = await client
      .getObjectSource("/sap/bc/adt/programs/programs/ztest/source/main")
      .catch(error => error)
    expect(isCsrfError(failure)).toBe(true)
    expect(failure.status).toBe(403)
    expect(failure.response.headers).toEqual({ "x-csrf-token": "Required" })
    expect(failure.parent).toBeUndefined()
    expect(JSON.stringify(failure)).not.toContain("PRIVATE-CSRF-TOKEN")
    expect(failure.stack).not.toContain("PRIVATE-CSRF-TOKEN")
  })
  it("does not retry non-401 failures or basic authentication", async () => {
    const getHeaders = vi.fn(async () => ({ Authorization: "secret" }))
    request.mockRejectedValueOnce({ status: 403, message: "secret" })
    await expect(
      createProviderClient({ ...connection, auth: { kind: "provider", getHeaders } }).login()
    ).rejects.toThrow(/ADT request failed/)
    expect(getHeaders).toHaveBeenCalledOnce()
    request.mockClear()
    request.mockRejectedValueOnce({ status: 401 })
    await expect(createProviderClient(connection).login()).rejects.toThrow(/ADT request failed/)
    expect(request).toHaveBeenCalledOnce()
  })
  it("cancels both sessions while headers never settle and prevents a late send", async () => {
    request.mockClear()
    let finish!: (headers: Record<string, string>) => void
    const getHeaders = vi.fn(
      () =>
        new Promise<Record<string, string>>(resolve => {
          finish = resolve
        })
    )
    const cancellation = new AbortController()
    const client = createProviderClient(
      { ...connection, auth: { kind: "provider", getHeaders } },
      cancellation.signal
    )
    const login = client.login()
    const cloneLogin = client.statelessClone.login()
    const rejected = Promise.all([
      expect(login).rejects.toThrow(/ADT request failed/),
      expect(cloneLogin).rejects.toThrow(/ADT request failed/)
    ])
    await vi.waitFor(() => expect(getHeaders).toHaveBeenCalledTimes(2))
    cancellation.abort()
    await rejected
    finish({ Authorization: "late-token" })
    await Promise.resolve()
    await expect(client.login()).rejects.toThrow(/ADT request failed/)
    await expect(client.statelessClone.login()).rejects.toThrow(/ADT request failed/)
    expect(request).not.toHaveBeenCalled()
    expect(getHeaders).toHaveBeenCalledTimes(2)
  })
  it("supports explicit basic credentials including an empty local password", async () => {
    request.mockClear()
    const client = createProviderClient({ ...connection, auth: { kind: "basic", password: "" } })
    await client.login()
    expect(request.mock.calls[0][0]).toMatchObject({
      auth: { username: "developer", password: "" }
    })
    await client.logout()
  })
  it("combines provider cookies with ADT session cookies and protects stateless clones", async () => {
    request.mockClear()
    request.mockResolvedValueOnce({
      body: "",
      status: 200,
      statusText: "OK",
      headers: { "x-csrf-token": "token", "set-cookie": ["SAP_SESSION=adt; Path=/"] }
    } as never)
    const client = createProviderClient({
      ...connection,
      auth: { kind: "provider", getHeaders: async () => ({ cookie: "gateway=auth" }) }
    })
    await client.login()
    await client.logout()
    expect(request.mock.calls[1][0]).toMatchObject({
      headers: { Cookie: "SAP_SESSION=adt; gateway=auth" }
    })
    expect(() => {
      client.statelessClone.stateful = session_types.stateful
    }).toThrow(/Stateless|stateless/)
  })
  it("redacts failed header callbacks and HTTP errors", async () => {
    const client = createProviderClient({
      ...connection,
      auth: {
        kind: "provider",
        getHeaders: async () => {
          throw new Error("Authorization: secret")
        }
      }
    })
    await expect(client.login()).rejects.toThrow("ADT request failed for provider connection osd")
    request.mockRejectedValueOnce(new Error("password=secret"))
    await expect(createProviderClient(connection).login()).rejects.toThrow(
      "ADT request failed for provider connection osd"
    )
  })
})
