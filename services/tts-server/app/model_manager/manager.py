"""Concurrency-safe lazy model lifecycle management."""

from __future__ import annotations

import asyncio
import contextlib
import os
from dataclasses import dataclass, field
from datetime import UTC, datetime

from app.errors import ProviderLoadError, ProviderUnavailableError
from app.model_manager.device import select_device
from app.providers.base import RawSynthesisResult, TTSBackend
from app.providers.registry import TTSRegistry
from app.schemas import ModelState, ProviderInfo, SpeechRequest


@dataclass(slots=True)
class _ManagedProvider:
    backend: TTSBackend
    state: ModelState
    lifecycle_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    generation_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    device: str | None = None
    error: str | None = None
    loaded_at: datetime | None = None


class ModelManager:
    def __init__(self, registry: TTSRegistry, *, device_preference: str = "auto") -> None:
        self.registry = registry
        self.device_preference = device_preference
        self._entries: dict[str, _ManagedProvider] = {}
        for backend in registry.all():
            if not backend.enabled:
                state = ModelState.DISABLED
            elif not backend.dependencies_installed():
                state = ModelState.NOT_INSTALLED
            elif backend.ready_without_load:
                backend.load("cpu")
                state = ModelState.READY
            else:
                state = ModelState.UNLOADED
            self._entries[backend.id] = _ManagedProvider(
                backend=backend,
                state=state,
                device="cpu" if backend.ready_without_load and state == ModelState.READY else None,
            )

    def _entry(self, provider_id: str) -> _ManagedProvider:
        # Registry owns the canonical not-found error.
        self.registry.get(provider_id)
        return self._entries[provider_id]

    def snapshot(self, provider_id: str) -> ProviderInfo:
        entry = self._entry(provider_id)
        backend = entry.backend
        installed = backend.dependencies_installed()
        preflight_error = (
            backend.preflight_error(self.device_preference) if backend.enabled and installed else None
        )
        loadable = (
            backend.enabled
            and installed
            and preflight_error is None
            and entry.state not in {ModelState.ERROR}
        )
        return ProviderInfo(
            id=backend.id,
            name=backend.name,
            local=True,
            enabled=backend.enabled,
            installed=installed,
            loadable=loadable,
            selectable=loadable,
            # "available" is deliberately stricter than "selectable": Qwen is
            # only operational after a real waveform/decode smoke test. Lazy
            # unloaded providers remain discoverable via selectable + state.
            available=entry.state == ModelState.READY and preflight_error is None,
            state=entry.state,
            model=backend.model_id,
            device=entry.device,
            error=entry.error or preflight_error,
            capabilities=backend.capabilities(),
        )

    def snapshots(self) -> list[ProviderInfo]:
        return [self.snapshot(backend.id) for backend in self.registry.all()]

    async def ensure_loaded(self, provider_id: str, *, retry: bool = False) -> TTSBackend:
        entry = self._entry(provider_id)
        backend = entry.backend
        if not backend.enabled:
            raise ProviderUnavailableError(f"provider {provider_id!r} is disabled")
        if not backend.dependencies_installed():
            entry.state = ModelState.NOT_INSTALLED
            raise ProviderUnavailableError(
                f"provider {provider_id!r} is not installed; install its optional dependency extra"
            )
        preflight_error = backend.preflight_error(self.device_preference)
        if preflight_error is not None:
            raise ProviderUnavailableError(f"provider {provider_id!r} is not selectable: {preflight_error}")

        async with entry.lifecycle_lock:
            if entry.state in {ModelState.LOADED, ModelState.READY}:
                return backend
            if entry.state == ModelState.ERROR and not retry:
                raise ProviderLoadError(entry.error or f"provider {provider_id!r} failed to load")

            entry.error = None
            try:
                device = await asyncio.to_thread(
                    select_device, self.device_preference, backend.supported_devices
                )
                is_remote_id = bool(backend.model_id and not os.path.exists(backend.model_id))
                entry.state = (
                    ModelState.DOWNLOADING if backend.may_download and is_remote_id else ModelState.LOADING
                )
                await asyncio.to_thread(backend.load, device)
            except Exception as exc:
                entry.state = ModelState.ERROR
                entry.error = f"{type(exc).__name__}: {exc}"
                with contextlib.suppress(Exception):
                    await asyncio.to_thread(backend.unload)
                if isinstance(exc, ProviderUnavailableError):
                    raise
                raise ProviderLoadError(f"failed to load provider {provider_id!r}: {exc}") from exc

            entry.device = device
            entry.loaded_at = datetime.now(UTC)
            entry.state = ModelState.READY if backend.validated_on_load else ModelState.LOADED
            return backend

    async def synthesize(self, request: SpeechRequest) -> RawSynthesisResult:
        entry = self._entry(request.provider_id)
        # Upstream GPU libraries do not promise concurrent-generation safety.
        # Acquire this before lifecycle loading so unload cannot slip between a
        # successful ensure_loaded() and the generation call.
        async with entry.generation_lock:
            backend = await self.ensure_loaded(request.provider_id)
            result = await asyncio.to_thread(backend.synthesize, request)
        # A decoded waveform is the runtime smoke test. In particular, Qwen is
        # not advertised as available based on import/config inspection alone.
        entry.state = ModelState.READY
        entry.error = None
        return result

    async def unload(self, provider_id: str) -> None:
        entry = self._entry(provider_id)
        async with entry.generation_lock, entry.lifecycle_lock:
            await asyncio.to_thread(entry.backend.unload)
            entry.device = None
            entry.error = None
            if not entry.backend.enabled:
                entry.state = ModelState.DISABLED
            elif not entry.backend.dependencies_installed():
                entry.state = ModelState.NOT_INSTALLED
            else:
                entry.state = ModelState.UNLOADED

    async def reload(self, provider_id: str) -> TTSBackend:
        await self.unload(provider_id)
        return await self.ensure_loaded(provider_id, retry=True)

    async def close(self) -> None:
        for provider_id in list(self._entries):
            entry = self._entries[provider_id]
            if entry.state in {ModelState.LOADED, ModelState.READY, ModelState.ERROR}:
                await self.unload(provider_id)
