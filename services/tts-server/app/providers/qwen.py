"""Optional backend for the official qwen-tts 0.1.1 wrapper."""

from __future__ import annotations

import gc
import json
import os
from typing import Any

from app.config import Settings
from app.errors import ProviderConfigurationError, ProviderSynthesisError, UnsupportedDeviceError
from app.model_manager.device import select_device
from app.providers.base import BaseBackend, RawSynthesisResult
from app.schemas import ProviderCapabilities, SpeechRequest, Voice
from app.synthesis.audio import floats_to_wav

_LANGUAGE_NAMES = {
    "auto": "Auto",
    "zh": "Chinese",
    "ch": "Chinese",
    "chinese": "Chinese",
    "en": "English",
    "english": "English",
    "ja": "Japanese",
    "japanese": "Japanese",
    "ko": "Korean",
    "korean": "Korean",
    "de": "German",
    "german": "German",
    "fr": "French",
    "french": "French",
    "ru": "Russian",
    "russian": "Russian",
    "pt": "Portuguese",
    "portuguese": "Portuguese",
    "es": "Spanish",
    "spanish": "Spanish",
    "it": "Italian",
    "italian": "Italian",
}


class QwenTTSBackend(BaseBackend):
    id = "qwen"
    name = "Qwen3-TTS"
    dependency_modules = ("torch", "qwen_tts")
    may_download = True

    def __init__(self, settings: Settings) -> None:
        super().__init__(enabled=settings.enable_qwen)
        self.settings = settings
        self.model_id = settings.qwen_checkpoint
        self.supported_devices = (
            ("cuda", "mps", "cpu") if settings.qwen_allow_experimental_device else ("cuda",)
        )
        self._torch: Any | None = None
        self._model: Any | None = None
        self._model_type: str | None = None
        self._model_size: str | None = None
        self._languages: list[str] = []
        self._speakers: list[str] = []
        self._clone_prompt: Any | None = None

    def capabilities(self) -> ProviderCapabilities:
        kind = self._model_type or self._configured_model_type()
        size = self._model_size or _configured_model_size(self.settings.qwen_checkpoint)
        return ProviderCapabilities(
            streaming=False,
            voice_selection=kind == "custom_voice",
            voice_cloning=kind == "base",
            voice_design=kind == "voice_design",
            native_alignment=False,
            numeric_rate_control=False,
            languages=list(self._languages),
            model_type=kind,
            model_size=size,
            instruction_control=(kind == "voice_design" or (kind == "custom_voice" and _is_1_7b(size))),
        )

    def voices(self) -> list[Voice]:
        return [
            Voice(
                id=speaker,
                provider_id=self.id,
                name=speaker.replace("_", " "),
                language=_primary_language(self._languages),
                languages=list(self._languages),
            )
            for speaker in self._speakers
        ]

    def preflight_error(self, device_preference: str) -> str | None:
        model_type = self._configured_model_type()
        if model_type == "voice_design":
            return (
                "Qwen VoiceDesign requires a per-request instruction, which the current "
                "reader extension does not expose"
            )
        if model_type == "base":
            if not self.settings.qwen_reference_audio or not self.settings.qwen_reference_transcript:
                return "a Qwen Base checkpoint requires server-configured reference audio and transcript"
            if not os.path.isfile(self.settings.qwen_reference_audio):
                return "the configured Qwen reference audio file does not exist"
        if self.settings.offline and not os.path.exists(self.settings.qwen_checkpoint):
            return "offline Qwen requires VIBE_TTS_QWEN_CHECKPOINT to name a complete local snapshot"
        try:
            select_device(device_preference, self.supported_devices)
        except UnsupportedDeviceError as exc:
            return str(exc)
        return None

    def _configured_model_type(self) -> str | None:
        checkpoint = self.settings.qwen_checkpoint
        lowered = checkpoint.casefold().replace("_", "-")
        if "voice-design" in lowered or "voicedesign" in lowered:
            return "voice_design"
        if "custom-voice" in lowered or "customvoice" in lowered:
            return "custom_voice"
        if lowered.endswith("-base") or "/base" in lowered:
            return "base"
        if os.path.isdir(checkpoint):
            for filename in ("config.json", "model/config.json"):
                path = os.path.join(checkpoint, filename)
                try:
                    with open(path, encoding="utf-8") as handle:
                        payload = json.load(handle)
                except (FileNotFoundError, OSError, TypeError, ValueError):
                    continue
                model_type = payload.get("tts_model_type") if isinstance(payload, dict) else None
                if isinstance(model_type, str):
                    return model_type.casefold().replace("-", "_")
        return None

    def load(self, device: str) -> None:
        if device != "cuda" and not self.settings.qwen_allow_experimental_device:
            raise UnsupportedDeviceError(
                "Qwen's officially demonstrated local deployment path is CUDA; "
                "set VIBE_TTS_QWEN_ALLOW_EXPERIMENTAL_DEVICE=1 to test CPU/MPS"
            )
        if self.settings.offline and not os.path.exists(self.settings.qwen_checkpoint):
            raise ProviderConfigurationError(
                "offline Qwen requires VIBE_TTS_QWEN_CHECKPOINT to name a complete local snapshot"
            )
        try:
            import torch
            from qwen_tts import Qwen3TTSModel
        except (ImportError, OSError) as exc:
            raise ProviderConfigurationError(
                "Qwen dependencies could not be imported; install the 'qwen' extra"
            ) from exc

        dtype = torch.bfloat16 if device == "cuda" else (torch.float16 if device == "mps" else torch.float32)
        load_args: dict[str, Any] = {
            "device_map": "cuda:0" if device == "cuda" else device,
            "dtype": dtype,
        }
        if device == "cuda" and self.settings.qwen_use_flash_attention:
            load_args["attn_implementation"] = "flash_attention_2"
        else:
            load_args["attn_implementation"] = "sdpa"
        model = Qwen3TTSModel.from_pretrained(self.settings.qwen_checkpoint, **load_args)

        inner = getattr(model, "model", None)
        model_type = str(getattr(inner, "tts_model_type", ""))
        model_size = str(getattr(inner, "tts_model_size", ""))
        if model_type not in {"base", "custom_voice", "voice_design"}:
            raise ProviderConfigurationError(
                f"Qwen checkpoint reported unsupported tts_model_type {model_type!r}"
            )
        if model_type == "voice_design":
            raise ProviderConfigurationError(
                "Qwen VoiceDesign requires a per-request instruction, which the current "
                "reader extension does not expose"
            )
        languages = [str(value) for value in (model.get_supported_languages() or [])]
        speakers = [str(value) for value in (model.get_supported_speakers() or [])]
        if model_type == "custom_voice" and speakers:
            known_speakers = {speaker.casefold() for speaker in speakers}
            if self.settings.qwen_default_voice.casefold() not in known_speakers:
                raise ProviderConfigurationError(
                    f"configured Qwen default voice {self.settings.qwen_default_voice!r} is not "
                    "supported by this checkpoint"
                )

        clone_prompt = None
        if model_type == "base":
            if not self.settings.qwen_reference_audio or not self.settings.qwen_reference_transcript:
                raise ProviderConfigurationError(
                    "a Qwen Base checkpoint requires server-configured reference audio and transcript"
                )
            if not os.path.isfile(self.settings.qwen_reference_audio):
                raise ProviderConfigurationError("the configured Qwen reference audio file does not exist")
            clone_prompt = model.create_voice_clone_prompt(
                ref_audio=self.settings.qwen_reference_audio,
                ref_text=self.settings.qwen_reference_transcript,
                x_vector_only_mode=False,
            )

        self.device = device
        self._torch = torch
        self._model = model
        self._model_type = model_type
        self._model_size = model_size
        self._languages = languages
        self._speakers = speakers
        self._clone_prompt = clone_prompt

    def unload(self) -> None:
        torch = self._torch
        self._model = None
        self._torch = None
        self._model_type = None
        self._model_size = None
        self._languages = []
        self._speakers = []
        self._clone_prompt = None
        self.device = None
        gc.collect()
        if torch is not None:
            try:
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass

    def synthesize(self, request: SpeechRequest) -> RawSynthesisResult:
        if self._model is None or self._model_type is None:
            raise ProviderSynthesisError("Qwen is not loaded")
        if abs(request.speed - 1.0) > 1e-6:
            raise ProviderSynthesisError(
                "the released local Qwen API has no numeric synthesis-rate control; "
                "apply playback rate in the client"
            )
        language = _qwen_language(request.language)
        try:
            if request.seed is not None and self._torch is not None:
                self._torch.manual_seed(request.seed)
                if self.device == "cuda":
                    self._torch.cuda.manual_seed_all(request.seed)

            if self._model_type == "custom_voice":
                speaker = request.voice_id or self.settings.qwen_default_voice
                known_speakers = {value.casefold() for value in self._speakers}
                if self._speakers and speaker.casefold() not in known_speakers:
                    raise ProviderSynthesisError(f"unknown Qwen speaker: {speaker}")
                if request.instruction and not _is_1_7b(self._model_size):
                    raise ProviderSynthesisError(
                        "instruction control is supported by the 1.7B CustomVoice checkpoint only"
                    )
                wavs, sample_rate = self._model.generate_custom_voice(
                    text=request.text,
                    language=language,
                    speaker=speaker,
                    instruct=request.instruction,
                    non_streaming_mode=True,
                )
            elif self._model_type == "voice_design":
                if not request.instruction:
                    raise ProviderSynthesisError("Qwen VoiceDesign requires an instruction")
                wavs, sample_rate = self._model.generate_voice_design(
                    text=request.text,
                    language=language,
                    instruct=request.instruction,
                    non_streaming_mode=True,
                )
            else:
                if self._clone_prompt is None:
                    raise ProviderSynthesisError("Qwen voice-clone prompt is not configured")
                wavs, sample_rate = self._model.generate_voice_clone(
                    text=request.text,
                    language=language,
                    voice_clone_prompt=self._clone_prompt,
                    non_streaming_mode=True,
                )
        except ProviderSynthesisError:
            raise
        except Exception as exc:
            raise ProviderSynthesisError(f"Qwen generation failed: {exc}") from exc

        if not wavs:
            raise ProviderSynthesisError("Qwen returned no decoded waveform")
        waveform = wavs[0]
        if hasattr(waveform, "reshape"):
            waveform = waveform.reshape(-1)
        samples = waveform.tolist() if hasattr(waveform, "tolist") else list(waveform)
        audio = floats_to_wav(samples, int(sample_rate))
        duration_ms = len(samples) * 1000.0 / int(sample_rate)
        return RawSynthesisResult(
            audio=audio,
            mime_type="audio/wav",
            duration_ms=duration_ms,
            # qwen-tts returns only complete waveform(s) and sample rate. Codec
            # frames are not text timestamps and must not be presented as such.
            native_alignment=None,
            diagnostics={
                "model": self.settings.qwen_checkpoint,
                "device": self.device,
                "model_type": self._model_type,
                "model_size": self._model_size,
                "sample_rate": int(sample_rate),
                "streaming": False,
                "native_alignment": False,
            },
        )


def _qwen_language(language: str | None) -> str:
    if not language:
        return "Auto"
    base = language.strip().lower().replace("_", "-").split("-", 1)[0]
    return _LANGUAGE_NAMES.get(language.strip().lower(), _LANGUAGE_NAMES.get(base, language))


def _primary_language(languages: list[str]) -> str | None:
    return next((language for language in languages if language.casefold() != "auto"), None)


def _configured_model_size(checkpoint: str) -> str | None:
    lowered = checkpoint.casefold()
    if "1.7b" in lowered:
        return "1.7B"
    if "0.6b" in lowered:
        return "0.6B"
    return None


def _is_1_7b(value: str | None) -> bool:
    return value is not None and value.casefold().replace(".", "").replace("_", "") in {
        "17b",
        "1b7",
    }
