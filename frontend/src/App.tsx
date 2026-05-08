import { useCallback, useEffect, useState } from "react";
import {
  getHealth,
  getJob,
  isApiError,
  postAnalyze,
  postEmphasize,
  postRagIngestFile,
  postSeparate,
  stemAudioUrl,
  type AnalyzeResponse,
  type SeparateResponse,
} from "./api";
import "./App.css";

const STORAGE_DEV = "sectional-developer-mode";
const SAMPLE_SCORE_PATH = "/samples/have-yourself-a-merry-little-christmas.pdf";
const SAMPLE_SCORE_TITLE = "Have Yourself a Merry Little Christmas";
const SAMPLE_SCORE_NAME = `${SAMPLE_SCORE_TITLE}.pdf`;

const TAGLINE_SINGER =
  `\u266a ${SAMPLE_SCORE_TITLE} is built in — no upload required for tips. Tap your section, type your line, get coaching; upload only if you want a different PDF or a rehearsal recording for split/EQ.`;

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

/** Singer section chips only (must stay in sync with voice-part detection on the server). */
const SINGER_VOICE_SECTIONS = [
  "soprano",
  "alto",
  "mezzo",
  "tenor",
  "baritone",
  "bass",
  "everyone",
] as const;

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
          <span className="singer-summary-label">summary</span>
          {result.interpretation}
        </p>
      ) : null}
      {result.coaching ? (
        <p className="singer-summary-block">
          <span className="singer-summary-label">how to sing this part</span>
          {result.coaching}
        </p>
      ) : null}
      {result.measure_cues ? (
        <p className="singer-summary-block">
          <span className="singer-summary-label">from your sheet music</span>
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

  const [analyzeText, setAnalyzeText] = useState("");
  const [useRag, setUseRag] = useState(false);
  const [useSampleScore, setUseSampleScore] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_DEV) !== "1";
    } catch {
      return true;
    }
  });
  const [analyzeLoading, setAnalyzeLoading] = useState(false);
  const [analyzeResult, setAnalyzeResult] = useState<AnalyzeResponse | null>(
    null
  );
  const [analyzeErr, setAnalyzeErr] = useState<string | null>(null);
  /** Developer-only: when true, POST /analyze calls Claude (seconds); default stays instant/heuristic. */
  const [useAiAnalyze, setUseAiAnalyze] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [sepLoading, setSepLoading] = useState(false);
  const [sepResult, setSepResult] = useState<SeparateResponse | null>(null);
  const [sepErr, setSepErr] = useState<string | null>(null);

  const [emphLoading, setEmphLoading] = useState(false);
  const [emphErr, setEmphErr] = useState<string | null>(null);
  const [ragIngestMsg, setRagIngestMsg] = useState<string | null>(null);
  const [ragIngestErr, setRagIngestErr] = useState<string | null>(null);
  const [ragIngestLoading, setRagIngestLoading] = useState(false);
  const [scoreFile, setScoreFile] = useState<File | null>(null);
  /** Singer flow: section button (lyrics go in analyzeText). */
  const [singerVoicePart, setSingerVoicePart] = useState<string | null>(null);

  useEffect(() => {
    if (developerMode) return;
    if (!useRag) {
      setUseSampleScore(true);
    }
  }, [developerMode, useRag]);

  const ping = useCallback(async () => {
    const h = await getHealth();
    setApiOk(!isApiError(h) && h.status === "ok");
  }, []);

  useEffect(() => {
    void ping();
    const t = setInterval(() => void ping(), 15000);
    return () => clearInterval(t);
  }, [ping]);

  async function ingestScoreFile(fileToIngest: File, source: string) {
    setRagIngestErr(null);
    setRagIngestLoading(true);
    const res = await postRagIngestFile(fileToIngest, source);
    setRagIngestLoading(false);
    if (isApiError(res)) {
      setRagIngestErr(res.error);
      return null;
    }
    const okRes = res;
    setUseRag(true);
    setUseSampleScore(false);
    setRagIngestMsg(
      `${okRes.chunks_added} text chunk${okRes.chunks_added === 1 ? "" : "s"} from ${okRes.source}. Tips now use your PDF (refresh the page to go back to the provided score only).`
    );
    return okRes;
  }

  async function onUseSampleScore() {
    setRagIngestErr(null);
    setUseSampleScore(true);
    setUseRag(false);
    setRagIngestMsg(
      `using built-in sample context from ${SAMPLE_SCORE_NAME} (fast mode)`
    );
  }

  async function onUploadOwnScore() {
    if (!scoreFile) {
      setRagIngestErr("pick a score file first (.pdf, .md, .txt).");
      return;
    }
    await ingestScoreFile(scoreFile, "user-upload");
  }

  async function onAnalyze(e: React.FormEvent) {
    e.preventDefault();
    setAnalyzeErr(null);
    setAnalyzeResult(null);

    let payloadText = analyzeText.trim();
    if (!developerMode) {
      if (!singerVoicePart) {
        setAnalyzeErr("Tap your section first (soprano, alto, …).");
        return;
      }
      if (!payloadText) {
        setAnalyzeErr("Type the line you're learning in the box.");
        return;
      }
      payloadText = `Voice part: ${singerVoicePart}. Line I'm learning: ${payloadText}`;
    } else if (!payloadText) {
      setAnalyzeErr("Enter text to analyze.");
      return;
    }

    setAnalyzeLoading(true);
    const res = await postAnalyze(
      payloadText,
      useRag,
      useSampleScore,
      developerMode ? !useAiAnalyze : true
    );
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
        your recording (optional)
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
            ? "no file yet - only needed for split & eq"
            : "no recording selected - optional unless you want split/eq"}
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
                stems via demucs; part + Hz via instant heuristics by default (
                <code>POST /analyze</code> with <code>instant_analyze</code>) or optional
                claude when enabled; gentle band-pass on the vocal stem (
                <code>POST /emphasize</code>). optional RAG = score text in the prompt (slow
                path only). see repo{" "}
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
                    checked={useAiAnalyze}
                    onChange={(e) => setUseAiAnalyze(e.target.checked)}
                  />
                  use Claude for analyze (slower; disables instant tips path)
                </label>
                <label className="check check-tight">
                  <input
                    type="checkbox"
                    checked={useRag}
                    onChange={(e) => setUseRag(e.target.checked)}
                  />
                  use ingested score / notes (RAG)
                </label>
                <div className="score-tools">
                  <p className="score-tools-label">choose your score source (optional)</p>
                  <p className="flow-step-desc score-tools-desc">
                    default sample is <strong>{SAMPLE_SCORE_NAME}</strong> (free to use),
                    or upload your own sheet music. no recording required for this mode.
                  </p>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={ragIngestLoading}
                    onClick={() => void onUseSampleScore()}
                  >
                    {ragIngestLoading
                      ? "loading sample…"
                      : `use default sample: ${SAMPLE_SCORE_NAME}`}
                  </button>
                  <a
                    className="score-tools-link"
                    href={SAMPLE_SCORE_PATH}
                    target="_blank"
                    rel="noreferrer"
                  >
                    preview default sample pdf
                  </a>
                  <details className="sample-preview" open>
                    <summary>preview: {SAMPLE_SCORE_NAME}</summary>
                    <object
                      className="sample-preview-frame"
                      data={SAMPLE_SCORE_PATH}
                      type="application/pdf"
                    >
                      <p className="flow-step-desc">
                        pdf preview unavailable in this browser.{" "}
                        <a href={SAMPLE_SCORE_PATH} target="_blank" rel="noreferrer">
                          open sample score
                        </a>
                        .
                      </p>
                    </object>
                  </details>
                  <label className="label" htmlFor="score-upload-dev">
                    or upload your own score
                  </label>
                  <input
                    id="score-upload-dev"
                    type="file"
                    accept=".pdf,.md,.txt,text/plain,application/pdf"
                    className="file"
                    onChange={(e) => setScoreFile(e.target.files?.[0] ?? null)}
                  />
                  <button
                    type="button"
                    className="btn"
                    disabled={ragIngestLoading || !scoreFile}
                    onClick={() => void onUploadOwnScore()}
                  >
                    ingest uploaded score
                  </button>
                </div>
                {ragIngestMsg && <p className="ok-msg">{ragIngestMsg}</p>}
                {ragIngestErr && <p className="err">{ragIngestErr}</p>}
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
                optional audio path: same upload as <strong>your part</strong> - get
                layers like{" "}
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
                <button
                  type="submit"
                  className="btn primary"
                  disabled={sepLoading || !file}
                >
                  {sepLoading ? "…" : "separate"}
                </button>
                {!file ? (
                  <p className="flow-step-desc">optional: add audio only for split/eq.</p>
                ) : null}
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
              Tips use our bundled PDF (<strong>{SAMPLE_SCORE_NAME}</strong>) automatically.
              Add your own PDF only for another piece; add audio only if you want split and EQ.
            </p>
            <div
              className="built-in-notice"
              role="region"
              aria-labelledby="built-in-notice-heading"
            >
              <p id="built-in-notice-heading" className="built-in-notice-title">
                Can't upload your own PDF? You don't need one.
              </p>
              <p className="built-in-notice-body">
                The complete <strong>{SAMPLE_SCORE_TITLE}</strong> sheet music is{" "}
                <strong>already built into this page</strong>. You can go straight to your section and line —{" "}
                <strong>no upload is required</strong> for tips on this piece. Only use the PDF upload if you're working from{" "}
                <strong>different music</strong>; only use the recording upload if you want <strong>split / EQ</strong> on a rehearsal track.
              </p>
            </div>

            {(() => {
              const hasRecording = Boolean(file);
              const stepTips = hasRecording ? 3 : 2;
              const stepEq = hasRecording ? 4 : 3;
              return (
                <>
                  <div className="flow-step flow-step-first">
                    <h3 className="flow-step-title">
                      <span className="flow-step-num">1</span> upload recording and/or PDF
                    </h3>
                    <p className="flow-step-desc">
                      Optional uploads only. Split and EQ need a recording; swapping scores needs your PDF.
                      Otherwise skip straight to your section — the bundled PDF below is already active for tips.
                    </p>

                    <div className="provided-score-block">
                      <p className="provided-score-head">provided sheet music</p>
                      <p className="flow-step-desc flow-step-desc-tight provided-score-lead">
                        <strong>{SAMPLE_SCORE_NAME}</strong> — this is your default score for tips (nothing to upload).
                      </p>
                      <a
                        className="score-tools-link"
                        href={SAMPLE_SCORE_PATH}
                        target="_blank"
                        rel="noreferrer"
                      >
                        open PDF in a new tab
                      </a>
                      <object
                        className="sample-preview-frame sample-preview-prominent"
                        data={SAMPLE_SCORE_PATH}
                        type="application/pdf"
                      >
                        <p className="flow-step-desc">
                          PDF preview unavailable in this browser.{" "}
                          <a href={SAMPLE_SCORE_PATH} target="_blank" rel="noreferrer">
                            open provided score
                          </a>
                          .
                        </p>
                      </object>
                    </div>

                    <div className="form flow-step-stack">
                      <label className="label" htmlFor="score-upload-singer">
                        different piece? upload your PDF <span className="label-tag">optional</span>
                      </label>
                      <p className="flow-step-desc flow-step-desc-tight built-in-skip-hint">
                        <strong>Staying on {SAMPLE_SCORE_TITLE}?</strong> Skip this — the score above is already loaded for tips.
                      </p>
                      <p className="flow-step-desc flow-step-desc-tight">
                        Only if you're practicing <strong>other sheet music</strong>: load your file here.
                        Text-based PDFs work best; scanned pages sometimes won't extract — try another export if tips miss your lyrics.
                      </p>
                      <input
                        id="score-upload-singer"
                        type="file"
                        accept=".pdf,.md,.txt,text/plain,application/pdf"
                        className="file"
                        onChange={(e) => setScoreFile(e.target.files?.[0] ?? null)}
                      />
                      <button
                        className="btn"
                        type="button"
                        disabled={ragIngestLoading || !scoreFile}
                        onClick={() => void onUploadOwnScore()}
                      >
                        load my PDF for tips
                      </button>
                      {!scoreFile ? (
                        <p className="file-picked muted">
                          nothing uploaded — tips keep using the built-in <strong>{SAMPLE_SCORE_TITLE}</strong> score (that's normal).
                        </p>
                      ) : (
                        <p className="file-picked">
                          picked: <strong>{scoreFile.name}</strong> — tap “load my PDF for tips”.
                        </p>
                      )}
                      {ragIngestMsg && <p className="ok-msg">{ragIngestMsg}</p>}
                      {ragIngestErr && <p className="err">{ragIngestErr}</p>}
                    </div>

                    <div className="form flow-step-stack">
                      <label className="label" htmlFor="audio-singer">
                        rehearsal recording <span className="label-tag">optional</span>
                      </label>
                      <input
                        id="audio-singer"
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
                          no recording — split and EQ stay unavailable below (tips still work).
                        </p>
                      )}
                    </div>
                  </div>

                  {hasRecording ? (
                    <div className="flow-step">
                      <h3 className="flow-step-title">
                        <span className="flow-step-num">2</span> split recording — <span className="step-scope">recording only</span>
                      </h3>
                      <p className="flow-step-desc">
                        Separates singers from piano or backing so you can solo the vocal stem. Only shown because you added a recording in step 1.
                      </p>
                      <form onSubmit={onSeparate} className="form flow-step-form">
                        <button
                          type="submit"
                          className="btn primary"
                          disabled={sepLoading || !file}
                        >
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
                  ) : null}

                  <div className="flow-step">
                    <h3 className="flow-step-title">
                      <span className="flow-step-num">{stepTips}</span> your section and line
                    </h3>
                    <p className="flow-step-desc">
                      Tap your section, then type the line you're learning (paste lyrics from the PDF or score notes).
                      <strong> Built-in score users:</strong> you don't need to upload anything — just pull wording from the provided PDF above.
                      Matching words from your score yields richer tips. Default cues match <strong>{SAMPLE_SCORE_TITLE}</strong>; after you load a different PDF, cues match that file instead.
                    </p>
                    <div className="part-grid" role="group" aria-label="Voice sections">
                      {SINGER_VOICE_SECTIONS.map((label) => (
                        <button
                          key={label}
                          type="button"
                          className={
                            singerVoicePart === label ? "btn part-btn part-btn-selected" : "btn part-btn"
                          }
                          aria-pressed={singerVoicePart === label}
                          onClick={() => setSingerVoicePart(label)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <form onSubmit={onAnalyze} className="form">
                      <label className="label" htmlFor="nl-singer">
                        line you're learning
                      </label>
                      <textarea
                        id="nl-singer"
                        className="textarea textarea-short"
                        rows={3}
                        value={analyzeText}
                        onChange={(e) => setAnalyzeText(e.target.value)}
                        placeholder={`Example from ${SAMPLE_SCORE_TITLE}: “have yourself a merry little christmas”`}
                      />
                      <button
                        type="submit"
                        className="btn primary"
                        disabled={
                          analyzeLoading ||
                          !analyzeText.trim() ||
                          !singerVoicePart
                        }
                      >
                        {analyzeLoading ? "working…" : "get tips for my part"}
                      </button>
                    </form>
                    {analyzeErr && <p className="err">{analyzeErr}</p>}
                    {analyzeResult ? <SingerSummary result={analyzeResult} /> : null}
                  </div>

                  <div className="flow-step flow-step-last">
                    <h3 className="flow-step-title">
                      <span className="flow-step-num">{stepEq}</span> boost my part in the mix{" "}
                      <span className="label-tag">recording only</span>
                    </h3>
                    <p className="flow-step-desc">
                      Gentle EQ on the separated vocal track so your section is easier to hear in headphones —{" "}
                      <strong>only after</strong> you added a recording (step 1), ran split (step 2), and got tips.
                      Skip this entire step if you’re only working from sheet music.
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
                        <span className="hint">
                          {!hasRecording
                            ? "Not available without a recording — add audio in step 1, then split and get tips."
                            : "Split the recording (step 2), then get tips (previous step), then come back here."}
                        </span>
                      )}
                    </div>
                    {emphErr && <p className="err">{emphErr}</p>}
                    {sepResult && canEmphasize && (
                      <p className="flow-hint">
                        After boosting, use <strong>refresh list</strong> in step 2 if you don’t see a new track.
                      </p>
                    )}
                  </div>
                </>
              );
            })()}
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
