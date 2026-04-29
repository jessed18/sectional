import { useCallback, useEffect, useState } from "react";
import {
  getHealth,
  getJob,
  isApiError,
  postAnalyze,
  postEmphasize,
  postSeparate,
  stemAudioUrl,
  type AnalyzeResponse,
  type SeparateResponse,
} from "./api";
import "./App.css";

const STORAGE_DEV = "sectional-developer-mode";

const TAGLINE_SINGER =
  "\u266a hear your line more clearly: upload your rehearsal recording, pull the singers away from the piano, get simple tips for your part, then gently bring your section forward in the mix.";

const TAGLINE_DEV =
  "\u266a practice tool for choirs & a cappella groups: pull out vocal lines, get cues for your part, then gently eq so your line sits forward in the mix - powered by stem separation (isolated tracks), an LLM (plain-language \u2192 structured data), and band-pass DSP (frequency shaping, not magic).";

const PART_QUICK_LINES: { label: string; line: string }[] = [
  { label: "soprano", line: "bring out the soprano line." },
  { label: "alto", line: "bring out the alto line." },
  { label: "mezzo", line: "bring out the mezzo-soprano line." },
  { label: "tenor", line: "bring out the tenor line." },
  { label: "baritone", line: "bring out the baritone line." },
  { label: "bass", line: "bring out the bass line." },
  { label: "everyone", line: "all voices together - no single part boosted." },
];

function StatusPill({
  ok,
  simple,
}: {
  ok: boolean | null;
  simple: boolean;
}) {
  if (ok === null) {
    return (
      <span className="pill pill-pending" title={simple ? undefined : "checking /health"}>
        …
      </span>
    );
  }
  return (
    <span
      className={ok ? "pill pill-ok" : "pill pill-bad"}
      title={simple ? undefined : ok ? "api up" : "start the flask backend"}
    >
      {simple ? (ok ? "connected" : "not connected") : ok ? "online" : "offline"}
    </span>
  );
}

function SingerSummary({ result }: { result: AnalyzeResponse }) {
  return (
    <div className="singer-summary" role="region" aria-label="tips for your part">
      <p className="singer-summary-lead">
        <strong>your part:</strong> {result.part}
      </p>
      {result.interpretation ? (
        <p className="singer-summary-block">
          <span className="singer-summary-label">what we heard</span>
          {result.interpretation}
        </p>
      ) : null}
      {result.coaching ? (
        <p className="singer-summary-block">
          <span className="singer-summary-label">listening tips</span>
          {result.coaching}
        </p>
      ) : null}
      {result.measure_cues ? (
        <p className="singer-summary-block">
          <span className="singer-summary-label">entrances &amp; cues</span>
          {result.measure_cues}
        </p>
      ) : null}
    </div>
  );
}

export default function App() {
  const [developerMode, setDeveloperMode] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_DEV) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      if (developerMode) localStorage.setItem(STORAGE_DEV, "1");
      else localStorage.removeItem(STORAGE_DEV);
    } catch {
      /* ignore */
    }
  }, [developerMode]);

  const [apiOk, setApiOk] = useState<boolean | null>(null);

  const [analyzeText, setAnalyzeText] = useState(PART_QUICK_LINES[0].line);
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

  const [emphLoading, setEmphLoading] = useState(false);
  const [emphErr, setEmphErr] = useState<string | null>(null);

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
      setSepErr(
        developerMode
          ? "pick an audio file first (either column)."
          : "choose a recording above first."
      );
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

  const canEmphasize = Boolean(sepResult?.job_id && analyzeResult);

  async function onEmphasize() {
    if (!sepResult?.job_id || !analyzeResult) return;
    setEmphErr(null);
    setEmphLoading(true);
    const res = await postEmphasize(
      sepResult.job_id,
      analyzeResult.part,
      analyzeResult.frequency_range_hz
    );
    setEmphLoading(false);
    if (isApiError(res)) {
      setEmphErr(res.error);
      return;
    }
    await refreshJob();
  }

  const uploadBlock = (id: string) => (
    <div className="form">
      <label className="label" htmlFor={id}>
        your recording
      </label>
      <input
        id={id}
        type="file"
        accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a"
        className="file"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      {file ? (
        <p className="file-picked">
          selected: <strong>{file.name}</strong>
        </p>
      ) : (
        <p className="file-picked muted">
          {developerMode
            ? "no file yet - needed for split & eq"
            : "choose a file to begin"}
        </p>
      )}
    </div>
  );

  return (
    <div className="layout">
      <header className="header">
        <div className="header-main">
          <h1 className="title">sectional</h1>
          <p className="tagline tagline-long">
            {developerMode ? TAGLINE_DEV : TAGLINE_SINGER}
          </p>
          {developerMode ? (
            <details className="extra">
              <summary>technical notes</summary>
              <p className="extra-body">
                stems via demucs; part + Hz hints via claude (<code>POST /analyze</code>
                ); gentle band-pass on the vocal stem (<code>POST /emphasize</code>).
                optional RAG = score text in the prompt. see repo{" "}
                <strong>readme</strong> for architecture and deployment.
              </p>
            </details>
          ) : null}
        </div>
        <div className="header-actions">
          <label className="dev-toggle">
            <input
              type="checkbox"
              checked={developerMode}
              onChange={(e) => setDeveloperMode(e.target.checked)}
            />
            developer mode
          </label>
          <StatusPill ok={apiOk} simple={!developerMode} />
          {developerMode ? (
            <button type="button" className="btn ghost" onClick={() => void ping()}>
              ping
            </button>
          ) : null}
        </div>
      </header>

      <main className={developerMode ? "grid" : "flow-singer"}>
        {developerMode ? (
          <>
            <section className="card">
              <h2 className="card-title">your part</h2>
              <p className="card-desc card-desc-tight">
                upload <strong>your</strong> recording here too (same file you use for
                split). then tap a section or type below and analyze - part, pitch band
                (Hz), and cues.
              </p>
              {uploadBlock("audio-part")}
              <div className="part-grid" role="group" aria-label="Quick part lines">
                {PART_QUICK_LINES.map(({ label, line }) => (
                  <button
                    key={label}
                    type="button"
                    className="btn part-btn"
                    onClick={() => setAnalyzeText(line)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <form onSubmit={onAnalyze} className="form">
                <label className="label" htmlFor="nl">
                  say it your way
                </label>
                <textarea
                  id="nl"
                  className="textarea textarea-short"
                  rows={3}
                  value={analyzeText}
                  onChange={(e) => setAnalyzeText(e.target.value)}
                  placeholder="or write your own request…"
                />
                <label className="check check-tight">
                  <input
                    type="checkbox"
                    checked={useRag}
                    onChange={(e) => setUseRag(e.target.checked)}
                  />
                  use ingested score / notes (RAG)
                </label>
                <button type="submit" className="btn primary" disabled={analyzeLoading}>
                  {analyzeLoading ? "…" : "analyze"}
                </button>
              </form>
              {analyzeErr && <p className="err">{analyzeErr}</p>}
              {analyzeResult && (
                <div className="json-block">
                  <details className="extra extra-inline">
                    <summary>raw json (for apps)</summary>
                    <pre className="json-out">
                      {JSON.stringify(analyzeResult, null, 2)}
                    </pre>
                  </details>
                </div>
              )}
            </section>

            <section className="card">
              <h2 className="card-title">split the mix</h2>
              <p className="card-desc card-desc-tight">
                same upload as <strong>your part</strong> - get layers like{" "}
                <strong>vocals</strong> vs backing.
              </p>
              <details className="extra extra-inline">
                <summary>more</summary>
                <p className="extra-body">
                  demucs ml separation; first run may download weights.{" "}
                  <code>POST /separate</code>.
                </p>
              </details>
              <form onSubmit={onSeparate} className="form">
                <label className="label" htmlFor="audio">
                  your recording
                </label>
                <input
                  id="audio"
                  type="file"
                  accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a"
                  className="file"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
                {file && (
                  <p className="file-picked">
                    selected: <strong>{file.name}</strong>
                  </p>
                )}
                <button type="submit" className="btn primary" disabled={sepLoading}>
                  {sepLoading ? "…" : "separate"}
                </button>
              </form>
              {sepErr && <p className="err">{sepErr}</p>}
              {sepResult && (
                <div className="stems">
                  <div className="stems-head">
                    <p className="job-id">
                      session <code>{sepResult.job_id}</code>
                    </p>
                    <button type="button" className="btn ghost sm" onClick={refreshJob}>
                      refresh
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

            <section className="card span-full">
              <h2 className="card-title">boost your line (eq)</h2>
              <p className="card-desc card-desc-tight">
                after <strong>separate</strong> + <strong>analyze</strong>: we eq the
                vocal stem so your register is louder in headphones. original{" "}
                <code>vocals.wav</code> stays; you get{" "}
                <code>{'{part}'}_emphasized.wav</code>.
              </p>
              <details className="extra extra-inline">
                <summary>more</summary>
                <p className="extra-body">
                  butterworth band-pass + blend; not solo isolation.{" "}
                  <code>POST /emphasize</code> uses <code>frequency_range_hz</code> from
                  analysis.
                </p>
              </details>
              <div className="emph-row">
                <button
                  type="button"
                  className="btn primary"
                  disabled={!canEmphasize || emphLoading}
                  onClick={() => void onEmphasize()}
                >
                  {emphLoading ? "…" : "apply eq"}
                </button>
                {!canEmphasize && (
                  <span className="hint">
                    upload your file, then separate + analyze.
                  </span>
                )}
              </div>
              {emphErr && <p className="err">{emphErr}</p>}
            </section>
          </>
        ) : (
          <section className="card card-singer-flow">
            <h2 className="card-title">rehearsal helper</h2>
            <p className="card-desc card-desc-tight singer-intro">
              work top to bottom. you can <strong>split</strong> and{" "}
              <strong>get tips</strong> in either order, then <strong>boost your part</strong>{" "}
              when both are done.
            </p>

            <div className="flow-step flow-step-first">
              <h3 className="flow-step-title">
                <span className="flow-step-num">1</span> your recording
              </h3>
              {uploadBlock("audio-singer")}
            </div>

            <div className="flow-step">
              <h3 className="flow-step-title">
                <span className="flow-step-num">2</span> split singers from the accompaniment
              </h3>
              <p className="flow-step-desc">
                separates an “all singers” track from piano, organ, or backing - so you
                can focus on the choir.
              </p>
              <form onSubmit={onSeparate} className="form flow-step-form">
                <button type="submit" className="btn primary" disabled={sepLoading}>
                  {sepLoading ? "working…" : "split recording"}
                </button>
              </form>
              {sepErr && <p className="err">{sepErr}</p>}
              {sepResult && (
                <div className="stems stems-compact">
                  <p className="stems-compact-label">listen to each layer</p>
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
                  <button type="button" className="btn ghost sm" onClick={refreshJob}>
                    refresh list
                  </button>
                </div>
              )}
            </div>

            <div className="flow-step">
              <h3 className="flow-step-title">
                <span className="flow-step-num">3</span> which line are you learning?
              </h3>
              <p className="flow-step-desc">
                tap your section or write in your own words, then get plain-language tips.
              </p>
              <div className="part-grid" role="group" aria-label="Voice sections">
                {PART_QUICK_LINES.map(({ label, line }) => (
                  <button
                    key={label}
                    type="button"
                    className="btn part-btn"
                    onClick={() => setAnalyzeText(line)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <form onSubmit={onAnalyze} className="form">
                <label className="label" htmlFor="nl-singer">
                  your words (optional edit)
                </label>
                <textarea
                  id="nl-singer"
                  className="textarea textarea-short"
                  rows={3}
                  value={analyzeText}
                  onChange={(e) => setAnalyzeText(e.target.value)}
                  placeholder="e.g. help me hear the alto on page two"
                />
                <button type="submit" className="btn primary" disabled={analyzeLoading}>
                  {analyzeLoading ? "working…" : "get tips for my part"}
                </button>
              </form>
              {analyzeErr && <p className="err">{analyzeErr}</p>}
              {analyzeResult ? <SingerSummary result={analyzeResult} /> : null}
            </div>

            <div className="flow-step flow-step-last">
              <h3 className="flow-step-title">
                <span className="flow-step-num">4</span> make my part a little louder
              </h3>
              <p className="flow-step-desc">
                gentle tone shaping on the singers’ track - not a perfect solo, but
                easier to hear your section in headphones. run this after split and tips.
              </p>
              <div className="emph-row">
                <button
                  type="button"
                  className="btn primary"
                  disabled={!canEmphasize || emphLoading}
                  onClick={() => void onEmphasize()}
                >
                  {emphLoading ? "working…" : "boost my part"}
                </button>
                {!canEmphasize && (
                  <span className="hint">finish steps 2 and 3 first.</span>
                )}
              </div>
              {emphErr && <p className="err">{emphErr}</p>}
              {sepResult && canEmphasize && (
                <p className="flow-hint">
                  after boosting, use <strong>refresh list</strong> above if you don’t see
                  a new track.
                </p>
              )}
            </div>
          </section>
        )}
      </main>

      {developerMode ? (
        <footer className="footer">
          <details className="extra">
            <summary>local dev</summary>
            <p className="extra-body">
              flask <code>:5000</code>, vite <code>:5173</code>, browser uses{" "}
              <code>/api</code> proxy.
            </p>
          </details>
        </footer>
      ) : (
        <footer className="footer footer-singer">
          <span>having trouble? ask your music director or try turning on developer mode.</span>
        </footer>
      )}
    </div>
  );
}
