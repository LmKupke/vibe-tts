"""Alignment providers are separate from waveform generation."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

from app.schemas import AlignmentEntry


@dataclass(frozen=True, slots=True)
class AlignmentRequest:
    text: str
    audio: bytes
    mime_type: str
    duration_ms: float
    native_alignment: list[AlignmentEntry] | None = None


class AlignmentProvider(ABC):
    id: str

    @abstractmethod
    def align(self, request: AlignmentRequest) -> list[AlignmentEntry]:
        raise NotImplementedError
