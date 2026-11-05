"""Optional CUDA PyTorch backend for the official Hume TADA package."""

from __future__ import annotations

import gc
import os
from typing import Any

from app.config import Settings
from app.errors import (
    NativeAlignmentError,
    ProviderConfigurationError,
    ProviderSynthesisError,
    UnsupportedDeviceError,
)
from app.model_manager.device import select_device
from app.providers.base import BaseBackend, RawSynthesisResult
from app.providers.tada_alignment import extract_tada_word_alignment
from app.schemas import ProviderCapabilities, SpeechRequest, Voice
from app.synthesis.audio import floats_to_wav


class TadaTTSBackend(BaseBackend):
    id = "tada"
    name = "TADA"
    dependency_modules = ("torch", "torchaudio", "tada")
    supported_devices = ("cuda",)
    may_download = True

    def __init__(self, settings: Settings) -> None:
        super().__init__(enabled=settings.enable_tada)
        self.settings = settings
        self.model_id = settings.tada_checkpoint
        self._model: Any | None = None
        self._prompt: Any | None = None
        self._torch: Any | None = None
        self._inference_options_class: Any | None = None
        self._normalize_text: Any | None = None

    def capabilities(self) -> ProviderCapabilities:
        multilingual = "3b-ml" in self.settings.tada_checkpoint.lower()
        languages = ["en", "ar", "ch", "de", "es", "fr", "it", "ja", "pl", "pt"] if multilingual else ["en"]
        return ProviderCapabilities(
            streaming=False,
            voice_selection=False,
            # This service uses one administrator-configured reference. It does
            # not expose arbitrary file/URL cloning inputs to extension pages.
            voice_cloning=False,
            voice_design=False,
            native_alignment=True,
            numeric_rate_control=True,
            languages=languages,
            model_type="text_acoustic_dual_alignment",
        )

    def voices(self) -> list[Voice]:
        if not self.settings.tada_prompt_audio or not self.settings.tada_prompt_transcript:
            return []
        return [
            Voice(
                id="tada-reference",
                provider_id=self.id,
                name="Configured TADA reference",
                language="en",
                languages=self.capabilities().languages,
                description="Voice derived from the server-configured reference audio",
            )
        ]

    def preflight_error(self, device_preference: str) -> str | None:
        audio_path = self.settings.tada_prompt_audio
        if not audio_path or not self.settings.tada_prompt_transcript:
            return "TADA requires VIBE_TTS_TADA_PROMPT_AUDIO and an exact VIBE_TTS_TADA_PROMPT_TRANSCRIPT"
        if not os.path.isfile(audio_path):
            return "the configured TADA prompt audio file does not exist"
        if self.settings.offline:
            missing = [
                checkpoint
                for checkpoint in (self.settings.tada_checkpoint, self.settings.tada_encoder_checkpoint)
                if not os.path.exists(checkpoint)
            ]
            if missing:
                return "offline TADA requires checkpoint variables to name complete local snapshots"
        try:
            select_device(device_preference, self.supported_devices)
        except UnsupportedDeviceError as exc:
            return str(exc)
        return None

    def load(self, device: str) -> None:
        if device != "cuda":
            raise UnsupportedDeviceError("the official TADA PyTorch path is supported on CUDA only")
        audio_path = self.settings.tada_prompt_audio
        transcript = self.settings.tada_prompt_transcript
        if not audio_path or not transcript:
            raise ProviderConfigurationError(
                "TADA requires VIBE_TTS_TADA_PROMPT_AUDIO and an exact VIBE_TTS_TADA_PROMPT_TRANSCRIPT"
            )
        if not os.path.isfile(audio_path):
            raise ProviderConfigurationError("the configured TADA prompt audio file does not exist")
        if self.settings.offline:
            for checkpoint in (self.settings.tada_checkpoint, self.settings.tada_encoder_checkpoint):
                if not os.path.exists(checkpoint):
                    raise ProviderConfigurationError(
                        "offline TADA requires checkpoint variables to name complete local snapshots"
                    )

        try:
            import torch
            import torchaudio
            from tada.modules.encoder import Encoder
            from tada.modules.tada import InferenceOptions, TadaForCausalLM
            from tada.utils.text import normalize_text
        except (ImportError, OSError) as exc:
            raise ProviderConfigurationError(
                "TADA dependencies could not be imported; install the 'tada' extra"
            ) from exc

        try:
            encoder_kwargs: dict[str, Any] = {"subfolder": "encoder"}
            if self.settings.tada_prompt_language:
                encoder_kwargs["language"] = self.settings.tada_prompt_language
            encoder = Encoder.from_pretrained(
                self.settings.tada_encoder_checkpoint,
                **encoder_kwargs,
            ).to(device)
            audio, sample_rate = torchaudio.load(audio_path)
            audio = audio.mean(dim=0, keepdim=True).to(device)
            peak = audio.abs().max().clamp(min=1e-8)
            audio = audio / peak * 0.95
            with torch.inference_mode():
                prompt = encoder(audio, text=[transcript], sample_rate=sample_rate)
            del encoder, audio
            torch.cuda.empty_cache()

            model = TadaForCausalLM.from_pretrained(
                self.settings.tada_checkpoint,
                torch_dtype=torch.bfloat16,
                low_cpu_mem_usage=True,
            ).to(device)
            model.eval()
        except Exception:
            # Let ModelManager record the original framework/HF error.
            raise

        self.device = device
        self._torch = torch
        self._model = model
        self._prompt = prompt
        self._inference_options_class = InferenceOptions
        self._normalize_text = normalize_text

    def unload(self) -> None:
        torch = self._torch
        self._model = None
        self._prompt = None
        self._inference_options_class = None
        self._normalize_text = None
        self._torch = None
        self.device = None
        gc.collect()
        if torch is not None:
            try:
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass

    def synthesize(self, request: SpeechRequest) -> RawSynthesisResult:
        if (
            self._model is None
            or self._prompt is None
            or self._torch is None
            or self._inference_options_class is None
            or self._normalize_text is None
        ):
            raise ProviderSynthesisError("TADA is not loaded")
        if request.voice_id not in {None, "tada-reference"}:
            raise ProviderSynthesisError(f"unknown TADA voice: {request.voice_id}")

        torch = self._torch
        if request.seed is not None:
            torch.manual_seed(request.seed)
            torch.cuda.manual_seed_all(request.seed)
        speed_up = request.speed if abs(request.speed - 1.0) > 1e-6 else None
        options = self._inference_options_class(
            speed_up_factor=speed_up,
            text_do_sample=False,
        )
        try:
            with torch.inference_mode():
                output = self._model.generate(
                    prompt=self._prompt,
                    text=request.text,
                    num_transition_steps=0,
                    normalize_text=True,
                    inference_options=options,
                )
        except Exception as exc:
            raise ProviderSynthesisError(f"TADA generation failed: {exc}") from exc

        waveforms = getattr(output, "audio", None)
        if not waveforms or waveforms[0] is None:
            raise ProviderSynthesisError("TADA returned no decoded waveform")
        waveform = waveforms[0].detach().float().cpu().reshape(-1)
        sample_rate = 24_000
        audio = floats_to_wav(waveform.tolist(), sample_rate)
        duration_ms = waveform.numel() * 1000.0 / sample_rate
        normalized = self._normalize_text(request.text)

        try:
            alignment, alignment_diagnostics = extract_tada_word_alignment(
                source_text=request.text,
                normalized_text=normalized,
                tokenizer=self._model.tokenizer,
                generation_output=output,
                shift_acoustic=int(self._model.config.shift_acoustic),
                audio_duration_ms=duration_ms,
            )
        except NativeAlignmentError as exc:
            if self.settings.tada_require_alignment:
                raise ProviderSynthesisError(
                    f"TADA native alignment verification failed closed: {exc}"
                ) from exc
            alignment = None
            alignment_diagnostics = {
                "alignment_error": str(exc),
                "alignment_verification": "failed_closed",
            }

        diagnostics: dict[str, Any] = {
            "model": self.settings.tada_checkpoint,
            "device": self.device,
            "sample_rate": sample_rate,
            "alignment_verification": "verified" if alignment is not None else "failed_closed",
        }
        if request.diagnostics:
            diagnostics["tada_alignment"] = alignment_diagnostics
        return RawSynthesisResult(
            audio=audio,
            mime_type="audio/wav",
            duration_ms=duration_ms,
            native_alignment=alignment,
            diagnostics=diagnostics,
        )
