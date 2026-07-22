// Where the Forge backend lives. Empty string = same origin (local dev, where
// the dev server proxies /api to the backend). For a split deploy, set
// window.FORGE_API (or VITE_FORGE_API at build time), e.g.
//   window.FORGE_API = "https://forge-backend.example.com";
export const API: string =
  (window as any).FORGE_API ?? import.meta.env.VITE_FORGE_API ?? "";

// Deployment invite token. It lives in the URL fragment so browsers never send
// it to the server or include it in normal HTTP logs/referrers.
export const ACCESS_TOKEN = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";

// Opaque per-browser session id: lets the backend remember THIS participant's
// GitHub sign-in without the browser ever holding the token itself.
export const SESSION_ID: string = (() => {
  try {
    const existing = localStorage.getItem("forge-session-id");
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem("forge-session-id", id);
    return id;
  } catch {
    return crypto.randomUUID(); // private mode — sign-in lasts the tab's life
  }
})();

export function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (ACCESS_TOKEN) headers.set("X-Forge-Access-Token", ACCESS_TOKEN);
  headers.set("X-Forge-Session", SESSION_ID);
  return fetch(input, { ...init, headers });
}
