/**
 * MusicXML 3/4 partwise + MXL (zip) loader for browser playback.
 * Part ids and names come from <part-list>; timing follows backup/forward/chord rules.
 */

import JSZip from "jszip";

export type ScoreNote = {
  /** Quarter-note offset from start of piece */
  startQuarters: number;
  /** Quarter-note length */
  quarters: number;
  midi: number;
  lyric: string;
};

export type ScorePartInfo = {
  id: string;
  name: string;
  /** lowercased, punctuation stripped — for matching UI sections */
  nameNorm: string;
};

const STEP_SEMI: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

function pitchToMidi(step: string, alter: number | undefined, octave: number): number {
  const base = STEP_SEMI[step] ?? 0;
  const alt = alter ?? 0;
  return (octave + 1) * 12 + base + alt;
}

function textContent(el: Element | null): string {
  return (el?.textContent ?? "").trim();
}

function parseIntSafe(s: string | null | undefined, fallback: number): number {
  if (s == null || s === "") return fallback;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : fallback;
}

function hasTieStart(el: Element): boolean {
  return Boolean(
    el.querySelector('tie[type="start"]') ||
      el.querySelector('notations > tied[type="start"]')
  );
}

function hasTieStop(el: Element): boolean {
  return Boolean(
    el.querySelector('tie[type="stop"]') ||
      el.querySelector('notations > tied[type="stop"]')
  );
}

function normPartLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Unzip MXL and return inner MusicXML string (first .xml in container or score.xml). */
export async function loadMusicXmlFromMxl(url: string): Promise<string> {
  const buf = await fetch(url).then((r) => r.arrayBuffer());
  const zip = await JSZip.loadAsync(buf);
  const container = zip.file("META-INF/container.xml");
  if (!container) {
    const score = zip.file("score.xml");
    if (!score) throw new Error("MXL missing score.xml");
    return score.async("string");
  }
  const cxml = await container.async("string");
  const doc = new DOMParser().parseFromString(cxml, "application/xml");
  const root = doc.querySelector("rootfile");
  const full = root?.getAttribute("full-path");
  if (full) {
    const f = zip.file(full);
    if (f) return f.async("string");
  }
  const score = zip.file("score.xml");
  if (!score) throw new Error("Could not resolve MusicXML inside MXL");
  return score.async("string");
}

export function parseScoreTempoBpm(xml: string): number {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return getFirstTempoBpm(doc);
}

function getFirstTempoBpm(doc: Document): number {
  const sound = doc.querySelector("sound[tempo]");
  if (sound) {
    const t = sound.getAttribute("tempo");
    if (t) {
      const n = parseFloat(t);
      if (Number.isFinite(n) && n > 20 && n < 300) return n;
    }
  }
  const perMin = doc.querySelector("metronome per-minute");
  if (perMin) {
    const n = parseFloat(textContent(perMin));
    if (Number.isFinite(n) && n > 20 && n < 300) return n;
  }
  return 85;
}

/** Read <score-part> ids and display names from the score. */
export function parseScorePartList(xml: string): ScorePartInfo[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const out: ScorePartInfo[] = [];
  for (const sp of doc.querySelectorAll("part-list > score-part")) {
    const id = sp.getAttribute("id");
    const nameEl = sp.querySelector("part-name");
    const name = nameEl ? textContent(nameEl) : "";
    if (!id || !name) continue;
    out.push({ id, name, nameNorm: normPartLabel(name) });
  }
  return out;
}

function partNameMatches(nameNorm: string, keywords: string[]): boolean {
  for (const kw of keywords) {
    const k = normPartLabel(kw);
    if (!k) continue;
    if (nameNorm === k) return true;
    if (nameNorm.includes(k) || k.includes(nameNorm)) return true;
  }
  return false;
}

function pickPartId(parts: ScorePartInfo[], keywords: string[], exclude?: (name: string) => boolean): string | null {
  for (const p of parts) {
    if (exclude && exclude(p.nameNorm)) continue;
    if (partNameMatches(p.nameNorm, keywords)) return p.id;
  }
  return null;
}

/**
 * Pick <part id> from the score’s part-list for a UI section.
 * Returns "__TUTTI__" when the section should combine all listed parts.
 */
export function resolvePartIdForSection(xml: string, section: string): string {
  const parts = parseScorePartList(xml);
  if (!parts.length) return "P1";

  const sec = normPartLabel(section);

  if (
    sec === "everyone" ||
    sec === "vocals" ||
    sec.includes("full choir") ||
    sec.includes("whole choir") ||
    sec.includes("all voices")
  ) {
    return "__TUTTI__";
  }

  if (sec.includes("mezzo")) {
    return (
      pickPartId(parts, ["mezzo", "mezzo soprano", "second soprano"]) ??
      pickPartId(parts, ["alto"]) ??
      parts[0].id
    );
  }
  if (sec.includes("baritone")) {
    return pickPartId(parts, ["baritone", "bari"]) ?? pickPartId(parts, ["tenor"]) ?? parts[0].id;
  }
  if (sec.includes("bass")) {
    return pickPartId(parts, ["bass"]) ?? parts[parts.length - 1]?.id ?? parts[0].id;
  }
  if (sec.includes("tenor") && !sec.includes("counter")) {
    const id = pickPartId(parts, ["tenor", "ten"], (n) => n.includes("counter"));
    if (id) return id;
    for (const p of parts) {
      if (p.nameNorm === "tenor") return p.id;
    }
    return parts[0].id;
  }
  if (sec.includes("alto")) {
    return pickPartId(parts, ["alto", "alt"]) ?? parts[0].id;
  }
  if (sec.includes("soprano") && !sec.includes("alto")) {
    const id = pickPartId(parts, ["soprano", "sop"], (n) => n.includes("mezzo"));
    if (id) return id;
    for (const p of parts) {
      if (p.nameNorm === "soprano") return p.id;
    }
    return parts[0].id;
  }

  return parts[0].id;
}

/**
 * Walk one <part id="…">: all voices, backup/forward, chord groups, grace notes skipped.
 * Yields notes with absolute start time in quarter notes from piece start.
 */
export function parsePartNotes(xml: string, partId: string): ScoreNote[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const part = doc.querySelector(`part[id="${partId}"]`);
  if (!part) throw new Error(`No part ${partId} in score`);

  let divisions = 4;
  let beats = 4;
  let beatType = 4;
  let globalStartQuarters = 0;
  const out: ScoreNote[] = [];

  const measures = part.querySelectorAll("measure");
  measures.forEach((measure) => {
    let t = 0;
    let chordAnchorDiv = 0;

    for (const el of Array.from(measure.children)) {
      const tag = el.tagName;
      if (tag === "attributes") {
        const divEl = el.querySelector("divisions");
        if (divEl) divisions = parseIntSafe(textContent(divEl), divisions);
        const timeEl = el.querySelector("time");
        if (timeEl) {
          const b = timeEl.querySelector("beats");
          const bt = timeEl.querySelector("beat-type");
          if (b) beats = parseIntSafe(textContent(b), beats);
          if (bt) beatType = parseIntSafe(textContent(bt), beatType);
        }
      } else if (tag === "backup") {
        const d = el.querySelector("duration");
        t -= parseIntSafe(textContent(d), 0);
      } else if (tag === "forward") {
        const d = el.querySelector("duration");
        t += parseIntSafe(textContent(d), 0);
      } else if (tag === "note") {
        if (el.querySelector("grace")) continue;

        const isChord = el.querySelector("chord");
        const durEl = el.querySelector("duration");
        const dur = parseIntSafe(textContent(durEl), 0);

        if (el.querySelector("rest")) {
          if (!isChord) t += dur;
          continue;
        }

        const pitch = el.querySelector("pitch");
        if (!pitch) {
          if (!isChord) t += dur;
          continue;
        }

        const step = textContent(pitch.querySelector("step")) || "C";
        const alterEl = pitch.querySelector("alter");
        const alter = alterEl ? parseIntSafe(textContent(alterEl), 0) : 0;
        const oct = parseIntSafe(textContent(pitch.querySelector("octave")), 4);
        const midi = pitchToMidi(step, alter, oct);

        const lyrics = Array.from(el.querySelectorAll("lyric text"))
          .map((tx) => textContent(tx))
          .filter(Boolean)
          .join("");

        let startDiv: number;
        if (isChord) {
          startDiv = chordAnchorDiv;
        } else {
          startDiv = t;
          chordAnchorDiv = t;
          t += dur;
        }

        const startQuarters = globalStartQuarters + startDiv / divisions;
        const quarters = dur / divisions;

        const stopOnly = hasTieStop(el) && !hasTieStart(el);
        if (stopOnly && out.length > 0) {
          const prev = out[out.length - 1];
          const gap = Math.abs(prev.startQuarters + prev.quarters - startQuarters);
          if (prev.midi === midi && gap < 1e-5) {
            prev.quarters += quarters;
            continue;
          }
        }

        out.push({
          startQuarters,
          quarters,
          midi,
          lyric: lyrics,
        });
      }
    }

    const measureQuarters = (beats * 4) / beatType;
    globalStartQuarters += measureQuarters;
  });

  out.sort((a, b) => a.startQuarters - b.startQuarters || a.midi - b.midi);
  return out;
}

/** Combine all parts in the part-list (SATB-style demo). Overlapping starts produce multiple notes. */
export function parseTuttiNotes(xml: string): ScoreNote[] {
  const parts = parseScorePartList(xml);
  const merged: ScoreNote[] = [];
  for (const { id } of parts) {
    try {
      merged.push(...parsePartNotes(xml, id));
    } catch {
      /* skip missing part elements */
    }
  }
  merged.sort((a, b) => a.startQuarters - b.startQuarters || a.midi - b.midi);
  return merged;
}

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-zà-ž']+/gu) ?? []).filter(Boolean);
}

/** Pick notes whose lyrics best overlap typed line; respects startQuarters order. */
export function pickNotesForLine(notes: ScoreNote[], line: string): ScoreNote[] {
  const sorted = [...notes].sort((a, b) => a.startQuarters - b.startQuarters || b.midi - a.midi);
  const want = new Set(tokenize(line));
  if (!want.size) return [];

  let best: ScoreNote[] = [];
  let bestScore = 0;

  for (let i = 0; i < sorted.length; i++) {
    let joined = "";
    const chunk: ScoreNote[] = [];
    for (let j = i; j < Math.min(sorted.length, i + 96); j++) {
      const n = sorted[j];
      if (n.lyric) joined += (joined ? " " : "") + n.lyric;
      chunk.push(n);
      const got = new Set(tokenize(joined));
      let score = 0;
      for (const t of got) if (want.has(t)) score++;
      if (score > bestScore || (score === bestScore && score > 0 && chunk.length > best.length)) {
        bestScore = score;
        best = chunk.slice();
      }
      if (score === 0 && joined.length > 72) break;
    }
  }

  if (bestScore > 0) return best;

  const first = sorted.slice(0, Math.min(32, sorted.length));
  return first;
}

/** Move the earliest note in the list to time 0 (for short previews). */
export function shiftNotesToZero(notes: ScoreNote[]): ScoreNote[] {
  if (!notes.length) return [];
  const t0 = Math.min(...notes.map((n) => n.startQuarters));
  if (t0 === 0) return notes;
  return notes.map((n) => ({ ...n, startQuarters: n.startQuarters - t0 }));
}

/** Created on first user gesture; reused across plays (never closed). */
let sharedAudioContext: AudioContext | null = null;

function getOrCreateAudioContext(): AudioContext | null {
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedAudioContext) sharedAudioContext = new Ctx();
  return sharedAudioContext;
}

/**
 * Call from pointerdown on hear buttons so AudioContext exists before any await
 * (fetching MXL yields the event loop and browsers drop the user-gesture chain).
 */
export function primeAudioOnUserGesture(): void {
  const ctx = getOrCreateAudioContext();
  if (!ctx) return;
  void ctx.resume();
}

/** Exposed for UI (e.g. “sound blocked” hints). */
export function getSharedAudioContextState(): AudioContextState | "unsupported" {
  const ctx = sharedAudioContext;
  if (!ctx) return "unsupported";
  return ctx.state;
}

export async function ensureAudioUnlocked(): Promise<boolean> {
  const ctx = getOrCreateAudioContext();
  if (!ctx) return false;
  for (let i = 0; i < 5; i++) {
    if ((ctx.state as string) === "running") return true;
    try {
      await ctx.resume();
    } catch {
      /* continue */
    }
    if ((ctx.state as string) === "running") return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return (ctx.state as string) === "running";
}

/** After tab switch / iOS background, try to move context back to running. */
export function resumeAudioIfPossible(): void {
  const ctx = sharedAudioContext;
  if (!ctx) return;
  const st = ctx.state as string;
  if (st === "suspended" || st === "interrupted") void ctx.resume();
}

/** Short beep so the user can confirm output path (call from a click handler). */
export async function playTestBeep(): Promise<boolean> {
  if (!(await ensureAudioUnlocked())) return false;
  const ctx = getOrCreateAudioContext();
  if (!ctx || ctx.state !== "running") return false;
  const t0 = ctx.currentTime + 0.04;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.28, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
  osc.type = "sine";
  osc.frequency.setValueAtTime(880, t0);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + 0.2);
  return true;
}

export async function playNotesWebAudio(
  notes: ScoreNote[],
  bpm: number,
  onDone: () => void
): Promise<boolean> {
  if (!notes.length) {
    onDone();
    return true;
  }
  const ctx = getOrCreateAudioContext();
  if (!ctx) {
    onDone();
    return false;
  }
  if (!(await ensureAudioUnlocked())) {
    onDone();
    return false;
  }
  if (ctx.state !== "running") {
    onDone();
    return false;
  }

  const beatSec = 60 / Math.max(20, Math.min(300, bpm));
  const base = ctx.currentTime + 0.08;
  const master = ctx.createGain();
  master.gain.value = 0.14;
  master.connect(ctx.destination);

  let latestEnd = base;
  for (const n of notes) {
    const t0 = base + n.startQuarters * beatSec;
    const sec = Math.max(0.06, n.quarters * beatSec);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(0.05, sec - 0.03));
    osc.type = "triangle";
    osc.frequency.setValueAtTime(440 * Math.pow(2, (n.midi - 69) / 12), t0);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + sec);
    latestEnd = Math.max(latestEnd, t0 + sec);
  }

  const ms = Math.max(200, (latestEnd - ctx.currentTime) * 1000 + 120);
  window.setTimeout(() => {
    try {
      master.disconnect();
    } catch {
      /* ignore */
    }
    onDone();
  }, ms);
  return true;
}

export const IKAW_MXL_PATH = "/samples/ikaw-ang-aking-mahal.mxl";

/** @deprecated use resolvePartIdForSection(xml, section) for XML-accurate mapping */
export function sectionToPartId(section: string): string {
  const s = section.toLowerCase();
  if (s === "alto") return "P2";
  if (s === "tenor") return "P3";
  if (s === "bass") return "P4";
  if (s === "mezzo") return "P2";
  if (s === "everyone") return "P1";
  if (s === "baritone") return "P3";
  return "P1";
}
