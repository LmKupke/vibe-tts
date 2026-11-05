"""Provider contract independent of FastAPI and model frameworks."""

from __future__ import annotations

import importlib.util
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from app.schemas import AlignmentEntry, ProviderCapabilities, SpeechRequest, Voice


@dataclass(slots=True)
class RawSynthesisResult:
    audio: bytes
    mime_type: str
    duration_ms: float
    native_alignment: list[AlignmentEntry] | None = None
    diagnostics: dict[str, Any] = field(default_factory=dict)


class TTSBackend(ABC):
    id: str
    name: str
    dependency_modules: tuple[str, ...] = ()
    supported_devices: tuple[str, ...] = ("cpu",)
    model_id: str | None = None
    enabled: bool = True
    may_download: bool = False
    ready_without_load: bool = False
    # Qwen is only considered runtime-available after a decoded waveform has
    # actually been produced. Lightweight/mock implementations can opt in.
    validated_on_load: bool = False

    def dependencies_installed(self) -> bool:
        for module in self.dependency_modules:
            try:
                if importlib.util.find_spec(module) is None:
                    return False
            except (ImportError, AttributeError, ValueError):
                return False
        return True

    def preflight_error(self, device_preference: str) -> str | None:
        """Return why this backend cannot be selected without loading weights.

        Implementations use this for configuration and accelerator checks that
        are safe to perform during provider discovery. Returning a message
        keeps an enabled provider visible while ensuring ``selectable`` never
        promises that an impossible load can succeed.
        """

        del device_preference
        return None

    @abstractmethod
    def capabilities(self) -> ProviderCapabilities:
        raise NotImplementedError

    @abstractmethod
    def voices(self) -> list[Voice]:
        raise NotImplementedError

    @abstractmethod
    def load(self, device: str) -> None:
        raise NotImplementedError

    @abstractmethod
    def unload(self) -> None:
        raise NotImplementedError

    @abstractmethod
    def synthesize(self, request: SpeechRequest) -> RawSynthesisResult:
        raise NotImplementedError


class BaseBackend(TTSBackend):
    """Convenience base with a conservative unloaded implementation."""

    def __init__(self, *, enabled: bool = True) -> None:
        self.enabled = enabled
        self.device: str | None = None

    def load(self, device: str) -> None:
        self.device = device

    def unload(self) -> None:
        self.device = None
