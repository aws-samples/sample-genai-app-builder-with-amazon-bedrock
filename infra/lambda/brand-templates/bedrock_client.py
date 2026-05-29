"""
Multimodal Bedrock client — sends N images + one text prompt in a single
`converse` call and returns the assistant's text reply.

Format sniffing is done from the first bytes of each image so the caller
doesn't have to plumb MIME types through. If a buffer doesn't match one of
the supported magic numbers we fall back to PNG — Bedrock's converse API
tolerates misnamed formats for PNG/JPEG within reason, and the extractor
is resilient to model confusion.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, Iterable, List, Optional

import boto3


def _log_bedrock_event(event: str, **fields: Any) -> None:
    """
    Emit a single JSON log line per Bedrock converse stage.

    Why structured: CloudWatch Logs Insights can filter/parse these directly:
        fields @timestamp, @message
        | filter event = "bedrock.converse.request"
        | stats avg(prompt_chars), count() by model_id

    Why two events: pairing a 'request' line with a 'response' line lets you
    measure latency and detect Bedrock returning partial/empty content without
    an exception (which would NOT show up in extraction.failed logs).
    """
    payload = {"event": event, **{k: v for k, v in fields.items() if v is not None}}
    print(json.dumps(payload, default=str))


# Haiku 4.5 is roughly 2x faster than Sonnet on multimodal tokens with
# acceptable quality for token extraction; the schema-validation retry loop
# absorbs the small accuracy gap. Chat generation (a different Lambda) stays
# on Sonnet via BEDROCK_MODEL_ID.
DEFAULT_MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
DEFAULT_REGION = "us-west-2"
DEFAULT_TEMPERATURE = 0.2
DEFAULT_MAX_TOKENS = 8192


def _sniff_image_format(buf: bytes) -> str:
    """Return 'png' | 'jpeg' | 'webp' based on magic number, default 'png'."""
    if len(buf) >= 8 and buf[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if len(buf) >= 3 and buf[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if len(buf) >= 12 and buf[:4] == b"RIFF" and buf[8:12] == b"WEBP":
        return "webp"
    return "png"


class BedrockConverseClient:
    def __init__(
        self,
        *,
        model_id: Optional[str] = None,
        region: Optional[str] = None,
        client=None,
    ) -> None:
        # Prefer extractor-specific override so chat (Sonnet) and extraction
        # (Haiku) can diverge without two Lambdas fighting over one env.
        self._model_id = (
            model_id
            or os.environ.get("EXTRACTION_MODEL_ID")
            or os.environ.get("BEDROCK_MODEL_ID")
            or DEFAULT_MODEL_ID
        )
        self._region = region or os.environ.get("AWS_REGION", DEFAULT_REGION)
        self._client = client or boto3.client("bedrock-runtime", region_name=self._region)

    def converse(
        self,
        *,
        images: Iterable[bytes],
        prompt: str,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        temperature: float = DEFAULT_TEMPERATURE,
        system_prompt: Optional[str] = None,
    ) -> str:
        image_list = [buf for buf in images if buf]
        if not image_list:
            raise ValueError("At least one image is required for converse().")

        content: List[Dict[str, Any]] = []
        for buf in image_list:
            content.append(
                {
                    "image": {
                        "format": _sniff_image_format(buf),
                        "source": {"bytes": buf},
                    }
                }
            )
        content.append({"text": prompt})

        kwargs: Dict[str, Any] = {
            "modelId": self._model_id,
            "messages": [{"role": "user", "content": content}],
            "inferenceConfig": {
                "maxTokens": max_tokens,
                "temperature": temperature,
            },
        }
        if system_prompt:
            kwargs["system"] = [{"text": system_prompt}]

        # Log what we're about to send. Keep it structured (one JSON line)
        # so CloudWatch Logs Insights can filter by request stage without
        # parsing free-form print() calls. We deliberately do NOT log the
        # full prompt here — it's large and the caller's prompts-on-disk
        # already document the template — but we do log its length, image
        # count, image formats, and system-prompt presence so you can tell
        # "the model got 1 image + our prompt" apart from "the model got 0
        # images because of a silent dropout upstream".
        _log_bedrock_event(
            "bedrock.converse.request",
            model_id=self._model_id,
            image_count=len(image_list),
            image_formats=[_sniff_image_format(b) for b in image_list],
            image_bytes=[len(b) for b in image_list],
            prompt_chars=len(prompt),
            system_prompt_chars=len(system_prompt) if system_prompt else 0,
            max_tokens=max_tokens,
            temperature=temperature,
        )

        response = self._client.converse(**kwargs)
        message = response.get("output", {}).get("message", {})
        blocks = message.get("content") or []

        reply_text = ""
        for block in blocks:
            if "text" in block:
                reply_text = block["text"]
                break

        usage = response.get("usage") or {}
        _log_bedrock_event(
            "bedrock.converse.response",
            model_id=self._model_id,
            stop_reason=response.get("stopReason"),
            reply_chars=len(reply_text),
            reply_head=reply_text[:200],  # first 200 chars — enough to spot "No, I can't help with that" or model preamble leaks
            input_tokens=usage.get("inputTokens"),
            output_tokens=usage.get("outputTokens"),
            total_tokens=usage.get("totalTokens"),
        )

        return reply_text
