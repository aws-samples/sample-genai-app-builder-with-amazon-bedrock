"""
DynamoDB client for the Brand Templates Lambda.

Owns every write to the BrandTemplates table. Converts floats → Decimal at write
time and Decimal → float/int at read time so HTTP responses carry native JSON
numbers. `patch_metadata` whitelists fields at the call site to prevent any
token attribute from being mutated via the HTTP surface.
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Mapping, Optional

import boto3


_METADATA_FIELDS = frozenset({"name", "description", "tags"})

_SUMMARY_FIELDS = [
    "skillId",
    "name",
    "description",
    "tags",
    "status",
    "createdAt",
    "styleDescriptor",
    "palette",
]


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _to_ddb(obj: Any) -> Any:
    """Recursively convert floats to Decimal for DynamoDB safety."""
    if isinstance(obj, float):
        return Decimal(str(obj))
    if isinstance(obj, dict):
        return {k: _to_ddb(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_to_ddb(v) for v in obj]
    return obj


def _from_ddb(obj: Any) -> Any:
    """Recursively convert Decimal back to int/float for JSON responses."""
    if isinstance(obj, Decimal):
        return int(obj) if obj % 1 == 0 else float(obj)
    if isinstance(obj, dict):
        return {k: _from_ddb(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_from_ddb(v) for v in obj]
    return obj


class BrandTemplatesDynamoClient:
    """Wraps the BrandTemplates table."""

    def __init__(self, table_name: str, dynamodb_resource=None) -> None:
        self._table_name = table_name
        self._dynamodb = dynamodb_resource or boto3.resource("dynamodb")
        self._table = self._dynamodb.Table(table_name)

    # ---- writes ------------------------------------------------------------

    def create_skill_record(
        self,
        *,
        user_id: str,
        skill_id: str,
        job_id: str,
        source: str,
        name: str,
        description: Optional[str] = None,
        tags: Optional[List[str]] = None,
        source_images: Optional[List[str]] = None,
        source_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Insert a row in `processing` state. Returns the written item."""
        now = _now_iso()
        item: Dict[str, Any] = {
            "userId": user_id,
            "skillId": skill_id,
            # Two names for the same value: `jobId` is the GSI partition key
            # (reads via get_by_job_id), `extractionJobId` is the field name
            # the schema + frontend consume. Populating both up front means
            # the detail page can poll by extractionJobId even while the skill
            # is still in 'processing' state and hasn't yet been merged with
            # the extractor's output.
            "jobId": job_id,
            "extractionJobId": job_id,
            "name": name,
            "status": "processing",
            "source": source,
            "createdAt": now,
            "updatedAt": now,
            "schemaVersion": 2,
            "progress": {"stage": "queued", "message": "Queued for extraction."},
        }
        if description:
            item["description"] = description
        if tags:
            item["tags"] = list(tags)
        if source_images:
            item["sourceImages"] = list(source_images)
        if source_url:
            item["sourceUrl"] = source_url

        self._table.put_item(Item=_to_ddb(item))
        return item

    def update_progress(
        self,
        *,
        user_id: str,
        skill_id: str,
        stage: str,
        message: str,
        percent: Optional[int] = None,
    ) -> None:
        progress: Dict[str, Any] = {"stage": stage, "message": message}
        if percent is not None:
            progress["percent"] = int(percent)
        self._table.update_item(
            Key={"userId": user_id, "skillId": skill_id},
            UpdateExpression="SET progress = :p, updatedAt = :u",
            ExpressionAttributeValues={":p": progress, ":u": _now_iso()},
        )

    def update_completion(
        self,
        *,
        user_id: str,
        skill_id: str,
        skill: Mapping[str, Any],
    ) -> None:
        """
        Mark the record `ready` and store every token attribute atomically.

        `skill` must be the validated BrandTemplate dict (see schema.py). We write
        only the token/descriptor attributes — identity and provenance are
        already set by create_skill_record.
        """
        token_fields = (
            "register",
            "styleDescriptor",
            "colorStrategy",
            "theme",
            "informationHierarchy",
            "antiReferences",
            "copyVoice",
            "palette",
            "typography",
            "borders",
            "shadows",
            "spacing",
            "motion",
            "exemplars",
            "sourceResolvedUrl",
            "sourceScreenshotKey",
        )
        sets = ["#status = :status", "updatedAt = :updated"]
        names: Dict[str, str] = {"#status": "status"}
        values: Dict[str, Any] = {":status": "ready", ":updated": _now_iso()}
        removes = ["progress", "#error"]
        names["#error"] = "error"

        for field in token_fields:
            if field in skill and skill[field] is not None:
                placeholder = f":v_{field}"
                sets.append(f"{field} = {placeholder}")
                values[placeholder] = _to_ddb(skill[field])

        expr = "SET " + ", ".join(sets) + " REMOVE " + ", ".join(removes)
        self._table.update_item(
            Key={"userId": user_id, "skillId": skill_id},
            UpdateExpression=expr,
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )

    def mark_failed(
        self,
        *,
        user_id: str,
        skill_id: str,
        code: str,
        message: str,
        detail: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> None:
        """
        Set status='failed' plus a structured error payload.

        `detail` and `request_id` are safe to surface in the UI. `detail`
        should be a short, non-sensitive string (typically an exception
        class name); do not stuff raw exception messages here — those can
        leak PII, SQL fragments, or stack traces. `request_id` lets users
        paste it into a support request; we use it as the CloudWatch
        correlation key too.
        """
        now = _now_iso()
        error_payload: Dict[str, Any] = {
            "code": code,
            "message": message,
            "failedAt": now,
        }
        if detail:
            error_payload["detail"] = detail
        if request_id:
            error_payload["requestId"] = request_id

        self._table.update_item(
            Key={"userId": user_id, "skillId": skill_id},
            UpdateExpression="SET #status = :s, updatedAt = :u, #e = :err REMOVE progress",
            ExpressionAttributeNames={"#status": "status", "#e": "error"},
            ExpressionAttributeValues={
                ":s": "failed",
                ":u": now,
                ":err": error_payload,
            },
        )

    def put_skill_record(self, skill: Mapping[str, Any]) -> None:
        """
        Write a complete skill in one PutItem.

        Used by the declared-token path: declared skills never pass through the
        two-step 'processing -> ready' state, so there is no create + update
        split. The caller guarantees the dict has already been validated by
        schema.validate_brand_template; we just stamp it to DDB.

        Any keys whose values are None are dropped so we don't persist NULL
        attributes that would trip validation on read-back.
        """
        item = {k: v for k, v in skill.items() if v is not None}
        self._table.put_item(Item=_to_ddb(item))

    def patch_metadata(
        self,
        *,
        user_id: str,
        skill_id: str,
        patch: Mapping[str, Any],
    ) -> Dict[str, Any]:
        """Update only name/description/tags. Raises if any other field is supplied."""
        unknown = set(patch.keys()) - _METADATA_FIELDS
        if unknown:
            raise ValueError(f"Cannot patch fields: {sorted(unknown)}")

        sets = ["updatedAt = :updated"]
        values: Dict[str, Any] = {":updated": _now_iso()}
        names: Dict[str, str] = {}
        # `name` is a DDB reserved word — alias every field to stay consistent.
        for field in ("name", "description", "tags"):
            if field in patch:
                placeholder = f":v_{field}"
                alias = f"#k_{field}"
                sets.append(f"{alias} = {placeholder}")
                values[placeholder] = _to_ddb(patch[field])
                names[alias] = field

        update_kwargs: Dict[str, Any] = {
            "Key": {"userId": user_id, "skillId": skill_id},
            "UpdateExpression": "SET " + ", ".join(sets),
            "ExpressionAttributeValues": values,
            "ConditionExpression": "attribute_exists(userId)",
            "ReturnValues": "ALL_NEW",
        }
        if names:
            update_kwargs["ExpressionAttributeNames"] = names

        result = self._table.update_item(**update_kwargs)
        return _from_ddb(result.get("Attributes") or {})

    def delete_skill(self, *, user_id: str, skill_id: str) -> None:
        self._table.delete_item(Key={"userId": user_id, "skillId": skill_id})

    # ---- reads -------------------------------------------------------------

    def get_skill(self, *, user_id: str, skill_id: str) -> Optional[Dict[str, Any]]:
        resp = self._table.get_item(Key={"userId": user_id, "skillId": skill_id})
        item = resp.get("Item")
        return _from_ddb(item) if item else None

    def get_by_job_id(self, *, job_id: str) -> Optional[Dict[str, Any]]:
        resp = self._table.query(
            IndexName="jobId-index",
            KeyConditionExpression="jobId = :j",
            ExpressionAttributeValues={":j": job_id},
            Limit=1,
        )
        items = resp.get("Items") or []
        return _from_ddb(items[0]) if items else None

    def list_skills(self, *, user_id: str) -> List[Dict[str, Any]]:
        """Return summary projections for the gallery view.

        DDB query responses are capped at 1MB per page; without pagination a
        prolific user would silently see only their first ~few hundred
        skills. Loop until LastEvaluatedKey is exhausted so the gallery is
        always complete.
        """
        items: List[Dict[str, Any]] = []
        kwargs: Dict[str, Any] = {
            "KeyConditionExpression": "userId = :u",
            "ExpressionAttributeValues": {":u": user_id},
        }
        while True:
            resp = self._table.query(**kwargs)
            items.extend(_from_ddb(i) for i in resp.get("Items", []))
            last_key = resp.get("LastEvaluatedKey")
            if not last_key:
                break
            kwargs["ExclusiveStartKey"] = last_key
        return [self._to_summary(i) for i in items]

    # ---- helpers -----------------------------------------------------------

    @staticmethod
    def _to_summary(item: Mapping[str, Any]) -> Dict[str, Any]:
        palette = item.get("palette") or {}
        preview_colors: List[str] = []
        for bucket in ("primary", "accent", "background", "surface", "text"):
            for tok in palette.get(bucket) or []:
                hex_val = tok.get("hex") if isinstance(tok, Mapping) else None
                if hex_val and hex_val not in preview_colors:
                    preview_colors.append(hex_val)
                if len(preview_colors) >= 5:
                    break
            if len(preview_colors) >= 5:
                break

        descriptor = item.get("styleDescriptor") or {}
        return {
            "skillId": item.get("skillId"),
            "name": item.get("name"),
            "description": item.get("description"),
            "tags": item.get("tags") or [],
            "status": item.get("status"),
            "styleDescriptorLabel": descriptor.get("label", ""),
            "createdAt": item.get("createdAt"),
            "previewColors": preview_colors,
        }
