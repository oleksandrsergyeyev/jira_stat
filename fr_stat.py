import requests
from collections import Counter
from flask import Flask, jsonify, render_template, request, send_file
import os
import io
import pandas as pd
from dotenv import load_dotenv
import re
import argparse
import json

load_dotenv()

app = Flask(__name__)

JIRA_BASE_URL = "https://jira-vira.volvocars.biz/rest/api/2"
JIRA_SEARCH = f"{JIRA_BASE_URL}/search"
JIRA_ISSUE = f"{JIRA_BASE_URL}/issue"

JIRA_TOKEN = os.getenv("JIRA_TOKEN")

headers = {
    "Authorization": f"Bearer {JIRA_TOKEN}",
    "Content-Type": "application/json"
}

class Jira:

    def __init__(self):
        self.jira_token = JIRA_TOKEN
        self.headers = headers

    def fetch_issue(self, key, fields=None):
        """GET a single issue with the fields we need."""
        url = f"{JIRA_ISSUE}/{key}"
        params = {}
        if fields:
            params["fields"] = ",".join(fields)
        resp = requests.get(url, headers=self.headers, params=params)
        if resp.status_code == 200:
            return resp.json()
        return None

    def _seed_feature_from_issue(self, issue_json, summary_cache):
        """Create a features[key] row from a raw issue (Feature/Epic)."""
        fields = issue_json.get("fields", {}) or {}
        key = issue_json.get("key", "")
        if not key:
            return None

        issuetype_name = (fields.get("issuetype", {}) or {}).get("name", "").lower()
        if "feature" not in issuetype_name and issuetype_name != "epic":
            return None  # only seed features/epics

        # PI Scope
        pi_scope_field = fields.get("customfield_14700")
        pi_scope_value = pi_scope_field.get("value", "") if isinstance(pi_scope_field, dict) else (pi_scope_field or "")

        # Priority
        prio_field = fields.get("priority")
        priority_value = (prio_field or {}).get("name", "") if isinstance(prio_field, dict) else (prio_field or "")

        # Capability parent (customfield_13801)
        parent_link = fields.get("customfield_13801", "")
        if isinstance(parent_link, dict):
            parent_link_value = parent_link.get("key", "") or ""
        else:
            parent_link_value = parent_link or ""

        parent_summary = ""
        if parent_link_value:
            parent_summary = self.get_issue_summary(parent_link_value, summary_cache) or ""

        # FixVersions
        fix_versions = []
        for fv in fields.get("fixVersions", []) or []:
            name = fv.get("name")
            if name:
                fix_versions.append(name)

        # Feature-level SP
        feature_sp = fields.get("customfield_10708", 0)
        try:
            feature_sp = float(feature_sp) if feature_sp not in (None, "") else 0.0
        except Exception:
            feature_sp = 0.0

        # Assignee
        assignee_obj = fields.get("assignee")
        assignee_display = assignee_obj.get("displayName") if isinstance(assignee_obj, dict) else ""

        # Build row
        return key, {
            "summary": fields.get("summary", "") or "",
            "status": (fields.get("status", {}) or {}).get("name", "") or "",
            "pi_scope": pi_scope_value,
            "priority": priority_value,
            "parent_link": parent_link_value,
            "parent_summary": parent_summary,
            "fixVersions": fix_versions,
            "linked_issues": self.extract_linked_issue_links(fields.get("issuelinks", []) or []),
            "sprints": {},
            "story_points": feature_sp,
            "sum_story_points": 0.0,
            "assignee": assignee_display,
            "stories_detail": [],
        }


    def list_issues(self, fix_version, work_group):
        jql_query = (
            'type = "Fault Report" AND '
            f'"Leading Work Group" = "{work_group}" AND '
            f'fixVersion = "{fix_version}" '
            ' AND (labels = "BuildIssue" AND labels = "Internal_Dev")'
        )

        payload = {
            "jql": jql_query,
            "maxResults": 100,
            "fields": ["summary", "status", "fixVersions", "labels", "issuelinks"]
        }
        response = requests.post(JIRA_SEARCH, json=payload, headers=headers)
        result_data = []
        if response.status_code == 200:
            data = response.json()
            for issue in data.get("issues", []):
                result_data.append({
                    "key": issue['key'],
                    "summary": issue['fields']['summary'],
                    "status": issue['fields']['status'],
                    "labels": [label.lower() for label in issue['fields']['labels']],
                    "classes": [
                        self.get_classes(label.lower())
                        for label in issue['fields']['labels']
                        if self.get_classes(label.lower()) not in ["buildissue", "internal_dev", "internla_dev"]
                    ],
                    "linked_features": self.extract_linked_features(issue['fields'].get("issuelinks", []))
                })
        else:
            print(f"Error: {response.status_code}, {response.text}")
        return result_data

    def extract_linked_features(self, links):
        result = []
        for link in links:
            issue_data = link.get("inwardIssue") or link.get("outwardIssue")
            if issue_data:
                fields = issue_data.get("fields", {})
                issuetype = fields.get("issuetype", {})
                if issuetype.get("id") == "10400":  # Only Feature type
                    key = issue_data.get("key")
                    summary = fields.get("summary", "")
                    if key:
                        result.append({
                            "key": key,
                            "url": f"https://jira-vira.volvocars.biz/browse/{key}",
                            "summary": summary
                        })
        return result

    def extract_linked_issue_links(self, links):
        result = []
        for link in links:
            link_type = link.get("type", {}).get("outward", "") or link.get("type", {}).get("inward", "")
            # figure out which is populated
            outward_issue = link.get("outwardIssue")
            inward_issue = link.get("inwardIssue")
            issue = outward_issue or inward_issue
            if issue and "key" in issue:
                key = issue["key"]
                # choose which direction applies
                if outward_issue and link.get("type", {}).get("outward"):
                    direction = link.get("type", {}).get("outward")
                elif inward_issue and link.get("type", {}).get("inward"):
                    direction = link.get("type", {}).get("inward")
                else:
                    direction = ""
                result.append({
                    "key": key,
                    "url": f"https://jira-vira.volvocars.biz/browse/{key}",
                    "link_type": direction
                })
        return result

    def get_statistics(self, fix_version, work_group):
        all_classes = [cls for issue in self.list_issues(fix_version, work_group) for cls in issue["classes"]]
        class_counts = Counter(all_classes)
        return class_counts

    def show_statistic(self):
        all_labels = [label for issue in self.list_issues() for label in issue["labels"]]
        label_counts = Counter(all_labels)
        print("Issue Statistics:")
        for label, count in label_counts.most_common():
            if label not in ["internal_dev", "buildissue", "internla_dev"]:
                print(f"{label}: {count}")

    def get_classes(self, label):
        parts = label.split('_', 2)
        return '_'.join(parts[:2]) if len(parts) > 1 else label

    def get_issue_summary(self, key, summary_cache):
        if key in summary_cache:
            return summary_cache[key]
        url = f"{JIRA_ISSUE}/{key}"
        resp = requests.get(url, headers=self.headers)
        if resp.status_code == 200:
            summary = resp.json()["fields"]["summary"]
            summary_cache[key] = summary
            return summary
        return ""

    def get_pi_planning(self, fix_version, work_group):
        """
        Build PI Planning data for a given Leading Work Group.

        - Rows are Features/Epics; children (Stories/Fault Reports) contribute to sprint cells & details.
        - Sprint names are normalized to canonical "Sprint N".
        - A child issue is assigned to a sprint ONLY if that sprint's raw name contains the PI token
          derived from `fix_version` (e.g., "25w37"). Otherwise it goes to "No Sprint".
        - Story points are counted only from *real children* (Epic Link/parent), NOT from generic issue links.
        - If a child belongs to this work group but its parent Feature/Epic wasn't returned by the JQL,
          we fetch and seed that parent on-the-fly so the Feature appears in the tables.
        """

        # ---- Extract PI token from fix_version, e.g., "PI_25w10" -> "25w10"
        def extract_pi_token(fx: str) -> str:
            if not fx:
                return ""
            m = re.search(r"(\d{2}w\d{2})", fx, flags=re.IGNORECASE)
            return m.group(1).lower() if m else ""

        pi_token = extract_pi_token(fix_version)

        # ---- Normalize sprint names and check if sprint belongs to the current PI
        # Returns (canonical_name, matches_pi)
        def match_and_normalize_sprint(raw, pi_token_lc: str):
            if raw is None:
                return (None, False)

            if isinstance(raw, list):
                best = None
                for entry in raw:
                    c, ok = match_and_normalize_sprint(entry, pi_token_lc)
                    if ok and c:
                        return (c, True)
                    if best is None and c:
                        best = c
                return (best, False)

            if isinstance(raw, dict):
                for k in ("name", "Name", "toString", "value"):
                    v = raw.get(k)
                    if isinstance(v, str) and v:
                        return match_and_normalize_sprint(v, pi_token_lc)
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

        # ---- From issue links, try to discover a parent Feature/Epic (fallback)
        def find_parent_feature_from_links(issuelinks, known_feature_keys: set):
            if not issuelinks:
                return None
            for link in issuelinks:
                for side in ("outwardIssue", "inwardIssue"):
                    issue = link.get(side)
                    if not issue:
                        continue
                    key = issue.get("key")
                    fields = issue.get("fields", {}) or {}
                    itype = (fields.get("issuetype", {}) or {}).get("name", "").lower()
                    # Prefer a link to one of the seeded Features/Epics
                    if key and key in known_feature_keys:
                        return key
                    # Or accept link to a Feature/Epic not in set yet (we still attach)
                    if key and (itype == "epic" or "feature" in itype):
                        return key
            return None

        epic_link_field = "customfield_10702"  # Epic Link

        # ---- Robust parent resolution for a Story / Fault Report
        def resolve_parent_feature_key(fields, feature_keys: set):
            """
            Order:
              1) Epic Link (customfield_10702) → may be string or object with 'key'
              2) parent.key (company-managed projects)
              3) issue links (prefer already-seeded features; else any linked Feature/Epic)
            """
            # 1) Epic Link
            epic_val = fields.get(epic_link_field)
            if epic_val:
                if isinstance(epic_val, str):
                    return epic_val
                if isinstance(epic_val, dict):
                    k = epic_val.get("key")
                    if k:
                        return k

            # 2) parent
            parent_obj = fields.get("parent")
            if isinstance(parent_obj, dict):
                pk = parent_obj.get("key")
                if pk:
                    # If we know the type and it's Feature/Epic, great; else accept anyway.
                    itype = (((parent_obj.get("fields") or {}).get("issuetype") or {}).get("name") or "").lower()
                    if not itype or itype == "epic" or "feature" in itype:
                        return pk

            # 3) issue links
            cand = find_parent_feature_from_links(fields.get("issuelinks", []) or [], feature_keys)
            if cand:
                return cand

            return ""

        # ---- Fetch a single issue (for missing parents) with needed fields
        def _fetch_issue_full(key):
            url = f"{JIRA_ISSUE}/{key}"
            params = {
                "fields": ",".join([
                    "summary", "issuetype", "issuelinks", "customfield_14700", "status", "priority",
                    "customfield_13801",  # Capability parent
                    "fixVersions", "customfield_10708", "assignee"
                ])
            }
            resp = requests.get(url, headers=self.headers, params=params)
            if resp.status_code == 200:
                return resp.json()
            return None

        # ---- Turn a fetched Feature/Epic issue into a row for 'features' dict
        def _seed_feature_from_issue(issue_json, summary_cache):
            if not issue_json:
                return None
            fields = issue_json.get("fields", {}) or {}
            key = issue_json.get("key", "")
            if not key:
                return None

            issuetype_name = (fields.get("issuetype", {}) or {}).get("name", "").lower()
            if issuetype_name != "epic" and "feature" not in issuetype_name:
                return None  # only seed Features/Epics

            pi_scope_field = fields.get("customfield_14700")
            pi_scope_value = pi_scope_field.get("value", "") if isinstance(pi_scope_field, dict) else (
                        pi_scope_field or "")

            prio_field = fields.get("priority")
            priority_value = (prio_field or {}).get("name", "") if isinstance(prio_field, dict) else (prio_field or "")

            parent_link = fields.get("customfield_13801", "")
            if isinstance(parent_link, dict):
                parent_link_value = parent_link.get("key", "") or ""
            else:
                parent_link_value = parent_link or ""

            parent_summary = ""
            if parent_link_value:
                parent_summary = self.get_issue_summary(parent_link_value, summary_cache) or ""

            fix_versions = []
            for fv in fields.get("fixVersions", []) or []:
                name = fv.get("name")
                if name:
                    fix_versions.append(name)

            feature_sp = fields.get("customfield_10708", 0)
            try:
                feature_sp = float(feature_sp) if feature_sp not in (None, "") else 0.0
            except Exception:
                feature_sp = 0.0

            assignee_obj = fields.get("assignee")
            assignee_display = assignee_obj.get("displayName") if isinstance(assignee_obj, dict) else ""

            return key, {
                "summary": fields.get("summary", "") or "",
                "status": (fields.get("status", {}) or {}).get("name", "") or "",
                "pi_scope": pi_scope_value,
                "priority": priority_value,
                "parent_link": parent_link_value,
                "parent_summary": parent_summary,
                "fixVersions": fix_versions,
                "linked_issues": self.extract_linked_issue_links(fields.get("issuelinks", []) or []),
                "sprints": {},  # canonical sprint -> [issue keys]
                "story_points": feature_sp,  # feature-level estimate
                "sum_story_points": 0.0,  # sum of child story points
                "assignee": assignee_display,
                "stories_detail": [],  # [{key, story_points, assignee, status}]
            }

        # ---------------- JQL: scoped to Leading Work Group ----------------
        jql_query = f'"Leading Work Group" = "{work_group}"'
        payload = {
            "jql": jql_query,
            "maxResults": 500,
            "fields": [
                "summary",
                "issuetype",
                "issuelinks",
                "customfield_10701",  # Sprint(s)
                "customfield_14700",  # PI Scope
                "status",
                "priority",
                "customfield_13801",  # Parent link (Capability)
                "fixVersions",
                "customfield_10702",  # Epic Link
                "customfield_10708",  # Story Points
                "assignee",
                "parent"  # <-- required for robust parent resolution
            ],
        }

        response = requests.post(JIRA_SEARCH, json=payload, headers=self.headers)
        if response.status_code != 200:
            return {"error": response.text}

        data = response.json() or {}
        issues = data.get("issues", [])

        features = {}
        summary_cache = {}

        # ---------- 1) Seed rows from Features & Epics returned by JQL ----------
        for issue in issues:
            key = issue.get("key", "")
            fields = issue.get("fields", {}) or {}
            issuetype_name = (fields.get("issuetype", {}) or {}).get("name", "").lower()

            # Seed if Epic OR any issuetype containing "feature" (e.g., "Enabler Feature")
            if issuetype_name == "epic" or "feature" in issuetype_name:
                pi_scope_field = fields.get("customfield_14700")
                pi_scope_value = pi_scope_field.get("value", "") if isinstance(pi_scope_field, dict) else (
                            pi_scope_field or "")

                prio_field = fields.get("priority")
                priority_value = (prio_field or {}).get("name", "") if isinstance(prio_field, dict) else (
                            prio_field or "")

                parent_link = fields.get("customfield_13801", "")
                if isinstance(parent_link, dict):
                    parent_link_value = parent_link.get("key", "") or ""
                else:
                    parent_link_value = parent_link or ""

                parent_summary = ""
                if parent_link_value:
                    parent_summary = self.get_issue_summary(parent_link_value, summary_cache) or ""

                fix_versions = []
                for fv in fields.get("fixVersions", []) or []:
                    name = fv.get("name")
                    if name:
                        fix_versions.append(name)

                feature_sp = fields.get("customfield_10708", 0)
                try:
                    feature_sp = float(feature_sp) if feature_sp not in (None, "") else 0.0
                except Exception:
                    feature_sp = 0.0

                assignee_obj = fields.get("assignee")
                assignee_display = assignee_obj.get("displayName") if isinstance(assignee_obj, dict) else ""

                features[key] = {
                    "summary": fields.get("summary", "") or "",
                    "status": (fields.get("status", {}) or {}).get("name", "") or "",
                    "pi_scope": pi_scope_value,
                    "priority": priority_value,
                    "parent_link": parent_link_value,
                    "parent_summary": parent_summary,
                    "fixVersions": fix_versions,
                    "linked_issues": self.extract_linked_issue_links(fields.get("issuelinks", []) or []),
                    "sprints": {},
                    "story_points": feature_sp,
                    "sum_story_points": 0.0,
                    "assignee": assignee_display,
                    "stories_detail": [],
                }

        feature_keys = set(features.keys())

        # ---------- 2) Attach Stories & Fault Reports (and backfill missing parents) ----------
        for issue in issues:
            key = issue.get("key", "")
            fields = issue.get("fields", {}) or {}
            issuetype_name = (fields.get("issuetype", {}) or {}).get("name", "").lower()

            if issuetype_name not in ("story", "fault report"):
                continue

            # -- Resolve parent Feature/Epic for this child
            parent_key = resolve_parent_feature_key(fields, feature_keys)

            # -- If parent exists but wasn't seeded by JQL (e.g., parent not in this Work Group),
            #    fetch it now so it shows in the output.
            if parent_key and parent_key not in features:
                parent_issue = _fetch_issue_full(parent_key)
                seeded = _seed_feature_from_issue(parent_issue, summary_cache)
                if seeded:
                    pk, prow = seeded
                    features[pk] = prow
                    feature_keys.add(pk)

            if not parent_key or parent_key not in features:
                # No valid parent Feature/Epic to attach to
                continue

            # -- Child Story Points (only true children are counted; NOT generic issue links)
            sp_val = fields.get("customfield_10708", 0)
            try:
                sp_val = float(sp_val) if sp_val not in (None, "") else 0.0
            except Exception:
                sp_val = 0.0

            # Assignee
            assignee_obj = fields.get("assignee")
            child_assignee = assignee_obj.get("displayName") if isinstance(assignee_obj, dict) else ""
            child_assignee = (child_assignee or "").strip() or "Unassigned"

            # Status
            child_status = (fields.get("status", {}) or {}).get("name", "") or ""

            # Accumulate story points and details on the parent Feature
            features[parent_key]["sum_story_points"] += sp_val
            features[parent_key]["stories_detail"].append({
                "key": key,
                "story_points": sp_val,
                "assignee": child_assignee,
                "status": child_status,
            })

            # -- Sprint placement (only sprints that belong to THIS PI)
            raw_sprints = fields.get("customfield_10701")
            if not raw_sprints:
                features[parent_key]["sprints"].setdefault("No Sprint", []).append(key)
                continue

            entries = raw_sprints if isinstance(raw_sprints, list) else [raw_sprints]
            placed_in_any = False
            for entry in entries:
                canonical, matches_pi = match_and_normalize_sprint(entry, pi_token)
                if canonical and matches_pi:
                    features[parent_key]["sprints"].setdefault(canonical, []).append(key)
                    placed_in_any = True

            if not placed_in_any:
                features[parent_key]["sprints"].setdefault("No Sprint", []).append(key)

        # ---------- 3) Canonicalize sprint keys across all features ----------
        for feat in features.values():
            if not feat.get("sprints"):
                continue
            new_map = {}
            for k, v in list(feat["sprints"].items()):
                c, _ = match_and_normalize_sprint(k, pi_token)
                c = c or "No Sprint"
                new_map.setdefault(c, []).extend(v or [])
            feat["sprints"] = new_map

        return features

    def extract_sprint_name(self, sprint_data):
        if isinstance(sprint_data, list):
            if sprint_data:
                return self.extract_sprint_name(sprint_data[0])
            return None  # skip empty lists

        if isinstance(sprint_data, str):
            name_match = re.search(r"name=([^,]+)", sprint_data)
            if name_match:
                name_str = name_match.group(1)
                sprint_match = re.search(r"(Sprint.\d+)", name_str)
                return sprint_match.group(1) if sprint_match else None
            return None

        return None

#     ".*Sprint.\d.*"gm

@app.route("/")
def home():
    return render_template("index.html", active_page="dashboard")

@app.route("/issue_data")
def issue_data():
    fix_version = request.args.get("fixVersion", "PI_25w10")
    work_group = request.args.get("workGroup", "ART - BCRC - BSW TFW")
    jira = Jira()
    issues = jira.list_issues(fix_version, work_group)
    return jsonify(issues)

@app.route("/stats")
def stats():
    fix_version = request.args.get("fixVersion", "PI_25w10")
    work_group = request.args.get("workGroup", "ART - BCRC - BSW TFW")
    jira = Jira()
    return jsonify(jira.get_statistics(fix_version, work_group))

@app.route("/pi-planning")
def pi_planning():
    return render_template("pi_planning.html", active_page="dashboard")

@app.route("/pi_planning_data")
def pi_planning_data():
    fix_version = request.args.get("fixVersion", "PI_25w10")
    work_group = request.args.get("workGroup", "ART - BCRC - BSW TFW")
    jira = Jira()
    return jsonify(jira.get_pi_planning(fix_version, work_group))

@app.route("/export_excel")
def export_excel():
    fix_version = request.args.get("fixVersion", "PI_25w10")
    work_group = request.args.get("workGroup", "ART - BCRC - BSW TFW")
    jira = Jira()
    issues = jira.list_issues(fix_version, work_group)

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
    jira = Jira()
    features = jira.get_pi_planning(fix_version, work_group)

    # Filter for Committed in current PI only
    committed = []
    for key, feature in features.items():
        if feature.get("pi_scope") == "Committed" and fix_version in feature.get("fixVersions", []):
            committed.append((key, feature))

    # Prepare rows
    sprints = ["Sprint 1", "Sprint 2", "Sprint 3", "Sprint 4", "Sprint 5", "No Sprint"]
    rows = []
    for key, feature in committed:
        row = {
            "Capability": feature["parent_summary"] or feature["parent_link"] or "",
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

    output.seek(0)
    return send_file(
        output,
        download_name=f"pi_planning_committed_{fix_version}.xlsx",
        as_attachment=True,
        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )


@app.route("/export_backlog_excel")
def export_backlog_excel():
    fix_version = request.args.get("fixVersion", "PI_25w10")
    work_group = request.args.get("workGroup", "ART - BCRC - BSW TFW")
    jira = Jira()
    features = jira.get_pi_planning(fix_version, work_group)

    # Get all Committed keys first
    committed_keys = set()
    for key, feature in features.items():
        if feature.get("pi_scope") == "Committed" and fix_version in feature.get("fixVersions", []):
            committed_keys.add(key)

    # Filter for not-Done, not already committed
    backlog = []
    for key, feature in features.items():
        if (
            feature.get("status") and
            feature["status"].lower() != "done" and
            key not in committed_keys
        ):
            backlog.append((key, feature))

    # Prepare rows
    sprints = ["Sprint 1", "Sprint 2", "Sprint 3", "Sprint 4", "Sprint 5", "No Sprint"]
    rows = []
    for key, feature in backlog:
        row = {
            "Capability": feature["parent_summary"] or feature["parent_link"] or "",
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
        download_name=f"pi_planning_backlog_{fix_version}.xlsx",
        as_attachment=True,
        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )

@app.route('/track_user', methods=['POST'])
def track_user():
    data = request.get_json()
    user_id = data.get('user_id')
    if user_id:
        # Save user_id to a file, one per line (no duplicates)
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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run Flask backend with custom IP and port")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host IP to bind (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=80, help="Port to bind (default: 80)")
    parser.add_argument("--debug", action="store_true", help="Enable Flask debug mode")

    args = parser.parse_args()
    app.run(host=args.host, port=args.port, debug=args.debug)
