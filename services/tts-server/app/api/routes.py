"""Thin FastAPI routes; lifecycle and synthesis live below this layer."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request

from app import __version__
from app.errors import (
    AlignmentValidationError,
    ProviderNotFoundError,
    ProviderSynthesisError,
    ProviderUnavailableError,
)
from app.schemas import (
    HealthResponse,
    ProvidersResponse,
    SpeechRequest,
    SpeechResponse,
    VoicesResponse,
)

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    providers = request.app.state.model_manager.snapshots()
    service_ok = any(provider.loadable or provider.available for provider in providers)
    return HealthResponse(
        status="ok" if service_ok else "degraded",
        version=__version__,
        providers=providers,
    )


@router.get("/v1/providers", response_model=ProvidersResponse)
async def providers(request: Request) -> ProvidersResponse:
    return ProvidersResponse(providers=request.app.state.model_manager.snapshots())


@router.get("/v1/voices", response_model=VoicesResponse)
async def voices(
    request: Request,
    provider_id: str | None = Query(default=None),
) -> VoicesResponse:
    registry = request.app.state.tts_registry
    try:
        backends = [registry.get(provider_id)] if provider_id else registry.all()
    except ProviderNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return VoicesResponse(
        voices=[voice for backend in backends if backend.enabled for voice in backend.voices()]
    )


@router.post(
    "/v1/speech",
    response_model=SpeechResponse,
    response_model_exclude_none=True,
)
async def speech(payload: SpeechRequest, request: Request) -> SpeechResponse:
    try:
        return await request.app.state.synthesis_pipeline.synthesize(payload)
    except ProviderNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ProviderUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except (ProviderSynthesisError, AlignmentValidationError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
