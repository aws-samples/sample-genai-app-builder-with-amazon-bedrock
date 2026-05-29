"""
Integration tests for the Lambda handler. moto mocks S3 + DynamoDB + Lambda;
Bedrock is stubbed via a fake client; async self-invoke is replaced by a
direct call to the internal handler in tests so we can assert end state.
"""

from __future__ import annotations

import importlib
import json
import os
from typing import Any, Dict, List
from unittest.mock import MagicMock

import boto3
import pytest
from moto import mock_aws


TABLE = "brand-templates-test"
BUCKET = "brand-templates-bucket-test"


@pytest.fixture(autouse=True)
def _aws_env(monkeypatch):
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-west-2")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test")
    monkeypatch.setenv("BRAND_TEMPLATES_TABLE", TABLE)
    monkeypatch.setenv("BRAND_TEMPLATES_BUCKET", BUCKET)
    monkeypatch.setenv("AWS_LAMBDA_FUNCTION_NAME", "brand-templates-test-fn")


@pytest.fixture
def lf():
    """Fresh import of lambda_function with cleared module-level singletons."""
    with mock_aws():
        # Create AWS resources.
        ddb = boto3.resource("dynamodb", region_name="us-west-2")
        ddb.create_table(
            TableName=TABLE,
            KeySchema=[
                {"AttributeName": "userId", "KeyType": "HASH"},
                {"AttributeName": "skillId", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "userId", "AttributeType": "S"},
                {"AttributeName": "skillId", "AttributeType": "S"},
                {"AttributeName": "jobId", "AttributeType": "S"},
            ],
            GlobalSecondaryIndexes=[
                {
                    "IndexName": "jobId-index",
                    "KeySchema": [{"AttributeName": "jobId", "KeyType": "HASH"}],
                    "Projection": {"ProjectionType": "ALL"},
                }
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        boto3.client("s3", region_name="us-west-2").create_bucket(
            Bucket=BUCKET,
            CreateBucketConfiguration={"LocationConstraint": "us-west-2"},
        )

        import lambda_function  # type: ignore[import-not-found]
        importlib.reload(lambda_function)
        # Reset singletons so they rebind to the mocked AWS environment.
        lambda_function._s3 = None
        lambda_function._lambda = None
        lambda_function._ddb_client = None
        lambda_function._image_processor = None
        lambda_function._bedrock_client = None
        lambda_function._url_renderer = None

        # Swap in a Lambda stub that records invoke() calls instead of actually async-calling.
        invoke_mock = MagicMock()
        lambda_function._lambda = invoke_mock

        yield lambda_function, invoke_mock


USER_ID = "cognito-sub-abc"
OTHER_USER = "cognito-sub-xyz"


def _event(method: str, path: str, *, body: Any = None, user_id: str = USER_ID) -> Dict[str, Any]:
    return {
        "rawPath": path,
        "httpMethod": method,
        "requestContext": {
            "http": {"method": method},
            "authorizer": {"claims": {"sub": user_id}},
        },
        "body": json.dumps(body) if body is not None else None,
    }


def _body(resp: Dict[str, Any]) -> Dict[str, Any]:
    return json.loads(resp["body"])


# ---- upload-urls ---------------------------------------------------------


def test_upload_urls_returns_keys(lf):
    lambda_function, _ = lf
    resp = lambda_function.handler(
        _event(
            "POST", "/v1/brand-templates/upload-urls",
            body={
                "filenames": ["a.png", "b.jpg"],
                "contentTypes": ["image/png", "image/jpeg"],
            },
        ),
        None,
    )
    assert resp["statusCode"] == 200
    b = _body(resp)
    assert len(b["uploads"]) == 2
    assert "jobId" in b


def test_upload_urls_400_on_bad_extension(lf):
    lambda_function, _ = lf
    resp = lambda_function.handler(
        _event(
            "POST", "/v1/brand-templates/upload-urls",
            body={"filenames": ["evil.exe"], "contentTypes": ["application/octet-stream"]},
        ),
        None,
    )
    assert resp["statusCode"] == 400


def test_upload_urls_400_on_non_array(lf):
    lambda_function, _ = lf
    resp = lambda_function.handler(
        _event(
            "POST", "/v1/brand-templates/upload-urls",
            body={"filenames": "a.png", "contentTypes": ["image/png"]},
        ),
        None,
    )
    assert resp["statusCode"] == 400


# ---- create skill --------------------------------------------------------


def test_create_skill_images_returns_202_and_schedules_invoke(lf):
    lambda_function, invoke_mock = lf
    up = lambda_function.handler(
        _event("POST", "/v1/brand-templates/upload-urls",
               body={"filenames": ["a.png"], "contentTypes": ["image/png"]}),
        None,
    )
    job_id = _body(up)["jobId"]
    key = _body(up)["uploads"][0]["s3Key"]

    resp = lambda_function.handler(
        _event("POST", "/v1/brand-templates",
               body={
                   "name": "Editorial",
                   "source": "images",
                   "jobId": job_id,
                   "s3Keys": [key],
               }),
        None,
    )
    assert resp["statusCode"] == 202
    b = _body(resp)
    assert b["status"] == "processing"
    assert b["jobId"] == job_id
    assert "skillId" in b
    invoke_mock.invoke.assert_called_once()
    payload = json.loads(invoke_mock.invoke.call_args.kwargs["Payload"])
    assert payload["_internal_action"] == "process_extraction"


def test_create_skill_rejects_s3_key_for_other_user(lf):
    lambda_function, _ = lf
    # Key belongs to OTHER_USER.
    other_key = "uploads/cognito-sub-xyz/11111111-1111-4111-8111-111111111111/input-0.png"
    resp = lambda_function.handler(
        _event("POST", "/v1/brand-templates",
               body={
                   "name": "n",
                   "source": "images",
                   "jobId": "11111111-1111-4111-8111-111111111111",
                   "s3Keys": [other_key],
               }),
        None,
    )
    assert resp["statusCode"] == 400


def test_create_skill_rejects_http_url(lf):
    lambda_function, _ = lf
    resp = lambda_function.handler(
        _event("POST", "/v1/brand-templates",
               body={"name": "n", "source": "url", "url": "http://example.com"}),
        None,
    )
    assert resp["statusCode"] == 400


def test_create_skill_rejects_private_url(lf):
    lambda_function, invoke_mock = lf
    resp = lambda_function.handler(
        _event("POST", "/v1/brand-templates",
               body={"name": "n", "source": "url", "url": "https://169.254.169.254/"}),
        None,
    )
    assert resp["statusCode"] == 400
    invoke_mock.invoke.assert_not_called()


# ---- declared-token source ---------------------------------------------


def _valid_declared_body(**overrides):
    body = {
        "name": "OneAdvanced Corporate",
        "source": "declared",
        "tokens": {
            "palette": {
                "primary":    [{"hex": "#00205b", "role": "primary"}],
                "accent":     [{"hex": "#ffa300", "role": "accent"}],
                "background": [{"hex": "#ffffff", "role": "background"}],
                "surface":    [{"hex": "#f5f7fa", "role": "surface"}],
                "text":       [{"hex": "#1a1a1a", "role": "text"}],
                "border":     [{"hex": "#d5d8dc", "role": "border"}],
                "states":     [{"hex": "#002b7a", "role": "state-hover"}],
            },
        },
    }
    body.update(overrides)
    return body


def test_create_skill_declared_returns_200_ready_without_invoke(lf):
    lambda_function, invoke_mock = lf
    resp = lambda_function.handler(
        _event("POST", "/v1/brand-templates", body=_valid_declared_body()),
        None,
    )
    assert resp["statusCode"] == 200
    b = _body(resp)
    assert b["status"] == "ready"
    assert "skillId" in b
    assert "jobId" in b
    # Declared path must not schedule an async extraction.
    invoke_mock.invoke.assert_not_called()


def test_create_skill_declared_writes_schema_valid_record(lf):
    from schema import validate_brand_template  # type: ignore[import-not-found]

    lambda_function, _ = lf
    resp = lambda_function.handler(
        _event("POST", "/v1/brand-templates", body=_valid_declared_body()),
        None,
    )
    skill_id = _body(resp)["skillId"]

    get = lambda_function.handler(
        _event("GET", f"/v1/brand-templates/{skill_id}"),
        None,
    )
    assert get["statusCode"] == 200
    persisted = _body(get)
    # Round-trip the DDB view through the same validator the extractor uses.
    validate_brand_template(persisted)
    assert persisted["source"] == "declared"
    assert persisted["status"] == "ready"
    assert persisted["palette"]["primary"][0]["hex"] == "#00205b"


def test_create_skill_declared_rejects_missing_palette_bucket(lf):
    lambda_function, invoke_mock = lf
    body = _valid_declared_body()
    del body["tokens"]["palette"]["accent"]
    resp = lambda_function.handler(
        _event("POST", "/v1/brand-templates", body=body),
        None,
    )
    assert resp["statusCode"] == 400
    invoke_mock.invoke.assert_not_called()


def test_create_skill_declared_shows_in_list_as_ready(lf):
    lambda_function, _ = lf
    lambda_function.handler(
        _event("POST", "/v1/brand-templates",
               body=_valid_declared_body(name="Corp A")),
        None,
    )
    lambda_function.handler(
        _event("POST", "/v1/brand-templates",
               body=_valid_declared_body(name="Corp B")),
        None,
    )
    listed = lambda_function.handler(
        _event("GET", "/v1/brand-templates"),
        None,
    )
    assert listed["statusCode"] == 200
    items = _body(listed)["skills"]
    names = {s["name"] for s in items}
    assert names == {"Corp A", "Corp B"}
    for s in items:
        assert s["status"] == "ready"
        # Summary view carries preview colors sourced from the declared palette.
        assert "#00205b" in s["previewColors"]


# ---- status -------------------------------------------------------------


def test_status_returns_processing_after_create(lf):
    lambda_function, _ = lf
    up = lambda_function.handler(
        _event("POST", "/v1/brand-templates/upload-urls",
               body={"filenames": ["a.png"], "contentTypes": ["image/png"]}),
        None,
    )
    job_id = _body(up)["jobId"]
    key = _body(up)["uploads"][0]["s3Key"]
    lambda_function.handler(
        _event("POST", "/v1/brand-templates",
               body={"name": "n", "source": "images", "jobId": job_id, "s3Keys": [key]}),
        None,
    )
    status = lambda_function.handler(
        _event("GET", f"/v1/brand-templates/status/{job_id}"),
        None,
    )
    assert status["statusCode"] == 200
    assert _body(status)["status"] == "processing"


def test_status_404_for_unknown_job(lf):
    lambda_function, _ = lf
    status = lambda_function.handler(
        _event("GET", "/v1/brand-templates/status/00000000-0000-4000-8000-000000000000"),
        None,
    )
    assert status["statusCode"] == 404


def test_status_403_when_wrong_user(lf):
    lambda_function, _ = lf
    up = lambda_function.handler(
        _event("POST", "/v1/brand-templates/upload-urls",
               body={"filenames": ["a.png"], "contentTypes": ["image/png"]}),
        None,
    )
    job_id = _body(up)["jobId"]
    key = _body(up)["uploads"][0]["s3Key"]
    lambda_function.handler(
        _event("POST", "/v1/brand-templates",
               body={"name": "n", "source": "images", "jobId": job_id, "s3Keys": [key]}),
        None,
    )
    status = lambda_function.handler(
        _event("GET", f"/v1/brand-templates/status/{job_id}", user_id=OTHER_USER),
        None,
    )
    assert status["statusCode"] == 403


# ---- list / get / patch / delete / export -------------------------------


def test_list_returns_empty_for_new_user(lf):
    lambda_function, _ = lf
    resp = lambda_function.handler(_event("GET", "/v1/brand-templates"), None)
    assert resp["statusCode"] == 200
    assert _body(resp) == {"skills": []}


def test_patch_only_allows_metadata(lf):
    lambda_function, _ = lf
    # Seed a record directly.
    ddb = lambda_function._get_ddb()
    skill_id = "11111111-1111-4111-8111-111111111111"
    ddb.create_skill_record(
        user_id=USER_ID, skill_id=skill_id,
        job_id="22222222-2222-4222-8222-222222222222",
        source="images", name="Old name",
    )

    ok = lambda_function.handler(
        _event("PATCH", f"/v1/brand-templates/{skill_id}", body={"name": "New name"}),
        None,
    )
    assert ok["statusCode"] == 200
    assert _body(ok)["name"] == "New name"

    bad = lambda_function.handler(
        _event("PATCH", f"/v1/brand-templates/{skill_id}", body={"palette": {}}),
        None,
    )
    assert bad["statusCode"] == 400


def test_get_404_when_absent(lf):
    lambda_function, _ = lf
    resp = lambda_function.handler(
        _event("GET", "/v1/brand-templates/11111111-1111-4111-8111-111111111111"),
        None,
    )
    assert resp["statusCode"] == 404


def test_delete_removes_record(lf):
    lambda_function, _ = lf
    skill_id = "11111111-1111-4111-8111-111111111111"
    lambda_function._get_ddb().create_skill_record(
        user_id=USER_ID, skill_id=skill_id,
        job_id="22222222-2222-4222-8222-222222222222",
        source="images", name="n",
    )
    resp = lambda_function.handler(
        _event("DELETE", f"/v1/brand-templates/{skill_id}"), None,
    )
    assert resp["statusCode"] == 200
    follow = lambda_function.handler(
        _event("GET", f"/v1/brand-templates/{skill_id}"), None,
    )
    assert follow["statusCode"] == 404


def test_export_sets_content_disposition(lf):
    lambda_function, _ = lf
    skill_id = "11111111-1111-4111-8111-111111111111"
    lambda_function._get_ddb().create_skill_record(
        user_id=USER_ID, skill_id=skill_id,
        job_id="22222222-2222-4222-8222-222222222222",
        source="images", name="Exportable",
    )
    resp = lambda_function.handler(
        _event("GET", f"/v1/brand-templates/{skill_id}/export"), None,
    )
    assert resp["statusCode"] == 200
    assert "attachment" in resp["headers"].get("Content-Disposition", "")


def test_options_preflight_returns_204(lf):
    lambda_function, _ = lf
    resp = lambda_function.handler(_event("OPTIONS", "/v1/brand-templates"), None)
    assert resp["statusCode"] == 204


def test_unknown_route_returns_404(lf):
    lambda_function, _ = lf
    resp = lambda_function.handler(_event("GET", "/v1/unrelated"), None)
    assert resp["statusCode"] == 404


# ---- auth gate (defense-in-depth) ---------------------------------------


def test_unauthenticated_request_returns_401(lf):
    """No Cognito claims and no identity.cognitoIdentityId → 401, not anonymous."""
    lambda_function, invoke_mock = lf
    resp = lambda_function.handler(
        {
            "rawPath": "/v1/brand-templates",
            "httpMethod": "GET",
            "requestContext": {"http": {"method": "GET"}},
            "body": None,
        },
        None,
    )
    assert resp["statusCode"] == 401
    # Mutating routes also reject without ever invoking downstream.
    assert invoke_mock.invoke.call_count == 0


def test_unauthenticated_create_skill_does_not_pool_writes(lf):
    """A POST without auth must not create a record under a shared namespace."""
    lambda_function, invoke_mock = lf
    resp = lambda_function.handler(
        {
            "rawPath": "/v1/brand-templates",
            "httpMethod": "POST",
            "requestContext": {"http": {"method": "POST"}},
            "body": json.dumps(
                {
                    "name": "x",
                    "source": "url",
                    "url": "https://example.com",
                }
            ),
        },
        None,
    )
    assert resp["statusCode"] == 401
    assert invoke_mock.invoke.call_count == 0


# ---- async invoke failure (data-integrity guard) -------------------------


def test_create_skill_marks_failed_when_async_invoke_throws(lf):
    """If Lambda.invoke() throws, the just-created DDB row must be marked failed.

    Without this guard, a transient throttling/IAM error during create would
    leave the record stuck in 'processing' forever — the polling loop would
    eventually time out client-side, but the row would persist as a ghost.
    """
    lambda_function, invoke_mock = lf
    invoke_mock.invoke.side_effect = RuntimeError("simulated throttle")

    resp = lambda_function.handler(
        _event(
            "POST", "/v1/brand-templates",
            body={"name": "Test", "source": "url", "url": "https://example.com"},
        ),
        None,
    )
    assert resp["statusCode"] == 500

    # The record must exist (we wrote it) AND be marked failed (not stuck processing).
    list_resp = lambda_function.handler(_event("GET", "/v1/brand-templates"), None)
    skills = _body(list_resp)["skills"]
    assert len(skills) == 1
    assert skills[0]["status"] == "failed"
