# 📊 Jira Metrics Dashboard

A lightweight web application that connects to Jira, gathers project data, and visualizes metrics, interactive dashboard.
## 🚀 Features

- Connects to Jira via API
- Fetches issues based on filters or projects
- Visualizes metrics using graphs (e.g., bar charts, line graphs)
- Road map planning with local pending changes and explicit push to Jira
- Team Capacity page to manage team members and sprint-day capacity per work group + Fix Version
- Jira-backed user search when adding team members to capacity plans

## 👥 Team Capacity

- Open `/team-capacity` from the top menu.
- Choose `Leading Work Group` and `Fix Version`.
- Search Jira users and add team members.
- Set capacity days for each member across Sprint 1..5.
- Click **Save Capacity** to persist data for reuse in other pages.

Capacity data is stored in `team_capacity_data.json` in the app root.
