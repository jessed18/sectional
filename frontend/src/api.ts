/**
 * Local dev: Vite proxies `/api/*` -> Flask (see `vite.config.ts`).
 * Production: set `VITE_API_ORIGIN` at build time, e.g. `https://sectional-api.onrender.com`
 * (no trailing slash). Requests go to `https://.../health`, not `/api/health`.
 */
const prefix = (import.meta.env.VITE_API_ORIGIN || "").replace(/\/$/, "") || "/api";

export type HealthResponse = { status: string };

export type AnalyzeResponse = {
  part: string;
  confidence: number;
  interpretation: string;
  frequency_range_hz: [number, number];
  coaching: string;
  measure_cues: string;
};

export type EmphasizeResponse = {
  job_id: string;
  part: string;
  stems: string[];
  emphasized: string;
  dsp?: {
    source_hz: number;
    band_hz: [number, number];
    part: string;
  };
  note?: string;
};

export type SeparateResponse = {
  job_id: string;
  status: string;
  stems: string[];
  files: Record<string, string>;
};

export type JobResponse = {
  job_id: string;
  stems: string[];
  files: Record<string, string>;
};

export type ApiError = { error: string; details?: string };

async function parseJson<T>(res: Response): Promise<T | ApiError> {
  const data = (await res.json()) as T | ApiError;
  return data;
}

export async function getHealth(): Promise<HealthResponse | ApiError> {
  const res = await fetch(`${prefix}/health`);
  return parseJson<HealthResponse>(res);
}

export async function postAnalyze(
  text: string,
  useRag: boolean,
  useSampleScore: boolean,
  instantAnalyze = true
): Promise<AnalyzeResponse | ApiError> {
  const res = await fetch(`${prefix}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      use_rag: useRag,
      use_sample_score: useSampleScore,
      instant_analyze: instantAnalyze,
    }),
  });
  return parseJson<AnalyzeResponse>(res);
}

export async function postSeparate(
  file: File
): Promise<SeparateResponse | ApiError> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`${prefix}/separate`, {
    method: "POST",
    body: fd,
  });
  return parseJson<SeparateResponse>(res);
}

export async function getJob(jobId: string): Promise<JobResponse | ApiError> {
  const res = await fetch(`${prefix}/jobs/${jobId}`);
  return parseJson<JobResponse>(res);
}

export async function postEmphasize(
  jobId: string,
  part: string,
  frequencyRangeHz?: [number, number]
): Promise<EmphasizeResponse | ApiError> {
  const body: Record<string, unknown> = { job_id: jobId, part };
  if (frequencyRangeHz) {
    body.frequency_range_hz = frequencyRangeHz;
  }
  const res = await fetch(`${prefix}/emphasize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseJson<EmphasizeResponse>(res);
}

export type RagIngestResponse = { chunks_added: number; source: string };

export async function postRagIngestFile(
  file: File,
  source: string
): Promise<RagIngestResponse | ApiError> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("source", source);
  const res = await fetch(`${prefix}/rag/ingest`, {
    method: "POST",
    body: fd,
  });
  return parseJson<RagIngestResponse>(res);
}

export function stemAudioUrl(jobId: string, stem: string): string {
  return `${prefix}/stems/${jobId}/${stem}`;
}

export function isApiError(x: unknown): x is ApiError {
  return typeof x === "object" && x !== null && "error" in x;
}
