from __future__ import annotations

import pytest

from app.config import Settings
from app.errors import ProviderSynthesisError
from app.providers.qwen import QwenTTSBackend
from app.schemas import SpeechRequest


class FakeQwenModel:
    def __init__(self) -> None:
        self.kwargs = None

    def generate_custom_voice(self, **kwargs):
        self.kwargs = kwargs
        return [[0.0, 0.2, -0.2, 0.0]], 24_000


def ready_custom_voice_backend() -> tuple[QwenTTSBackend, FakeQwenModel]:
    backend = QwenTTSBackend(Settings(enable_qwen=True))
    model = FakeQwenModel()
    backend._model = model
    backend._model_type = "custom_voice"
    backend._model_size = "1b7"
    backend._speakers = ["Ryan"]
    backend._languages = ["english"]
    backend.device = "cuda"
    return backend, model


def test_qwen_uses_non_streaming_api_and_never_fabricates_alignment() -> None:
    backend, model = ready_custom_voice_backend()
    result = backend.synthesize(
        SpeechRequest(text="Hello.", provider_id="qwen", voice_id="Ryan", language="en")
    )
    assert result.audio.startswith(b"RIFF")
    assert result.native_alignment is None
    assert model.kwargs["non_streaming_mode"] is True
    assert model.kwargs["language"] == "English"
    assert backend.capabilities().streaming is False
    assert backend.capabilities().native_alignment is False


def test_qwen_rejects_unsupported_numeric_rate_instead_of_ignoring_it() -> None:
    backend, _ = ready_custom_voice_backend()
    with pytest.raises(ProviderSynthesisError, match="no numeric"):
        backend.synthesize(SpeechRequest(text="Hello.", provider_id="qwen", speed=1.25))


def test_qwen_voice_design_is_not_selectable_for_the_current_extension() -> None:
    backend = QwenTTSBackend(
        Settings(
            enable_qwen=True,
            qwen_checkpoint="Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
        )
    )

    assert backend.preflight_error("auto") == (
        "Qwen VoiceDesign requires a per-request instruction, which the current "
        "reader extension does not expose"
    )
    assert backend.capabilities().voice_design is True


def test_qwen_base_requires_a_real_configured_reference_before_device_discovery() -> None:
    backend = QwenTTSBackend(Settings(enable_qwen=True, qwen_checkpoint="Qwen/Qwen3-TTS-12Hz-0.6B-Base"))

    assert backend.preflight_error("auto") == (
        "a Qwen Base checkpoint requires server-configured reference audio and transcript"
    )
