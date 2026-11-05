"""Registry reserved for real forced aligners when one is justified."""

from __future__ import annotations

from collections.abc import Iterable

from app.alignment.base import AlignmentProvider
from app.errors import AlignmentUnavailableError


class AlignmentRegistry:
    def __init__(self, providers: Iterable[AlignmentProvider] = ()) -> None:
        self._providers: dict[str, AlignmentProvider] = {}
        for provider in providers:
            self.register(provider)

    def register(self, provider: AlignmentProvider) -> None:
        if provider.id in self._providers:
            raise ValueError(f"alignment provider {provider.id!r} is already registered")
        self._providers[provider.id] = provider

    def get(self, provider_id: str) -> AlignmentProvider:
        try:
            return self._providers[provider_id]
        except KeyError as exc:
            raise AlignmentUnavailableError(f"unknown alignment provider: {provider_id}") from exc

    def all(self) -> list[AlignmentProvider]:
        return list(self._providers.values())
