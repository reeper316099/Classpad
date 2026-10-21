export interface ApiConfig {
  baseUrl: string;
  token: string;
}

declare global {
  interface Window {
    /** Present only inside the desktop app (injected by the preload script). */
    classpad?: {
      api: ApiConfig;
      platform: string;
      version: string;
      dataDir: string;
      onMenu(cb: (action: string) => void): () => void;
      openDataFolder(): Promise<void>;
      openReport(hide?: boolean): Promise<void>;
      saveReportPdf(): Promise<{ saved: boolean; path?: string }>;
    };
  }
}

/** The Electron preload bridge provides the API address and per-launch token; dev uses a proxy. */
export function apiConfig(): ApiConfig {
  if (typeof window !== 'undefined' && window.classpad?.api) return window.classpad.api;
  return { baseUrl: '', token: String(import.meta.env.VITE_API_TOKEN ?? '') };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request(
  method: string,
  path: string,
  body?: BodyInit | null,
  headers: Record<string, string> = {},
): Promise<Response> {
  const { baseUrl, token } = apiConfig();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/v1${path}`, {
      method,
      body,
      headers: { authorization: `Bearer ${token}`, ...headers },
    });
  } catch {
    throw new ApiError(
      0,
      'NETWORK',
      'Cannot reach the local Classpad server. In development run `npm run dev` (it starts the server and the app together); in the desktop app, quit and reopen Classpad.',
    );
  }
  if (!res.ok) {
    let code = 'ERROR',
      message = res.statusText,
      details: unknown;
    try {
      const j = await res.json();
      code = j.error?.code ?? code;
      message = j.error?.message ?? message;
      details = j.error?.details;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, code, message, details);
  }
  return res;
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await request(
    method,
    path,
    body === undefined ? undefined : JSON.stringify(body),
    body === undefined ? {} : { 'content-type': 'application/json' },
  );
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}
export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});
export const patch = <T>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const put = <T>(path: string, body: unknown) => api<T>('PUT', path, body);
export const del = (path: string) => api<void>('DELETE', path);

/** Upload raw bytes (e.g. a zip) as the request body. */
export async function postBinary<T>(path: string, data: Blob): Promise<T> {
  const res = await request('POST', path, data, { 'content-type': 'application/zip' });
  return (await res.json()) as T;
}

/** Download a file served by the API (exports) and hand it to the browser. */
export async function download(path: string, filename: string): Promise<void> {
  const res = await request('GET', path);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

export async function openInTab(path: string): Promise<void> {
  // desktop app: the main process shows the report in its own window
  if (window.classpad && path.startsWith('/export/report'))
    return window.classpad.openReport(path.includes('hide=1'));
  const res = await request('GET', path);
  window.open(URL.createObjectURL(await res.blob()), '_blank', 'noopener');
}

export function eventsUrl(): string {
  const { baseUrl, token } = apiConfig();
  return `${baseUrl}/api/v1/events?access_token=${encodeURIComponent(token)}`;
}
