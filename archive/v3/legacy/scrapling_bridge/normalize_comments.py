"""使用 Scrapling 对评论数据做清洗、去重和字段标准化。

这个脚本只处理已经由现有采集器保存到本地的 JSON，不负责登录、抓取或发送消息。
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote

from scrapling import Selector


MAX_COMMENT_LENGTH = 2_000
MAX_NICKNAME_LENGTH = 80
MIN_TIMESTAMP = 946684800  # 2000-01-01
PROVINCE_NAMES = (
    "北京", "天津", "上海", "重庆", "河北", "山西", "辽宁", "吉林", "黑龙江", "江苏", "浙江", "安徽", "福建",
    "江西", "山东", "河南", "湖北", "湖南", "广东", "海南", "四川", "贵州", "云南", "陕西", "甘肃", "青海",
    "内蒙古", "广西", "西藏", "宁夏", "新疆", "香港", "澳门", "台湾",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="清洗和标准化评论 JSON")
    parser.add_argument("--input", required=True, help="输入 JSON 文件")
    parser.add_argument("--output", required=True, help="标准化 JSON 文件")
    parser.add_argument("--stats", required=True, help="清洗统计 JSON 文件")
    return parser.parse_args()


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    temp.replace(path)


def as_text(value: Any) -> str:
    if value is None or isinstance(value, (dict, list, tuple)):
        return ""
    return str(value)


def nested_value(record: dict[str, Any], paths: Iterable[str]) -> Any:
    for path in paths:
        current: Any = record
        for part in path.split("."):
            if not isinstance(current, dict) or part not in current:
                current = None
                break
            current = current[part]
        if current not in (None, ""):
            return current
    return ""


def parse_integer(value: Any, default: int = 0) -> int:
    try:
        if value in (None, ""):
            return default
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return default


def clean_html_text(value: Any) -> str:
    """用 Scrapling 解析可能混入的 HTML，再统一空白字符。"""
    raw = html.unescape(as_text(value))
    if not raw:
        return ""
    try:
        # 评论内容只在内存中解析；含标签时让 Scrapling 去掉结构，普通文本先转义。
        source = f"<div>{raw}</div>" if re.search(r"<[A-Za-z/][^>]*>", raw) else f"<div>{html.escape(raw, quote=False)}</div>"
        page = Selector(source)
        nodes = page.css("div")
        if nodes:
            parsed = str(nodes[0].get_all_text(separator=" ", strip=True))
            if parsed:
                raw = parsed
    except Exception:
        # 单条脏数据不应导致整批任务失败，保留原文本继续清洗。
        pass

    raw = unicodedata.normalize("NFKC", raw)
    raw = raw.replace("\u200b", "").replace("\u200c", "").replace("\u200d", "")
    raw = "".join(ch if ch in "\n\t" or not unicodedata.category(ch).startswith("C") else " " for ch in raw)
    return re.sub(r"\s+", " ", raw).strip()


def normalize_id(value: Any) -> str:
    return re.sub(r"\s+", "", as_text(value)).strip()


def normalize_sec_uid(value: Any) -> str:
    value = normalize_id(value)
    if not value or len(value) > 256:
        return ""
    return value


def normalize_region_parts(record: dict[str, Any]) -> tuple[str, str, str, str]:
    """只拆分接口明确提供的地域文本，不根据昵称、IP 或其他特征推断城市。"""
    raw = clean_html_text(nested_value(record, ("region", "ip_label", "ipLabel", "location"))).replace(" ", "")
    province = clean_html_text(nested_value(record, (
        "province", "regionProvince", "region_province", "user.province", "author.province",
    ))).replace(" ", "").removesuffix("省")
    city = clean_html_text(nested_value(record, (
        "city", "cityName", "city_name", "regionCity", "region_city", "user.city_name", "user.cityName", "author.city_name",
    ))).replace(" ", "").removesuffix("市")
    if city.isdigit():
        city = ""
    if not province:
        province = next((name for name in PROVINCE_NAMES if raw == name or raw.startswith(name + "省") or raw.startswith(name)), "")
    if not city and province and len(raw) > len(province):
        remainder = raw[len(province):].removeprefix("省").removesuffix("市")
        if remainder and remainder != "省":
            city = remainder
    if province in {"北京", "天津", "上海", "重庆"} and not city and province + "市" in raw:
        city = province
    normalized = " / ".join(part for part in (province, city) if part) or raw
    precision = "city" if city else ("province" if province else "unknown")
    return normalized, province, city, precision


def normalize_timestamp(value: Any) -> tuple[int, str | None]:
    timestamp = parse_integer(value)
    now = int(datetime.now(timezone.utc).timestamp())
    if timestamp < MIN_TIMESTAMP or timestamp > now + 86400:
        return 0, "invalid_create_time"
    return timestamp, None


def nickname_is_suspicious(nickname: str) -> bool:
    if not nickname or len(nickname) > MAX_NICKNAME_LENGTH or "�" in nickname:
        return True
    if any(unicodedata.category(ch).startswith("C") for ch in nickname):
        return True
    # 仅把强信号标记为异常，避免误伤正常的中文、英文、数字或表情昵称。
    visible = [ch for ch in nickname if ch.isalnum() or "\u3400" <= ch <= "\u9fff"]
    return bool(nickname) and not visible and len(nickname) >= 5


def text_is_emoji_only(text: str) -> bool:
    meaningful = [ch for ch in text if ch.isalnum() or "\u3400" <= ch <= "\u9fff"]
    return bool(text) and not meaningful


def standardize(record: dict[str, Any]) -> tuple[dict[str, Any] | None, list[str]]:
    text = clean_html_text(nested_value(record, ("text", "commentText", "content")))
    user = clean_html_text(nested_value(record, ("nickname", "nick", "userNickname", "user.nickname", "author.nickname", "user")))
    comment_id = normalize_id(nested_value(record, ("commentId", "cid", "comment_id", "id")))
    aweme_id = normalize_id(nested_value(record, ("awemeId", "aweme_id", "videoId", "video_id")))
    sec_uid = normalize_sec_uid(
        nested_value(record, ("sec_uid", "secUid", "userSecUid", "user_sec_uid", "user.sec_uid", "author.sec_uid"))
    )
    create_time, time_reason = normalize_timestamp(
        nested_value(record, ("createTime", "create_time", "createdAt", "timestamp"))
    )
    like_count = max(0, parse_integer(nested_value(record, ("likeCount", "digg", "digg_count"))))
    video_title = clean_html_text(nested_value(record, ("videoTitle", "title", "video_title")))
    region, province, city, region_precision = normalize_region_parts(record)
    avatar_url = as_text(nested_value(record, ("avatarUrl", "avatar_url", "user.avatarUrl", "user.avatar"))).strip()
    works_count_value = nested_value(record, ("worksCount", "awemeCount", "user.aweme_count"))
    works_count = parse_integer(works_count_value, -1) if works_count_value not in (None, "") else None
    profile_private = nested_value(record, ("profilePrivate", "isPrivate", "user.is_private"))
    if profile_private in ("", None):
        profile_private = None
    elif isinstance(profile_private, str):
        profile_private = profile_private.lower() in {"1", "true", "yes"}
    profile_url = as_text(nested_value(record, ("profileUrl", "userProfile", "user_profile"))).strip()
    if sec_uid:
        profile_url = f"https://www.douyin.com/user/{quote(sec_uid, safe='')}"

    reasons: list[str] = []
    if not text:
        reasons.append("empty_text")
    if not comment_id:
        reasons.append("missing_comment_id")
    if not aweme_id:
        reasons.append("missing_aweme_id")
    if not user:
        reasons.append("missing_user")
    if time_reason:
        reasons.append(time_reason)
    if nickname_is_suspicious(user):
        reasons.append("suspicious_nickname")
    if text_is_emoji_only(text):
        reasons.append("emoji_only_text")
    if len(text) > MAX_COMMENT_LENGTH:
        reasons.append("text_too_long")

    avatar_checked = record.get("avatarCollected") is True
    if avatar_checked and not avatar_url:
        reasons.append("missing_avatar")
    if works_count == 0:
        reasons.append("no_works")
    if profile_private is True:
        reasons.append("private_profile")

    # 缺失 sec_uid、头像或作品数只代表当前接口没有提供资料，不能伪造，也不单独判为低价值。
    quality_flags = list(dict.fromkeys(reasons))
    low_value_reasons = [
        reason
        for reason in quality_flags
        if reason in {
            "suspicious_nickname",
            "emoji_only_text",
            "text_too_long",
            "missing_avatar",
            "no_works",
            "private_profile",
            "invalid_create_time",
        }
    ]
    if not sec_uid:
        quality_flags.append("missing_sec_uid")
    if not avatar_url:
        quality_flags.append("avatar_not_collected")
    if works_count is None:
        quality_flags.append("works_count_not_collected")
    if profile_private is None:
        quality_flags.append("profile_visibility_unknown")

    # 没有可定位的评论记录时不输出到标准化结果，避免下游生成 undefined 任务。
    if not text or not comment_id or not aweme_id or not user:
        return None, quality_flags

    result = dict(record)
    result.update(
        {
            "commentId": comment_id,
            "cid": comment_id,
            "awemeId": aweme_id,
            "text": text,
            "user": user,
            "sec_uid": sec_uid,
            "userSecUid": sec_uid,
            "profileUrl": profile_url,
            "likeCount": like_count,
            "digg": like_count,
            "createTime": create_time,
            "time": datetime.fromtimestamp(create_time).strftime("%Y-%m-%d %H:%M:%S") if create_time else "",
            "commentTime": datetime.fromtimestamp(create_time).isoformat() if create_time else "",
            "videoTitle": video_title,
            "region": region,
            "province": province,
            "city": city,
            "regionPrecision": region_precision,
            "avatarUrl": avatar_url,
            "worksCount": works_count,
            "profilePrivate": profile_private,
            "qualityFlags": list(dict.fromkeys(quality_flags)),
            "low_value": bool(low_value_reasons),
            "lowValueReasons": low_value_reasons,
            "userLocatorReady": bool(sec_uid),
        }
    )
    return result, quality_flags


def dedupe_keys(record: dict[str, Any]) -> list[tuple[str, ...]]:
    keys: list[tuple[str, ...]] = []
    comment_id = normalize_id(record.get("commentId"))
    if comment_id:
        keys.append(("id", comment_id))
    normalized_text = re.sub(r"\s+", "", as_text(record.get("text")).lower())
    identity = normalize_id(record.get("sec_uid") or record.get("user"))
    if normalized_text and identity:
        keys.append(("content", normalize_id(record.get("awemeId")), identity, normalized_text))
    return keys or [("fallback", normalize_id(record.get("awemeId")), normalized_text)]


def merge_duplicate(existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    merged = dict(existing)
    for key, value in incoming.items():
        if merged.get(key) in (None, "", [], {}):
            merged[key] = value
    merged["likeCount"] = max(parse_integer(existing.get("likeCount")), parse_integer(incoming.get("likeCount")))
    merged["digg"] = merged["likeCount"]
    merged["qualityFlags"] = list(dict.fromkeys(
        list(existing.get("qualityFlags") or []) + list(incoming.get("qualityFlags") or [])
    ))
    merged["lowValueReasons"] = list(dict.fromkeys(
        list(existing.get("lowValueReasons") or []) + list(incoming.get("lowValueReasons") or [])
    ))
    merged["low_value"] = bool(merged["lowValueReasons"])
    merged["userLocatorReady"] = bool(merged.get("sec_uid"))
    return merged


def flatten_records(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        if isinstance(payload.get("comments"), list):
            return [item for item in payload["comments"] if isinstance(item, dict)]
        if isinstance(payload.get("results"), list):
            records: list[dict[str, Any]] = []
            for item in payload["results"]:
                if isinstance(item, dict) and isinstance(item.get("comments"), list):
                    records.extend(comment for comment in item["comments"] if isinstance(comment, dict))
            return records
    return []


def normalize(records: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: dict[tuple[str, ...], int] = {}
    reason_counts: Counter[str] = Counter()
    dropped = 0
    duplicate_count = 0
    missing_sec_uid = 0

    for raw in records:
        item, flags = standardize(raw)
        reason_counts.update(flags)
        if item is None:
            dropped += 1
            continue
        if not item.get("sec_uid"):
            missing_sec_uid += 1
        keys = dedupe_keys(item)
        existing_index = next((seen[key] for key in keys if key in seen), None)
        if existing_index is not None:
            duplicate_count += 1
            result[existing_index] = merge_duplicate(result[existing_index], item)
            for key in keys:
                seen[key] = existing_index
        else:
            for key in keys:
                seen[key] = len(result)
            result.append(item)

    stats = {
        "inputCount": len(records),
        "outputCount": len(result),
        "droppedCount": dropped,
        "duplicateCount": duplicate_count,
        "lowValueCount": sum(1 for item in result if item.get("low_value")),
        "missingSecUidCount": missing_sec_uid,
        "reasonCounts": dict(reason_counts),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "processor": "scrapling-official 0.4.15",
    }
    return result, stats


def main() -> int:
    args = parse_args()
    try:
        records = flatten_records(read_json(Path(args.input)))
        cleaned, stats = normalize(records)
        write_json(Path(args.output), cleaned)
        write_json(Path(args.stats), stats)
        print(json.dumps(stats, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(f"normalize_comments failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
