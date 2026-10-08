import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import type { Job } from "../core/autopilot";
import type { EditOp } from "../core/ops";
import { cropRect } from "../core/render/graph";
import type { ProjectView, StudioState } from "./server";

type ViewClip = ProjectView["clips"][number];
type ViewWord = ProjectView["words"][number];

// ───────────────────────── helpers

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}

const fmt = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
};
const fmtSize = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);

function useHashRoute(): [string | null, (id: string | null) => void] {
  const read = () => window.location.hash.match(/^#\/p\/(.+)$/)?.[1] ?? null;
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [route, (id) => (window.location.hash = id ? `#/p/${id}` : "#/")];
}

type Upload = { name: string; progress: number };

type AutopilotInfo = {
  enabled: boolean;
  watching: boolean;
  elsewhere: boolean;
  director: string;
  directorLabel: string;
  folder: string;
  outbox: string;
  jobs: Job[];
};

const readPref = (key: string, fallback: boolean) => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
};
const writePref = (key: string, value: boolean) => {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Private mode: the toggle just won't be remembered.
  }
};

function uploadFile(file: File, onProgress: (p: number) => void, batch?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/upload?name=${encodeURIComponent(file.name)}${batch ? `&batch=${batch}` : ""}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(JSON.parse(xhr.responseText || "{}").error ?? "Upload failed")));
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.send(file);
  });
}

// ───────────────────────── app

function App() {
  const [state, setState] = useState<StudioState | null>(null);
  const [route, go] = useHashRoute();
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<{ text: string; err?: boolean } | null>(null);

  const notify = useCallback((text: string, err = false) => {
    setToast({ text, err });
    window.setTimeout(() => setToast((t) => (t?.text === text ? null : t)), err ? 6000 : 2800);
  }, []);

  const [autopilot, setAutopilot] = useState<AutopilotInfo | null>(null);
  const [autoEdit, setAutoEditState] = useState(() => readPref("opencut.autoEdit", true));
  const setAutoEdit = (v: boolean) => (setAutoEditState(v), writePref("opencut.autoEdit", v));

  const refresh = useCallback(() => {
    api<StudioState>("/api/state").then(setState).catch(() => {});
    api<AutopilotInfo>("/api/autopilot").then(setAutopilot).catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 3000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const autoEditing = autoEdit && Boolean(autopilot?.enabled);

  const upload = useCallback(
    async (files: File[]) => {
      const video = files.find((f) => /\.(mp4|mov|m4v|mkv|webm|avi)$/i.test(f.name));
      // With auto-edit on, a drop that includes a video becomes one autopilot job.
      const batch = autoEditing && video ? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` : undefined;
      for (const file of files) {
        setUploads((u) => [...u, { name: file.name, progress: 0 }]);
        try {
          await uploadFile(file, (p) => setUploads((u) => u.map((x) => (x.name === file.name ? { ...x, progress: p } : x))), batch);
        } catch (e) {
          notify(`${file.name}: ${(e as Error).message}`, true);
        }
        setUploads((u) => u.filter((x) => x.name !== file.name));
        if (!batch) refresh();
      }
      if (batch && video) {
        try {
          await api("/api/upload/commit", { method: "POST", body: { batch, name: video.name } });
          notify(`Auto-editing ${video.name}… it will appear under Autopilot`);
        } catch (e) {
          notify((e as Error).message, true);
        }
        refresh();
      }
    },
    [notify, refresh, autoEditing],
  );

  useEffect(() => {
    let depth = 0;
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (e.dataTransfer?.files.length) upload([...e.dataTransfer.files]);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [upload]);

  return (
    <div className="app">
      <Sidebar
        state={state}
        route={route}
        go={go}
        uploads={uploads}
        upload={upload}
        notify={notify}
        refresh={refresh}
        autopilot={autopilot}
        autoEdit={autoEdit}
        setAutoEdit={setAutoEdit}
      />
      <main className="main">
        {route ? (
          <ProjectScreen key={route} id={route} state={state} notify={notify} onDeleted={() => (go(null), refresh())} />
        ) : (
          <Home state={state} notify={notify} />
        )}
      </main>
      {dragging && (
        <div className="drag-overlay">
          {autoEditing ? "Drop a video (with photos or a notes.txt) and the AI edits it for you" : "Drop videos, photos or music to add them to your inbox"}
        </div>
      )}
      {toast && <div className={`toast ${toast.err ? "err" : ""}`}>{toast.text}</div>}
    </div>
  );
}

// ───────────────────────── sidebar

function Sidebar(props: {
  state: StudioState | null;
  route: string | null;
  go: (id: string | null) => void;
  uploads: Upload[];
  upload: (files: File[]) => void;
  notify: (t: string, err?: boolean) => void;
  refresh: () => void;
  autopilot: AutopilotInfo | null;
  autoEdit: boolean;
  setAutoEdit: (v: boolean) => void;
}) {
  const { state, route, go, uploads, upload, notify, refresh, autopilot, autoEdit, setAutoEdit } = props;
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const videos = state?.inbox.filter((i) => i.kind === "video" && i.file.startsWith("inbox/")) ?? [];
  const others = state?.inbox.filter((i) => i.kind !== "video") ?? [];

  const toggle = (file: string) => setSelected((s) => (s.includes(file) ? s.filter((f) => f !== file) : [...s, file]));

  const create = async () => {
    setBusy(true);
    try {
      const firstName = videos.find((v) => v.file === selected[0])?.name.replace(/\.[^.]+$/, "") ?? "New reel";
      const { id } = await api<{ id: string }>("/api/projects", { method: "POST", body: { name: name.trim() || firstName, files: selected } });
      setSelected([]);
      setName("");
      refresh();
      go(id);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="sidebar">
      <div className="brand" onClick={() => go(null)} style={{ cursor: "pointer" }}>
        <span className="brand-dot" /> OpenCut Studio
      </div>
      <div className="sidebar-scroll">
        <div className="dropzone" onClick={() => fileInput.current?.click()}>
          {autoEdit && autopilot?.enabled ? "Drop a video to auto-edit it" : "Drop videos & images here"}
          <div className="hint">{autoEdit && autopilot?.enabled ? "add photos or a notes.txt in the same drop" : "or click to choose files"}</div>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept="video/*,image/*,audio/*,.txt,.md"
            onChange={(e) => e.target.files && upload([...e.target.files])}
          />
        </div>
        {uploads.map((u) => (
          <div key={u.name} className="upload-row">
            Uploading {u.name}
            <div className="upload-bar">
              <div style={{ width: `${u.progress * 100}%` }} />
            </div>
          </div>
        ))}

        <AutopilotPanel info={autopilot} autoEdit={autoEdit} setAutoEdit={setAutoEdit} go={go} notify={notify} refresh={refresh} />

        <div className="section-title">
          <span>Videos</span>
          <button className="ghost" title="Open the inbox folder in Finder" onClick={() => api("/api/reveal", { method: "POST", body: {} }).catch((e) => notify(e.message, true))}>
            Open folder
          </button>
        </div>
        <div className="media-list">
          {!videos.length && <div className="hint">No videos yet.</div>}
          {videos.map((v) => (
            <div key={v.file} className={`media-item ${selected.includes(v.file) ? "selected" : ""}`} onClick={() => toggle(v.file)}>
              <input type="checkbox" readOnly checked={selected.includes(v.file)} />
              <div className="media-thumb" style={{ backgroundImage: `url("${v.thumb}")` }} />
              <div style={{ minWidth: 0 }}>
                <div className="media-name">{v.name}</div>
                <div className="media-meta">
                  {v.duration ? fmt(v.duration) : "…"} · {fmtSize(v.size)}
                  {v.analyzed ? " · ready" : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
        {selected.length > 0 && (
          <div className="new-reel">
            <input type="text" placeholder="Reel name (optional)" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
            <button className="primary" disabled={busy} onClick={create}>
              New reel from {selected.length} video{selected.length > 1 ? "s" : ""}
            </button>
          </div>
        )}

        {others.length > 0 && (
          <>
            <div className="section-title">Images & music</div>
            <div className="media-list">
              {others.map((v) => (
                <div key={v.file} className="media-item" style={{ gridTemplateColumns: "44px 1fr", cursor: "default" }}>
                  <div className="media-thumb" style={{ backgroundImage: v.kind === "image" ? `url("${v.thumb}")` : undefined }}>
                    {v.kind === "audio" && <div style={{ textAlign: "center", lineHeight: "30px" }}>♪</div>}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="media-name">{v.name}</div>
                    <div className="media-meta">{v.kind}</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="section-title">Reels</div>
        {!state?.projects.length && <div className="hint">Select videos above, then “New reel”.</div>}
        {state?.projects.map((p) => (
          <div key={p.id} className={`project-item ${route === p.id ? "active" : ""}`} onClick={() => go(p.id)}>
            <span className="media-name">{p.name}</span>
            <span className="media-meta">
              {p.render === "running" ? "rendering…" : p.duration ? fmt(p.duration) : ""}
            </span>
          </div>
        ))}
      </div>
    </aside>
  );
}

// ───────────────────────── autopilot

const JOB_LABEL: Record<Job["status"], string> = {
  importing: "importing",
  analyzing: "transcribing",
  editing: "editing",
  rendering: "rendering",
  done: "ready",
  error: "failed",
};

function AutopilotPanel(props: {
  info: AutopilotInfo | null;
  autoEdit: boolean;
  setAutoEdit: (v: boolean) => void;
  go: (id: string | null) => void;
  notify: (t: string, err?: boolean) => void;
  refresh: () => void;
}) {
  const { info, autoEdit, setAutoEdit, go, notify, refresh } = props;
  if (!info) return null;
  const reveal = (path: string) => api("/api/reveal", { method: "POST", body: { path } }).catch((e) => notify(e.message, true));
  const status = !info.enabled
    ? "Off (Studio started with --no-autopilot)."
    : info.elsewhere
      ? "Running in another OpenCut process."
      : `${info.directorLabel} edits every video you drop.`;
  return (
    <>
      <div className="section-title">
        <span>Autopilot</span>
        <span className="row" style={{ gap: 0 }}>
          <button className="ghost" title="Open the auto-edit drop folder in Finder" onClick={() => reveal("auto-edit")}>
            Drop folder
          </button>
          <button className="ghost" title="Open finished reels in Finder" onClick={() => reveal("outbox")}>
            Outbox
          </button>
        </span>
      </div>
      <label className="autopilot-toggle">
        <input type="checkbox" checked={autoEdit} disabled={!info.enabled} onChange={(e) => setAutoEdit(e.target.checked)} />
        <span>
          Auto-edit drops with AI
          <div className="hint">{status}</div>
          {info.director === "basic" && info.enabled && (
            <div className="hint">No AI found: install Claude Code or add an API key to get AI edits.</div>
          )}
        </span>
      </label>
      <div className="jobs">
        {info.jobs.slice(0, 6).map((j) => (
          <div key={j.id} className={`job ${j.status}`}>
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
              <span className="media-name">{j.name}</span>
              <span className={`pill ${j.status === "done" ? "ok" : j.status === "error" ? "err" : "warn"}`}>{JOB_LABEL[j.status]}</span>
            </div>
            {j.status !== "done" && j.status !== "error" && <div className="hint">{j.step}</div>}
            {j.status === "error" && (
              <div className="hint">
                {j.error}{" "}
                <button
                  className="ghost"
                  onClick={() =>
                    api("/api/autopilot/retry", { method: "POST", body: { id: j.id } })
                      .then(refresh)
                      .catch((e) => notify(e.message, true))
                  }
                >
                  Retry
                </button>
              </div>
            )}
            {j.status === "done" && (
              <div className="row">
                {j.outputs.map((o) => (
                  <button key={o.project} className="ghost job-link" onClick={() => go(o.project)} title={o.file}>
                    ▶ {o.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

// ───────────────────────── home

type SetupInfo = {
  ffmpeg: boolean;
  whisper: boolean;
  brew: boolean;
  model: { file: string; installed: boolean; downloading: boolean; progress: number; error?: string };
  director: string;
};

function SetupCard({ notify }: { notify: (t: string, err?: boolean) => void }) {
  const [setup, setSetup] = useState<SetupInfo | null>(null);
  const load = useCallback(() => api<SetupInfo>("/api/setup").then(setSetup).catch(() => {}), []);
  useEffect(() => {
    load();
    const t = window.setInterval(load, 2000);
    return () => window.clearInterval(t);
  }, [load]);
  if (!setup) return null;
  const toolsReady = setup.ffmpeg && setup.whisper;
  if (toolsReady && setup.model.installed) return null;
  const post = (path: string) => api(path, { method: "POST", body: {} }).then(load).catch((e) => notify(e.message, true));
  return (
    <div className="card setup">
      <h3>Finish setting up</h3>
      <div className="step">
        <span>{toolsReady ? "✅" : "1."}</span>
        <div>
          <b>Video and speech tools</b> (FFmpeg and whisper.cpp, free, from Homebrew)
          {!toolsReady && (
            <div className="row">
              <button className="primary" onClick={() => post("/api/setup/brew")}>
                {setup.brew ? "Install in Terminal" : "Install Homebrew + tools in Terminal"}
              </button>
              <span className="hint">Terminal opens and runs it; come back when it finishes.</span>
            </div>
          )}
        </div>
      </div>
      <div className="step">
        <span>{setup.model.installed ? "✅" : "2."}</span>
        <div>
          <b>Speech model</b> (about 550 MB, runs on your Mac)
          {!setup.model.installed && (
            <div className="row">
              {setup.model.downloading ? (
                <>
                  <span className="progress" style={{ width: 200 }}>
                    <div style={{ width: `${setup.model.progress * 100}%` }} />
                  </span>
                  <span className="hint">{Math.round(setup.model.progress * 100)}%</span>
                </>
              ) : (
                <button className="primary" onClick={() => post("/api/setup/model")}>
                  Download
                </button>
              )}
              {setup.model.error && <span className="hint" style={{ color: "var(--danger)" }}>{setup.model.error}</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ConnectCard({ notify }: { notify: (t: string, err?: boolean) => void }) {
  const [info, setInfo] = useState<{ clients: Record<string, boolean>; text: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [showConfig, setShowConfig] = useState(false);
  useEffect(() => {
    api<typeof info>("/api/connect").then(setInfo).catch(() => {});
  }, []);
  if (!info) return null;
  const connect = async (client: string) => {
    setBusy(client);
    try {
      const r = await api<{ message: string }>("/api/connect", { method: "POST", body: { client } });
      notify(r.message);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };
  const clients: [string, string][] = [
    ["claude-code", "Claude Code"],
    ["claude-desktop", "Claude Desktop"],
    ["codex", "Codex"],
  ];
  return (
    <div className="card">
      <h3>Edit by chatting with your AI</h3>
      <p className="hint">Connect OpenCut to your AI app, then ask it things like “make a reel from my newest video” or “cut the 3 best moments from podcast.mp4”.</p>
      <div className="row">
        {clients.map(([id, label]) => (
          <button key={id} disabled={!info.clients[id] || busy !== ""} title={info.clients[id] ? "" : `${label} isn't installed`} onClick={() => connect(id)}>
            {busy === id ? "Connecting…" : `Connect ${label}`}
          </button>
        ))}
        <button className="ghost" onClick={() => setShowConfig(!showConfig)}>
          {showConfig ? "Hide" : "Antigravity / manual setup"}
        </button>
      </div>
      {showConfig && <textarea readOnly rows={14} value={info.text} style={{ marginTop: 8, fontFamily: "ui-monospace, monospace", fontSize: 12 }} />}
    </div>
  );
}

function Home({ state, notify }: { state: StudioState | null; notify: (t: string, err?: boolean) => void }) {
  const [checks, setChecks] = useState<{ name: string; ok: boolean; detail: string; fix?: string }[] | null>(null);
  useEffect(() => {
    api<typeof checks>("/api/doctor").then(setChecks).catch(() => {});
  }, []);
  return (
    <div className="home">
      <SetupCard notify={notify} />
      <h2>Make a reel</h2>
      <h3>Hands-free</h3>
      <ol>
        <li>
          Drop a talking-head video on this window (keep <b>Auto-edit drops with AI</b> on), or into <code>{state?.root}/auto-edit</code> in Finder.
          Add photos, music or a <code>notes.txt</code> (what it's about, who it's for, your call to action) in the same drop.
        </li>
        <li>The AI transcribes it, understands it, cuts retakes and silences, picks the hook, places your photos, adds captions and writes the caption and hashtags.</li>
        <li>
          The finished MP4 and its publish copy land in <code>{state?.root}/outbox</code>, and you get a notification. Open it here to tweak, or ask the AI for changes in the <b>AI ✨</b> tab.
        </li>
      </ol>
      <h3>Hands-on</h3>
      <ol>
        <li>Turn auto-edit off and drop videos to add them to your library, tick them on the left and press <b>New reel</b>.</li>
        <li>Press <b>Auto edit</b>, click words in the transcript to cut or restore them, then <b>Render</b>.</li>
        <li>Or ask Claude / Codex / Antigravity: <i>“Make a reel from my newest video in OpenCut.”</i> You'll see its edits appear here live.</li>
      </ol>
      <p className="hint">
        Your editing rules and “about me” for the AI live in <code>{state?.root}/STYLE.md</code>.
      </p>
      <ConnectCard notify={notify} />
      <details className="checks">
        <summary>System check</summary>
        {!checks && <div className="hint">Checking…</div>}
        {checks?.map((c) => (
          <div key={c.name}>
            {c.ok ? "✅" : "❌"} <b>{c.name}</b> <span className="hint">{c.detail}</span>
            {c.fix && (
              <div className="hint" style={{ marginLeft: 26 }}>
                Fix: <code>{c.fix}</code>
              </div>
            )}
          </div>
        ))}
      </details>
    </div>
  );
}

// ───────────────────────── project

type Tab = "transcript" | "ai" | "style" | "layers" | "renders";
const TAB_LABEL: Record<Tab, string> = { transcript: "Transcript", ai: "AI ✨", style: "Style", layers: "Layers", renders: "Renders" };

function ProjectScreen({ id, state, notify, onDeleted }: { id: string; state: StudioState | null; notify: (t: string, err?: boolean) => void; onDeleted: () => void }) {
  const [view, setView] = useState<ProjectView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [tab, setTab] = useState<Tab>("transcript");
  const [mode, setMode] = useState<"live" | "render">("live");
  const [busy, setBusy] = useState(false);
  const localRevision = useRef(0);
  const undoChain = useRef<{ resultRev: number; target: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const v = await api<ProjectView>(`/api/projects/${id}`);
      setView((old) => {
        if (old && v.project.revision !== old.project.revision && v.project.revision !== localRevision.current) {
          notify("Updated by your AI assistant");
        }
        return v;
      });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id, notify]);

  useEffect(() => {
    load();
    const t = window.setInterval(load, 1500);
    return () => window.clearInterval(t);
  }, [load]);

  const edit = useCallback(
    async (ops: EditOp[], label?: string) => {
      setBusy(true);
      try {
        const r = await api<{ summary: string[]; view: ProjectView }>(`/api/projects/${id}/edit`, { method: "POST", body: { ops } });
        localRevision.current = r.view.project.revision;
        undoChain.current = null;
        setView(r.view);
        notify(label ?? r.summary[0] ?? "Saved");
      } catch (e) {
        notify((e as Error).message, true);
      } finally {
        setBusy(false);
      }
    },
    [id, notify],
  );

  const autoEdit = async () => {
    setBusy(true);
    try {
      const r = await api<{ summary: string[]; view: ProjectView }>(`/api/projects/${id}/auto`, { method: "POST" });
      localRevision.current = r.view.project.revision;
      setView(r.view);
      notify(r.summary.at(-1) ?? "Auto edit done");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!view) return;
    const chain = undoChain.current;
    const target = chain && chain.resultRev === view.project.revision ? chain.target - 1 : view.project.revision - 1;
    if (!view.revisions.includes(target)) return notify("Nothing more to undo");
    try {
      const r = await api<{ view: ProjectView }>(`/api/projects/${id}/revert`, { method: "POST", body: { revision: target } });
      localRevision.current = r.view.project.revision;
      undoChain.current = { resultRev: r.view.project.revision, target };
      setView(r.view);
      notify(`Undid to revision ${target}`);
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  const render = async (quality: "preview" | "final") => {
    try {
      await api(`/api/projects/${id}/render`, { method: "POST", body: { quality } });
      load();
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  const lastRenderStatus = useRef<string>("");
  useEffect(() => {
    const r = view?.state.render;
    if (!r) return;
    if (lastRenderStatus.current === "running" && r.status === "done") {
      notify("Render finished");
      setMode("render");
    }
    if (lastRenderStatus.current === "running" && r.status === "error") notify(`Render failed: ${r.error}`, true);
    lastRenderStatus.current = r.status;
  }, [view?.state.render, notify]);

  if (error && !view) return <div className="home">Couldn't open this reel: {error}</div>;
  if (!view) return <div className="home hint">Loading…</div>;

  const analysis = Object.values(view.assets).filter((a) => a.status && a.status.stage !== "done");
  const analyzing = analysis.some((a) => a.status!.stage !== "error");
  const analysisError = analysis.find((a) => a.status!.stage === "error");
  const r = view.state.render;
  const latestRender = view.renders[0];
  const renderStale = latestRender && !latestRender.file.includes(`/r${view.project.revision}-`);

  return (
    <>
      <div className="topbar">
        <h1>{view.project.name}</h1>
        <span className="pill">{fmt(view.duration)}</span>
        <span className="pill">{view.clips.length} cuts</span>
        {analyzing && (
          <span className="pill warn">
            Analyzing {analysis.map((a) => `${a.name}: ${a.status!.stage} ${Math.round(a.status!.progress * 100)}%`).join(", ")}
          </span>
        )}
        {analysisError && <span className="pill err">{analysisError.name}: {analysisError.status!.error}</span>}
        <div className="spacer" />
        <button disabled={busy || analyzing} onClick={autoEdit} title="Remove silences and filler words, add zooms and captions">
          ✨ Auto edit
        </button>
        <button disabled={busy || view.revisions.length === 0} onClick={undo}>
          Undo
        </button>
        {r.status === "running" ? (
          <span className="row">
            <span className="hint">Rendering {Math.round(r.progress * 100)}%</span>
            <span className="progress">
              <div style={{ width: `${r.progress * 100}%` }} />
            </span>
          </span>
        ) : (
          <>
            <button disabled={analyzing || !view.clips.length} onClick={() => render("preview")}>
              Render preview
            </button>
            <button className="primary" disabled={analyzing || !view.clips.length} onClick={() => render("final")}>
              Render final
            </button>
          </>
        )}
      </div>
      <div className="workspace">
        <div className="stage">
          <div className="view-toggle">
            <button className={mode === "live" ? "on" : ""} onClick={() => setMode("live")}>
              Live preview
            </button>
            <button className={mode === "render" ? "on" : ""} disabled={!latestRender} onClick={() => setMode("render")}>
              Rendered{renderStale ? " (older)" : ""}
            </button>
          </div>
          {mode === "live" || !latestRender ? (
            <LivePlayer view={view} time={time} setTime={setTime} playing={playing} setPlaying={setPlaying} />
          ) : (
            <div className="phone">
              <video className="render-video" src={`${latestRender.url}?v=${latestRender.mtime}`} controls autoPlay />
            </div>
          )}
        </div>
        <div className="panel">
          <div className="tabs">
            {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
              <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
                {TAB_LABEL[t]}
                {t === "ai" && view.ai?.status === "running" ? " …" : ""}
              </button>
            ))}
          </div>
          <div className="panel-body">
            {tab === "transcript" && <TranscriptPanel view={view} time={time} edit={edit} seek={(t) => (setTime(t), setMode("live"))} inbox={state?.inbox ?? []} />}
            {tab === "style" && <StylePanel view={view} edit={edit} inbox={state?.inbox ?? []} />}
            {tab === "layers" && <LayersPanel view={view} edit={edit} time={time} inbox={state?.inbox ?? []} />}
            {tab === "ai" && <AiPanel view={view} id={id} edit={edit} notify={notify} reload={load} />}
            {tab === "renders" && <RendersPanel view={view} id={id} notify={notify} onDeleted={onDeleted} />}
          </div>
        </div>
      </div>
    </>
  );
}

// ───────────────────────── live preview player

function clipAt(clips: ViewClip[], t: number): number {
  const i = clips.findIndex((c) => t >= c.outStart && t < c.outEnd);
  return i === -1 ? Math.max(0, clips.length - 1) : i;
}

function LivePlayer({ view, time, setTime, playing, setPlaying }: { view: ProjectView; time: number; setTime: (t: number) => void; playing: boolean; setPlaying: (p: boolean) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const clips = view.clips;
  const ref = useRef({ clips, time, playing, index: 0, assetUrl: "" });
  ref.current.clips = clips;
  ref.current.playing = playing;

  // Position the source so the playhead shows the right frame.
  const showFrame = useCallback((t: number) => {
    const v = video.current;
    const c = ref.current.clips;
    if (!v || !c.length) return;
    const i = clipAt(c, t);
    const clip = c[i]!;
    const url = view.assets[clip.asset]?.url ?? "";
    ref.current.index = i;
    const sourceTime = clip.in + Math.max(0, t - clip.outStart);
    if (ref.current.assetUrl !== url) {
      ref.current.assetUrl = url;
      v.src = url;
      v.addEventListener("loadedmetadata", () => (v.currentTime = sourceTime), { once: true });
    } else if (Math.abs(v.currentTime - sourceTime) > 0.05) {
      v.currentTime = sourceTime;
    }
  }, [view.assets]);

  useEffect(() => {
    if (!ref.current.playing) showFrame(time);
    ref.current.time = time;
  }, [time, showFrame, clips]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (!playing) {
      v.pause();
      return;
    }
    let raf = 0;
    if (ref.current.time >= view.duration - 0.05) {
      ref.current.time = 0;
      showFrame(0);
    }
    v.play().catch(() => setPlaying(false));
    const tick = () => {
      const c = ref.current.clips;
      const clip = c[ref.current.index];
      if (clip && !v.seeking) {
        if (v.currentTime >= clip.out - 0.02 || v.ended) {
          const next = c[ref.current.index + 1];
          if (!next) {
            setPlaying(false);
            setTime(view.duration);
            return;
          }
          ref.current.index++;
          const nextUrl = view.assets[next.asset]?.url ?? "";
          if (nextUrl !== ref.current.assetUrl) {
            ref.current.assetUrl = nextUrl;
            v.src = nextUrl;
            v.addEventListener("loadedmetadata", () => ((v.currentTime = next.in), v.play()), { once: true });
          } else if (Math.abs(next.in - v.currentTime) > 0.06) {
            v.currentTime = next.in;
          }
        } else if (v.currentTime >= clip.in - 0.05) {
          const t = clip.outStart + (v.currentTime - clip.in);
          ref.current.time = t;
          setTime(t);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, view.duration, view.assets, setPlaying, setTime, showFrame]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.code !== "Space" || (e.target as HTMLElement).closest("input,textarea,select")) return;
      e.preventDefault();
      setPlaying(!ref.current.playing);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [setPlaying]);

  const clip = clips[clipAt(clips, time)];
  const asset = clip ? view.assets[clip.asset] : undefined;
  const canvas = view.project.canvas;
  const blur = canvas.fill === "blur" && asset && asset.width / asset.height > canvas.width / canvas.height + 0.01;

  let videoStyle: React.CSSProperties = { display: "none" };
  if (clip && asset?.width) {
    if (blur) {
      const h = (canvas.width / asset.width) * asset.height / canvas.height;
      videoStyle = { width: "100%", height: `${h * 100}%`, left: 0, top: `${((1 - h) / 2) * 100}%`, transform: `scale(${clip.zoom})` };
    } else {
      const r = cropRect(asset, canvas, clip);
      videoStyle = {
        width: `${(asset.width / r.cw) * 100}%`,
        height: `${(asset.height / r.ch) * 100}%`,
        left: `${(-r.x / r.cw) * 100}%`,
        top: `${(-r.y / r.ch) * 100}%`,
      };
    }
  }

  const chunk = view.project.captions.enabled ? view.captions.find((c) => time >= c.start && time < c.end) : undefined;
  const cap = view.project.captions;
  const capText = (s: string) => (cap.uppercase ?? cap.style === "bold" ? s.toUpperCase() : s);

  return (
    <>
      <div className="phone" onClick={() => setPlaying(!playing)}>
        {blur && <div className="blur-bg" style={{ backgroundImage: `url("${asset!.thumb}")` }} />}
        <video ref={video} className="main-video" style={videoStyle} playsInline preload="auto" />
        {!clips.length && <div className="phone-empty">{Object.values(view.assets).some((a) => a.status?.stage !== "done") ? "Analyzing your video…" : "No clips. Use Auto edit or Undo."}</div>}
        {view.overlays.map((o) => {
          if (o.outStart === null || o.outEnd === null || time < o.outStart || time >= o.outEnd) return null;
          const a = view.assets[o.asset];
          const box = { full: [0, 0, 100, 100], top: [0, 0, 100, 50], bottom: [0, 50, 100, 50], center: [7, 14, 86, 42], pip: [56, 13, 40, 26] }[o.layout];
          const cover = ["full", "top", "bottom"].includes(o.layout);
          return (
            <div key={o.id} className="overlay" style={{ left: `${box[0]}%`, top: `${box[1]}%`, width: `${box[2]}%`, height: `${box[3]}%` }}>
              <img src={a?.kind === "image" ? a.url : a?.thumb} style={{ objectFit: cover ? "cover" : "contain" }} alt="" />
            </div>
          );
        })}
        {view.texts.map((t) =>
          t.outStart !== null && t.outEnd !== null && time >= t.outStart && time < t.outEnd ? (
            <div key={t.id} className={`text-item ${t.position} ${t.style}`}>
              <span>{t.text}</span>
            </div>
          ) : null,
        )}
        {chunk && (
          <div className={`cap ${cap.style} ${cap.position}`}>
            <span className="line">
              {chunk.words.map((w, i) => {
                const next = chunk.words[i + 1];
                const active = cap.highlight && time >= w.start && (!next || time < next.start);
                return (
                  <span key={i} className={active ? "hl" : ""}>
                    {capText(w.text)}
                    {i < chunk.words.length - 1 ? " " : ""}
                  </span>
                );
              })}
            </span>
          </div>
        )}
      </div>
      <div className="transport">
        <button onClick={() => setPlaying(!playing)} disabled={!clips.length} style={{ width: 70 }}>
          {playing ? "Pause" : "Play"}
        </button>
        <div
          className="scrubber"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setPlaying(false);
            setTime(Math.max(0, Math.min(view.duration, ((e.clientX - rect.left) / rect.width) * view.duration)));
          }}
        >
          {view.duration > 0 && (
            <>
              {clips.map((c) => (
                <div key={c.id} className={`seg ${c.zoom > 1 ? "z" : ""}`} style={{ left: `${(c.outStart / view.duration) * 100}%`, width: `${((c.outEnd - c.outStart) / view.duration) * 100}%` }} />
              ))}
              {view.overlays.map((o) =>
                o.outStart !== null && o.outEnd !== null ? (
                  <div key={o.id} className="ov" style={{ left: `${(o.outStart / view.duration) * 100}%`, width: `${((o.outEnd - o.outStart) / view.duration) * 100}%` }} />
                ) : null,
              )}
              {view.texts.map((t) =>
                t.outStart !== null && t.outEnd !== null ? (
                  <div key={t.id} className="tx" style={{ left: `${(t.outStart / view.duration) * 100}%`, width: `${((t.outEnd - t.outStart) / view.duration) * 100}%` }} />
                ) : null,
              )}
              <div className="head" style={{ left: `${(Math.min(time, view.duration) / view.duration) * 100}%` }} />
            </>
          )}
        </div>
        <span className="time">
          {fmt(Math.min(time, view.duration))} / {fmt(view.duration)}
        </span>
      </div>
    </>
  );
}

// ───────────────────────── transcript

function TranscriptPanel({ view, time, edit, seek, inbox }: { view: ProjectView; time: number; edit: (ops: EditOp[], label?: string) => void; seek: (t: number) => void; inbox: StudioState["inbox"] }) {
  const [sel, setSel] = useState<[number, number] | null>(null);
  const anchor = useRef<number | null>(null);
  const [title, setTitle] = useState("");
  const [image, setImage] = useState("");
  const images = inbox.filter((i) => i.kind === "image" || (i.kind === "video" && i.file.startsWith("inbox/")));

  const nowId = useMemo(() => {
    const w = view.words.find((w) => w.kept && w.outStart !== null && time >= w.outStart && time < w.outStart + (w.end - w.start));
    return w?.id ?? -1;
  }, [view.words, time]);

  if (!view.words.length) {
    const analyzing = Object.values(view.assets).some((a) => a.status?.stage !== "done");
    return <div className="hint">{analyzing ? "Transcribing… the transcript appears here when it's done." : "No speech found in this video."}</div>;
  }

  const click = (w: ViewWord, e: React.MouseEvent) => {
    if (e.shiftKey && anchor.current !== null) {
      setSel([Math.min(anchor.current, w.id), Math.max(anchor.current, w.id)]);
      return;
    }
    anchor.current = w.id;
    setSel([w.id, w.id]);
    if (w.kept && w.outStart !== null) seek(w.outStart);
  };

  const selected = sel ? view.words.slice(sel[0], sel[1] + 1) : [];
  const anyKept = selected.some((w) => w.kept);
  const anyCut = selected.some((w) => !w.kept);
  // A picture pinned to a couple of words would flash by; give short picks about 3 seconds.
  const overlayOp = (asset: string): EditOp => {
    const span = selected.length ? selected[selected.length - 1]!.end - selected[0]!.start : 0;
    return span >= 2
      ? { op: "add_overlay", asset, from: sel![0], to: sel![1], layout: "top" }
      : { op: "add_overlay", asset, from: sel![0], layout: "top" };
  };
  const run = (ops: EditOp[], label: string) => {
    edit(ops, label);
    setSel(null);
  };

  let lastAsset = "";
  return (
    <div className="transcript">
      {sel && (
        <div className="selection-bar">
          <span className="label">
            “{selected.map((w) => w.text).join(" ").slice(0, 80)}{selected.length > 12 ? "…" : ""}” · words #{sel[0]}–#{sel[1]} (shift-click to extend)
          </span>
          {anyKept && <button onClick={() => run([{ op: "cut", from: sel[0], to: sel[1] }], "Cut")}>✂ Cut</button>}
          {anyCut && <button onClick={() => run([{ op: "restore", from: sel[0], to: sel[1] }], "Restored")}>↺ Restore</button>}
          <button onClick={() => run([{ op: "move_to_start", from: sel[0], to: sel[1] }], "Moved to the start as the hook")}>⚡ Make hook</button>
          <button onClick={() => run([{ op: "keep", ranges: [{ from: sel[0], to: sel[1] }] }], "Kept only this part")}>Keep only this</button>
          <div className="row" style={{ width: "100%" }}>
            <input type="text" placeholder="Title text over these words" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1 }} />
            <button disabled={!title.trim()} onClick={() => (run([{ op: "add_text", text: title.trim(), from: sel[0], to: sel[1] }], "Added title"), setTitle(""))}>
              Add title
            </button>
          </div>
          {images.length > 0 && (
            <div className="row" style={{ width: "100%" }}>
              <select value={image} onChange={(e) => setImage(e.target.value)} style={{ flex: 1 }}>
                <option value="">Show an image / clip over these words…</option>
                {images.map((i) => (
                  <option key={i.file} value={i.name}>
                    {i.name}
                  </option>
                ))}
              </select>
              <button disabled={!image} onClick={() => (run([overlayOp(image)], "Added overlay"), setImage(""))}>
                Add
              </button>
            </div>
          )}
          <button className="ghost" onClick={() => setSel(null)}>
            Clear
          </button>
        </div>
      )}
      {view.words.map((w, i) => {
        const prev = view.words[i - 1];
        const header = w.asset !== lastAsset ? ((lastAsset = w.asset), <div className="asset-label">{view.assets[w.asset]?.name}</div>) : null;
        const pause = prev && prev.asset === w.asset && w.start - prev.end >= 0.6 ? <span className="gap">⏸{(w.start - prev.end).toFixed(1)}s </span> : null;
        const inSel = sel && w.id >= sel[0] && w.id <= sel[1];
        const cls = ["w", w.kept ? "" : "cut", w.filler ? "filler" : "", w.id === nowId ? "now" : "", inSel ? "sel" : ""].join(" ");
        return (
          <span key={w.id}>
            {header}
            {pause}
            <span className={cls} onClick={(e) => click(w, e)} title={`#${w.id} · ${w.start.toFixed(2)}s`}>
              {w.text}
            </span>{" "}
          </span>
        );
      })}
    </div>
  );
}

// ───────────────────────── style

function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg-buttons">
      {options.map(([v, label]) => (
        <button key={String(v)} className={v === value ? "on" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function StylePanel({ view, edit, inbox }: { view: ProjectView; edit: (ops: EditOp[], label?: string) => void; inbox: StudioState["inbox"] }) {
  const cap = view.project.captions;
  const music = view.project.audio.music;
  const [minSilence, setMinSilence] = useState(0.35);
  const [focus, setFocus] = useState(view.clips[0]?.focusX ?? 0.5);
  const audio = inbox.filter((i) => i.kind === "audio");
  const zoomed = view.clips.some((c) => c.zoom > 1);

  return (
    <>
      <div className="field">
        <label>Pacing</label>
        <div className="row">
          <button onClick={() => edit([{ op: "remove_silences", minSilence }], "Removed silences")}>Remove silences</button>
          <button onClick={() => edit([{ op: "remove_fillers" }], "Removed filler words")}>Remove um / uh</button>
        </div>
        <div className="hint">Cut pauses longer than {minSilence.toFixed(2)}s</div>
        <input type="range" min={0.15} max={1.5} step={0.05} value={minSilence} onChange={(e) => setMinSilence(Number(e.target.value))} />
      </div>

      <div className="field">
        <label>Captions</label>
        <div className="row">
          <Seg value={cap.enabled ? cap.style : "off"} options={[["bold", "Bold"], ["clean", "Clean"], ["minimal", "Minimal"], ["off", "Off"]]}
            onChange={(v) => edit([{ op: "captions", ...(v === "off" ? { enabled: false } : { enabled: true, style: v }) }], "Captions updated")} />
        </div>
        <div className="row">
          <Seg value={cap.maxWords} options={[[1, "1"], [2, "2"], [3, "3"], [4, "4"], [6, "6"]]} onChange={(v) => edit([{ op: "captions", maxWords: v }], `${v} words per caption`)} />
          <span className="hint">words at a time</span>
        </div>
        <div className="row">
          <Seg value={cap.position} options={[["upper", "Upper"], ["middle", "Middle"], ["lower", "Lower"]]} onChange={(v) => edit([{ op: "captions", position: v }], "Captions moved")} />
          <label className="row hint">
            <input type="checkbox" checked={cap.highlight} onChange={(e) => edit([{ op: "captions", highlight: e.target.checked }])} /> highlight active word
          </label>
        </div>
      </div>

      <div className="field">
        <label>Framing</label>
        <div className="row">
          <Seg value={view.project.canvas.fill} options={[["crop", "Fill (crop)"], ["blur", "Fit + blur"]]} onChange={(v) => edit([{ op: "frame", fill: v }], "Framing updated")} />
          <button className={zoomed ? "" : "primary"} onClick={() => edit([{ op: "auto_zoom", zoom: zoomed ? 1 : 1.12 }])}>
            {zoomed ? "Remove zooms" : "Punch-in zooms"}
          </button>
        </div>
        <div className="hint">Crop position (for wide videos): {Math.round(focus * 100)}%</div>
        <input type="range" min={0} max={1} step={0.01} value={focus} onChange={(e) => setFocus(Number(e.target.value))}
          onMouseUp={() => edit([{ op: "frame", focusX: focus }], "Crop moved")} onTouchEnd={() => edit([{ op: "frame", focusX: focus }], "Crop moved")} />
      </div>

      <div className="field">
        <label>Music</label>
        <select value={music ? view.assets[music.asset]?.name ?? "" : ""} onChange={(e) => edit([{ op: "music", asset: e.target.value || null }], e.target.value ? "Music added" : "Music removed")}>
          <option value="">No music</option>
          {audio.map((a) => (
            <option key={a.file} value={a.name}>
              {a.name}
            </option>
          ))}
        </select>
        {!audio.length && <div className="hint">Drop an MP3 or M4A to use it as background music.</div>}
        {music && (
          <>
            <div className="hint">Volume {music.volumeDb} dB (lowered automatically while you talk)</div>
            <Seg value={music.volumeDb} options={[[-26, "Quiet"], [-20, "Normal"], [-14, "Loud"]]} onChange={(v) => edit([{ op: "music", asset: music.asset, volumeDb: v }])} />
          </>
        )}
      </div>

      <div className="field">
        <label>Start over</label>
        <div className="row">
          <button className="danger" onClick={() => confirm("Reset to the full, uncut video? (You can undo.)") && edit([{ op: "reset" }], "Reset to the uncut video")}>
            Reset to uncut video
          </button>
        </div>
      </div>
    </>
  );
}

// ───────────────────────── layers

function LayersPanel({ view, edit, time, inbox }: { view: ProjectView; edit: (ops: EditOp[], label?: string) => void; time: number; inbox: StudioState["inbox"] }) {
  const [text, setText] = useState("");
  const media = inbox.filter((i) => i.kind === "image" || (i.kind === "video" && i.file.startsWith("inbox/")));
  return (
    <>
      <div className="field">
        <label>Add at the playhead ({fmt(time)})</label>
        <div className="row">
          <input type="text" placeholder="Title text, e.g. 3 mistakes I made" value={text} onChange={(e) => setText(e.target.value)} style={{ flex: 1 }} />
          <button disabled={!text.trim()} onClick={() => (edit([{ op: "add_text", text: text.trim(), start: time, end: time + 2.5 }], "Added title"), setText(""))}>
            Add title
          </button>
        </div>
        <div className="row">
          {media.map((m) => (
            <button key={m.file} title={`Show ${m.name} for 3s`} onClick={() => edit([{ op: "add_overlay", asset: m.name, start: time, end: time + 3, layout: "top" }], "Added overlay")}
              style={{ padding: 3 }}>
              <div className="media-thumb" style={{ backgroundImage: `url("${m.thumb}")`, width: 56, height: 38 }} />
            </button>
          ))}
        </div>
        <div className="hint">Tip: select words in the transcript to pin an image or title to what you're saying.</div>
      </div>

      <div className="field">
        <label>Images & clips</label>
        {!view.overlays.length && <div className="hint">None yet.</div>}
        {view.overlays.map((o) => (
          <div key={o.id} className="layer">
            <div className="media-thumb" style={{ backgroundImage: `url("${view.assets[o.asset]?.thumb}")` }} />
            <div className="grow">
              {view.assets[o.asset]?.name}
              <div className="hint">{o.outStart !== null && o.outEnd !== null ? `${fmt(o.outStart)}–${fmt(o.outEnd)}` : "its words were cut"}</div>
            </div>
            <select value={o.layout} onChange={(e) => edit([{ op: "update_overlay", id: o.id, layout: e.target.value as typeof o.layout }])}>
              <option value="top">Top half</option>
              <option value="full">Full screen</option>
              <option value="bottom">Bottom half</option>
              <option value="center">Card</option>
              <option value="pip">Corner</option>
            </select>
            <button className="ghost danger" onClick={() => edit([{ op: "remove_overlay", id: o.id }], "Removed overlay")}>
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="field">
        <label>Titles</label>
        {!view.texts.length && <div className="hint">None yet.</div>}
        {view.texts.map((t) => (
          <div key={t.id} className="layer">
            <div className="grow">
              {t.text}
              <div className="hint">{t.outStart !== null && t.outEnd !== null ? `${fmt(t.outStart)}–${fmt(t.outEnd)}` : "its words were cut"}</div>
            </div>
            <select value={t.position} onChange={(e) => edit([{ op: "update_text", id: t.id, position: e.target.value as typeof t.position }])}>
              <option value="top">Top</option>
              <option value="center">Center</option>
              <option value="bottom">Bottom</option>
            </select>
            <button className="ghost danger" onClick={() => edit([{ op: "remove_text", id: t.id }], "Removed title")}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

// ───────────────────────── AI

const SUGGESTIONS = [
  "Make the hook punchier",
  "Make it shorter, under 30 seconds",
  "Cut the slow intro",
  "Put my photos where I talk about them",
  "Use the clean caption style",
];

function AiPanel({ view, id, edit, notify, reload }: { view: ProjectView; id: string; edit: (ops: EditOp[], label?: string) => void; notify: (t: string, err?: boolean) => void; reload: () => void }) {
  const [brief, setBrief] = useState(view.project.brief);
  const [instruction, setInstruction] = useState("");
  const savedBrief = useRef(view.project.brief);
  useEffect(() => {
    // Follow changes made elsewhere (e.g. by the AI) unless the user is mid-edit.
    if (view.project.brief !== savedBrief.current) {
      setBrief((b) => (b === savedBrief.current ? view.project.brief : b));
      savedBrief.current = view.project.brief;
    }
  }, [view.project.brief]);
  const ai = view.ai;
  const running = ai?.status === "running";
  const ask = async (text: string) => {
    if (!text.trim()) return;
    try {
      await api(`/api/projects/${id}/ask`, { method: "POST", body: { instruction: text.trim() } });
      setInstruction("");
      reload();
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  return (
    <>
      <div className="field">
        <label>Ask the AI to change this reel</label>
        <textarea
          rows={3}
          placeholder="e.g. Start with the part about pricing, and add my logo.png at the end"
          value={instruction}
          disabled={running}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && ask(instruction)}
        />
        <div className="row">
          <button className="primary" disabled={running || !instruction.trim()} onClick={() => ask(instruction)}>
            {running ? "Working…" : "Ask AI"}
          </button>
          {SUGGESTIONS.map((sug) => (
            <button key={sug} className="chip" disabled={running} onClick={() => ask(sug)}>
              {sug}
            </button>
          ))}
        </div>
        {ai && (
          <div className={`ai-status ${ai.status}`}>
            <b>“{ai.instruction}”</b>
            <div>{ai.status === "running" ? ai.step : ai.status === "done" ? ai.summary : ai.error}</div>
          </div>
        )}
      </div>

      <div className="field">
        <label>What is this reel about? (the AI reads this)</label>
        <textarea
          rows={4}
          placeholder="Topic, who it's for, the call to action… e.g. Tips for new café owners. CTA: book a free consult, link in bio."
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
        />
        <div className="row">
          <button disabled={brief === view.project.brief} onClick={() => ((savedBrief.current = brief), edit([{ op: "brief", text: brief }], "Saved"))}>
            Save
          </button>
          <span className="hint">Tip: drop a notes.txt with your video and it lands here automatically.</span>
        </div>
      </div>

      <div className="field">
        <label>Publish copy</label>
        <textarea readOnly rows={6} value={view.project.notes || "The AI writes a title, caption and hashtags here when it edits."} />
        <div className="row">
          <button
            disabled={!view.project.notes}
            onClick={() => navigator.clipboard.writeText(view.project.notes).then(() => notify("Copied"), () => notify("Couldn't copy", true))}
          >
            Copy
          </button>
        </div>
      </div>
    </>
  );
}

// ───────────────────────── renders

function RendersPanel({ view, id, notify, onDeleted }: { view: ProjectView; id: string; notify: (t: string, err?: boolean) => void; onDeleted: () => void }) {
  const latest = view.renders[0];
  return (
    <div className="render-list">
      {!latest && <div className="hint">No renders yet. Press “Render preview” or “Render final”.</div>}
      {latest && (
        <div className="field">
          <label>Latest: {latest.file.replace("renders/", "")}</label>
          <video src={`${latest.url}?v=${latest.mtime}`} controls />
          <div className="row">
            <a href={latest.url} download={`${view.project.id}.mp4`}>
              <button>Download</button>
            </a>
            <button onClick={() => api(`/api/projects/${id}/reveal`, { method: "POST" }).catch((e) => notify(e.message, true))}>Show in Finder</button>
          </div>
        </div>
      )}
      {view.renders.length > 1 && (
        <div className="field">
          <label>Older renders</label>
          {view.renders.slice(1).map((r) => (
            <a key={r.file} href={r.url} target="_blank" rel="noreferrer">
              {r.file.replace("renders/", "")} · {fmtSize(r.size)}
            </a>
          ))}
        </div>
      )}
      <div className="field">
        <label>Project</label>
        <div className="hint">Revision {view.project.revision} · {view.clips.length} clips</div>
        <div className="row">
          <button
            className="danger"
            onClick={async () => {
              if (!confirm(`Delete "${view.project.name}"? Your videos in the inbox are kept.`)) return;
              await api(`/api/projects/${id}`, { method: "DELETE" });
              onDeleted();
            }}
          >
            Delete reel
          </button>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
