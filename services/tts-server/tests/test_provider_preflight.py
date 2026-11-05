from __future__ import annotations

from app.config import Settings
from app.providers.tada import TadaTTSBackend


def test_tada_requires_prompt_configuration_before_cuda_discovery() -> None:
    backend = TadaTTSBackend(Settings(enable_tada=True))

    assert backend.preflight_error("auto") == (
        "TADA requires VIBE_TTS_TADA_PROMPT_AUDIO and an exact VIBE_TTS_TADA_PROMPT_TRANSCRIPT"
    )


def test_tada_rejects_a_missing_prompt_file_before_cuda_discovery() -> None:
    backend = TadaTTSBackend(
        Settings(
            enable_tada=True,
            tada_prompt_audio="/definitely/missing/vibe-tts-reference.wav",
            tada_prompt_transcript="Exact transcript.",
        )
    )

    assert backend.preflight_error("auto") == "the configured TADA prompt audio file does not exist"
