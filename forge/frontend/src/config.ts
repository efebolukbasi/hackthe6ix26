// Where the Forge backend lives. Empty string = same origin (local dev, where
// the dev server proxies /api to the backend). For a split deploy, set
// window.FORGE_API (or VITE_FORGE_API at build time), e.g.
//   window.FORGE_API = "https://forge-backend.example.com";
export const API: string =
  (window as any).FORGE_API ?? import.meta.env.VITE_FORGE_API ?? "";

// Deployment invite token. It lives in the URL fragment so browsers never send
// it to the server or include it in normal HTTP logs/referrers.
export const ACCESS_TOKEN = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";

export function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (ACCESS_TOKEN) headers.set("X-Forge-Access-Token", ACCESS_TOKEN);
  return fetch(input, { ...init, headers });
}
