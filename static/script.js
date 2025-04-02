async function fetchData() {
    const response = await fetch("/stats");
    return await response.json();
}

async function fetchIssues() {
    const response = await fetch("/issue_data");
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
                label: "Label Count",
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
            stepSize: 1,               // ✅ Force whole number steps
            callback: function(value) {
                return Number.isInteger(value) ? value : null;  // ✅ Hide non-integer ticks
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
        const row = document.createElement("tr");
        row.innerHTML = `
            <td><a href="https://jira-vira.volvocars.biz/browse/${issue.key}" target="_blank">${issue.key}</a></td>
            <td>${issue.summary}</td>
            <td>${issue.status.name || issue.status}</td>
            <td class="hide-labels">${(Array.isArray(issue.labels) ? issue.labels.join(", ") : "")}</td>
            <td class="${issue.classes.length === 0 ? 'no-class' : ''}">
                ${(Array.isArray(issue.classes) && issue.classes.length > 0) ? issue.classes.join(", ") : ""}
            </td>
        `;
        tbody.appendChild(row);
    });
}

// Load everything on page load
renderChart();
renderTable();

document.getElementById("refresh").addEventListener("click", () => {
    renderChart();
    renderTable();
});
