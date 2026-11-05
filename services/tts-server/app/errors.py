"""Typed service errors used at architecture boundaries."""

from __future__ import annotations

from typing import Any


class TTSError(Exception):
    """Base class for expected service failures."""


class ProviderNotFoundError(TTSError):
    pass


class ProviderUnavailableError(TTSError):
    pass


class ProviderConfigurationError(ProviderUnavailableError):
    pass


class UnsupportedDeviceError(ProviderUnavailableError):
    pass


class ProviderLoadError(ProviderUnavailableError):
    pass


class ProviderSynthesisError(TTSError):
    pass


class AlignmentUnavailableError(TTSError):
    pass


class AlignmentValidationError(TTSError):
    pass


class NativeAlignmentError(AlignmentValidationError):
    """TADA metadata could not be safely mapped to source characters."""

    def __init__(self, message: str, diagnostics: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.diagnostics = diagnostics or {}
