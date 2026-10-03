import { EventEmitter, type Event, type Uri } from "vscode"
import type { AbapObject } from "abapobject"

export interface ObjectEvent {
  connId: string
  uri: Uri
  objectType: string
  objectName: string
  include?: string
}

// Allocate only when subscribed; ordinary users do not pay for API listeners.
function signal<T>() {
  let emitter: EventEmitter<T> | undefined
  const event: Event<T> = (listener, thisArgs, disposables) => {
    emitter ??= new EventEmitter<T>()
    return emitter.event(listener, thisArgs, disposables)
  }
  return {
    event,
    get observed() {
      return !!emitter
    },
    fire: (value: T) => emitter?.fire(value)
  }
}

export const connected = signal<string>()
export const disconnected = signal<string>()
export const savedObject = signal<ObjectEvent>()
export const activatedObject = signal<ObjectEvent>()

export function objectEvent(uri: Uri, object: AbapObject): ObjectEvent {
  return {
    connId: uri.authority.toLowerCase(),
    uri,
    objectType: object.lockObject.type,
    objectName: object.lockObject.name,
    ...(object !== object.lockObject ? { include: object.name } : {})
  }
}
