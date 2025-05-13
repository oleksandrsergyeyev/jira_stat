let currentSortOrder = 'asc';

function getSelectedFixVersion() {
    return document.getElementById("fixVersionSelect").value;
}
function getSelectedWorkGroup() {
    return document.getElementById("workGroupSelect").value;
}

function applyFilter() {
    const filter = document.getElementById("globalFilter").value.toLowerCase();
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
        const btn = section.previousElementSibling.querySelector("button");
        section.style.display = isCollapsing ? "none" : "block";
        btn.textContent = isCollapsing ? "⬇ Expand" : "⬆ Collapse";
    });
    masterBtn.textContent = isCollapsing ? "⬇ Expand All" : "⬆ Collapse All";
}

async function loadPIPlanningData() {
    const fixVersion = getSelectedFixVersion();
    const workGroup = getSelectedWorkGroup();
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
    document.getElementById(containerId).innerHTML = tableHtml;
}

// Init
document.getElementById("fixVersionSelect").addEventListener("change", loadPIPlanningData);
document.getElementById("workGroupSelect").addEventListener("change", loadPIPlanningData);
document.getElementById("globalFilter").addEventListener("input", applyFilter);

loadPIPlanningData();
