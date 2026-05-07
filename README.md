# sectional

full-stack choral audio tool: **react + typescript** frontend, **flask** backend.

**pipeline:** (1) **demucs** → isolated **vocals** vs accompaniment. (2) **claude** `/analyze` → part + **frequency_range_hz** + optional coaching / measure hints; optional **RAG** when `rag_service` is installed. (3) **band emphasis** `POST /emphasize` → processes the **vocals** stem with **scipy** bandpass + blend (heuristic, not perfect isolation).

the **web ui** defaults to a single-column **singer flow** (upload → split → part tips → boost). turn on **developer mode** in the header for the split-panel layout, raw analyze json, RAG toggle, endpoint hints, and local dev footer. engineering detail below is for reviewers and operators.

## architecture (for engineers)

| layer | role |
| --- | --- |
| **vite + react** | spa on `:5173`; `/api/*` **proxied** to flask (path rewritten without `/api`) |
| **flask** | rest api on `:5000` (Linux/Windows); on **macOS** defaults to `:5001` and remaps `PORT=5000` to avoid AirPlay (set `SECTIONAL_ALLOW_PORT_5000=1` to force `5000`); **cors** enabled for local dev |
| **demucs** | `POST /separate` runs `python -m demucs` → per-stem wavs under `outputs/<job_id>/` |
| **anthropic** | `POST /analyze` → structured json (`part`, `frequency_range_hz`, coaching text); model from `ANTHROPIC_MODEL` |
| **optional RAG** | chromadb (persistent) + sentence-transformers via `rag_service`; `use_rag: true` injects retrieved score text into the system prompt |
| **dsp** | `POST /emphasize` → **butterworth** band-pass + wet/dry blend in `audio_emphasis.py`; writes `{part}_emphasized.wav` beside `vocals.wav` |

**main routes:** `GET /health` · `POST /separate` · `POST /analyze` · `POST /emphasize` · `GET /stems/<job_id>/<stem>` · `GET /jobs/<job_id>` · `POST /rag/*` (when `rag_service` present).

**deploy split:** full backend (demucs + gpu-friendly) vs **lambda container** (`Dockerfile.lambda`, `requirements-lambda.txt`) for analyze + RAG only; `DISABLE_DEMUCS=1` returns **503** on `/separate`. **sam** template in `template.yaml`.

## prerequisites

- python 3.9+ (backend venv recommended)
- node 18+ (frontend)

## backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate   # windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env       # add ANTHROPIC_API_KEY (PORT=5001 avoids macOS AirPlay on 5000)
python -u app.py           # -u: line-buffered logs; works from repo root or backend/
```

api listens on **http://127.0.0.1:5000** (Linux/Windows) or **:5001** on macOS unless you set `SECTIONAL_ALLOW_PORT_5000=1` with a free **5000**.

## frontend

```bash
cd frontend
npm install
npm run dev:all   # api + ui together (needs backend/.venv); use npm run dev if api is already running
# or: npm run dev   # ui only — run python -u app.py in backend in another terminal
```

ui listens on **http://127.0.0.1:5173** (or **:5174** if 5173 is busy) and proxies **`/api/*`** to the flask server (strip `/api` prefix). npm scripts must be invoked as **`npm run <script>`**, not `npm <script>`.

production bundle:

```bash
cd frontend && npm run build
```

serve `frontend/dist` with any static host; point api calls at your deployed backend (set `vite` `base` / env as needed for your host).

## optional RAG

ingest markdown or pdf via `POST /rag/ingest`, then use **`use_rag: true`** on `POST /analyze`. chroma data lives in `backend/data/chroma` (gitignored).

keep choir docs under `knowledge/` (recommended: `knowledge/scores/` for service PDFs and rehearsal packets, `knowledge/user_piece_test/` for quick local experiments).

**cli ingest** (from `backend/` after installing deps):

```bash
python -m scripts.ingest_knowledge ../knowledge
# or target score packets only
python -m scripts.ingest_knowledge ../knowledge/scores --prefix choir_scores
```

**pdf note:** text-based exports from notation tools ingest well; scanned/image-only pdfs usually need OCR first.

## aws lambda (analyze + RAG only)

the **lambda** image omits demucs (`requirements-lambda.txt` + `Dockerfile.lambda`). `DISABLE_DEMUCS=1` makes `POST /separate` return **503**.

**build image locally**

```bash
cd backend
docker build -f Dockerfile.lambda -t sectional-lambda .
docker run -p 8080:8080 -e ANTHROPIC_API_KEY=your-key sectional-lambda
# curl http://127.0.0.1:8080/health
```

**deploy with sam** (needs docker + aws cli + sam cli): copy `samconfig.toml.example`, run `sam build` then `sam deploy --guided` and paste your **anthropic** key when prompted. first deploy creates an **ecr** repo for the image.

**lambda caveat:** `CHROMA_PERSIST_DIR` defaults to `/tmp/chroma` in the container - the index is **empty on cold start** unless you bake data into the image, attach **efs**, or sync from **s3** on startup (implement that yourself for production).

## project layout

- `backend/app.py` - flask api
- `backend/rag_service.py` - vector store + embeddings (loaded on first RAG use)
- `backend/Dockerfile.lambda` - lambda container (no demucs)
- `backend/scripts/ingest_knowledge.py` - batch ingest for RAG
- `template.yaml` - sam template
- `frontend/` - vite + react + typescript
