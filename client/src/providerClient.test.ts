import { describe, it, expect, vi } from "vitest"
import type { ProvidedConnection } from "./connectionProviders"

const { request } = vi.hoisted(() => ({
  request: vi.fn(async (_options: unknown) => ({
    body: "",
    status: 200,
    statusText: "OK",
    headers: { "x-csrf-token": "token" }
  }))
}))
vi.mock("abap-adt-api/build/AxiosHttpClient.js", () => ({
  AxiosHttpClient: class {
    request = request
  }
}))
import { session_types } from "abap-adt-api"
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
