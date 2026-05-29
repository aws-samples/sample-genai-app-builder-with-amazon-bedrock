"""
Brand Templates Lambda handler.

Routes:
    POST   /v1/brand-templates/upload-urls      generate presigned PUT URLs
    POST   /v1/brand-templates                  start extraction (images|url)
    GET    /v1/brand-templates                  list summaries
    GET    /v1/brand-templates/status/{jobId}   poll extraction status
    GET    /v1/brand-templates/{skillId}        fetch full skill
    PATCH  /v1/brand-templates/{skillId}        update metadata (name/desc/tags)
    DELETE /v1/brand-templates/{skillId}        delete skill + S3 prefix
    GET    /v1/brand-templates/{skillId}/export download skill.json

Plus an internal self-invoke branch (`_internal_action == 'process_extraction'`)
that owns the async Bedrock call and writes the final DDB state.

Errors never leak raw exception text to clients — the `_ERROR_MESSAGES` map
below defines stable, user-safe messages keyed by handler.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, Optional

import boto3

from bedrock_client import BedrockConverseClient
from declared_template_builder import build_declared_template
from brand_template_extractor import BrandTemplateExtractor, ExtractionError
from dynamodb_client import BrandTemplatesDynamoClient
from image_processor import BrandTemplatesImageProcessor
from schema import (
    SchemaValidationError,
    validate_create_request,
    validate_brand_template,
    validate_patch_request,
)
from url_renderer import (
    UrlFetchError,
    UrlRejectedError,
    UrlRenderer,
    extract_css_tokens,
)


_ERROR_MESSAGES = {
    "upload_urls": "Failed to generate upload URLs.",
    "create_skill": "Failed to create brand template.",
    "status": "Failed to retrieve extraction status.",
    "list_skills": "Failed to list brand templates.",
    "get_skill": "Failed to retrieve brand template.",
    "patch_skill": "Failed to update brand template.",
    "delete_skill": "Failed to delete brand template.",
    "export_skill": "Failed to export brand template.",
    "url_fetch": "Failed to fetch the provided URL. Ensure it is a public, reachable HTTPS page.",
    "route": "Internal server error.",
}


_BUCKET = os.environ.get("BRAND_TEMPLATES_BUCKET")
_TABLE = os.environ.get("BRAND_TEMPLATES_TABLE")
# AWS_LAMBDA_FUNCTION_NAME is set by the Lambda runtime; the env-var
# fallback covers local invocations only. Validated at first self-invoke.
_FUNCTION_NAME = os.environ.get("AWS_LAMBDA_FUNCTION_NAME")
_CORS_ORIGIN = os.environ.get("CORS_ORIGIN", "*")

_S3_KEY_RE = re.compile(
    r"^uploads/(?P<user_id>[^/]+)/(?P<job_id>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/input-\d+\.(png|jpg|jpeg|webp)$"
)


# Clients are initialized lazily so tests can inject their own.
_s3 = None
_lambda = None
_ddb_client: Optional[BrandTemplatesDynamoClient] = None
_image_processor: Optional[BrandTemplatesImageProcessor] = None
_bedrock_client: Optional[BedrockConverseClient] = None
_url_renderer: Optional[UrlRenderer] = None


def _get_s3():
    global _s3
    if _s3 is None:
        from botocore.config import Config
        # Force SigV4 + regional virtual-hosted addressing so presigned URLs
        # land on <bucket>.s3.<region>.amazonaws.com rather than the legacy
        # <bucket>.s3.amazonaws.com, which 500s on CORS preflight.
        region = (
            os.environ.get("AWS_REGION")
            or os.environ.get("AWS_DEFAULT_REGION")
            or "us-west-2"
        )
        _s3 = boto3.client(
            "s3",
            region_name=region,
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": "virtual"},
            ),
        )
    return _s3


def _require_env(name: str, value: Optional[str]) -> str:
    if not value:
        raise RuntimeError(
            f"{name} env var is not set; refusing to operate on a default. "
            "This indicates a misdeployed stack."
        )
    return value


def _get_lambda():
    global _lambda
    if _lambda is None:
        _lambda = boto3.client("lambda")
    return _lambda


def _get_ddb() -> BrandTemplatesDynamoClient:
    global _ddb_client
    if _ddb_client is None:
        _ddb_client = BrandTemplatesDynamoClient(_require_env("BRAND_TEMPLATES_TABLE", _TABLE))
    return _ddb_client


def _get_image_processor() -> BrandTemplatesImageProcessor:
    global _image_processor
    if _image_processor is None:
        _image_processor = BrandTemplatesImageProcessor(
            s3_client=_get_s3(),
            bucket_name=_require_env("BRAND_TEMPLATES_BUCKET", _BUCKET),
        )
    return _image_processor


def _get_bedrock() -> BedrockConverseClient:
    global _bedrock_client
    if _bedrock_client is None:
        _bedrock_client = BedrockConverseClient()
    return _bedrock_client


def _get_url_renderer() -> UrlRenderer:
    global _url_renderer
    if _url_renderer is None:
        _url_renderer = UrlRenderer()
    return _url_renderer


class _DecimalEncoder(json.JSONEncoder):
    def default(self, obj):  # noqa: D401
        if isinstance(obj, Decimal):
            return int(obj) if obj % 1 == 0 else float(obj)
        return super().default(obj)


def _cors_headers() -> Dict[str, str]:
    return {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": _CORS_ORIGIN,
        "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Amz-Security-Token",
        "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    }


def _json_response(status: int, body: Any, extra_headers: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    headers = _cors_headers()
    if extra_headers:
        headers.update(extra_headers)
    return {
        "statusCode": status,
        "headers": headers,
        "body": json.dumps(body, cls=_DecimalEncoder),
    }


def _error(status: int, key: str) -> Dict[str, Any]:
    return _json_response(status, {"error": _ERROR_MESSAGES.get(key, _ERROR_MESSAGES["route"])})


def _get_user_id(event: Dict[str, Any]) -> Optional[str]:
    """
    Extract the caller's user id from the API Gateway event.

    Returns None when neither the Cognito authorizer claims nor the
    `identity.cognitoIdentityId` field are populated. Callers MUST treat
    None as unauthenticated and reject the request with 401 — never fall
    back to a shared namespace such as "anonymous", which would let any
    unauthenticated caller mutate a shared bucket of skills.

    Defense-in-depth: the API Gateway Cognito authorizer is the primary
    gate, but a misconfigured route or a future event-shape change must
    fail closed here rather than silently pooling writes.
    """
    ctx = event.get("requestContext") or {}
    claims = (ctx.get("authorizer") or {}).get("claims") or {}
    user_id = claims.get("sub")
    if user_id:
        return user_id
    identity = ctx.get("identity") or {}
    return identity.get("cognitoIdentityId") or None


def _parse_body(event: Dict[str, Any]) -> Dict[str, Any]:
    raw = event.get("body") or "{}"
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}


def _normalize_path(event: Dict[str, Any]) -> str:
    path = event.get("rawPath", event.get("path", "")) or ""
    if path.startswith("/api/"):
        path = path[4:]
    return path


def _method(event: Dict[str, Any]) -> str:
    http = (event.get("requestContext") or {}).get("http") or {}
    return http.get("method") or event.get("httpMethod", "GET")


# ---- handler --------------------------------------------------------------


def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    if event.get("_internal_action") == "process_extraction":
        return _handle_async_extraction(event, context)

    path = _normalize_path(event)
    method = _method(event)

    try:
        if method == "OPTIONS":
            return {"statusCode": 204, "headers": _cors_headers(), "body": ""}

        # Defense in depth: API Gateway's Cognito authorizer is the primary
        # gate, but if it is misconfigured or the event shape changes, every
        # mutating route would otherwise pool writes under a shared namespace.
        # Reject up front so no downstream handler ever runs unauthenticated.
        if _get_user_id(event) is None:
            return _json_response(401, {"error": "Unauthorized."})

        if path == "/v1/brand-templates/upload-urls" and method == "POST":
            return _handle_upload_urls(event)
        if path == "/v1/brand-templates" and method == "POST":
            return _handle_create_skill(event)
        if path == "/v1/brand-templates" and method == "GET":
            return _handle_list_skills(event)
        if path.startswith("/v1/brand-templates/status/") and method == "GET":
            return _handle_status(event, path)
        if path.endswith("/export") and path.startswith("/v1/brand-templates/") and method == "GET":
            return _handle_export(event, path)

        m = re.fullmatch(r"/v1/brand-templates/(?P<skill_id>[^/]+)", path)
        if m:
            skill_id = m.group("skill_id")
            if method == "GET":
                return _handle_get_skill(event, skill_id)
            if method == "PATCH":
                return _handle_patch_skill(event, skill_id)
            if method == "DELETE":
                return _handle_delete_skill(event, skill_id)

        return _json_response(404, {"error": "Not found."})
    except Exception as err:  # noqa: BLE001 - last-resort sanitizer
        print(f"Unhandled error for {method} {path}: {err}")
        return _error(500, "route")


# ---- route handlers -------------------------------------------------------


def _handle_upload_urls(event: Dict[str, Any]) -> Dict[str, Any]:
    try:
        body = _parse_body(event)
        filenames = body.get("filenames")
        content_types = body.get("contentTypes")
        if not isinstance(filenames, list) or not isinstance(content_types, list):
            return _json_response(400, {"error": "filenames and contentTypes must be arrays."})

        user_id = _get_user_id(event)
        uploads, job_id = _get_image_processor().create_upload_urls(
            user_id=user_id,
            filenames=filenames,
            content_types=content_types,
        )
        return _json_response(200, {"jobId": job_id, "uploads": uploads})
    except ValueError as e:
        return _json_response(400, {"error": str(e)})
    except Exception as e:  # noqa: BLE001
        print(f"upload-urls error: {e}")
        return _error(500, "upload_urls")


def _handle_create_skill(event: Dict[str, Any]) -> Dict[str, Any]:
    try:
        body = _parse_body(event)
        try:
            validate_create_request(body)
        except SchemaValidationError as e:
            return _json_response(400, {"error": e.message})

        user_id = _get_user_id(event)
        skill_id = str(uuid.uuid4())
        source = body["source"]

        # Declared-token skills skip Bedrock entirely and land in one PutItem.
        if source == "declared":
            return _handle_create_declared(user_id=user_id, body=body)

        if source == "images":
            job_id = body["jobId"]
            s3_keys = list(body["s3Keys"])
            # Defense in depth: keys must be under this user's uploads prefix.
            for key in s3_keys:
                m = _S3_KEY_RE.match(key)
                if not m or m.group("user_id") != user_id or m.group("job_id") != job_id:
                    return _json_response(400, {"error": "Invalid s3Keys for this user/job."})
            source_url = None
        else:
            job_id = str(uuid.uuid4())
            s3_keys = []
            source_url = body["url"]
            # Early SSRF check so we can reject before persisting a record.
            try:
                _get_url_renderer().validate(source_url)
            except UrlRejectedError as e:
                return _json_response(400, {"error": str(e)})

        _get_ddb().create_skill_record(
            user_id=user_id,
            skill_id=skill_id,
            job_id=job_id,
            source=source,
            name=body["name"],
            description=body.get("description"),
            tags=body.get("tags"),
            source_images=s3_keys or None,
            source_url=source_url,
        )

        # Kick off async extraction. If the invoke itself fails (throttling,
        # transient network, IAM regression after a redeploy), the DDB row
        # we just wrote would otherwise sit in `processing` forever — the
        # status endpoint would keep returning "processing" until the user
        # times out the polling loop. Mark the record failed before
        # surfacing the error so the UI can show a useful message and the
        # user can retry without an orphan record.
        try:
            _get_lambda().invoke(
                FunctionName=_require_env("AWS_LAMBDA_FUNCTION_NAME", _FUNCTION_NAME),
                InvocationType="Event",
                Payload=json.dumps(
                    {
                        "_internal_action": "process_extraction",
                        "user_id": user_id,
                        "skill_id": skill_id,
                        "job_id": job_id,
                        "source": source,
                        "s3_keys": s3_keys,
                        "source_url": source_url,
                    }
                ),
            )
        except Exception as invoke_err:  # noqa: BLE001
            print(f"create-skill async invoke failed for skill_id={skill_id}: {invoke_err}")
            try:
                _get_ddb().mark_failed(
                    user_id=user_id,
                    skill_id=skill_id,
                    code="extraction_dispatch_failed",
                    message="Could not start extraction. Please try again.",
                    detail=type(invoke_err).__name__,
                )
            except Exception as mark_err:  # noqa: BLE001
                print(f"create-skill mark_failed also failed for {skill_id}: {mark_err}")
            return _error(500, "create_skill")

        return _json_response(
            202,
            {"skillId": skill_id, "jobId": job_id, "status": "processing"},
        )
    except Exception as e:  # noqa: BLE001
        print(f"create-skill error: {e}")
        return _error(500, "create_skill")


def _handle_create_declared(*, user_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """
    Synchronous creation for declared-token skills.

    No Bedrock. No self-invoke. One PutItem with status='ready'. The caller
    has already passed validate_create_request, so body['tokens'] is shaped;
    the builder produces a full BrandTemplate and we re-validate defensively
    before writing.
    """
    try:
        skill_id = str(uuid.uuid4())
        # jobId is kept for GSI parity with extracted skills, even though the
        # declared path never polls the /status endpoint.
        job_id = str(uuid.uuid4())
        now_iso = datetime.now(timezone.utc).isoformat()

        skill = build_declared_template(
            user_id=user_id,
            skill_id=skill_id,
            job_id=job_id,
            name=body["name"].strip(),
            description=body.get("description"),
            tags=body.get("tags"),
            tokens=body["tokens"],
            now_iso=now_iso,
        )

        # Belt-and-braces: the builder is covered by unit tests, but a bug there
        # should surface as a 500 rather than a silent corrupt DDB row.
        try:
            validate_brand_template(skill)
        except SchemaValidationError as e:
            print(f"declared-skill builder produced invalid output: {e}")
            return _error(500, "create_skill")

        _get_ddb().put_skill_record(skill)

        return _json_response(
            200,
            {"skillId": skill_id, "jobId": job_id, "status": "ready"},
        )
    except Exception as e:  # noqa: BLE001
        print(f"create-declared-skill error: {e}")
        return _error(500, "create_skill")


def _handle_status(event: Dict[str, Any], path: str) -> Dict[str, Any]:
    try:
        job_id = path.rsplit("/", 1)[-1]
        user_id = _get_user_id(event)
        record = _get_ddb().get_by_job_id(job_id=job_id)
        if not record:
            return _json_response(404, {"error": "Job not found."})
        if record.get("userId") != user_id:
            return _json_response(403, {"error": "Unauthorized."})

        response: Dict[str, Any] = {
            "status": record.get("status", "processing"),
            "skillId": record.get("skillId"),
        }
        if record.get("progress"):
            response["progress"] = record["progress"]
        if record.get("error"):
            response["error"] = record["error"]
        return _json_response(200, response)
    except Exception as e:  # noqa: BLE001
        print(f"status error: {e}")
        return _error(500, "status")


def _handle_list_skills(event: Dict[str, Any]) -> Dict[str, Any]:
    try:
        user_id = _get_user_id(event)
        summaries = _get_ddb().list_skills(user_id=user_id)
        return _json_response(200, {"skills": summaries})
    except Exception as e:  # noqa: BLE001
        print(f"list-skills error: {e}")
        return _error(500, "list_skills")


def _handle_get_skill(event: Dict[str, Any], skill_id: str) -> Dict[str, Any]:
    try:
        user_id = _get_user_id(event)
        record = _get_ddb().get_skill(user_id=user_id, skill_id=skill_id)
        if not record:
            return _json_response(404, {"error": "Skill not found."})
        return _json_response(200, record)
    except Exception as e:  # noqa: BLE001
        print(f"get-skill error: {e}")
        return _error(500, "get_skill")


def _handle_patch_skill(event: Dict[str, Any], skill_id: str) -> Dict[str, Any]:
    try:
        body = _parse_body(event)
        try:
            validate_patch_request(body)
        except SchemaValidationError as e:
            return _json_response(400, {"error": e.message})

        user_id = _get_user_id(event)
        # Ensure record exists (otherwise we get a ConditionalCheckFailed).
        if not _get_ddb().get_skill(user_id=user_id, skill_id=skill_id):
            return _json_response(404, {"error": "Skill not found."})
        updated = _get_ddb().patch_metadata(
            user_id=user_id, skill_id=skill_id, patch=body
        )
        return _json_response(200, updated)
    except Exception as e:  # noqa: BLE001
        print(f"patch-skill error: {e}")
        return _error(500, "patch_skill")


def _handle_delete_skill(event: Dict[str, Any], skill_id: str) -> Dict[str, Any]:
    try:
        user_id = _get_user_id(event)
        record = _get_ddb().get_skill(user_id=user_id, skill_id=skill_id)
        if not record:
            return _json_response(404, {"error": "Skill not found."})
        _get_ddb().delete_skill(user_id=user_id, skill_id=skill_id)
        _get_image_processor().delete_skill_prefix(user_id=user_id, skill_id=skill_id)
        return _json_response(200, {"ok": True})
    except Exception as e:  # noqa: BLE001
        print(f"delete-skill error: {e}")
        return _error(500, "delete_skill")


def _handle_export(event: Dict[str, Any], path: str) -> Dict[str, Any]:
    try:
        # path ends with /export; strip it.
        skill_id = path.rsplit("/", 2)[-2]
        user_id = _get_user_id(event)
        record = _get_ddb().get_skill(user_id=user_id, skill_id=skill_id)
        if not record:
            return _json_response(404, {"error": "Skill not found."})
        filename = f"brand-template-{skill_id}.json"
        return _json_response(
            200,
            record,
            extra_headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except Exception as e:  # noqa: BLE001
        print(f"export-skill error: {e}")
        return _error(500, "export_skill")


# ---- async extraction -----------------------------------------------------


def _handle_async_extraction(event: Dict[str, Any], context: Any = None) -> Dict[str, Any]:
    user_id = event["user_id"]
    skill_id = event["skill_id"]
    job_id = event["job_id"]
    source = event["source"]
    s3_keys = event.get("s3_keys") or []
    source_url = event.get("source_url")

    # Lambda request id is our correlation token between DDB, CloudWatch, and
    # the user's browser. Log it once with structure so `filter-log-events
    # --filter-pattern` can grep by skill_id or request_id straight away.
    request_id = getattr(context, "aws_request_id", None) or "unknown"
    _log_extraction_event(
        "extraction.start",
        request_id=request_id,
        user_id=user_id,
        skill_id=skill_id,
        job_id=job_id,
        source=source,
    )

    ddb = _get_ddb()
    image_processor = _get_image_processor()
    extractor = BrandTemplateExtractor(
        bedrock_client=_get_bedrock(),
        image_processor=image_processor,
    )

    try:
        if source == "images":
            ddb.update_progress(
                user_id=user_id, skill_id=skill_id,
                stage="load_images", message="Loading uploaded images...",
                percent=10,
            )
            images = [image_processor.download_image(s3_key=k) for k in s3_keys]
            new_keys = image_processor.copy_uploads_to_skill(
                user_id=user_id, skill_id=skill_id, source_keys=s3_keys,
            )
            ddb.update_progress(
                user_id=user_id, skill_id=skill_id,
                stage="analysis", message="Analyzing design tokens...",
                percent=40,
            )
            skill = extractor.extract(
                user_id=user_id, skill_id=skill_id, job_id=job_id,
                images=images, source="images",
                name=_record_name(ddb, user_id, skill_id),
                source_images_s3_keys=new_keys,
            )
        else:
            ddb.update_progress(
                user_id=user_id, skill_id=skill_id,
                stage="fetch_url", message="Fetching public URL...",
                percent=15,
            )
            url_renderer = _get_url_renderer()
            html, css_urls, final_url = url_renderer.fetch_html(source_url)
            stylesheets = url_renderer.fetch_stylesheets(css_urls)
            combined_css = "\n".join(stylesheets)
            css_tokens = extract_css_tokens(combined_css).to_dict()

            ddb.update_progress(
                user_id=user_id, skill_id=skill_id,
                stage="screenshot", message="Collecting palette seed...",
                percent=30,
            )
            screenshot_bytes = url_renderer.fetch_favicon_and_og(html, final_url)
            # Normalize whatever we got to PNG. Even with a MIME allowlist,
            # servers occasionally lie about Content-Type. This guards against
            # Pillow UnidentifiedImageError surfacing as an opaque 'internal
            # error' to the user — if we can't decode, we quietly fall back to
            # the palette-placeholder swatch and keep the extraction going.
            if screenshot_bytes:
                normalized = _normalize_to_png(screenshot_bytes)
                if normalized is None:
                    _log_extraction_event(
                        "extraction.screenshot_undecodable",
                        request_id=request_id,
                        skill_id=skill_id,
                        bytes_len=len(screenshot_bytes),
                    )
                    screenshot_bytes = None
                else:
                    screenshot_bytes = normalized

            if not screenshot_bytes:
                # No reachable OG / favicon — skip. Extractor needs at least one
                # image, so fall back to a neutral placeholder derived from CSS colors.
                screenshot_bytes = _palette_placeholder_png(css_tokens.get("colors") or [])

            screenshot_key = f"uploads/{user_id}/{job_id}/url-screenshot.png"
            image_processor.put_object(
                s3_key=screenshot_key, body=screenshot_bytes, content_type="image/png",
            )

            ddb.update_progress(
                user_id=user_id, skill_id=skill_id,
                stage="analysis", message="Analyzing design tokens...",
                percent=60,
            )
            skill = extractor.extract(
                user_id=user_id, skill_id=skill_id, job_id=job_id,
                images=[screenshot_bytes], source="url",
                name=_record_name(ddb, user_id, skill_id),
                source_url=source_url,
                source_resolved_url=final_url,
                source_screenshot_key=screenshot_key,
                css_token_prior=css_tokens,
            )

        ddb.update_progress(
            user_id=user_id, skill_id=skill_id,
            stage="finalize", message="Saving skill...", percent=90,
        )

        # Render and store the preview swatch for gallery cards.
        preview_hexes = _top_palette_hexes(skill)
        preview_png = image_processor.render_preview_swatch(preview_hexes)
        image_processor.put_object(
            s3_key=f"skills/{user_id}/{skill_id}/preview.png",
            body=preview_png,
            content_type="image/png",
        )
        image_processor.put_object(
            s3_key=f"skills/{user_id}/{skill_id}/skill.json",
            body=json.dumps(skill).encode("utf-8"),
            content_type="application/json",
        )

        ddb.update_completion(user_id=user_id, skill_id=skill_id, skill=skill)
        return {"status": "ready", "skillId": skill_id, "jobId": job_id}

    except UrlRejectedError as e:
        detail = type(e).__name__
        _log_extraction_event(
            "extraction.failed",
            request_id=request_id,
            skill_id=skill_id,
            code="url_rejected",
            detail=detail,
            error=str(e),
        )
        ddb.mark_failed(
            user_id=user_id, skill_id=skill_id,
            code="url_rejected", message=str(e),
            detail=detail, request_id=request_id,
        )
        return {"status": "failed", "skillId": skill_id, "jobId": job_id}
    except UrlFetchError as e:
        detail = type(e).__name__
        _log_extraction_event(
            "extraction.failed",
            request_id=request_id,
            skill_id=skill_id,
            code="url_fetch_error",
            detail=detail,
            error=str(e),
        )
        ddb.mark_failed(
            user_id=user_id, skill_id=skill_id,
            code="url_fetch_error", message=_ERROR_MESSAGES["url_fetch"],
            detail=detail, request_id=request_id,
        )
        return {"status": "failed", "skillId": skill_id, "jobId": job_id}
    except ExtractionError as e:
        detail = type(e).__name__
        _log_extraction_event(
            "extraction.failed",
            request_id=request_id,
            skill_id=skill_id,
            code="extraction_error",
            detail=detail,
            error=str(e),
        )
        ddb.mark_failed(
            user_id=user_id, skill_id=skill_id,
            code="extraction_error",
            message="Could not extract a coherent brand template. Try different inputs.",
            detail=detail, request_id=request_id,
        )
        return {"status": "failed", "skillId": skill_id, "jobId": job_id}
    except Exception as e:  # noqa: BLE001
        # Catch-all: the generic message stays sanitized, but we surface the
        # exception class name as `detail` because class names aren't
        # sensitive and they let support (and the user) tell "Bedrock model
        # retired" from "S3 access denied" from "SchemaValidationError"
        # without paging anyone. The real message still hits CloudWatch.
        detail = type(e).__name__
        _log_extraction_event(
            "extraction.failed",
            request_id=request_id,
            skill_id=skill_id,
            code="internal_error",
            detail=detail,
            error=str(e),
        )
        ddb.mark_failed(
            user_id=user_id, skill_id=skill_id,
            code="internal_error",
            message="Extraction failed due to an internal error.",
            detail=detail, request_id=request_id,
        )
        return {"status": "failed", "skillId": skill_id, "jobId": job_id}


# ---- helpers --------------------------------------------------------------


def _record_name(ddb: BrandTemplatesDynamoClient, user_id: str, skill_id: str) -> str:
    record = ddb.get_skill(user_id=user_id, skill_id=skill_id) or {}
    return record.get("name") or "Untitled skill"


def _log_extraction_event(event: str, **fields: Any) -> None:
    """
    Emit a single structured log line per extraction lifecycle step.

    Why this pattern:
      - CloudWatch Logs Insights can parse JSON lines out of the box.
      - The browser shows the request_id in the failure UI; a user pastes
        it into a support ticket and we grep the log group for that exact
        string — one filter gets the whole pipeline for that request.
      - Keeps us from sprinkling ad-hoc `print(...)` calls that aren't
        searchable without a human parsing the unstructured text.

    Example query:
        fields @timestamp, @message
        | filter requestId = "fb8b3ab4-7066-49c6-bd39-48289cf67d44"
        | sort @timestamp desc
    """
    payload = {"event": event, **{k: v for k, v in fields.items() if v is not None}}
    print(json.dumps(payload, default=str))


def _top_palette_hexes(skill: Dict[str, Any], limit: int = 5) -> list:
    palette = skill.get("palette") or {}
    out = []
    for bucket in ("primary", "accent", "background", "surface", "text"):
        for tok in palette.get(bucket) or []:
            hex_val = tok.get("hex") if isinstance(tok, dict) else None
            if hex_val and hex_val not in out:
                out.append(hex_val)
            if len(out) >= limit:
                return out
    return out


def _palette_placeholder_png(hex_colors: list) -> bytes:
    """Render a fallback swatch PNG when no OG/favicon is reachable."""
    from image_processor import BrandTemplatesImageProcessor
    # Use the image processor's render method via the module-level singleton.
    processor = _get_image_processor()
    if hex_colors:
        return processor.render_preview_swatch(hex_colors[:5])
    return processor.render_preview_swatch(["#5e6ad2"])


def _normalize_to_png(image_bytes: bytes) -> Optional[bytes]:
    """
    Decode any raster bytes with Pillow and re-encode as PNG.

    Returns None on decode failure so the caller can fall back instead of
    raising. Servers sometimes send image/webp with a PNG Content-Type, or
    ship a truncated OG image; neither should kill the whole extraction.
    """
    import io
    try:
        from PIL import Image, UnidentifiedImageError
    except ImportError:  # pragma: no cover
        return None

    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            # Convert to RGB so palette modes (L, P, RGBA with transparency
            # on a non-PNG target) round-trip cleanly.
            if img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGB")
            out = io.BytesIO()
            img.save(out, format="PNG")
            return out.getvalue()
    except (UnidentifiedImageError, OSError, ValueError):
        return None
