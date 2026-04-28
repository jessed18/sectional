# sectional

full-stack choral audio tool: **react + typescript** frontend, **flask** backend with **claude** for voice-part intent, **demucs** for stems, optional **rag** over rehearsal / sheet-music text.

## prerequisites

- python 3.9+ (backend venv recommended)
- node 18+ (frontend)

## backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate   # windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env       # add ANTHROPIC_API_KEY
python app.py
```

api listens on **http://127.0.0.1:5000**.

## frontend

```bash
cd frontend
npm install
npm run dev
```

ui listens on **http://127.0.0.1:5173** and proxies **`/api/*`** to the flask server (strip `/api` prefix). run **both** processes for local development.

production bundle:

```bash
cd frontend && npm run build
```

serve `frontend/dist` with any static host; point api calls at your deployed backend (set `vite` `base` / env as needed for your host).

## optional rag

ingest markdown or pdf via `POST /rag/ingest`, then use **`use_rag: true`** on `POST /analyze`. chroma data lives in `backend/data/chroma` (gitignored).

## project layout

- `backend/app.py` — flask api
- `backend/rag_service.py` — vector store + embeddings (loaded on first rag use)
- `frontend/` — vite + react + typescript
