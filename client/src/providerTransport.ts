import axios, { AxiosHeaders } from "axios"
import type {
  ClientOptions,
  HttpClientOptions,
  HttpClientResponse
} from "abap-adt-api/build/AdtHTTP.js"

/** ADT's bundled adapter drops AbortSignal. Keep cancellation on the actual HTTP request. */
export class ProviderTransport {
  private readonly http
  constructor(url: string, ssl: ClientOptions) {
    this.http = axios.create({ baseURL: url, httpsAgent: ssl.httpsAgent })
  }
  async request(options: HttpClientOptions, signal: AbortSignal): Promise<HttpClientResponse> {
    const response = await this.http.request({
      url: options.url,
      method: options.method || "GET",
      headers: options.headers,
      params: options.qs,
      auth: options.auth,
      data: options.body,
      timeout: options.timeout,
      signal,
      responseType: "text",
      validateStatus: () => true
    })
    return {
      status: response.status,
      statusText: response.statusText,
      body: response.data,
      headers: (response.headers instanceof AxiosHeaders
        ? response.headers.toJSON()
        : response.headers) as HttpClientResponse["headers"]
    }
  }
}

/** Reject promptly even when an external provider ignores cancellation. */
export function untilCancelled<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Provider connection withdrawn"))
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new Error("Provider connection withdrawn"))
    signal.addEventListener("abort", cancel, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel))
  })
}
