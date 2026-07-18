// GitHub login + repo picker. Zero-click when the backend already has a token
// (env or the host's `gh` login); otherwise GitHub's device flow (short code).
import { useEffect, useState } from "react";
import { API, apiFetch } from "../config";
import { useStore } from "../state/store";

interface Repo {
  full_name: string;
  private: boolean;
}

interface GhStatus {
  connected: boolean;
  user?: string;
  loginAvailable: boolean;
}

export default function RepoPicker() {
  const health = useStore((s) => s.health);
  const [gh, setGh] = useState<GhStatus | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");

  const refresh = async () => {
    try {
      const s = (await (await apiFetch(`${API}/api/github/status`)).json()) as GhStatus;
      setGh(s);
      if (s.connected) setRepos((await (await apiFetch(`${API}/api/github/repos`)).json()) as Repo[]);
    } catch {
      setGh({ connected: false, loginAvailable: false });
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  const connect = async () => {
    window.location.assign(`${API}/api/github/login?returnTo=${encodeURIComponent(window.location.href)}`);
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
        📁 {health.repo?.name || "repo"}
        {gh?.connected ? <span className="repo-gh"> · {gh.user}</span> : null} ▾
      </button>
      {open && (
        <div className="repo-drop">
          {!gh?.connected &&
            (gh?.loginAvailable ? (
              <button className="repo-connect" onClick={() => void connect()}>Sign in with GitHub</button>
            ) : (
              <div className="repo-hint">GitHub sign-in is not configured for this deployment.</div>
            ))}
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
            </>
          )}
          {note && <div className="repo-hint">{note}</div>}
        </div>
      )}
    </div>
  );
}
