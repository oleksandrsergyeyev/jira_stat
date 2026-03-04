import requests
from collections import Counter
from flask import Flask, jsonify, render_template, request, send_file
import os
import io
import copy
import json
from datetime import datetime, timezone
import pandas as pd
from dotenv import load_dotenv
import re
import argparse

load_dotenv()

app = Flask(__name__)

JIRA_BASE_URL = "https://jira-vira.volvocars.biz/rest/api/2"
JIRA_SEARCH = f"{JIRA_BASE_URL}/search"
JIRA_ISSUE = f"{JIRA_BASE_URL}/issue"
JIRA_PRIORITY = f"{JIRA_BASE_URL}/priority"
JIRA_PROJECT = f"{JIRA_BASE_URL}/project"
JIRA_USER_SEARCH = f"{JIRA_BASE_URL}/user/search"

JIRA_TOKEN = os.getenv("JIRA_TOKEN")

# If your Feature issue type id differs, set env: JIRA_FEATURE_TYPE_IDS="10400,12345"
FEATURE_TYPE_IDS = {
    s.strip() for s in (os.getenv("JIRA_FEATURE_TYPE_IDS", "10400").split(",")) if s.strip()
}

HEADERS = {
    "Authorization": f"Bearer {JIRA_TOKEN}",
    "Content-Type": "application/json"
}

_DATA_CACHE: dict[tuple, object] = {}
TEAM_CAPACITY_FILE = "team_capacity_data.json"
APP_SETTINGS_FILE = "app_settings.json"


def _cache_get_or_build(cache_key: tuple, builder, force_refresh: bool = False):
    if (not force_refresh) and (cache_key in _DATA_CACHE):
        return copy.deepcopy(_DATA_CACHE[cache_key])
    value = builder()
    _DATA_CACHE[cache_key] = copy.deepcopy(value)
    return copy.deepcopy(value)


def _is_force_refresh_requested() -> bool:
    raw = (request.args.get("forceRefresh", "") or "").strip().lower()
    return raw in {"1", "true", "yes", "y"}

# ---------------- Common lightweight helpers (stateless) ----------------

def _is_feature_type(fields: dict) -> bool:
    it = (fields or {}).get("issuetype", {}) or {}
    name = (it.get("name") or "").lower()
    iid = str(it.get("id") or "").strip()
    if "feature" in name:
        return True
    if iid and iid in FEATURE_TYPE_IDS:
        return True
    return False

def _status_category_key(fields: dict) -> str:
    st = (fields or {}).get("status", {}) or {}
    cat = (st.get("statusCategory") or {}) or {}
    return (cat.get("key") or "").lower()

def _story_points(fields: dict) -> float:
    val = (fields or {}).get("customfield_10708", 0)
    try:
        return float(val) if val not in (None, "") else 0.0
    except Exception:
        return 0.0

def _assignee_name(fields: dict) -> str:
    a = (fields or {}).get("assignee")
    return (a or {}).get("displayName", "") if isinstance(a, dict) else ""

def _reporter_name(fields: dict) -> str:
    r = (fields or {}).get("reporter")
    if not isinstance(r, dict):
        return ""
    return (
        r.get("displayName")
        or r.get("name")
        or r.get("emailAddress")
        or r.get("key")
        or ""
    )

def _priority_name(fields: dict) -> str:
    p = (fields or {}).get("priority")
    return (p or {}).get("name", "") if isinstance(p, dict) else ""

def _pi_scope_value(fields: dict) -> str:
    scope = (fields or {}).get("customfield_14700")
    if isinstance(scope, dict):
        return scope.get("value", "") or ""
    return scope or ""

def _fix_versions(fields: dict) -> list:
    out = []
    for fv in (fields or {}).get("fixVersions", []) or []:
        name = fv.get("name")
        if name:
            out.append(name)
    return out

def _archived_fix_versions(fields: dict) -> list:
    out = []
    for fv in (fields or {}).get("fixVersions", []) or []:
        name = fv.get("name")
        if name and bool(fv.get("archived", False)):
            out.append(name)
    return out

def _canonicalize_sprint_name(raw) -> str | None:
    if raw is None:
        return None
    if isinstance(raw, list):
        for entry in raw:
            c = _canonicalize_sprint_name(entry)
            if c:
                return c
        return None
    if isinstance(raw, dict):
        for k in ("name", "Name", "toString", "value"):
            v = raw.get(k)
            if isinstance(v, str) and v:
                return _canonicalize_sprint_name(v)
        return None

    s = str(raw)
    m = re.search(r"name=([^,]+)", s, flags=re.IGNORECASE)
    raw_name = m.group(1) if m else s

    m1 = re.search(r"(?i)sprint[\s_\-:]*#?\s*(\d+)", raw_name)
    if m1:
        return f"Sprint {int(m1.group(1))}"
    m2 = re.search(r"(?i)(?:^|[_\-\s])s[\s_\-:]*#?\s*(\d+)(?:$|[_\-\s])", raw_name)
    if m2:
        return f"Sprint {int(m2.group(1))}"
    return None

def _extract_capability_key(fields: dict) -> str:
    cap = (fields or {}).get("customfield_13801", "")
    if isinstance(cap, dict):
        return cap.get("key", "") or ""
    return cap or ""

def _leading_work_group_value(fields: dict) -> str:
    raw = (fields or {}).get("customfield_14400")

    def _one(v) -> str:
        if isinstance(v, dict):
            return (
                v.get("value")
                or v.get("name")
                or v.get("displayName")
                or v.get("key")
                or ""
            ).strip()
        return str(v).strip() if v not in (None, "") else ""

    if isinstance(raw, list):
        values = []
        for entry in raw:
            name = _one(entry)
            if name and name not in values:
                values.append(name)
        return ", ".join(values)

    return _one(raw)

def _get_issue_summary(key: str, cache: dict) -> str:
    if not key:
        return ""
    if key in cache:
        return cache[key]
    url = f"{JIRA_ISSUE}/{key}"
    resp = requests.get(url, headers=HEADERS, params={"fields": "summary"})
    if resp.status_code == 200:
        s = (resp.json().get("fields") or {}).get("summary", "") or ""
        cache[key] = s
        return s
    return ""

def _get_issue_meta(key: str, cache: dict[str, dict]) -> dict:
    if not key:
        return {"summary": "", "leading_work_group": "", "created": "", "priority": ""}
    if key in cache:
        return cache[key]

    url = f"{JIRA_ISSUE}/{key}"
    resp = requests.get(url, headers=HEADERS, params={"fields": "summary,customfield_14400,created,priority"})
    if resp.status_code == 200:
        fields = (resp.json().get("fields") or {})
        meta = {
            "summary": fields.get("summary", "") or "",
            "leading_work_group": _leading_work_group_value(fields),
            "created": fields.get("created", "") or "",
            "priority": _priority_name(fields),
        }
        cache[key] = meta
        return meta

    meta = {"summary": "", "leading_work_group": "", "created": "", "priority": ""}
    cache[key] = meta
    return meta

def _extract_linked_issue_links(links):
    result = []
    for link in (links or []):
        outward = link.get("outwardIssue")
        inward = link.get("inwardIssue")
        issue = outward or inward
        if issue and "key" in issue:
            key = issue["key"]
            if outward and link.get("type", {}).get("outward"):
                direction = link.get("type", {}).get("outward")
            elif inward and link.get("type", {}).get("inward"):
                direction = link.get("type", {}).get("inward")
            else:
                direction = ""
            result.append({
                "key": key,
                "url": f"https://jira-vira.volvocars.biz/browse/{key}",
                "link_type": direction
            })
    return result

def _norm_py(s: str) -> str:
    return (s or "").strip().lower()

def _parse_excluded(raw: str) -> set[str]:
    import re
    if not raw:
        return set()
    parts = re.split(r'[,\n;|]+', raw)
    return { _norm_py(p) for p in parts if p and p.strip() }


def _team_capacity_path() -> str:
    return os.path.join(app.root_path, TEAM_CAPACITY_FILE)


def _default_app_settings() -> dict:
    return {
        "fix_versions": [
            "PI_24w49",
            "PI_25w10",
            "QS_25w22",
            "QS_25w37",
            "QS_25w49",
        ],
        "work_groups": [
            {"leadingWorkGroup": "ART - BCRC - BSW TFW", "teamName": "Infra Team"},
            {"leadingWorkGroup": "ART - BCRC - FPT", "teamName": "Web Team"},
            {"leadingWorkGroup": "ART - BCRC - SysSW CI", "teamName": "CI Team"},
            {"leadingWorkGroup": "ART - BCRC - BSW Diag and Com", "teamName": "Diag and Com"},
            {"leadingWorkGroup": "ART - BCRC - BSW HW Interface", "teamName": "HW interface"},
            {"leadingWorkGroup": "ART - BCRC - BSW Platform", "teamName": "BSW Platform"},
            {"leadingWorkGroup": "ART - BCRC - BSW SW Platform and BL", "teamName": "BSW SW Platform and BL"},
            {"leadingWorkGroup": "ART - BCRC - Domain", "teamName": "AiC team"},
            {"leadingWorkGroup": "ART - BCRC - FSW", "teamName": "FSW team"},
            {"leadingWorkGroup": "ART - BCRC - SysSW System Safety and Security", "teamName": "Safety & Security"},
            {"leadingWorkGroup": "ART - BCRC - Moni", "teamName": "TPMS"},
        ],
    }


def _app_settings_path() -> str:
    return os.path.join(app.root_path, APP_SETTINGS_FILE)


def _normalize_app_settings(raw: dict) -> dict:
    src = raw if isinstance(raw, dict) else {}

    seen_fix = set()
    fix_versions = []
    for entry in (src.get("fix_versions") or []):
        item = str(entry or "").strip()
        if not item:
            continue
        key = item.lower()
        if key in seen_fix:
            continue
        seen_fix.add(key)
        fix_versions.append(item)

    seen_wg = set()
    work_groups = []
    for row in (src.get("work_groups") or []):
        row_obj = row if isinstance(row, dict) else {}
        leading = str(row_obj.get("leadingWorkGroup") or "").strip()
        team = str(row_obj.get("teamName") or "").strip()
        if not leading:
            continue
        key = leading.lower()
        if key in seen_wg:
            continue
        seen_wg.add(key)
        work_groups.append({
            "leadingWorkGroup": leading,
            "teamName": team or leading,
        })

    if not fix_versions:
        fix_versions = _default_app_settings()["fix_versions"]
    if not work_groups:
        work_groups = _default_app_settings()["work_groups"]

    return {
        "fix_versions": fix_versions,
        "work_groups": work_groups,
    }


def _load_app_settings() -> dict:
    path = _app_settings_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            normalized = _normalize_app_settings(data)
            return normalized
    except FileNotFoundError:
        defaults = _default_app_settings()
        _save_app_settings(defaults)
        return defaults
    except Exception:
        defaults = _default_app_settings()
        return defaults


def _save_app_settings(settings: dict):
    normalized = _normalize_app_settings(settings)
    path = _app_settings_path()
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(normalized, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, path)


def _load_team_capacity_store() -> dict:
    path = _team_capacity_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, dict):
                return data
    except FileNotFoundError:
        return {}
    except Exception:
        return {}
    return {}


def _save_team_capacity_store(store: dict):
    path = _team_capacity_path()
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(store, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, path)


def _team_capacity_key(work_group: str, fix_version: str) -> str:
    wg = (work_group or "").strip()
    fv = (fix_version or "").strip()
    return f"{wg}|||{fv}"


def _team_capacity_teammates(work_group: str, fix_version: str | None = None) -> list[dict]:
    wg = (work_group or "").strip()
    fv = (fix_version or "").strip() if fix_version is not None else ""
    if not wg:
        return []

    store = _load_team_capacity_store()
    source_payloads = []

    if fv:
        payload = store.get(_team_capacity_key(wg, fv))
        if isinstance(payload, dict):
            source_payloads.append(payload)

    if not source_payloads:
        prefix = f"{wg}|||"
        for key, payload in (store or {}).items():
            if not str(key).startswith(prefix):
                continue
            if isinstance(payload, dict):
                source_payloads.append(payload)

    out = []
    seen = set()
    for payload in source_payloads:
        for row in (payload.get("members") or []):
            member = _normalize_member(row)
            account_id = str(member.get("accountId") or "").strip()
            display_name = str(member.get("displayName") or "").strip()
            email = str(member.get("emailAddress") or "").strip()
            if not display_name:
                continue
            dedupe_key = account_id or display_name.lower()
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            out.append({
                "accountId": account_id,
                "displayName": display_name,
                "emailAddress": email,
            })

    out.sort(key=lambda x: (x.get("displayName") or "").lower())
    return out


def _coerce_day_value(raw) -> float:
    try:
        val = float(raw)
    except Exception:
        return 0.0
    if val < 0:
        return 0.0
    if val > 5:
        return 5.0
    return round(val, 2)


def _normalize_member(raw: dict) -> dict:
    row = raw if isinstance(raw, dict) else {}
    display_name = str(row.get("displayName") or row.get("name") or "").strip()
    account_id = str(row.get("accountId") or "").strip()
    email = str(row.get("emailAddress") or row.get("email") or "").strip()

    return {
        "accountId": account_id,
        "displayName": display_name,
        "emailAddress": email,
    }


def _default_sprint_weeks() -> dict:
    return {
        "Sprint 1": 2,
        "Sprint 2": 2,
        "Sprint 3": 2,
        "Sprint 4": 2,
        "Sprint 5": 2,
    }


def _normalize_sprint_weeks(raw: dict | None) -> dict:
    src = raw if isinstance(raw, dict) else {}
    out = {}
    defaults = _default_sprint_weeks()
    for sprint, default_weeks in defaults.items():
        try:
            val = int(src.get(sprint, default_weeks))
        except Exception:
            val = default_weeks
        if val < 1:
            val = 1
        if val > 8:
            val = 8
        out[sprint] = val
    return out


def _normalize_start_week(raw) -> str | None:
    value = str(raw or "").strip()
    if not value:
        return None
    m = re.match(r"^(\d{4})-W(\d{2})$", value, flags=re.IGNORECASE)
    if not m:
        return None
    year = int(m.group(1))
    week = int(m.group(2))
    if week < 1:
        week = 1
    if week > 53:
        week = 53
    return f"{year}-W{week:02d}"


def _normalize_member_week_values(raw: dict, sprint_weeks: dict) -> dict:
    row = raw if isinstance(raw, dict) else {}
    raw_week_values = row.get("weekValues") or {}
    if not isinstance(raw_week_values, dict):
        raw_week_values = {}

    raw_week_days = row.get("weekDays") or {}
    if not isinstance(raw_week_days, dict):
        raw_week_days = {}

    raw_days = row.get("days") or {}
    if not isinstance(raw_days, dict):
        raw_days = {}

    normalized_week_values = {}

    for sprint, week_count in sprint_weeks.items():
        direct_values = raw_week_values.get(sprint) or []
        if not isinstance(direct_values, list):
            direct_values = []

        sprint_rows = raw_week_days.get(sprint) or []
        if not isinstance(sprint_rows, list):
            sprint_rows = []

        normalized_rows = []
        for week_idx in range(week_count):
            direct_val = direct_values[week_idx] if week_idx < len(direct_values) else 0
            direct_num = _coerce_day_value(direct_val)
            if direct_num > 0:
                normalized_rows.append(direct_num)
                continue

            # backward compatibility: previous format stored per-day values in weekDays
            src_week = sprint_rows[week_idx] if week_idx < len(sprint_rows) and isinstance(sprint_rows[week_idx], dict) else {}
            week_sum = 0.0
            for day in ["Mon", "Tue", "Wed", "Thu", "Fri"]:
                week_sum += _coerce_day_value(src_week.get(day, 0))
            normalized_rows.append(round(week_sum, 2))

        # backward compatibility: old format had per-sprint totals in `days`
        legacy_total = _coerce_day_value(raw_days.get(sprint, 0))
        has_any_values = any(v > 0 for v in normalized_rows)
        if (not has_any_values) and legacy_total > 0 and normalized_rows:
            normalized_rows[0] = legacy_total

        normalized_week_values[sprint] = normalized_rows

    return normalized_week_values


def _jira_user_search(query_text: str, max_results: int = 20) -> list[dict]:
    q = (query_text or "").strip()
    if not q:
        return []

    users_payload = None
    errors = []

    attempts = [
        {"query": q, "maxResults": max_results, "includeInactive": "false"},
        {"username": q, "maxResults": max_results, "includeInactive": "false"},
    ]

    for params in attempts:
        resp = requests.get(JIRA_USER_SEARCH, headers=HEADERS, params=params)
        if resp.status_code == 200:
            users_payload = resp.json()
            break
        errors.append(f"{resp.status_code} {resp.text}")

    if users_payload is None:
        raise RuntimeError(f"Jira user search failed: {' | '.join(errors)}")

    rows = users_payload if isinstance(users_payload, list) else []
    out = []
    seen = set()
    for u in rows:
        if not isinstance(u, dict):
            continue
        account_id = str(u.get("accountId") or "").strip()
        display = str(u.get("displayName") or u.get("name") or u.get("key") or "").strip()
        if not display:
            continue
        dedupe_key = account_id or display.lower()
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        out.append({
            "accountId": account_id,
            "displayName": display,
            "emailAddress": str(u.get("emailAddress") or "").strip(),
            "name": str(u.get("name") or "").strip(),
            "key": str(u.get("key") or "").strip(),
            "active": bool(u.get("active", True)),
        })
        if len(out) >= max_results:
            break

    return out

# ---------------- Jira search ----------------

def _jira_search(jql: str, fields: list[str], max_results: int = 1000, start_at: int = 0):
    payload = {"jql": jql, "maxResults": max_results, "startAt": start_at, "fields": fields}
    resp = requests.post(JIRA_SEARCH, json=payload, headers=HEADERS)
    if resp.status_code != 200:
        print(f"Jira error: {resp.status_code} {resp.text}")
        return None
    return resp.json()

def _jira_search_all(jql: str, fields: list[str], page_size: int = 1000, hard_cap: int = 5000):
    """Paginate JQL to collect many issues safely."""
    results = []
    start = 0
    while True:
        data = _jira_search(jql, fields, max_results=page_size, start_at=start)
        if not data:
            break
        issues = data.get("issues", []) or []
        results.extend(issues)
        total = int(data.get("total", len(results)))
        if start + len(issues) >= total:
            break
        start += len(issues)
        if len(results) >= hard_cap:
            # safety to avoid pulling the whole Jira by accident
            break
    return results


def _jira_get_issue_fix_versions(issue_key: str) -> list[str]:
    url = f"{JIRA_ISSUE}/{issue_key}"
    resp = requests.get(url, headers=HEADERS, params={"fields": "fixVersions"})
    if resp.status_code != 200:
        raise RuntimeError(f"Failed to read issue {issue_key}: {resp.status_code} {resp.text}")
    fields = (resp.json().get("fields") or {})
    return [fv.get("name") for fv in (fields.get("fixVersions") or []) if fv.get("name")]


def _jira_update_issue_fix_versions(issue_key: str, add_versions: list[str], remove_versions: list[str]) -> dict:
    ops = []
    for v in add_versions:
        ops.append({"add": {"name": v}})
    for v in remove_versions:
        ops.append({"remove": {"name": v}})

    payload = {"update": {"fixVersions": ops}}
    url = f"{JIRA_ISSUE}/{issue_key}"
    resp = requests.put(url, headers=HEADERS, json=payload)
    if resp.status_code not in (200, 204):
        raise RuntimeError(f"Failed to update issue {issue_key}: {resp.status_code} {resp.text}")
    return payload


def _jira_get_priorities(force_refresh: bool = False) -> list[dict]:
    cache_key = ("jira_priorities",)

    def _build():
        resp = requests.get(JIRA_PRIORITY, headers=HEADERS)
        if resp.status_code != 200:
            raise RuntimeError(f"Failed to read Jira priorities: {resp.status_code} {resp.text}")
        data = resp.json()
        return data if isinstance(data, list) else []

    return _cache_get_or_build(cache_key, _build, force_refresh=force_refresh)


def _resolve_priority_id_from_number(priority_number: int, force_refresh: bool = False) -> tuple[str, str]:
    priorities = _jira_get_priorities(force_refresh=force_refresh)
    wanted = int(priority_number)
    wanted_str = str(wanted)

    def _extract_num(name: str) -> int | None:
        m = re.search(r"(?:^|\D)(10|[1-9])(?:\D|$)", str(name or ""))
        return int(m.group(1)) if m else None

    exact = []
    partial = []
    for p in priorities:
        name = str(p.get("name") or "")
        pid = str(p.get("id") or "")
        if not pid:
            continue
        if name.strip() == wanted_str:
            exact.append((pid, name))
            continue
        n = _extract_num(name)
        if n == wanted:
            partial.append((pid, name))

    if exact:
        return exact[0]
    if partial:
        return partial[0]
    raise RuntimeError(f"Priority '{wanted}' not found in Jira priorities")


def _jira_update_issue_priority(issue_key: str, priority_id: str) -> dict:
    payload = {"fields": {"priority": {"id": str(priority_id)}}}
    url = f"{JIRA_ISSUE}/{issue_key}"
    resp = requests.put(url, headers=HEADERS, json=payload)
    if resp.status_code not in (200, 204):
        raise RuntimeError(f"Failed to update issue {issue_key} priority: {resp.status_code} {resp.text}")
    return payload


def _jira_get_issue_assignee(issue_key: str) -> dict:
    url = f"{JIRA_ISSUE}/{issue_key}"
    resp = requests.get(url, headers=HEADERS, params={"fields": "assignee"})
    if resp.status_code != 200:
        raise RuntimeError(f"Failed to read issue {issue_key}: {resp.status_code} {resp.text}")
    fields = (resp.json().get("fields") or {})
    assignee = (fields.get("assignee") or {})
    return {
        "accountId": str(assignee.get("accountId") or "").strip(),
        "displayName": str(assignee.get("displayName") or assignee.get("name") or "").strip(),
        "emailAddress": str(assignee.get("emailAddress") or "").strip(),
    }


def _jira_update_issue_assignee(issue_key: str, assignee_identity: dict) -> dict:
    identity = assignee_identity if isinstance(assignee_identity, dict) else {}

    candidates = []
    account_id = str(identity.get("accountId") or "").strip()
    user_name = str(identity.get("name") or "").strip()
    user_key = str(identity.get("key") or "").strip()

    if account_id:
        candidates.append(("accountId", account_id))
    if user_name:
        candidates.append(("name", user_name))
    if user_key and user_key != user_name:
        candidates.append(("key", user_key))

    if not candidates:
        raise RuntimeError("No valid assignee identity to update Jira issue")

    url = f"{JIRA_ISSUE}/{issue_key}"
    errors = []
    for mode, value in candidates:
        payload = {"fields": {"assignee": {mode: value}}}
        resp = requests.put(url, headers=HEADERS, json=payload)
        if resp.status_code in (200, 204):
            return {"mode": mode, "value": value, "payload": payload}
        errors.append(f"{mode}={value}: {resp.status_code} {resp.text}")

    raise RuntimeError(f"Failed to update issue {issue_key} assignee: {' | '.join(errors)}")


def _resolve_user_identity(account_id: str, display_name: str, email_address: str) -> dict:
    aid = str(account_id or "").strip()
    if aid:
        return {"accountId": aid, "displayName": str(display_name or "").strip(), "emailAddress": str(email_address or "").strip(), "name": "", "key": ""}

    target_email = str(email_address or "").strip().lower()
    target_name_raw = str(display_name or "").strip()

    if not target_email and not target_name_raw:
        raise RuntimeError("accountId or displayName/emailAddress is required to resolve assignee")

    def _norm_name(s: str) -> str:
        return re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()

    def _token_set(s: str) -> set[str]:
        return {p for p in _norm_name(s).split(" ") if p}

    query_candidates = []
    if target_email:
        query_candidates.append(target_email)
        local = target_email.split("@", 1)[0].replace(".", " ").replace("_", " ").strip()
        if local:
            query_candidates.append(local)

    if target_name_raw:
        query_candidates.append(target_name_raw)
        cleaned = re.sub(r"[,;]", " ", target_name_raw).strip()
        if cleaned and cleaned not in query_candidates:
            query_candidates.append(cleaned)

        parts = [p for p in re.split(r"[,\s]+", target_name_raw) if p]
        if len(parts) >= 2:
            swapped = f"{parts[-1]} {parts[0]}".strip()
            if swapped and swapped not in query_candidates:
                query_candidates.append(swapped)

    all_users = []
    seen_users = set()
    for q in query_candidates:
        qv = str(q or "").strip()
        if not qv:
            continue
        try:
            users = _jira_user_search(qv, max_results=50)
        except Exception:
            users = []
        for u in users:
            uid = str(u.get("accountId") or "").strip() or str(u.get("displayName") or "").strip().lower()
            if not uid or uid in seen_users:
                continue
            seen_users.add(uid)
            all_users.append(u)

    if not all_users:
        raise RuntimeError("No Jira user found for assignee resolution")

    if target_email:
        for u in all_users:
            em = str(u.get("emailAddress") or "").strip().lower()
            if em and em == target_email:
                return {
                    "accountId": str(u.get("accountId") or "").strip(),
                    "displayName": str(u.get("displayName") or u.get("name") or "").strip(),
                    "emailAddress": str(u.get("emailAddress") or "").strip(),
                    "name": str(u.get("name") or "").strip(),
                    "key": str(u.get("key") or "").strip(),
                }

    target_tokens = _token_set(target_name_raw)
    if target_tokens:
        for u in all_users:
            nm = str(u.get("displayName") or u.get("name") or "").strip()
            if _token_set(nm) == target_tokens:
                return {
                    "accountId": str(u.get("accountId") or "").strip(),
                    "displayName": str(u.get("displayName") or u.get("name") or "").strip(),
                    "emailAddress": str(u.get("emailAddress") or "").strip(),
                    "name": str(u.get("name") or "").strip(),
                    "key": str(u.get("key") or "").strip(),
                }

    if target_name_raw:
        target_name = _norm_name(target_name_raw)
        for u in all_users:
            nm = _norm_name(str(u.get("displayName") or u.get("name") or ""))
            if nm and (nm in target_name or target_name in nm):
                return {
                    "accountId": str(u.get("accountId") or "").strip(),
                    "displayName": str(u.get("displayName") or u.get("name") or "").strip(),
                    "emailAddress": str(u.get("emailAddress") or "").strip(),
                    "name": str(u.get("name") or "").strip(),
                    "key": str(u.get("key") or "").strip(),
                }

    u0 = all_users[0]
    identity = {
        "accountId": str(u0.get("accountId") or "").strip(),
        "displayName": str(u0.get("displayName") or u0.get("name") or "").strip(),
        "emailAddress": str(u0.get("emailAddress") or "").strip(),
        "name": str(u0.get("name") or "").strip(),
        "key": str(u0.get("key") or "").strip(),
    }
    if identity.get("accountId") or identity.get("name") or identity.get("key"):
        return identity

    raise RuntimeError("Failed to resolve Jira assignee identity")


def _jira_get_issue_estimation(issue_key: str) -> int:
    url = f"{JIRA_ISSUE}/{issue_key}"
    resp = requests.get(url, headers=HEADERS, params={"fields": "customfield_10708"})
    if resp.status_code != 200:
        raise RuntimeError(f"Failed to read issue {issue_key}: {resp.status_code} {resp.text}")
    fields = (resp.json().get("fields") or {})
    raw_val = fields.get("customfield_10708", 0)
    try:
        return int(float(raw_val or 0))
    except Exception:
        return 0


def _jira_update_issue_estimation(issue_key: str, estimation_value: int) -> dict:
    payload = {"fields": {"customfield_10708": int(estimation_value)}}
    url = f"{JIRA_ISSUE}/{issue_key}"
    resp = requests.put(url, headers=HEADERS, json=payload)
    if resp.status_code not in (200, 204):
        raise RuntimeError(f"Failed to update issue {issue_key} estimation: {resp.status_code} {resp.text}")
    return payload


def _jira_get_issue_pi_scope(issue_key: str) -> str:
    url = f"{JIRA_ISSUE}/{issue_key}"
    resp = requests.get(url, headers=HEADERS, params={"fields": "customfield_14700"})
    if resp.status_code != 200:
        raise RuntimeError(f"Failed to read issue {issue_key}: {resp.status_code} {resp.text}")
    fields = (resp.json().get("fields") or {})
    return _pi_scope_value(fields)


def _jira_update_issue_pi_scope(issue_key: str, pi_scope_value: str) -> dict:
    raw = str(pi_scope_value or "").strip()
    normalized = raw.lower()

    if not normalized or normalized == "none":
        payload = {"fields": {"customfield_14700": None}}
    elif normalized == "committed":
        payload = {"fields": {"customfield_14700": {"value": "Committed"}}}
    elif normalized == "stretch":
        payload = {"fields": {"customfield_14700": {"value": "Stretch"}}}
    elif normalized in ("not included", "notincluded"):
        payload = {"fields": {"customfield_14700": {"value": "Not Included"}}}
    else:
        raise RuntimeError("piScope must be one of: None, Committed, Stretch, Not Included")

    url = f"{JIRA_ISSUE}/{issue_key}"
    resp = requests.put(url, headers=HEADERS, json=payload)
    if resp.status_code not in (200, 204):
        raise RuntimeError(f"Failed to update issue {issue_key} PI Scope: {resp.status_code} {resp.text}")
    return payload


def _extract_text_value(raw) -> str:
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw.strip()
    if isinstance(raw, list):
        parts = [_extract_text_value(x) for x in raw]
        return "\n".join([p for p in parts if p]).strip()
    if isinstance(raw, dict):
        if "text" in raw and isinstance(raw.get("text"), str):
            return (raw.get("text") or "").strip()
        if isinstance(raw.get("content"), list):
            return _extract_text_value(raw.get("content"))
        for key in ("value", "name", "displayName", "description"):
            value = raw.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return ""
    return str(raw).strip()


def _jira_get_issue_project_key(issue_key: str) -> str:
    url = f"{JIRA_ISSUE}/{issue_key}"
    resp = requests.get(url, headers=HEADERS, params={"fields": "project"})
    if resp.status_code != 200:
        raise RuntimeError(f"Failed to read issue {issue_key}: {resp.status_code} {resp.text}")
    fields = (resp.json().get("fields") or {})
    project = (fields.get("project") or {})
    return str(project.get("key") or "").strip().upper()


def _jira_get_project_version_names(project_key: str, force_refresh: bool = False) -> list[str]:
    project_key = str(project_key or "").strip().upper()
    if not project_key:
        return []

    cache_key = ("project_versions", project_key)

    def _build():
        url = f"{JIRA_PROJECT}/{project_key}/versions"
        resp = requests.get(url, headers=HEADERS)
        if resp.status_code != 200:
            raise RuntimeError(f"Failed to read project versions for {project_key}: {resp.status_code} {resp.text}")
        data = resp.json()
        out = []
        if isinstance(data, list):
            for v in data:
                name = str((v or {}).get("name") or "").strip()
                if name:
                    out.append(name)
        return out

    return _cache_get_or_build(cache_key, _build, force_refresh=force_refresh)

# ======================================================================
#                       1) FAULT REPORT DASHBOARD
# ======================================================================

def fr_list_issues(fix_version, work_group, force_refresh: bool = False):
    def _build():
        jql = (
            'type = "Fault Report" AND '
            f'"Leading Work Group" = "{work_group}" AND '
            f'fixVersion = "{fix_version}" '
            'AND (labels = "BuildIssue" AND labels = "Internal_Dev")'
        )
        data = _jira_search(jql, ["summary", "status", "fixVersions", "labels", "issuelinks"], max_results=500)
        out = []
        if not data:
            return out
        for it in data.get("issues", []):
            f = it.get("fields") or {}
            out.append({
                "key": it.get("key"),
                "summary": f.get("summary", ""),
                "status": f.get("status", {}),
                "labels": [str(x).lower() for x in (f.get("labels") or [])],
                "classes": [
                    get_classes(str(lbl).lower())
                    for lbl in (f.get("labels") or [])
                    if get_classes(str(lbl).lower()) not in ["buildissue", "internal_dev", "internla_dev"]
                ],
                "linked_features": extract_linked_features_for_fr(f.get("issuelinks", []))
            })
        return out

    cache_key = ("fr_list_issues", fix_version, work_group)
    return _cache_get_or_build(cache_key, _build, force_refresh=force_refresh)

def extract_linked_features_for_fr(links):
    result = []
    for link in (links or []):
        issue_data = link.get("inwardIssue") or link.get("outwardIssue")
        if issue_data:
            fields = issue_data.get("fields", {}) or {}
            issuetype = fields.get("issuetype", {}) or {}
            it_id = str(issuetype.get("id") or "")
            it_name = (issuetype.get("name") or "").lower()
            if ("feature" in it_name) or (it_id in FEATURE_TYPE_IDS):
                key = issue_data.get("key")
                if key:
                    result.append({
                        "key": key,
                        "url": f"https://jira-vira.volvocars.biz/browse/{key}",
                        "summary": fields.get("summary", "")
                    })
    return result

def get_statistics(fix_version, work_group, force_refresh: bool = False):
    all_classes = [cls for issue in fr_list_issues(fix_version, work_group, force_refresh=force_refresh) for cls in issue["classes"]]
    return Counter(all_classes)

def get_classes(label):
    parts = label.split('_', 2)
    return '_'.join(parts[:2]) if len(parts) > 1 else label

# ======================================================================
#                           2) PI PLANNING (independent)
# ======================================================================

def _extract_pi_token(fx: str) -> str:
    if not fx:
        return ""
    m = re.search(r"(\d{2}w\d{2})", fx, flags=re.IGNORECASE)
    return m.group(1).lower() if m else ""

def _match_and_normalize_sprint(raw, pi_token_lc: str):
    """
    Returns (canonical_name, matches_pi)
    """
    if raw is None:
        return (None, False)

    if isinstance(raw, list):
        best = None
        for entry in raw:
            c, ok = _match_and_normalize_sprint(entry, pi_token_lc)
            if ok and c:
                return (c, True)
            if best is None and c:
                best = c
        return (best, False)

    if isinstance(raw, dict):
        for k in ("name", "Name", "toString", "value"):
            v = raw.get(k)
            if isinstance(v, str) and v:
                return _match_and_normalize_sprint(v, pi_token_lc)
        return (None, False)

    s = str(raw)

    # Jira often stores KV blob "..., name=<real name>, ..."
    name_match = re.search(r"name=([^,]+)", s, flags=re.IGNORECASE)
    raw_name = name_match.group(1) if name_match else s
    raw_name_lc = raw_name.lower()

    matches_pi = bool(pi_token_lc and (pi_token_lc in raw_name_lc))

    # "Sprint 1", "Sprint_1", "Sprint-1", "Sprint: 1", "S1"
    m = re.search(r"(?i)sprint[\s_\-:]*#?\s*(\d+)", raw_name)
    if m:
        return (f"Sprint {int(m.group(1))}", matches_pi)

    m2 = re.search(r"(?i)(?:^|[_\-\s])s[\s_\-:]*#?\s*(\d+)(?:$|[_\-\s])", raw_name)
    if m2:
        return (f"Sprint {int(m2.group(1))}", matches_pi)

    return (None, matches_pi)

def _fetch_issue_full(key: str):
    """Side fetch for a missing parent Feature."""
    url = f"{JIRA_ISSUE}/{key}"
    params = {
        "fields": ",".join([
            "summary", "issuetype", "issuelinks", "customfield_14700", "status", "priority",
            "customfield_13801",
            "fixVersions", "customfield_10708", "assignee", "reporter"
        ])
    }
    resp = requests.get(url, headers=HEADERS, params=params)
    if resp.status_code == 200:
        return resp.json()
    return None

def _seed_feature_from_issue_json(issue_json: dict, summary_cache: dict):
    """Turn a fetched Feature issue into a row for 'features' dict."""
    if not issue_json:
        return None
    fields = issue_json.get("fields", {}) or {}
    key = issue_json.get("key", "")
    if not key:
        return None

    if not _is_feature_type(fields):
        return None

    pi_scope_value = _pi_scope_value(fields)
    priority_value = _priority_name(fields)

    parent_link_value = _extract_capability_key(fields)
    parent_summary = _get_issue_summary(parent_link_value, summary_cache) if parent_link_value else ""

    fix_versions = _fix_versions(fields)
    feature_sp = _story_points(fields)
    assignee_display = _assignee_name(fields)
    reporter_display = _reporter_name(fields)

    return key, {
        "summary": fields.get("summary", "") or "",
        "status": (fields.get("status", {}) or {}).get("name", "") or "",
        "pi_scope": pi_scope_value,
        "priority": priority_value,
        "parent_link": parent_link_value,
        "parent_summary": parent_summary,
        "fixVersions": fix_versions,
        "linked_issues": _extract_linked_issue_links(fields.get("issuelinks", []) or []),
        "sprints": {},                 # canonical sprint -> [issue keys]
        "story_points": feature_sp,    # feature-level estimate
        "sum_story_points": 0.0,       # sum of child story points
        "assignee": assignee_display,
        "reporter": reporter_display,
        "stories_detail": [],          # [{key, story_points, assignee, status}]
    }

def _find_parent_feature_from_links(issuelinks, known_feature_keys: set):
    if not issuelinks:
        return None
    for link in issuelinks:
        for side in ("outwardIssue", "inwardIssue"):
            issue = link.get(side)
            if not issue:
                continue
            key = issue.get("key")
            fields = issue.get("fields", {}) or {}
            if key and key in known_feature_keys:
                return key
            if key and _is_feature_type(fields):
                return key
    return None

def _resolve_parent_feature_key(fields, feature_keys: set):
    """
    Parent resolution for child Story / Fault Report:
      1) Epic Link (customfield_10702) – may be string or object with 'key'
      2) parent.key
      3) issue links pointing to Feature
    """
    epic_link_field = "customfield_10702"

    epic_val = fields.get(epic_link_field)
    if epic_val:
        if isinstance(epic_val, str):
            return epic_val
        if isinstance(epic_val, dict):
            k = epic_val.get("key")
            if k:
                return k

    parent_obj = fields.get("parent")
    if isinstance(parent_obj, dict):
        pk = parent_obj.get("key")
        if pk:
            p_fields = (parent_obj.get("fields") or {})
            if not p_fields or _is_feature_type(p_fields):
                return pk

    cand = _find_parent_feature_from_links(fields.get("issuelinks", []) or [], feature_keys)
    if cand:
        return cand

    return ""

def get_pi_planning(fix_version: str, work_group: str, force_refresh: bool = False) -> dict:
    """
    Build PI Planning data for a given Leading Work Group.

    Inclusion for the page:
      • Seed all Features in this WG that have fixVersion = selected PI, plus
      • Any Feature that becomes a parent of a child Story/FR in this PI (via fixVersion match OR sprint name matches PI token).
    """
    pi_token = _extract_pi_token(fix_version)

    fields_needed = [
        "summary", "issuetype", "issuelinks",
        "customfield_10701",      # Sprint(s)
        "customfield_14700",      # PI Scope
        "status", "priority",
        "customfield_13801",      # Capability link
        "fixVersions",
        "customfield_10702",      # Epic Link (if exists)
        "customfield_10708",      # Story Points
        "assignee",
        "reporter",
        "parent"
    ]

    # Pull everything for WG that is either in this PI (fixVersion) OR recently updated (to catch sprint-only children).
    jql = (
        f'"Leading Work Group" = "{work_group}" '
        f'AND (fixVersion = "{fix_version}" OR updated >= -120d) '
        "ORDER BY updated DESC"
    )
    cache_key = ("pi_planning_issues_v2", fix_version, work_group)
    issues = _cache_get_or_build(
        cache_key,
        lambda: _jira_search_all(jql, fields_needed, page_size=1000, hard_cap=6000),
        force_refresh=force_refresh,
    )

    features: dict[str, dict] = {}
    summary_cache: dict[str, str] = {}

    # 1) Seed Features that explicitly carry this fixVersion
    for it in issues:
        fields = it.get("fields", {}) or {}
        if not _is_feature_type(fields):
            continue
        if fix_version not in _fix_versions(fields):
            continue  # seed only the ones clearly in this PI
        key = it.get("key", "")
        seeded = _seed_feature_from_issue_json(it, summary_cache)
        if seeded:
            fk, row = seeded
            features[fk] = row

    feature_keys = set(features.keys())

    # 2) Attach children (Story / Fault Report). If their parent Feature wasn't seeded, fetch/seed it now.
    for it in issues:
        key = it.get("key", "")
        fields = it.get("fields", {}) or {}
        itype_name = ((fields.get("issuetype") or {}).get("name") or "").lower()
        if itype_name not in ("story", "fault report"):
            continue

        # Check if this child is in this PI: via fixVersion OR sprint name contains PI token
        in_this_pi = False
        if fix_version in _fix_versions(fields):
            in_this_pi = True
        else:
            canonical, matches = _match_and_normalize_sprint(fields.get("customfield_10701"), pi_token)
            if matches:
                in_this_pi = True

        if not in_this_pi:
            continue

        parent_key = _resolve_parent_feature_key(fields, feature_keys)

        if parent_key and parent_key not in features:
            # side-load parent Feature and seed
            parent_issue = _fetch_issue_full(parent_key)
            seeded = _seed_feature_from_issue_json(parent_issue, summary_cache)
            if seeded:
                pk, prow = seeded
                features[pk] = prow
                feature_keys.add(pk)

        if not parent_key or parent_key not in features:
            continue

        # story points for child
        sp_val = _story_points(fields)

        child_assignee = _assignee_name(fields) or "Unassigned"
        child_status = ((fields.get("status") or {}).get("name") or "")

        features[parent_key]["sum_story_points"] += sp_val
        features[parent_key]["stories_detail"].append({
            "key": key,
            "story_points": sp_val,
            "assignee": child_assignee,
            "status": child_status,
        })

        # Sprint placement (PI-matching sprints only)
        raw_sprints = fields.get("customfield_10701")
        if not raw_sprints:
            features[parent_key]["sprints"].setdefault("No Sprint", []).append(key)
            continue

        entries = raw_sprints if isinstance(raw_sprints, list) else [raw_sprints]
        placed_in_any = False
        for entry in entries:
            canonical, matches_pi = _match_and_normalize_sprint(entry, pi_token)
            if canonical and matches_pi:
                features[parent_key]["sprints"].setdefault(canonical, []).append(key)
                placed_in_any = True

        if not placed_in_any:
            features[parent_key]["sprints"].setdefault("No Sprint", []).append(key)

    # 3) Canonicalize sprint keys across all features
    for feat in features.values():
        if not feat.get("sprints"):
            continue
        new_map = {}
        for k, v in list(feat["sprints"].items()):
            c = _canonicalize_sprint_name(k) or "No Sprint"
            new_map.setdefault(c, []).extend(v or [])
        feat["sprints"] = new_map

    return features

# change signature
def pi_planning_data_service(fix_version: str, work_group: str, excluded: set[str] | None = None, force_refresh: bool = False) -> dict:
    data = get_pi_planning(fix_version, work_group, force_refresh=force_refresh)
    if not excluded:
        return data

    excl = { _norm_py(x) for x in excluded }

    # mutate a copy-safe iteration
    for key in list(data.keys()):
        feat = data[key]

        # drop whole feature if its assignee is excluded
        if _norm_py(feat.get("assignee", "")) in excl:
            del data[key]
            continue

        # keep only non-excluded stories
        details = [d for d in (feat.get("stories_detail") or [])
                   if _norm_py(d.get("assignee", "")) not in excl]
        feat["stories_detail"] = details
        feat["sum_story_points"] = sum(float(d.get("story_points") or 0) for d in details)

        # filter sprint lists using the kept details (key -> assignee)
        by_key = { d["key"]: _norm_py(d.get("assignee","")) for d in details if d.get("key") }
        new_sprints: dict[str, list[str]] = {}
        for s_name, arr in (feat.get("sprints") or {}).items():
            kept = [k for k in (arr or []) if by_key.get(k, "") not in excl]
            new_sprints[s_name] = kept
        feat["sprints"] = new_sprints

    return data


# ======================================================================
#                           3) BACKLOG (independent)
# ======================================================================

def backlog_data_service(work_group: str, force_refresh: bool = False) -> dict:
    """
    All Feature-type issues for WG where statusCategory != done (across all fixVersions).
    Includes Capability (customfield_13801) and resolves its summary.
    """
    fields_needed = [
        "summary", "issuetype", "issuelinks", "customfield_14700",
        "status", "priority", "fixVersions", "customfield_10708", "assignee", "reporter",
        "customfield_13801",  # Capability link
        "customfield_13802",  # Target start
        "customfield_13803",  # Target end
    ]

    # Back to efficient mode: seed only non-done issues for backlog table.
    jql = f'"Leading Work Group" = "{work_group}" AND statusCategory != Done'

    cache_key = ("backlog_issues_v6", work_group)
    issues = _cache_get_or_build(
        cache_key,
        lambda: _jira_search_all(jql, fields_needed, page_size=500, hard_cap=20000),
        force_refresh=force_refresh,
    )
    if not issues:
        print(f"[Backlog] WG='{work_group}': no results from Jira")
        return {}

    features: dict[str, dict] = {}
    cap_cache: dict[str, dict] = {}

    for it in issues:
        key = it.get("key", "")
        f = it.get("fields") or {}
        if not _is_feature_type(f):
            continue
        if _status_category_key(f) == "done":
            continue

        cap_key = _extract_capability_key(f)
        cap_meta = _get_issue_meta(cap_key, cap_cache) if cap_key else {"summary": "", "leading_work_group": "", "created": "", "priority": ""}
        features[key] = {
            "summary": f.get("summary", "") or "",
            "status": ((f.get("status") or {}).get("name") or ""),
            "pi_scope": _pi_scope_value(f),
            "priority": _priority_name(f),
            "parent_link": cap_key,
            "parent_summary": cap_meta.get("summary", ""),
            "parent_leading_work_group": cap_meta.get("leading_work_group", ""),
            "parent_created": cap_meta.get("created", ""),
            "parent_priority": cap_meta.get("priority", ""),
            "fixVersions": _fix_versions(f),
            "archived_fixVersions": _archived_fix_versions(f),
            "linked_issues": _extract_linked_issue_links((f.get("issuelinks") or [])),
            "sprints": {},                 # not used on backlog page but kept for consistency
            "story_points": _story_points(f),
            "sum_story_points": 0.0,
            "assignee": _assignee_name(f),
            "reporter": _reporter_name(f),
            "target_start": (f.get("customfield_13802") or ""),
            "target_end": (f.get("customfield_13803") or ""),
            "stories_detail": [],
        }

    # Attach child Story/Fault Report estimation sums to seeded features.
    # Use a separate child query to avoid scan-all on backlog seed set.
    if features:
        child_fields = [
            "issuetype",
            "customfield_10708",  # Story Points
            "customfield_10702",  # Epic Link
            "parent",
            "issuelinks",
            "status",
            "assignee",
        ]
        child_jql = f'"Leading Work Group" = "{work_group}" AND updated >= -365d ORDER BY updated DESC'
        child_cache_key = ("backlog_child_issues_v2", work_group)
        child_issues = _cache_get_or_build(
            child_cache_key,
            lambda: _jira_search_all(child_jql, child_fields, page_size=500, hard_cap=40000),
            force_refresh=force_refresh,
        )

        feature_keys = set(features.keys())
        for it in (child_issues or []):
            child_key = it.get("key", "")
            f = it.get("fields") or {}
            itype_name = ((f.get("issuetype") or {}).get("name") or "").strip().lower()
            if itype_name not in ("story", "fault report"):
                continue
            parent_key = _resolve_parent_feature_key(f, feature_keys)
            if not parent_key or parent_key not in features:
                continue

            sp_val = _story_points(f)
            features[parent_key]["sum_story_points"] += sp_val
            features[parent_key]["stories_detail"].append({
                "key": child_key,
                "story_points": sp_val,
                "assignee": _assignee_name(f) or "Unassigned",
                "status": ((f.get("status") or {}).get("name") or ""),
            })

    print(f"[Backlog] WG='{work_group}': scanned={len(issues)} features_not_done={len(features)}")
    return features


def capabilities_data_service(work_group: str, force_refresh: bool = False) -> list[dict]:
    """
    Return all Capability issues for selected WG, including capabilities without linked features.
    """
    fields_needed = ["summary", "issuetype", "status", "customfield_14400", "created", "priority"]
    jql = f'"Leading Work Group" = "{work_group}" AND issuetype = Capability ORDER BY key ASC'

    cache_key = ("capability_issues_v3", work_group)
    issues = _cache_get_or_build(
        cache_key,
        lambda: _jira_search_all(jql, fields_needed, page_size=500, hard_cap=10000),
        force_refresh=force_refresh,
    )

    out = []
    for it in issues or []:
        key = it.get("key", "")
        fields = it.get("fields") or {}
        out.append({
            "key": key,
            "summary": fields.get("summary", "") or "",
            "status": ((fields.get("status") or {}).get("name") or ""),
            "leading_work_group": _leading_work_group_value(fields),
            "created": fields.get("created", "") or "",
            "priority": _priority_name(fields),
        })

    return out


# ======================================================================
#                               FLASK ROUTES
# ======================================================================

@app.route("/")
def home():
    return render_template("index.html", active_page="dashboard")

@app.route("/issue_data")
def issue_data():
    fix_version = request.args.get("fixVersion", "PI_25w10")
    work_group = request.args.get("workGroup", "ART - BCRC - BSW TFW")
    force_refresh = _is_force_refresh_requested()
    issues = fr_list_issues(fix_version, work_group, force_refresh=force_refresh)
    return jsonify(issues)

@app.route("/stats")
def stats():
    fix_version = request.args.get("fixVersion", "PI_25w10")
    work_group = request.args.get("workGroup", "ART - BCRC - BSW TFW")
    force_refresh = _is_force_refresh_requested()
    return jsonify(get_statistics(fix_version, work_group, force_refresh=force_refresh))

@app.route("/pi-planning")
def pi_planning():
    return render_template("pi_planning.html", active_page="pi-planning")

@app.route("/pi_planning_data")
def pi_planning_data():
    fix_version = request.args.get("fixVersion", "PI_25w10")
    work_group  = request.args.get("workGroup", "ART - BCRC - BSW TFW")
    raw_excl    = request.args.get("excludeAssignees", "")
    excluded    = _parse_excluded(raw_excl)
    force_refresh = _is_force_refresh_requested()
    data = pi_planning_data_service(fix_version, work_group, excluded, force_refresh=force_refresh)
    return jsonify(data)

@app.route("/backlog")
def backlog():
    return render_template("backlog.html", active_page="backlog")

@app.route("/roadmap")
def roadmap():
    return render_template("roadmap.html", active_page="roadmap")


@app.route("/team-capacity")
def team_capacity():
    return render_template("team_capacity.html", active_page="team-capacity")


@app.route("/settings")
def settings_page():
    return render_template("settings.html", active_page="settings")

@app.route("/backlog_data")
def backlog_data():
    work_group = request.args.get("workGroup", "ART - BCRC - BSW TFW")
    force_refresh = _is_force_refresh_requested()
    return jsonify(backlog_data_service(work_group, force_refresh=force_refresh))


@app.route("/capabilities_data")
def capabilities_data():
    work_group = request.args.get("workGroup", "ART - BCRC - BSW TFW")
    force_refresh = _is_force_refresh_requested()
    return jsonify(capabilities_data_service(work_group, force_refresh=force_refresh))


@app.route("/jira_user_search")
def jira_user_search():
    query_text = (request.args.get("q") or "").strip()
    if len(query_text) < 2:
        return jsonify({"ok": True, "users": []})
    try:
        users = _jira_user_search(query_text, max_results=20)
        return jsonify({"ok": True, "users": users})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "users": []}), 502


@app.route("/roadmap_teammates")
def roadmap_teammates():
    work_group = (request.args.get("workGroup") or "").strip()
    fix_version = (request.args.get("fixVersion") or "").strip()
    if not work_group:
        return jsonify({"ok": False, "error": "workGroup is required", "teammates": []}), 400
    teammates = _team_capacity_teammates(work_group, fix_version if fix_version else None)
    return jsonify({"ok": True, "teammates": teammates})


@app.route("/app_settings", methods=["GET", "POST"])
def app_settings():
    if request.method == "GET":
        return jsonify({"ok": True, "settings": _load_app_settings()})

    data = request.get_json(silent=True) or {}
    candidate = data.get("settings") if isinstance(data, dict) else {}
    normalized = _normalize_app_settings(candidate if isinstance(candidate, dict) else {})
    _save_app_settings(normalized)
    return jsonify({"ok": True, "settings": normalized})


@app.route("/team_capacity_data", methods=["GET", "POST"])
def team_capacity_data():
    if request.method == "GET":
        work_group = (request.args.get("workGroup") or "").strip()
        fix_version = (request.args.get("fixVersion") or "").strip()
        if not work_group or not fix_version:
            return jsonify({"ok": False, "error": "workGroup and fixVersion are required"}), 400

        store = _load_team_capacity_store()
        key = _team_capacity_key(work_group, fix_version)
        payload = store.get(key) or {
            "workGroup": work_group,
            "fixVersion": fix_version,
            "startWeek": None,
            "sprintWeeks": _default_sprint_weeks(),
            "members": [],
            "updatedAt": None,
        }
        payload["startWeek"] = _normalize_start_week((payload or {}).get("startWeek"))
        return jsonify({"ok": True, "data": payload})

    data = request.get_json(silent=True) or {}
    work_group = (data.get("workGroup") or "").strip()
    fix_version = (data.get("fixVersion") or "").strip()
    members_raw = data.get("members") or []
    start_week_raw = data.get("startWeek")
    sprint_weeks_raw = data.get("sprintWeeks") or {}

    if not work_group or not fix_version:
        return jsonify({"ok": False, "error": "workGroup and fixVersion are required"}), 400
    if not isinstance(members_raw, list):
        return jsonify({"ok": False, "error": "members must be an array"}), 400

    sprint_weeks = _normalize_sprint_weeks(sprint_weeks_raw)
    start_week = _normalize_start_week(start_week_raw)

    normalized = []
    seen_members = set()
    for row in members_raw:
        member = _normalize_member(row)
        member["weekValues"] = _normalize_member_week_values(row, sprint_weeks)
        member_name = member.get("displayName", "").strip()
        member_id = member.get("accountId", "").strip()
        dedupe_key = member_id or member_name.lower()
        if not member_name:
            continue
        if dedupe_key in seen_members:
            continue
        seen_members.add(dedupe_key)
        normalized.append(member)

    updated_at = datetime.now(timezone.utc).isoformat()
    payload = {
        "workGroup": work_group,
        "fixVersion": fix_version,
        "startWeek": start_week,
        "sprintWeeks": sprint_weeks,
        "members": normalized,
        "updatedAt": updated_at,
    }

    store = _load_team_capacity_store()
    store[_team_capacity_key(work_group, fix_version)] = payload
    _save_team_capacity_store(store)

    return jsonify({"ok": True, "data": payload})

# --------------- Exports ---------------

@app.route("/export_excel")
def export_excel():
    fix_version = request.args.get("fixVersion", "PI_25w10")
    work_group = request.args.get("workGroup", "ART - BCRC - BSW TFW")
    issues = fr_list_issues(fix_version, work_group)

    rows = []
    for issue in issues:
        rows.append({
            "Key": issue["key"],
            "Summary": issue["summary"],
            "Status": issue["status"]["name"] if isinstance(issue["status"], dict) else issue["status"],
            "Labels": ", ".join(issue.get("labels", [])),
            "Classes": ", ".join(issue.get("classes", [])),
            "Linked Features": ", ".join([f["key"] for f in issue.get("linked_features", [])]),
        })

    df = pd.DataFrame(rows)
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine='xlsxwriter') as writer:
        df.to_excel(writer, index=False, sheet_name='Dashboard')

    output.seek(0)
    return send_file(
        output,
        download_name=f"dashboard_export_{fix_version}.xlsx",
        as_attachment=True,
        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )

@app.route("/export_committed_excel")
def export_committed_excel():
    fix_version = request.args.get("fixVersion", "PI_25w10")
    work_group = request.args.get("workGroup", "ART - BCRC - BSW TFW")
    raw_excl = request.args.get("excludeAssignees", "")
    text_query = (request.args.get("q", "") or "").strip().lower()
    excluded = _parse_excluded(raw_excl)

    features = pi_planning_data_service(fix_version, work_group, excluded)

    committed = []
    for key, feature in features.items():
        if feature.get("pi_scope") == "Committed" and fix_version in feature.get("fixVersions", []):
            committed.append((key, feature))

    if text_query:
        def _matches_feature_text(feature_key: str, feature: dict) -> bool:
            sprint_keys = []
            for arr in (feature.get("sprints") or {}).values():
                if isinstance(arr, list):
                    sprint_keys.extend([str(x) for x in arr if x])

            parts = [
                feature_key,
                feature.get("summary", ""),
                feature.get("status", ""),
                feature.get("priority", ""),
                feature.get("assignee", ""),
                feature.get("reporter", ""),
                feature.get("pi_scope", ""),
                feature.get("parent_summary", ""),
                feature.get("parent_link", ""),
                " ".join((feature.get("fixVersions") or [])),
                " ".join(sprint_keys),
                " ".join(l.get("key", "") for l in (feature.get("linked_issues") or [])),
            ]
            haystack = " ".join(str(p) for p in parts if p).lower()
            return text_query in haystack

        committed = [(k, f) for (k, f) in committed if _matches_feature_text(k, f)]

    sprints = ["Sprint 1", "Sprint 2", "Sprint 3", "Sprint 4", "Sprint 5", "No Sprint"]
    rows = []
    for key, feature in committed:
        row = {
            "Capability": feature.get("parent_summary") or feature.get("parent_link") or "",
            "Feature ID": key,
            "Feature Name": feature["summary"],
            "Story Points": feature.get("story_points", ""),
            "Assignee": feature.get("assignee", ""),
            "Priority": feature.get("priority", ""),
            "Status": feature.get("status", ""),
            "PI Scope": feature.get("pi_scope", ""),
            "Links": ", ".join([l["key"] for l in feature.get("linked_issues", [])]),
        }
        for sprint in sprints:
            row[sprint] = ", ".join(feature["sprints"].get(sprint, []))
        rows.append(row)

    df = pd.DataFrame(rows)
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine='xlsxwriter') as writer:
        df.to_excel(writer, index=False, sheet_name='Committed')

        workbook = writer.book
        worksheet = writer.sheets['Committed']
        hyperlink_format = workbook.add_format({'font_color': 'blue', 'underline': 1})

        for excel_row, (key, feature) in enumerate(committed, start=1):
            feature_url = f"https://jira-vira.volvocars.biz/browse/{key}"
            worksheet.write_url(excel_row, 1, feature_url, hyperlink_format, string=key)

            cap_key = feature.get("parent_link") or ""
            cap_text = feature.get("parent_summary") or cap_key
            if cap_key:
                cap_url = f"https://jira-vira.volvocars.biz/browse/{cap_key}"
                worksheet.write_url(excel_row, 0, cap_url, hyperlink_format, string=cap_text)

    output.seek(0)
    return send_file(
        output,
        download_name=f"pi_planning_committed_{fix_version}.xlsx",
        as_attachment=True,
        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )

@app.route("/export_backlog_excel", methods=["GET", "POST"])
def export_backlog_excel():
    payload = request.get_json(silent=True) or {}
    is_post = request.method == "POST"

    def _issue_url(issue_key: str) -> str:
        return f"https://jira-vira.volvocars.biz/browse/{issue_key}"

    def _first_issue_key(text: str) -> str:
        m = re.search(r"\b([A-Z][A-Z0-9]+-\d+)\b", str(text or ""))
        return m.group(1) if m else ""

    if is_post and isinstance(payload, dict):
        visible_table = payload.get("visibleTable")
        if isinstance(visible_table, dict):
            headers = visible_table.get("headers") or []
            rows = visible_table.get("rows") or []
            if isinstance(headers, list) and isinstance(rows, list) and headers:
                clean_headers = [str(h or "").strip() for h in headers if str(h or "").strip()]
                if clean_headers:
                    normalized_rows = []
                    for row in rows:
                        if not isinstance(row, list):
                            continue
                        values = [str(v or "").strip() for v in row]
                        if not values:
                            continue
                        if len(values) < len(clean_headers):
                            values = values + [""] * (len(clean_headers) - len(values))
                        elif len(values) > len(clean_headers):
                            values = values[:len(clean_headers)]
                        normalized_rows.append(values)

                    df = pd.DataFrame(normalized_rows, columns=clean_headers)
                    output = io.BytesIO()
                    with pd.ExcelWriter(output, engine='xlsxwriter') as writer:
                        df.to_excel(writer, index=False, sheet_name='Backlog')

                        workbook = writer.book
                        worksheet = writer.sheets['Backlog']
                        hyperlink_format = workbook.add_format({'font_color': 'blue', 'underline': 1})

                        feature_idx = clean_headers.index("Feature ID") if "Feature ID" in clean_headers else -1
                        capability_idx = clean_headers.index("Capability") if "Capability" in clean_headers else -1

                        for excel_row, row_values in enumerate(normalized_rows, start=1):
                            if feature_idx >= 0 and feature_idx < len(row_values):
                                feature_key = _first_issue_key(row_values[feature_idx])
                                if feature_key:
                                    worksheet.write_url(excel_row, feature_idx, _issue_url(feature_key), hyperlink_format, string=feature_key)

                            if capability_idx >= 0 and capability_idx < len(row_values):
                                cap_text = str(row_values[capability_idx] or "")
                                cap_key = _first_issue_key(cap_text)
                                if cap_key:
                                    worksheet.write_url(excel_row, capability_idx, _issue_url(cap_key), hyperlink_format, string=cap_text)

                    output.seek(0)
                    return send_file(
                        output,
                        download_name="backlog_visible.xlsx",
                        as_attachment=True,
                        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                    )

    work_group = (
        payload.get("workGroup") if is_post else (request.args.get("WorkGroup", None) or request.args.get("workGroup"))
    ) or "ART - BCRC - BSW TFW"
    text_query = ((payload.get("q") if is_post else request.args.get("q", "")) or "").strip().lower()
    features = backlog_data_service(work_group)

    feature_ids = []
    if is_post:
        raw_feature_ids = payload.get("featureIds") or []
        if isinstance(raw_feature_ids, list):
            feature_ids = [str(x).strip() for x in raw_feature_ids if str(x).strip()]
        elif isinstance(raw_feature_ids, str):
            feature_ids = [s.strip() for s in raw_feature_ids.split(",") if s.strip()]
    else:
        feature_ids = request.args.getlist("featureId") or []
        if not feature_ids:
            raw_feature_ids = request.args.get("featureIds", "")
            if raw_feature_ids:
                feature_ids = [s.strip() for s in raw_feature_ids.split(",") if s.strip()]
    selected_feature_ids = {str(fid).strip() for fid in feature_ids if str(fid).strip()}
    if selected_feature_ids:
        by_id_features = {
            key: feature
            for key, feature in features.items()
            if key in selected_feature_ids
        }
        if by_id_features:
            features = by_id_features

    requested_statuses = []
    if is_post:
        raw_statuses = payload.get("statuses") or []
        if isinstance(raw_statuses, list):
            requested_statuses = [str(s).strip() for s in raw_statuses if str(s).strip()]
        elif isinstance(raw_statuses, str):
            requested_statuses = [s.strip() for s in raw_statuses.split(",") if s.strip()]
    else:
        requested_statuses = request.args.getlist("status") or []
        if not requested_statuses:
            raw_statuses = request.args.get("statuses", "")
            if raw_statuses:
                requested_statuses = [s.strip() for s in raw_statuses.split(",") if s.strip()]

    allowed_statuses = {s.strip().lower() for s in requested_statuses if s and s.strip()}
    if allowed_statuses:
        features = {
            key: feature
            for key, feature in features.items()
            if str(feature.get("status", "")).strip().lower() in allowed_statuses
        }

    if text_query:
        def _matches_text(feature_key: str, feature: dict) -> bool:
            parts = [
                feature_key,
                feature.get("summary", ""),
                feature.get("status", ""),
                feature.get("priority", ""),
                feature.get("assignee", ""),
                feature.get("pi_scope", ""),
                feature.get("parent_summary", ""),
                feature.get("parent_link", ""),
                " ".join((feature.get("fixVersions") or [])),
                " ".join(l.get("key", "") for l in (feature.get("linked_issues") or [])),
            ]
            haystack = " ".join(str(p) for p in parts if p).lower()
            return text_query in haystack

        features = {
            key: feature
            for key, feature in features.items()
            if _matches_text(key, feature)
        }

    sprints = ["Sprint 1", "Sprint 2", "Sprint 3", "Sprint 4", "Sprint 5", "No Sprint"]
    columns = [
        "Capability",
        "Feature ID",
        "Feature Name",
        "Story Points",
        "Assignee",
        "Priority",
        "Status",
        "PI Scope",
        "Links",
        *sprints,
    ]
    rows = []
    for key, feature in features.items():
        row = {
            "Capability": feature.get("parent_summary") or feature.get("parent_link") or "",
            "Feature ID": key,
            "Feature Name": feature.get("summary", ""),
            "Story Points": feature.get("story_points", ""),
            "Assignee": feature.get("assignee", ""),
            "Priority": feature.get("priority", ""),
            "Status": feature.get("status", ""),
            "PI Scope": feature.get("pi_scope", ""),
            "Links": ", ".join([l["key"] for l in feature.get("linked_issues", [])]),
        }
        for sprint in sprints:
            row[sprint] = ", ".join(feature["sprints"].get(sprint, []))
        rows.append(row)

    df = pd.DataFrame(rows, columns=columns)
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine='xlsxwriter') as writer:
        df.to_excel(writer, index=False, sheet_name='Backlog')

        workbook = writer.book
        worksheet = writer.sheets['Backlog']
        hyperlink_format = workbook.add_format({'font_color': 'blue', 'underline': 1})

        feature_idx = columns.index("Feature ID")
        capability_idx = columns.index("Capability")

        for excel_row, row in enumerate(rows, start=1):
            feature_key = str(row.get("Feature ID") or "").strip()
            if feature_key:
                worksheet.write_url(excel_row, feature_idx, _issue_url(feature_key), hyperlink_format, string=feature_key)

            cap_display = str(row.get("Capability") or "")
            cap_key = _first_issue_key(str((features.get(feature_key) or {}).get("parent_link") or cap_display))
            if cap_key:
                worksheet.write_url(excel_row, capability_idx, _issue_url(cap_key), hyperlink_format, string=cap_display)

    output.seek(0)
    return send_file(
        output,
        download_name=f"pi_planning_backlog.xlsx",
        as_attachment=True,
        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )

# ---------------- Tracking ----------------

@app.route('/track_user', methods=['POST'])
def track_user():
    data = request.get_json()
    user_id = data.get('user_id')
    if user_id:
        file_path = 'user_ids.txt'
        try:
            with open(file_path, 'r') as f:
                ids = set(line.strip() for line in f if line.strip())
        except FileNotFoundError:
            ids = set()
        if user_id not in ids:
            with open(file_path, 'a') as f:
                f.write(user_id + '\n')
    return jsonify({'ok': True})

@app.route('/unique_users')
def unique_users():
    file_path = 'user_ids.txt'
    try:
        with open(file_path, 'r') as f:
            ids = set(line.strip() for line in f if line.strip())
        return jsonify({'unique_users': len(ids)})
    except FileNotFoundError:
        return jsonify({'unique_users': 0})

# ---------------- Project Fault Reports ----------------

def search_project_fault_reports(keywords: str, work_group: str | None = None, force_refresh: bool = False):
    tokens = [t.strip() for t in re.split(r"[\n,;|]+", keywords or "") if t.strip()]
    if not tokens:
        return []

    term_clauses = [f'(summary ~ "{t}" OR description ~ "{t}")' for t in tokens]
    term_block = " OR ".join(term_clauses)

    jql_parts = ['type = "Fault Report"']
    if work_group:
        jql_parts.append(f'"Leading Work Group" = "{work_group}"')
    jql_parts.append(f"({term_block})")
    jql = " AND ".join(jql_parts)

    cache_key = ("project_fault_reports", keywords, work_group or "")
    issues = _cache_get_or_build(
        cache_key,
        lambda: _jira_search_all(jql, ["summary", "status", "fixVersions", "labels"], page_size=200),
        force_refresh=force_refresh,
    )
    out = []
    for it in issues or []:
        f = it.get("fields") or {}
        out.append({
            "key": it.get("key"),
            "summary": f.get("summary", ""),
            "status": (f.get("status") or {}).get("name", ""),
            "fixVersions": _fix_versions(f),
            "labels": [str(x) for x in (f.get("labels") or [])],
        })
    return out

@app.route("/project-fault-reports")
def project_fault_reports():
    return render_template("project_fault_reports.html", active_page="project-fr")

@app.route("/project_fault_reports_data")
def project_fault_reports_data():
    keywords = (request.args.get("keywords") or "").strip()
    work_group = (request.args.get("workGroup") or "").strip()
    force_refresh = _is_force_refresh_requested()
    if not keywords:
        return jsonify([])
    return jsonify(search_project_fault_reports(keywords, work_group or None, force_refresh=force_refresh))


@app.route("/update_fix_versions", methods=["POST"])
def update_fix_versions():
    data = request.get_json(silent=True) or {}

    issue_key = str(data.get("issueKey") or "").strip().upper()
    add_versions = data.get("addFixVersions") or []
    remove_versions = data.get("removeFixVersions") or []
    dry_run = bool(data.get("dryRun", True))

    if not re.fullmatch(r"[A-Z][A-Z0-9]+-\d+", issue_key):
        return jsonify({"ok": False, "error": "Invalid issueKey format"}), 400

    if not isinstance(add_versions, list) or not isinstance(remove_versions, list):
        return jsonify({"ok": False, "error": "addFixVersions/removeFixVersions must be arrays"}), 400

    add_versions = [str(v).strip() for v in add_versions if str(v).strip()]
    remove_versions = [str(v).strip() for v in remove_versions if str(v).strip()]

    if not add_versions and not remove_versions:
        return jsonify({"ok": False, "error": "Nothing to update (both add/remove are empty)"}), 400

    add_set = set(add_versions)
    remove_set = set(remove_versions)
    overlap = sorted(add_set & remove_set)
    if overlap:
        return jsonify({"ok": False, "error": f"Same version in add and remove: {', '.join(overlap)}"}), 400

    try:
        before = _jira_get_issue_fix_versions(issue_key)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502

    try:
        project_key = _jira_get_issue_project_key(issue_key)
        valid_versions = set(_jira_get_project_version_names(project_key))
        invalid_add = sorted([v for v in add_set if v not in valid_versions])
        if invalid_add:
            valid_versions = set(_jira_get_project_version_names(project_key, force_refresh=True))
            invalid_add = sorted([v for v in add_set if v not in valid_versions])
        if invalid_add:
            valid_qs = sorted([v for v in valid_versions if re.match(r"^QS_\d{2}w\d{2}$", v)])
            return jsonify({
                "ok": False,
                "error": f"Invalid Fix Version(s) for project {project_key}: {', '.join(invalid_add)}",
                "projectKey": project_key,
                "invalid": invalid_add,
                "validQsVersions": valid_qs,
                "issueKey": issue_key,
                "before": before,
            }), 400
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "issueKey": issue_key, "before": before}), 502

    if dry_run:
        after_set = set(before)
        after_set |= add_set
        after_set -= remove_set
        after = sorted(after_set)
        return jsonify({
            "ok": True,
            "dryRun": True,
            "issueKey": issue_key,
            "before": before,
            "requested": {"add": sorted(add_set), "remove": sorted(remove_set)},
            "afterPreview": after,
        })

    try:
        payload = _jira_update_issue_fix_versions(issue_key, sorted(add_set), sorted(remove_set))
        after = _jira_get_issue_fix_versions(issue_key)
        return jsonify({
            "ok": True,
            "dryRun": False,
            "issueKey": issue_key,
            "before": before,
            "after": after,
            "applied": {"add": sorted(add_set), "remove": sorted(remove_set)},
            "payload": payload,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "issueKey": issue_key, "before": before}), 502


@app.route("/update_priority", methods=["POST"])
def update_priority():
    data = request.get_json(silent=True) or {}

    issue_key = str(data.get("issueKey") or "").strip().upper()
    dry_run = bool(data.get("dryRun", True))
    raw_priority = data.get("priority")

    if not re.fullmatch(r"[A-Z][A-Z0-9]+-\d+", issue_key):
        return jsonify({"ok": False, "error": "Invalid issueKey format"}), 400

    try:
        priority_number = int(raw_priority)
    except Exception:
        return jsonify({"ok": False, "error": "priority must be integer 1..10"}), 400

    if priority_number < 1 or priority_number > 10:
        return jsonify({"ok": False, "error": "priority must be in range 1..10"}), 400

    try:
        before_issue = requests.get(f"{JIRA_ISSUE}/{issue_key}", headers=HEADERS, params={"fields": "priority"})
        if before_issue.status_code != 200:
            raise RuntimeError(f"Failed to read issue {issue_key}: {before_issue.status_code} {before_issue.text}")
        before_priority = (((before_issue.json().get("fields") or {}).get("priority") or {}).get("name") or "")

        priority_id, priority_name = _resolve_priority_id_from_number(priority_number)

        if dry_run:
            return jsonify({
                "ok": True,
                "dryRun": True,
                "issueKey": issue_key,
                "before": before_priority,
                "requested": priority_number,
                "resolved": {"id": priority_id, "name": priority_name},
            })

        payload = _jira_update_issue_priority(issue_key, priority_id)

        after_issue = requests.get(f"{JIRA_ISSUE}/{issue_key}", headers=HEADERS, params={"fields": "priority"})
        if after_issue.status_code != 200:
            raise RuntimeError(f"Failed to read updated issue {issue_key}: {after_issue.status_code} {after_issue.text}")
        after_priority = (((after_issue.json().get("fields") or {}).get("priority") or {}).get("name") or "")

        return jsonify({
            "ok": True,
            "dryRun": False,
            "issueKey": issue_key,
            "before": before_priority,
            "after": after_priority,
            "requested": priority_number,
            "resolved": {"id": priority_id, "name": priority_name},
            "payload": payload,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "issueKey": issue_key}), 502


@app.route("/update_estimation", methods=["POST"])
def update_estimation():
    data = request.get_json(silent=True) or {}

    issue_key = str(data.get("issueKey") or "").strip().upper()
    dry_run = bool(data.get("dryRun", True))
    raw_estimation = data.get("estimation")

    if not re.fullmatch(r"[A-Z][A-Z0-9]+-\d+", issue_key):
        return jsonify({"ok": False, "error": "Invalid issueKey format"}), 400

    try:
        estimation_value = int(raw_estimation)
    except Exception:
        return jsonify({"ok": False, "error": "estimation must be an integer"}), 400

    try:
        before_estimation = _jira_get_issue_estimation(issue_key)

        if dry_run:
            return jsonify({
                "ok": True,
                "dryRun": True,
                "issueKey": issue_key,
                "before": before_estimation,
                "requested": estimation_value,
            })

        payload = _jira_update_issue_estimation(issue_key, estimation_value)
        after_estimation = _jira_get_issue_estimation(issue_key)

        return jsonify({
            "ok": True,
            "dryRun": False,
            "issueKey": issue_key,
            "before": before_estimation,
            "after": after_estimation,
            "requested": estimation_value,
            "payload": payload,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "issueKey": issue_key}), 502


@app.route("/update_assignee", methods=["POST"])
def update_assignee():
    data = request.get_json(silent=True) or {}

    issue_key = str(data.get("issueKey") or "").strip().upper()
    dry_run = bool(data.get("dryRun", True))
    account_id = str(data.get("accountId") or "").strip()
    display_name = str(data.get("displayName") or "").strip()
    email_address = str(data.get("emailAddress") or "").strip()

    if not re.fullmatch(r"[A-Z][A-Z0-9]+-\d+", issue_key):
        return jsonify({"ok": False, "error": "Invalid issueKey format"}), 400
    if not account_id and not display_name and not email_address:
        return jsonify({"ok": False, "error": "accountId or displayName/emailAddress is required"}), 400

    try:
        before_assignee = _jira_get_issue_assignee(issue_key)
        resolved_identity = _resolve_user_identity(account_id, display_name, email_address)

        if dry_run:
            return jsonify({
                "ok": True,
                "dryRun": True,
                "issueKey": issue_key,
                "before": before_assignee,
                "requested": {"accountId": account_id, "displayName": display_name, "emailAddress": email_address},
                "resolved": resolved_identity,
            })

        payload = _jira_update_issue_assignee(issue_key, resolved_identity)
        after_assignee = _jira_get_issue_assignee(issue_key)

        return jsonify({
            "ok": True,
            "dryRun": False,
            "issueKey": issue_key,
            "before": before_assignee,
            "after": after_assignee,
            "requested": {"accountId": account_id, "displayName": display_name, "emailAddress": email_address},
            "resolved": resolved_identity,
            "payload": payload,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "issueKey": issue_key}), 502


@app.route("/update_pi_scope", methods=["POST"])
def update_pi_scope():
    data = request.get_json(silent=True) or {}

    issue_key = str(data.get("issueKey") or "").strip().upper()
    dry_run = bool(data.get("dryRun", True))
    raw_scope = str(data.get("piScope") or "").strip()

    if not re.fullmatch(r"[A-Z][A-Z0-9]+-\d+", issue_key):
        return jsonify({"ok": False, "error": "Invalid issueKey format"}), 400

    try:
        before_scope = _jira_get_issue_pi_scope(issue_key)

        normalized = raw_scope.lower()
        if not normalized or normalized == "none":
            requested_scope = ""
        elif normalized == "committed":
            requested_scope = "Committed"
        elif normalized == "stretch":
            requested_scope = "Stretch"
        elif normalized in ("not included", "notincluded"):
            requested_scope = "Not Included"
        else:
            return jsonify({"ok": False, "error": "piScope must be one of: None, Committed, Stretch, Not Included"}), 400

        if dry_run:
            return jsonify({
                "ok": True,
                "dryRun": True,
                "issueKey": issue_key,
                "before": before_scope,
                "requested": requested_scope,
            })

        payload = _jira_update_issue_pi_scope(issue_key, requested_scope)
        after_scope = _jira_get_issue_pi_scope(issue_key)

        return jsonify({
            "ok": True,
            "dryRun": False,
            "issueKey": issue_key,
            "before": before_scope,
            "after": after_scope,
            "requested": requested_scope,
            "payload": payload,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "issueKey": issue_key}), 502


@app.route("/feature_details")
def feature_details():
    issue_key = str(request.args.get("issueKey") or "").strip().upper()
    force_refresh = _is_force_refresh_requested()

    if not re.fullmatch(r"[A-Z][A-Z0-9]+-\d+", issue_key):
        return jsonify({"ok": False, "error": "Invalid issueKey format"}), 400

    try:
        cache_key = ("feature_details", issue_key)

        def _build():
            issue_url = f"{JIRA_ISSUE}/{issue_key}"
            issue_resp = requests.get(
                issue_url,
                headers=HEADERS,
                params={
                    "fields": ",".join([
                        "summary",
                        "description",
                        "assignee",
                        "reporter",
                        "customfield_10708",
                        "customfield_12421",
                    ])
                },
            )
            if issue_resp.status_code != 200:
                raise RuntimeError(f"Failed to read issue {issue_key}: {issue_resp.status_code} {issue_resp.text}")

            fields = (issue_resp.json().get("fields") or {})

            stories_jql = f'"Epic Link" = "{issue_key}"'
            story_issues = _jira_search_all(stories_jql, ["customfield_10708", "summary"], page_size=200, hard_cap=5000)
            stories_estimation = 0.0
            for st in story_issues or []:
                st_fields = st.get("fields") or {}
                stories_estimation += _story_points(st_fields)

            feature_estimation = _story_points(fields)

            return {
                "ok": True,
                "issueKey": issue_key,
                "summary": fields.get("summary", "") or "",
                "acceptance_criteria": _extract_text_value(fields.get("customfield_12421")),
                "description": _extract_text_value(fields.get("description")),
                "assignee": _assignee_name(fields),
                "reporter": _reporter_name(fields),
                "feature_estimation": feature_estimation,
                "stories_estimation": stories_estimation,
                "stories_count": len(story_issues or []),
            }

        return jsonify(_cache_get_or_build(cache_key, _build, force_refresh=force_refresh))
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "issueKey": issue_key}), 502

# ---------------- Main ----------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run Flask backend with custom IP and port")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host IP to bind (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=80, help="Port to bind (default: 80)")
    parser.add_argument("--debug", action="store_true", help="Enable Flask debug mode")
    args = parser.parse_args()
    app.run(host=args.host, port=args.port, debug=args.debug)
