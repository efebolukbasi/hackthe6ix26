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
  deviceFlowAvailable: boolean;
}

interface DeviceInfo {
  user_code: string;
  verification_uri: string;
  device_code: string;
  interval?: number;
}

export default function RepoPicker() {
  const health = useStore((s) => s.health);
  const [gh, setGh] = useState<GhStatus | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [device, setDevice] = useState<DeviceInfo | null>(null);

  const refresh = async () => {
    try {
      const s = (await (await apiFetch(`${API}/api/github/status`)).json()) as GhStatus;
      setGh(s);
      if (s.connected) setRepos((await (await apiFetch(`${API}/api/github/repos`)).json()) as Repo[]);
    } catch {
      setGh({ connected: false, deviceFlowAvailable: false });
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  const connect = async () => {
    setNote("");
    const d = (await (await apiFetch(`${API}/api/github/device/start`, { method: "POST" })).json()) as DeviceInfo & { error?: string };
    if (d.error) { setNote(d.error); return; }
    setDevice(d);
    window.open(d.verification_uri, "_blank");
    const poll = async () => {
      try {
        const r = (await (
          await apiFetch(`${API}/api/github/device/poll`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ device_code: d.device_code }),
          })
        ).json()) as { status: string; error?: string };
        if (r.status === "ok") { setDevice(null); void refresh(); }
        else if (r.status === "pending") setTimeout(() => void poll(), (d.interval || 5) * 1000);
        else { setDevice(null); setNote(r.error || "login failed"); }
      } catch {
        setDevice(null);
        setNote("login failed");
      }
    };
    setTimeout(() => void poll(), (d.interval || 5) * 1000);
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
            (gh?.deviceFlowAvailable ? (
              <button className="repo-connect" onClick={() => void connect()}>Connect GitHub</button>
            ) : (
              <div className="repo-hint">No GitHub login — run `gh auth login` on the host, or set GITHUB_CLIENT_ID for device login.</div>
            ))}
          {device && (
            <div className="repo-hint">
              Enter code <strong>{device.user_code}</strong> at {device.verification_uri}
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
            </>
          )}
          {note && <div className="repo-hint">{note}</div>}
        </div>
      )}
    </div>
  );
}
