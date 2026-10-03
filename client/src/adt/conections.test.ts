vi.mock("vscode", () => ({
  EventEmitter: class<T> {
    listeners = new Set<(value: T) => void>()
    event = (listener: (value: T) => void) => {
      this.listeners.add(listener)
      return { dispose: () => this.listeners.delete(listener) }
    }
    fire(value: T) {
      for (const listener of this.listeners) listener(value)
    }
  },
  FileSystemError: {
    FileNotFound: (msg: string) => new Error(`FileNotFound: ${msg}`)
  },
  workspace: {
    workspaceFolders: undefined
  },
  Uri: {
    parse: vi.fn(function (s: string) {
      return {
        scheme: s.split("://")[0],
        authority: s.split("://")[1]?.split("/")[0],
        toString: () => s
      }
    })
  }
}))

vi.mock("../config", () => ({
  RemoteManager: { get: vi.fn() },
  createClient: vi.fn()
}))

vi.mock("./debugger", () => ({ LogOutPendingDebuggers: vi.fn().mockReturnValue([]) }))
vi.mock("../services/sapSystemValidator", () => ({
  SapSystemValidator: {
    getInstance: vi
      .fn()
      .mockReturnValue({ validateSystemAccess: vi.fn().mockResolvedValue(undefined) })
  }
}))
vi.mock("../fs/LocalFsProvider", () => ({
  LocalFsProvider: { useLocalStorage: vi.fn().mockReturnValue(false) }
}))
vi.mock("../lib", () => ({ log: Object.assign(vi.fn(), { debug: vi.fn() }) }))
const { httpRequest, realProviderClient } = vi.hoisted(() => ({
  httpRequest: vi.fn(),
  realProviderClient: {
    create: undefined as typeof import("../providerClient").createProviderClient | undefined
  }
}))
vi.mock("../providerTransport", async importOriginal => ({
  ...(await importOriginal<typeof import("../providerTransport")>()),
  ProviderTransport: class {
    request = httpRequest
  }
}))
vi.mock("../providerClient", async importOriginal => {
  const actual = await importOriginal<typeof import("../providerClient")>()
  realProviderClient.create = actual.createProviderClient
  return { ...actual, createProviderClient: vi.fn() }
})
vi.mock("abapfs", () => ({
  AFsService: class {},
  Root: class {
    lockManager = { dropall: vi.fn(async () => undefined) }
  }
}))

import {
  ADTSCHEME,
  ADTURIPATTERN,
  abapUri,
  getClient,
  getRoot,
  rootIsConnected
} from "./conections"
import * as __$mock_vscode from "vscode"

describe("ADTSCHEME", () => {
  it("is 'adt'", () => {
    expect(ADTSCHEME).toBe("adt")
  })
})

describe("ADTURIPATTERN", () => {
  it("matches ADT URI paths", () => {
    expect(ADTURIPATTERN.test("/sap/bc/adt/programs/programs/zprog")).toBe(true)
    expect(ADTURIPATTERN.test("/sap/bc/adt/classes/classes/zcl_test/source/main")).toBe(true)
  })

  it("does not match non-ADT paths", () => {
    expect(ADTURIPATTERN.test("/some/other/path")).toBe(false)
    expect(ADTURIPATTERN.test("/sap/bc/gui")).toBe(false)
  })
})

describe("abapUri", () => {
  it("returns true for adt:// URIs", () => {
    const uri = { scheme: "adt" } as any
    expect(abapUri(uri)).toBe(true)
  })

  it("returns false for file:// URIs", () => {
    const uri = { scheme: "file" } as any
    expect(abapUri(uri)).toBe(false)
  })

  it("returns false/undefined for undefined", () => {
    expect(abapUri(undefined)).toBeFalsy()
  })

  it("returns false for untitled scheme", () => {
    const uri = { scheme: "untitled" } as any
    expect(abapUri(uri)).toBeFalsy()
  })
})

describe("getClient", () => {
  it("throws when connection not established", () => {
    expect(() => getClient("nonexistent_conn")).toThrow()
  })

  it("throws with helpful message about inaccessible system", () => {
    expect(() => getClient("nonexistent_conn")).toThrow(/not accessible|not found/i)
  })
})

describe("getRoot", () => {
  it("throws FileNotFound when root not established", () => {
    expect(() => getRoot("nonexistent_conn")).toThrow(/FileNotFound/)
  })
})

describe("rootIsConnected", () => {
  it("returns false when workspaceFolders is undefined", () => {
    const { workspace } = __$mock_vscode
    Object.defineProperty(workspace, "workspaceFolders", { value: undefined, configurable: true })
    expect(rootIsConnected("myconn")).toBe(false)
  })

  it("returns false when no matching ADT folder", () => {
    const { workspace } = __$mock_vscode
    Object.defineProperty(workspace, "workspaceFolders", {
      value: [{ uri: { scheme: "file", authority: "myconn" } }],
      configurable: true
    })
    expect(rootIsConnected("myconn")).toBe(false)
  })

  it("returns true when matching ADT folder exists", () => {
    const { workspace } = __$mock_vscode
    Object.defineProperty(workspace, "workspaceFolders", {
      value: [{ uri: { scheme: "adt", authority: "myconn" } }],
      configurable: true
    })
    expect(rootIsConnected("myconn")).toBe(true)
  })

  it("is case-insensitive for connId", () => {
    const { workspace } = __$mock_vscode
    Object.defineProperty(workspace, "workspaceFolders", {
      value: [{ uri: { scheme: "adt", authority: "myconn" } }],
      configurable: true
    })
    expect(rootIsConnected("MYCONN")).toBe(true)
  })
})

import { getOrCreateRoot, clientIsConnected, disconnectConnection, disconnect } from "./conections"
import { RemoteManager, createClient } from "../config"
import { createProviderClient } from "../providerClient"
import { providedConnections, type ProvidedConnection } from "../connectionProviders"
import { connected, disconnected } from "../apiEvents"

describe("connection lifecycle", () => {
  const config = {
    name: "osd",
    url: "http://127.0.0.1:5000",
    username: "developer",
    password: "secret",
    client: "001",
    language: "EN",
    allowSelfSigned: false,
    diff_formatter: "ADT formatter" as const
  }
  const provided: ProvidedConnection = {
    id: "osd",
    name: "OSD",
    url: config.url,
    client: config.client,
    language: config.language,
    user: config.username,
    auth: { kind: "basic", password: "" }
  }
  let client: {
    login: ReturnType<typeof vi.fn>
    logout: ReturnType<typeof vi.fn>
    statelessClone: {
      login: ReturnType<typeof vi.fn>
      logout: ReturnType<typeof vi.fn>
      loggedin: boolean
    }
  }
  beforeEach(async () => {
    await disconnect()
    providedConnections.clear()
    client = {
      login: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
      statelessClone: {
        login: vi.fn(async () => undefined),
        logout: vi.fn(async () => undefined),
        loggedin: true
      }
    }
    vi.mocked(createClient).mockReturnValue(client as never)
    vi.mocked(createProviderClient).mockReturnValue(client as never)
    vi.mocked(RemoteManager.get).mockReturnValue({ byIdAsync: vi.fn(async () => config) } as never)
  })
  afterEach(async () => {
    await disconnect()
    providedConnections.clear()
  })
  it("deduplicates login and fires lifecycle events once", async () => {
    const onConnect = vi.fn(),
      onDisconnect = vi.fn()
    const a = connected.event(onConnect),
      b = disconnected.event(onDisconnect)
    const [root, same] = await Promise.all([getOrCreateRoot("OSD"), getOrCreateRoot("osd")])
    expect(root).toBe(same)
    expect(client.login).toHaveBeenCalledOnce()
    expect(onConnect).toHaveBeenCalledExactlyOnceWith("osd")
    expect(clientIsConnected("OSD")).toBe(true)
    await disconnectConnection("OSD")
    expect(clientIsConnected("osd")).toBe(false)
    expect(() => getRoot("osd")).toThrow()
    expect(client.logout).toHaveBeenCalledOnce()
    expect(client.statelessClone.logout).toHaveBeenCalledOnce()
    expect(onDisconnect).toHaveBeenCalledExactlyOnceWith("osd")
    await getOrCreateRoot("osd")
    expect(client.login).toHaveBeenCalledTimes(2)
    a.dispose()
    b.dispose()
  })
  it("cancels an in-flight provider login and never publishes its root", async () => {
    providedConnections.set("osd", provided)
    let finish!: () => void
    let started!: () => void
    const starting = new Promise<void>(resolve => {
      started = resolve
    })
    client.login.mockImplementation(() => {
      started()
      return new Promise<void>(resolve => {
        finish = resolve
      })
    })
    const creation = getOrCreateRoot("osd")
    const failure = expect(creation).rejects.toThrow(/withdrawn|Unable to connect/)
    await starting
    providedConnections.delete("osd")
    const removal = disconnectConnection("osd")
    await removal
    await failure
    finish()
    await Promise.resolve()
    expect(clientIsConnected("osd")).toBe(false)
    expect(() => getRoot("osd")).toThrow()
    expect(client.statelessClone.login).not.toHaveBeenCalled()
  })
  it("authenticates provider headers without asking for or saving passwords", async () => {
    const askPassword = vi.fn(),
      savePassword = vi.fn()
    const getHeaders = async () => ({ "X-Local-Token": "PRIVATE-PER-START-TOKEN" })
    providedConnections.set("osd", { ...provided, auth: { kind: "provider", getHeaders } })
    vi.mocked(RemoteManager.get).mockReturnValue({
      byIdAsync: vi.fn(async () => ({ ...config, password: "" })),
      askPassword,
      savePassword
    } as never)
    await getOrCreateRoot("osd")
    expect(createProviderClient).toHaveBeenCalledWith(
      providedConnections.get("osd"),
      expect.any(AbortSignal)
    )
    expect(askPassword).not.toHaveBeenCalled()
    expect(savePassword).not.toHaveBeenCalled()
    expect(client.login).toHaveBeenCalledOnce()
    expect(client.statelessClone.login).toHaveBeenCalledOnce()
  })
  it.each(["basic", "provider"] as const)(
    "sends retired-session teardown after cancelling ordinary requests (%s)",
    async kind => {
      const getHeaders = vi.fn(async () => ({ Authorization: "Bearer PRIVATE_TEARDOWN_TOKEN" }))
      const owner: ProvidedConnection = {
        ...provided,
        auth: kind === "basic" ? { kind, password: "PRIVATE_PASSWORD" } : { kind, getHeaders }
      }
      providedConnections.set("osd", owner)
      vi.mocked(createProviderClient).mockImplementation(realProviderClient.create!)
      httpRequest.mockReset().mockResolvedValue({
        status: 200,
        statusText: "OK",
        body: "",
        headers: {
          "x-csrf-token": "retired-csrf",
          "set-cookie": ["SAP_SESSION=retired-session; Path=/"]
        }
      })
      await getOrCreateRoot("osd")
      const retired = getClient("osd", false)
      httpRequest.mockClear()
      // Ordinary requests stay pending until the shared signal is aborted.
      httpRequest.mockImplementationOnce(() => new Promise(() => {}))
      const operation = retired.getObjectSource("/sap/bc/adt/programs/programs/ztest/source/main")
      const cancelled = expect(operation).rejects.toThrow()
      await vi.waitFor(() => expect(httpRequest).toHaveBeenCalledOnce())
      providedConnections.delete("osd")
      await disconnectConnection("osd")
      await cancelled
      const calls = httpRequest.mock.calls.slice(1)
      expect(calls.map(([options]) => options.url)).toEqual([
        "/sap/bc/adt/compatibility/graph",
        "/sap/public/bc/icf/logoff",
        "/sap/public/bc/icf/logoff"
      ])
      for (const [options, signal] of calls) {
        expect(options.headers.Cookie).toContain("SAP_SESSION=retired-session")
        expect(options.headers["x-csrf-token"]).toBe("retired-csrf")
        expect(options.timeout).toBe(3000)
        expect(signal).not.toBe(vi.mocked(createProviderClient).mock.calls.at(-1)![1])
        if (kind === "basic") expect(options.auth.password).toBe("PRIVATE_PASSWORD")
        else expect(options.headers.Authorization).toBe("Bearer PRIVATE_TEARDOWN_TOKEN")
      }
      if (kind === "provider") expect(getHeaders).toHaveBeenCalledTimes(3)
      httpRequest.mockClear()
      await expect(retired.getObjectSource("/sap/bc/adt/test")).rejects.toThrow()
      expect(httpRequest).not.toHaveBeenCalled()
    }
  )
  it("bounds hung remote teardown and aborts its separate transport after three seconds", async () => {
    providedConnections.set("osd", provided)
    vi.mocked(createProviderClient).mockImplementation(realProviderClient.create!)
    httpRequest.mockReset().mockResolvedValue({
      status: 200,
      statusText: "OK",
      body: "",
      headers: { "x-csrf-token": "csrf" }
    })
    await getOrCreateRoot("osd")
    httpRequest.mockClear().mockImplementation(() => new Promise(() => {}))
    vi.useFakeTimers()
    try {
      const settled = vi.fn()
      const removal = disconnectConnection("osd").then(settled)
      await vi.advanceTimersByTimeAsync(0)
      expect(httpRequest).toHaveBeenCalledTimes(3)
      expect(clientIsConnected("osd")).toBe(false)
      const signals = httpRequest.mock.calls.map(([, signal]) => signal as AbortSignal)
      expect(signals.every(signal => !signal.aborted)).toBe(true)
      await vi.advanceTimersByTimeAsync(2999)
      expect(settled).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(signals.every(signal => signal.aborted)).toBe(true)
      await removal
    } finally {
      vi.useRealTimers()
    }
  })
  it("invalidates the transport after a failed provider login", async () => {
    providedConnections.set("osd", provided)
    client.statelessClone.login.mockRejectedValueOnce(new Error("failed"))
    await expect(getOrCreateRoot("osd")).rejects.toThrow(/Unable to connect/)
    const signal = vi.mocked(createProviderClient).mock.calls.at(-1)?.[1]
    expect(signal?.aborted).toBe(true)
  })
  it("uses transient authentication and cleans up failed logins", async () => {
    providedConnections.set("osd", provided)
    client.statelessClone.login.mockRejectedValueOnce(new Error("password=secret"))
    await expect(getOrCreateRoot("osd")).rejects.toThrow(
      "Unable to connect to provider connection osd"
    )
    expect(clientIsConnected("osd")).toBe(false)
    expect(client.logout).toHaveBeenCalledOnce()
    expect(client.statelessClone.logout).toHaveBeenCalledOnce()
  })
})
