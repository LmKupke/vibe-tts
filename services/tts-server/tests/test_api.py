from __future__ import annotations

import base64
import io
import wave

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_health_and_provider_discovery_do_not_load_heavy_models() -> None:
    app = create_app(Settings(enable_tada=False, enable_qwen=False))
    with TestClient(app) as client:
        health = client.get("/health")
        assert health.status_code == 200
        payload = health.json()
        assert payload["status"] == "ok"
        states = {provider["id"]: provider["state"] for provider in payload["providers"]}
        assert states["mock"] == "ready"
        assert states["tada"] == "disabled"
        assert states["qwen"] == "disabled"

        providers = client.get("/v1/providers").json()["providers"]
        mock = next(provider for provider in providers if provider["id"] == "mock")
        assert mock["local"] is True
        assert mock["selectable"] is True
        assert mock["available"] is True
        qwen = next(provider for provider in providers if provider["id"] == "qwen")
        assert qwen["capabilities"]["streaming"] is False
        assert qwen["capabilities"]["native_alignment"] is False


def test_mock_speech_returns_real_wav_and_exact_repeated_word_offsets() -> None:
    app = create_app(Settings())
    with TestClient(app) as client:
        response = client.post(
            "/v1/speech",
            json={
                "text": "echo, echo café",
                "provider_id": "mock",
                "voice_id": "mock-neutral",
                "speed": 1.25,
                "diagnostics": True,
            },
        )
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["provider_id"] == "mock"
        assert payload["mime_type"] == "audio/wav"
        assert [(item["text"], item["char_start"], item["char_end"]) for item in payload["alignment"]] == [
            ("echo", 0, 4),
            ("echo", 6, 10),
            ("café", 11, 15),
        ]
        assert payload["diagnostics"]["alignment_source"] == "provider_native"

        audio = base64.b64decode(payload["audio_base64"], validate=True)
        with wave.open(io.BytesIO(audio), "rb") as wav:
            assert wav.getframerate() == 16_000
            assert wav.getnchannels() == 1
            assert wav.getnframes() > 0


def test_speech_serializes_character_offsets_as_utf16_code_units() -> None:
    app = create_app(Settings())
    with TestClient(app) as client:
        response = client.post(
            "/v1/speech",
            json={"text": "🙂 echo", "provider_id": "mock", "diagnostics": True},
        )
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["alignment"] == [
            {
                "text": "echo",
                "char_start": 3,
                "char_end": 7,
                "start_ms": 0.0,
                "end_ms": 161.0,
            }
        ]
        assert payload["diagnostics"]["alignment_offset_unit"] == "utf16_code_units"


def test_speech_accepts_camel_case_aliases_but_serializes_canonical_snake_case() -> None:
    app = create_app(Settings())
    with TestClient(app) as client:
        response = client.post(
            "/v1/speech",
            json={"text": "Alias check.", "providerId": "mock", "voiceId": "mock-bright"},
        )
        assert response.status_code == 200
        payload = response.json()
        assert "audio_base64" in payload
        assert "audioBase64" not in payload
        assert payload["provider_id"] == "mock"
        assert "diagnostics" not in payload


def test_disabled_model_provider_is_a_service_unavailable_error() -> None:
    app = create_app(Settings(enable_qwen=False))
    with TestClient(app) as client:
        response = client.post("/v1/speech", json={"text": "No download.", "provider_id": "qwen"})
        assert response.status_code == 503
        assert "disabled" in response.json()["detail"]


def test_unknown_provider_and_voice_query_are_not_found() -> None:
    app = create_app(Settings())
    with TestClient(app) as client:
        assert client.post("/v1/speech", json={"text": "Hi", "provider_id": "missing"}).status_code == 404
        assert client.get("/v1/voices", params={"provider_id": "missing"}).status_code == 404


def test_voices_include_primary_language_and_full_language_list() -> None:
    app = create_app(Settings())
    with TestClient(app) as client:
        voices = client.get("/v1/voices", params={"provider_id": "mock"}).json()["voices"]
        assert voices[0]["language"] == "und"
        assert voices[0]["languages"] == ["und"]


def test_cors_can_be_restricted_to_one_exact_extension_origin() -> None:
    allowed = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
    app = create_app(Settings(cors_origins=(allowed,), cors_origin_regex=None))
    with TestClient(app) as client:
        accepted = client.options(
            "/v1/providers",
            headers={
                "Origin": allowed,
                "Access-Control-Request-Method": "GET",
            },
        )
        assert accepted.status_code == 200
        assert accepted.headers["access-control-allow-origin"] == allowed

        rejected = client.options(
            "/v1/providers",
            headers={
                "Origin": "chrome-extension://pppppppppppppppppppppppppppppppp",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert rejected.status_code == 400
        assert "access-control-allow-origin" not in rejected.headers
