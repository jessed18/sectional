# choir score packets for RAG

drop service/rehearsal PDFs here (or nested subfolders) and ingest from `backend/`:

```bash
python -m scripts.ingest_knowledge ../knowledge/scores --prefix choir_scores
```

notes:
- prefer text-based PDFs exported from notation software.
- scanned/image-only PDFs often produce weak extraction unless OCR is done first.
- this folder is for local project assets; only commit files you have rights to share.
