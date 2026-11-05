"""Provider-neutral synthesis and alignment normalization."""

from __future__ import annotations

import base64

from app.alignment.base import AlignmentRequest
from app.alignment.native import NativeAlignmentProvider
from app.alignment.registry import AlignmentRegistry
from app.config import Settings
from app.errors import ProviderSynthesisError
from app.model_manager.manager import ModelManager
from app.schemas import SpeechRequest, SpeechResponse
from app.synthesis.utf16 import alignment_to_utf16
from app.synthesis.validation import validate_alignment


class SynthesisPipeline:
    def __init__(
        self,
        manager: ModelManager,
        alignment_registry: AlignmentRegistry,
        settings: Settings,
    ) -> None:
        self.manager = manager
        self.alignment_registry = alignment_registry
        self.settings = settings
        self.native_alignment = NativeAlignmentProvider()

    async def synthesize(self, request: SpeechRequest) -> SpeechResponse:
        if len(request.text) > self.settings.max_text_length:
            raise ProviderSynthesisError(
                f"text is too long ({len(request.text)} characters); "
                f"maximum is {self.settings.max_text_length}"
            )
        raw = await self.manager.synthesize(request)
        if not raw.audio:
            raise ProviderSynthesisError("provider returned empty audio")
        if raw.duration_ms <= 0:
            raise ProviderSynthesisError("provider returned a non-positive duration")

        if raw.native_alignment is None:
            # No forced aligner is installed in the MVP. Sentence clip timing is
            # still exact; word timing is intentionally absent rather than made up.
            alignment = []
            alignment_source = "unavailable"
        else:
            alignment = self.native_alignment.align(
                AlignmentRequest(
                    text=request.text,
                    audio=raw.audio,
                    mime_type=raw.mime_type,
                    duration_ms=raw.duration_ms,
                    native_alignment=raw.native_alignment,
                )
            )
            alignment = validate_alignment(request.text, alignment, duration_ms=raw.duration_ms)
            alignment_source = "provider_native"

        wire_alignment = alignment_to_utf16(request.text, alignment)

        diagnostics = None
        if request.diagnostics:
            diagnostics = dict(raw.diagnostics)
            diagnostics["alignment_source"] = alignment_source
            diagnostics["alignment_entry_count"] = len(wire_alignment)
            diagnostics["alignment_offset_unit"] = "utf16_code_units"

        return SpeechResponse(
            audio_base64=base64.b64encode(raw.audio).decode("ascii"),
            mime_type=raw.mime_type,
            duration_ms=raw.duration_ms,
            alignment=wire_alignment,
            provider_id=request.provider_id,
            diagnostics=diagnostics,
        )
