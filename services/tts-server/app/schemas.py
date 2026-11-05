"""Stable JSON contracts for the HTTP service."""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class ModelState(StrEnum):
    DISABLED = "disabled"
    NOT_INSTALLED = "not_installed"
    UNLOADED = "unloaded"
    DOWNLOADING = "downloading"
    LOADING = "loading"
    LOADED = "loaded"
    READY = "ready"
    ERROR = "error"


class AlignmentEntry(StrictModel):
    """Character offsets are UTF-16 code units at the HTTP boundary."""

    text: str
    char_start: int = Field(ge=0)
    char_end: int = Field(ge=0)
    start_ms: float = Field(ge=0)
    end_ms: float = Field(ge=0)


class ProviderCapabilities(StrictModel):
    streaming: bool = False
    voice_selection: bool = False
    voice_cloning: bool = False
    voice_design: bool = False
    native_alignment: bool = False
    numeric_rate_control: bool = False
    languages: list[str] = Field(default_factory=list)
    model_type: str | None = None
    model_size: str | None = None
    instruction_control: bool = False


class ProviderInfo(StrictModel):
    id: str
    name: str
    local: bool = True
    enabled: bool
    installed: bool
    loadable: bool
    selectable: bool
    available: bool
    state: ModelState
    model: str | None = None
    device: str | None = None
    error: str | None = None
    capabilities: ProviderCapabilities


class ProvidersResponse(StrictModel):
    providers: list[ProviderInfo]


class Voice(StrictModel):
    id: str
    provider_id: str
    name: str
    language: str | None = None
    languages: list[str] = Field(default_factory=list)
    description: str | None = None


class VoicesResponse(StrictModel):
    voices: list[Voice]


class HealthResponse(StrictModel):
    status: Literal["ok", "degraded"]
    version: str
    providers: list[ProviderInfo]


class SpeechRequest(StrictModel):
    text: str = Field(min_length=1, max_length=5_000)
    provider_id: str = Field(
        default="mock",
        validation_alias=AliasChoices("provider_id", "providerId", "provider"),
    )
    voice_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("voice_id", "voiceId", "voice"),
    )
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    language: str | None = None
    instruction: str | None = Field(default=None, max_length=1_000)
    diagnostics: bool = False
    seed: int | None = Field(default=None, ge=0, le=2**31 - 1)

    @field_validator("text")
    @classmethod
    def reject_blank_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("text must contain at least one non-whitespace character")
        return value


class SpeechResponse(StrictModel):
    audio_base64: str
    mime_type: str
    duration_ms: float = Field(gt=0)
    alignment: list[AlignmentEntry]
    provider_id: str
    diagnostics: dict[str, Any] | None = None
