# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["kokoro-onnx==0.6.1"]
# ///
"""Speaks the captions of the demo recordings with an open-source voice, on this machine.

Called by scripts/lib/narration.mjs. It reads a job file (the voice, the pace and the clips to
make), writes one WAV per clip and prints how long each one runs. Nothing is sent anywhere: the
only network use is the first download of the model files, which are checked against the
SHA-256 values pinned in narration.config.json before they are loaded.

  uv run --script scripts/narrate.py --job <job.json> --out <folder> --models <folder>
"""

import argparse
import hashlib
import json
import pathlib
import ssl
import sys
import urllib.request
import wave

import numpy as np

FADE_SECONDS = 0.008


def fetch(url: str, target: pathlib.Path, sha256: str) -> None:
    """Downloads a model file once and refuses one that is not the pinned file."""
    if not target.exists():
        part = target.with_suffix(target.suffix + ".part")
        request = urllib.request.Request(url, headers={"User-Agent": "python-urllib"})
        with urllib.request.urlopen(
            request, context=ssl.create_default_context(), timeout=900
        ) as response, open(part, "wb") as out:
            while chunk := response.read(1 << 20):
                out.write(chunk)
        part.rename(target)
    digest = hashlib.sha256()
    with open(target, "rb") as stream:
        while chunk := stream.read(1 << 20):
            digest.update(chunk)
    if digest.hexdigest() != sha256:
        raise SystemExit(
            f"{target.name}: SHA-256 {digest.hexdigest()} is not the pinned {sha256}; "
            "delete the file and run again, or update narration.config.json on purpose"
        )


def write_wav(path: pathlib.Path, samples: np.ndarray, rate: int) -> float:
    """Writes mono 16-bit PCM with a short fade at each end, and answers the length in seconds."""
    audio = np.clip(np.asarray(samples, dtype=np.float32).reshape(-1), -1.0, 1.0)
    fade = min(int(rate * FADE_SECONDS), audio.size // 2)
    if fade > 0:
        ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
        audio[:fade] *= ramp
        audio[-fade:] *= ramp[::-1]
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes((audio * 32767.0).astype("<i2").tobytes())
    return audio.size / rate


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--models", required=True)
    args = parser.parse_args()

    job = json.loads(pathlib.Path(args.job).read_text(encoding="utf-8"))
    out = pathlib.Path(args.out)
    models = pathlib.Path(args.models)
    out.mkdir(parents=True, exist_ok=True)
    models.mkdir(parents=True, exist_ok=True)

    paths = {}
    for name in ("model", "voices"):
        spec = job["files"][name]
        paths[name] = models / spec["name"]
        fetch(spec["url"], paths[name], spec["sha256"])

    from kokoro_onnx import Kokoro  # imported late: the files above must be the pinned ones

    engine = Kokoro(str(paths["model"]), str(paths["voices"]))
    done = []
    for clip in job["clips"]:
        samples, rate = engine.create(
            clip["text"], voice=job["voice"], speed=job["speed"], lang=job["lang"]
        )
        seconds = write_wav(out / f"{clip['key']}.wav", samples, rate)
        done.append({"key": clip["key"], "seconds": round(seconds, 3)})
        print(f"spoke {clip['key']} {seconds:.2f}s", file=sys.stderr)
    json.dump({"clips": done}, sys.stdout)


if __name__ == "__main__":
    main()
