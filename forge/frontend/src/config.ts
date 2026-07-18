// Where the Forge backend lives. Empty string = same origin (local dev, where
// the dev server proxies /api to the backend). For a split deploy, set
// window.FORGE_API (or VITE_FORGE_API at build time), e.g.
//   window.FORGE_API = "https://forge-backend.example.com";
export const API: string =
  (window as any).FORGE_API ?? import.meta.env.VITE_FORGE_API ?? "";
