"""Tests for the multimodal Bedrock converse wrapper."""

from __future__ import annotations

from typing import Any, Dict, List
from unittest.mock import MagicMock

import pytest

from bedrock_client import (  # type: ignore[import-not-found]
    BedrockConverseClient,
    _sniff_image_format,
)


PNG = b"\x89PNG\r\n\x1a\n" + b"x" * 32
JPEG = b"\xff\xd8\xff" + b"x" * 32
WEBP = b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + b"x" * 32


def _mock_client_returning(text: str) -> MagicMock:
    mock = MagicMock()
    mock.converse.return_value = {
        "output": {
            "message": {"content": [{"text": text}]}
        }
    }
    return mock


def test_converse_sends_each_image_as_a_content_block():
    mock = _mock_client_returning("hello")
    client = BedrockConverseClient(client=mock, model_id="test-model", region="us-west-2")
    result = client.converse(images=[PNG, JPEG], prompt="Describe")
    assert result == "hello"
    kwargs = mock.converse.call_args.kwargs
    content = kwargs["messages"][0]["content"]
    assert len(content) == 3
    assert content[0]["image"]["format"] == "png"
    assert content[0]["image"]["source"]["bytes"] == PNG
    assert content[1]["image"]["format"] == "jpeg"
    assert content[1]["image"]["source"]["bytes"] == JPEG
    assert content[2] == {"text": "Describe"}


def test_converse_forwards_inference_config_and_model():
    mock = _mock_client_returning("ok")
    client = BedrockConverseClient(client=mock, model_id="test-model", region="us-west-2")
    client.converse(images=[PNG], prompt="p", max_tokens=1024, temperature=0.5)
    kwargs = mock.converse.call_args.kwargs
    assert kwargs["modelId"] == "test-model"
    assert kwargs["inferenceConfig"] == {"maxTokens": 1024, "temperature": 0.5}


def test_converse_attaches_system_prompt_when_provided():
    mock = _mock_client_returning("ok")
    client = BedrockConverseClient(client=mock, model_id="m", region="us-west-2")
    client.converse(images=[PNG], prompt="p", system_prompt="you are helpful")
    kwargs = mock.converse.call_args.kwargs
    assert kwargs["system"] == [{"text": "you are helpful"}]


def test_converse_rejects_empty_image_list():
    client = BedrockConverseClient(client=_mock_client_returning(""), model_id="m", region="us-west-2")
    with pytest.raises(ValueError):
        client.converse(images=[], prompt="p")


def test_converse_returns_empty_string_when_no_text_block():
    mock = MagicMock()
    mock.converse.return_value = {"output": {"message": {"content": []}}}
    client = BedrockConverseClient(client=mock, model_id="m", region="us-west-2")
    assert client.converse(images=[PNG], prompt="p") == ""


def test_sniff_image_format_detects_png_jpeg_webp_and_defaults():
    assert _sniff_image_format(PNG) == "png"
    assert _sniff_image_format(JPEG) == "jpeg"
    assert _sniff_image_format(WEBP) == "webp"
    assert _sniff_image_format(b"\x00\x00\x00\x00garbage") == "png"
