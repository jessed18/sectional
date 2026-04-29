"""
stage 3: emphasize a voice-part frequency band on the demucs vocals stem.

uses butterworth bandpass + wet/dry blend (not surgical isolation - good for practice tools).
"""

from __future__ import annotations

from pathlib import Path
from typing import Tuple

import numpy as np
from scipy.signal import butter, sosfiltfilt

# approximate fundamental-heavy ranges (hz) - tweak as you like
PART_BANDS_HZ: dict[str, Tuple[float, float]] = {
    "soprano": (250.0, 1000.0),
    "alto": (200.0, 700.0),
    "mezzo": (200.0, 900.0),
    "tenor": (130.0, 500.0),
    "baritone": (100.0, 400.0),
    "bass": (80.0, 350.0),
    "vocals": (80.0, 1200.0),
}


def _bandpass_sos(sr: int, low_hz: float, high_hz: float, order: int = 4):
    nyq = sr / 2.0
    low_n = max(low_hz / nyq, 1e-5)
    high_n = min(high_hz / nyq, 0.999)
    if low_n >= high_n:
        raise ValueError(f"invalid band [{low_hz}, {high_hz}] for sr={sr}")
    return butter(order, [low_n, high_n], btype="band", output="sos")


def emphasize_vocals_file(
    src_path: Path,
    dst_path: Path,
    part: str,
    frequency_range_hz: Tuple[float, float] | None = None,
    band_gain: float = 1.45,
    residual_gain: float = 0.28,
) -> dict:
    """
    read wav from src_path, write processed wav to dst_path.

    band_gain / residual_gain: boost band-passed content vs energy outside the band.
    """
    import soundfile as sf

    data, sr = sf.read(str(src_path), always_2d=True)
    if data.size == 0:
        raise ValueError("empty audio")

    data = np.asarray(data, dtype=np.float64)
    if data.ndim == 1:
        data = data.reshape(-1, 1)

    low_hz, high_hz = frequency_range_hz or PART_BANDS_HZ.get(
        part, PART_BANDS_HZ["vocals"]
    )

    sos = _bandpass_sos(int(sr), low_hz, high_hz)
    n_ch = data.shape[1]
    emphasized = np.empty_like(data)
    for c in range(n_ch):
        band = sosfiltfilt(sos, data[:, c])
        residual = data[:, c] - band
        emphasized[:, c] = band_gain * band + residual_gain * residual

    peak = np.max(np.abs(emphasized)) + 1e-9
    emphasized = (emphasized / peak) * 0.98

    dst_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(
        str(dst_path),
        emphasized.astype(np.float32),
        int(sr),
        subtype="PCM_16",
    )

    return {
        "source_hz": int(sr),
        "band_hz": [float(low_hz), float(high_hz)],
        "part": part,
    }
