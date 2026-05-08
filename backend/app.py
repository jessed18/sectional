from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import uuid
from functools import lru_cache
from pathlib import Path

from anthropic import Anthropic
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_file
from flask_cors import CORS

import audio_emphasis

# Cwd .env first, then backend/.env overrides (so PORT/API keys in backend/.env win over shell/cwd).
load_dotenv()
load_dotenv(Path(__file__).resolve().parent / ".env", override=True)

_RAG_MISSING = object()
_rag_service = None


def _rag():
    """optional RAG module - raises RuntimeError if chromadb/rag_service not installed."""
    global _rag_service
    if _rag_service is _RAG_MISSING:
        raise RuntimeError("RAG is not installed (rag_service missing)")
    if _rag_service is None:
        try:
            import rag_service as _rs  # type: ignore[import-not-found]

            _rag_service = _rs
        except ImportError:
            _rag_service = _RAG_MISSING
            raise RuntimeError("RAG is not installed (rag_service missing)") from None
    return _rag_service


app = Flask(__name__)
CORS(app)

_api_key = os.getenv("ANTHROPIC_API_KEY")
if not _api_key:
    raise RuntimeError(
        "set ANTHROPIC_API_KEY in the environment or in a .env file"
    )
client = Anthropic(api_key=_api_key)

_default_model = "claude-sonnet-4-6"
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", _default_model)

upload = Path("uploads")
output = Path("outputs")
upload.mkdir(exist_ok=True)
output.mkdir(exist_ok=True)

demucs_model = "htdemucs"
stem_names = ["vocals", "drums", "bass", "other"]

VOICE_PARTS = frozenset(
    {"soprano", "alto", "mezzo", "tenor", "baritone", "bass", "vocals"}
)

system_prompt = """you are a music audio processing assistant for a choral music tool called sectional.

the user is a choir singer working from a mixed choral recording (after stem separation they already have a clean vocals track).

your job: interpret what voice part they want to hear clearly and return structured json.

the available voice parts are:
- soprano
- alto
- mezzo (mezzo-soprano)
- tenor
- baritone
- bass
- vocals (all voices on the stem - no single-section boost)

return ONLY valid json in this shape (fill optional fields when you can infer them; use empty string if unknown):
{
    "part": "soprano",
    "confidence": 0.95,
    "interpretation": "short plain-language summary of what they want",
    "frequency_range_hz": [250, 1000],
    "coaching": "what to listen for in rehearsal (vowel shape, blend, etc.)",
    "measure_cues": "e.g. entrance around rehearsal letter B - only if score context or user text implies it"
}

rules:
- "part" must be one of: soprano, alto, mezzo, tenor, baritone, bass, vocals
- default frequency_range_hz by part if unsure: soprano [250,1000], alto [200,700], mezzo [200,900], tenor [130,500], baritone [100,400], bass [80,350], vocals [80,1200]
- "confidence" is 0.0 to 1.0
- informal language: "high part" often soprano, "low part" often bass, "guys" tenor/bass, "women" soprano/alto; "mezzo" / "second soprano" → mezzo; "bari" / low male harmony → baritone
- in interpretation, coaching, measure_cues: write for choir/a cappella singers first; use music terms (entrance, pickup, phrase, blend, tessitura). when useful, add a short parenthetical for engineers (e.g. "roughly this register in Hz" or "after the rest in m. 12")
"""


def _safe_job_segment(seg: str) -> bool:
    if not seg or ".." in seg or "/" in seg or "\\" in seg:
        return False
    return True


def _analyze_system_prompt(rag_context: str | None) -> str:
    if not rag_context:
        return system_prompt
    return (
        system_prompt
        + "\n\n---\noptional context from uploaded sheet-music / rehearsal notes (use if relevant):\n"
        + rag_context
    )


@lru_cache(maxsize=1)
def _sample_score_chunks() -> list[str]:
    p = (
        Path(__file__).resolve().parent
        / "sample_scores"
        / "have_yourself_a_merry_little_christmas.txt"
    )
    if not p.exists():
        return []
    text = p.read_text(encoding="utf-8", errors="replace")
    raw_parts = re.split(r"\n\s*\n+", text)
    return [x.strip() for x in raw_parts if x.strip()]


def _tokenize(s: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", s.lower()))


def _sample_score_context(query: str, max_chunks: int = 6) -> str | None:
    chunks = _sample_score_chunks()
    if not chunks:
        return None
    qtok = _tokenize(query)
    if not qtok:
        return None
    scored: list[tuple[int, str]] = []
    for c in chunks:
        ctok = _tokenize(c)
        overlap = len(qtok.intersection(ctok))
        if overlap > 0:
            scored.append((overlap, c))
    if not scored:
        return None
    scored.sort(key=lambda t: t[0], reverse=True)
    top = [c for _, c in scored[:max_chunks]]
    return "\n\n".join(top)


def _query_rag_context_with_timeout(
    user_input: str, *, n_results: int, timeout_s: float
) -> str | None:
    """
    Best-effort RAG lookup that never blocks request handling for long.
    If RAG is slow/unavailable, return None and continue with base prompt.
    """
    holder: dict[str, str | None] = {"ctx": None}

    def _worker() -> None:
        try:
            holder["ctx"] = _rag().query_context(user_input, n_results=n_results)
        except Exception:
            holder["ctx"] = None

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    t.join(timeout_s)
    if t.is_alive():
        return None
    return holder["ctx"]


def _first_text_block(message) -> str:
    for block in message.content:
        if getattr(block, "type", None) == "text":
            return block.text
    raise ValueError("no text block in model response")


def _parse_json_from_model(text: str):
    text = text.strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, re.DOTALL | re.IGNORECASE)
    if fence:
        text = fence.group(1).strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError(f"no json object in model output: {text[:200]!r}...")
    return json.loads(text[start : end + 1])


def _normalize_analyze_response(parsed: dict) -> dict:
    part = parsed.get("part")
    if part not in VOICE_PARTS:
        raise ValueError(
            f'"part" must be one of {sorted(VOICE_PARTS)}, got {part!r}'
        )

    raw_conf = parsed.get("confidence", 0.95)
    try:
        confidence = float(raw_conf)
    except (TypeError, ValueError) as e:
        raise ValueError(f'"confidence" must be a number, got {raw_conf!r}') from e
    confidence = round(max(0.0, min(1.0, confidence)), 2)

    default_low, default_high = audio_emphasis.PART_BANDS_HZ.get(
        part, audio_emphasis.PART_BANDS_HZ["vocals"]
    )
    low, high = default_low, default_high
    fr = parsed.get("frequency_range_hz")
    if isinstance(fr, (list, tuple)) and len(fr) == 2:
        try:
            low = float(fr[0])
            high = float(fr[1])
        except (TypeError, ValueError):
            pass

    interpretation = (
        parsed.get("interpretation") or f"user wants the {part} part emphasized"
    )
    coaching = parsed.get("coaching") if isinstance(parsed.get("coaching"), str) else ""
    measure_cues = (
        parsed.get("measure_cues")
        if isinstance(parsed.get("measure_cues"), str)
        else ""
    )

    return {
        "part": part,
        "confidence": confidence,
        "interpretation": interpretation,
        "frequency_range_hz": [round(low, 1), round(high, 1)],
        "coaching": coaching,
        "measure_cues": measure_cues,
    }


_PART_DETECT_RE: list[tuple[str, str]] = [
    (r"mezzo[\s-]?soprano", "mezzo"),
    (r"second\s+soprano", "mezzo"),
    (r"\bmezzo\b", "mezzo"),
    (r"\bbaritone\b|\bbari\b", "baritone"),
    (r"\bsoprano\b|\bsop\b", "soprano"),
    (r"\balto\b", "alto"),
    (r"\btenor\b", "tenor"),
    (r"\bbass\b", "bass"),
    (
        r"\ball\s+voices\b|\beveryone\b|\bfull\s+choir\b|\bwhole\s+choir\b|"
        r"\bmixed\s+choir\b|\bno\s+single\s+part\b|\ball\s+together\b",
        "vocals",
    ),
    (r"\b(high\s+women|top\s+line|upper\s+voices)\b", "soprano"),
    (r"\b(low\s+voices|bottom\s+line|low\s+part)\b", "bass"),
]


_INSTANT_COACHING: dict[str, str] = {
    "soprano": (
        "Lean toward tall vowels and steady airflow on sustained tones; keep entrances "
        "clean without scooping from below."
    ),
    "alto": (
        "Anchor vowels with aligned color across the section; watch blending when "
        "doubling or harmonizing under sopranos."
    ),
    "mezzo": (
        "Sit comfortably between soprano and alto colours; phrase so bridges across "
        "breaks stay smooth, not pushed."
    ),
    "tenor": (
        "Brighten gently without nasality; lock rhythmic pickups so male-stack rhythms "
        "stay crisp against piano."
    ),
    "baritone": (
        "Support low mids without dragging tempo; keep consonants clear when buried "
        "between tenor and bass."
    ),
    "bass": (
        "Prioritize rhythmic solidity and unison tuning on roots; avoid over-darkening "
        "vowels that muddy the blend."
    ),
    "vocals": (
        "Listen for sectional balance first; pick one line to track each pass-through so "
        "harmonies unpack mentally."
    ),
}


def _detect_voice_part(user_input: str) -> tuple[str, float]:
    low = user_input.lower()
    for pattern, part in _PART_DETECT_RE:
        if re.search(pattern, low):
            return part, 0.88
    return "vocals", 0.55


_BUNDLED_SAMPLE_TITLE = "Have Yourself a Merry Little Christmas"


def _instant_analyze_payload(
    user_input: str,
    rag_context: str | None,
    *,
    bundled_sample: bool,
    ingested_score: bool,
) -> dict:
    part, confidence = _detect_voice_part(user_input)
    low_hz, high_hz = audio_emphasis.PART_BANDS_HZ.get(
        part, audio_emphasis.PART_BANDS_HZ["vocals"]
    )
    coaching_base = _INSTANT_COACHING.get(part, _INSTANT_COACHING["vocals"])

    if rag_context:
        excerpt_full = " ".join(rag_context.split())
        excerpt = excerpt_full[:520].rsplit(" ", 1)[0] + (
            " …" if len(excerpt_full) > 520 else ""
        )
        coaching = (
            f"Singing this as {part}: line up stressed syllables with the rhythm shown in the score text "
            f"below; keep vowels consistent through sustained tones and phrase endings. {coaching_base} "
            "Use the excerpt for entrances, breaths, and where you sit in the harmony."
        )
        if ingested_score:
            interpretation = (
                "We're coaching your "
                + part
                + " line against your uploaded PDF — match your typed lyric "
                "to words in the excerpt when you can."
            )
        elif bundled_sample:
            interpretation = (
                "We're coaching your "
                + part
                + " line using the bundled "
                + _BUNDLED_SAMPLE_TITLE
                + " score text (default sheet music)."
            )
        else:
            interpretation = (
                "We're coaching your " + part + " line using retrieved sheet-music text."
            )
        measure_cues = f"Sheet music excerpt (syllables & rhythm): {excerpt}"
    else:
        coaching = coaching_base
        if bundled_sample and not ingested_score:
            coaching += (
                f" For line-specific help, type words that actually appear in {_BUNDLED_SAMPLE_TITLE} "
                "so we can pull matching score text."
            )
        elif ingested_score:
            coaching += (
                " Type words from your PDF so retrieval can surface the right passage "
                "(some PDFs extract text poorly — try a phrase from the score)."
            )
        else:
            coaching += " Add sheet music in step 1 for line-specific cues."

        if bundled_sample and not ingested_score:
            interpretation = (
                "We matched "
                + part
                + " from your message; enable richer cues by typing a lyric from "
                + _BUNDLED_SAMPLE_TITLE
                + " (default PDF)."
            )
        elif ingested_score:
            interpretation = (
                "We matched "
                + part
                + " — no score excerpt matched yet; try wording from your uploaded PDF."
            )
        else:
            interpretation = "We matched your request to the " + part + " line."
        measure_cues = ""

    return {
        "part": part,
        "confidence": round(confidence, 2),
        "interpretation": interpretation,
        "frequency_range_hz": [round(low_hz, 1), round(high_hz, 1)],
        "coaching": coaching,
        "measure_cues": measure_cues,
    }


def _env_truthy(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in ("1", "true", "yes")


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/", methods=["GET"])
def root():
    return jsonify({"status": "ok", "service": "sectional-api"})


@app.route("/analyze", methods=["POST"])
def analyze_request():
    data = request.get_json(silent=True) or {}
    user_input = data.get("text", "")

    if not user_input:
        return jsonify({"error": "no text provided"}), 400

    use_rag = bool(data.get("use_rag"))
    use_sample_score = bool(data.get("use_sample_score"))
    force_instant = _env_truthy("SECTIONAL_INSTANT_ANALYZE")
    instant_analyze = force_instant or bool(data.get("instant_analyze"))

    rag_context = None
    if use_sample_score:
        rag_context = _sample_score_context(user_input)
    if use_rag:
        rag_n_results = int(os.getenv("RAG_QUERY_N_RESULTS", "3"))
        if instant_analyze:
            rag_ctx = None
            try:
                rag_ctx = _rag().query_context_lexical(
                    user_input, n_results=rag_n_results
                )
            except Exception:
                rag_ctx = None
            if rag_ctx:
                rag_context = (
                    f"{rag_context}\n\n{rag_ctx}" if rag_context else rag_ctx
                )
        else:
            rag_timeout_s = float(os.getenv("RAG_QUERY_TIMEOUT_SECONDS", "2.5"))
            rag_ctx = _query_rag_context_with_timeout(
                user_input, n_results=rag_n_results, timeout_s=rag_timeout_s
            )
            if rag_ctx:
                rag_context = (
                    f"{rag_context}\n\n{rag_ctx}" if rag_context else rag_ctx
                )

    if instant_analyze:
        return jsonify(
            _instant_analyze_payload(
                user_input,
                rag_context,
                bundled_sample=use_sample_score,
                ingested_score=use_rag,
            )
        )

    try:
        message = client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=700,
            system=_analyze_system_prompt(rag_context),
            messages=[{"role": "user", "content": user_input}],
        )

        raw = _first_text_block(message)
        parsed = _parse_json_from_model(raw)
        result = _normalize_analyze_response(parsed)
        return jsonify(result)

    except ValueError as e:
        return jsonify({"error": str(e)}), 422
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/separate", methods=["POST"])
def separate_audio():
    if os.getenv("DISABLE_DEMUCS") == "1":
        return jsonify(
            {
                "error": "audio separation is disabled on this deployment (use full backend or ecs for demucs)",
            }
        ), 503

    if "file" not in request.files:
        return jsonify({"error": "no audio file provided"}), 400

    upload_file = request.files["file"]
    filename = upload_file.filename
    if not filename:
        return jsonify({"error": "no file selected"}), 400

    job_id = str(uuid.uuid4())[:8]
    job_upload_dir = upload / job_id
    job_upload_dir.mkdir(exist_ok=True)

    original_ext = Path(filename).suffix or ".wav"
    input_path = job_upload_dir / f"input{original_ext}"
    upload_file.save(input_path)

    try:
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "demucs",
                "--name",
                demucs_model,
                "--out",
                str(output),
                str(input_path),
            ],
            capture_output=True,
            text=True,
            timeout=300,
        )

        if result.returncode != 0:
            return jsonify(
                {"error": "separation failed", "details": result.stderr}
            ), 500

    except subprocess.TimeoutExpired:
        return jsonify({"error": "separation timed out"}), 504

    stems_dir = output / demucs_model / input_path.stem

    if not stems_dir.exists():
        return jsonify({"error": "output stems not found"}), 500

    final_dir = output / job_id
    if final_dir.exists():
        shutil.rmtree(final_dir)
    stems_dir.rename(final_dir)

    model_dir = output / demucs_model
    if model_dir.exists() and not any(model_dir.iterdir()):
        model_dir.rmdir()

    available_stems = [
        s for s in stem_names if (final_dir / f"{s}.wav").exists()
    ]

    return jsonify(
        {
            "job_id": job_id,
            "status": "success",
            "stems": available_stems,
            "files": {
                stem: f"/stems/{job_id}/{stem}" for stem in available_stems
            },
        }
    )


@app.route("/emphasize", methods=["POST"])
def emphasize():
    """
    stage 3: band-emphasize the demucs vocals stem for the requested voice part.
    optional body: frequency_range_hz [low, high] overrides defaults / analyze output.
    """
    data = request.get_json(silent=True) or {}
    job_id = data.get("job_id")
    part = data.get("part", "vocals")
    if not job_id:
        return jsonify({"error": "job_id required"}), 400
    if not _safe_job_segment(str(job_id)):
        return jsonify({"error": "invalid job_id"}), 400

    job_dir = output / job_id
    if not job_dir.exists():
        return jsonify({"error": "job not found"}), 404

    src = job_dir / "vocals.wav"
    if not src.exists():
        return jsonify({"error": "vocals stem not found; run separation first"}), 404

    if part not in VOICE_PARTS:
        return jsonify({"error": f"part must be one of {sorted(VOICE_PARTS)}"}), 400

    freq_in = data.get("frequency_range_hz")
    freq_tuple = None
    if isinstance(freq_in, (list, tuple)) and len(freq_in) == 2:
        try:
            freq_tuple = (float(freq_in[0]), float(freq_in[1]))
        except (TypeError, ValueError):
            freq_tuple = None

    safe = "".join(c for c in str(part) if c.isalnum() or c in "_-").strip()[:64] or "part"
    out_stem = f"{safe}_emphasized"
    dest = job_dir / f"{out_stem}.wav"

    try:
        meta = audio_emphasis.emphasize_vocals_file(
            src,
            dest,
            part,
            frequency_range_hz=freq_tuple,
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    available = sorted(
        p.stem for p in job_dir.glob("*.wav") if p.is_file()
    )

    return jsonify(
        {
            "job_id": job_id,
            "part": part,
            "stems": available,
            "emphasized": out_stem,
            "dsp": meta,
            "note": "Register-focused EQ on the vocals stem (band-pass DSP): boosts the analyzed pitch range so a section pops in headphones; not stem-perfect isolation - original vocals.wav unchanged.",
        }
    )


@app.route("/stems/<job_id>/<stem>", methods=["GET"])
def get_stem(job_id, stem):
    if not _safe_job_segment(job_id):
        return jsonify({"error": "invalid job_id"}), 400
    if ".." in stem or "/" in stem or "\\" in stem:
        return jsonify({"error": "invalid stem"}), 400

    stem_path = output / job_id / f"{stem}.wav"
    if not stem_path.is_file():
        return jsonify({"error": "stem not found"}), 404

    return send_file(stem_path, mimetype="audio/wav", as_attachment=True)


@app.route("/jobs/<job_id>", methods=["GET"])
def job_status(job_id):
    if not _safe_job_segment(job_id):
        return jsonify({"error": "invalid job_id"}), 400
    job_dir = output / job_id
    if not job_dir.exists():
        return jsonify({"error": "job not found"}), 404

    available_stems = sorted(
        p.stem for p in job_dir.glob("*.wav") if p.is_file()
    )

    return jsonify(
        {
            "job_id": job_id,
            "stems": available_stems,
            "files": {
                stem: f"/stems/{job_id}/{stem}" for stem in available_stems
            },
        }
    )


def _rag_not_installed_response():
    return jsonify(
        {
            "error": "RAG is not installed (rag_service missing); pip install chromadb sentence-transformers pypdf or remove use_rag"
        }
    ), 503


@app.route("/rag/stats", methods=["GET"])
def rag_stats():
    try:
        n = _rag().collection_count()
    except RuntimeError:
        return _rag_not_installed_response()
    except Exception as e:
        return jsonify({"error": str(e), "documents": 0}), 500
    return jsonify({"documents": n})


@app.route("/rag/ingest", methods=["POST"])
def rag_ingest():
    try:
        _rag()
    except RuntimeError:
        return _rag_not_installed_response()

    src = request.form.get("source") or "upload"

    if "file" in request.files and request.files["file"].filename:
        ingest = request.files["file"]
        name = ingest.filename or "upload"
        raw = ingest.read()
        lower = name.lower()
        try:
            if lower.endswith(".pdf"):
                added = _rag().ingest_pdf(raw, source=src or name)
            else:
                text = raw.decode("utf-8", errors="replace")
                added = _rag().ingest_plaintext(text, source=src or name)
        except Exception as e:
            return jsonify({"error": str(e)}), 400
        return jsonify({"chunks_added": added, "source": src or name})

    data = request.get_json(silent=True) or {}
    text = data.get("text", "")
    if not text:
        return jsonify({"error": "no file or text provided"}), 400
    try:
        added = _rag().ingest_plaintext(text, source=data.get("source", "json"))
    except Exception as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"chunks_added": added, "source": data.get("source", "json")})


@app.route("/rag/query", methods=["POST"])
def rag_query_debug():
    try:
        _rag()
    except RuntimeError:
        return _rag_not_installed_response()

    data = request.get_json(silent=True) or {}
    q = data.get("text", "")
    if not q:
        return jsonify({"error": "no text provided"}), 400
    try:
        ctx = _rag().query_context(q, n_results=int(data.get("n", 5)))
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"context": ctx})


@app.route("/rag/reset", methods=["POST"])
def rag_reset():
    if os.getenv("ALLOW_RAG_RESET") != "1":
        return jsonify({"error": "set ALLOW_RAG_RESET=1 to confirm"}), 403
    try:
        _rag().reset_knowledge_base()
    except RuntimeError:
        return _rag_not_installed_response()
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    import socket
    import sys

    def _can_bind(host: str, p: int, *, family: int = socket.AF_INET) -> bool:
        with socket.socket(family, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((host, p))
                return True
            except OSError:
                return False

    def _flask_port_available(p: int, host: str) -> bool:
        """True if we expect Flask can listen on host:p (IPv4 + IPv6 loopback on macOS)."""
        if not _can_bind(host, p, family=socket.AF_INET):
            return False
        if sys.platform == "darwin":
            try:
                if not _can_bind("::1", p, family=socket.AF_INET6):
                    return False
            except OSError:
                pass
        return True

    _host = "127.0.0.1"
    # macOS: AirPlay / Control Center often holds 5000. Shell may still export PORT=5000.
    if sys.platform == "darwin":
        _raw = os.environ.get("PORT", "").strip()
        preferred = int(_raw) if _raw else 5001
        if preferred == 5000 and os.environ.get("SECTIONAL_ALLOW_PORT_5000") != "1":
            preferred = 5001
    else:
        preferred = int(os.environ.get("PORT", "5000"))
    listen_port = preferred
    if not _flask_port_available(preferred, _host):
        listen_port = None
        for p in range(preferred + 1, preferred + 20):
            if _flask_port_available(p, _host):
                listen_port = p
                break
        if listen_port is None:
            raise RuntimeError(
                f"no free TCP port in {_host}:{preferred + 1}-{preferred + 19}; "
                "free one or set PORT in .env"
            )
        print(
            f"\n*** Port {preferred} is in use; listening on {listen_port}.\n"
            f"*** If the UI cannot reach the API, set VITE_BACKEND_PORT={listen_port} "
            "in frontend/.env (see frontend/.env.example).\n"
        )

    print(
        f"[sectional] http://{_host}:{listen_port}/  (debug, reloader off)\n",
        flush=True,
    )
    # use_reloader=False avoids extra bind / "Address already in use" on macOS with debug=True
    app.run(debug=True, host=_host, port=listen_port, use_reloader=False)
