from __future__ import annotations

import asyncio

import pytest

from app.errors import ProviderUnavailableError
from app.model_manager.manager import ModelManager
from app.providers.base import BaseBackend, RawSynthesisResult
from app.providers.registry import TTSRegistry
from app.schemas import ModelState, ProviderCapabilities, SpeechRequest


class CountingBackend(BaseBackend):
    id = "counting"
    name = "Counting"
    supported_devices = ("cpu",)
    validated_on_load = True

    def __init__(self) -> None:
        super().__init__()
        self.loads = 0
        self.active = 0
        self.max_active = 0

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities()

    def voices(self):
        return []

    def load(self, device: str) -> None:
        import time

        time.sleep(0.02)
        self.loads += 1
        super().load(device)

    def synthesize(self, request: SpeechRequest) -> RawSynthesisResult:
        import time

        self.active += 1
        self.max_active = max(self.max_active, self.active)
        time.sleep(0.02)
        self.active -= 1
        return RawSynthesisResult(b"RIFF-not-used", "audio/wav", 1.0, [])


class PreflightBlockedBackend(CountingBackend):
    id = "blocked"
    name = "Blocked"

    def preflight_error(self, device_preference: str) -> str | None:
        return f"no usable accelerator for {device_preference}"


@pytest.mark.asyncio
async def test_model_load_is_deduplicated_and_generation_is_serialized() -> None:
    backend = CountingBackend()
    manager = ModelManager(TTSRegistry([backend]))
    initial = manager.snapshot("counting")
    assert initial.selectable is True
    assert initial.available is False
    assert initial.state == ModelState.UNLOADED
    request = SpeechRequest(text="test", provider_id="counting")
    await asyncio.gather(*(manager.synthesize(request) for _ in range(4)))
    assert backend.loads == 1
    assert backend.max_active == 1
    assert manager.snapshot("counting").state == ModelState.READY
    assert manager.snapshot("counting").available is True


@pytest.mark.asyncio
async def test_unload_and_reload_replace_lifecycle_state() -> None:
    backend = CountingBackend()
    manager = ModelManager(TTSRegistry([backend]))
    await manager.ensure_loaded("counting")
    await manager.unload("counting")
    assert manager.snapshot("counting").state == ModelState.UNLOADED
    await manager.reload("counting")
    assert backend.loads == 2


@pytest.mark.asyncio
async def test_preflight_failure_is_visible_and_prevents_lazy_load() -> None:
    backend = PreflightBlockedBackend()
    manager = ModelManager(TTSRegistry([backend]), device_preference="cuda")

    snapshot = manager.snapshot("blocked")
    assert snapshot.enabled is True
    assert snapshot.installed is True
    assert snapshot.loadable is False
    assert snapshot.selectable is False
    assert snapshot.available is False
    assert snapshot.error == "no usable accelerator for cuda"
    with pytest.raises(ProviderUnavailableError, match="no usable accelerator"):
        await manager.ensure_loaded("blocked")
    assert backend.loads == 0
