"""
ChromaDB + sentence-transformers RAG for sectional.

Used by app.py (/rag/*, analyze with use_rag) and scripts.ingest_knowledge.
Persist dir: CHROMA_PERSIST_DIR or backend/data/chroma.
"""

from __future__ import annotations

import io
import os
import re
import threading
import uuid
from pathlib import Path
from typing import Any, cast

import chromadb
from chromadb.api import ClientAPI
from chromadb.api.models.Collection import Collection
from chromadb.api.types import Metadata
from chromadb.utils import embedding_functions

COLLECTION_NAME = "sectional_knowledge"
_DEFAULT_EMBED_MODEL = "all-MiniLM-L6-v2"
_DEFAULT_CHUNK = 1200
_DEFAULT_OVERLAP = 180

_lock = threading.RLock()
_client: ClientAPI | None = None
_collection: Collection | None = None


def _persist_dir() -> str:
    explicit = os.environ.get("CHROMA_PERSIST_DIR")
    if explicit:
        return explicit
    base = Path(__file__).resolve().parent / "data" / "chroma"
    base.mkdir(parents=True, exist_ok=True)
    return str(base)


def _embed_model_name() -> str:
    return os.environ.get("SECTIONAL_EMBED_MODEL", _DEFAULT_EMBED_MODEL)


def _make_embedding_fn():
    return embedding_functions.SentenceTransformerEmbeddingFunction(
        model_name=_embed_model_name()
    )


def _get_client() -> ClientAPI:
    global _client
    with _lock:
        if _client is None:
            _client = chromadb.PersistentClient(path=_persist_dir())
        return _client


def _get_collection() -> Collection:
    global _collection
    with _lock:
        if _collection is None:
            client = _get_client()
            _collection = client.get_or_create_collection(
                name=COLLECTION_NAME,
                embedding_function=cast(Any, _make_embedding_fn()),
                metadata={"hnsw:space": "cosine"},
            )
        return _collection


def _chunk_text(
    text: str,
    max_chars: int = _DEFAULT_CHUNK,
    overlap: int = _DEFAULT_OVERLAP,
) -> list[str]:
    text = (text or "").strip()
    if not text:
        return []

    parts: list[str] = []
    for block in re.split(r"\n\s*\n+", text):
        b = block.strip()
        if b:
            parts.append(b)

    if not parts:
        return []

    chunks: list[str] = []
    buf = ""
    for p in parts:
        if len(buf) + len(p) + 2 <= max_chars:
            buf = f"{buf}\n\n{p}".strip() if buf else p
            continue
        if buf:
            chunks.append(buf)
        if len(p) <= max_chars:
            buf = p
            continue
        buf = ""
        step = max(200, max_chars - overlap)
        for i in range(0, len(p), step):
            piece = p[i : i + max_chars]
            if piece.strip():
                chunks.append(piece)
    if buf:
        chunks.append(buf)
    return chunks


def ingest_plaintext(text: str, source: str) -> int:
    chunks = _chunk_text(text)
    if not chunks:
        return 0
    coll = _get_collection()
    ids = [str(uuid.uuid4()) for _ in chunks]
    metadatas: list[Metadata] = [
        {"source": str(source), "chunk_index": i} for i in range(len(chunks))
    ]
    coll.add(ids=ids, documents=chunks, metadatas=metadatas)
    return len(chunks)


def ingest_pdf(raw: bytes, source: str) -> int:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(raw))
    page_texts: list[str] = []
    for page in reader.pages:
        try:
            t = page.extract_text()
        except Exception:
            t = ""
        if t:
            page_texts.append(t)
    text = "\n\n".join(page_texts)
    return ingest_plaintext(text, source)


def collection_count() -> int:
    return _get_collection().count()


def query_context(query: str, n_results: int = 5) -> str:
    q = (query or "").strip()
    if not q:
        return ""

    coll = _get_collection()
    n = coll.count()
    if n == 0:
        return ""

    k = max(1, min(int(n_results), n))
    res = coll.query(query_texts=[q], n_results=k)
    docs = (res.get("documents") or [[]])[0]
    lines = [f"[{i + 1}] {d.strip()}" for i, d in enumerate(docs) if d and str(d).strip()]
    return "\n\n".join(lines) if lines else ""


def reset_knowledge_base() -> None:
    global _collection
    with _lock:
        client = _get_client()
        try:
            client.delete_collection(COLLECTION_NAME)
        except Exception:
            pass
        _collection = None
        _collection = client.get_or_create_collection(
            name=COLLECTION_NAME,
            embedding_function=cast(Any, _make_embedding_fn()),
            metadata={"hnsw:space": "cosine"},
        )
