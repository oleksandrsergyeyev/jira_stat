let currentSortOrder = 'asc';  // toggle between 'asc' and 'desc'

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

    if (window.myChart) {
        window.myChart.destroy();
    }

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
                        callback: function(value) {
                            return Number.isInteger(value) ? value : null;
                        }
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
    tbody.innerHTML = "";

    issues.forEach(issue => {
        const linksHtml = (issue.linked_features || []).map(link =>
            `<a href="${link.url}" target="_blank">${link.key}</a>`
        ).join(" ");

        const featureNames = (issue.linked_features || []).map(link =>
            `${link.summary}`
        ).join("; ");

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

    document.getElementById("sortClasses").addEventListener("click", sortTableByClass);
}

function sortTableByClass() {
    currentSortOrder = currentSortOrder === 'asc' ? 'desc' : 'asc';

    const tbody = document.querySelector("#issueTable tbody");
    const rows = Array.from(tbody.querySelectorAll("tr"));

    rows.sort((a, b) => {
        const aClass = a.cells[4].innerText.toLowerCase();
        const bClass = b.cells[4].innerText.toLowerCase();

        if (aClass < bClass) return currentSortOrder === 'asc' ? -1 : 1;
        if (aClass > bClass) return currentSortOrder === 'asc' ? 1 : -1;
        return 0;
    });

    rows.forEach(row => tbody.appendChild(row));

    document.getElementById("sortClasses").innerText =
        `Classes ${currentSortOrder === 'asc' ? '▲' : '▼'}`;
}

// Utilities
function getSelectedFixVersion() {
    return document.getElementById("fixVersionSelect").value;
}
function getSelectedWorkGroup() {
    return document.getElementById("workGroupSelect").value;
}

// PI Planning
async function loadPIPlanningData() {
    const fixVersion = getSelectedFixVersion();
    const workGroup = getSelectedWorkGroup();
    const response = await fetch(`/pi_planning_data?fixVersion=${fixVersion}&workGroup=${encodeURIComponent(workGroup)}`);
    const data = await response.json();

    const sprints = ["Sprint 1", "Sprint 2", "Sprint 3", "Sprint 4", "Sprint 5"];
    let tableHtml = '<table>';
    tableHtml += '<thead><tr>';
    ["Feature ID", "Feature Name", "Status", "Links", ...sprints].forEach(col => {
        tableHtml += `<th onclick="sortTable(this)">${col}</th>`;
    });
    tableHtml += '</tr></thead><tbody>';

    for (const [featureId, feature] of Object.entries(data)) {
        const linksHtml = (feature.linked_issues || []).map(link =>
            `<a href="${link.url}" target="_blank">${link.key}</a>`
        ).join(" ");

        tableHtml += `<tr>
            <td><a href="https://jira-vira.volvocars.biz/browse/${featureId}" target="_blank">${featureId}</a></td>
            <td><a href="https://jira-vira.volvocars.biz/browse/${featureId}" target="_blank">${feature.summary}</a></td>
            <td>${feature.status || ""}</td>
            <td>${linksHtml}</td>`;
        sprints.forEach(sprint => {
            const stories = feature.sprints[sprint] || [];
            tableHtml += `<td class="story-cell">${stories.join("\n")}</td>`;
        });
        tableHtml += '</tr>';
    }

    tableHtml += '</tbody></table>';
    document.getElementById('table-container').innerHTML = tableHtml;

    applyFilter();
}

// Table sorting
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

    document.querySelectorAll("th").forEach(th => th.classList.remove("asc", "desc"));
    header.classList.add(ascending ? "asc" : "desc");
}

function applyFilter() {
    const filter = document.getElementById("globalFilter")?.value?.toLowerCase() || "";
    const rows = document.querySelectorAll("#table-container table tbody tr");
    rows.forEach(row => {
        const text = row.innerText.toLowerCase();
        row.style.display = text.includes(filter) ? "" : "none";
    });
}

// Attach events
document.getElementById("refresh")?.addEventListener("click", () => {
    renderChart();
    renderTable();
});

document.getElementById("fixVersionSelect").addEventListener("change", () => {
    renderChart();
    renderTable();
    loadPIPlanningData();
});
document.getElementById("workGroupSelect").addEventListener("change", () => {
    renderChart();
    renderTable();
    loadPIPlanningData();
});
document.getElementById("globalFilter")?.addEventListener("input", applyFilter);

// Init
renderChart();
renderTable();
loadPIPlanningData();
