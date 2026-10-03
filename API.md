# ABAP FS extension API v2

Activate `murbani.vscode-abap-remote-fs` and read its exports. Check `version === 2`
before using the API. The public TypeScript interfaces are in
[`client/src/api.ts`](client/src/api.ts); consumers can vendor those type declarations
(they are not a published npm package). VS Code events and registrations return
`Disposable`s; put them in your extension context's subscriptions.

```ts
import * as vscode from "vscode"
import type { AbapFsApi, ProvidedConnection } from "./abapfs-api-types"

export async function activate(context: vscode.ExtensionContext) {
  const extension = vscode.extensions.getExtension<AbapFsApi>(
    "murbani.vscode-abap-remote-fs"
  )
  if (!extension) throw new Error("Install ABAP FS to browse the local ABAP system")
  const api = await extension.activate()
  if (api.version !== 2) throw new Error("ABAP FS API v2 is required")

  const changed = new vscode.EventEmitter<void>()
  let connections: ProvidedConnection[] = []
  context.subscriptions.push(
    changed,
    api.registerConnectionProvider({
      getConnections: () => connections,
      onDidChange: changed.event
    }),
    api.onDidSaveObject(event => {
      if (event.connId === "osd-local") refreshDiagnostics(event.uri)
    })
  )

  // Your local system launcher returns a new in-memory token on every start.
  const { port, token } = await startLocalSystem()
  connections = [{
    id: "osd-local",
    name: "OSD local ABAP",
    url: `http://127.0.0.1:${port}`,
    client: "001",
    language: "EN",
    user: "DEVELOPER",
    autoConnect: true,
    auth: {
      kind: "provider",
      getHeaders: async () => ({ "X-OSD-Token": token })
    }
  }]
  changed.fire()
  // ABAP FS connects and mounts automatically; onDidConnect reports login success.

  // On server shutdown: withdraw the connection and release its ADT sessions.
  // connections = []
  // changed.fire()
}

function refreshDiagnostics(uri: vscode.Uri) {
  // Schedule OSD diagnostics for this saved source file.
}
```

## Surface

```ts
version: 2
registerTransportValidator(validator: TransportValidator): vscode.Disposable
registerConnectionProvider(provider: ConnectionProvider): vscode.Disposable
connect(id: string): Promise<void>
isConnected(id: string): boolean
onDidConnect: vscode.Event<string>
onDidDisconnect: vscode.Event<string>
onDidSaveObject: vscode.Event<ObjectEvent>
onDidActivate: vscode.Event<ObjectEvent>
toAdtUri(fsUri: vscode.Uri): Promise<string>
fromAdtUri(connId: string, adtUri: string): Promise<vscode.Uri>
openObject(connId: string, objectType: string, name: string): Promise<vscode.Uri>
runUnitTests(connId: string, uri: vscode.Uri): Promise<UnitTestResults>
```

A provider implements synchronous `getConnections(): readonly ProvidedConnection[]`
and optional `onDidChange: vscode.Event<void>`. Load asynchronous state in the
consumer, then fire the event. Registration reads the initial snapshot immediately.
Each connection has `id`, display `name`, `url`, `client`, `language`, `user`, `auth`
and optional `allowSelfSigned` and `autoConnect`. IDs accept letters, digits, `_`
and `-`, are normalized to lowercase, and must not collide with settings or another
provider. Invalid snapshots throw and leave the previous snapshot intact. URLs must use HTTP(S), with
no embedded credentials, query or fragment.

Authentication is either `{ kind: "basic", password: string }` (an empty password
is supported for local systems), or
`{ kind: "provider", getHeaders(): Promise<Record<string, string>> }`.
Header callbacks run before every request in both ADT sessions, supporting rotating
Authorization headers or cookies; ABAP FS handles CSRF and session cookies. On HTTP
401, ABAP FS fetches fresh headers and retries that request once. A second failure
rejects with a redacted error; other failures are not retried by this auth layer.
No password prompt is shown for provider authentication. Header values are never
written to logs, errors, settings or telemetry. Provider credentials never go to
settings or the password vault, and provider HTTP errors are redacted. Communication logging is disabled for provider HTTP traffic.

Provided connections appear in the connection picker and as read-only entries in
Connection Manager. Changed or withdrawn connections are disconnected and unmounted;
unchanged snapshots preserve sessions. Disposing registration withdraws all its
connections and unsubscribes from changes. Cache invalidation is immediate; lock,
debugger and session cleanup completes asynchronously. With `autoConnect: true`,
ABAP FS connects and mounts connections present in the initial snapshot and after
`onDidChange`, including after a port or credential change. Presence means the system is active; withdraw it when the server stops.
Automatic failures are silent; another provider event retries, or call `connect(id)`
to observe a rejected promise. Connections without this flag still require
`connect(id)`. Reconnecting waits for cleanup.
Disposal cancels pending provider logins and requests in both sessions, including waits for
header callbacks. Late callback results cannot send requests. Provider cleanup is bounded to
one second independently of callbacks; reconnecting waits for that cleanup.
Nothing is persisted; re-register when the consumer activates again. The example
uses your own `startLocalSystem()` launcher: retain its per-start token only in
memory, withdraw the snapshot on shutdown, and publish a new snapshot on restart.

Language-server features also support provider authentication. Each server HTTP attempt is
forwarded to the extension host, which fetches fresh headers and retries a 401 once.
Provider authentication headers and passwords stay in the host and are never saved in server
configuration. Echoed provider header values are redacted before responses reach server
parsers. Withdrawal cancels pending requests; stale server sessions reject further requests,
and a replacement snapshot creates a new server session.

`connect` authenticates and mounts the system, reuses existing sessions, and rejects
on failure. It does not show a connection picker. Configured connections retain their
existing authentication prompts. `isConnected` reflects a live cached ADT session;
workspace folders alone do not imply a successful login. Connection events carry the
normalized ID and fire once per session creation/removal, including connections
created through commands or filesystem access. `onDidConnect` occurs before mounting.

Object events carry `{ connId, uri, objectType, objectName, include? }`. `uri` is an
ABAP FS URI. Saves fire after a successful remote source write; cancelled or failed
writes and local-only storage do not fire. Activation fires on successful activation,
including selected objects in batch activation when their filesystem paths can be
resolved. For source includes, the type/name identify the owning lock object and
`include` identifies the edited include. Saving and activation are separate events.

`toAdtUri` resolves a source file to its relative ADT source path, including any source
context query and fragment. `fromAdtUri` accepts relative `/sap/bc/adt/...` paths,
HTTP(S) URLs or Eclipse `adt://SYSTEM/sap/bc/adt/...` links; the explicit `connId`
selects the destination system. It resolves ADT fragments through the existing
object finder and retains the fragment on the returned filesystem URI. These
functions may authenticate and query the server. Unsupported objects reject.

`openObject` uses an exact case-insensitive name and ADT type such as `PROG/P` or
`CLAS/OC`, mounts the connection and displays its source document. Missing objects
reject. `runUnitTests` accepts a filesystem URI belonging to the given connection,
runs the existing ABAP Unit integration and updates VS Code's Testing view. It
returns `UnitTestResults` (`objectName`, `totalTests`, `passed`, `failed`, `totalTime`,
`allPassed`, `classes`); it does not implicitly save or activate source.
