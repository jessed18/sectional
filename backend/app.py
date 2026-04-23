import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

from anthropic import Anthropic
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_file
from flask_cors import CORS

load_dotenv()

app = Flask(__name__)
CORS(app)

_api_key = os.getenv("ANTHROPIC_API_KEY")
if not _api_key:
    raise RuntimeError(
        "set ANTHROPIC_API_KEY in the environment or in a .env file"
    )
client = Anthropic(api_key=_api_key)

# default: current sonnet on the claude api (older ids like claude-sonnet-4-20250514 often 404).
_default_model = "claude-sonnet-4-6"
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", _default_model)

# --- directories ---
upload = Path("uploads")
output = Path("outputs")
upload.mkdir(exist_ok=True)
output.mkdir(exist_ok=True)

# --- demucs config ---
demucs_model = "htdemucs"
stem_names = ["vocals", "drums", "bass", "other"]

VOICE_PARTS = frozenset({"soprano", "alto", "tenor", "bass", "vocals"})

# --- claude system prompt ---
system_prompt = """you are a music audio processing assistant for a choral music tool called sectional.

the user is a choir singer who wants to isolate specific vocal parts from a mixed choral recording.

your job: interpret their natural language request and return structured json.

the available voice parts you can isolate are:
- soprano
- alto
- tenor
- bass
- vocals (all vocals combined)

return ONLY valid json in this exact format, nothing else:
{
    "part": "soprano",
    "confidence": 0.95,
    "interpretation": "user wants the soprano part isolated"
}

rules:
- "part" must be one of: soprano, alto, tenor, bass, vocals
- "confidence" is how sure you are about what they want (0.0 to 1.0)
- if the request is unclear, set confidence below 0.5 and pick your best guess
- if they use informal language like "the high part" = soprano, "the low part" = bass, "the guys" = tenor or bass, "the women" = soprano or alto
- if they say something like "everything except the alto", set part to "alto" and add a note in interpretation that they want the OTHER parts
"""


# =====================
# endpoints
# =====================


def _first_text_block(message) -> str:
    for block in message.content:
        if getattr(block, "type", None) == "text":
            return block.text
    raise ValueError("no text block in model response")


def _parse_json_from_model(text: str):
    """model may wrap json in markdown fences or add whitespace."""
    text = text.strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, re.DOTALL | re.IGNORECASE)
    if fence:
        text = fence.group(1).strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError(f"no json object in model output: {text[:200]!r}...")
    return json.loads(text[start : end + 1])


def _normalize_analyze_response(parsed: dict) -> dict:
    """fixed api shape; interpretation matches the documented example pattern."""
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

    interpretation = f"user wants the {part} part isolated"

    return {
        "part": part,
        "confidence": confidence,
        "interpretation": interpretation,
    }


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/analyze", methods=["POST"])
def analyze_request():
    """send natural language to claude, get structured voice part json back."""
    data = request.get_json(silent=True) or {}
    user_input = data.get("text", "")

    if not user_input:
        return jsonify({"error": "no text provided"}), 400

    try:
        message = client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=300,
            system=system_prompt,
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
    """upload an audio file and separate it into stems using demucs."""
    if "file" not in request.files:
        return jsonify({"error": "no audio file provided"}), 400

    file = request.files["file"]
    filename = file.filename
    if not filename:
        return jsonify({"error": "no file selected"}), 400

    job_id = str(uuid.uuid4())[:8]
    job_upload_dir = upload / job_id
    job_upload_dir.mkdir(exist_ok=True)

    original_ext = Path(filename).suffix or ".wav"
    input_path = job_upload_dir / f"input{original_ext}"
    file.save(input_path)

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


@app.route("/stems/<job_id>/<stem>", methods=["GET"])
def get_stem(job_id, stem):
    """download an individual separated stem."""
    if stem not in stem_names:
        return jsonify({"error": f"invalid stem: {stem}"}), 400

    stem_path = output / job_id / f"{stem}.wav"
    if not stem_path.exists():
        return jsonify({"error": "stem not found"}), 404

    return send_file(stem_path, mimetype="audio/wav", as_attachment=True)


@app.route("/jobs/<job_id>", methods=["GET"])
def job_status(job_id):
    """check what stems are available for a completed job."""
    job_dir = output / job_id
    if not job_dir.exists():
        return jsonify({"error": "job not found"}), 404

    available_stems = [
        s for s in stem_names if (job_dir / f"{s}.wav").exists()
    ]

    return jsonify(
        {
            "job_id": job_id,
            "stems": available_stems,
            "files": {
                stem: f"/stems/{job_id}/{stem}" for stem in available_stems
            },
        }
    )


if __name__ == "__main__":
    app.run(debug=True, port=5000)
