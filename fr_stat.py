import requests
from collections import Counter
from flask import Flask, jsonify, render_template
import json


app = Flask(__name__)

# Jira API URL
JIRA_BASE_URL = "https://jira-vira.volvocars.biz/rest/api/2"
JIRA_SEARCH = f"{JIRA_BASE_URL}/search"
JIRA_ISSUE = f"{JIRA_BASE_URL}/issue"

# Personal Access Token
JIRA_TOKEN = "Replace with your actual token"

headers = {
    "Authorization": f"Bearer {JIRA_TOKEN}",
    "Content-Type": "application/json"
}

class Jira:

    def __init__(self):
        self.jira_token = JIRA_TOKEN
        self.headers = headers

    def list_issues(self):
        jql_query = (
            'type = "Fault Report" AND '
            '"Leading Work Group" = "ART - BCRC - BSW TFW" AND '
            'fixVersion = PI_25w10'
            ' AND (labels = "BuildIssue" AND labels = "Internal_Dev")'
        )

        payload = {
            "jql": jql_query,
            "maxResults": 100,  # Limit results
            "fields": ["summary", "status", "fixVersions", "labels"]  # Fields to fetch
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
                    ]

                })
                print(f"{issue['key']} {issue['fields']['summary']} "
                      f"{issue['fields']['status']['name']} "
                      f"Labels: {issue['fields']['labels']}, "
                      )
        else:
            print(f"Error: {response.status_code}, {response.text}")
        return result_data

    def get_statistics(self):
        all_classes = [cls for issue in self.list_issues() for cls in issue["classes"]]
        class_counts = Counter(all_classes)
        return class_counts

    def show_statistic(self):
        # Flatten all labels into a single list
        all_labels = [label for issue in self.list_issues() for label in issue["labels"]]

        # Count occurrences of each label
        label_counts = Counter(all_labels)

        # Print statistics
        print("Issue Statistics:")
        for label, count in label_counts.most_common():
            if label not in ["internal_dev", "buildissue", "internla_dev"]:
                print(f"{label}: {count}")

    def get_classes(self, label):
        parts = label.split('_', 2)  # Split at most twice
        return '_'.join(parts[:2]) if len(parts) > 1 else label

@app.route("/")
def home():
    return render_template("index.html")  # Serves the frontend

@app.route("/stats")
def stats():
    jira = Jira()
    # data = jira.show_statistic()
    data = jira.get_statistics()
    return jsonify(data)  # Returns JSON data for visualization

@app.route("/issue_data")
def issue_data():
    jira = Jira()
    issues = jira.list_issues()
    return jsonify(issues)


if __name__ == "__main__":
    app.run(host="localhost", port=80, debug=True)

