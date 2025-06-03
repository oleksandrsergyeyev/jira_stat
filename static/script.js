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
function showLoading() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = 'flex';
}
function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = 'none';
}

async function loadPIPlanningData() {
    showLoading();
    try {
        const fixVersion = getSelectedFixVersion();
        const workGroup = getSelectedWorkGroup();
        if (!fixVersion || !workGroup) {
            hideLoading();
            return;
        }

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
        renderCommittedSummary(committed, "committed-summary");
        renderFeatureTable(backlog, "backlog-table", sprints);
        applyFilter();
    } finally {
        hideLoading();
    }
}

// Config for columns (update if columns added/removed in future)
const piPlanningColumns = [
  { key: 'rownum', label: '#' },
  { key: 'capability', label: 'Capability' },
  { key: 'featureid', label: 'Feature ID' },
  { key: 'featurename', label: 'Feature Name' },
  { key: 'storypoints', label: 'Story Points' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'priority', label: 'Priority' },
  { key: 'status', label: 'Status' },
  { key: 'piscope', label: 'PI Scope' },
  { key: 'links', label: 'Links' }
  // Sprints columns are handled dynamically below
];

// Track hidden columns per table id
const hiddenColumns = {
  'committed-table': new Set(),
  'backlog-table': new Set(),
};

function renderColumnToggles(containerId, sprints) {
  const togglesDiv = document.getElementById(containerId.replace('-table', '-column-toggles'));
  if (!togglesDiv) return;

  // All base columns + sprints
  const columns = [...piPlanningColumns.map(col => col.label), ...sprints];
  togglesDiv.innerHTML = '';
  columns.forEach((colLabel, idx) => {
    // Never hide row number column
    const isDisabled = idx === 0;
    // Get current state for this column in this table
    const tableKey = containerId;
    const isHidden = hiddenColumns[tableKey]?.has(idx);
    const btn = document.createElement('button');
    btn.type = "button";
    btn.className = 'col-toggle-btn' + (isHidden ? ' collapsed' : '');
    btn.disabled = isDisabled;
    btn.textContent = isHidden ? `➕ ${colLabel}` : `➖ ${colLabel}`;
    btn.title = isHidden ? `Show "${colLabel}" column` : `Hide "${colLabel}" column`;
    btn.addEventListener('click', () => {
      if (isHidden) hiddenColumns[tableKey].delete(idx);
      else hiddenColumns[tableKey].add(idx);
      // re-render table only
      window._rerenderFeatureTable(containerId, sprints);
      renderColumnToggles(containerId, sprints); // update buttons state
    });
    togglesDiv.appendChild(btn);
  });
}

// Save a reference to the rendering fn so column toggles can trigger rerender
window._rerenderFeatureTable = function(containerId, sprints) {
  // Get features from rendered table (not ideal, but works since data is not big)
  const container = document.getElementById(containerId);
  if (!container) return;
  const features = container._features || [];
  renderFeatureTable(features, containerId, sprints);
}

function renderFeatureTable(features, containerId, sprints) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container._features = features;

    renderColumnToggles(containerId, sprints);

    const hidden = hiddenColumns[containerId] || new Set();

    // Define column classes (must match order of piPlanningColumns!)
    const columnClasses = [
        'col-rownum',
        'col-capability',
        'col-feature-id',
        'col-feature-name',
        'col-story-points',
        'col-assignee',
        'col-priority',
        'col-status',
        'col-pi-scope',
        'col-links'
    ];

    // HEADER
    let tableHtml = '<table class="pi-planning-table"><thead><tr>';
    [
      '#',
      'Capability',
      'Feature ID',
      'Feature Name',
      'St.P.',
      'Assignee',
      'Prio',
      'Status',
      'PI Scope',
      'Links'
    ].forEach((colLabel, idx) => {
        if (!hidden.has(idx))
            tableHtml += `<th class="${columnClasses[idx]}" onclick="sortTable(this)">${colLabel}</th>`;
    });
    // Sprint columns
    sprints.forEach((sprint, i) => {
        if (!hidden.has(piPlanningColumns.length + i))
            tableHtml += `<th class="story-cell">${sprint}</th>`;
    });
    tableHtml += '</tr></thead><tbody>';

    // ROWS
    let rowIndex = 1;
    for (const [featureId, feature] of features) {
        tableHtml += '<tr>';
        let colIdx = 0;

        // Row number
        if (!hidden.has(colIdx++)) tableHtml += `<td class="col-rownum">${rowIndex}</td>`;
        // Capability
        if (!hidden.has(colIdx++))
            tableHtml += `<td class="col-capability">${feature.parent_link ? `<a href="https://jira-vira.volvocars.biz/browse/${feature.parent_link}" target="_blank">${feature.parent_summary || feature.parent_link}</a>` : ""}</td>`;
        // Feature ID
        if (!hidden.has(colIdx++))
            tableHtml += `<td class="col-feature-id"><a href="https://jira-vira.volvocars.biz/browse/${featureId}" target="_blank">${featureId}</a></td>`;
        // Feature Name
        if (!hidden.has(colIdx++))
            tableHtml += `<td class="col-feature-name"><a href="https://jira-vira.volvocars.biz/browse/${featureId}" target="_blank">${feature.summary}</a></td>`;
        // Story Points
        if (!hidden.has(colIdx++)) {
            let storyPoints = feature.story_points ?? "";
            if (storyPoints && !isNaN(Number(storyPoints))) storyPoints = parseFloat(storyPoints);
            tableHtml += `<td class="col-story-points">${storyPoints !== "" ? storyPoints : ""}</td>`;
        }
        // Assignee
        if (!hidden.has(colIdx++))
            tableHtml += `<td class="col-assignee">${feature.assignee || ""}</td>`;
        // Priority
        if (!hidden.has(colIdx++))
            tableHtml += `<td class="col-priority">${feature.priority || ""}</td>`;
        // Status
        if (!hidden.has(colIdx++))
            tableHtml += `<td class="col-status">${feature.status || ""}</td>`;
        // PI Scope
        if (!hidden.has(colIdx++))
            tableHtml += `<td class="col-pi-scope">${feature.pi_scope || ""}</td>`;
        // Links (badge style)
        // Links: group by type, show type badges, tooltip lists the linked issues
        if (!hidden.has(colIdx++)) {
            const linksArr = feature.linked_issues || [];
            // Group by link_type
            const linksByType = {};
            for (const link of linksArr) {
                const type = link.link_type || "Other";
                if (!linksByType[type]) linksByType[type] = [];
                linksByType[type].push(link);
            }
            // Render a badge per link type (like "delegated from", etc)
            let badgesHtml = "";
            Object.entries(linksByType).forEach(([type, links]) => {
                badgesHtml += `
                  <span class="links-type-badge" tabindex="0"
                        data-links='${JSON.stringify(links)}'
                        data-type="${type}">
                    ${type} <span class="badge-count">(${links.length})</span>
                  </span>
                `;
            });
            tableHtml += `<td class="col-links">${badgesHtml}</td>`;
        }


        // Sprints
        sprints.forEach((sprint, i) => {
            if (!hidden.has(piPlanningColumns.length + i)) {
                let stories = Array.isArray(feature.sprints[sprint]) ? feature.sprints[sprint] : [];
                stories = stories.filter(storyKey =>
                    typeof storyKey === "string" && !!storyKey && storyKey.trim() !== "" && storyKey !== "null" && storyKey !== "undefined"
                );
                if (stories.length) {
                    tableHtml += `<td class="story-cell"><span class="story-badge" tabindex="0" data-stories='${JSON.stringify(stories)}'>${stories.length}</span></td>`;
                } else {
                    tableHtml += `<td class="story-cell"></td>`;
                }
            }
        });
        tableHtml += '</tr>';
        rowIndex++;
    }
    tableHtml += '</tbody></table>';
    container.innerHTML = tableHtml;

    // Tooltip logic unchanged
    document.querySelectorAll('.story-badge').forEach(badge => {
        badge.addEventListener('mouseenter', showCustomTooltip);
        badge.addEventListener('focus', showCustomTooltip);
        badge.addEventListener('mouseleave', hideCustomTooltipWithDelay);
        badge.addEventListener('blur', hideCustomTooltipWithDelay);
    });

    // Attach tooltip handlers for links-type badges
    document.querySelectorAll('.links-type-badge').forEach(badge => {
        badge.addEventListener('mouseenter', showLinksTypeTooltip);
        badge.addEventListener('focus', showLinksTypeTooltip);
        badge.addEventListener('mouseleave', hideLinksTypeTooltipWithDelay);
        badge.addEventListener('blur', hideLinksTypeTooltipWithDelay);
    });

    let tooltip = document.getElementById('custom-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'custom-tooltip';
        tooltip.className = 'custom-tooltip';
        tooltip.style.display = 'none';
        document.body.appendChild(tooltip);
    }
    tooltip.addEventListener('mouseenter', () => {
        clearTimeout(tooltip._hideTimeout);
    });
    tooltip.addEventListener('mouseleave', hideCustomTooltipWithDelay);
}


function showCustomTooltip(event) {
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
    if (!tooltip) return;

    tooltip.innerHTML = stories.map(key =>
        `<a href="https://jira-vira.volvocars.biz/browse/${key}" target="_blank">${key}</a>`
    ).join('');
    tooltip.style.display = 'block';

    // Position below badge, centered, and FIXED, so it doesn't move with mouse
    const rect = badge.getBoundingClientRect();
    const scrollY = window.scrollY !== undefined ? window.scrollY : window.pageYOffset;
    const scrollX = window.scrollX !== undefined ? window.scrollX : window.pageXOffset;
    tooltip.style.left = (rect.left + scrollX + rect.width / 2 - tooltip.offsetWidth / 2) + "px";
    tooltip.style.top = (rect.bottom + scrollY + 6) + "px";
}

function hideCustomTooltipWithDelay() {
    let tooltip = document.getElementById('custom-tooltip');
    if (tooltip) {
        clearTimeout(tooltip._hideTimeout);
        tooltip._hideTimeout = setTimeout(() => {
            tooltip.style.display = 'none';
        }, 250);
    }
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


function showLinksTypeTooltip(event) {
    const badge = event.currentTarget;
    let links = [];
    try {
        links = JSON.parse(badge.getAttribute('data-links')) || [];
    } catch { }
    if (!links.length) return;
    let tooltip = document.getElementById('custom-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'custom-tooltip';
        tooltip.className = 'custom-tooltip';
        tooltip.style.display = 'none';
        document.body.appendChild(tooltip);
    }
    tooltip.innerHTML = links.map(link =>
        `<a href="${link.url}" target="_blank">${link.key}${link.summary ? ': ' + link.summary : ''}</a>`
    ).join('');
    tooltip.style.display = 'block';

    // Position below badge, centered and fixed
    positionTooltipUnderBadge(badge, tooltip);
}

function hideLinksTypeTooltipWithDelay() {
    let tooltip = document.getElementById('custom-tooltip');
    if (tooltip) {
        clearTimeout(tooltip._hideTimeout);
        tooltip._hideTimeout = setTimeout(() => {
            tooltip.style.display = 'none';
        }, 250);
    }
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
    showUniqueUserCount();
});

let lastTooltipBadge = null;

function showCustomTooltip(event) {
    const badge = event.currentTarget;
    lastTooltipBadge = badge; // <-- track for reposition
    let stories = [];
    try {
        stories = JSON.parse(badge.getAttribute('data-stories')) || [];
    } catch { }
    stories = stories.filter(storyKey =>
        !!storyKey && typeof storyKey === "string" && storyKey.trim() !== "" && !/^null|undefined$/i.test(storyKey)
    );
    if (!stories.length) return;
    let tooltip = document.getElementById('custom-tooltip');
    if (!tooltip) return;

    tooltip.innerHTML = stories.map(key =>
        `<a href="https://jira-vira.volvocars.biz/browse/${key}" target="_blank">${key}</a>`
    ).join('');
    tooltip.style.display = 'block';

    // Position below badge, centered
    positionTooltipUnderBadge(badge, tooltip);
}

// Helper for correct positioning
function positionTooltipUnderBadge(badge, tooltip) {
    const rect = badge.getBoundingClientRect();
    const scrollY = window.scrollY !== undefined ? window.scrollY : window.pageYOffset;
    const scrollX = window.scrollX !== undefined ? window.scrollX : window.pageXOffset;
    tooltip.style.position = 'fixed';
    tooltip.style.left = (rect.left + rect.width / 2 - tooltip.offsetWidth / 2) + "px";
    tooltip.style.top = (rect.bottom + 6) + "px";
}

// Update tooltip position on scroll and resize
window.addEventListener('scroll', function () {
    let tooltip = document.getElementById('custom-tooltip');
    if (tooltip && tooltip.style.display === 'block' && lastTooltipBadge) {
        positionTooltipUnderBadge(lastTooltipBadge, tooltip);
    }
});
window.addEventListener('resize', function () {
    let tooltip = document.getElementById('custom-tooltip');
    if (tooltip && tooltip.style.display === 'block' && lastTooltipBadge) {
        positionTooltipUnderBadge(lastTooltipBadge, tooltip);
    }
});

function renderCommittedSummary(committedFeatures, containerId) {
    // Compute totals
    let totalPoints = 0;
    const perPerson = {};

    for (const [, feature] of committedFeatures) {
        const sp = Number(feature.story_points) || 0;
        const assignee = (feature.assignee || "Unassigned").trim() || "Unassigned";
        totalPoints += sp;
        if (!perPerson[assignee]) perPerson[assignee] = 0;
        perPerson[assignee] += sp;
    }

    // Create summary table HTML
    let html = `
      <div class="summary-section">
        <h3>Committed Load (St. P.) Summary</h3>
        <table class="summary-table">
          <tr><th>Total Story Points (Committed, this PI):</th><td>${totalPoints}</td></tr>
        </table>
        <table class="summary-table">
          <tr><th>Assignee</th><th>Load (St. P.)</th></tr>
          ${Object.entries(perPerson).sort((a, b) => b[1] - a[1]).map(
            ([assignee, points]) =>
              `<tr><td>${assignee}</td><td>${points}</td></tr>`
          ).join("")}
        </table>
      </div>
    `;

    const container = document.getElementById(containerId);
    if (container) container.innerHTML = html;
}

function getOrCreateUserId() {
    let uid = localStorage.getItem('user_id');
    if (!uid) {
        // Simple random id
        uid = Math.random().toString(36).substring(2) + Date.now();
        localStorage.setItem('user_id', uid);
    }
    return uid;
}

// Send to backend
function sendUserIdToBackend() {
    const userId = getOrCreateUserId();
    fetch('/track_user', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({user_id: userId})
    });
}
sendUserIdToBackend();

function showUniqueUserCount() {
  let users = JSON.parse(localStorage.getItem("uniqueUsers") || "[]");
  let count = users.length || 1;
  let el = document.getElementById("unique-users-count").innerText = "Unique users: " + (count || 0);
  if (el) el.textContent = count;
}
