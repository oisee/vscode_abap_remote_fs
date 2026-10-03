import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createProviderClient } from "./providerClient"

it("aborts an in-flight HTTP login on withdrawal", async () => {
  let received!: () => void
  const started = new Promise<void>(resolve => {
    received = resolve
  })
  let closed!: () => void
  const disconnected = new Promise<void>(resolve => {
    closed = resolve
  })
  const server = createServer(request => {
    received()
    request.on("close", closed)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const cancellation = new AbortController()
  try {
    const client = createProviderClient(
      {
        id: "osd",
        name: "OSD",
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        user: "developer",
        client: "001",
        language: "EN",
        auth: { kind: "provider", getHeaders: async () => ({ Authorization: "test-token" }) }
      },
      cancellation.signal
    )
    const login = expect(client.login()).rejects.toThrow(/ADT request failed/)
    await started
    cancellation.abort()
    await login
    await disconnected
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
