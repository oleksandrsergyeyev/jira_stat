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
        - Does NOT filter by fixVersion here (so backlog can include other PIs).
        - Features/Epics become rows; Stories contribute to sprint columns.
        - Stories with no/unknown sprint go into a 'No Sprint' bucket.
        - Adds stories_detail: [{key, story_points, assignee, status}]
        """
        jql_query = f'"Leading Work Group" = "{work_group}"'
        payload = {
            "jql": jql_query,
            "maxResults": 500,
            "fields": [
                "summary",
                "issuetype",
                "issuelinks",
                "customfield_10701",  # Sprint (string or list of strings)
                "customfield_14700",  # PI Scope
                "status",
                "priority",
                "customfield_13801",  # Parent link
                "fixVersions",
                "customfield_10702",  # Epic Link
                "customfield_10708",  # Story Points
                "assignee",
            ],
        }

        response = requests.post(JIRA_SEARCH, json=payload, headers=self.headers)
        if response.status_code != 200:
            return {"error": response.text}

        data = response.json() or {}
        issues = data.get("issues", [])

        features = {}
        summary_cache = {}

        # ---------- 1) Seed rows from Features & Epics ----------
        for issue in issues:
            key = issue.get("key", "")
            fields = issue.get("fields", {}) or {}
            issuetype_name = (fields.get("issuetype", {}) or {}).get("name", "").lower()

            if issuetype_name in ("feature", "epic"):
                pi_scope_field = fields.get("customfield_14700")
                if isinstance(pi_scope_field, dict):
                    pi_scope_value = pi_scope_field.get("value", "") or ""
                else:
                    pi_scope_value = pi_scope_field or ""

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
                    "sprints": {},  # sprint name -> [story keys]  (keep keys as strings for compatibility)
                    "story_points": feature_sp,  # feature’s own estimate
                    "sum_story_points": 0.0,  # sum of child stories
                    "assignee": assignee_display,  # feature assignee (kept for reference)
                    "stories_detail": [],  # <-- includes {key, story_points, assignee, status}
                }

        # ---------- 2) Attach Stories to their Feature/Epic rows ----------
        epic_link_field = "customfield_10702"

        for issue in issues:
            fields = issue.get("fields", {}) or {}
            issuetype_name = (fields.get("issuetype", {}) or {}).get("name", "").lower()
            if issuetype_name != "story":
                continue

            story_key = issue.get("key", "")
            story_epic = fields.get(epic_link_field, "") or ""

            # Story points
            story_points = fields.get("customfield_10708", 0)
            try:
                story_points = float(story_points) if story_points not in (None, "") else 0.0
            except Exception:
                story_points = 0.0

            # Story assignee
            assignee_obj = fields.get("assignee")
            story_assignee = assignee_obj.get("displayName") if isinstance(assignee_obj, dict) else ""
            story_assignee = (story_assignee or "").trim() if hasattr(str, 'trim') else (story_assignee or "").strip()
            story_assignee = story_assignee or "Unassigned"

            # Story status (for Gantt chip coloring)
            story_status = (fields.get("status", {}) or {}).get("name", "") or ""

            if story_epic in features:
                # accumulate SP
                features[story_epic]["sum_story_points"] += story_points
                # record detail for per-story aggregation on frontend
                features[story_epic]["stories_detail"].append({
                    "key": story_key,
                    "story_points": story_points,
                    "assignee": story_assignee,
                    "status": story_status,  # <-- added
                })

            # Sprint(s)
            raw_sprints = fields.get("customfield_10701")

            if not raw_sprints:
                if story_epic in features:
                    features[story_epic]["sprints"].setdefault("No Sprint", []).append(story_key)  # keep keys (strings)
                continue

            sprint_entries = raw_sprints if isinstance(raw_sprints, list) else [raw_sprints]
            placed_in_any = False
            for entry in sprint_entries:
                sprint_name = self.extract_sprint_name(entry)  # "Sprint N" or None
                if sprint_name and sprint_name != "Unknown Sprint":
                    if story_epic in features:
                        features[story_epic]["sprints"].setdefault(sprint_name, []).append(story_key)  # keep keys
                        placed_in_any = True

            if not placed_in_any and story_epic in features:
                features[story_epic]["sprints"].setdefault("No Sprint", []).append(story_key)

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
                sprint_match = re.search(r"(Sprint \d+)", name_str)
                return sprint_match.group(1) if sprint_match else None
            return None

        return None

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
