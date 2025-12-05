/* =========================
   PI Planning / Dashboard JS
   ========================= */

let currentSortOrder = 'asc';

// --- helpers ---
const norm = s => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

// Exclusion state: applied ONLY after user clicks "Apply"
let activeExcludedRaw = "";

// Parse multi-name input safely. Supports:
// - ; | or newline as separators
// - "Lastname, Firstname" with quotes
// - bare "Lastname, Firstname" (pairs)
function parseExcludedList(raw) {
  if (!raw) return [];
  raw = String(raw).trim();

  const quoted = [];
  raw = raw.replace(/"([^"]+)"/g, (_, m) => {
    quoted.push(m.trim());
    return `<<Q${quoted.length - 1}>>`;
  });

  let items = [];
  if (/[;\n|]/.test(raw)) {
    items = raw.split(/[;\n|]+/).map(s => s.trim()).filter(Boolean);
  } else if (raw.includes(',')) {
    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length % 2 === 0) {
      for (let i = 0; i < parts.length; i += 2) items.push(`${parts[i]}, ${parts[i + 1]}`);
    } else {
      items = [raw];
    }
  } else {
    items = [raw];
  }

  return items.map(s =>
    s.replace(/<<Q(\d+)>>/g, (_, i) => quoted[Number(i)] || "")
  ).map(norm).filter(Boolean);
}
function getActiveExcludedSet() { return new Set(parseExcludedList(activeExcludedRaw)); }

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

// --- remember page selections ---
function savePlanningSettings() {
  localStorage.setItem("piPlanningFixVersion", getSelectedFixVersion());
  localStorage.setItem("piPlanningWorkGroup", getSelectedWorkGroup());
}
function restorePlanningSettings() {
  const fv = localStorage.getItem("piPlanningFixVersion");
  const wg = localStorage.getItem("piPlanningWorkGroup");
  if (fv) { const el = document.getElementById("fixVersionSelect"); if (el) el.value = fv; }
  if (wg) { const el = document.getElementById("workGroupSelect");  if (el) el.value = wg; }
}

function showLoading() { const o = document.getElementById('loading-overlay'); if (o) o.style.display = 'flex'; }
function hideLoading() { const o = document.getElementById('loading-overlay'); if (o) o.style.display = 'none'; }

// --- Exclude UI helpers (storage only; Apply controls state) ---
function restoreExcludedAssignees() {
  const saved = localStorage.getItem("piPlanningExcludedAssignees");
  const input = document.getElementById("excludeAssigneesInput");
  if (input && saved != null) input.value = saved;
}
function persistExcludedAssigneesRaw(raw) {
  localStorage.setItem("piPlanningExcludedAssignees", raw || "");
}

// Build <datalist> suggestions from data
function populateAssigneeSuggestions(dataObj) {
  const dl = document.getElementById("assignee-suggestions");
  if (!dl) return;
  const seen = new Set();
  Object.values(dataObj || {}).forEach(f => {
    if (f.assignee) seen.add(f.assignee);
    if (Array.isArray(f.stories_detail)) {
      f.stories_detail.forEach(s => {
        const who = (s.assignee || "").trim();
        if (who) seen.add(who);
      });
    }
  });
  dl.innerHTML = "";
  Array.from(seen).sort((a,b)=>a.localeCompare(b)).forEach(name => {
    const opt = document.createElement("option");
    opt.value = name;
    dl.appendChild(opt);
  });
}

/* ========================
   PI Planning main loader
   ======================== */
async function loadPIPlanningData() {
  showLoading();
  function getExcludedRaw() {
    const el = document.getElementById("excludeAssigneesInput");
    return (el?.value || "").trim();
  }
  try {
    const fixVersion = getSelectedFixVersion();
    const workGroup  = getSelectedWorkGroup();
    if (!fixVersion || !workGroup) return;

    const excludedRaw = getExcludedRaw();
    const url = `/pi_planning_data?fixVersion=${encodeURIComponent(fixVersion)}&workGroup=${encodeURIComponent(workGroup)}${
      excludedRaw ? `&excludeAssignees=${encodeURIComponent(excludedRaw)}` : ""
    }`;
    const response = await fetch(url, { cache: "no-store" });
    const data = await response.json();

    // suggestions based on RAW data
    populateAssigneeSuggestions(data);

    const excluded = getActiveExcludedSet();

    // 1) story-level filtering (when stories_detail is present)
    for (const [, feature] of Object.entries(data)) {
      const details = Array.isArray(feature.stories_detail) ? feature.stories_detail : [];

      const byKeyAssignee = new Map(
        details.filter(d => d && d.key).map(d => [String(d.key), norm(d.assignee)])
      );

      const keptDetails = excluded.size
        ? details.filter(d => !excluded.has(norm(d.assignee)))
        : details.slice();

      feature.stories_detail = keptDetails;
      feature.sum_story_points = keptDetails.reduce((sum, d) => sum + (Number(d.story_points) || 0), 0);

      const sMap = feature.sprints || {};
      const newSprints = {};
      for (const [sprintName, arr] of Object.entries(sMap)) {
        const keptKeys = (Array.isArray(arr) ? arr : []).filter(k => {
          if (!excluded.size) return true;
          const a = byKeyAssignee.get(String(k)); // may be undefined if backend didn’t supply details
          return !a || !excluded.has(a);          // unknown assignee => keep
        });
        newSprints[sprintName] = keptKeys;
      }
      feature.sprints = newSprints;
    }

    // 2) feature-level filtering (ALWAYS available)
    const dropFeature = f => excluded.size && excluded.has(norm(f.assignee));

    // Define sprint columns
    const sprints = ["Sprint 1","Sprint 2","Sprint 3","Sprint 4","Sprint 5","No Sprint"];

    const featureInSelectedPI = (feature, fv) =>
      Array.isArray(feature.fixVersions) && feature.fixVersions.includes(fv);
    const isDone = feature => (feature.status || "").toLowerCase() === "done";

    const committed = [];
    const backlog   = [];

    for (const [key, feature] of Object.entries(data)) {
      if (dropFeature(feature)) continue;

      const scope = (feature.pi_scope || "").toLowerCase();
      const inPI = Array.isArray(feature.fixVersions)
        ? feature.fixVersions.includes(fixVersion)
        : false;

      const hasStories = Array.isArray(feature.stories_detail) && feature.stories_detail.length > 0;

      if (scope.startsWith("committed") && (inPI || hasStories)) {
        committed.push([key, feature]);
      } else if (!isDone(feature)) {
        backlog.push([key, feature]);
      }
    }

    console.log("Committed count for table/Gantt:", committed.length);


    renderFeatureTable(committed, "committed-table", sprints);

    // Don't let summary kill the Gantt
    try {
      if (typeof renderCommittedSummary === "function") {
        renderCommittedSummary(committed, "committed-summary");
      }
    } catch (e) {
      console.error("renderCommittedSummary failed, skipping summary:", e);
    }

    renderGanttTimeline(committed, sprints);


    applyFilter();
  } finally {
    hideLoading();
  }
}

/* =====================
   Backlog (unchanged)
   ===================== */
async function loadBacklogData() {
  showLoading();
  try {
    const workGroup = getSelectedWorkGroup();
    if (!workGroup) return;

    const url = `/backlog_data?workGroup=${encodeURIComponent(workGroup)}`;
    const resp = await fetch(url);
    const data = await resp.json();

    renderFeatureTable(Object.entries(data), "backlog-table", []);
    applyFilter();
  } finally {
    hideLoading();
  }
}

/* ======================
   Table render + toggles
   ====================== */

const piPlanningColumns = [
  { key: 'rownum', label: '#' },
  { key: 'capability', label: 'Capability' },
  { key: 'featureid', label: 'Feature ID' },
  { key: 'featurename', label: 'Feature Name' },
  { key: 'storypoints', label: 'Feature St.P.' },
  { key: 'totalpoints', label: 'St.P. sum' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'priority', label: 'Priority' },
  { key: 'status', label: 'Status' },
  { key: 'piscope', label: 'PI Scope' },
  { key: 'links', label: 'Links' }
];

const hiddenColumns = {
  'committed-table': new Set(),
  'backlog-table': new Set(),
};

function renderColumnToggles(containerId, sprints) {
  const togglesDiv = document.getElementById(containerId.replace('-table', '-column-toggles'));
  if (!togglesDiv) return;

  const columns = [...piPlanningColumns.map(col => col.label), ...sprints];
  togglesDiv.innerHTML = '';
  columns.forEach((colLabel, idx) => {
    const isDisabled = idx === 0;
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
      window._rerenderFeatureTable(containerId, sprints);
      renderColumnToggles(containerId, sprints);
    });
    togglesDiv.appendChild(btn);
  });
}

window._rerenderFeatureTable = function(containerId, sprints) {
  const container = document.getElementById(containerId);
  if (!container) return;
  renderFeatureTable(container._features || [], containerId, sprints);
};

function renderFeatureTable(features, containerId, sprints) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container._features = features;
  renderColumnToggles(containerId, sprints);

  const hidden = hiddenColumns[containerId] || new Set();

  const columnClasses = [
    'col-rownum',
    'col-capability',
    'col-feature-id',
    'col-feature-name',
    'col-story-points',
    'col-story-points',
    'col-assignee',
    'col-priority',
    'col-status',
    'col-pi-scope',
    'col-links'
  ];

  let tableHtml = '<table class="pi-planning-table"><thead><tr>';
  const headerLabels = ['#','Capability','Feature ID','Feature Name','Feature St.P.','St.P. sum','Assignee','Prio','Status','PI Scope','Links'];
  headerLabels.forEach((label, idx) => {
    if (!hidden.has(idx))
      tableHtml += `<th class="${columnClasses[idx]}" onclick="sortTable(this)">${label}</th>`;
  });
  sprints.forEach((sprint, i) => {
    if (!hidden.has(piPlanningColumns.length + i))
      tableHtml += `<th class="story-cell">${sprint}</th>`;
  });
  tableHtml += '</tr></thead><tbody>';

  let rowIndex = 1;
  for (const [featureId, feature] of features) {
    tableHtml += '<tr>';
    let colIdx = 0;

    if (!hidden.has(colIdx++)) tableHtml += `<td class="col-rownum">${rowIndex}</td>`;
    if (!hidden.has(colIdx++)) {
      const capCell = feature.parent_link
        ? `<a href="https://jira-vira.volvocars.biz/browse/${feature.parent_link}" target="_blank">${feature.parent_summary || feature.parent_link}</a>`
        : "";
      tableHtml += `<td class="col-capability">${capCell}</td>`;
    }
    if (!hidden.has(colIdx++))
      tableHtml += `<td class="col-feature-id"><a href="https://jira-vira.volvocars.biz/browse/${featureId}" target="_blank">${featureId}</a></td>`;
    if (!hidden.has(colIdx++))
      tableHtml += `<td class="col-feature-name"><a href="https://jira-vira.volvocars.biz/browse/${featureId}" target="_blank">${feature.summary}</a></td>`;
    if (!hidden.has(colIdx++)) {
      let sp = feature.story_points ?? "";
      if (sp && !isNaN(Number(sp))) sp = parseFloat(sp);
      tableHtml += `<td class="col-story-points">${sp !== "" ? sp : ""}</td>`;
    }
    if (!hidden.has(colIdx++)) {
      let total = feature.sum_story_points ?? "";
      if (total && !isNaN(Number(total))) total = parseFloat(total);
      tableHtml += `<td class="col-story-points">${total !== "" ? total : ""}</td>`;
    }
    if (!hidden.has(colIdx++))
      tableHtml += `<td class="col-assignee">${feature.assignee || ""}</td>`;
    if (!hidden.has(colIdx++))
      tableHtml += `<td class="col-priority">${feature.priority || ""}</td>`;
    if (!hidden.has(colIdx++))
      tableHtml += `<td class="col-status">${feature.status || ""}</td>`;
    if (!hidden.has(colIdx++))
      tableHtml += `<td class="col-pi-scope">${feature.pi_scope || ""}</td>`;
    if (!hidden.has(colIdx++)) {
      const linksArr = feature.linked_issues || [];
      const linksByType = {};
      for (const link of linksArr) {
        const type = link.link_type || "Other";
        (linksByType[type] ||= []).push(link);
      }
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

    sprints.forEach((sprint, i) => {
      if (!hidden.has(piPlanningColumns.length + i)) {
        let stories = Array.isArray(feature.sprints[sprint]) ? feature.sprints[sprint] : [];
        stories = stories.filter(k => typeof k === "string" && k.trim() && !/^null|undefined$/i.test(k));
        tableHtml += stories.length
          ? `<td class="story-cell"><span class="story-badge" tabindex="0" data-stories='${JSON.stringify(stories)}'>${stories.length}</span></td>`
          : `<td class="story-cell"></td>`;
      }
    });

    tableHtml += '</tr>';
    rowIndex++;
  }

  if (containerId === 'committed-table') {
    let totalFeatureSP = 0;
    let totalStoriesSP = 0;
    for (const [, feature] of features) {
      totalFeatureSP += Number(feature.story_points) || 0;
      totalStoriesSP += Number(feature.sum_story_points) || 0;
    }

    tableHtml += '<tr class="totals-row">';
    headerLabels.forEach((_, idx) => {
      if (hidden.has(idx)) return;
      const isFeatureNameCol = idx === 3;
      const isFeatureSPCol = idx === 4;
      const isStoriesSPCol = idx === 5;
      let content = '';
      if (isFeatureNameCol) content = 'Total';
      else if (isFeatureSPCol) content = String(totalFeatureSP);
      else if (isStoriesSPCol) content = String(totalStoriesSP);
      tableHtml += `<td class="${columnClasses[idx]}">${content}</td>`;
    });
    sprints.forEach((_, i) => {
      if (!hidden.has(piPlanningColumns.length + i)) tableHtml += `<td class="story-cell"></td>`;
    });
    tableHtml += '</tr>';
  }

  tableHtml += '</tbody></table>';
  container.innerHTML = tableHtml;

  // tooltips for story counts and link badges
  document.querySelectorAll('.story-badge').forEach(b => {
    b.addEventListener('mouseenter', onStoryBadgeEnter);
    b.addEventListener('focus', onStoryBadgeEnter);
    b.addEventListener('mouseleave', hideTooltipDelayed);
    b.addEventListener('blur', hideTooltipDelayed);
  });
  document.querySelectorAll('.links-type-badge').forEach(b => {
    b.addEventListener('mouseenter', onLinksBadgeEnter);
    b.addEventListener('focus', onLinksBadgeEnter);
    b.addEventListener('mouseleave', hideTooltipDelayed);
    b.addEventListener('blur', hideTooltipDelayed);
  });

  ensureTooltip();
}

/* ==============
   Tooltip logic
   ============== */
function ensureTooltip() {
  let t = document.getElementById('custom-tooltip');
  if (!t) {
    t = document.createElement('div');
    t.id = 'custom-tooltip';
    t.className = 'custom-tooltip';
    t.style.display = 'none';
    document.body.appendChild(t);
  }
  return t;
}
function positionTooltipUnder(el, tooltip) {
  const rect = el.getBoundingClientRect();
  tooltip.style.position = 'fixed';
  tooltip.style.left = (rect.left + rect.width / 2 - tooltip.offsetWidth / 2) + "px";
  tooltip.style.top  = (rect.bottom + 6) + "px";
}
function onStoryBadgeEnter(e) {
  const badge = e.currentTarget;
  const tooltip = ensureTooltip();
  let stories = [];
  try { stories = JSON.parse(badge.getAttribute('data-stories')) || []; } catch {}
  stories = stories.filter(k => k && typeof k === 'string');
  if (!stories.length) return;
  tooltip.innerHTML = stories.map(k =>
    `<a href="https://jira-vira.volvocars.biz/browse/${k}" target="_blank">${k}</a>`
  ).join('');
  tooltip.style.display = 'block';
  positionTooltipUnder(badge, tooltip);
}
function onLinksBadgeEnter(e) {
  const badge = e.currentTarget;
  const tooltip = ensureTooltip();
  let links = [];
  try { links = JSON.parse(badge.getAttribute('data-links')) || []; } catch {}
  if (!links.length) return;
  tooltip.innerHTML = links.map(l =>
    `<a href="${l.url}" target="_blank">${l.key}${l.summary ? ': ' + l.summary : ''}</a>`
  ).join('');
  tooltip.style.display = 'block';
  positionTooltipUnder(badge, tooltip);
}
function hideTooltipDelayed() {
  const t = document.getElementById('custom-tooltip');
  if (!t) return;
  clearTimeout(t._hideTimeout);
  t._hideTimeout = setTimeout(() => { t.style.display = 'none'; }, 250);
}

/* =========================
   Fault Report (dashboard)
   ========================= */
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
    data: { labels, datasets: [{ label: "Class Count", data: counts, backgroundColor: "rgba(75, 192, 192, 0.5)", borderColor: "rgba(75, 192, 192, 1)", borderWidth: 1, barThickness: 40 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        y: { beginAtZero: true, ticks: { font: { size: 16 }, stepSize: 1, callback: v => Number.isInteger(v) ? v : null } },
        x: { ticks: { font: { size: 14 } } }
      },
      plugins: { legend: { labels: { font: { size: 18 } } } }
    }
  });
}
async function renderTable() {
  const issues = await fetchIssues();
  const tbody = document.querySelector("#issueTable tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  issues.forEach(issue => {
    const linksHtml = (issue.linked_features || []).map(l => `<a href="${l.url}" target="_blank">${l.key}</a>`).join(" ");
    const featureNames = (issue.linked_features || []).map(l => `${l.summary}`).join("; ");
    const row = document.createElement("tr");
    row.innerHTML = `
      <td class="one-line-cell"><a href="https://jira-vira.volvocars.biz/browse/${issue.key}" target="_blank">${issue.key}</a></td>
      <td>${issue.summary}</td>
      <td>${issue.status.name || issue.status}</td>
      <td class="hide-labels">${Array.isArray(issue.labels) ? issue.labels.join(", ") : ""}</td>
      <td class="${issue.classes.length === 0 ? 'no-class' : ''}">${(Array.isArray(issue.classes) && issue.classes.length > 0) ? issue.classes.join(", ") : ""}</td>
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
  const btn = document.getElementById("sortClasses");
  if (btn) btn.innerText = `Classes ${currentSortOrder === 'asc' ? '▲' : '▼'}`;
}

/* ==========================
   Remember other selections
   ========================== */
function saveDashboardSettings() {
  localStorage.setItem("dashboardFixVersion", getSelectedFixVersion());
  localStorage.setItem("dashboardWorkGroup", getSelectedWorkGroup());
}
function restoreDashboardSettings() {
  const fv = localStorage.getItem("dashboardFixVersion");
  const wg = localStorage.getItem("dashboardWorkGroup");
  if (fv) { const el = document.getElementById("fixVersionSelect"); if (el) el.value = fv; }
  if (wg) { const el = document.getElementById("workGroupSelect");  if (el) el.value = wg; }
}
function saveBacklogSettings() {
  localStorage.setItem("backlogWorkGroup", getSelectedWorkGroup());
}
function restoreBacklogSettings() {
  const wg = localStorage.getItem("backlogWorkGroup");
  if (wg) { const el = document.getElementById("workGroupSelect"); if (el) el.value = wg; }
}

/* ===============
   Page bootstrap
   =============== */
document.addEventListener("DOMContentLoaded", () => {
  const isDashboard = document.getElementById("statsChart") && document.getElementById("issueTable");
  const isPlanning  = !!document.getElementById("committed-table");
  const isBacklog   = !!document.getElementById("backlog-table") && !document.getElementById("committed-table");

  if (isDashboard) {
    restoreDashboardSettings();
    renderChart(); renderTable();
    document.getElementById("refresh")?.addEventListener("click", () => { renderChart(); renderTable(); });
    document.getElementById("fixVersionSelect")?.addEventListener("change", () => { saveDashboardSettings(); renderChart(); renderTable(); });
    document.getElementById("workGroupSelect")?.addEventListener("change", () => { saveDashboardSettings(); renderChart(); renderTable(); });
  }

  if (isPlanning) {
    restorePlanningSettings();
    restoreExcludedAssignees();       // show only
    activeExcludedRaw = "";           // start with FULL LIST
    loadPIPlanningData();

    document.getElementById("fixVersionSelect")?.addEventListener("change", () => { savePlanningSettings(); loadPIPlanningData(); });
    document.getElementById("workGroupSelect")?.addEventListener("change", () => { savePlanningSettings(); loadPIPlanningData(); });
    document.getElementById("globalFilter")?.addEventListener("input", applyFilter);

    document.getElementById("apply-exclude")?.addEventListener("click", () => {
      activeExcludedRaw = document.getElementById("excludeAssigneesInput")?.value || "";
      persistExcludedAssigneesRaw(activeExcludedRaw);
      loadPIPlanningData();
    });
    document.getElementById("excludeAssigneesInput")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        activeExcludedRaw = document.getElementById("excludeAssigneesInput")?.value || "";
        persistExcludedAssigneesRaw(activeExcludedRaw);
        loadPIPlanningData();
      }
    });
    document.getElementById("clear-exclude")?.addEventListener("click", () => {
      const el = document.getElementById("excludeAssigneesInput");
      if (el) el.value = "";
      activeExcludedRaw = "";
      persistExcludedAssigneesRaw(activeExcludedRaw);
      loadPIPlanningData();
    });

    document.getElementById("export-committed-excel")?.addEventListener("click", function () {
      const fv = getSelectedFixVersion();
      const wg = getSelectedWorkGroup();
      window.location.href = `/export_committed_excel?fixVersion=${encodeURIComponent(fv)}&workGroup=${encodeURIComponent(wg)}`;
    });
  }

  if (isBacklog) {
    restoreBacklogSettings();
    loadBacklogData();
    document.getElementById("workGroupSelect")?.addEventListener("change", () => { saveBacklogSettings(); loadBacklogData(); });
    document.getElementById("globalFilter")?.addEventListener("input", applyFilter);
    document.getElementById("export-backlog-excel")?.addEventListener("click", function () {
      const wg = getSelectedWorkGroup();
      window.location.href = `/export_backlog_excel?workGroup=${encodeURIComponent(wg)}`;
    });
  }

  sendUserIdToBackend().catch(() => {}).finally(showUniqueUserCount);
});

/* ================
   User tracking UI
   ================ */
function getOrCreateUserId() {
  let uid = localStorage.getItem('user_id');
  if (!uid) { uid = Math.random().toString(36).substring(2) + Date.now(); localStorage.setItem('user_id', uid); }
  return uid;
}
function sendUserIdToBackend() {
  return fetch('/track_user', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: getOrCreateUserId() })
  });
}
async function showUniqueUserCount() {
  try {
    const res = await fetch('/unique_users', { cache: 'no-store' });
    const data = await res.json();
    const el = document.getElementById('unique-users-count');
    if (el) el.textContent = `Unique users: ${Number(data.unique_users) || 0}`;
  } catch {
    const el = document.getElementById('unique-users-count');
    if (el) el.textContent = 'Unique users: –';
  }
}

function mapStatusToClass(status) {
  const s = (status || "").toLowerCase();

  if (s.includes("in progress") || s.includes("doing") || s.includes("wip")) {
    return "status-progress";
  }
  if (s.includes("done") || s.includes("resolved") || s.includes("closed")) {
    return "status-done";
  }
  return "status-todo";
}



/* =====================
   Gantt (committed only)
   ===================== */
function renderGanttTimeline(committedFeatures, sprints) {
  const host = document.getElementById("gantt-container");
  if (!host) return;

  // Debug: see in console how many features we got
  console.log(
    "[Gantt] committedFeatures:",
    Array.isArray(committedFeatures) ? committedFeatures.length : committedFeatures
  );

  host.style.setProperty("--gantt-cols", String(sprints.length));
  host.innerHTML = "";

  // --- helper: map status -> CSS class (inline, no external dependency)
  const mapStatus = (status) => {
    const s = (status || "").toLowerCase();
    if (s.includes("in progress") || s.includes("doing") || s.includes("wip")) return "status-progress";
    if (s.includes("done") || s.includes("resolved") || s.includes("closed")) return "status-done";
    return "status-todo";
  };

  const normalizeItem = (x) =>
    typeof x === "string" ? { key: x, status: "" } : { key: x?.key || "", status: x?.status || "" };

  const buildStatusMap = (feature) => {
    const m = new Map();
    if (Array.isArray(feature.stories_detail)) {
      feature.stories_detail.forEach((d) => {
        if (d && d.key) m.set(String(d.key), d.status || "");
      });
    }
    return m;
  };

  // ---- Legend
  const legend = document.createElement("div");
  legend.className = "gantt-legend";
  [
    { cls: "status-todo", label: "To Do" },
    { cls: "status-progress", label: "In Progress" },
    { cls: "status-done", label: "Done" },
  ].forEach((item) => {
    const w = document.createElement("div");
    w.className = "gantt-legend-item";
    const box = document.createElement("span");
    box.className = "gantt-chip " + item.cls;
    const lbl = document.createElement("span");
    lbl.textContent = item.label;
    w.appendChild(box);
    w.appendChild(lbl);
    legend.appendChild(w);
  });
  host.appendChild(legend);

  // ---- Header
  const header = document.createElement("div");
  header.className = "gantt-header";
  const headLabel = document.createElement("div");
  headLabel.textContent = "";
  header.appendChild(headLabel);
  sprints.forEach((name) => {
    const h = document.createElement("div");
    h.textContent = name;
    header.appendChild(h);
  });
  host.appendChild(header);

  // If somehow no committed features – show a message instead of “nothing”
  if (!Array.isArray(committedFeatures) || committedFeatures.length === 0) {
    const msg = document.createElement("div");
    msg.style.padding = "8px 6px";
    msg.style.fontSize = "12px";
    msg.style.color = "#666";
    msg.textContent = "No committed features to display in Gantt.";
    host.appendChild(msg);
    return;
  }

  // ---- Rows
  for (const [featureId, feature] of committedFeatures) {
    const row = document.createElement("div");
    row.className = "gantt-row";

    // left label
    const label = document.createElement("div");
    label.className = "gantt-label";
    label.innerHTML = `<a href="https://jira-vira.volvocars.biz/browse/${featureId}" target="_blank">${
      feature.summary || featureId
    }</a>`;
    row.appendChild(label);

    const statusByKey = buildStatusMap(feature);

    // per-sprint stories (aligned to 'sprints' order)
    const storiesPerSprint = sprints.map((s) => {
      const arr = feature.sprints && Array.isArray(feature.sprints[s]) ? feature.sprints[s] : [];
      return arr.map(normalizeItem);
    });

    const activeIdx = storiesPerSprint
      .map((arr, i) => (arr && arr.length ? i : -1))
      .filter((i) => i >= 0);

    if (activeIdx.length) {
      const start = activeIdx[0];
      const end = activeIdx[activeIdx.length - 1];
      const bar = document.createElement("div");
      bar.className = "gantt-bar";
      bar.style.gridColumnStart = 2 + start;
      bar.style.gridColumnEnd = 2 + end + 1;
      bar.style.setProperty("--span-cols", String(end - start + 1));

      for (let i = start; i <= end; i++) {
        const seg = document.createElement("div");
        seg.className = "gantt-seg";
        (storiesPerSprint[i] || []).forEach((story) => {
          const chip = document.createElement("span");
          const st = statusByKey.get(story.key) || story.status || "";
          chip.className = "gantt-chip " + mapStatus(st);
          chip.title = story.key || "";
          seg.appendChild(chip);
        });
        bar.appendChild(seg);
      }
      row.appendChild(bar);
    } else {
      // Only “No Sprint” bucket has stories (and no sprint columns are used)
      const noIdx = sprints.indexOf("No Sprint");
      const raw = (feature.sprints && feature.sprints["No Sprint"]) || [];
      if (noIdx >= 0 && raw.length) {
        const bar = document.createElement("div");
        bar.className = "gantt-bar nosprint";
        bar.style.gridColumnStart = 2 + noIdx;
        bar.style.gridColumnEnd = 2 + noIdx + 1;
        bar.style.setProperty("--span-cols", "1");

        const seg = document.createElement("div");
        seg.className = "gantt-seg";
        raw.map(normalizeItem).forEach((story) => {
          const chip = document.createElement("span");
          const st = statusByKey.get(story.key) || story.status || "";
          chip.className = "gantt-chip " + mapStatus(st);
          chip.title = story.key || "";
          seg.appendChild(chip);
        });
        bar.appendChild(seg);
        row.appendChild(bar);
      }
    }

    host.appendChild(row);
  }
}
