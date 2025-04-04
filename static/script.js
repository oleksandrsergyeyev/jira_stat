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
        // ✅ Display clickable links with the issue key as text
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

    // ✅ Update column index (Classes is now index 4)
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

// Load on page load
renderChart();
renderTable();

document.getElementById("refresh").addEventListener("click", () => {
    renderChart();
    renderTable();
});

function getSelectedFixVersion() {
    return document.getElementById("fixVersionSelect").value;
}

document.getElementById("fixVersionSelect").addEventListener("change", () => {
    renderChart();
    renderTable();
});

function getSelectedWorkGroup() {
    return document.getElementById("workGroupSelect").value;
}

document.getElementById("workGroupSelect").addEventListener("change", () => {
    renderChart();
    renderTable();
});
