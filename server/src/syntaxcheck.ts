import { connection, log } from "./clientManager"
import { objectIsValid } from "./api"
import { TextDocument, Diagnostic } from "vscode-languageserver"
import { getObject, vscUrl } from "./objectManager"
import {
  sourceRange,
  decodeSeverity,
  clientAndObjfromUrl,
  memoize
} from "./utilities"

const oldDiagKeys = new Map<string, string[]>()

export async function syntaxCheck(document: TextDocument) {
  const diagmap = new Map<string, Diagnostic[]>()
  const oldKeys = oldDiagKeys.get(document.uri)
  if (oldKeys) for (const k of oldKeys) diagmap.set(k, [])
  try {
    const co = await clientAndObjfromUrl(document.uri, false)
    if (!co) return
    const obj = await getObject(document.uri)
    // no object or include without a main program
    if (!obj || !objectIsValid(obj)) return

    const getSource = memoize((c: string) => co.client.getObjectSource(c))
    const getUri = memoize((uri: string) => vscUrl(co.confKey, uri, false))
    const getdiag = (key: string) => {
      let diag = diagmap.get(key)
      if (!diag) {
        diag = []
        diagmap.set(key, diag)
      }
      return diag
    }

    const source = document.getText()
    const checks = await co.client.syntaxCheck(
      obj.url,
      obj.mainUrl,
      source,
      obj.mainProgram
    )
    for (const c of checks) {
      let diagnostics
      let range
      if (c.uri === obj.mainUrl) {
        diagnostics = getdiag(document.uri)
        range = sourceRange(document, c.line, c.offset)
      } else {
        const uri = await getUri(c.uri)
        if (!uri) continue
        const chsrc = await getSource(c.uri)
        diagnostics = getdiag(uri)
        range = sourceRange(chsrc, c.line, c.offset)
      }
      diagnostics.push({
        message: c.text,
        range,
        source: "ABAPfs",
        severity: decodeSeverity(c.severity)
      })
    }
  } catch (e) {
    log("Exception in syntax check:", e.toString()) // ignore
  }
  for (const diag of diagmap)
    connection.sendDiagnostics({ uri: diag[0], diagnostics: diag[1] })
  // store a list of the sources with diagnostics generated by this URL
  // so I will clean them later
  const newKeys = [...diagmap].filter(e => e[1].length).map(e => e[0])
  if (newKeys) oldDiagKeys.set(document.uri, newKeys)
  else oldDiagKeys.delete(document.uri)
}
