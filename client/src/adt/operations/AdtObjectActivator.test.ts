vi.mock("vscode", () => ({
  EventEmitter: vi.fn().mockImplementation(function () {
    return {
      event: "mockEvent",
      fire: vi.fn()
    }
  }),
  Uri: {
    parse: vi.fn(function (s: string) {
      return {
        scheme: "adt",
        authority: "conn",
        path: s,
        toString: () => s
      }
    })
  }
}))

vi.mock("../conections", () => ({
  getClient: vi.fn(),
  getRoot: vi.fn()
}))

vi.mock("../includes", () => ({
  IncludeService: {
    get: vi.fn().mockReturnValue({
      needMain: vi.fn().mockReturnValue(false),
      current: vi.fn().mockReturnValue(null)
    })
  },
  IncludeProvider: {
    get: vi.fn().mockReturnValue({
      switchIncludeIfMissing: vi.fn().mockResolvedValue(null)
    })
  }
}))

vi.mock("../../lib", () => ({
  isDefined: vi.fn(function (x: any) {
    return x !== undefined && x !== null
  }),
  channel: { appendLine: vi.fn() }
}))

vi.mock("abap-adt-api", () => ({
  isAdtError: vi.fn(),
  inactiveObjectsInResults: vi.fn(),
  session_types: { stateful: "stateful" }
}))

vi.mock("../../services/funMessenger", () => ({
  funWindow: {
    showQuickPick: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    withProgress: vi.fn()
  }
}))

vi.mock("abapobject", () => ({}))

import { AdtObjectActivator, type ActivationEvent } from "./AdtObjectActivator"
import { getClient } from "../conections"
import type { Mock } from "vitest"

const mockGetClient = getClient as Mock

describe("AdtObjectActivator", () => {
  let mockStatelessClient: any
  let mockClient: any

  beforeEach(() => {
    vi.clearAllMocks()
    AdtObjectActivator["instances"].clear()

    mockStatelessClient = {
      activate: vi.fn(),
      inactiveObjects: vi.fn().mockResolvedValue([]),
      statelessClone: {
        nodeContents: vi.fn().mockResolvedValue({ nodes: [] }),
        login: vi.fn()
      },
      nodeContents: vi.fn().mockResolvedValue({ nodes: [] }),
      httpClient: {
        request: vi.fn().mockResolvedValue({ body: "" })
      }
    }
    mockClient = {
      ...mockStatelessClient,
      statelessClone: mockStatelessClient
    }
    mockGetClient.mockReturnValue(mockClient)
  })

  it("creates an instance via get()", () => {
    const instance = AdtObjectActivator.get("testconn")
    expect(instance).toBeDefined()
    expect(instance).toBeInstanceOf(AdtObjectActivator)
  })

  it("get() returns the same instance for same connId", () => {
    const a = AdtObjectActivator.get("conn1")
    const b = AdtObjectActivator.get("conn1")
    expect(a).toBe(b)
  })

  it("get() returns different instances for different connIds", () => {
    const a = AdtObjectActivator.get("conn1")
    const b = AdtObjectActivator.get("conn2")
    expect(a).not.toBe(b)
  })

  it("onActivate returns an event", () => {
    const instance = AdtObjectActivator.get("conn3")
    expect(instance.onActivate).toBeDefined()
  })

  it("constructor uses stateless client", () => {
    AdtObjectActivator.get("conn4")
    expect(mockGetClient).toHaveBeenCalledWith("conn4", false)
  })
})

import { activatedObject } from "../../apiEvents"
import { getRoot } from "../conections"
import type { AbapObject } from "abapobject"
import { Uri } from "vscode"

describe("activation API events", () => {
  afterEach(() => vi.restoreAllMocks())
  it("emits successful activation metadata and omits failed attempts", async () => {
    const client = {
      activate: vi.fn(async () => ({ success: true })),
      inactiveObjects: vi.fn(async () => [])
    }
    const object = {
      name: "ZCL_TEST",
      type: "CLAS/OC",
      path: "/sap/bc/adt/oo/classes/zcl_test",
      structure: {},
      loadStructure: vi.fn(async () => undefined),
      childComponents: vi.fn(async () => ({ nodes: [] })),
      lockObject: undefined as unknown
    }
    object.lockObject = object
    const activator = new AdtObjectActivator(client as never)
    const uri = Uri.parse("adt://osd/package/ZCL_TEST.abap")
    const fire = vi.spyOn(activatedObject, "fire")
    expect(await activator.activate(object as unknown as AbapObject, uri, false)).toEqual({
      ok: true
    })
    expect(fire).toHaveBeenCalledExactlyOnceWith({
      connId: "conn",
      uri,
      objectType: "CLAS/OC",
      objectName: "ZCL_TEST"
    })
    client.activate.mockResolvedValue({ success: false })
    expect((await activator.activate(object as unknown as AbapObject, uri, false)).ok).toBe(false)
    expect(fire).toHaveBeenCalledOnce()
  })
  it("emits a filesystem event for each successfully activated batch object", async () => {
    const selection = [
      {
        "adtcore:name": "ZTEST",
        "adtcore:type": "PROG/P",
        "adtcore:uri": "/sap/bc/adt/programs/programs/ztest"
      }
    ]
    const client = {
      activate: vi.fn(async () => ({ success: true })),
      inactiveObjects: vi.fn(async () => selection.map(object => ({ object })))
    }
    vi.mocked(getRoot).mockReturnValue({
      findByAdtUri: vi.fn(async () => ({ path: "/package/ZTEST.abap" }))
    } as never)
    vi.spyOn(activatedObject, "observed", "get").mockReturnValue(true)
    const fire = vi.spyOn(activatedObject, "fire")
    const activator = new AdtObjectActivator(client as never, "osd")
    expect((await activator.activateMultiple(false)).ok).toBe(true)
    expect(fire).toHaveBeenCalledWith(
      expect.objectContaining({ connId: "osd", objectType: "PROG/P", objectName: "ZTEST" })
    )
    client.activate.mockResolvedValue({ success: false })
    await activator.activateMultiple(false)
    expect(fire).toHaveBeenCalledOnce()
  })
})
