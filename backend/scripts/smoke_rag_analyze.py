"""
verify RAG index + POST /analyze with use_rag (Flask test client; no server).

from the backend directory:

  python -m scripts.smoke_rag_analyze

requires ANTHROPIC_API_KEY in backend/.env (or environment) and a non-empty
Chroma index unless you pass --allow-empty-rag. ingest first:

  python -m scripts.ingest_knowledge ../knowledge
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="smoke test: rag collection_count + analyze with use_rag"
    )
    parser.add_argument(
        "--min-chunks",
        type=int,
        default=1,
        metavar="N",
        help="minimum rag_service.collection_count() required (default: 1)",
    )
    parser.add_argument(
        "--allow-empty-rag",
        action="store_true",
        help="do not fail if the vector index is empty",
    )
    parser.add_argument(
        "--query",
        default="Where do sopranos come in? I need measure cues.",
        help="user text sent to /analyze",
    )
    args = parser.parse_args()

    from dotenv import load_dotenv

    load_dotenv(_BACKEND / ".env")

    import os

    if not os.getenv("ANTHROPIC_API_KEY"):
        print("error: ANTHROPIC_API_KEY missing (set in backend/.env)", file=sys.stderr)
        return 1

    import rag_service

    n = rag_service.collection_count()
    print(f"rag collection_count: {n}")
    if n < args.min_chunks and not args.allow_empty_rag:
        print(
            f"error: need at least {args.min_chunks} chunk(s); run scripts.ingest_knowledge first",
            file=sys.stderr,
        )
        return 1

    import app as sectional

    client = sectional.app.test_client()
    resp = client.post("/analyze", json={"text": args.query, "use_rag": True})
    body = resp.get_json(silent=True)

    print(f"/analyze status: {resp.status_code}")
    if resp.status_code != 200:
        print(f"body: {body}", file=sys.stderr)
        return 1

    assert isinstance(body, dict)
    for key in ("part", "confidence", "frequency_range_hz", "measure_cues"):
        if key not in body:
            print(f"error: missing {key!r} in response", file=sys.stderr)
            return 1

    mc = body.get("measure_cues") or ""
    snippet = str(mc)[:240] + ("…" if len(str(mc)) > 240 else "")
    print(f"part: {body.get('part')}")
    print(f"measure_cues: {snippet}")
    print("smoke_rag_analyze: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
