"""Speech backend registry."""

from __future__ import annotations

from collections.abc import Iterable

from app.errors import ProviderNotFoundError
from app.providers.base import TTSBackend


class TTSRegistry:
    def __init__(self, providers: Iterable[TTSBackend] = ()) -> None:
        self._providers: dict[str, TTSBackend] = {}
        for provider in providers:
            self.register(provider)

    def register(self, provider: TTSBackend) -> None:
        if provider.id in self._providers:
            raise ValueError(f"provider {provider.id!r} is already registered")
        self._providers[provider.id] = provider

    def get(self, provider_id: str) -> TTSBackend:
        try:
            return self._providers[provider_id]
        except KeyError as exc:
            raise ProviderNotFoundError(f"unknown TTS provider: {provider_id}") from exc

    def all(self) -> list[TTSBackend]:
        return list(self._providers.values())
