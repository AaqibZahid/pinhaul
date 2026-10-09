// Pinterest's own resource API, called from the extension's origin.
//
// The extension asks for the same resources the Pinterest web app asks for, so
// no scraping layer is invented. The requests carry the browser's Pinterest
// session cookie (`_pinterest_sess` is `SameSite=None; Secure`, so Chrome
// attaches it to a credentialed cross-origin request from an extension origin
// that holds the host permission), which is what makes private boards the user
// can already see work without any second sign-in.

const BASE = "https://www.pinterest.com";

const HEADERS: Record<string, string> = {
  Accept: "application/json, text/javascript, */*; q=0.01",
  "X-Requested-With": "XMLHttpRequest",
  "X-Pinterest-PWS-Handler": "www/pinterest.js",
  "X-Pinterest-AppState": "active",
  "Alt-Used": "www.pinterest.com",
};

/** Why a resource call failed. */
export type PinterestErrorKind =
  | "rate-limited"
  | "unauthorized"
  | "not-found"
  | "server"
  | "transport"
  | "invalid"
  | "missing-data";

export class PinterestError extends Error {
  readonly kind: PinterestErrorKind;
  readonly resource: string;
  readonly detail?: string;

  constructor(kind: PinterestErrorKind, resource: string, message: string, detail?: string) {
    super(message);
    this.name = "PinterestError";
    this.kind = kind;
    this.resource = resource;
    this.detail = detail;
  }
}

export interface ResourceEnvelope {
  resource_response?: {
    status?: string;
    data?: unknown;
    bookmark?: string | string[];
    error?: { message?: string; http_status?: number; api_error_code?: number; message_detail?: string };
  };
  http_status?: number;
  body?: { response?: { error?: { message?: string; http_status?: number } } };
}

export interface PinterestGateway {
  getData<T = unknown>(resource: string, options: Record<string, unknown>, sourceUrl: string): Promise<T>;
  getResource(resource: string, options: Record<string, unknown>, sourceUrl: string): Promise<ResourceEnvelope>;
}

export interface ClientOptions {
  fetch?: typeof fetch;
  /** Milliseconds between two requests, so a large board is not throttled. */
  intervalMs?: number;
  /** How many times a throttled or failing request is retried. */
  maxAttempts?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Builds the URL the Pinterest web app uses for a resource call. */
export function resourceUrl(resource: string, options: unknown, sourceUrl: string): string {
  const data = encodeURIComponent(JSON.stringify({ options }));
  const source = encodeURIComponent(sourceUrl);
  return `${BASE}/resource/${resource}/get/?data=${data}&source_url=${source}`;
}

export class PinterestClient {
  private readonly fetchFn: typeof fetch;
  private readonly intervalMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextSlot = 0;

  constructor(options: ClientOptions = {}) {
    // The extension service worker's fetch has to be called as the global, not
    // as a detached function, so the default is a bound call.
    this.fetchFn =
      options.fetch ??
      ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.intervalMs = options.intervalMs ?? 110;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Calls one resource and returns its envelope, retrying what Pinterest is
   * only refusing temporarily. */
  async getResource(resource: string, options: Record<string, unknown>, sourceUrl: string): Promise<ResourceEnvelope> {
    const url = resourceUrl(resource, options, sourceUrl);
    let backoff = 1000;
    let lastError: PinterestError | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await this.pace();
      const outcome = await this.once(url, resource);
      if (outcome.ok) return outcome.envelope;
      lastError = outcome.error;
      const retryable =
        outcome.error.kind === "rate-limited" ||
        outcome.error.kind === "server" ||
        outcome.error.kind === "transport";
      if (!retryable || attempt === this.maxAttempts) break;
      const delay = outcome.retryAfterMs ?? backoff;
      await this.sleep(delay);
      backoff = Math.min(backoff * 2, 8000);
    }

    throw lastError ?? new PinterestError("invalid", resource, "the request never completed");
  }

  /** Calls one resource and returns only its `data` field. */
  async getData<T = unknown>(resource: string, options: Record<string, unknown>, sourceUrl: string): Promise<T> {
    const envelope = await this.getResource(resource, options, sourceUrl);
    const response = envelope.resource_response;
    if (!response || response.status !== "success") {
      throw envelopeError(envelope, resource);
    }
    if (response.data === undefined || response.data === null) {
      throw new PinterestError("missing-data", resource, `Pinterest returned no ${resource} data`);
    }
    return response.data as T;
  }

  private async pace(): Promise<void> {
    const now = Date.now();
    const at = Math.max(this.nextSlot, now);
    this.nextSlot = at + this.intervalMs;
    const wait = at - Date.now();
    if (wait > 0) await this.sleep(wait);
  }

  private async once(
    url: string,
    resource: string,
  ): Promise<{ ok: true; envelope: ResourceEnvelope } | { ok: false; error: PinterestError; retryAfterMs?: number }> {
    let response: Response;
    try {
      response = await this.fetchFn(url, { method: "GET", headers: HEADERS, credentials: "include" });
    } catch (cause) {
      return {
        ok: false,
        error: new PinterestError("transport", resource, `could not reach Pinterest: ${describe(cause)}`),
      };
    }

    const retryAfterMs = retryAfter(response.headers.get("retry-after"));
    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      return {
        ok: false,
        error: new PinterestError("transport", resource, `Pinterest's answer could not be read: ${describe(cause)}`),
      };
    }

    if (response.status === 429) {
      return {
        ok: false,
        error: new PinterestError("rate-limited", resource, "Pinterest asked us to slow down (429)"),
        retryAfterMs,
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        error: new PinterestError(
          "unauthorized",
          resource,
          "Pinterest needs a signed-in session for this board. Sign in to Pinterest in this browser, then try again.",
        ),
      };
    }
    if (response.status === 404) {
      return {
        ok: false,
        error: new PinterestError(
          "not-found",
          resource,
          "Pinterest has no such board. If it is private, this Pinterest account cannot see it.",
        ),
      };
    }
    if (response.status >= 500) {
      return {
        ok: false,
        error: new PinterestError("server", resource, `Pinterest answered ${response.status}`),
        retryAfterMs,
      };
    }

    let envelope: ResourceEnvelope;
    try {
      envelope = JSON.parse(text) as ResourceEnvelope;
    } catch {
      // Pinterest answers a request it considers malformed with HTML and the
      // words "Invalid Resource Request", and that is a throttled-shaped
      // refusal rather than a parse bug.
      if (/Invalid Resource Request/i.test(text)) {
        return {
          ok: false,
          error: new PinterestError("rate-limited", resource, "Pinterest refused the request as invalid"),
          retryAfterMs,
        };
      }
      return {
        ok: false,
        error: new PinterestError("invalid", resource, "Pinterest answered with something that is not JSON"),
      };
    }

    const response1 = envelope.resource_response;
    if (response1 && typeof response1.status === "string" && response1.status !== "success") {
      const kind = response1.error?.http_status === 401 || response1.error?.http_status === 403 ? "unauthorized" : "invalid";
      const message = response1.error?.message?.trim();
      return {
        ok: false,
        error: new PinterestError(kind, resource, message ? `Pinterest refused ${resource}: ${message}` : `Pinterest refused ${resource}`),
      };
    }

    // A well formed envelope with a failure body is the same refusal in another
    // shape.
    const wrapped = envelope.body?.response?.error;
    if (wrapped) {
      return {
        ok: false,
        error: new PinterestError("rate-limited", resource, "Pinterest refused the request as invalid"),
        retryAfterMs,
      };
    }

    return { ok: true, envelope };
  }
}

function envelopeError(envelope: ResourceEnvelope, resource: string): PinterestError {
  const wrapped = envelope.body?.response?.error;
  if (wrapped) {
    return new PinterestError("rate-limited", resource, "Pinterest refused the request as invalid");
  }
  const message = envelope.resource_response?.error?.message?.trim();
  return new PinterestError(
    "missing-data",
    resource,
    message ? `Pinterest refused ${resource}: ${message}` : `Pinterest returned no ${resource} data`,
  );
}

function retryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(seconds, 30) * 1000;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
