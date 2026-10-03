import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("vscode", () => {
  class Uri {
    constructor(
      public scheme: string,
      public authority: string,
      public path: string,
      public query = "",
      public fragment = ""
    ) {}
    static parse(value: string) {
      const u = new URL(value, "relative://placeholder")
      return new Uri(
        value.startsWith("/") ? "" : u.protocol.slice(0, -1),
        value.startsWith("/") ? "" : u.host,
        u.pathname,
        u.search.slice(1),
        u.hash.slice(1)
      )
    }
    with(changes: Partial<Uri>) {
      return Object.assign(
        new Uri(this.scheme, this.authority, this.path, this.query, this.fragment),
        changes
      )
    }
    toString() {
      return `${this.scheme}://${this.authority}${this.path}${this.query ? `?${this.query}` : ""}${this.fragment ? `#${this.fragment}` : ""}`
    }
  }
  class EventEmitter<T> {
    listeners = new Set<(value: T) => void>()
    event = (listener: (value: T) => void) => {
      this.listeners.add(listener)
      return { dispose: () => this.listeners.delete(listener) }
    }
    fire(value: T) {
      for (const listener of this.listeners) listener(value)
    }
  }
  return {
    Uri,
    EventEmitter,
    workspace: {
      getConfiguration: vi.fn(() => ({ remote: {} })),
      workspaceFolders: [],
      updateWorkspaceFolders: vi.fn(() => true),
      openTextDocument: vi.fn(async uri => ({ uri }))
    },
    window: { showTextDocument: vi.fn(), showInputBox: vi.fn(), showErrorMessage: vi.fn() }
  }
})
vi.mock("./adt/AdtTransports", () => ({ transportValidators: [] }))
vi.mock("./config", () => ({ RemoteManager: { get: () => ({ forget: vi.fn() }) } }))
vi.mock("./adt/conections", () => ({
  getOrCreateRoot: vi.fn(),
  getClient: vi.fn(),
  clientIsConnected: vi.fn(() => true),
  disconnectConnection: vi.fn(async () => undefined)
}))
vi.mock("abapfs", () => ({ isAbapFile: vi.fn(() => true) }))
vi.mock("./adt/operations/AdtObjectFinder", () => ({
  AdtObjectFinder: vi.fn(
    class {
      vscodeRange = vi.fn(async () => ({ uri: "adt://osd/package/ztest.abap" }))
    }
  )
}))
vi.mock("./adt/includes/service", () => ({ IncludeService: { forget: vi.fn() } }))
vi.mock("./adt/operations/AdtObjectActivator", () => ({ AdtObjectActivator: { forget: vi.fn() } }))
vi.mock("./adt/operations/UnitTestRunner", () => ({
  UnitTestRunner: {
    get: vi.fn(() => ({ addResultsWithReturn: vi.fn(async () => ({ allPassed: true })) })),
    forget: vi.fn()
  }
}))

import { Uri, workspace, window } from "vscode"
import { api } from "./api"
import { transportValidators } from "./adt/AdtTransports"
import {
  getOrCreateRoot,
  getClient,
  clientIsConnected,
  disconnectConnection
} from "./adt/conections"
import { connected, disconnected, savedObject, activatedObject, objectEvent } from "./apiEvents"
import { providedConnections, type ProvidedConnection } from "./connectionProviders"
import { AdtObjectFinder } from "./adt/operations/AdtObjectFinder"
import { isAbapFile } from "abapfs"
import { UnitTestRunner } from "./adt/operations/UnitTestRunner"
import type { AbapObject } from "abapobject"

const connection: ProvidedConnection = {
  id: "OSD",
  name: "Local ABAP",
  url: "http://127.0.0.1:5000",
  client: "001",
  language: "EN",
  user: "developer",
  auth: { kind: "basic", password: "secret" }
}
beforeEach(() => {
  vi.clearAllMocks()
  providedConnections.clear()
  vi.mocked(clientIsConnected).mockReturnValue(true)
  vi.mocked(isAbapFile).mockReturnValue(true)
  vi.mocked(getOrCreateRoot).mockResolvedValue({
    getNodeAsync: vi.fn(async () => ({
      object: {
        loadStructure: vi.fn(),
        contentsPath: () => "/sap/bc/adt/programs/programs/ztest/source/main"
      }
    }))
  } as never)
})

describe("AbapFsApi v2", () => {
  it("retains validator registration, deduplication and disposal", () => {
    expect(api.version).toBe(2)
    const validator = vi.fn(async () => true)
    const disposable = api.registerTransportValidator(validator)
    api.registerTransportValidator(validator)
    expect(transportValidators.filter(v => v === validator)).toHaveLength(1)
    disposable.dispose()
    disposable.dispose()
    expect(transportValidators).not.toContain(validator)
  })
  it("registers, refreshes and disposes transient connections without writing settings", () => {
    let refresh: (() => void) | undefined
    let snapshot = [connection]
    const unsubscribe = vi.fn()
    const registration = api.registerConnectionProvider({
      getConnections: () => snapshot,
      onDidChange: listener => {
        refresh = listener
        return { dispose: unsubscribe }
      }
    })
    expect(providedConnections.get("osd")?.name).toBe("Local ABAP")
    refresh!()
    expect(disconnectConnection).not.toHaveBeenCalled()
    snapshot = [{ ...connection, url: "http://127.0.0.1:5001" }]
    refresh!()
    expect(disconnectConnection).toHaveBeenCalledWith("osd")
    registration.dispose()
    registration.dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(providedConnections.size).toBe(0)
  })
  it("automatically mounts active snapshots, reconnects changes and withdraws without prompts or settings writes", async () => {
    let refresh!: () => void
    let snapshot: ProvidedConnection[] = []
    const update = vi.fn()
    vi.mocked(workspace.getConfiguration).mockReturnValue({ remote: {}, update } as never)
    const registration = api.registerConnectionProvider({
      getConnections: () => snapshot,
      onDidChange: listener => {
        refresh = listener
        return { dispose() {} }
      }
    })
    snapshot = [{ ...connection, autoConnect: true }]
    refresh()
    refresh()
    await vi.waitFor(() => expect(workspace.updateWorkspaceFolders).toHaveBeenCalledOnce())
    expect(getOrCreateRoot).toHaveBeenCalledOnce()
    snapshot = [{ ...snapshot[0], url: "http://127.0.0.1:5001" }]
    refresh()
    await vi.waitFor(() => expect(getOrCreateRoot).toHaveBeenCalledTimes(2))
    expect(disconnectConnection).toHaveBeenCalledOnce()
    snapshot = []
    refresh()
    await Promise.resolve()
    expect(providedConnections.size).toBe(0)
    expect(disconnectConnection).toHaveBeenCalledTimes(2)
    expect(window.showInputBox).not.toHaveBeenCalled()
    expect(window.showErrorMessage).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    registration.dispose()
  })
  it("auto-connects initial snapshots and safely swallows failed automatic logins", async () => {
    vi.mocked(getOrCreateRoot).mockRejectedValueOnce(new Error("provider failure"))
    const registration = api.registerConnectionProvider({
      getConnections: () => [{ ...connection, autoConnect: true }]
    })
    await vi.waitFor(() => expect(getOrCreateRoot).toHaveBeenCalledOnce())
    expect(workspace.updateWorkspaceFolders).not.toHaveBeenCalled()
    expect(window.showErrorMessage).not.toHaveBeenCalled()
    registration.dispose()
  })
  it("does not mount a connection withdrawn during automatic login", async () => {
    let finish!: (value: never) => void
    vi.mocked(getOrCreateRoot).mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve
      })
    )
    const registration = api.registerConnectionProvider({
      getConnections: () => [{ ...connection, autoConnect: true }]
    })
    await vi.waitFor(() => expect(getOrCreateRoot).toHaveBeenCalledOnce())
    registration.dispose()
    vi.mocked(clientIsConnected).mockReturnValue(false)
    finish({} as never)
    await vi.waitFor(() => expect(disconnectConnection).toHaveBeenCalledOnce())
    expect(workspace.updateWorkspaceFolders).not.toHaveBeenCalled()
  })
  it("leaves connections without autoConnect idle on provider events", async () => {
    const registration = api.registerConnectionProvider({ getConnections: () => [connection] })
    await Promise.resolve()
    expect(getOrCreateRoot).not.toHaveBeenCalled()
    registration.dispose()
  })
  it("unmounts multiple withdrawn provider roots in one workspace edit", async () => {
    const folders = [
      { uri: Uri.parse("adt://osd"), name: "OSD", index: 0 },
      { uri: Uri.parse("adt://osd-two"), name: "OSD two", index: 1 },
      { uri: Uri.parse("file:///workspace"), name: "Workspace", index: 2 }
    ]
    Object.defineProperty(workspace, "workspaceFolders", { value: folders, configurable: true })
    const registration = api.registerConnectionProvider({
      getConnections: () => [connection, { ...connection, id: "osd-two" }]
    })
    registration.dispose()
    await Promise.resolve()
    expect(workspace.updateWorkspaceFolders).toHaveBeenCalledExactlyOnceWith(0, 3, folders[2])
    Object.defineProperty(workspace, "workspaceFolders", { value: [], configurable: true })
  })
  it("rejects colliding registrations atomically", () => {
    const registration = api.registerConnectionProvider({ getConnections: () => [connection] })
    expect(() =>
      api.registerConnectionProvider({
        getConnections: () => [{ ...connection, id: "other" }, connection]
      })
    ).toThrow(/already in use/)
    expect(providedConnections.has("other")).toBe(false)
    registration.dispose()
  })
  it("mounts once for concurrent connects and reports actual session state", async () => {
    await Promise.all([api.connect("OSD"), api.connect("osd")])
    expect(getOrCreateRoot).toHaveBeenCalledOnce()
    expect(workspace.updateWorkspaceFolders).toHaveBeenCalledOnce()
    expect(api.isConnected("osd")).toBe(true)
    vi.mocked(clientIsConnected).mockReturnValue(false)
    expect(api.isConnected("osd")).toBe(false)
  })
  it("rejects failed connections and failed workspace mounts", async () => {
    vi.mocked(getOrCreateRoot).mockRejectedValueOnce(new Error("login failed"))
    await expect(api.connect("osd")).rejects.toThrow("login failed")
    expect(workspace.updateWorkspaceFolders).not.toHaveBeenCalled()
    vi.mocked(workspace.updateWorkspaceFolders).mockReturnValueOnce(false)
    await expect(api.connect("osd")).rejects.toThrow(/mount/)
  })
  it.each([
    ["connect", connected, api.onDidConnect],
    ["disconnect", disconnected, api.onDidDisconnect]
  ] as const)("publishes %s and supports listener disposal", (_, signal, event) => {
    const listener = vi.fn()
    const sub = event(listener)
    signal.fire("osd")
    sub.dispose()
    signal.fire("osd")
    expect(listener).toHaveBeenCalledExactlyOnceWith("osd")
  })
  it.each([
    [savedObject, api.onDidSaveObject],
    [activatedObject, api.onDidActivate]
  ] as const)("publishes object metadata including includes", (signal, event) => {
    const listener = vi.fn()
    const sub = event(listener)
    const object = {
      name: "ZCL_TEST_CCIMP",
      lockObject: { name: "ZCL_TEST", type: "CLAS/OC" }
    } as AbapObject
    const uri = Uri.parse("adt://osd/package/ztest.abap")
    signal.fire(objectEvent(uri, object))
    expect(listener).toHaveBeenCalledWith({
      connId: "osd",
      uri,
      objectType: "CLAS/OC",
      objectName: "ZCL_TEST",
      include: "ZCL_TEST_CCIMP"
    })
    sub.dispose()
  })
  it("maps FS source URIs to ADT source paths", async () => {
    expect(await api.toAdtUri(Uri.parse("adt://osd/package/ztest.abap#start=3,1"))).toBe(
      "/sap/bc/adt/programs/programs/ztest/source/main#start=3,1"
    )
    await expect(api.toAdtUri(Uri.parse("file:///tmp/test"))).rejects.toThrow(/ABAP FS URI/)
    vi.mocked(isAbapFile).mockReturnValue(false)
    await expect(api.toAdtUri(Uri.parse("adt://osd/package"))).rejects.toThrow(/source file/)
  })
  it.each([
    "/sap/bc/adt/programs/programs/ztest/source/main#start=3,1",
    "http://127.0.0.1:5000/sap/bc/adt/programs/programs/ztest/source/main#start=3,1",
    "adt://SYS/sap/bc/adt/programs/programs/ztest/source/main#start=3,1"
  ])("maps ADT URI %s", async value => {
    const uri = await api.fromAdtUri("OSD", value)
    expect(uri.authority).toBe("osd")
    expect(uri.fragment).toBe("start=3,1")
    expect(AdtObjectFinder).toHaveBeenCalledWith("osd")
  })
  it("rejects non-ADT navigation paths", async () => {
    await expect(api.fromAdtUri("osd", "/sap/public/login")).rejects.toThrow(/ADT object path/)
    await expect(api.fromAdtUri("osd", "file:///sap/bc/adt/test")).rejects.toThrow(/ADT URI/)
  })
  it("opens an exact typed object and rejects missing objects", async () => {
    const searchObject = vi.fn(async () => [
      {
        "adtcore:type": "PROG/P",
        "adtcore:name": "ZTEST",
        "adtcore:uri": "/sap/bc/adt/programs/programs/ztest"
      }
    ])
    vi.mocked(getClient).mockReturnValue({ searchObject } as never)
    expect((await api.openObject("OSD", "PROG/P", "ztest")).authority).toBe("osd")
    expect(searchObject).toHaveBeenCalledWith("ZTEST", "PROG/P")
    expect(window.showTextDocument).toHaveBeenCalledOnce()
    await expect(api.openObject("osd", "CLAS/OC", "ztest")).rejects.toThrow(/not found/)
  })
  it("runs unit tests using the existing result model and rejects a foreign URI", async () => {
    const uri = Uri.parse("adt://osd/package/ztest.abap")
    expect(await api.runUnitTests("OSD", uri)).toEqual({ allPassed: true })
    expect(UnitTestRunner.get).toHaveBeenCalledWith("osd")
    await expect(api.runUnitTests("other", uri)).rejects.toThrow(/this connection/)
  })
})
