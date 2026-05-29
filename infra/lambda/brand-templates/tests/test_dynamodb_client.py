"""
Unit tests for dynamodb_client.py backed by moto's DynamoDB mock.

No AWS credentials are touched; moto intercepts all boto3 calls.
"""

from __future__ import annotations

import os

import boto3
import pytest
from moto import mock_aws

from dynamodb_client import BrandTemplatesDynamoClient  # type: ignore[import-not-found]


TABLE_NAME = "brand-templates-test"


@pytest.fixture(autouse=True)
def _aws_env(monkeypatch):
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-west-2")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test")


@pytest.fixture
def client():
    with mock_aws():
        dynamodb = boto3.resource("dynamodb", region_name="us-west-2")
        dynamodb.create_table(
            TableName=TABLE_NAME,
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
        yield BrandTemplatesDynamoClient(TABLE_NAME, dynamodb_resource=dynamodb)


SKILL_ID = "11111111-1111-4111-8111-111111111111"
JOB_ID = "22222222-2222-4222-8222-222222222222"
USER_ID = "cognito-sub-abc"


def _valid_extracted_tokens() -> dict:
    return {
        "register": {
            "kind": "brand",
            "rationale": "Editorial long-form surface; design IS the product.",
        },
        "styleDescriptor": {
            "label": "editorial",
            "rationale": "High-contrast type with generous whitespace.",
            "adjectives": ["editorial", "minimal", "confident"],
        },
        "colorStrategy": {
            "tier": "restrained",
            "accentCoveragePct": 6,
            "rationale": "Tinted neutrals carry the surface.",
        },
        "theme": {
            "mode": "dark",
            "sceneSentence": "Designer reading essays on a 14-inch laptop in a dim studio after dusk.",
            "rationale": "Dim-studio scene forces dark.",
        },
        "informationHierarchy": {
            "focalOrder": [
                {"rank": 1, "element": "Headline", "role": "Anchor"}
            ],
            "principles": ["Scale over color"],
        },
        "copyVoice": {
            "adjectives": ["confident", "editorial"],
            "case": "sentence",
            "density": "sparse",
            "forbidden": ["em-dashes"],
        },
        "palette": {
            "primary":    [{"hex": "#5e6ad2", "role": "primary"}],
            "accent":     [{"hex": "#f59e0b", "role": "accent"}],
            "background": [{"hex": "#0b0e16", "role": "background"}],
            "surface":    [{"hex": "#1f2633", "role": "surface"}],
            "text":       [{"hex": "#e6e8ec", "role": "text"}],
            "border":     [{"hex": "#262b36", "role": "border"}],
            "states":     [{"hex": "#3b82f6", "role": "state-hover"}],
        },
        "typography": {
            "families": {"sans": "Inter"},
            "scale": [
                {"name": "body", "fontFamily": "Inter", "fontSize": "16px",
                 "fontWeight": 400, "lineHeight": "1.5"}
            ],
            "principles": {
                "bodyLineLengthCh": 72,
                "scaleRatio": 1.333,
                "hierarchyStrategy": "Weight + scale contrast.",
            },
        },
        "borders": {"radius": {"md": "6px"}, "width": {"normal": "2px"}, "color": ["#262b36"]},
        "shadows": {"elevation": [{"name": "sm", "value": "0 1px 2px rgba(0,0,0,0.3)"}]},
        "spacing": {
            "base": "4px",
            "scale": {"md": "16px"},
            "rhythmRules": ["Cards use 24px padding; list rows use 8px"],
        },
        "motion": {
            "tokens": [{"name": "default", "duration": "180ms", "easing": "linear"}],
            "habits": ["Fades over translations"],
            "disallowedPatterns": ["bounce", "elastic", "layout-property-animation"],
        },
    }


# ---- writes --------------------------------------------------------------


def test_create_skill_record_writes_processing_state(client):
    client.create_skill_record(
        user_id=USER_ID,
        skill_id=SKILL_ID,
        job_id=JOB_ID,
        source="images",
        name="My skill",
        description="hi",
        tags=["a", "b"],
        source_images=["uploads/u/j/input-0.png"],
    )
    item = client.get_skill(user_id=USER_ID, skill_id=SKILL_ID)
    assert item is not None
    assert item["status"] == "processing"
    assert item["source"] == "images"
    assert item["name"] == "My skill"
    assert item["description"] == "hi"
    assert item["tags"] == ["a", "b"]
    assert item["schemaVersion"] == 2
    # Both keys hold the same value: jobId is the GSI partition key, and
    # extractionJobId is the frontend/schema field name. Writing both up
    # front lets the detail page poll by extractionJobId even while the
    # skill is still processing.
    assert item["jobId"] == JOB_ID
    assert item["extractionJobId"] == JOB_ID
    assert item["progress"]["stage"] == "queued"


def test_update_progress_sets_progress_map(client):
    client.create_skill_record(
        user_id=USER_ID, skill_id=SKILL_ID, job_id=JOB_ID,
        source="images", name="n",
    )
    client.update_progress(
        user_id=USER_ID, skill_id=SKILL_ID,
        stage="analysis", message="Analyzing typography", percent=40,
    )
    item = client.get_skill(user_id=USER_ID, skill_id=SKILL_ID)
    assert item["progress"] == {"stage": "analysis", "message": "Analyzing typography", "percent": 40}


def test_update_completion_writes_tokens_and_clears_progress(client):
    client.create_skill_record(
        user_id=USER_ID, skill_id=SKILL_ID, job_id=JOB_ID,
        source="images", name="n",
    )
    client.update_progress(user_id=USER_ID, skill_id=SKILL_ID, stage="x", message="y")

    skill = _valid_extracted_tokens()
    client.update_completion(user_id=USER_ID, skill_id=SKILL_ID, skill=skill)

    item = client.get_skill(user_id=USER_ID, skill_id=SKILL_ID)
    assert item["status"] == "ready"
    assert item["styleDescriptor"]["label"] == "editorial"
    assert item["palette"]["primary"][0]["hex"] == "#5e6ad2"
    assert item["shadows"]["elevation"][0]["value"] == "0 1px 2px rgba(0,0,0,0.3)"
    assert "progress" not in item
    assert "error" not in item


def test_update_completion_preserves_identity_fields(client):
    client.create_skill_record(
        user_id=USER_ID, skill_id=SKILL_ID, job_id=JOB_ID,
        source="images", name="Before",
    )
    client.update_completion(
        user_id=USER_ID, skill_id=SKILL_ID, skill=_valid_extracted_tokens(),
    )
    item = client.get_skill(user_id=USER_ID, skill_id=SKILL_ID)
    assert item["skillId"] == SKILL_ID
    assert item["userId"] == USER_ID
    assert item["name"] == "Before"  # completion doesn't mutate metadata


def test_mark_failed_sets_error_and_clears_progress(client):
    client.create_skill_record(
        user_id=USER_ID, skill_id=SKILL_ID, job_id=JOB_ID,
        source="url", name="n",
    )
    client.update_progress(user_id=USER_ID, skill_id=SKILL_ID, stage="x", message="y")
    client.mark_failed(
        user_id=USER_ID, skill_id=SKILL_ID,
        code="extraction_error", message="Bedrock returned invalid JSON.",
    )
    item = client.get_skill(user_id=USER_ID, skill_id=SKILL_ID)
    assert item["status"] == "failed"
    # Minimum payload: code + message + failedAt (always stamped).
    assert item["error"]["code"] == "extraction_error"
    assert item["error"]["message"] == "Bedrock returned invalid JSON."
    assert "failedAt" in item["error"]
    # Optional fields are absent when not supplied.
    assert "detail" not in item["error"]
    assert "requestId" not in item["error"]
    assert "progress" not in item


def test_mark_failed_with_detail_and_request_id(client):
    client.create_skill_record(
        user_id=USER_ID, skill_id=SKILL_ID, job_id=JOB_ID,
        source="url", name="n",
    )
    client.mark_failed(
        user_id=USER_ID, skill_id=SKILL_ID,
        code="internal_error",
        message="Extraction failed due to an internal error.",
        detail="ResourceNotFoundException",
        request_id="fb8b3ab4-7066-49c6-bd39-48289cf67d44",
    )
    item = client.get_skill(user_id=USER_ID, skill_id=SKILL_ID)
    assert item["error"]["detail"] == "ResourceNotFoundException"
    assert item["error"]["requestId"] == "fb8b3ab4-7066-49c6-bd39-48289cf67d44"
    assert "failedAt" in item["error"]


def test_patch_metadata_updates_allowed_fields(client):
    client.create_skill_record(
        user_id=USER_ID, skill_id=SKILL_ID, job_id=JOB_ID,
        source="images", name="Old",
    )
    updated = client.patch_metadata(
        user_id=USER_ID, skill_id=SKILL_ID,
        patch={"name": "New", "tags": ["brand"]},
    )
    assert updated["name"] == "New"
    assert updated["tags"] == ["brand"]


def test_patch_metadata_rejects_other_fields(client):
    client.create_skill_record(
        user_id=USER_ID, skill_id=SKILL_ID, job_id=JOB_ID,
        source="images", name="n",
    )
    with pytest.raises(ValueError):
        client.patch_metadata(
            user_id=USER_ID, skill_id=SKILL_ID,
            patch={"palette": {}},
        )


def test_delete_skill_removes_row(client):
    client.create_skill_record(
        user_id=USER_ID, skill_id=SKILL_ID, job_id=JOB_ID,
        source="images", name="n",
    )
    client.delete_skill(user_id=USER_ID, skill_id=SKILL_ID)
    assert client.get_skill(user_id=USER_ID, skill_id=SKILL_ID) is None


# ---- reads ---------------------------------------------------------------


def test_get_by_job_id_uses_gsi(client):
    client.create_skill_record(
        user_id=USER_ID, skill_id=SKILL_ID, job_id=JOB_ID,
        source="images", name="n",
    )
    found = client.get_by_job_id(job_id=JOB_ID)
    assert found is not None
    assert found["skillId"] == SKILL_ID


def test_get_by_job_id_returns_none_for_unknown(client):
    assert client.get_by_job_id(job_id="00000000-0000-4000-8000-000000000000") is None


def test_list_skills_returns_summary_projection(client):
    client.create_skill_record(
        user_id=USER_ID, skill_id=SKILL_ID, job_id=JOB_ID,
        source="images", name="A",
    )
    client.update_completion(
        user_id=USER_ID, skill_id=SKILL_ID, skill=_valid_extracted_tokens(),
    )
    client.create_skill_record(
        user_id=USER_ID, skill_id="33333333-3333-4333-8333-333333333333",
        job_id="44444444-4444-4444-8444-444444444444",
        source="url", name="B",
    )

    summaries = client.list_skills(user_id=USER_ID)
    assert len(summaries) == 2
    summary_for_a = next(s for s in summaries if s["name"] == "A")
    assert summary_for_a["status"] == "ready"
    assert summary_for_a["styleDescriptorLabel"] == "editorial"
    assert "#5e6ad2" in summary_for_a["previewColors"]
    assert len(summary_for_a["previewColors"]) <= 5

    summary_for_b = next(s for s in summaries if s["name"] == "B")
    assert summary_for_b["status"] == "processing"
    assert summary_for_b["previewColors"] == []


def test_list_skills_empty_for_unknown_user(client):
    assert client.list_skills(user_id="nobody") == []
