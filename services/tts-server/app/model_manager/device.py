"""Lazy device selection without importing torch during app startup."""

from __future__ import annotations

import importlib

from app.errors import UnsupportedDeviceError


def select_device(preference: str, supported: tuple[str, ...]) -> str:
    preference = preference.lower().strip()
    if preference not in {"auto", "cpu", "cuda", "mps"}:
        raise UnsupportedDeviceError(f"unsupported device preference: {preference}")

    if preference != "auto":
        if preference not in supported:
            raise UnsupportedDeviceError(
                f"device {preference!r} is not supported by this provider; supported: {', '.join(supported)}"
            )
        if preference == "cpu":
            return "cpu"
        torch = _import_torch()
        if preference == "cuda" and not torch.cuda.is_available():
            raise UnsupportedDeviceError("CUDA was requested but torch.cuda.is_available() is false")
        if preference == "mps" and not _mps_available(torch):
            raise UnsupportedDeviceError("MPS was requested but torch.backends.mps.is_available() is false")
        return preference

    if supported == ("cpu",):
        return "cpu"

    torch = _import_torch()
    if "cuda" in supported and torch.cuda.is_available():
        return "cuda"
    if "mps" in supported and _mps_available(torch):
        return "mps"
    if "cpu" in supported:
        return "cpu"
    raise UnsupportedDeviceError(
        f"no supported accelerator is available; provider supports: {', '.join(supported)}"
    )


def _import_torch():
    try:
        return importlib.import_module("torch")
    except (ImportError, OSError) as exc:
        raise UnsupportedDeviceError("PyTorch could not be imported for device discovery") from exc


def _mps_available(torch: object) -> bool:
    backends = getattr(torch, "backends", None)
    mps = getattr(backends, "mps", None)
    check = getattr(mps, "is_available", None)
    return bool(check and check())
