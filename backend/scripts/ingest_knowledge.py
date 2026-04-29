"""
ingest pdf / md / txt into chromadb for RAG.

run from the backend directory:
  python -m scripts.ingest_knowledge ../knowledge
  python -m scripts.ingest_knowledge ./scores --prefix rehearsal_2026
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# ensure backend root is importable when run as __main__
_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))


def main() -> None:
    p = argparse.ArgumentParser(description="ingest choir documents into sectional RAG store")
    p.add_argument("path", type=Path, help="file or directory to ingest")
    p.add_argument(
        "--prefix",
        default="",
        help="optional prefix for source labels",
    )
    args = p.parse_args()

    import rag_service

    root: Path = args.path.resolve()
    if not root.exists():
        print(f"not found: {root}", file=sys.stderr)
        sys.exit(1)

    files: list[Path]
    if root.is_file():
        files = [root]
    else:
        files = [
            f
            for f in root.rglob("*")
            if f.is_file() and f.suffix.lower() in {".pdf", ".md", ".txt"}
        ]

    total_chunks = 0
    for f in sorted(files):
        if args.prefix:
            rel = f.relative_to(root) if root.is_dir() else Path(f.name)
            label = f"{args.prefix.rstrip('/')}/{rel}"
        else:
            label = str(f.relative_to(root)) if root.is_dir() else f.name
        raw = f.read_bytes()
        suf = f.suffix.lower()
        try:
            if suf == ".pdf":
                n = rag_service.ingest_pdf(raw, source=label)
            else:
                text = raw.decode("utf-8", errors="replace")
                n = rag_service.ingest_plaintext(text, source=label)
        except Exception as e:
            print(f"skip {f}: {e}", file=sys.stderr)
            continue
        total_chunks += n
        print(f"{f.name}: {n} chunks")

    print(f"done. total chunks added: {total_chunks}. documents in index: {rag_service.collection_count()}")


if __name__ == "__main__":
    main()
