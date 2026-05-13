import { useCallback, useEffect, useRef, useState } from "react";
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
import {
  ensureAudioUnlocked,
  IKAW_MXL_PATH,
  loadMusicXmlFromMxl,
  parsePartNotes,
  parseScoreTempoBpm,
  parseTuttiNotes,
  pickNotesForLine,
  playNotesWebAudio,
  playTestBeep,
  primeAudioOnUserGesture,
  resolvePartIdForSection,
  resumeAudioIfPossible,
  shiftNotesToZero,
} from "./musicxmlPlay";
import "./App.css";

const STORAGE_DEV = "sectional-developer-mode";
const IKAW_SCORE_TITLE = "Ikaw Ang Aking Mahal";
const IKAW_MXL_NAME = "ikaw-ang-aking-mahal.mxl";

/** Syllable-style phrases from the built-in MusicXML lyrics (same text as tips RAG sample). */
const IKAW_HINT_LINES: readonly string[] = [
  "Ang na is ko sa na'y in yong ma la man",
  "Sa hi la ga o sa ti mog o kan lu ran",
  "At ka hit sa'n pa man",
  "I kaw ang a king ma hal",
  "I kaw lang ang a king ma ha al",
  "Ang pag i big mo'y a king kai lang an",
  "Ma ni wa la ka sa na",
  "Kung si no'ng a king ma hal",
];

const TAGLINE_SINGER =
  "\u266a Built-in MusicXML demo for tips and playback. Pick your part, type a line, tap get tips. Upload only if you want another PDF or a recording for split/EQ.";

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

const LOCAL_PART_BANDS: Record<string, [number, number]> = {
  soprano: [250, 1000],
  alto: [200, 700],
  mezzo: [200, 900],
  tenor: [130, 500],
  baritone: [100, 400],
  bass: [80, 350],
  vocals: [80, 1200],
};

const LOCAL_COACHING: Record<string, string> = {
  soprano:
    "Keep vowels tall and unified across sustained notes; avoid scooping into entrances.",
  alto: "Anchor inner harmony with steady vowel color and clear consonant releases.",
  mezzo:
    "Bridge between soprano and alto color; shape phrase peaks without forcing.",
  tenor:
    "Place tone forward without nasality and lock pickups rhythmically with the section.",
  baritone:
    "Support the low mids with clean diction so inner harmony stays present and clear.",
  bass: "Prioritize rhythmic solidity and tune roots/fifths before adding extra weight.",
  vocals:
    "Track one line per pass and check blend points where parts move together in rhythm.",
};

function buildLocalAnalyzeResult(
  singerVoicePart: string,
  lineText: string,
  score: { uploaded: boolean }
): AnalyzeResponse {
  const part = singerVoicePart === "everyone" ? "vocals" : singerVoicePart;
  const scoreSource = score.uploaded ? "your uploaded PDF" : IKAW_SCORE_TITLE;
  return {
    part,
    confidence: 0.84,
    interpretation: `Instant tips for ${part} while we finish full analysis.`,
    frequency_range_hz: LOCAL_PART_BANDS[part] ?? LOCAL_PART_BANDS.vocals,
    coaching:
      `${LOCAL_COACHING[part] ?? LOCAL_COACHING.vocals} ` +
      `Use exact lyric wording from ${scoreSource} for stronger cue matching.`,
    measure_cues: lineText
      ? `Working line: "${lineText.slice(0, 160)}"${
          lineText.length > 160 ? "…" : ""
        }`
      : "",
  };
}

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
  const [analyzeRefining, setAnalyzeRefining] = useState(false);
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
  const [tempoBpm, setTempoBpm] = useState(85);
  const [isPlayingScore, setIsPlayingScore] = useState(false);
  const [isPlayingTypedLine, setIsPlayingTypedLine] = useState(false);
  const [showSoundHelp, setShowSoundHelp] = useState(false);
  const ikawScoreXmlRef = useRef<string | null>(null);

  useEffect(() => {
    const wake = () => {
      if (!document.hidden) resumeAudioIfPossible();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, []);

  useEffect(() => {
    if (developerMode) return;
    let cancelled = false;
    void (async () => {
      try {
        const xml = await loadMusicXmlFromMxl(IKAW_MXL_PATH);
        if (cancelled) return;
        ikawScoreXmlRef.current = xml;
        const bpm = parseScoreTempoBpm(xml);
        setTempoBpm(Math.round(bpm));
      } catch {
        /* ignore prefetch errors; playback will surface */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [developerMode]);

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
      `${okRes.chunks_added} text chunk${okRes.chunks_added === 1 ? "" : "s"} from ${okRes.source}. Tips now use your PDF (refresh the page to go back to the built-in ${IKAW_SCORE_TITLE} text only).`
    );
    return okRes;
  }

  async function onUseSampleScore() {
    setRagIngestErr(null);
    setUseSampleScore(true);
    setUseRag(false);
    setRagIngestMsg(
      `using built-in ${IKAW_SCORE_TITLE} score text and ${IKAW_MXL_NAME} for playback (fast mode)`
    );
  }

  async function onUploadOwnScore() {
    if (!scoreFile) {
      setRagIngestErr("pick a score file first (.pdf, .md, .txt).");
      return;
    }
    await ingestScoreFile(scoreFile, "user-upload");
  }

  async function onEnableSoundBarClick() {
    primeAudioOnUserGesture();
    const unlocked = await ensureAudioUnlocked();
    if (!unlocked) {
      setAnalyzeErr(
        "Audio still cannot start. Unmute this browser tab, raise system volume, and check headphones or Bluetooth. No website can override device mute or missing speakers."
      );
      return;
    }
    const beepOk = await playTestBeep();
    if (beepOk) {
      setShowSoundHelp(false);
      setAnalyzeErr(null);
    }
  }

  async function ensureIkawXml(): Promise<string> {
    if (ikawScoreXmlRef.current) return ikawScoreXmlRef.current;
    const xml = await loadMusicXmlFromMxl(IKAW_MXL_PATH);
    ikawScoreXmlRef.current = xml;
    return xml;
  }

  async function onPlaySampleMelody() {
    if (isPlayingScore) return;
    if (typeof window === "undefined") return;
    primeAudioOnUserGesture();
    setAnalyzeErr(null);
    setIsPlayingScore(true);
    try {
      const xml = await ensureIkawXml();
      const partId = resolvePartIdForSection(xml, singerVoicePart ?? "soprano");
      let notes =
        partId === "__TUTTI__"
          ? parseTuttiNotes(xml).slice(0, 56)
          : parsePartNotes(xml, partId).slice(0, 52);
      notes = shiftNotesToZero(notes);
      if (!notes.length) {
        setAnalyzeErr("No notes found in the MusicXML preview.");
        setIsPlayingScore(false);
        return;
      }
      const played = await playNotesWebAudio(notes, tempoBpm, () => setIsPlayingScore(false));
      if (!played) {
        setShowSoundHelp(true);
        setAnalyzeErr(
          "Preview audio did not start. Tap “Enable sound” at the bottom (or “No sound?” above), unmute this tab, then try again."
        );
      }
    } catch (e) {
      setAnalyzeErr(
        e instanceof Error ? e.message : "Could not load the MusicXML file."
      );
      setIsPlayingScore(false);
    }
  }

  async function onPlayTypedLine() {
    if (isPlayingTypedLine) return;
    if (!singerVoicePart) {
      setAnalyzeErr("Choose a section first, then play the line.");
      return;
    }
    if (!analyzeText.trim()) {
      setAnalyzeErr("Type a line first so we can match lyrics in the score.");
      return;
    }
    if (typeof window === "undefined") return;
    primeAudioOnUserGesture();
    setAnalyzeErr(null);
    setIsPlayingTypedLine(true);
    try {
      const xml = await ensureIkawXml();
      const partId = resolvePartIdForSection(xml, singerVoicePart);
      const all =
        partId === "__TUTTI__" ? parseTuttiNotes(xml) : parsePartNotes(xml, partId);
      let picked = pickNotesForLine(all, analyzeText);
      picked = shiftNotesToZero(picked);
      if (!picked.length) {
        setAnalyzeErr("No notes in that part — try another section.");
        setIsPlayingTypedLine(false);
        return;
      }
      const played = await playNotesWebAudio(picked, tempoBpm, () => setIsPlayingTypedLine(false));
      if (!played) {
        setShowSoundHelp(true);
        setAnalyzeErr(
          "Preview audio did not start. Tap “Enable sound” at the bottom (or “No sound?” in step 1), unmute this tab, then try again."
        );
      }
    } catch (e) {
      setAnalyzeErr(
        e instanceof Error ? e.message : "Could not play from MusicXML."
      );
      setIsPlayingTypedLine(false);
    }
  }

  async function onAnalyze(e: React.FormEvent) {
    e.preventDefault();
    setAnalyzeErr(null);
    setAnalyzeRefining(false);

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
      const localResult = buildLocalAnalyzeResult(singerVoicePart, analyzeText.trim(), {
        uploaded: useRag,
      });
      setAnalyzeResult(localResult);
      setAnalyzeLoading(false);
      setAnalyzeRefining(true);
      void (async () => {
        const useBundledSampleBackend = useSampleScore && !useRag;
        const res = await postAnalyze(payloadText, useRag, useBundledSampleBackend, true);
        if (isApiError(res)) {
          setAnalyzeErr("Showing instant tips while the server wakes up.");
          setAnalyzeRefining(false);
          return;
        }
        setAnalyzeErr(null);
        setAnalyzeResult(res);
        setAnalyzeRefining(false);
      })();
      return;
    } else if (!payloadText) {
      setAnalyzeErr("Enter text to analyze.");
      return;
    }

    setAnalyzeResult(null);
    setAnalyzeLoading(true);
    const res = await postAnalyze(
      payloadText,
      useRag,
      useSampleScore,
      developerMode ? !useAiAnalyze : true
    );
    setAnalyzeLoading(false);
    setAnalyzeRefining(false);
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
                    default is <strong>{IKAW_SCORE_TITLE}</strong> (bundled lyrics for API / RAG overlap +{" "}
                    <code>{IKAW_MXL_NAME}</code> for the UI player), or upload your own sheet music. No recording required
                    for this mode.
                  </p>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={ragIngestLoading}
                    onClick={() => void onUseSampleScore()}
                  >
                    {ragIngestLoading ? "loading…" : `use built-in demo: ${IKAW_SCORE_TITLE}`}
                  </button>
                  <p className="flow-step-desc score-tools-desc">
                    Open the singer-facing app (non–developer mode) to try “hear opening” / “hear my line” from the MXL.
                  </p>
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
              This page includes <strong>{IKAW_SCORE_TITLE}</strong> as the built-in demo: bundled MusicXML for playback and
              lyric text for tips.
            </p>
            <ol className="singer-quick" aria-label="Quick steps">
              <li>
                <strong>Pick your part</strong> and <strong>type a line</strong> from the song.
              </li>
              <li>
                <strong>Get tips</strong> — answers show up fast, then may sharpen when the server catches up.
              </li>
              <li>
                <strong>Optional:</strong> hear notes from the MXL or add a recording for split/EQ.
              </li>
            </ol>
            <details className="singer-details">
              <summary>optional — uploads &amp; how playback works</summary>
              <div className="singer-details-body">
                <p>
                  <strong>PDF upload</strong> only if you are practicing something else. Scanned PDFs often work poorly — typed
                  lyrics still help tips.
                </p>
                <p>
                  <strong>Hear opening</strong> plays the first soprano (P1) notes from the built-in MusicXML (MuseScore-style SATB export).
                </p>
                <p>
                  <strong>Hear my line</strong> matches your typed words to lyrics on your selected part (simple overlap).
                </p>
              </div>
            </details>

            {(() => {
              const hasRecording = Boolean(file);
              const stepTips = hasRecording ? 3 : 2;
              const stepEq = hasRecording ? 4 : 3;
              return (
                <>
                  <div className="flow-step flow-step-first">
                    <h3 className="flow-step-title">
                      <span className="flow-step-num">1</span> optional: PDF or recording
                    </h3>
                    <p className="flow-step-desc">
                      Skip this block unless you need it. Tips use the built-in {IKAW_SCORE_TITLE} text unless you load your own PDF.
                    </p>

                    <div className="provided-score-block">
                      <p className="provided-score-head">built-in score</p>
                      <p className="flow-step-desc flow-step-desc-tight provided-score-lead">
                        {useRag ? (
                          <>
                            Tips use <strong>your uploaded PDF</strong> until you refresh. Hear buttons still use the bundled{" "}
                            <code>{IKAW_MXL_NAME}</code>.
                          </>
                        ) : (
                          <>
                            <strong>{IKAW_SCORE_TITLE}</strong> — lyric text for the API and{" "}
                            <code>public/samples/{IKAW_MXL_NAME}</code> for on-page playback (no upload needed).
                          </>
                        )}
                      </p>
                      <div className="score-audio-row">
                        <button
                          type="button"
                          className="btn"
                          onPointerDown={() => primeAudioOnUserGesture()}
                          onClick={() => void onPlaySampleMelody()}
                          disabled={isPlayingScore}
                        >
                          {isPlayingScore ? "playing…" : "hear opening from score"}
                        </button>
                        <label className="score-audio-tempo" htmlFor="score-tempo">
                          speed
                          <input
                            id="score-tempo"
                            type="range"
                            min={56}
                            max={108}
                            step={2}
                            value={tempoBpm}
                            onChange={(e) => setTempoBpm(Number(e.target.value))}
                            disabled={isPlayingScore}
                          />
                          <span>{tempoBpm} bpm</span>
                        </label>
                      </div>
                      <p className="sound-trouble-row">
                        <button
                          type="button"
                          className="btn-linkish"
                          onClick={() => setShowSoundHelp(true)}
                        >
                          No sound?
                        </button>
                      </p>
                      <p className="flow-step-desc flow-step-desc-tight muted-tight">
                        Opening follows the <strong>part you selected</strong> (matched from the score’s part names) or all parts together for “everyone”. “Hear my line” uses the same part plus your typed lyrics.
                      </p>
                      <p className="flow-step-desc flow-step-desc-tight ikaw-score-note">
                        There is no PDF for this built-in piece — open the MXL in your notation app if you need a printed score.
                      </p>
                    </div>

                    <div className="form flow-step-stack">
                      <label className="label" htmlFor="score-upload-singer">
                        different piece? PDF <span className="label-tag">optional</span>
                      </label>
                      <p className="flow-step-desc flow-step-desc-tight">
                        Skip if you are staying on the built-in song. Other pieces only.
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
                        load PDF for tips
                      </button>
                      {!scoreFile ? (
                        <p className="file-picked muted">
                          nothing uploaded — tips use the built-in <strong>{IKAW_SCORE_TITLE}</strong> demo (that&apos;s normal).
                        </p>
                      ) : (
                        <p className="file-picked">
                          picked: <strong>{scoreFile.name}</strong> — tap “load PDF for tips”.
                        </p>
                      )}
                      {ragIngestMsg && <p className="ok-msg">{ragIngestMsg}</p>}
                      {ragIngestErr && <p className="err">{ragIngestErr}</p>}
                    </div>

                    <div className="form flow-step-stack">
                      <label className="label" htmlFor="audio-singer">
                        rehearsal recording <span className="label-tag">optional</span>
                      </label>
                      <p className="flow-step-desc flow-step-desc-tight muted-tight">
                        Needed only for split + EQ below.
                      </p>
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
                        Pulls vocals away from piano or backing. Only shows when you added a recording.
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
                      <span className="flow-step-num">{stepTips}</span> part + line → tips
                    </h3>
                    <p className="flow-step-desc">
                      {useRag
                        ? "Use wording from your uploaded PDF when you can — tips match better."
                        : "Type lyrics the way they appear on your part — “hear my line” matches syllables in the MXL."}{" "}
                      Hear buttons are short previews only.
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
                      <p className="flow-step-desc flow-step-desc-tight ikaw-hint-intro">
                        Stuck? These lines are copied from the built-in score’s lyrics (same syllables as in the MXL).
                      </p>
                      <div className="ikaw-hint-lines" role="group" aria-label="Example lines from the score">
                        {IKAW_HINT_LINES.map((line) => (
                          <button
                            key={line}
                            type="button"
                            className="btn ghost sm ikaw-hint-chip"
                            title={line}
                            onClick={() => setAnalyzeText(line)}
                          >
                            {line}
                          </button>
                        ))}
                      </div>
                      <textarea
                        id="nl-singer"
                        className="textarea textarea-short"
                        rows={3}
                        value={analyzeText}
                        onChange={(e) => setAnalyzeText(e.target.value)}
                        placeholder={`Type words from your line in ${IKAW_SCORE_TITLE} (Tagalog / syllables as on your part).`}
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
                        {analyzeLoading
                          ? "working…"
                          : analyzeRefining
                            ? "updating…"
                            : "get tips for my part"}
                      </button>
                      <div className="score-audio-row score-audio-row-inline">
                        <button
                          type="button"
                          className="btn ghost"
                          onPointerDown={() => primeAudioOnUserGesture()}
                          onClick={() => void onPlayTypedLine()}
                          disabled={
                            isPlayingTypedLine ||
                            !analyzeText.trim() ||
                            !singerVoicePart
                          }
                        >
                          {isPlayingTypedLine ? "playing…" : "hear my line"}
                        </button>
                        <span className="flow-step-desc flow-step-desc-tight muted-tight">
                          Plays notes from your part’s MXL where lyrics overlap your typing (simple match).
                        </span>
                      </div>
                    </form>
                    {analyzeRefining ? (
                      <p className="flow-hint">Updating tips…</p>
                    ) : null}
                    {analyzeErr && <p className="err">{analyzeErr}</p>}
                    {analyzeResult ? <SingerSummary result={analyzeResult} /> : null}
                  </div>

                  <div className="flow-step flow-step-last">
                    <h3 className="flow-step-title">
                      <span className="flow-step-num">{stepEq}</span> boost my part in the mix{" "}
                      <span className="label-tag">recording only</span>
                    </h3>
                    <p className="flow-step-desc">
                      Only after recording + split + tips. Sheet-music-only? Skip.
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
      {!developerMode && showSoundHelp ? (
        <div className="sound-help-bar" role="dialog" aria-labelledby="sound-help-title">
          <div className="sound-help-inner">
            <p className="sound-help-text" id="sound-help-title">
              <strong>No website can unmute your device or speakers for you.</strong> If note previews are silent: tap{" "}
              <strong>Enable sound</strong>, unmute this browser tab, raise system volume, and check headphones or Bluetooth.
            </p>
            <div className="sound-help-actions">
              <button type="button" className="btn primary" onClick={() => void onEnableSoundBarClick()}>
                Enable sound
              </button>
              <button type="button" className="btn ghost" onClick={() => setShowSoundHelp(false)}>
                Dismiss
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
