#!/usr/bin/env python3
"""Fallback CLI for explicit image generation or editing with GPT Image models.

Used only when the user explicitly opts into CLI fallback mode, or when explicit
transparent output requires the `gpt-image-1.5` fallback path.

Defaults to gpt-image-2 and a structured prompt augmentation workflow.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import hashlib
import os
from pathlib import Path
import re
import signal
import sqlite3
import sys
import time
import uuid
from contextlib import contextmanager
from typing import Any, Dict, Iterable, List, Optional, Tuple

from io import BytesIO

DEFAULT_MODEL = os.getenv("PET_IMAGE_MODEL") or "gpt-image-2"
DEFAULT_SIZE = "auto"
DEFAULT_QUALITY = "medium"
DEFAULT_OUTPUT_FORMAT = "png"
DEFAULT_CONCURRENCY = 5
DEFAULT_DOWNSCALE_SUFFIX = "-web"
DEFAULT_OUTPUT_PATH = "output/imagegen/output.png"
GPT_IMAGE_MODEL_PREFIX = "gpt-image-"
# 备用线路模型名可通过 PET_IMAGE_FALLBACK_MODEL 覆盖；此处只是缺省值，不是硬编码策略。
FALLBACK_MODEL = os.getenv("PET_IMAGE_FALLBACK_MODEL") or "grok-imagine-image-quality"
MUSE_SIZES = {"1024x1024": "2048x2048", "1536x1024": "2048x1536", "1024x1536": "1536x2048", "auto": "2048x2048"}
EDIT_TIMEOUT = 550
FALLBACK_TIMEOUT = 160
MODEL_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

ALLOWED_LEGACY_SIZES = {"1024x1024", "1536x1024", "1024x1536", "auto"}
ALLOWED_QUALITIES = {"low", "medium", "high", "auto"}
ALLOWED_BACKGROUNDS = {"transparent", "opaque", "auto", None}
ALLOWED_INPUT_FIDELITIES = {"low", "high", None}

GPT_IMAGE_2_MODEL = "gpt-image-2"
GPT_IMAGE_2_MIN_PIXELS = 655_360
GPT_IMAGE_2_MAX_PIXELS = 8_294_400
GPT_IMAGE_2_MAX_EDGE = 3840
GPT_IMAGE_2_MAX_RATIO = 3.0

MAX_IMAGE_BYTES = 50 * 1024 * 1024
MAX_BATCH_JOBS = 500


@contextmanager
def _edit_deadline(seconds: int):
    """Bound the whole request, including reads that keep resetting socket timeouts."""
    if not hasattr(signal, "setitimer"):
        yield
        return

    def expired(_signum, _frame):
        raise TimeoutError("image edit wall time exceeded")

    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


IMAGE_EVENT_LOG_ENV = "PET_IMAGE_EVENT_LOG"
_IMAGE_EVENT_CONTEXT: Dict[str, Any] = {}


def _image_event_log_path() -> str:
    explicit = os.environ.get(IMAGE_EVENT_LOG_ENV, "").strip()
    if explicit:
        return explicit
    data_dir = os.environ.get("PET_DATA_DIR", "").strip()
    if data_dir:
        return str(Path(data_dir) / "logs" / "image-events.log")
    return ""


def _write_image_event(record: Dict[str, Any]) -> None:
    """Append one line for later "which model made this / why did it fail" questions.

    Never records prompt text, keys or image bytes. Silently skipped when no log target.
    """
    path = _image_event_log_path()
    if not path:
        return
    try:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and target.stat().st_size > 2 * 1024 * 1024:
            os.replace(target, target.with_name(target.name + ".1"))
        created = not target.exists()
        with open(target, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        if created:
            os.chmod(target, 0o640)
    except OSError as error:
        print(f"IMAGE_DIAGNOSTIC_WRITE_FAILED {type(error).__name__} {error.errno}", file=sys.stderr, flush=True)


def _edit_event(provider, stage, started, error=None):
    event = {"provider": provider, "stage": stage, "elapsedMs": round((time.monotonic() - started) * 1000)}
    if error is not None:
        event["error"] = type(error).__name__
        response = getattr(error, "response", None)
        status = getattr(error, "status_code", None) or getattr(response, "status_code", None)
        if isinstance(status, int):
            event["status"] = status
        if isinstance(error, EditFailure):
            event.update(code=error.code, retryable=error.retryable)
    if error is not None:
        event.update(getattr(error, "evidence", {}))
    event.update({k: _IMAGE_EVENT_CONTEXT[k] for k in ("httpStatus", "upstreamRequestId") if k in _IMAGE_EVENT_CONTEXT})
    print("IMAGE_EDIT " + json.dumps(event), file=sys.stderr, flush=True)
    record = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    record.update(_IMAGE_EVENT_CONTEXT)
    record.update(event)
    if error is not None:
        record["reason"] = str(error) if isinstance(error, EditFailure) else type(error).__name__
    _write_image_event(record)
    _save_image_checkpoint(record)


def _save_image_checkpoint(record):
    marker = os.getenv("PET_IMAGE_JOB_MARKER")
    if marker:
        target = Path(marker + ".diagnostic.json")
        temporary = target.with_suffix(".tmp")
        try:
            temporary.write_text(json.dumps(record), encoding="utf-8")
            temporary.replace(target)
        except OSError as write_error:
            print(f"IMAGE_DIAGNOSTIC_WRITE_FAILED {type(write_error).__name__} {write_error.errno}", file=sys.stderr, flush=True)


def _mark_decode_phase(phase):
    _save_image_checkpoint({**_IMAGE_EVENT_CONTEXT, "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                            "stage": "processing_response", "phase": phase})


def _capture_edit_response(response):
    _IMAGE_EVENT_CONTEXT["httpStatus"] = response.status_code
    request_id = response.headers.get("x-request-id") or response.headers.get("request-id")
    if request_id and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", request_id):
        _IMAGE_EVENT_CONTEXT["upstreamRequestId"] = request_id


def _die(message: str, code: int = 1) -> None:
    print(f"Error: {message}", file=sys.stderr)
    raise SystemExit(code)


def _warn(message: str) -> None:
    print(f"Warning: {message}", file=sys.stderr)


def _dependency_hint(package: str, *, upgrade: bool = False) -> str:
    command = f"uv pip install {'-U ' if upgrade else ''}{package}"
    return (
        "Activate the repo-selected environment first, then install it with "
        f"`{command}`. If this repo uses a local virtualenv, start with "
        "`source .venv/bin/activate`; otherwise use this repo's configured shared fallback "
        "environment. If your project declares dependencies, prefer that project's normal "
        "`uv sync` flow."
    )


def _ensure_api_key(dry_run: bool) -> None:
    if os.getenv("OPENAI_API_KEY"):
        print("OPENAI_API_KEY is set.", file=sys.stderr)
        return
    if dry_run:
        _warn("OPENAI_API_KEY is not set; dry-run only.")
        return
    _die("OPENAI_API_KEY is not set. Export it before running.")


def _read_prompt(prompt: Optional[str], prompt_file: Optional[str]) -> str:
    if prompt and prompt_file:
        _die("Use --prompt or --prompt-file, not both.")
    if prompt_file:
        path = Path(prompt_file)
        if not path.exists():
            _die(f"Prompt file not found: {path}")
        return path.read_text(encoding="utf-8").strip()
    if prompt:
        return prompt.strip()
    _die("Missing prompt. Use --prompt or --prompt-file.")
    return ""  # unreachable


def _check_image_paths(paths: Iterable[str]) -> List[Path]:
    resolved: List[Path] = []
    for raw in paths:
        path = Path(raw)
        if not path.exists():
            _die(f"Image file not found: {path}")
        if path.stat().st_size > MAX_IMAGE_BYTES:
            _warn(f"Image exceeds 50MB limit: {path}")
        resolved.append(path)
    return resolved


def _normalize_output_format(fmt: Optional[str]) -> str:
    if not fmt:
        return DEFAULT_OUTPUT_FORMAT
    fmt = fmt.lower()
    if fmt not in {"png", "jpeg", "jpg", "webp"}:
        _die("output-format must be png, jpeg, jpg, or webp.")
    return "jpeg" if fmt == "jpg" else fmt


def _parse_size(size: str) -> Optional[Tuple[int, int]]:
    match = re.fullmatch(r"([1-9][0-9]*)x([1-9][0-9]*)", size)
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


def _validate_gpt_image_2_size(size: str) -> None:
    if size == "auto":
        return

    parsed = _parse_size(size)
    if parsed is None:
        _die("size must be auto or WIDTHxHEIGHT, for example 1024x1024.")

    width, height = parsed
    max_edge = max(width, height)
    min_edge = min(width, height)
    total_pixels = width * height

    if max_edge > GPT_IMAGE_2_MAX_EDGE:
        _die(
            "gpt-image-2 size maximum edge length must be less than or equal to 3840px."
        )
    if width % 16 != 0 or height % 16 != 0:
        _die("gpt-image-2 size width and height must be multiples of 16px.")
    if max_edge / min_edge > GPT_IMAGE_2_MAX_RATIO:
        _die("gpt-image-2 size long edge to short edge ratio must not exceed 3:1.")
    if total_pixels < GPT_IMAGE_2_MIN_PIXELS or total_pixels > GPT_IMAGE_2_MAX_PIXELS:
        _die(
            "gpt-image-2 size total pixels must be at least 655,360 and no more than 8,294,400."
        )


def _validate_size(size: str, model: str) -> None:
    if model == GPT_IMAGE_2_MODEL:
        _validate_gpt_image_2_size(size)
        return

    if size not in ALLOWED_LEGACY_SIZES:
        _die(
            "size must be one of 1024x1024, 1536x1024, 1024x1536, or auto for this GPT Image model."
        )


def _validate_quality(quality: str) -> None:
    if quality not in ALLOWED_QUALITIES:
        _die("quality must be one of low, medium, high, or auto.")


def _validate_background(background: Optional[str]) -> None:
    if background not in ALLOWED_BACKGROUNDS:
        _die("background must be one of transparent, opaque, or auto.")


def _validate_input_fidelity(input_fidelity: Optional[str]) -> None:
    if input_fidelity not in ALLOWED_INPUT_FIDELITIES:
        _die("input-fidelity must be one of low or high.")


def _validate_model(model: str) -> None:
    # 不再限定必须 gpt-image-*：中转站可能提供其它模型（如 muse-image）。
    # 只做最基本的名字合法性校验，具体模型是否存在交由上游判定。
    if not MODEL_NAME_PATTERN.match(model or ""):
        _die("model 名称不合法：只允许字母、数字和 . _ -，长度 1-64，且不能以符号开头。")


def _validate_transparency(background: Optional[str], output_format: str) -> None:
    if background == "transparent" and output_format not in {"png", "webp"}:
        _die("transparent background requires output-format png or webp.")


def _validate_model_specific_options(
    *,
    model: str,
    background: Optional[str],
    input_fidelity: Optional[str] = None,
) -> None:
    if model != GPT_IMAGE_2_MODEL:
        return
    if background == "transparent":
        _die(
            "transparent backgrounds are not supported in gpt-image-2, the latest model. "
            "Use --model gpt-image-1.5 --background transparent --output-format png instead."
        )
    if input_fidelity is not None:
        _die(
            "input_fidelity is not supported in gpt-image-2 because image inputs always use high fidelity for this model."
        )


def _validate_generate_payload(payload: Dict[str, Any]) -> None:
    model = str(payload.get("model", DEFAULT_MODEL))
    _validate_model(model)
    n = int(payload.get("n", 1))
    if n < 1 or n > 10:
        _die("n must be between 1 and 10")
    size = str(payload.get("size", DEFAULT_SIZE))
    quality = str(payload.get("quality", DEFAULT_QUALITY))
    background = payload.get("background")
    _validate_size(size, model)
    _validate_quality(quality)
    _validate_background(background)
    _validate_model_specific_options(model=model, background=background)
    oc = payload.get("output_compression")
    if oc is not None and not (0 <= int(oc) <= 100):
        _die("output_compression must be between 0 and 100")


def _build_output_paths(
    out: str,
    output_format: str,
    count: int,
    out_dir: Optional[str],
) -> List[Path]:
    ext = "." + output_format

    if out_dir:
        out_base = Path(out_dir)
        out_base.mkdir(parents=True, exist_ok=True)
        return [out_base / f"image_{i}{ext}" for i in range(1, count + 1)]

    out_path = Path(out)
    if out_path.exists() and out_path.is_dir():
        out_path.mkdir(parents=True, exist_ok=True)
        return [out_path / f"image_{i}{ext}" for i in range(1, count + 1)]

    if out_path.suffix == "":
        out_path = out_path.with_suffix(ext)
    elif output_format and out_path.suffix.lstrip(".").lower() != output_format:
        _warn(
            f"Output extension {out_path.suffix} does not match output-format {output_format}."
        )

    if count == 1:
        return [out_path]

    return [
        out_path.with_name(f"{out_path.stem}-{i}{out_path.suffix}")
        for i in range(1, count + 1)
    ]


def _augment_prompt(args: argparse.Namespace, prompt: str) -> str:
    fields = _fields_from_args(args)
    return _augment_prompt_fields(args.augment, prompt, fields)


def _augment_prompt_fields(
    augment: bool, prompt: str, fields: Dict[str, Optional[str]]
) -> str:
    if not augment:
        return prompt

    sections: List[str] = []
    if fields.get("use_case"):
        sections.append(f"Use case: {fields['use_case']}")
    sections.append(f"Primary request: {prompt}")
    if fields.get("scene"):
        sections.append(f"Scene/background: {fields['scene']}")
    if fields.get("subject"):
        sections.append(f"Subject: {fields['subject']}")
    if fields.get("style"):
        sections.append(f"Style/medium: {fields['style']}")
    if fields.get("composition"):
        sections.append(f"Composition/framing: {fields['composition']}")
    if fields.get("lighting"):
        sections.append(f"Lighting/mood: {fields['lighting']}")
    if fields.get("palette"):
        sections.append(f"Color palette: {fields['palette']}")
    if fields.get("materials"):
        sections.append(f"Materials/textures: {fields['materials']}")
    if fields.get("text"):
        sections.append(f'Text (verbatim): "{fields["text"]}"')
    if fields.get("constraints"):
        sections.append(f"Constraints: {fields['constraints']}")
    if fields.get("negative"):
        sections.append(f"Avoid: {fields['negative']}")

    return "\n".join(sections)


def _fields_from_args(args: argparse.Namespace) -> Dict[str, Optional[str]]:
    return {
        "use_case": getattr(args, "use_case", None),
        "scene": getattr(args, "scene", None),
        "subject": getattr(args, "subject", None),
        "style": getattr(args, "style", None),
        "composition": getattr(args, "composition", None),
        "lighting": getattr(args, "lighting", None),
        "palette": getattr(args, "palette", None),
        "materials": getattr(args, "materials", None),
        "text": getattr(args, "text", None),
        "constraints": getattr(args, "constraints", None),
        "negative": getattr(args, "negative", None),
    }


def _print_request(payload: dict) -> None:
    print(json.dumps(payload, indent=2, sort_keys=True))


def _decode_and_write(images: List[str], outputs: List[Path], force: bool) -> None:
    for idx, image_b64 in enumerate(images):
        if idx >= len(outputs):
            break
        out_path = outputs[idx]
        if out_path.exists() and not force:
            _die(f"Output already exists: {out_path} (use --force to overwrite)")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(base64.b64decode(image_b64))
        print(f"Wrote {out_path}")


def _derive_downscale_path(path: Path, suffix: str) -> Path:
    if suffix and not suffix.startswith("-") and not suffix.startswith("_"):
        suffix = "-" + suffix
    return path.with_name(f"{path.stem}{suffix}{path.suffix}")


def _downscale_image_bytes(
    image_bytes: bytes, *, max_dim: int, output_format: str
) -> bytes:
    try:
        from PIL import Image
    except Exception:
        _die(f"Downscaling requires Pillow. {_dependency_hint('pillow')}")

    if max_dim < 1:
        _die("--downscale-max-dim must be >= 1")

    with Image.open(BytesIO(image_bytes)) as img:
        img.load()
        w, h = img.size
        scale = min(1.0, float(max_dim) / float(max(w, h)))
        target = (max(1, int(round(w * scale))), max(1, int(round(h * scale))))

        resized = (
            img if target == (w, h) else img.resize(target, Image.Resampling.LANCZOS)
        )

        fmt = output_format.lower()
        if fmt == "jpg":
            fmt = "jpeg"

        if fmt == "jpeg":
            if resized.mode in ("RGBA", "LA") or (
                "transparency" in getattr(resized, "info", {})
            ):
                bg = Image.new("RGB", resized.size, (255, 255, 255))
                bg.paste(
                    resized.convert("RGBA"), mask=resized.convert("RGBA").split()[-1]
                )
                resized = bg
            else:
                resized = resized.convert("RGB")

        out = BytesIO()
        resized.save(out, format=fmt.upper())
        return out.getvalue()


def _max_side_limit(explicit: Optional[int], size: str) -> Optional[int]:
    """最长边上限：显式 --max-side 优先，否则跟随 --size（auto 时不限）。"""
    if explicit is not None:
        return explicit if explicit > 0 else None
    match = re.fullmatch(r"(\d+)\s*[xX]\s*(\d+)", str(size or "").strip())
    if not match:
        return None
    return max(int(match.group(1)), int(match.group(2)))


def _clamp_image_bytes(raw: bytes, max_side: int, output_format: str) -> bytes:
    """上游回图有时比请求更大（实测 low 质量返回 1536），按最长边原地缩到请求尺寸。"""
    from PIL import Image

    with Image.open(BytesIO(raw)) as im:
        longest = max(im.size)
        if longest <= max_side:
            return raw
        scale = max_side / float(longest)
        target = (max(1, round(im.width * scale)), max(1, round(im.height * scale)))
        resized = im.resize(target, Image.LANCZOS)
        buf = BytesIO()
        fmt = (output_format or "png").upper()
        if fmt == "JPG":
            fmt = "JPEG"
        save_kwargs = {"quality": 95} if fmt in ("JPEG", "WEBP") else {}
        resized.save(buf, format=fmt, **save_kwargs)
        print(
            f"Clamped {im.size[0]}x{im.size[1]} -> {target[0]}x{target[1]} (max side {max_side})",
            file=sys.stderr,
            flush=True,
        )
        return buf.getvalue()


def _decode_write_and_downscale(
    images: List[str],
    outputs: List[Path],
    *,
    force: bool,
    downscale_max_dim: Optional[int],
    downscale_suffix: str,
    output_format: str,
    clamp_max_side: Optional[int] = None,
) -> None:
    for idx, image_b64 in enumerate(images):
        if idx >= len(outputs):
            break
        out_path = outputs[idx]
        if out_path.exists() and not force:
            _die(f"Output already exists: {out_path} (use --force to overwrite)")
        out_path.parent.mkdir(parents=True, exist_ok=True)

        raw = base64.b64decode(image_b64)
        if clamp_max_side:
            raw = _clamp_image_bytes(raw, clamp_max_side, output_format)
        temporary = out_path.with_name(out_path.name + "." + uuid.uuid4().hex + ".tmp")
        try:
            temporary.write_bytes(raw)
            os.replace(temporary, out_path)
        finally:
            temporary.unlink(missing_ok=True)
        print(f"Wrote {out_path}")

        if downscale_max_dim is None:
            continue

        derived = _derive_downscale_path(out_path, downscale_suffix)
        if derived.exists() and not force:
            _die(f"Output already exists: {derived} (use --force to overwrite)")
        derived.parent.mkdir(parents=True, exist_ok=True)
        resized = _downscale_image_bytes(
            raw, max_dim=downscale_max_dim, output_format=output_format
        )
        derived.write_bytes(resized)
        print(f"Wrote {derived}")



class EditFailure(Exception):
    def __init__(self, code, status=None, cooldown=0, retryable=False, fallback=False):
        super().__init__(code)
        self.code, self.status_code, self.cooldown = code, status, cooldown
        self.retryable, self.fallback = retryable, fallback


def _http_failure(status, body, retry_after=None):
    if status in (401, 402, 403):
        return EditFailure("provider_credentials_or_balance", status, 3600)
    if status == 503 and any(text in body.lower() for text in (
            "no eligible", "no available compatible accounts", "no available accounts")):
        return EditFailure("provider_account_pool_empty", status, 1800, True, True)
    if status in (429, 502, 503, 504):
        delay = max(600, min(3600, int(retry_after))) if str(retry_after).isdigit() else 600
        return EditFailure("provider_unavailable", status, delay, True, True)
    return EditFailure("provider_rejected_request", status)


@contextmanager
def _edit_route(base, model):
    """Share each model's cooldown across image subprocesses. Lease one recovery probe."""
    log = _image_event_log_path()
    if not log:
        yield
        return
    clock = time.time()
    route = hashlib.sha256((base.rstrip("/") + "|" + model).encode()).hexdigest()
    db = None
    probe = False
    try:
        db_path = Path(log).with_name("image-route-health.sqlite3")
        db_path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(db_path, timeout=3, isolation_level=None)
        db.execute("CREATE TABLE IF NOT EXISTS cooldown (route TEXT PRIMARY KEY, until REAL, probe REAL)")
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT until,probe FROM cooldown WHERE route=?", (route,)).fetchone()
        if row and max(row) > clock:
            raise EditFailure("provider_cooldown", retryable=True, fallback=True)
        if row:
            db.execute("UPDATE cooldown SET probe=? WHERE route=?", (clock + 600, route))
            probe = True
        db.execute("COMMIT")
        try:
            yield
        except EditFailure as error:
            if error.cooldown:
                db.execute("""INSERT INTO cooldown VALUES(?, ?, 0)
                    ON CONFLICT(route) DO UPDATE SET until=MAX(cooldown.until, excluded.until), probe=0""",
                           (route, time.time() + error.cooldown))
            elif probe:
                db.execute("DELETE FROM cooldown WHERE route=? AND probe=?", (route, clock + 600))
            raise
        else:
            if probe:
                db.execute("DELETE FROM cooldown WHERE route=? AND probe=?", (route, clock + 600))
    except (OSError, sqlite3.Error):
        raise EditFailure("route_state_unavailable") from None
    finally:
        if db is not None:
            db.close()


def _data_url(file):
    content_type = {".jpg": "jpeg", ".jpeg": "jpeg", ".webp": "webp"}.get(file.suffix.lower(), "png")
    return "data:image/" + content_type + ";base64," + base64.b64encode(file.read_bytes()).decode("ascii")


def _supported_media_url(url, base):
    from urllib.parse import urlsplit, urljoin
    if not isinstance(url, str) or not url:
        raise EditFailure("image_response_missing_bytes")
    base_url = urlsplit(base)
    target = urlsplit(urljoin(base.rstrip("/") + "/", url))
    if (target.scheme != "https" or target.username or target.password or
            target.port not in (None, 443)):
        raise EditFailure("image_media_url_unsupported")
    if target.netloc == base_url.netloc and target.path.startswith("/v1/media/"):
        return target.geturl(), True
    if target.hostname == "imgen.x.ai":
        return target.geturl(), False
    raise EditFailure("image_media_url_unsupported")


def _image_bytes(item, base, key):
    import requests
    encoded = item.get("b64_json")
    if encoded:
        if not isinstance(encoded, str) or len(encoded) > 28 * 1024 * 1024:
            raise EditFailure("image_response_too_large")
        return base64.b64decode(encoded, validate=True)
    url, internal = _supported_media_url(item.get("url"), base)
    try:
        with requests.get(url, headers={"Authorization": "Bearer " + key} if internal else {},
                          timeout=(8, 25), allow_redirects=False, stream=True) as response:
            if response.status_code != 200:
                raise EditFailure("image_media_download_failed", response.status_code)
            raw = bytearray()
            for chunk in response.iter_content(65536):
                raw.extend(chunk)
                if len(raw) > 20 * 1024 * 1024:
                    raise EditFailure("image_response_too_large")
            return bytes(raw)
    except requests.exceptions.Timeout:
        raise EditFailure("image_media_download_timeout") from None
    except requests.exceptions.RequestException:
        raise EditFailure("image_media_download_network_error") from None


def _decode_edit_result(data, n, base, key, output_format, max_side, checkpoint=None):
    from binascii import Error as Base64Error
    from PIL import Image, UnidentifiedImageError
    if not isinstance(data, list) or len(data) != n or not all(isinstance(item, dict) for item in data):
        raise EditFailure("image_response_count_mismatch")
    images = []
    for item in data:
        phase = "read"
        _mark_decode_phase(phase)
        raw = None
        try:
            with _edit_deadline(45):
                raw = _image_bytes(item, base, key)
            phase = "open"
            _mark_decode_phase(phase)
            with Image.open(BytesIO(raw)) as im:
                if im.width * im.height > 20_000_000:
                    raise EditFailure("image_response_dimensions_too_large")
                phase = "load"
                _mark_decode_phase(phase)
                im.load()
                if checkpoint is not None:
                    phase = "checkpoint"
                    _mark_decode_phase(phase)
                    pending = checkpoint.with_suffix(".tmp")
                    pending.write_bytes(raw)
                    pending.replace(checkpoint)
                    continue  # The trip worker normalizes this source directly to JPEG.
                phase = "convert"
                _mark_decode_phase(phase)
                if output_format == "jpeg":
                    im = im.convert("RGB")
                if max_side:
                    im.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
                out = BytesIO()
                phase = "encode"
                _mark_decode_phase(phase)
                im.save(out, format={"png": "PNG", "jpeg": "JPEG", "webp": "WEBP"}[output_format])
                images.append(base64.b64encode(out.getvalue()).decode("ascii"))
        except Exception as cause:
            if isinstance(cause, EditFailure):
                error = cause
            elif isinstance(cause, (Base64Error, UnidentifiedImageError)):
                error = EditFailure("image_response_invalid_image", fallback=True)
            elif isinstance(cause, TimeoutError):
                error = EditFailure("image_media_download_timeout")
            else:
                error = EditFailure("image_response_decode_failed")
            error.evidence = {"phase": phase, "causeType": type(cause).__name__}
            if raw is not None:
                error.evidence["responseBytes"] = len(raw)
            errno = getattr(cause, "errno", None)
            if isinstance(errno, int):
                error.evidence["errno"] = errno
            raise error from None
    return images


def _edit_payload(model, prompt, size, image_paths, n, background=None, mask=None, output_format="png"):
    if mask or background == "transparent":
        raise EditFailure("route_does_not_support_mask_or_transparency")
    if model == "muse-image":
        if len(image_paths) > 4 or n != 1:
            raise EditFailure("muse_reference_or_count_unsupported")
        if (any(p.stat().st_size > 40 * 1024 * 1024 for p in image_paths) or
                sum(p.stat().st_size for p in image_paths) > 100 * 1024 * 1024):
            raise EditFailure("muse_reference_too_large")
        payload = {"model": model, "prompt": prompt, "size": MUSE_SIZES.get(size, size),
                   "response_format": "b64_json"}
        if image_paths:
            payload["images"] = [_data_url(file) for file in image_paths]
        return payload
    if not model.startswith("grok-imagine-image") or len(image_paths) > 3:
        raise EditFailure("fallback_model_or_reference_unsupported")
    # Production uses Muse first and Grok Image 2.0 as the application fallback.
    # Grok uses the gateway's main credentials. This gateway route is separate
    # from the application's model order. Inline delivery passed on 2026-11-15.
    aspect = {"1536x1024": "3:2", "1024x1536": "2:3"}.get(size, "1:1")
    payload = {"model": model, "prompt": prompt, "resolution": "1k",
               "quality": "medium", "aspect_ratio": aspect, "n": n}
    if model == "grok-imagine-image-2.0":
        # xAI's JSON edit API supports inline bytes. The relay may still
        # return a URL, which remains subject to the existing download rules.
        payload["response_format"] = "b64_json"
    if image_paths:
        payload["images"] = [{"image_url": _data_url(file)} for file in image_paths]
    return payload


def _json_image_request(base, key, endpoint, payload, seconds):
    import requests
    with requests.post(base.rstrip("/") + endpoint, json=payload,
                       headers={"Authorization": "Bearer " + key},
                       timeout=(10, seconds), allow_redirects=False, stream=True) as response:
        _capture_edit_response(response)
        if response.status_code != 200:
            body = next(response.iter_content(8192), b"").decode("utf-8", "replace")
            raise _http_failure(response.status_code, body, response.headers.get("Retry-After"))
        body = bytearray()
        for part in response.iter_content(65536):
            body.extend(part)
            if len(body) > 120 * 1024 * 1024:
                raise EditFailure("image_response_too_large")
        try:
            return json.loads(body).get("data")
        except (ValueError, AttributeError):
            raise EditFailure("image_response_invalid_json") from None


def _fallback_images(prompt, image_paths, output_format, n, background=None, mask=None):
    key, base = os.getenv("PET_IMAGE_FALLBACK_KEY"), os.getenv("PET_IMAGE_FALLBACK_BASE_URL")
    if not key or not base:
        raise EditFailure("fallback_not_configured")
    payload = _edit_payload(FALLBACK_MODEL, prompt, "1024x1024", image_paths, n, background, mask)
    seconds = EDIT_TIMEOUT if FALLBACK_MODEL == "muse-image" else FALLBACK_TIMEOUT
    with _edit_deadline(seconds):
        data = _json_image_request(base, key, "/images/edits" if image_paths else "/images/generations",
                                   payload, seconds)
        return _decode_edit_result(data, n, base, key, output_format, 1024)


def _create_client():
    try:
        from openai import OpenAI
    except ImportError:
        _die(
            f"openai SDK not installed in the active environment. {_dependency_hint('openai')}"
        )
    return OpenAI(timeout=300.0, max_retries=0)


def _create_async_client():
    try:
        from openai import AsyncOpenAI
    except ImportError:
        try:
            import openai as _openai  # noqa: F401
        except ImportError:
            _die(
                f"openai SDK not installed in the active environment. {_dependency_hint('openai')}"
            )
        _die(
            "AsyncOpenAI not available in this openai SDK version. "
            f"{_dependency_hint('openai', upgrade=True)}"
        )
    return AsyncOpenAI()


def _slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = re.sub(r"-{2,}", "-", value).strip("-")
    return value[:60] if value else "job"


def _normalize_job(job: Any, idx: int) -> Dict[str, Any]:
    if isinstance(job, str):
        prompt = job.strip()
        if not prompt:
            _die(f"Empty prompt at job {idx}")
        return {"prompt": prompt}
    if isinstance(job, dict):
        if "prompt" not in job or not str(job["prompt"]).strip():
            _die(f"Missing prompt for job {idx}")
        return job
    _die(f"Invalid job at index {idx}: expected string or object.")
    return {}  # unreachable


def _read_jobs_jsonl(path: str) -> List[Dict[str, Any]]:
    p = Path(path)
    if not p.exists():
        _die(f"Input file not found: {p}")
    jobs: List[Dict[str, Any]] = []
    for line_no, raw in enumerate(p.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        try:
            item: Any
            if line.startswith("{"):
                item = json.loads(line)
            else:
                item = line
            jobs.append(_normalize_job(item, idx=line_no))
        except json.JSONDecodeError as exc:
            _die(f"Invalid JSON on line {line_no}: {exc}")
    if not jobs:
        _die("No jobs found in input file.")
    if len(jobs) > MAX_BATCH_JOBS:
        _die(f"Too many jobs ({len(jobs)}). Max is {MAX_BATCH_JOBS}.")
    return jobs


def _merge_non_null(dst: Dict[str, Any], src: Dict[str, Any]) -> Dict[str, Any]:
    merged = dict(dst)
    for k, v in src.items():
        if v is not None:
            merged[k] = v
    return merged


def _job_output_paths(
    *,
    out_dir: Path,
    output_format: str,
    idx: int,
    prompt: str,
    n: int,
    explicit_out: Optional[str],
) -> List[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    ext = "." + output_format

    if explicit_out:
        base = Path(explicit_out)
        if base.suffix == "":
            base = base.with_suffix(ext)
        elif base.suffix.lstrip(".").lower() != output_format:
            _warn(
                f"Job {idx}: output extension {base.suffix} does not match output-format {output_format}."
            )
        base = out_dir / base.name
    else:
        slug = _slugify(prompt[:80])
        base = out_dir / f"{idx:03d}-{slug}{ext}"

    if n == 1:
        return [base]
    return [base.with_name(f"{base.stem}-{i}{base.suffix}") for i in range(1, n + 1)]


def _extract_retry_after_seconds(exc: Exception) -> Optional[float]:
    # Best-effort: openai SDK errors vary by version. Prefer a conservative fallback.
    for attr in ("retry_after", "retry_after_seconds"):
        val = getattr(exc, attr, None)
        if isinstance(val, (int, float)) and val >= 0:
            return float(val)
    msg = str(exc)
    m = re.search(r"retry[- ]after[:= ]+([0-9]+(?:\\.[0-9]+)?)", msg, re.IGNORECASE)
    if m:
        try:
            return float(m.group(1))
        except Exception:
            return None
    return None


def _is_rate_limit_error(exc: Exception) -> bool:
    name = exc.__class__.__name__.lower()
    if "ratelimit" in name or "rate_limit" in name:
        return True
    msg = str(exc).lower()
    return "429" in msg or "rate limit" in msg or "too many requests" in msg


def _is_transient_error(exc: Exception) -> bool:
    if _is_rate_limit_error(exc):
        return True
    name = exc.__class__.__name__.lower()
    if "timeout" in name or "timedout" in name or "tempor" in name:
        return True
    msg = str(exc).lower()
    return "timeout" in msg or "timed out" in msg or "connection reset" in msg


async def _generate_one_with_retries(
    client: Any,
    payload: Dict[str, Any],
    *,
    attempts: int,
    job_label: str,
) -> Any:
    last_exc: Optional[Exception] = None
    for attempt in range(1, attempts + 1):
        try:
            return await client.images.generate(**payload)
        except Exception as exc:
            last_exc = exc
            if not _is_transient_error(exc):
                raise
            if attempt == attempts:
                raise
            sleep_s = _extract_retry_after_seconds(exc)
            if sleep_s is None:
                sleep_s = min(60.0, 2.0**attempt)
            print(
                f"{job_label} attempt {attempt}/{attempts} failed ({exc.__class__.__name__}); retrying in {sleep_s:.1f}s",
                file=sys.stderr,
            )
            await asyncio.sleep(sleep_s)
    raise last_exc or RuntimeError("unknown error")


async def _run_generate_batch(args: argparse.Namespace) -> int:
    jobs = _read_jobs_jsonl(args.input)
    out_dir = Path(args.out_dir)

    base_fields = _fields_from_args(args)
    base_payload = {
        "model": args.model,
        "n": args.n,
        "size": args.size,
        "quality": args.quality,
        "background": args.background,
        "output_format": args.output_format,
        "output_compression": args.output_compression,
        "moderation": args.moderation,
    }

    if args.dry_run:
        for i, job in enumerate(jobs, start=1):
            prompt = str(job["prompt"]).strip()
            fields = _merge_non_null(base_fields, job.get("fields", {}))
            # Allow flat job keys as well (use_case, scene, etc.)
            fields = _merge_non_null(
                fields, {k: job.get(k) for k in base_fields.keys()}
            )
            augmented = _augment_prompt_fields(args.augment, prompt, fields)

            job_payload = dict(base_payload)
            job_payload["prompt"] = augmented
            job_payload = _merge_non_null(
                job_payload, {k: job.get(k) for k in base_payload.keys()}
            )
            job_payload = {k: v for k, v in job_payload.items() if v is not None}

            _validate_generate_payload(job_payload)
            effective_output_format = _normalize_output_format(
                job_payload.get("output_format")
            )
            _validate_transparency(
                job_payload.get("background"), effective_output_format
            )
            job_payload["output_format"] = effective_output_format

            n = int(job_payload.get("n", 1))
            outputs = _job_output_paths(
                out_dir=out_dir,
                output_format=effective_output_format,
                idx=i,
                prompt=prompt,
                n=n,
                explicit_out=job.get("out"),
            )
            downscaled = None
            if args.downscale_max_dim is not None:
                downscaled = [
                    str(_derive_downscale_path(p, args.downscale_suffix))
                    for p in outputs
                ]
            _print_request(
                {
                    "endpoint": "/v1/images/generations",
                    "job": i,
                    "outputs": [str(p) for p in outputs],
                    "outputs_downscaled": downscaled,
                    **job_payload,
                }
            )
        return 0

    client = _create_async_client()
    sem = asyncio.Semaphore(args.concurrency)

    any_failed = False

    async def run_job(i: int, job: Dict[str, Any]) -> Tuple[int, Optional[str]]:
        nonlocal any_failed
        prompt = str(job["prompt"]).strip()
        job_label = f"[job {i}/{len(jobs)}]"

        fields = _merge_non_null(base_fields, job.get("fields", {}))
        fields = _merge_non_null(fields, {k: job.get(k) for k in base_fields.keys()})
        augmented = _augment_prompt_fields(args.augment, prompt, fields)

        payload = dict(base_payload)
        payload["prompt"] = augmented
        payload = _merge_non_null(payload, {k: job.get(k) for k in base_payload.keys()})
        payload = {k: v for k, v in payload.items() if v is not None}

        n = int(payload.get("n", 1))
        _validate_generate_payload(payload)
        effective_output_format = _normalize_output_format(payload.get("output_format"))
        _validate_transparency(payload.get("background"), effective_output_format)
        payload["output_format"] = effective_output_format
        outputs = _job_output_paths(
            out_dir=out_dir,
            output_format=effective_output_format,
            idx=i,
            prompt=prompt,
            n=n,
            explicit_out=job.get("out"),
        )
        try:
            async with sem:
                print(f"{job_label} starting", file=sys.stderr)
                started = time.time()
                result = await _generate_one_with_retries(
                    client,
                    payload,
                    attempts=args.max_attempts,
                    job_label=job_label,
                )
                elapsed = time.time() - started
                print(f"{job_label} completed in {elapsed:.1f}s", file=sys.stderr)
            images = [item.b64_json for item in result.data]
            _decode_write_and_downscale(
                images,
                outputs,
                force=args.force,
                downscale_max_dim=args.downscale_max_dim,
                downscale_suffix=args.downscale_suffix,
                output_format=effective_output_format,
                clamp_max_side=_max_side_limit(args.max_side, args.size),
            )
            return i, None
        except Exception as exc:
            any_failed = True
            print(f"{job_label} failed: {exc}", file=sys.stderr)
            if args.fail_fast:
                raise
            return i, str(exc)

    tasks = [
        asyncio.create_task(run_job(i, job)) for i, job in enumerate(jobs, start=1)
    ]

    try:
        await asyncio.gather(*tasks)
    except Exception:
        for t in tasks:
            if not t.done():
                t.cancel()
        raise

    return 1 if any_failed else 0


def _generate_batch(args: argparse.Namespace) -> None:
    exit_code = asyncio.run(_run_generate_batch(args))
    if exit_code:
        raise SystemExit(exit_code)


def _generate(args: argparse.Namespace) -> None:
    prompt = _read_prompt(args.prompt, args.prompt_file)
    prompt = _augment_prompt(args, prompt)

    payload = {
        "model": args.model,
        "prompt": prompt,
        "n": args.n,
        "size": args.size,
        "quality": args.quality,
        "background": args.background,
        "output_format": args.output_format,
        "output_compression": args.output_compression,
        "moderation": args.moderation,
    }
    payload = {k: v for k, v in payload.items() if v is not None}

    output_format = _normalize_output_format(args.output_format)
    _validate_transparency(args.background, output_format)
    payload["output_format"] = output_format
    # 中转站的 muse-image 默认只返回 url（该地址取不到图），必须显式要 b64_json 内联。
    if "muse" in str(args.model).lower():
        payload["response_format"] = "b64_json"
    output_paths = _build_output_paths(args.out, output_format, args.n, args.out_dir)
    downscaled = None
    if args.downscale_max_dim is not None:
        downscaled = [
            str(_derive_downscale_path(p, args.downscale_suffix)) for p in output_paths
        ]

    if args.dry_run:
        _print_request(
            {
                "endpoint": "/v1/images/generations",
                "outputs": [str(p) for p in output_paths],
                "outputs_downscaled": downscaled,
                **payload,
            }
        )
        return

    print(
        "Calling Image API (generation). This can take up to a couple of minutes.",
        file=sys.stderr,
    )
    started = time.time()
    client = _create_client()
    try:
        result = client.images.generate(**payload)
        images = [item.b64_json for item in result.data]
        if len(images)!=args.n or any(not item for item in images):
            urls=[getattr(x,"url",None) for x in result.data]
            raise RuntimeError("主图片服务未返回完整图片(b64 为空; url=%s)"%(urls[0] if urls else None))
        from PIL import Image
        for item in images:
            with Image.open(BytesIO(base64.b64decode(item,validate=True))) as im: im.verify()
    except Exception as primary:
        print("Primary image generation failed; trying fallback:", type(primary).__name__, file=sys.stderr)
        images = _fallback_images(prompt, [], output_format, args.n, args.background)
    elapsed = time.time() - started
    print(f"Generation completed in {elapsed:.1f}s.", file=sys.stderr)

    _decode_write_and_downscale(
        images,
        output_paths,
        force=args.force,
        downscale_max_dim=args.downscale_max_dim,
        downscale_suffix=args.downscale_suffix,
        output_format=output_format,
        clamp_max_side=_max_side_limit(args.max_side, args.size),
    )


def _edit(args: argparse.Namespace) -> None:
    prompt = _read_prompt(args.prompt, args.prompt_file)
    prompt = _augment_prompt(args, prompt)

    image_paths = _check_image_paths(args.image)
    mask_path = Path(args.mask) if args.mask else None
    if mask_path:
        if not mask_path.exists():
            _die(f"Mask file not found: {mask_path}")
        if mask_path.suffix.lower() != ".png":
            _warn(f"Mask should be a PNG with an alpha channel: {mask_path}")
        if mask_path.stat().st_size > MAX_IMAGE_BYTES:
            _warn(f"Mask exceeds 50MB limit: {mask_path}")

    payload = {
        "model": args.model,
        "prompt": prompt,
        "n": args.n,
        "size": args.size,
        "quality": args.quality,
        "background": args.background,
        "output_format": args.output_format,
        "output_compression": args.output_compression,
        "input_fidelity": args.input_fidelity,
        "moderation": args.moderation,
    }
    payload = {k: v for k, v in payload.items() if v is not None}

    output_format = _normalize_output_format(args.output_format)
    _validate_transparency(args.background, output_format)
    payload["output_format"] = output_format
    # 中转站的 muse-image 默认只返回 url（该地址取不到图），必须显式要 b64_json 内联。
    if "muse" in str(args.model).lower():
        payload["response_format"] = "b64_json"
    _validate_input_fidelity(args.input_fidelity)
    output_paths = _build_output_paths(args.out, output_format, args.n, args.out_dir)
    base = os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1"
    key = os.getenv("OPENAI_API_KEY", "")
    json_edit = args.model == "muse-image" or args.model.startswith("grok-imagine-image")
    try:
        selected = (_edit_payload(args.model, prompt, args.size, image_paths, args.n,
                                  args.background, mask_path) if json_edit else payload)
    except EditFailure as error:
        _die("Image edit failed: " + error.code)
    if args.dry_run:
        print_preview = dict(selected)
        if json_edit:
            print_preview["images"] = [str(file) for file in image_paths]
        else:
            print_preview["image"] = [str(file) for file in image_paths]
        _print_request({"endpoint": "/v1/images/edits", "outputs": [str(p) for p in output_paths],
                        **print_preview})
        return

    try:
        import requests  # noqa: F401
        from PIL import Image  # noqa: F401
    except ImportError:
        _die("Image edit dependencies missing; install scripts/image-requirements.txt.")
    # Never start a paid request if the expected destination already exists.
    if not args.force and any(file.exists() for file in output_paths):
        _die("Image output already exists.")
    _IMAGE_EVENT_CONTEXT.clear()
    _IMAGE_EVENT_CONTEXT.update(op="edit", size=str(args.size), quality=args.quality,
                                output=output_paths[0].name, job=output_paths[0].parent.name,
                                jobScope=output_paths[0].parent.parent.name, inputs=len(image_paths))
    marker_setting = os.environ.get("PET_IMAGE_JOB_MARKER")
    marker = Path(marker_setting) if marker_setting else None
    max_side = _max_side_limit(args.max_side, args.size)

    raw_path = os.getenv("PET_IMAGE_VALIDATED_SOURCE") if args.n == 1 else None
    checkpoint = Path(raw_path) if raw_path else None

    def request(provider, model, route_base, route_key, seconds, send):
        _IMAGE_EVENT_CONTEXT.update(model=model, provider=provider)
        started = time.monotonic()
        for field in ("httpStatus", "upstreamRequestId"):
            _IMAGE_EVENT_CONTEXT.pop(field, None)
        try:
            with _edit_route(route_base, model):
                if marker:
                    marker.write_text("submitted\n", encoding="ascii")
                _edit_event(provider, "started", started)
                try:
                    with _edit_deadline(seconds):
                        data = send()
                    _edit_event(provider, "response", started)
                    return started, _decode_edit_result(data, args.n, route_base, route_key,
                                                        output_format, max_side, checkpoint)
                except EditFailure as error:
                    if error.code.startswith(("image_response_", "image_media_")):
                        error.cooldown = 600
                    if error.status_code and not error.code.startswith(("image_response_", "image_media_")) and marker:
                        marker.unlink(missing_ok=True)
                    raise
                except Exception as cause:
                    status = getattr(cause, "status_code", None)
                    if isinstance(status, int):
                        response = getattr(cause, "response", None)
                        if response is not None:
                            _capture_edit_response(response)
                        error = _http_failure(status, str(cause), response.headers.get("Retry-After") if response is not None else None)
                        if marker:
                            marker.unlink(missing_ok=True)
                        raise error from None
                    name = type(cause).__name__.lower()
                    error = EditFailure("image_request_timeout_unknown" if "timeout" in name
                                        else "image_request_outcome_unknown", cooldown=600)
                    error.evidence = {"phase": "request", "causeType": type(cause).__name__}
                    raise error from None
        except EditFailure as error:
            _edit_event(provider, "failed", started, error)
            raise

    def send_primary():
        if json_edit:
            return _json_image_request(base, key, "/images/edits", selected, EDIT_TIMEOUT)
        client = _create_client()
        with _open_files(image_paths) as image_files, _open_mask(mask_path) as mask_file:
            query = dict(selected, image=image_files if len(image_files) > 1 else image_files[0])
            if mask_file is not None:
                query["mask"] = mask_file
            result = client.images.edit(**query)
            request_id = getattr(result, "_request_id", None)
            if isinstance(request_id, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", request_id):
                _IMAGE_EVENT_CONTEXT["upstreamRequestId"] = request_id
            return [item.model_dump() for item in result.data]

    provider = "primary"
    wall_started = time.monotonic()
    try:
        started, images = request(provider, args.model, base, key, EDIT_TIMEOUT, send_primary)
    except EditFailure as primary:
        backup_base, backup_key = os.getenv("PET_IMAGE_FALLBACK_BASE_URL"), os.getenv("PET_IMAGE_FALLBACK_KEY")
        if (not primary.fallback
                or (primary.code == "image_response_invalid_image" and args.model != "muse-image")
                or not backup_base or not backup_key) or (
                args.model == FALLBACK_MODEL and base.rstrip("/") == backup_base.rstrip("/")):
            _die("Image edit failed: " + primary.code)
        try:
            backup = _edit_payload(FALLBACK_MODEL, prompt, args.size, image_paths, args.n,
                                   args.background, mask_path)
        except EditFailure:
            _die("Image edit failed: " + primary.code)
        # Keep the same overall deadline when switching from Grok to Muse.
        route_limit = EDIT_TIMEOUT if FALLBACK_MODEL == "muse-image" else FALLBACK_TIMEOUT
        remaining = int(EDIT_TIMEOUT + FALLBACK_TIMEOUT - (time.monotonic() - wall_started))
        seconds = min(route_limit, remaining)
        if seconds <= 0:
            _die("Image edit failed: " + primary.code)
        provider = "fallback"
        try:
            started, images = request(provider, FALLBACK_MODEL, backup_base, backup_key, seconds,
                lambda: _json_image_request(backup_base, backup_key, "/images/edits", backup, seconds))
        except EditFailure as error:
            _die("Image edit failed: " + error.code)

    try:
        if checkpoint is None:
            _decode_write_and_downscale(
                images, output_paths, force=args.force, downscale_max_dim=args.downscale_max_dim,
                downscale_suffix=args.downscale_suffix, output_format=output_format,
            )
        if marker:
            marker.unlink(missing_ok=True)
    except Exception:
        _edit_event(provider, "failed", started, EditFailure("image_output_save_failed"))
        raise
    _edit_event(provider, "done", started)


def _open_files(paths: List[Path]):
    return _FileBundle(paths)


def _open_mask(mask_path: Optional[Path]):
    if mask_path is None:
        return _NullContext()
    return _SingleFile(mask_path)


class _NullContext:
    def __enter__(self):
        return None

    def __exit__(self, exc_type, exc, tb):
        return False


class _SingleFile:
    def __init__(self, path: Path):
        self._path = path
        self._handle = None

    def __enter__(self):
        self._handle = self._path.open("rb")
        return self._handle

    def __exit__(self, exc_type, exc, tb):
        if self._handle:
            try:
                self._handle.close()
            except Exception:
                pass
        return False


class _FileBundle:
    def __init__(self, paths: List[Path]):
        self._paths = paths
        self._handles: List[object] = []

    def __enter__(self):
        self._handles = [p.open("rb") for p in self._paths]
        return self._handles

    def __exit__(self, exc_type, exc, tb):
        for handle in self._handles:
            try:
                handle.close()
            except Exception:
                pass
        return False


def _add_shared_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--prompt")
    parser.add_argument("--prompt-file")
    parser.add_argument("--n", type=int, default=1)
    parser.add_argument("--size", default=DEFAULT_SIZE)
    parser.add_argument("--max-side", type=int, help="输出最长边上限，缺省跟随 --size；上游回更大的图会原地缩回该尺寸")
    parser.add_argument("--quality", default=DEFAULT_QUALITY)
    parser.add_argument("--background")
    parser.add_argument("--output-format")
    parser.add_argument("--output-compression", type=int)
    parser.add_argument("--moderation")
    parser.add_argument("--out", default=DEFAULT_OUTPUT_PATH)
    parser.add_argument("--out-dir")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--augment", dest="augment", action="store_true")
    parser.add_argument("--no-augment", dest="augment", action="store_false")
    parser.set_defaults(augment=True)

    # Prompt augmentation hints
    parser.add_argument("--use-case")
    parser.add_argument("--scene")
    parser.add_argument("--subject")
    parser.add_argument("--style")
    parser.add_argument("--composition")
    parser.add_argument("--lighting")
    parser.add_argument("--palette")
    parser.add_argument("--materials")
    parser.add_argument("--text")
    parser.add_argument("--constraints")
    parser.add_argument("--negative")

    # Post-processing (optional): generate an additional downscaled copy for fast web loading.
    parser.add_argument("--downscale-max-dim", type=int)
    parser.add_argument("--downscale-suffix", default=DEFAULT_DOWNSCALE_SUFFIX)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fallback CLI for explicit image generation or editing via GPT Image models"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    gen_parser = subparsers.add_parser("generate", help="Create a new image")
    _add_shared_args(gen_parser)
    gen_parser.set_defaults(func=_generate)

    batch_parser = subparsers.add_parser(
        "generate-batch",
        help="Generate multiple prompts concurrently (JSONL input)",
    )
    _add_shared_args(batch_parser)
    batch_parser.add_argument(
        "--input", required=True, help="Path to JSONL file (one job per line)"
    )
    batch_parser.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY)
    batch_parser.add_argument("--max-attempts", type=int, default=3)
    batch_parser.add_argument("--fail-fast", action="store_true")
    batch_parser.set_defaults(func=_generate_batch)

    edit_parser = subparsers.add_parser("edit", help="Edit an existing image")
    _add_shared_args(edit_parser)
    edit_parser.add_argument("--image", action="append", required=True)
    edit_parser.add_argument("--mask")
    edit_parser.add_argument("--input-fidelity")
    edit_parser.set_defaults(func=_edit)

    args = parser.parse_args()
    if args.n < 1 or args.n > 10:
        _die("--n must be between 1 and 10")
    if getattr(args, "concurrency", 1) < 1 or getattr(args, "concurrency", 1) > 25:
        _die("--concurrency must be between 1 and 25")
    if getattr(args, "max_attempts", 3) < 1 or getattr(args, "max_attempts", 3) > 10:
        _die("--max-attempts must be between 1 and 10")
    if args.output_compression is not None and not (
        0 <= args.output_compression <= 100
    ):
        _die("--output-compression must be between 0 and 100")
    if args.command == "generate-batch" and not args.out_dir:
        _die("generate-batch requires --out-dir")
    if (
        getattr(args, "downscale_max_dim", None) is not None
        and args.downscale_max_dim < 1
    ):
        _die("--downscale-max-dim must be >= 1")

    _validate_model(args.model)
    _validate_size(args.size, args.model)
    _validate_quality(args.quality)
    _validate_background(args.background)
    _validate_model_specific_options(
        model=args.model,
        background=args.background,
        input_fidelity=getattr(args, "input_fidelity", None),
    )
    _ensure_api_key(args.dry_run)

    args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
