let currentSortOrder = 'asc';

function getSelectedFixVersion() {
    return document.getElementById("fixVersionSelect")?.value;
}
function getSelectedWorkGroup() {
    return document.getElementById("workGroupSelect")?.value;
}

function applyFilter() {
    const filterInput = document.getElementById("globalFilter");
    if (!filterInput) return;

    const filter = filterInput.value.toLowerCase();
    document.querySelectorAll("table tbody tr").forEach(row => {
        row.style.display = row.innerText.toLowerCase().includes(filter) ? "" : "none";
    });
}

function sortTable(header) {
    const table = header.closest("table");
    const tbody = table.querySelector("tbody");
    const index = Array.from(header.parentNode.children).indexOf(header);
    const rows = Array.from(tbody.querySelectorAll("tr"));
    const ascending = !header.classList.contains("asc");

    rows.sort((a, b) => {
        const aText = a.cells[index]?.innerText.toLowerCase() || "";
        const bText = b.cells[index]?.innerText.toLowerCase() || "";
        return ascending ? aText.localeCompare(bText) : bText.localeCompare(aText);
    });

    tbody.innerHTML = "";
    rows.forEach(row => tbody.appendChild(row));
    table.querySelectorAll("th").forEach(th => th.classList.remove("asc", "desc"));
    header.classList.add(ascending ? "asc" : "desc");
}

function toggleTable(id, btn) {
    const section = document.getElementById(id);
    const isHidden = section.style.display === "none";
    section.style.display = isHidden ? "block" : "none";
    btn.textContent = isHidden ? "⬆ Collapse" : "⬇ Expand";
}

// --- Remember PI Planning selections ---
function savePlanningSettings() {
    localStorage.setItem("piPlanningFixVersion", getSelectedFixVersion());
    localStorage.setItem("piPlanningWorkGroup", getSelectedWorkGroup());
}

function restorePlanningSettings() {
    const fixVersion = localStorage.getItem("piPlanningFixVersion");
    const workGroup = localStorage.getItem("piPlanningWorkGroup");

    if (fixVersion) {
        const fixVersionSelect = document.getElementById("fixVersionSelect");
        if (fixVersionSelect) fixVersionSelect.value = fixVersion;
    }
    if (workGroup) {
        const workGroupSelect = document.getElementById("workGroupSelect");
        if (workGroupSelect) workGroupSelect.value = workGroup;
    }
}

// PI Planning logic with cross-PI backlog
async function loadPIPlanningData() {
    const fixVersion = getSelectedFixVersion();
    const workGroup = getSelectedWorkGroup();
    if (!fixVersion || !workGroup) return;

    const url = `/pi_planning_data?fixVersion=${encodeURIComponent(fixVersion)}&workGroup=${encodeURIComponent(workGroup)}`;
    const response = await fetch(url);
    const data = await response.json();

    const sprints = ["Sprint 1", "Sprint 2", "Sprint 3", "Sprint 4", "Sprint 5"];
    const committed = [];
    const backlog = [];

    function featureInSelectedPI(feature, fixVersion) {
        return Array.isArray(feature.fixVersions) && feature.fixVersions.includes(fixVersion);
    }

    for (const [key, feature] of Object.entries(data)) {
        if (
            feature.pi_scope === "Committed" &&
            featureInSelectedPI(feature, fixVersion)
        ) {
            committed.push([key, feature]);
        }
    }
    const committedKeys = new Set(committed.map(([key]) => key));

    for (const [key, feature] of Object.entries(data)) {
        if (
            feature.status &&
            feature.status.toLowerCase() !== "done" &&
            !committedKeys.has(key)
        ) {
            backlog.push([key, feature]);
        }
    }

    renderFeatureTable(committed, "committed-table", sprints);
    renderFeatureTable(backlog, "backlog-table", sprints);
    applyFilter();
}

function renderFeatureTable(features, containerId, sprints) {
    const container = document.getElementById(containerId);
    if (!container) return;

    let tableHtml = '<table><thead><tr>';
    tableHtml += '<th onclick="sortTable(this)">Capability</th>';
    tableHtml += '<th onclick="sortTable(this)">Feature ID</th>';
    tableHtml += '<th onclick="sortTable(this)">Feature Name</th>';
    tableHtml += '<th onclick="sortTable(this)">Priority</th>';
    tableHtml += '<th onclick="sortTable(this)">Status</th>';
    tableHtml += '<th onclick="sortTable(this)">PI Scope</th>';
    tableHtml += '<th onclick="sortTable(this)">Links</th>';
    sprints.forEach(sprint => tableHtml += `<th>${sprint}</th>`);
    tableHtml += '</tr></thead><tbody>';

    for (const [featureId, feature] of features) {
        const linksHtml = (feature.linked_issues || []).map(link =>
            `<a href="${link.url}" target="_blank">${link.key}</a>`).join(" ");
        tableHtml += `<tr>
            <td>${feature.parent_link ? `<a href="https://jira-vira.volvocars.biz/browse/${feature.parent_link}" target="_blank">${feature.parent_summary || feature.parent_link}</a>` : ""}</td>
            <td><a href="https://jira-vira.volvocars.biz/browse/${featureId}" target="_blank">${featureId}</a></td>
            <td><a href="https://jira-vira.volvocars.biz/browse/${featureId}" target="_blank">${feature.summary}</a></td>
            <td>${feature.priority || ""}</td>
            <td>${feature.status || ""}</td>
            <td>${feature.pi_scope || ""}</td>
            <td>${linksHtml}</td>`;
        sprints.forEach(sprint => {
            let stories = Array.isArray(feature.sprints[sprint]) ? feature.sprints[sprint] : [];
            stories = stories.filter(storyKey =>
                typeof storyKey === "string" && !!storyKey && storyKey.trim() !== "" && storyKey !== "null" && storyKey !== "undefined"
            );
            if (stories.length) {
                tableHtml += `<td class="story-cell"><span class="story-badge" tabindex="0" data-stories='${JSON.stringify(stories)}'>${stories.length}</span></td>`;
            } else {
                tableHtml += `<td class="story-cell"></td>`;
            }
        });
        tableHtml += '</tr>';
    }
    tableHtml += '</tbody></table>';
    container.innerHTML = tableHtml;

    document.querySelectorAll('.story-badge').forEach(badge => {
        badge.addEventListener('mouseenter', handleStoryBadgeHover);
        badge.addEventListener('mouseleave', hideCustomTooltip);
        badge.addEventListener('focus', handleStoryBadgeHover);
        badge.addEventListener('blur', hideCustomTooltip);
        badge.addEventListener('mousemove', moveCustomTooltip);
    });
}

// Tooltip helpers
function handleStoryBadgeHover(event) {
    const badge = event.currentTarget;
    let stories = [];
    try {
        stories = JSON.parse(badge.getAttribute('data-stories')) || [];
    } catch { }
    stories = stories.filter(storyKey =>
        !!storyKey && typeof storyKey === "string" && storyKey.trim() !== "" && !/^null|undefined$/i.test(storyKey)
    );
    if (!stories.length) return;
    let tooltip = document.getElementById('custom-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'custom-tooltip';
        tooltip.style.position = 'fixed';
        tooltip.style.zIndex = 9999;
        tooltip.style.background = '#fff';
        tooltip.style.border = '1px solid #007bff';
        tooltip.style.borderRadius = '8px';
        tooltip.style.padding = '10px 16px';
        tooltip.style.boxShadow = '0 4px 16px rgba(0,0,0,0.13)';
        tooltip.style.fontSize = '14px';
        tooltip.style.maxWidth = '350px';
        tooltip.style.pointerEvents = 'none';
        tooltip.style.whiteSpace = 'pre-line';
        document.body.appendChild(tooltip);
    }
    tooltip.innerHTML = stories.map(key =>
        `<a href="https://jira-vira.volvocars.biz/browse/${key}" target="_blank" style="color:#007bff;display:block;margin:2px 0;">${key}</a>`
    ).join('');
    tooltip.style.display = 'block';

    const rect = badge.getBoundingClientRect();
    tooltip.style.left = (rect.left + window.scrollX + rect.width/2) + "px";
    tooltip.style.top = (rect.bottom + window.scrollY + 8) + "px";
}
function hideCustomTooltip() {
    let tooltip = document.getElementById('custom-tooltip');
    if (tooltip) tooltip.style.display = 'none';
}
function moveCustomTooltip(event) {
    let tooltip = document.getElementById('custom-tooltip');
    if (tooltip && tooltip.style.display === 'block') {
        tooltip.style.left = (event.clientX + 20) + "px";
        tooltip.style.top = (event.clientY + 10) + "px";
    }
}

// Fault Report Dashboard support (unchanged)
async function fetchData() {
    const version = getSelectedFixVersion();
    const workGroup = getSelectedWorkGroup();
    const response = await fetch(`/stats?fixVersion=${version}&workGroup=${encodeURIComponent(workGroup)}`);
    return await response.json();
}

async function fetchIssues() {
    const version = getSelectedFixVersion();
    const workGroup = getSelectedWorkGroup();
    const response = await fetch(`/issue_data?fixVersion=${version}&workGroup=${encodeURIComponent(workGroup)}`);
    return await response.json();
}

async function renderChart() {
    const stats = await fetchData();
    const labels = Object.keys(stats);
    const counts = Object.values(stats);

    if (window.myChart) window.myChart.destroy();

    const ctx = document.getElementById("statsChart").getContext("2d");
    window.myChart = new Chart(ctx, {
        type: "bar",
        data: {
            labels: labels,
            datasets: [{
                label: "Class Count",
                data: counts,
                backgroundColor: "rgba(75, 192, 192, 0.5)",
                borderColor: "rgba(75, 192, 192, 1)",
                borderWidth: 1,
                barThickness: 40
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        font: { size: 16 },
                        stepSize: 1,
                        callback: value => Number.isInteger(value) ? value : null
                    }
                },
                x: {
                    ticks: { font: { size: 14 } }
                }
            },
            plugins: {
                legend: {
                    labels: { font: { size: 18 } }
                }
            }
        }
    });
}

async function renderTable() {
    const issues = await fetchIssues();
    const tbody = document.querySelector("#issueTable tbody");
    if (!tbody) return;
    tbody.innerHTML = "";

    issues.forEach(issue => {
        const linksHtml = (issue.linked_features || []).map(link =>
            `<a href="${link.url}" target="_blank">${link.key}</a>`).join(" ");
        const featureNames = (issue.linked_features || []).map(link =>
            `${link.summary}`).join("; ");

        const row = document.createElement("tr");
        row.innerHTML = `
            <td class="one-line-cell"><a href="https://jira-vira.volvocars.biz/browse/${issue.key}" target="_blank">${issue.key}</a></td>
            <td>${issue.summary}</td>
            <td>${issue.status.name || issue.status}</td>
            <td class="hide-labels">${(Array.isArray(issue.labels) ? issue.labels.join(", ") : "")}</td>
            <td class="${issue.classes.length === 0 ? 'no-class' : ''}">
                ${(Array.isArray(issue.classes) && issue.classes.length > 0) ? issue.classes.join(", ") : ""}
            </td>
            <td class="one-line-cell">${linksHtml}</td>
            <td>${featureNames}</td>
        `;
        tbody.appendChild(row);
    });

    document.getElementById("sortClasses")?.addEventListener("click", sortTableByClass);
}

function sortTableByClass() {
    currentSortOrder = currentSortOrder === 'asc' ? 'desc' : 'asc';
    const tbody = document.querySelector("#issueTable tbody");
    const rows = Array.from(tbody.querySelectorAll("tr"));
    rows.sort((a, b) => {
        const aClass = a.cells[4].innerText.toLowerCase();
        const bClass = b.cells[4].innerText.toLowerCase();
        return currentSortOrder === 'asc' ? aClass.localeCompare(bClass) : bClass.localeCompare(aClass);
    });
    rows.forEach(row => tbody.appendChild(row));
    document.getElementById("sortClasses").innerText =
        `Classes ${currentSortOrder === 'asc' ? '▲' : '▼'}`;
}

// ✅ Init depending on page
document.addEventListener("DOMContentLoaded", () => {
    const isDashboard = document.getElementById("statsChart") && document.getElementById("issueTable");
    const isPlanning = document.getElementById("committed-table") && document.getElementById("backlog-table");

    if (isDashboard) {
        renderChart();
        renderTable();
        document.getElementById("refresh")?.addEventListener("click", () => {
            renderChart();
            renderTable();
        });
        document.getElementById("fixVersionSelect")?.addEventListener("change", () => {
            renderChart();
            renderTable();
        });
        document.getElementById("workGroupSelect")?.addEventListener("change", () => {
            renderChart();
            renderTable();
        });

        document.getElementById("download-excel")?.addEventListener("click", () => {
            const fixVersion = getSelectedFixVersion();
            const workGroup = getSelectedWorkGroup();
            const query = `?fixVersion=${encodeURIComponent(fixVersion)}&workGroup=${encodeURIComponent(workGroup)}`;
            window.location.href = `/export_excel${query}`;
        });
    }

    if (isPlanning) {
        // Restore last PI/WorkGroup before first load
        restorePlanningSettings();

        loadPIPlanningData();

        document.getElementById("fixVersionSelect")?.addEventListener("change", () => {
            savePlanningSettings();
            loadPIPlanningData();
        });
        document.getElementById("workGroupSelect")?.addEventListener("change", () => {
            savePlanningSettings();
            loadPIPlanningData();
        });
        document.getElementById("globalFilter")?.addEventListener("input", applyFilter);

        // --- Export PI Planning Committed/Backlog ---
        document.getElementById("export-committed-excel")?.addEventListener("click", function () {
            const fixVersion = getSelectedFixVersion();
            const workGroup = getSelectedWorkGroup();
            const query = `?fixVersion=${encodeURIComponent(fixVersion)}&workGroup=${encodeURIComponent(workGroup)}`;
            window.location.href = `/export_committed_excel${query}`;
        });
        document.getElementById("export-backlog-excel")?.addEventListener("click", function () {
            const fixVersion = getSelectedFixVersion();
            const workGroup = getSelectedWorkGroup();
            const query = `?fixVersion=${encodeURIComponent(fixVersion)}&workGroup=${encodeURIComponent(workGroup)}`;
            window.location.href = `/export_backlog_excel${query}`;
        });
    }
});
