import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  loadDotenvSafely,
  readEnvVar,
  buildQueryString,
  formatApiError,
  createHelpfulError,
  McpToolError,
  RateLimitError,
  UnreachableError,
} from '@chrischall/mcp-utils';

// Load .env for local dev; silently skip if dotenv is unavailable (e.g. the
// mcpb bundle). `loadDotenvSafely` swallows a missing dotenv module and never
// lets .env override a host-provided value.
const __dirname = dirname(fileURLToPath(import.meta.url));
await loadDotenvSafely({ path: join(__dirname, '..', '.env'), override: false });

const BASE_URL = 'https://api.untappd.com/v4';
const SERVICE = 'Untappd';
const REQUEST_TIMEOUT_MS = 30_000;

// Non-secret client constants that mimic the Untappd iPad app (v4.7.13). The
// API accepts requests carrying these; NONE are user secrets (the secrets are
// UNTAPPD_CLIENT_ID / UNTAPPD_CLIENT_SECRET / UNTAPPD_USERNAME / _PASSWORD,
// which come from the environment). All overridable via env for forward-compat
// when the app version bumps.
const DEFAULTS = {
  utv: '4.0.0',
  appVersion: '4.7.13',
  deviceName: 'iPad',
  deviceVersion: '26.5',
  devicePlatform: 'iPadOS',
  userAgent: 'Untappd/4.7.13 (ios; iPadOS 26.5)',
  // Untappd keys the returned access token to this device id; any stable UUID
  // works. Override with UNTAPPD_DEVICE_ID to pin your own.
  deviceUdid: 'A1B2C3D4-0000-4000-8000-0000000000AA',
};

/** Query params; undefined/null members are dropped by buildQueryString. */
export type Query = Record<string, string | number | boolean | undefined | null>;

interface Credentials {
  username: string;
  password: string;
  clientId: string;
  clientSecret: string;
}

export interface ClientOptions {
  /** Injectable fetch (for tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Pre-seed the access token (tests) so no xauth login is performed. */
  token?: string;
  /** Override credentials (tests) instead of reading the environment. */
  credentials?: Credentials | null;
}

function readCredentials(): Credentials | null {
  const username = readEnvVar('UNTAPPD_USERNAME');
  const password = readEnvVar('UNTAPPD_PASSWORD');
  const clientId = readEnvVar('UNTAPPD_CLIENT_ID');
  const clientSecret = readEnvVar('UNTAPPD_CLIENT_SECRET');
  if (username && password && clientId && clientSecret) {
    return { username, password, clientId, clientSecret };
  }
  return null;
}

function missingCredsError(): McpToolError {
  const missing = (
    ['UNTAPPD_USERNAME', 'UNTAPPD_PASSWORD', 'UNTAPPD_CLIENT_ID', 'UNTAPPD_CLIENT_SECRET'] as const
  ).filter((k) => !readEnvVar(k));
  return createHelpfulError(
    `Untappd credentials are not configured — missing ${missing.join(', ') || 'credentials'}.`,
    {
      hint:
        'Set UNTAPPD_USERNAME and UNTAPPD_PASSWORD (your Untappd login), plus UNTAPPD_CLIENT_ID and ' +
        'UNTAPPD_CLIENT_SECRET (the Untappd mobile app client credentials). See the README for how to obtain them.',
    },
  );
}

export class UntappdClient {
  private readonly fetchImpl: typeof fetch;
  private readonly creds: Credentials | null;
  private readonly configError: McpToolError | null;
  private readonly utv = readEnvVar('UNTAPPD_UTV') ?? DEFAULTS.utv;
  private readonly deviceUdid = readEnvVar('UNTAPPD_DEVICE_ID') ?? DEFAULTS.deviceUdid;
  private readonly userAgent = readEnvVar('UNTAPPD_USER_AGENT') ?? DEFAULTS.userAgent;

  private token: string | null;
  private loginInFlight: Promise<string> | null = null;

  /**
   * Defer the config error so the server can still start (and respond to the
   * host's install-time tools/list smoke test) when credentials aren't set yet.
   * Tool calls re-raise the error at request time.
   */
  constructor(opts: ClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.token = opts.token ?? null;
    const creds = opts.credentials !== undefined ? opts.credentials : readCredentials();
    if (creds) {
      this.creds = creds;
      this.configError = null;
    } else {
      this.creds = null;
      this.configError = missingCredsError();
    }
  }

  /** Whether credentials are configured (used by the healthcheck tool). */
  get configured(): boolean {
    return this.configError === null;
  }

  /** The configured login name — the default `username` for user-scoped tools. */
  get loginName(): string | null {
    return this.creds?.username ?? null;
  }

  private requireCreds(): Credentials {
    if (this.configError) throw this.configError;
    return this.creds!;
  }

  private baseHeaders(): Record<string, string> {
    return {
      'User-Agent': this.userAgent,
      Accept: 'application/json',
      'x-untappd-app': 'ios',
      'x-untappd-app-version': DEFAULTS.appVersion,
    };
  }

  // One HTTP attempt with a hard timeout. Network/timeout failures become an
  // UnreachableError; HTTP status handling is left to the caller.
  private async send(
    method: string,
    url: string,
    init: { headers: Record<string, string>; body?: string },
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.fetchImpl(url, {
        method,
        headers: init.headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: controller.signal,
      });
    } catch {
      throw new UnreachableError(SERVICE);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Obtain an access token, logging in via xauth (username/password) on demand.
   * A single shared in-flight promise coalesces concurrent tool calls so they
   * never trigger duplicate logins.
   */
  private async ensureToken(): Promise<string> {
    if (this.token) return this.token;
    if (!this.loginInFlight) {
      this.loginInFlight = this.login().finally(() => {
        this.loginInFlight = null;
      });
    }
    return this.loginInFlight;
  }

  private async login(): Promise<string> {
    const c = this.requireCreds();
    const qs = buildQueryString({ client_id: c.clientId, client_secret: c.clientSecret, utv: this.utv });
    const form = new URLSearchParams({
      user_name: c.username,
      user_password: c.password,
      device_udid: this.deviceUdid,
      device_name: DEFAULTS.deviceName,
      device_version: DEFAULTS.deviceVersion,
      device_platform: DEFAULTS.devicePlatform,
      app_version: DEFAULTS.appVersion,
      multi_account: 'true',
    });
    const res = await this.send('POST', `${BASE_URL}/xauth${qs}`, {
      headers: { ...this.baseHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401 || res.status === 400) {
        throw createHelpfulError(`Untappd login failed (${res.status}).`, {
          hint: 'Check UNTAPPD_USERNAME / UNTAPPD_PASSWORD, and that UNTAPPD_CLIENT_ID / UNTAPPD_CLIENT_SECRET are the mobile app credentials.',
        });
      }
      throw new McpToolError(formatApiError(res.status, 'POST', '/xauth', text, { service: SERVICE }));
    }
    let data: { response?: { access_token?: string; two_factor_enabled?: boolean } } | undefined;
    try {
      data = JSON.parse(text);
    } catch {
      throw new McpToolError('Untappd login returned a non-JSON response.');
    }
    const token = data?.response?.access_token;
    if (!token) {
      throw createHelpfulError('Untappd login did not return an access token.', {
        hint: data?.response?.two_factor_enabled
          ? 'This account has two-factor authentication enabled, which xauth login cannot satisfy.'
          : 'The credentials may be incorrect.',
      });
    }
    this.token = token;
    return token;
  }

  private async parseJson<T>(res: Response, method: string, path: string): Promise<T> {
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      throw new RateLimitError(SERVICE, ra > 0 ? ra : undefined);
    }
    const text = await res.text();
    let data: unknown;
    if (text.length) {
      try {
        data = JSON.parse(text);
      } catch {
        /* leave undefined; handled below */
      }
    }
    const meta = (data as { meta?: { code?: number; error_detail?: string; error_type?: string } } | undefined)?.meta;
    if (!res.ok) {
      const detail = meta?.error_detail || meta?.error_type;
      throw new McpToolError(formatApiError(res.status, method, path, detail ?? text, { service: SERVICE }));
    }
    if (typeof meta?.code === 'number' && meta.code >= 400) {
      const detail = meta.error_detail || meta.error_type || `code ${meta.code}`;
      throw new McpToolError(`Untappd ${method} ${path} failed (${meta.code}): ${detail}`);
    }
    return ((data as { response?: T } | undefined)?.response ?? (data as T)) as T;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Query; form?: Record<string, string | number | undefined | null>; auth: 'query' | 'bearer' },
    isRetry = false,
  ): Promise<T> {
    const token = await this.ensureToken();
    const headers = this.baseHeaders();
    // The Untappd app carries the token as a query param on reads and as an
    // `Authorization: Bearer` header on writes (with the client credentials in
    // the query). We mirror that exactly — both shapes are the real captured
    // requests the app itself makes.
    let query: Query;
    if (opts.auth === 'bearer') {
      const c = this.requireCreds();
      headers['Authorization'] = `Bearer ${token}`;
      query = { ...opts.query, client_id: c.clientId, client_secret: c.clientSecret, utv: this.utv };
    } else {
      query = { ...opts.query, access_token: token, utv: this.utv };
    }
    const qs = buildQueryString(query);
    let body: string | undefined;
    if (opts.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const f = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.form)) {
        if (v !== undefined && v !== null) f.append(k, String(v));
      }
      body = f.toString();
    }
    const res = await this.send(method, `${BASE_URL}${path}${qs}`, { headers, body });
    // A 401 means the cached token went stale — drop it and log in once more.
    if (res.status === 401 && !isRetry) {
      this.token = null;
      return this.request<T>(method, path, opts, true);
    }
    return this.parseJson<T>(res, method, path);
  }

  /** Authenticated read (token in the query, as the app does for GETs). */
  async get<T>(path: string, query: Query = {}): Promise<T> {
    return this.request<T>('GET', path, { query, auth: 'query' });
  }

  /**
   * Authenticated write. Attaches the `Authorization: Bearer` token and client
   * credentials centrally (the app's write shape); `form` is sent as
   * application/x-www-form-urlencoded. Every mutating tool routes through here.
   */
  async write<T>(
    method: 'POST' | 'GET',
    path: string,
    opts: { query?: Query; form?: Record<string, string | number | undefined | null> } = {},
  ): Promise<T> {
    return this.request<T>(method, path, { ...opts, auth: 'bearer' });
  }
}

/**
 * Module-level singleton shared by every tool module. Constructing it here (not
 * in `index.ts`) keeps the deferred-config-error pattern: the server boots and
 * answers the host's install-time tools/list smoke test even when credentials
 * are absent — the error only surfaces on the first tool call.
 */
export const client = new UntappdClient();
