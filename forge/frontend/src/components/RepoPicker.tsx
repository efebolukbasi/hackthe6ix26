// Repo picker with per-participant GitHub sign-in (OAuth device flow, with a
// paste-a-token fallback). Tokens never reach the browser — the backend keys
// them off an opaque session id sent with every request.
import { useEffect, useRef, useState } from "react";
import { API, apiFetch } from "../config";
import { useStore } from "../state/store";

interface Repo {
  full_name: string;
  private: boolean;
}

interface GhStatus {
  connected: boolean;
  user?: string;
  via?: "oauth" | "env" | "gh";
  authAvailable?: boolean;
  pending?: { userCode: string; verificationUri: string };
  error?: string;
  /** Client-side: API is refusing us (bad/missing invite token) — no sign-in
   * affordance will work, so show only the explanation. */
  blocked?: boolean;
}

export default function RepoPicker() {
  const health = useStore((s) => s.health);
  const [gh, setGh] = useState<GhStatus | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [patOpen, setPatOpen] = useState(false);
  const [pat, setPat] = useState("");
  const [copied, setCopied] = useState(false);
  const autoOpened = useRef(false);

  const refresh = async () => {
    try {
      const res = await apiFetch(`${API}/api/github/status`);
      if (res.status === 401) {
        // Deployment requires the invite token and this tab lacks it — no
        // GitHub call will work until they reopen the full invite link.
        setGh({ connected: false, blocked: true, error: "This tab is missing the meeting's invite token — reopen the full invite link (the URL ending in #token=…)." });
        return;
      }
      const s = (await res.json()) as GhStatus;
      setGh(s);
      if (s.connected) setRepos((await (await apiFetch(`${API}/api/github/repos`)).json()) as Repo[]);
    } catch {
      setGh({ connected: false });
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  // Uninitialized meeting: pop the picker open once so nobody hunts for it.
  useEffect(() => {
    if (health.repo || autoOpened.current) return;
    autoOpened.current = true;
    setOpen(true);
  }, [health.repo]);

  // While a device-flow sign-in is pending, poll until GitHub confirms it.
  const pendingCode = gh?.pending?.userCode;
  useEffect(() => {
    if (!pendingCode) return;
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [pendingCode]);

  const login = async () => {
    setNote("");
    try {
      const r = (await (await apiFetch(`${API}/api/github/login`, { method: "POST" })).json()) as {
        userCode?: string;
        verificationUri?: string;
        error?: string;
      };
      if (!r.userCode) {
        setNote(r.error || "couldn't start GitHub sign-in");
        return;
      }
      setGh((s) => ({
        ...(s ?? {}),
        connected: false,
        pending: { userCode: r.userCode!, verificationUri: r.verificationUri || "https://github.com/login/device" },
      }));
    } catch {
      setNote("couldn't start GitHub sign-in");
    }
  };

  const savePat = async () => {
    const token = pat.trim();
    if (!token) return;
    setNote("checking token…");
    try {
      const r = (await (
        await apiFetch(`${API}/api/github/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        })
      ).json()) as { ok?: boolean; error?: string };
      if (!r.ok) {
        setNote(r.error || "GitHub rejected that token");
        return;
      }
      setPat("");
      setPatOpen(false);
      setNote("");
      await refresh();
    } catch {
      setNote("couldn't reach the backend");
    }
  };

  const logout = async () => {
    try {
      await apiFetch(`${API}/api/github/logout`, { method: "POST" });
    } catch { /* backend hiccup — refresh below tells the truth */ }
    setRepos([]);
    setPatOpen(false);
    void refresh();
  };

  const copyCode = () => {
    if (!pendingCode) return;
    void navigator.clipboard?.writeText(pendingCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const load = async (fullName: string) => {
    setNote(`Reading ${fullName}…`);
    try {
      const r = (await (
        await apiFetch(`${API}/api/repo/load`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: `https://github.com/${fullName}` }),
        })
      ).json()) as { repo?: { name?: string }; error?: string };
      if (r.error || !r.repo) { setNote(r.error || "failed to load"); return; }
      useStore.setState((s) => ({ health: { ...s.health, repo: r.repo } }));
      setNote("");
      setOpen(false);
    } catch {
      setNote("failed to load repo");
    }
  };

  const list = repos.filter((r) => r.full_name.toLowerCase().includes(q.toLowerCase())).slice(0, 12);

  return (
    <div className="repopicker">
      <button className="repo-current" onClick={() => setOpen(!open)}>
        📁 {health.repo?.name || "Connect a repository"}
        {gh?.connected ? <span className="repo-gh"> · {gh.user}</span> : null} ▾
      </button>
      {open && (
        <div className="repo-drop">
          {!gh?.connected && gh?.pending && (
            <div className="repo-auth">
              <div className="repo-hint">
                Enter this code at{" "}
                <a href={gh.pending.verificationUri} target="_blank" rel="noreferrer">
                  github.com/login/device
                </a>
                :
              </div>
              <button className="repo-code" onClick={copyCode} title="click to copy">
                {gh.pending.userCode}{copied ? " ✓" : ""}
              </button>
              <div className="repo-hint">Waiting for GitHub — this updates by itself.</div>
            </div>
          )}
          {gh?.blocked && <div className="repo-hint">{gh.error}</div>}
          {!gh?.connected && !gh?.pending && !gh?.blocked && (
            <div className="repo-auth">
              {gh?.authAvailable ? (
                <button className="repo-login" onClick={() => void login()}>Sign in with GitHub</button>
              ) : (
                <div className="repo-hint">
                  GitHub sign-in isn't configured (set GITHUB_OAUTH_CLIENT_ID on the backend) — paste a personal access token instead.
                </div>
              )}
              {gh?.authAvailable && (
                <button className="repo-alt" onClick={() => setPatOpen(!patOpen)}>use a personal access token instead</button>
              )}
              {(patOpen || !gh?.authAvailable) && (
                <div className="repo-pat">
                  <input
                    type="password"
                    placeholder="token with repo scope"
                    value={pat}
                    onChange={(e) => setPat(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void savePat(); }}
                  />
                  <button onClick={() => void savePat()}>Connect</button>
                </div>
              )}
              {gh?.error && <div className="repo-hint">{gh.error}</div>}
            </div>
          )}
          {gh?.connected && (
            <>
              <input placeholder="Search your repos…" value={q} onChange={(e) => setQ(e.target.value)} />
              <div className="repo-list">
                {list.map((r) => (
                  <button key={r.full_name} onClick={() => void load(r.full_name)}>
                    {r.private ? "🔒 " : ""}{r.full_name}
                  </button>
                ))}
              </div>
              <div className="repo-foot">
                {gh.via === "oauth" ? (
                  <button className="repo-alt" onClick={() => void logout()}>sign out {gh.user}</button>
                ) : gh.authAvailable ? (
                  <button className="repo-alt" onClick={() => void login()}>sign in with your own GitHub</button>
                ) : null}
              </div>
            </>
          )}
          {note && <div className="repo-hint">{note}</div>}
        </div>
      )}
    </div>
  );
}
