import requests
from collections import Counter
from flask import Flask, jsonify, render_template, request, send_file
import os
import io
import copy
import pandas as pd
from dotenv import load_dotenv
import re
import argparse

load_dotenv()

app = Flask(__name__)

JIRA_BASE_URL = "https://jira-vira.volvocars.biz/rest/api/2"
JIRA_SEARCH = f"{JIRA_BASE_URL}/search"
JIRA_ISSUE = f"{JIRA_BASE_URL}/issue"

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
        return {"summary": "", "leading_work_group": "", "created": ""}
    if key in cache:
        return cache[key]

    url = f"{JIRA_ISSUE}/{key}"
    resp = requests.get(url, headers=HEADERS, params={"fields": "summary,customfield_14400,created"})
    if resp.status_code == 200:
        fields = (resp.json().get("fields") or {})
        meta = {
            "summary": fields.get("summary", "") or "",
            "leading_work_group": _leading_work_group_value(fields),
            "created": fields.get("created", "") or "",
        }
        cache[key] = meta
        return meta

    meta = {"summary": "", "leading_work_group": "", "created": ""}
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

    # Narrow on the server (but don't use issuetype name to avoid env differences)
    jql = f'"Leading Work Group" = "{work_group}" AND statusCategory != Done'

    # >>> KEY CHANGE: paginate instead of taking only the first 1000
    cache_key = ("backlog_issues_v4", work_group)
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
        cap_meta = _get_issue_meta(cap_key, cap_cache) if cap_key else {"summary": "", "leading_work_group": "", "created": ""}
        features[key] = {
            "summary": f.get("summary", "") or "",
            "status": ((f.get("status") or {}).get("name") or ""),
            "pi_scope": _pi_scope_value(f),
            "priority": _priority_name(f),
            "parent_link": cap_key,
            "parent_summary": cap_meta.get("summary", ""),
            "parent_leading_work_group": cap_meta.get("leading_work_group", ""),
            "parent_created": cap_meta.get("created", ""),
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

    print(f"[Backlog] WG='{work_group}': scanned={len(issues)} features_not_done={len(features)}")
    return features


def capabilities_data_service(work_group: str, force_refresh: bool = False) -> list[dict]:
    """
    Return all Capability issues for selected WG, including capabilities without linked features.
    """
    fields_needed = ["summary", "issuetype", "status", "customfield_14400", "created"]
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

@app.route("/export_backlog_excel")
def export_backlog_excel():
    work_group = request.args.get("WorkGroup", None) or request.args.get("workGroup", "ART - BCRC - BSW TFW")
    text_query = (request.args.get("q", "") or "").strip().lower()
    features = backlog_data_service(work_group)

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

    rows = []
    sprints = ["Sprint 1", "Sprint 2", "Sprint 3", "Sprint 4", "Sprint 5", "No Sprint"]
    for key, feature in features.items():
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
        df.to_excel(writer, index=False, sheet_name='Backlog')

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

# ---------------- Main ----------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run Flask backend with custom IP and port")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host IP to bind (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=80, help="Port to bind (default: 80)")
    parser.add_argument("--debug", action="store_true", help="Enable Flask debug mode")
    args = parser.parse_args()
    app.run(host=args.host, port=args.port, debug=args.debug)
