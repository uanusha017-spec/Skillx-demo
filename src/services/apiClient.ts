const TOKEN_STORAGE_KEY = 'natton_skillx_access_token_v1';

let accessTokenMemory: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

if (typeof window !== 'undefined') {
  try {
    accessTokenMemory = sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}

export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

export function setAccessToken(token: string | null) {
  accessTokenMemory = token;
  if (typeof window !== 'undefined') {
    try {
      if (token) {
        sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
      } else {
        sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      }
    } catch {
      // ignore storage errors
    }
  }
}

export function getAccessToken(): string | null {
  return accessTokenMemory;
}

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers || {});
  if (accessTokenMemory && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${accessTokenMemory}`);
  }
  const resp = await fetch(input, {
    ...init,
    headers,
  });
  if (resp.status === 401 && !input.startsWith('/api/auth/')) {
    setAccessToken(null);
    unauthorizedHandler?.();
  }
  return resp;
}

export async function readJsonSafe<T = Record<string, unknown>>(resp: Response): Promise<T> {
  const text = await resp.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { error: text.slice(0, 200) } as unknown as T;
  }
}
