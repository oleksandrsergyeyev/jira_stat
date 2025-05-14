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

function toggleAllTables(masterBtn) {
    const isCollapsing = masterBtn.textContent.includes("Collapse");
    const sections = ["committed-table", "noncommitted-table"];
    sections.forEach(id => {
        const section = document.getElementById(id);
        const btn = section?.previousElementSibling?.querySelector("button");
        if (section && btn) {
            section.style.display = isCollapsing ? "none" : "block";
            btn.textContent = isCollapsing ? "⬇ Expand" : "⬆ Collapse";
        }
    });
    masterBtn.textContent = isCollapsing ? "⬇ Expand All" : "⬆ Collapse All";
}

async function loadPIPlanningData() {
    const fixVersion = getSelectedFixVersion();
    const workGroup = getSelectedWorkGroup();
    if (!fixVersion || !workGroup) return;

    const url = `/pi_planning_data?fixVersion=${encodeURIComponent(fixVersion)}&workGroup=${encodeURIComponent(workGroup)}`;
    const response = await fetch(url);
    const data = await response.json();

    const sprints = ["Sprint 1", "Sprint 2", "Sprint 3", "Sprint 4", "Sprint 5"];
    const committed = [];
    const nonCommitted = [];

    for (const [key, feature] of Object.entries(data)) {
        (feature.pi_scope === "Committed" ? committed : nonCommitted).push([key, feature]);
    }

    renderFeatureTable(committed, "committed-table", sprints);
    renderFeatureTable(nonCommitted, "noncommitted-table", sprints);
    applyFilter();
}

function renderFeatureTable(features, containerId, sprints) {
    const container = document.getElementById(containerId);
    if (!container) return;

    let tableHtml = '<table><thead><tr>';
    tableHtml += '<th onclick="sortTable(this)">Feature ID</th>';
    tableHtml += '<th onclick="sortTable(this)">Feature Name</th>';
    tableHtml += '<th onclick="sortTable(this)">Status</th>';
    tableHtml += '<th onclick="sortTable(this)">PI Scope</th>';
    tableHtml += '<th onclick="sortTable(this)">Links</th>';
    sprints.forEach(sprint => tableHtml += `<th>${sprint}</th>`);
    tableHtml += '</tr></thead><tbody>';

    for (const [featureId, feature] of features) {
        const linksHtml = (feature.linked_issues || []).map(link =>
            `<a href="${link.url}" target="_blank">${link.key}</a>`).join(" ");
        tableHtml += `<tr>
            <td><a href="https://jira-vira.volvocars.biz/browse/${featureId}" target="_blank">${featureId}</a></td>
            <td><a href="https://jira-vira.volvocars.biz/browse/${featureId}" target="_blank">${feature.summary}</a></td>
            <td>${feature.status || ""}</td>
            <td>${feature.pi_scope || ""}</td>
            <td>${linksHtml}</td>`;
        sprints.forEach(sprint => {
            const stories = feature.sprints[sprint] || [];
            tableHtml += `<td class="story-cell">${stories.join("\n")}</td>`;
        });
        tableHtml += '</tr>';
    }

    tableHtml += '</tbody></table>';
    container.innerHTML = tableHtml;
}

// Fault Report Dashboard support
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
            <td><a href="https://jira-vira.volvocars.biz/browse/${issue.key}" target="_blank">${issue.key}</a></td>
            <td>${issue.summary}</td>
            <td>${issue.status.name || issue.status}</td>
            <td class="hide-labels">${(Array.isArray(issue.labels) ? issue.labels.join(", ") : "")}</td>
            <td class="${issue.classes.length === 0 ? 'no-class' : ''}">
                ${(Array.isArray(issue.classes) && issue.classes.length > 0) ? issue.classes.join(", ") : ""}
            </td>
            <td>${linksHtml}</td>
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
    const isPlanning = document.getElementById("committed-table") && document.getElementById("noncommitted-table");

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
        loadPIPlanningData();
        document.getElementById("fixVersionSelect")?.addEventListener("change", loadPIPlanningData);
        document.getElementById("workGroupSelect")?.addEventListener("change", loadPIPlanningData);
        document.getElementById("globalFilter")?.addEventListener("input", applyFilter);
    }
});
