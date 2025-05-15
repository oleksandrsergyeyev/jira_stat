import requests
from collections import Counter
from flask import Flask, jsonify, render_template, request, send_file
import os
import io
import pandas as pd
from dotenv import load_dotenv
import re

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
            issue = link.get("inwardIssue") or link.get("outwardIssue")
            if issue and "key" in issue:
                key = issue["key"]
                result.append({
                    "key": key,
                    "url": f"https://jira-vira.volvocars.biz/browse/{key}"
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

    def get_pi_planning(self, fix_version, work_group):
        jql_query = f'"Leading Work Group" = "{work_group}" AND fixVersion = "{fix_version}"'
        payload = {
            "jql": jql_query,
            "maxResults": 500,
            "fields": [
                "summary",
                "issuetype",
                "issuelinks",
                "customfield_10701",  # Sprint
                "customfield_14700",  # PI Scope
                "status",
                "priority"
            ]
        }

        response = requests.post(JIRA_SEARCH, json=payload, headers=self.headers)
        if response.status_code != 200:
            return {"error": response.text}

        data = response.json()
        features = {}

        for issue in data.get("issues", []):

            key = issue["key"]
            summary = issue["fields"]["summary"]
            issuetype = issue["fields"]["issuetype"]["name"].lower()

            if issuetype in ["feature", "epic"]:
                pi_scope_field = issue["fields"].get("customfield_14700")
                pi_scope_value = pi_scope_field.get("value") if isinstance(pi_scope_field, dict) else ""

                priority_field = issue["fields"].get("priority")
                priority_value = priority_field.get("name") if isinstance(priority_field, dict) else ""

                features[key] = {
                    "summary": summary,
                    "status": issue["fields"]["status"]["name"],
                    "pi_scope": pi_scope_value,
                    "priority": priority_value,
                    "linked_issues": self.extract_linked_issue_links(issue["fields"].get("issuelinks", [])),
                    "sprints": {},
                }

        for issue in data.get("issues", []):
            if issue["fields"]["issuetype"]["name"].lower() != "story":
                continue

            story_summary = issue["fields"]["summary"]
            story_sprints = issue["fields"].get("customfield_10701", [])
            linked_features = [
                f["key"]
                for f in self.extract_linked_features(issue["fields"].get("issuelinks", []))
            ]

            for feature_key in linked_features:
                if feature_key in features:
                    for sprint in story_sprints:
                        sprint_name = self.extract_sprint_name(sprint)
                        features[feature_key]["sprints"].setdefault(sprint_name, []).append(story_summary)

        return features

    def extract_sprint_name(self, sprint_data):
        if isinstance(sprint_data, list):
            if sprint_data:
                return self.extract_sprint_name(sprint_data[0])
            return "Unknown Sprint"

        if isinstance(sprint_data, str):
            name_match = re.search(r"name=([^,]+)", sprint_data)
            if name_match:
                name_str = name_match.group(1)
                sprint_match = re.search(r"(Sprint \d+)", name_str)
                return sprint_match.group(1) if sprint_match else "Unknown Sprint"
            return "Unknown Sprint"

        return "Unknown Sprint"

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

if __name__ == "__main__":
    app.run(host="10.246.39.48", port=80, debug=True)
