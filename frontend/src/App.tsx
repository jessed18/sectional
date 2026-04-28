import { useCallback, useEffect, useState } from "react";
import {
  getHealth,
  getJob,
  isApiError,
  postAnalyze,
  postSeparate,
  stemAudioUrl,
  type AnalyzeResponse,
  type SeparateResponse,
} from "./api";
import "./App.css";

function StatusPill({ ok }: { ok: boolean | null }) {
  if (ok === null) {
    return <span className="pill pill-pending">backend …</span>;
  }
  return (
    <span className={ok ? "pill pill-ok" : "pill pill-bad"}>
      {ok ? "api online" : "api offline"}
    </span>
  );
}

export default function App() {
  const [apiOk, setApiOk] = useState<boolean | null>(null);

  const [analyzeText, setAnalyzeText] = useState(
    "give me the soprano part"
  );
  const [useRag, setUseRag] = useState(false);
  const [analyzeLoading, setAnalyzeLoading] = useState(false);
  const [analyzeResult, setAnalyzeResult] = useState<AnalyzeResponse | null>(
    null
  );
  const [analyzeErr, setAnalyzeErr] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [sepLoading, setSepLoading] = useState(false);
  const [sepResult, setSepResult] = useState<SeparateResponse | null>(null);
  const [sepErr, setSepErr] = useState<string | null>(null);

  const ping = useCallback(async () => {
    const h = await getHealth();
    setApiOk(!isApiError(h) && h.status === "ok");
  }, []);

  useEffect(() => {
    void ping();
    const t = setInterval(() => void ping(), 15000);
    return () => clearInterval(t);
  }, [ping]);

  async function onAnalyze(e: React.FormEvent) {
    e.preventDefault();
    setAnalyzeErr(null);
    setAnalyzeResult(null);
    setAnalyzeLoading(true);
    const res = await postAnalyze(analyzeText.trim(), useRag);
    setAnalyzeLoading(false);
    if (isApiError(res)) {
      setAnalyzeErr(res.error);
      return;
    }
    setAnalyzeResult(res);
  }

  async function onSeparate(e: React.FormEvent) {
    e.preventDefault();
    setSepErr(null);
    setSepResult(null);
    if (!file) {
      setSepErr("choose an audio file first");
      return;
    }
    setSepLoading(true);
    const res = await postSeparate(file);
    setSepLoading(false);
    if (isApiError(res)) {
      setSepErr(res.details ? `${res.error}: ${res.details}` : res.error);
      return;
    }
    setSepResult(res);
  }

  async function refreshJob() {
    if (!sepResult?.job_id) return;
    const res = await getJob(sepResult.job_id);
    if (!isApiError(res)) {
      setSepResult((prev) =>
        prev
          ? {
              ...prev,
              stems: res.stems,
              files: res.files,
            }
          : prev
      );
    }
  }

  return (
    <div className="layout">
      <header className="header">
        <div>
          <h1 className="title">Sectional</h1>
          <p className="tagline">
            choir stems, natural-language voice parts, demucs under the hood
          </p>
        </div>
        <div className="header-actions">
          <StatusPill ok={apiOk} />
          <button type="button" className="btn ghost" onClick={() => void ping()}>
            refresh
          </button>
        </div>
      </header>

      <main className="grid">
        <section className="card">
          <h2 className="card-title">voice part (claude)</h2>
          <p className="card-desc">
            describe what you want in plain language; the api returns structured
            json for downstream processing.
          </p>
          <form onSubmit={onAnalyze} className="form">
            <label className="label" htmlFor="nl">
              request
            </label>
            <textarea
              id="nl"
              className="textarea"
              rows={4}
              value={analyzeText}
              onChange={(e) => setAnalyzeText(e.target.value)}
              placeholder="e.g. isolate the alto line"
            />
            <label className="check">
              <input
                type="checkbox"
                checked={useRag}
                onChange={(e) => setUseRag(e.target.checked)}
              />
              use rehearsal / sheet-music context (rag) when available
            </label>
            <button type="submit" className="btn primary" disabled={analyzeLoading}>
              {analyzeLoading ? "analyzing…" : "analyze"}
            </button>
          </form>
          {analyzeErr && <p className="err">{analyzeErr}</p>}
          {analyzeResult && (
            <pre className="json-out">{JSON.stringify(analyzeResult, null, 2)}</pre>
          )}
        </section>

        <section className="card">
          <h2 className="card-title">separate stems (demucs)</h2>
          <p className="card-desc">
            upload a mixed recording; the server runs demucs and exposes per-stem
            wavs. first run can take a while while models load.
          </p>
          <form onSubmit={onSeparate} className="form">
            <label className="label" htmlFor="audio">
              audio file
            </label>
            <input
              id="audio"
              type="file"
              accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a"
              className="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <button type="submit" className="btn primary" disabled={sepLoading}>
              {sepLoading ? "separating…" : "separate"}
            </button>
          </form>
          {sepErr && <p className="err">{sepErr}</p>}
          {sepResult && (
            <div className="stems">
              <div className="stems-head">
                <p className="job-id">
                  job <code>{sepResult.job_id}</code>
                </p>
                <button type="button" className="btn ghost sm" onClick={refreshJob}>
                  refresh job
                </button>
              </div>
              <ul className="stem-list">
                {sepResult.stems.map((stem) => (
                  <li key={stem} className="stem-item">
                    <span className="stem-name">{stem}</span>
                    <audio
                      controls
                      src={stemAudioUrl(sepResult.job_id, stem)}
                      className="player"
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </main>

      <footer className="footer">
        <span>dev: run flask on :5000 and vite on :5173 — requests proxy through /api</span>
      </footer>
    </div>
  );
}
