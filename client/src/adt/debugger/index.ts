import {
  debug,
  DebugConfigurationProviderTriggerKind,
  type DebugSession,
  type ExtensionContext
} from "vscode"
import { AbapConfigurationProvider, DEBUGTYPE } from "./abapConfigurationProvider"
import { AbapDebugSession } from "./abapDebugSession"
import { AbapDebugAdapterFactory } from "./AbapDebugAdapterFactory"
import { registerReplayDebugger } from "./replay/registration"

export const LogOutPendingDebuggers = (connId?: string) => {
  if (!connId) return AbapDebugAdapterFactory.instance.closeSessions()
  const session = AbapDebugSession.byConnection(connId)
  return session ? [session.logOut()] : []
}

export const registerAbapDebugger = (context: ExtensionContext) => {
  const provider = new AbapConfigurationProvider()
  const providerReg = debug.registerDebugConfigurationProvider(
    DEBUGTYPE,
    provider,
    DebugConfigurationProviderTriggerKind.Dynamic
  )
  const factoryReg = debug.registerDebugAdapterDescriptorFactory(
    DEBUGTYPE,
    AbapDebugAdapterFactory.instance
  )
  context.subscriptions.push(factoryReg, providerReg)

  // Register the replay debugger
  registerReplayDebugger(context)
}
