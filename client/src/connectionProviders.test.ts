import { beforeEach, describe, it, expect, vi } from "vitest"
import {
  registerProvider,
  providedConnections,
  onProvidersChanged,
  type ProvidedConnection
} from "./connectionProviders"
const connection: ProvidedConnection = {
  id: "osd",
  name: "OSD",
  url: "http://127.0.0.1:5000",
  user: "developer",
  client: "001",
  language: "EN",
  auth: { kind: "basic", password: "" }
}
beforeEach(() => providedConnections.clear())
describe("connection providers", () => {
  it("rejects IDs colliding with settings or within a snapshot", () => {
    expect(() =>
      registerProvider({ getConnections: () => [connection] }, () => ["OSD"], vi.fn())
    ).toThrow(/already in use/)
    expect(() =>
      registerProvider(
        { getConnections: () => [connection, { ...connection, id: "OSD" }] },
        () => [],
        vi.fn()
      )
    ).toThrow(/already in use/)
    expect(providedConnections.size).toBe(0)
  })
  it.each([
    "https://user:secret@example.com",
    "http://127.0.0.1?token=secret",
    "invalid-secret",
    "file:///tmp/system"
  ])("rejects unsafe URLs without echoing credentials: %s", url => {
    expect(() =>
      registerProvider({ getConnections: () => [{ ...connection, url }] }, () => [], vi.fn())
    ).toThrow(/Invalid provider/)
    try {
      registerProvider({ getConnections: () => [{ ...connection, url }] }, () => [], vi.fn())
    } catch (e) {
      expect(String(e)).not.toContain("secret")
    }
  })
  it("keeps the last valid snapshot after invalid refresh, and removes withdrawn connections", () => {
    let refresh!: () => void
    let snapshot = [connection]
    const remove = vi.fn(),
      changed = vi.fn()
    const sub = onProvidersChanged(changed)
    const registration = registerProvider(
      {
        getConnections: () => snapshot,
        onDidChange: listener => {
          refresh = listener
          return { dispose() {} }
        }
      },
      () => [],
      remove
    )
    snapshot = [connection, connection]
    expect(refresh).toThrow(/already in use/)
    expect(providedConnections.size).toBe(1)
    expect(remove).not.toHaveBeenCalled()
    snapshot = []
    refresh()
    expect(providedConnections.size).toBe(0)
    expect(remove).toHaveBeenCalledExactlyOnceWith("osd")
    expect(changed).toHaveBeenCalledTimes(2)
    registration.dispose()
    refresh()
    sub.dispose()
  })
})
