"""FastAPI application factory."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.alignment.registry import AlignmentRegistry
from app.api.routes import router
from app.config import Settings
from app.model_manager.manager import ModelManager
from app.providers.mock import MockTTSBackend
from app.providers.qwen import QwenTTSBackend
from app.providers.registry import TTSRegistry
from app.providers.tada import TadaTTSBackend
from app.synthesis.pipeline import SynthesisPipeline


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved = settings or Settings.from_env()
    registry = TTSRegistry(
        [
            MockTTSBackend(enabled=resolved.enable_mock),
            TadaTTSBackend(resolved),
            QwenTTSBackend(resolved),
        ]
    )
    alignment_registry = AlignmentRegistry()
    manager = ModelManager(registry, device_preference=resolved.device)
    pipeline = SynthesisPipeline(manager, alignment_registry, resolved)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        await manager.close()

    application = FastAPI(
        title="Vibe TTS local service",
        version="0.1.0",
        lifespan=lifespan,
    )
    application.state.settings = resolved
    application.state.tts_registry = registry
    application.state.alignment_registry = alignment_registry
    application.state.model_manager = manager
    application.state.synthesis_pipeline = pipeline
    application.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved.cors_origins),
        allow_origin_regex=resolved.cors_origin_regex,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type"],
    )
    application.include_router(router)
    return application


app = create_app()
