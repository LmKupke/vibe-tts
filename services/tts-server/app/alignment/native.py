"""Adapter for alignment emitted by a speech backend itself."""

from app.alignment.base import AlignmentProvider, AlignmentRequest
from app.errors import AlignmentUnavailableError
from app.schemas import AlignmentEntry


class NativeAlignmentProvider(AlignmentProvider):
    id = "native"

    def align(self, request: AlignmentRequest) -> list[AlignmentEntry]:
        if request.native_alignment is None:
            raise AlignmentUnavailableError("the speech provider returned no native alignment")
        return request.native_alignment
