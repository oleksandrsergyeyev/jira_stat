/* =========================
   PI Planning / Dashboard JS
   ========================= */

let currentSortOrder = 'asc';
let backlogSelectedStatuses = new Set();
const CLIENT_CACHE_PREFIX = "jiraStatCache::";
let roadmapCollapsedCapabilities = new Set();
let roadmapCollapsedYears = new Set();

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

function makeCacheKey(scope, paramsObj) {
  const ordered = Object.keys(paramsObj || {}).sort().reduce((acc, k) => {
    acc[k] = paramsObj[k];
    return acc;
  }, {});
  return `${CLIENT_CACHE_PREFIX}${scope}::${JSON.stringify(ordered)}`;
}

function readClientCache(cacheKey) {
  try {
    const raw = localStorage.getItem(cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.data ?? null;
  } catch {
    return null;
  }
}

function writeClientCache(cacheKey, data) {
  try {
    localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data }));
  } catch {
    // ignore storage quota or serialization issues
  }
}

async function fetchJsonWithClientCache(url, cacheKey, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = readClientCache(cacheKey);
    if (cached != null) return cached;
  }
  const resp = await fetch(url, { cache: "no-store" });
  const json = await resp.json();
  writeClientCache(cacheKey, json);
  return json;
}

function applyFilter() {
  const filterInput = document.getElementById("globalFilter");
  if (!filterInput) return;
  const filter = filterInput.value.toLowerCase();
  const selectedStatuses = new Set(Array.from(backlogSelectedStatuses).map(s => s.toLowerCase()));
  const hasBacklogStatusFilter = !!document.getElementById("statusFilterMenu");
  document.querySelectorAll("table tbody tr").forEach(row => {
    const matchesText = row.innerText.toLowerCase().includes(filter);
    const rowStatus = (row.getAttribute("data-status") || "").toLowerCase();
    const matchesStatus = !hasBacklogStatusFilter || selectedStatuses.has(rowStatus);
    row.style.display = (matchesText && matchesStatus) ? "" : "none";
  });
  document.querySelectorAll("table").forEach(renumberVisibleRows);
}

function renumberVisibleRows(table) {
  if (!table) return;
  const rows = Array.from(table.querySelectorAll("tbody tr"));
  let next = 1;
  rows.forEach(row => {
    if (row.classList.contains("totals-row")) return;
    const numCell = row.querySelector("td.col-rownum");
    if (!numCell) return;
    if (row.style.display === "none") return;
    numCell.textContent = String(next++);
  });
}

function sortTable(header) {
  const table = header.closest("table");
  const tbody = table.querySelector("tbody");
  const index = Array.from(header.parentNode.children).indexOf(header);
  const rows = Array.from(tbody.querySelectorAll("tr"));
  const totalsRows = rows.filter(r => r.classList.contains("totals-row"));
  const sortableRows = rows.filter(r => !r.classList.contains("totals-row"));
  const ascending = !header.classList.contains("asc");

  sortableRows.sort((a, b) => {
    const aText = a.cells[index]?.innerText.toLowerCase() || "";
    const bText = b.cells[index]?.innerText.toLowerCase() || "";
    return ascending ? aText.localeCompare(bText) : bText.localeCompare(aText);
  });

  tbody.innerHTML = "";
  sortableRows.forEach(row => tbody.appendChild(row));
  totalsRows.forEach(row => tbody.appendChild(row));
  table.querySelectorAll("th").forEach(th => th.classList.remove("asc", "desc"));
  header.classList.add(ascending ? "asc" : "desc");
  renumberVisibleRows(table);
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
async function loadPIPlanningData(forceRefresh = false) {
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
    }${forceRefresh ? "&forceRefresh=1" : ""}`;
    const cacheKey = makeCacheKey("piPlanningData", { fixVersion, workGroup, excludedRaw });
    const data = await fetchJsonWithClientCache(url, cacheKey, forceRefresh);

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
function parseIsoDate(value) {
  if (!value || typeof value !== "string") return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(d.getTime()) ? null : d;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getIsoWeekParts(dateUtc) {
  const d = new Date(Date.UTC(dateUtc.getUTCFullYear(), dateUtc.getUTCMonth(), dateUtc.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

function makeWeekKey(year, week) {
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function parseWeekKey(key) {
  const m = String(key || "").match(/^(\d{4})-W(\d{2})$/);
  if (!m) return null;
  return { year: Number(m[1]), week: Number(m[2]) };
}

function nextWeekKey(key) {
  const parsed = parseWeekKey(key);
  if (!parsed) return key;
  if (parsed.week >= 52) return makeWeekKey(parsed.year + 1, 1);
  return makeWeekKey(parsed.year, parsed.week + 1);
}

function buildWeekRange(startKey, endKey) {
  const out = [];
  let cursor = startKey;
  let guard = 0;
  while (cursor && guard < 260) {
    out.push(cursor);
    if (cursor === endKey) break;
    cursor = nextWeekKey(cursor);
    guard += 1;
  }
  return out;
}

function parseQsFixVersionLatest(fixVersions, archivedFixVersions) {
  const versions = Array.isArray(fixVersions) ? fixVersions : [];
  const archivedSet = new Set((Array.isArray(archivedFixVersions) ? archivedFixVersions : []).map(String));
  const candidates = [];

  for (const name of versions) {
    const m = String(name || "").match(/QS_(\d{2})w(\d{2})/i);
    if (!m) continue;
    const yy = Number(m[1]);
    const ww = Number(m[2]);
    if (!Number.isFinite(yy) || !Number.isFinite(ww) || ww < 1 || ww > 53) continue;
    candidates.push({ year: 2000 + yy, week: ww, raw: String(name), archived: archivedSet.has(String(name)) });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => (a.year - b.year) || (a.week - b.week));
  return candidates[candidates.length - 1];
}

function getQsPeriodEnd(year, startWeek) {
  const qsStarts = [10, 22, 37, 49];
  for (const w of qsStarts) {
    if (w > startWeek) return { year, week: w - 1 };
  }
  return { year: year + 1, week: 9 };
}

function roadmapSlotForFeature(feature) {
  const qs = parseQsFixVersionLatest(feature?.fixVersions || [], feature?.archived_fixVersions || []);
  const status = String(feature?.status || "").toLowerCase();
  const isDone = status.includes("done") || status.includes("resolved") || status.includes("closed");
  const isVerification = status.includes("verification");

  if (qs && !isDone && !isVerification && qs.archived) {
    return { startKey: "FUTURE", endKey: "FUTURE", isFuture: true, periodLabel: `${qs.raw} (archived)` };
  }

  if (!qs) {
    return { startKey: "FUTURE", endKey: "FUTURE", isFuture: true, periodLabel: "Future" };
  }

  const end = getQsPeriodEnd(qs.year, qs.week);
  const nowParts = getIsoWeekParts(new Date());
  const currentWeekKey = makeWeekKey(nowParts.year, nowParts.week);
  const qsEndKey = makeWeekKey(end.year, end.week);
  const isOverdue = qsEndKey < currentWeekKey;

  if (!isDone && !isVerification && isOverdue) {
    return { startKey: "FUTURE", endKey: "FUTURE", isFuture: true, periodLabel: `${qs.raw} (overdue)` };
  }

  return {
    startKey: makeWeekKey(qs.year, qs.week),
    endKey: qsEndKey,
    isFuture: false,
    periodLabel: qs.raw,
  };
}

function roadmapCollapseStorageKey() {
  return `roadmapCollapsed::${getSelectedWorkGroup() || ""}`;
}

function restoreRoadmapCollapseState() {
  try {
    const raw = localStorage.getItem(roadmapCollapseStorageKey());
    if (!raw) {
      roadmapCollapsedCapabilities = new Set();
      return false;
    }
    const arr = JSON.parse(raw);
    roadmapCollapsedCapabilities = new Set(Array.isArray(arr) ? arr : []);
    return true;
  } catch {
    roadmapCollapsedCapabilities = new Set();
    return false;
  }
}

function persistRoadmapCollapseState() {
  localStorage.setItem(
    roadmapCollapseStorageKey(),
    JSON.stringify(Array.from(roadmapCollapsedCapabilities))
  );
}

function roadmapYearCollapseStorageKey() {
  return `roadmapCollapsedYears::${getSelectedWorkGroup() || ""}`;
}

function restoreRoadmapYearCollapseState() {
  try {
    const raw = localStorage.getItem(roadmapYearCollapseStorageKey());
    if (!raw) {
      roadmapCollapsedYears = new Set();
      return false;
    }
    const arr = JSON.parse(raw);
    roadmapCollapsedYears = new Set(Array.isArray(arr) ? arr.map(String) : []);
    return true;
  } catch {
    roadmapCollapsedYears = new Set();
    return false;
  }
}

function persistRoadmapYearCollapseState() {
  localStorage.setItem(
    roadmapYearCollapseStorageKey(),
    JSON.stringify(Array.from(roadmapCollapsedYears))
  );
}

function renderBacklogRoadmap(featuresObj) {
  const host = document.getElementById("backlog-roadmap");
  if (!host) return;
  host._roadmapData = featuresObj || {};
  const hasSavedCollapseState = restoreRoadmapCollapseState();

  const entries = Object.entries(featuresObj || {});
  if (!entries.length) {
    host.innerHTML = '<div class="roadmap-empty">No backlog items to display.</div>';
    return;
  }

  const items = [];
  for (const [featureId, feature] of entries) {
    const slot = roadmapSlotForFeature(feature);
    items.push({
      featureId,
      feature,
      capability: feature?.parent_summary || feature?.parent_link || "No Capability",
      startKey: slot.startKey,
      endKey: slot.endKey,
      isFuture: slot.isFuture,
      periodLabel: slot.periodLabel,
    });
  }

  const datedItems = items.filter(i => !i.isFuture);
  const hasFutureItems = items.some(i => i.isFuture);
  const currentYear = new Date().getFullYear();
  const previousYearQsStart = makeWeekKey(currentYear - 1, 49);
  const currentYearStart = makeWeekKey(currentYear, 1);
  const currentYearEnd = makeWeekKey(currentYear, 52);

  let weeks = [];
  if (datedItems.length) {
    const minKey = datedItems.map(i => i.startKey).sort()[0];
    const maxKey = datedItems.map(i => i.endKey).sort().slice(-1)[0];
    const baselineStart = previousYearQsStart < currentYearStart ? previousYearQsStart : currentYearStart;
    const rangeStart = minKey < baselineStart ? minKey : baselineStart;
    const rangeEnd = maxKey > currentYearEnd ? maxKey : currentYearEnd;
    weeks = buildWeekRange(rangeStart, rangeEnd);
  } else {
    weeks = buildWeekRange(previousYearQsStart, currentYearEnd);
  }

  const hasSavedYearCollapseState = restoreRoadmapYearCollapseState();
  const weekIdx = new Map(weeks.map((w, i) => [w, i]));

  const yearBands = [];
  const qsStartWeeks = new Set([10, 22, 37, 49]);
  weeks.forEach((weekKey, idx) => {
    const parsed = parseWeekKey(weekKey);
    const year = parsed?.year || "";
    const last = yearBands[yearBands.length - 1];
    if (!last || last.year !== year) {
      yearBands.push({ year, startIdx: idx, count: 1 });
    } else {
      last.count += 1;
    }
  });

  if (!hasSavedYearCollapseState) {
    roadmapCollapsedYears = new Set();
    persistRoadmapYearCollapseState();
  }

  const timelineSlots = [];
  const yearHeaderBands = [];
  yearBands.forEach((band) => {
    const yearLabel = String(band.year);
    const isYearCollapsed = roadmapCollapsedYears.has(yearLabel);
    const startSlotIdx = timelineSlots.length;

    if (isYearCollapsed) {
      timelineSlots.push({
        type: "year",
        year: yearLabel,
        startWeekIdx: band.startIdx,
        endWeekIdx: band.startIdx + band.count - 1,
        isYearStart: true,
      });
    } else {
      for (let i = 0; i < band.count; i += 1) {
        const weekIndex = band.startIdx + i;
        const weekNum = parseWeekKey(weeks[weekIndex])?.week || 0;
        timelineSlots.push({
          type: "week",
          year: yearLabel,
          weekKey: weeks[weekIndex],
          weekIdx: weekIndex,
          isYearStart: i === 0,
          isQsStart: qsStartWeeks.has(weekNum),
        });
      }
    }

    yearHeaderBands.push({
      year: yearLabel,
      startSlotIdx,
      count: timelineSlots.length - startSlotIdx,
      isCollapsed: isYearCollapsed,
    });
  });

  if (hasFutureItems) {
    timelineSlots.push({ type: "future", year: "Future", isYearStart: true });
  }

  yearHeaderBands.forEach((band) => {
    const qsOffsets = [];
    for (let i = 0; i < band.count; i += 1) {
      const slot = timelineSlots[band.startSlotIdx + i];
      if (slot?.type === "week" && slot.isQsStart) qsOffsets.push(i);
    }
    band.qsOffsets = qsOffsets;
  });

  const timelineCols = timelineSlots.length;

  const byCapability = new Map();
  items.forEach(it => {
    if (!byCapability.has(it.capability)) byCapability.set(it.capability, []);
    byCapability.get(it.capability).push(it);
  });

  if (!hasSavedCollapseState) {
    roadmapCollapsedCapabilities = new Set(Array.from(byCapability.keys()));
    persistRoadmapCollapseState();
  }

  const slotWidthValues = timelineSlots.map((slot) => {
    if (slot.type === "future") return 56;
    if (slot.type === "year") return 28;
    return 18;
  });
  const slotWidths = slotWidthValues.map(v => `${v}px`).join(" ");
  const timelineWidthPx = slotWidthValues.reduce((sum, v) => sum + v, 0);

  const hostWidth = host.clientWidth || window.innerWidth;
  const horizontalPadding = 24;
  const availableForFeature = hostWidth - timelineWidthPx - horizontalPadding;
  const featureColWidth = Math.max(220, Math.floor(availableForFeature));

  let html = '<div class="roadmap-scroll-top" id="roadmap-scroll-top"><div class="roadmap-scroll-spacer" id="roadmap-scroll-spacer"></div></div>';
  html += `<div class="roadmap-scroll roadmap-scroll-main" id="roadmap-scroll-main"><div class="roadmap-grid" style="grid-template-columns: ${featureColWidth}px ${slotWidths};">`;
  html += '<div class="roadmap-header roadmap-feature-col roadmap-feature-head">Feature</div>';
  yearHeaderBands.forEach((band) => {
    const yearAttr = encodeURIComponent(band.year);
    const collapseMarker = band.isCollapsed ? "▶" : "▼";
    html += `<div class="roadmap-header roadmap-year-header roadmap-year-toggle" data-year="${yearAttr}" style="grid-column: ${band.startSlotIdx + 2} / span ${band.count}; grid-row: 1;"><span class="roadmap-year-arrow">${collapseMarker}</span><span class="roadmap-year-text">${escapeHtml(band.year)}</span></div>`;
  });
  yearHeaderBands.forEach((band) => {
    const yy = String(band.year).slice(-2);
    const slotStartCol = band.startSlotIdx + 2;

    if (band.isCollapsed) {
      html += `<div class="roadmap-header roadmap-qs-header roadmap-year-sep" style="grid-column: ${slotStartCol} / span ${band.count}; grid-row: 2;">${escapeHtml(`${yy}QS`)}</div>`;
      return;
    }

    const weekSlots = [];
    for (let i = 0; i < band.count; i += 1) {
      const slotIdx = band.startSlotIdx + i;
      const slot = timelineSlots[slotIdx];
      if (slot?.type === "week") {
        weekSlots.push({ slotIdx, week: parseWeekKey(slot.weekKey)?.week || 0 });
      }
    }

    const qsStarts = [10, 22, 37, 49].map((w) => {
      const found = weekSlots.find(s => s.week === w);
      return found ? { week: w, slotIdx: found.slotIdx } : null;
    }).filter(Boolean);

    if (!qsStarts.length) {
      html += `<div class="roadmap-header roadmap-qs-header roadmap-year-sep" style="grid-column: ${slotStartCol} / span ${band.count}; grid-row: 2;"></div>`;
      return;
    }

    const firstQsSlot = qsStarts[0].slotIdx;
    if (firstQsSlot > band.startSlotIdx) {
      const prevYearYY = String(Number(band.year) - 1).slice(-2);
      const leadingLabel = `${prevYearYY}QS49`;
      html += `<div class="roadmap-header roadmap-qs-header roadmap-qs-band roadmap-year-sep" style="grid-column: ${band.startSlotIdx + 2} / span ${firstQsSlot - band.startSlotIdx}; grid-row: 2;">${escapeHtml(leadingLabel)}</div>`;
    }

    for (let i = 0; i < qsStarts.length; i += 1) {
      const start = qsStarts[i];
      const next = qsStarts[i + 1];
      const endSlot = next ? (next.slotIdx - 1) : (band.startSlotIdx + band.count - 1);
      const span = Math.max(1, endSlot - start.slotIdx + 1);
      const label = `${yy}QS${String(start.week).padStart(2, "0")}`;
      const sepClass = start.slotIdx === band.startSlotIdx ? " roadmap-year-sep" : "";
      html += `<div class="roadmap-header roadmap-qs-header roadmap-qs-band${sepClass}" style="grid-column: ${start.slotIdx + 2} / span ${span}; grid-row: 2;">${escapeHtml(label)}</div>`;
    }
  });

  timelineSlots.forEach((slot, slotIdx) => {
    const gridCol = slotIdx + 2;
    if (slot.type === "future") {
      html += `<div class="roadmap-header roadmap-future-header" style="grid-column: ${gridCol}; grid-row: span 3;">Future</div>`;
      return;
    }

    if (slot.type === "year") {
      html += `<div class="roadmap-header roadmap-week-header roadmap-year-collapsed-cell ${slot.isYearStart ? "roadmap-year-sep" : ""}" style="grid-column: ${gridCol}; grid-row: 3;">…</div>`;
      return;
    }

    const wk = parseWeekKey(slot.weekKey)?.week;
    const wkLabel = wk ? String(wk).padStart(2, "0") : slot.weekKey;
    const qsClass = slot.isQsStart ? " roadmap-qs-sep" : "";
    html += `<div class="roadmap-header roadmap-week-header ${slot.isYearStart ? "roadmap-year-sep" : ""}${qsClass}" style="grid-column: ${gridCol}; grid-row: 3;">${escapeHtml(wkLabel)}</div>`;
  });

  Array.from(byCapability.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([capability, capItems]) => {
      const isCollapsed = roadmapCollapsedCapabilities.has(capability);
      const capabilityAttr = encodeURIComponent(capability);
      const arrow = isCollapsed ? "▶" : "▼";
      html += `<div class="roadmap-capability roadmap-capability-toggle" data-capability="${capabilityAttr}" style="grid-column: 1 / span ${timelineCols + 1};"><span class="roadmap-capability-arrow">${arrow}</span><span>${escapeHtml(capability)}</span><span class="roadmap-capability-count">(${capItems.length})</span></div>`;

      capItems.sort((a, b) => a.startKey.localeCompare(b.startKey) || a.featureId.localeCompare(b.featureId));

      if (isCollapsed) {
        const activeSlots = Array(timelineCols).fill(false);
        capItems.forEach(item => {
          const startWeek = item.isFuture ? -1 : (weekIdx.get(item.startKey) ?? -1);
          const endWeek = item.isFuture ? -1 : (weekIdx.get(item.endKey) ?? startWeek);
          timelineSlots.forEach((slot, slotIdx) => {
            if (item.isFuture) {
              if (slot.type === "future") activeSlots[slotIdx] = true;
              return;
            }
            if (slot.type === "week") {
              if (slot.weekIdx >= startWeek && slot.weekIdx <= endWeek) activeSlots[slotIdx] = true;
              return;
            }
            if (slot.type === "year") {
              const overlap = !(endWeek < slot.startWeekIdx || startWeek > slot.endWeekIdx);
              if (overlap) activeSlots[slotIdx] = true;
            }
          });
        });

        html += `<div class="roadmap-feature-col roadmap-capability-summary" title="${escapeHtml(capability)} collapsed summary">${capItems.length} features</div>`;
        let idx = 0;
        while (idx < timelineCols) {
          if (!activeSlots[idx]) {
            const sepClass = timelineSlots[idx]?.isYearStart ? " roadmap-year-sep" : "";
            const qsClass = timelineSlots[idx]?.isQsStart ? " roadmap-qs-sep" : "";
            html += `<div class="roadmap-cell roadmap-summary-cell${sepClass}${qsClass}"></div>`;
            idx += 1;
            continue;
          }
          let endIdx = idx;
          while (endIdx + 1 < timelineCols && activeSlots[endIdx + 1]) endIdx += 1;
          const span = endIdx - idx + 1;
          const sepClass = timelineSlots[idx]?.isYearStart ? " roadmap-year-sep" : "";
          const qsClass = timelineSlots[idx]?.isQsStart ? " roadmap-qs-sep" : "";
          html += `<div class="roadmap-bar roadmap-capability-bar${sepClass}${qsClass}" style="grid-column: ${idx + 2} / span ${span};"></div>`;
          idx = endIdx + 1;
        }
        return;
      }

      capItems.forEach(item => {
        const startWeek = item.isFuture ? -1 : (weekIdx.get(item.startKey) ?? -1);
        const endWeek = item.isFuture ? -1 : (weekIdx.get(item.endKey) ?? startWeek);

        const activeSlots = timelineSlots.map((slot) => {
          if (item.isFuture) return slot.type === "future";
          if (slot.type === "future") return false;
          if (slot.type === "week") return slot.weekIdx >= startWeek && slot.weekIdx <= endWeek;
          return !(endWeek < slot.startWeekIdx || startWeek > slot.endWeekIdx);
        });

        const label = `${item.featureId} — ${item.feature?.summary || ""}`;
        html += `<div class="roadmap-feature-col" title="${escapeHtml(label)}"><a href="https://jira-vira.volvocars.biz/browse/${encodeURIComponent(item.featureId)}" target="_blank">${escapeHtml(item.featureId)}</a> ${escapeHtml(item.feature?.summary || "")}</div>`;
        let idx = 0;
        while (idx < timelineCols) {
          if (!activeSlots[idx]) {
            const sepClass = timelineSlots[idx]?.isYearStart ? " roadmap-year-sep" : "";
            const qsClass = timelineSlots[idx]?.isQsStart ? " roadmap-qs-sep" : "";
            html += `<div class="roadmap-cell${sepClass}${qsClass}"></div>`;
            idx += 1;
            continue;
          }
          let endIdx = idx;
          while (endIdx + 1 < timelineCols && activeSlots[endIdx + 1]) endIdx += 1;
          const span = endIdx - idx + 1;
          const titleText = item.isFuture
            ? "Future"
            : `${item.periodLabel || "QS"}: ${item.startKey} → ${item.endKey}`;
          const sepClass = timelineSlots[idx]?.isYearStart ? " roadmap-year-sep" : "";
          const qsClass = timelineSlots[idx]?.isQsStart ? " roadmap-qs-sep" : "";
          html += `<div class="roadmap-bar${sepClass}${qsClass}" style="grid-column: ${idx + 2} / span ${span};" title="${escapeHtml(titleText)}"></div>`;
          idx = endIdx + 1;
        }
      });
    });

  html += '</div></div>';
  host.innerHTML = html;

  const topScroll = host.querySelector("#roadmap-scroll-top");
  const mainScroll = host.querySelector("#roadmap-scroll-main");
  const spacer = host.querySelector("#roadmap-scroll-spacer");
  const grid = host.querySelector(".roadmap-grid");

  if (topScroll && mainScroll && spacer && grid) {
    spacer.style.width = `${grid.scrollWidth}px`;

    let syncing = false;
    topScroll.addEventListener("scroll", () => {
      if (syncing) return;
      syncing = true;
      mainScroll.scrollLeft = topScroll.scrollLeft;
      syncing = false;
    });

    mainScroll.addEventListener("scroll", () => {
      if (syncing) return;
      syncing = true;
      topScroll.scrollLeft = mainScroll.scrollLeft;
      syncing = false;
    });
  }

  if (!host._resizeBound) {
    host._resizeBound = true;
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        renderBacklogRoadmap(host._roadmapData || {});
      }, 120);
    });
  }

  host.querySelectorAll(".roadmap-capability-toggle").forEach((el) => {
    el.addEventListener("click", () => {
      const encoded = el.getAttribute("data-capability") || "";
      const capability = encoded ? decodeURIComponent(encoded) : "";
      if (!capability) return;
      if (roadmapCollapsedCapabilities.has(capability)) roadmapCollapsedCapabilities.delete(capability);
      else roadmapCollapsedCapabilities.add(capability);
      persistRoadmapCollapseState();
      renderBacklogRoadmap(host._roadmapData || {});
    });
  });

  host.querySelectorAll(".roadmap-year-toggle").forEach((el) => {
    el.addEventListener("click", () => {
      const encoded = el.getAttribute("data-year") || "";
      const year = encoded ? decodeURIComponent(encoded) : "";
      if (!year) return;
      if (roadmapCollapsedYears.has(year)) roadmapCollapsedYears.delete(year);
      else roadmapCollapsedYears.add(year);
      persistRoadmapYearCollapseState();
      renderBacklogRoadmap(host._roadmapData || {});
    });
  });
}

async function loadBacklogData(forceRefresh = false) {
  showLoading();
  try {
    const workGroup = getSelectedWorkGroup();
    if (!workGroup) return;

    const url = `/backlog_data?workGroup=${encodeURIComponent(workGroup)}${forceRefresh ? "&forceRefresh=1" : ""}`;
    const cacheKey = makeCacheKey("backlogData", { workGroup });
    const data = await fetchJsonWithClientCache(url, cacheKey, forceRefresh);

    renderBacklogRoadmap(data);
    populateBacklogStatusFilter(data);

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
    const rowStatus = (feature.status || "").replace(/"/g, '&quot;');
    tableHtml += `<tr data-status="${rowStatus}">`;
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
  renumberVisibleRows(container.querySelector("table"));

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
async function fetchData(forceRefresh = false) {
  const version = getSelectedFixVersion();
  const workGroup = getSelectedWorkGroup();
  const url = `/stats?fixVersion=${version}&workGroup=${encodeURIComponent(workGroup)}${forceRefresh ? "&forceRefresh=1" : ""}`;
  const cacheKey = makeCacheKey("dashboardStats", { version, workGroup });
  return await fetchJsonWithClientCache(url, cacheKey, forceRefresh);
}
async function fetchIssues(forceRefresh = false) {
  const version = getSelectedFixVersion();
  const workGroup = getSelectedWorkGroup();
  const url = `/issue_data?fixVersion=${version}&workGroup=${encodeURIComponent(workGroup)}${forceRefresh ? "&forceRefresh=1" : ""}`;
  const cacheKey = makeCacheKey("dashboardIssues", { version, workGroup });
  return await fetchJsonWithClientCache(url, cacheKey, forceRefresh);
}
async function renderChart(forceRefresh = false) {
  const stats = await fetchData(forceRefresh);
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
async function renderTable(forceRefresh = false) {
  const issues = await fetchIssues(forceRefresh);
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

function saveBacklogStatusSetting() {
  localStorage.setItem("backlogStatus", JSON.stringify(Array.from(backlogSelectedStatuses)));
}

function getSavedBacklogStatuses() {
  const raw = localStorage.getItem("backlogStatus");
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(Boolean) : [];
  } catch {
    return raw ? [raw] : [];
  }
}

function updateBacklogStatusDropdownLabel(totalStatuses) {
  const toggle = document.getElementById("statusFilterToggle");
  if (!toggle) return;
  const selectedCount = backlogSelectedStatuses.size;

  if (totalStatuses === 0) {
    toggle.textContent = "Statuses";
    return;
  }

  if (selectedCount >= totalStatuses) {
    toggle.textContent = `Statuses: All (${totalStatuses})`;
    return;
  }

  toggle.textContent = `Statuses: ${selectedCount}/${totalStatuses}`;
}

function getBacklogStatusMenuValues() {
  const menu = document.getElementById("statusFilterMenu");
  if (!menu) return [];
  return Array.from(menu.querySelectorAll('.backlog-status-option input[type="checkbox"][value]'))
    .map(cb => (cb.value || "").trim())
    .filter(Boolean);
}

function setupBacklogStatusDropdown() {
  const toggle = document.getElementById("statusFilterToggle");
  const menu = document.getElementById("statusFilterMenu");
  if (!toggle || !menu || toggle.dataset.bound === "1") return;

  toggle.dataset.bound = "1";
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("open");
  });

  document.addEventListener("click", (e) => {
    if (!menu.classList.contains("open")) return;
    if (menu.contains(e.target) || toggle.contains(e.target)) return;
    menu.classList.remove("open");
  });
}

function populateBacklogStatusFilter(data) {
  const menu = document.getElementById("statusFilterMenu");
  if (!menu) return;

  const statuses = Array.from(new Set(
    Object.values(data || {})
      .map(feature => (feature?.status || "").trim())
      .filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));

  menu.innerHTML = '';

  const saved = getSavedBacklogStatuses();
  const previousSelection = backlogSelectedStatuses.size ? Array.from(backlogSelectedStatuses) : [];
  const baseSelection = previousSelection.length ? previousSelection : saved;
  const wantedSet = new Set(baseSelection.filter(s => statuses.includes(s)));

  if (!baseSelection.length) {
    statuses.forEach(s => wantedSet.add(s));
  }

  if (baseSelection.length && wantedSet.size === 0 && statuses.length) {
    statuses.forEach(s => wantedSet.add(s));
  }

  backlogSelectedStatuses = wantedSet;

  const allRow = document.createElement("label");
  allRow.className = "backlog-status-option all";
  const allCheckbox = document.createElement("input");
  allCheckbox.type = "checkbox";
  allCheckbox.checked = statuses.length > 0 && backlogSelectedStatuses.size === statuses.length;
  const allText = document.createElement("span");
  allText.textContent = "Select all";
  allRow.appendChild(allCheckbox);
  allRow.appendChild(allText);
  menu.appendChild(allRow);

  statuses.forEach(status => {
    const row = document.createElement("label");
    row.className = "backlog-status-option";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = status;
    checkbox.checked = wantedSet.has(status);

    const text = document.createElement("span");
    text.textContent = status;

    checkbox.addEventListener("change", () => {
      if (checkbox.checked) backlogSelectedStatuses.add(status);
      else backlogSelectedStatuses.delete(status);

      allCheckbox.checked = backlogSelectedStatuses.size === statuses.length;
      saveBacklogStatusSetting();
      updateBacklogStatusDropdownLabel(statuses.length);
      applyFilter();
    });

    row.appendChild(checkbox);
    row.appendChild(text);
    menu.appendChild(row);
  });

  allCheckbox.addEventListener("change", () => {
    backlogSelectedStatuses = allCheckbox.checked ? new Set(statuses) : new Set();
    menu.querySelectorAll('.backlog-status-option input[type="checkbox"]').forEach((cb) => {
      if (cb !== allCheckbox) cb.checked = allCheckbox.checked;
    });
    saveBacklogStatusSetting();
    updateBacklogStatusDropdownLabel(statuses.length);
    applyFilter();
  });

  updateBacklogStatusDropdownLabel(statuses.length);
  saveBacklogStatusSetting();

  if (!wantedSet.size && saved.length) {
    localStorage.setItem("backlogStatus", JSON.stringify(statuses));
  }
}

/* ===============
   Page bootstrap
   =============== */
document.addEventListener("DOMContentLoaded", () => {
  const isDashboard = document.getElementById("statsChart") && document.getElementById("issueTable");
  const isPlanning  = !!document.getElementById("committed-table");
  const isBacklog   = !!document.getElementById("backlog-table") && !document.getElementById("committed-table");
  const isRoadmap   = !!document.getElementById("backlog-roadmap") && !document.getElementById("backlog-table");
  const isProjectFR = !!document.getElementById("project-fr-table");

  if (isDashboard) {
    restoreDashboardSettings();
    renderChart(); renderTable();
    document.getElementById("refresh")?.addEventListener("click", () => { renderChart(true); renderTable(true); });
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
    document.getElementById("planning-refresh")?.addEventListener("click", () => {
      loadPIPlanningData(true);
    });
  }

  if (isBacklog) {
    restoreBacklogSettings();
    setupBacklogStatusDropdown();
    loadBacklogData();
    document.getElementById("workGroupSelect")?.addEventListener("change", () => { saveBacklogSettings(); loadBacklogData(); });
    document.getElementById("globalFilter")?.addEventListener("input", applyFilter);
    document.getElementById("export-backlog-excel")?.addEventListener("click", function () {
      const wg = getSelectedWorkGroup();
      const textFilter = (document.getElementById("globalFilter")?.value || "").trim();
      const params = new URLSearchParams();
      params.set("workGroup", wg || "");
      if (textFilter) params.set("q", textFilter);

      const allStatuses = getBacklogStatusMenuValues();
      const selectedStatuses = Array.from(backlogSelectedStatuses).filter(Boolean);
      const allSelected = allStatuses.length > 0 && selectedStatuses.length === allStatuses.length;

      if (!allSelected) {
        selectedStatuses.forEach(status => params.append("status", status));
      }

      window.location.href = `/export_backlog_excel?${params.toString()}`;
    });
    document.getElementById("backlog-refresh")?.addEventListener("click", () => {
      loadBacklogData(true);
    });
  }

  if (isRoadmap) {
    restoreBacklogSettings();
    loadBacklogData();
    document.getElementById("workGroupSelect")?.addEventListener("change", () => {
      saveBacklogSettings();
      loadBacklogData();
    });
    document.getElementById("roadmap-refresh")?.addEventListener("click", () => {
      loadBacklogData(true);
    });
  }

  if (isProjectFR) {
    window._projectFrCache = [];
    restoreProjectFrState();
    document.getElementById("search-btn")?.addEventListener("click", loadProjectFaultReports);
    document.getElementById("project-fr-refresh")?.addEventListener("click", () => loadProjectFaultReports(true));
    document.getElementById("keywordsInput")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        loadProjectFaultReports();
      }
    });
    document.getElementById("jiraIdFilterInput")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        loadProjectFaultReports();
      }
    });
    loadProjectFaultReports();
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
  const now = Date.now();
  const last = Number(localStorage.getItem("user_track_last_sent") || 0);
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (last && (now - last) < oneDayMs) {
    return Promise.resolve({ skipped: true });
  }
  return fetch('/track_user', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: getOrCreateUserId() })
  }).then((res) => {
    localStorage.setItem("user_track_last_sent", String(now));
    return res;
  });
}
async function showUniqueUserCount() {
  try {
    const cacheKey = makeCacheKey("uniqueUsers", {});
    const cachedRaw = localStorage.getItem(cacheKey);
    const cacheTtlMs = 5 * 60 * 1000;
    if (cachedRaw) {
      const parsed = JSON.parse(cachedRaw);
      if (parsed && parsed.ts && (Date.now() - Number(parsed.ts) < cacheTtlMs)) {
        const el = document.getElementById('unique-users-count');
        if (el) el.textContent = `Unique users: ${Number(parsed.data?.unique_users) || 0}`;
        return;
      }
    }

    const res = await fetch('/unique_users', { cache: 'no-store' });
    const data = await res.json();
    writeClientCache(cacheKey, data);
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

/* =========================
   Project Fault Reports
   ========================= */
let statusFilterSet = new Set();
let allStatusSet = new Set();
let jiraIdPrefixes = [];
let savedKeywords = "";

function setStatusFilters(statuses) {
  statusFilterSet = new Set(statuses || []);
}
function getStatusFilters() {
  return statusFilterSet;
}
function getAllStatuses() {
  return allStatusSet;
}
function getJiraPrefixes() {
  return jiraIdPrefixes;
}

function parseList(raw) {
  if (!raw) return [];
  return raw
    .split(/[,\n;]/)
    .map(s => s.trim())
    .filter(Boolean);
}

function persistProjectFrState({ keywords, jiraPrefixes, statuses }) {
  const payload = {
    keywords: keywords || "",
    jiraPrefixes: Array.isArray(jiraPrefixes) ? jiraPrefixes : [],
    statuses: Array.from(statuses || []),
  };
  localStorage.setItem("projectFrState", JSON.stringify(payload));
}
function restoreProjectFrState() {
  try {
    const raw = localStorage.getItem("projectFrState");
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (typeof parsed.keywords === "string") {
      const el = document.getElementById("keywordsInput");
      if (el) el.value = parsed.keywords;
      savedKeywords = parsed.keywords;
    }
    if (Array.isArray(parsed.jiraPrefixes)) {
      jiraIdPrefixes = parsed.jiraPrefixes;
      const el = document.getElementById("jiraIdFilterInput");
      if (el) el.value = parsed.jiraPrefixes.join(", ");
    }
    if (Array.isArray(parsed.statuses)) {
      setStatusFilters(parsed.statuses);
    }
  } catch (e) {
    console.warn("Failed to restore project FR state", e);
  }
}

async function loadProjectFaultReports(forceRefresh = false) {
  const wg = getSelectedWorkGroup();
  const keywordsRaw = document.getElementById("keywordsInput")?.value || "";
  const jiraPrefixRaw = document.getElementById("jiraIdFilterInput")?.value || "";
  const tbody = document.querySelector("#project-fr-table tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const keywordsList = parseList(keywordsRaw);
  const prefixList = parseList(jiraPrefixRaw);

  if (!keywordsList.length && !prefixList.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#888;">Enter keywords or Jira ID prefix and click Search</td></tr>';
    return;
  }

  const params = [];
  if (keywordsList.length) params.push(`keywords=${encodeURIComponent(keywordsList.join(","))}`);
  if (wg) params.push(`workGroup=${encodeURIComponent(wg)}`);
  if (forceRefresh) params.push("forceRefresh=1");
  const url = `/project_fault_reports_data${params.length ? "?" + params.join("&") : ""}`;
  const cacheKey = makeCacheKey("projectFaultReports", {
    keywords: keywordsList.join(","),
    workGroup: wg || "",
  });
  const data = await fetchJsonWithClientCache(url, cacheKey, forceRefresh);

  window._projectFrCache = Array.isArray(data) ? data : [];
  jiraIdPrefixes = prefixList;
  buildStatusChips(window._projectFrCache);
  persistProjectFrState({ keywords: keywordsRaw, jiraPrefixes: prefixList, statuses: getStatusFilters() });
  renderProjectFrTable();
}

function renderProjectFrTable() {
  const tbody = document.querySelector("#project-fr-table tbody");
  if (!tbody) return;
  const allowed = getStatusFilters();
  const all = getAllStatuses();
  const hasFilter = allowed.size > 0 && allowed.size < all.size;
  const prefixes = getJiraPrefixes().map(p => p.toLowerCase());
  const rows = (window._projectFrCache || []).filter(item => {
    const st = (item.status || "").trim();
    if (hasFilter && !allowed.has(st)) return false;
    if (prefixes.length) {
      const key = (item.key || "").toLowerCase();
      const match = prefixes.some(p => key.startsWith(p.toLowerCase()));
      if (!match) return false;
    }
    return true;
  });

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#888;">No results</td></tr>';
    return;
  }

  tbody.innerHTML = "";
  let idx = 1;
  rows.forEach(item => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="col-rownum">${idx++}</td>
      <td class="col-feature-id"><a href="https://jira-vira.volvocars.biz/browse/${item.key}" target="_blank">${item.key}</a></td>
      <td class="col-feature-name">${item.summary || ""}</td>
      <td class="col-status">${item.status || ""}</td>
      <td>${Array.isArray(item.fixVersions) ? item.fixVersions.join(", ") : ""}</td>
      <td>${Array.isArray(item.labels) ? item.labels.join(", ") : ""}</td>
    `;
    tbody.appendChild(tr);
  });
}

function toggleStatusChip(e) {
  const chip = e.currentTarget;
  const val = chip?.dataset?.value || "";
  if (!val) return;
  const current = getStatusFilters();
  if (current.has(val)) current.delete(val); else current.add(val);
  chip.classList.toggle("active", current.has(val));
  setStatusFilters(current);
  persistProjectFrState({
    keywords: document.getElementById("keywordsInput")?.value || "",
    jiraPrefixes: parseList(document.getElementById("jiraIdFilterInput")?.value || ""),
    statuses: current,
  });
  renderProjectFrTable();
}

function buildStatusChips(data) {
  const host = document.getElementById("status-filters");
  if (!host) return;
  const statuses = new Set();
  (Array.isArray(data) ? data : []).forEach(item => {
    const st = (item.status || "").trim();
    if (st) statuses.add(st);
  });
  // Ensure known statuses are present even if absent in current payload
  ["Deployment"].forEach(s => statuses.add(s));
  allStatusSet = new Set(statuses);

  const restored = getStatusFilters();
  let nextActive = new Set(restored);
  if (!nextActive.size) {
    const defaultsOff = new Set(["closed","verification","in progress","pre-verification"]);
    nextActive = new Set(Array.from(statuses).filter(s => !defaultsOff.has(s.toLowerCase())));
  }
  // Keep only statuses that exist now; if none remain, enable all
  nextActive = new Set(Array.from(nextActive).filter(s => statuses.has(s)));
  if (!nextActive.size) nextActive = new Set(statuses);
  setStatusFilters(nextActive);

  host.innerHTML = "";
  const sorted = Array.from(statuses).sort((a,b)=>a.localeCompare(b));
  sorted.forEach(st => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "status-chip" + (getStatusFilters().has(st) ? " active" : "");
    chip.textContent = st;
    chip.dataset.value = st;
    chip.addEventListener("click", toggleStatusChip);
    host.appendChild(chip);
  });
}
