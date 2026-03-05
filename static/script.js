/* =========================
   PI Planning / Dashboard JS
   ========================= */

let currentSortOrder = 'asc';
const CLIENT_CACHE_PREFIX = "jiraStatCache::v2::";
let roadmapCollapsedCapabilities = new Set();
let roadmapCollapsedYears = new Set();
let roadmapPendingMovesByWorkGroup = new Map();
let roadmapTeammatesByScope = new Map();
let appSettingsCache = null;
let committedCollapsedCapabilities = new Set();
let committedCollapsedFeatures = new Set();
const BACKLOG_SELECT_FILTER_KEYS = new Set(["assignee", "reporter", "status", "piscope", "fixversions"]);
let backlogColumnFilterMenusBound = false;

function backlogFilterTitleByKey(key) {
  const titles = {
    assignee: "Assignee",
    reporter: "Reporter",
    status: "Status",
    piscope: "PI Scope",
    fixversions: "Fix Version",
  };
  return titles[String(key || "").trim()] || "Filter";
}

function backlogFilterButtonText(key, selectedValues, totalCount) {
  const selected = Array.isArray(selectedValues) ? selectedValues.filter(Boolean) : [];
  const safeTotal = Number.isFinite(Number(totalCount)) ? Number(totalCount) : 0;
  const count = selected.length;
  return String(Math.max(0, Math.min(count, Math.max(safeTotal, count))));
}

function resetBacklogColumnFilters() {
  setBacklogColumnFilterState({});
  window._rerenderFeatureTable('backlog-table', []);
  applyFilter();
}

function committedCapabilityCollapseStorageKey() {
  return `committedCollapsedCapabilities::${getSelectedWorkGroup() || ""}::${getSelectedFixVersion() || ""}`;
}

function committedFeatureCollapseStorageKey() {
  return `committedCollapsedFeatures::${getSelectedWorkGroup() || ""}::${getSelectedFixVersion() || ""}`;
}

function restoreCommittedTreeCollapseState() {
  try {
    const rawCaps = localStorage.getItem(committedCapabilityCollapseStorageKey());
    const rawFeatures = localStorage.getItem(committedFeatureCollapseStorageKey());
    const capArr = rawCaps ? JSON.parse(rawCaps) : [];
    const featureArr = rawFeatures ? JSON.parse(rawFeatures) : [];
    committedCollapsedCapabilities = new Set(Array.isArray(capArr) ? capArr.map(String) : []);
    committedCollapsedFeatures = new Set(Array.isArray(featureArr) ? featureArr.map(String) : []);
  } catch {
    committedCollapsedCapabilities = new Set();
    committedCollapsedFeatures = new Set();
  }
}

function persistCommittedTreeCollapseState() {
  try {
    localStorage.setItem(
      committedCapabilityCollapseStorageKey(),
      JSON.stringify(Array.from(committedCollapsedCapabilities))
    );
    localStorage.setItem(
      committedFeatureCollapseStorageKey(),
      JSON.stringify(Array.from(committedCollapsedFeatures))
    );
  } catch {
    // ignore storage issues
  }
}

function updateCommittedCapabilityRowVisibility(table) {
  if (!(table instanceof HTMLTableElement) || !table.closest('#committed-table')) return;
  const rows = Array.from(table.querySelectorAll('tbody tr'));
  rows.forEach((row, index) => {
    if (String(row.getAttribute('data-row-kind') || '') !== 'capability') return;
    const capId = String(row.getAttribute('data-capability-id') || '').trim();
    if (capId && committedCollapsedCapabilities.has(capId)) {
      row.style.display = '';
      return;
    }
    let hasVisibleFeature = false;
    for (let i = index + 1; i < rows.length; i += 1) {
      const next = rows[i];
      const nextKind = String(next.getAttribute('data-row-kind') || '');
      if (nextKind === 'capability') break;
      if (nextKind !== 'feature') continue;
      if (next.style.display !== 'none') {
        hasVisibleFeature = true;
        break;
      }
    }
    row.style.display = hasVisibleFeature ? '' : 'none';
  });
}

function applyCommittedTreeVisibility(table) {
  if (!(table instanceof HTMLTableElement) || !table.closest('#committed-table')) return;
  const rows = Array.from(table.querySelectorAll('tbody tr'));
  let currentCapabilityCollapsed = false;
  let currentFeatureCollapsed = false;
  let currentFeatureVisible = false;

  rows.forEach((row) => {
    const rowKind = String(row.getAttribute('data-row-kind') || '');
    if (rowKind === 'capability') {
      const capId = String(row.getAttribute('data-capability-id') || '');
      currentCapabilityCollapsed = !!capId && committedCollapsedCapabilities.has(capId);
      currentFeatureCollapsed = false;
      currentFeatureVisible = false;
      const arrow = row.querySelector('.committed-cap-toggle');
      if (arrow) arrow.textContent = currentCapabilityCollapsed ? '▶' : '▼';
      return;
    }

    if (rowKind === 'feature') {
      const featureId = String(row.getAttribute('data-feature-id') || '');
      currentFeatureCollapsed = !!featureId && committedCollapsedFeatures.has(featureId);
      const arrow = row.querySelector('.committed-feature-toggle');
      if (arrow) arrow.textContent = currentFeatureCollapsed ? '▶' : '▼';

      const hiddenByFilter = row.style.display === 'none';
      if (currentCapabilityCollapsed || hiddenByFilter) {
        row.style.display = 'none';
        currentFeatureVisible = false;
      } else {
        row.style.display = '';
        currentFeatureVisible = true;
      }
      return;
    }

    if (rowKind === 'story') {
      const shouldHide = currentCapabilityCollapsed || !currentFeatureVisible || currentFeatureCollapsed;
      row.style.display = shouldHide ? 'none' : '';
    }
  });

  updateCommittedCapabilityRowVisibility(table);
}

function backlogColumnFilterStorageKey() {
  return `backlogColumnFilters::${getSelectedWorkGroup() || ""}`;
}

function getBacklogColumnFilterState() {
  try {
    const raw = localStorage.getItem(backlogColumnFilterStorageKey());
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!(parsed && typeof parsed === "object")) return {};
    const out = {};
    Object.entries(parsed).forEach(([key, value]) => {
      const safeKey = String(key || "").trim();
      if (!BACKLOG_SELECT_FILTER_KEYS.has(safeKey)) return;
      const list = Array.isArray(value)
        ? value
        : (String(value || "").trim() ? [String(value || "").trim()] : []);
      const normalized = Array.from(new Set(
        list.map((entry) => String(entry || "").trim()).filter(Boolean)
      ));
      if (!normalized.length) return;
      out[safeKey] = normalized;
    });
    return out;
  } catch {
    return {};
  }
}

function setBacklogColumnFilterState(state) {
  try {
    localStorage.setItem(backlogColumnFilterStorageKey(), JSON.stringify(state || {}));
  } catch {
    // ignore
  }
}

function getBacklogVisibleColumnKeys(table) {
  if (!(table instanceof HTMLTableElement)) return [];
  try {
    const raw = table.dataset.visibleColumnKeys || "[]";
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((x) => String(x || "")) : [];
  } catch {
    return [];
  }
}

function getBacklogColumnFiltersForTable(table) {
  const out = {};
  if (!(table instanceof HTMLTableElement)) return out;
  table.querySelectorAll('thead .backlog-col-filter-dropdown[data-filter-key]').forEach((dropdown) => {
    const key = String(dropdown.getAttribute('data-filter-key') || '').trim();
    if (!key) return;
    const values = Array.from(dropdown.querySelectorAll('.backlog-col-filter-option input[type="checkbox"][value]:checked'))
      .map((cb) => String(cb.value || '').trim().toLowerCase())
      .filter(Boolean);
    if (values.length) out[key] = values;
  });
  return out;
}

function bindBacklogColumnFilters(table) {
  if (!(table instanceof HTMLTableElement)) return;

  const positionBacklogFilterMenu = (dropdown, menu) => {
    const btn = dropdown.querySelector('.backlog-col-filter-btn');
    if (!(btn instanceof HTMLElement)) return;
    const rect = btn.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const menuWidth = Math.max(menuRect.width || 220, 180);
    const menuHeight = Math.max(menuRect.height || 120, 80);

    const left = Math.min(
      Math.max(8, rect.left),
      Math.max(8, window.innerWidth - menuWidth - 8)
    );

    const belowTop = rect.bottom + 4;
    const aboveTop = rect.top - menuHeight - 4;
    const top = (belowTop + menuHeight <= window.innerHeight - 8)
      ? belowTop
      : Math.max(8, aboveTop);

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.zIndex = '100000';
  };

  const closeAllBacklogFilterMenus = () => {
    table.querySelectorAll('.backlog-col-filter-dropdown').forEach((dropdown) => {
      dropdown.classList.remove('open');
      const th = dropdown.closest('th');
      if (th) th.classList.remove('backlog-filter-open');
    });
    document.querySelectorAll('.backlog-col-filter-menu.open').forEach((menu) => {
      menu.classList.remove('open');
      if (menu instanceof HTMLElement) {
        menu.style.left = '';
        menu.style.top = '';
        menu.style.zIndex = '';
      }
    });
  };

  if (!backlogColumnFilterMenusBound) {
    backlogColumnFilterMenusBound = true;
    document.addEventListener('click', (ev) => {
      const target = ev.target;
      if (target instanceof Element && target.closest('.backlog-col-filter-dropdown')) return;
      document.querySelectorAll('.backlog-col-filter-dropdown.open').forEach((dropdown) => {
        dropdown.classList.remove('open');
        const th = dropdown.closest('th');
        if (th) th.classList.remove('backlog-filter-open');
      });
      document.querySelectorAll('.backlog-col-filter-menu.open').forEach((menu) => {
        menu.classList.remove('open');
        if (menu instanceof HTMLElement) {
          menu.style.left = '';
          menu.style.top = '';
          menu.style.zIndex = '';
        }
      });
    });
    document.addEventListener('scroll', () => {
      document.querySelectorAll('.backlog-col-filter-dropdown.open').forEach((dropdown) => {
        dropdown.classList.remove('open');
        const th = dropdown.closest('th');
        if (th) th.classList.remove('backlog-filter-open');
      });
      document.querySelectorAll('.backlog-col-filter-menu.open').forEach((menu) => {
        menu.classList.remove('open');
        if (menu instanceof HTMLElement) {
          menu.style.left = '';
          menu.style.top = '';
          menu.style.zIndex = '';
        }
      });
    }, true);
    window.addEventListener('resize', () => {
      document.querySelectorAll('.backlog-col-filter-dropdown.open').forEach((dropdown) => {
        dropdown.classList.remove('open');
        const th = dropdown.closest('th');
        if (th) th.classList.remove('backlog-filter-open');
      });
      document.querySelectorAll('.backlog-col-filter-menu.open').forEach((menu) => {
        menu.classList.remove('open');
        if (menu instanceof HTMLElement) {
          menu.style.left = '';
          menu.style.top = '';
          menu.style.zIndex = '';
        }
      });
    });
  }

  table.querySelectorAll('thead .backlog-col-filter-dropdown[data-filter-key]').forEach((dropdown) => {
    const key = String(dropdown.getAttribute('data-filter-key') || '').trim();
    if (!key) return;

    dropdown.addEventListener('click', (ev) => {
      ev.stopPropagation();
    });

    const toggleBtn = dropdown.querySelector('.backlog-col-filter-btn');
    const menu = dropdown.querySelector('.backlog-col-filter-menu');
    if (toggleBtn instanceof HTMLButtonElement && menu instanceof HTMLElement) {
      toggleBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const willOpen = !menu.classList.contains('open');
        closeAllBacklogFilterMenus();
        if (willOpen) {
          menu.classList.add('open');
          dropdown.classList.add('open');
          const th = dropdown.closest('th');
          if (th) th.classList.add('backlog-filter-open');
          positionBacklogFilterMenu(dropdown, menu);
        }
      });
    }

    const handler = () => {
      const state = getBacklogColumnFilterState();
      const values = Array.from(dropdown.querySelectorAll('.backlog-col-filter-option input[type="checkbox"][value]:checked'))
        .map((cb) => String(cb.value || '').trim())
        .filter(Boolean);
      if (values.length && BACKLOG_SELECT_FILTER_KEYS.has(key)) state[key] = values;
      else delete state[key];
      setBacklogColumnFilterState(state);

      const total = Number(dropdown.getAttribute('data-options-count') || 0);
      const btn = dropdown.querySelector('.backlog-col-filter-btn');
      if (btn instanceof HTMLButtonElement) {
        btn.textContent = backlogFilterButtonText(key, values, total);
      }

      applyFilter();
    };

    dropdown.querySelectorAll('.backlog-col-filter-option input[type="checkbox"][value]').forEach((cb) => {
      cb.addEventListener('change', handler);
    });

    dropdown.querySelectorAll('.backlog-col-filter-action-btn[data-action]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const action = String(btn.getAttribute('data-action') || '').trim().toLowerCase();
        const checkboxes = Array.from(dropdown.querySelectorAll('.backlog-col-filter-option input[type="checkbox"][value]'));
        if (action === 'reset') {
          checkboxes.forEach((cb) => { cb.checked = false; });
          handler();
        }
      });
    });
  });
}

function roadmapPendingMoves() {
  const workGroup = (getSelectedWorkGroup() || "").trim();
  if (!roadmapPendingMovesByWorkGroup.has(workGroup)) {
    roadmapPendingMovesByWorkGroup.set(workGroup, new Map());
  }
  return roadmapPendingMovesByWorkGroup.get(workGroup);
}

function roadmapPendingCount() {
  return roadmapPendingMoves().size;
}

function updateRoadmapPendingUi() {
  const pendingEl = document.getElementById("roadmap-pending-count");
  const pendingCount = roadmapPendingCount();
  if (pendingEl) pendingEl.textContent = `Pending changes: ${pendingCount}`;
  const pushBtn = document.getElementById("roadmap-push-jira");
  if (pushBtn) pushBtn.disabled = pendingCount === 0;
  const floating = document.getElementById("roadmap-floating-actions");
  if (floating) {
    if (pendingCount > 0) floating.classList.remove("hidden");
    else floating.classList.add("hidden");
  }
}

async function getRoadmapTeammates(forceRefresh = false) {
  const workGroup = (getSelectedWorkGroup() || "").trim();
  const fixVersion = (getSelectedFixVersion() || "").trim();
  if (!workGroup) return [];
  const cacheScopeKey = `${workGroup}|||${fixVersion}`;
  if (!forceRefresh && roadmapTeammatesByScope.has(cacheScopeKey)) {
    return roadmapTeammatesByScope.get(cacheScopeKey) || [];
  }

  try {
    const url = `/roadmap_teammates?workGroup=${encodeURIComponent(workGroup)}&fixVersion=${encodeURIComponent(fixVersion)}`;
    const resp = await fetch(url, { cache: "no-store" });
    const json = await resp.json().catch(() => ({}));
    const teammates = (resp.ok && json?.ok && Array.isArray(json?.teammates)) ? json.teammates : [];
    roadmapTeammatesByScope.set(cacheScopeKey, teammates);
    return teammates;
  } catch {
    roadmapTeammatesByScope.set(cacheScopeKey, []);
    return [];
  }
}

function hideRoadmapContextMenu() {
  const menu = document.getElementById("roadmap-context-menu");
  if (menu) {
    menu.classList.add("hidden");
    menu.innerHTML = "";
  }
}

async function showRoadmapFeatureInfo(featureId) {
  const modal = document.getElementById("roadmap-feature-modal");
  const title = document.getElementById("roadmap-feature-modal-title");
  const body = document.getElementById("roadmap-feature-modal-body");
  if (!modal || !title || !body) return;

  title.textContent = `${featureId} — Full info`;
  body.innerHTML = '<div class="roadmap-feature-loading">Loading details...</div>';
  modal.classList.remove("hidden");

  try {
    const resp = await fetch(`/feature_details?issueKey=${encodeURIComponent(featureId)}`, { cache: "no-store" });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json?.ok) {
      body.innerHTML = `<div class="roadmap-feature-error">Failed to load feature details: ${escapeHtml(json?.error || `HTTP ${resp.status}`)}</div>`;
      return;
    }

    const featureEst = Number(json.feature_estimation || 0);
    const storiesEst = Number(json.stories_estimation || 0);
    const featureEstText = Number.isInteger(featureEst) ? String(featureEst) : featureEst.toFixed(1);
    const storiesEstText = Number.isInteger(storiesEst) ? String(storiesEst) : storiesEst.toFixed(1);

    body.innerHTML = `
      <div class="roadmap-feature-grid">
        <div class="roadmap-feature-field"><div class="roadmap-feature-label">Assignee</div><div class="roadmap-feature-value">${escapeHtml(json.assignee || "—")}</div></div>
        <div class="roadmap-feature-field"><div class="roadmap-feature-label">Reporter</div><div class="roadmap-feature-value">${escapeHtml(json.reporter || "—")}</div></div>
        <div class="roadmap-feature-field"><div class="roadmap-feature-label">Feature Estimation</div><div class="roadmap-feature-value">${escapeHtml(featureEstText)}</div></div>
        <div class="roadmap-feature-field"><div class="roadmap-feature-label">Stories Estimation</div><div class="roadmap-feature-value">${escapeHtml(storiesEstText)} ${json.stories_count != null ? `(from ${escapeHtml(String(json.stories_count))} stories)` : ""}</div></div>
      </div>
      <div class="roadmap-feature-field roadmap-feature-block">
        <div class="roadmap-feature-label">Acceptance Criterias</div>
        <div class="roadmap-feature-value">${escapeHtml(json.acceptance_criteria || "—")}</div>
      </div>
      <div class="roadmap-feature-field roadmap-feature-block">
        <div class="roadmap-feature-label">Description</div>
        <div class="roadmap-feature-value">${escapeHtml(json.description || "—")}</div>
      </div>
    `;
  } catch (e) {
    body.innerHTML = `<div class="roadmap-feature-error">Failed to load feature details: ${escapeHtml(String(e || "Unknown error"))}</div>`;
  }
}

function hideRoadmapFeatureInfo() {
  const modal = document.getElementById("roadmap-feature-modal");
  if (modal) modal.classList.add("hidden");
}

function setPendingPriority(featureId, priorityNumber) {
  const host = document.getElementById("backlog-roadmap");
  const feature = host?._roadmapData?.[featureId];
  if (!feature) return;

  const pending = roadmapPendingMoves();
  const current = pending.get(featureId) || {};
  const currentPrio = roadmapPriorityNumber(feature?.priority);
  const requested = Number(priorityNumber);

  if (requested === currentPrio) {
    delete current.targetPriority;
    current.priorityDirty = false;
  } else {
    current.targetPriority = requested;
    current.priorityDirty = true;
  }

  const hasMove = current.fixDirty === true;
  const hasPriority = current.priorityDirty === true && Number.isInteger(current.targetPriority);
  const hasEstimation = current.estimationDirty === true && Number.isInteger(current.targetEstimation);
  const hasAssignee = current.assigneeDirty === true && !!String(current.targetAssigneeName || "").trim();
  const hasPiScope = current.piScopeDirty === true;
  if (hasMove || hasPriority || hasEstimation || hasAssignee || hasPiScope) pending.set(featureId, current);
  else pending.delete(featureId);

  updateRoadmapPendingUi();
  renderBacklogRoadmap(host._roadmapData || {}, host._capabilitiesData || [], host._roadmapCapacityByFixVersion || {});
}

function normalizePiScopeValue(scopeRaw) {
  const text = String(scopeRaw || "").trim();
  const normalized = text.toLowerCase();
  if (!normalized || normalized === "none" || normalized === "not set") return "";
  if (normalized === "committed") return "Committed";
  if (normalized === "stretch") return "Stretch";
  if (normalized === "not included" || normalized === "notincluded") return "Not Included";
  return text;
}

function roadmapAssigneeShortName(nameRaw) {
  const full = String(nameRaw || "").trim();
  if (!full) return "";

  let base = full;
  if (base.includes(",")) {
    const parts = base.split(",");
    const afterComma = String(parts.slice(1).join(",") || "").trim();
    if (afterComma) base = afterComma;
  }

  const first = String(base.split(/\s+/)[0] || "").trim();
  return first || full;
}

function setPendingPiScope(featureId, piScopeValue) {
  const host = document.getElementById("backlog-roadmap");
  const feature = host?._roadmapData?.[featureId];
  if (!feature) return false;

  const requested = normalizePiScopeValue(piScopeValue);
  const currentScope = normalizePiScopeValue(feature?.pi_scope);

  const pending = roadmapPendingMoves();
  const current = pending.get(featureId) || {};

  if (requested === currentScope) {
    delete current.targetPiScope;
    current.piScopeDirty = false;
  } else {
    current.targetPiScope = requested;
    current.piScopeDirty = true;
  }

  const hasMove = current.fixDirty === true;
  const hasPriority = current.priorityDirty === true && Number.isInteger(current.targetPriority);
  const hasEstimation = current.estimationDirty === true && Number.isInteger(current.targetEstimation);
  const hasAssignee = current.assigneeDirty === true && !!String(current.targetAssigneeName || "").trim();
  const hasPiScope = current.piScopeDirty === true;
  if (hasMove || hasPriority || hasEstimation || hasAssignee || hasPiScope) pending.set(featureId, current);
  else pending.delete(featureId);

  updateRoadmapPendingUi();
  renderBacklogRoadmap(host._roadmapData || {}, host._capabilitiesData || [], host._roadmapCapacityByFixVersion || {});
  return true;
}

function setPendingEstimation(featureId, estimationValue) {
  const host = document.getElementById("backlog-roadmap");
  const feature = host?._roadmapData?.[featureId];
  if (!feature) return false;

  const requested = Number.parseInt(String(estimationValue || "").trim(), 10);
  if (!Number.isInteger(requested)) return false;

  const pending = roadmapPendingMoves();
  const current = pending.get(featureId) || {};
  const currentEstimation = Number.isFinite(Number(feature?.story_points))
    ? Number.parseInt(String(feature.story_points), 10)
    : 0;

  if (requested === currentEstimation) {
    delete current.targetEstimation;
    current.estimationDirty = false;
  } else {
    current.targetEstimation = requested;
    current.estimationDirty = true;
  }

  const hasMove = current.fixDirty === true;
  const hasPriority = current.priorityDirty === true && Number.isInteger(current.targetPriority);
  const hasEstimation = current.estimationDirty === true && Number.isInteger(current.targetEstimation);
  const hasAssignee = current.assigneeDirty === true && !!String(current.targetAssigneeName || "").trim();
  const hasPiScope = current.piScopeDirty === true;
  if (hasMove || hasPriority || hasEstimation || hasAssignee || hasPiScope) pending.set(featureId, current);
  else pending.delete(featureId);

  updateRoadmapPendingUi();
  renderBacklogRoadmap(host._roadmapData || {}, host._capabilitiesData || [], host._roadmapCapacityByFixVersion || {});
  return true;
}

function setPendingAssignee(featureId, teammate) {
  const host = document.getElementById("backlog-roadmap");
  const feature = host?._roadmapData?.[featureId];
  if (!feature) return false;

  const targetAccountId = String(teammate?.accountId || "").trim();
  const targetDisplayName = String(teammate?.displayName || "").trim();
  const targetEmailAddress = String(teammate?.emailAddress || "").trim();
  if (!targetDisplayName) return false;

  const pending = roadmapPendingMoves();
  const current = pending.get(featureId) || {};
  const currentAssigneeName = String(feature?.assignee || "").trim();

  if (targetDisplayName.toLowerCase() === currentAssigneeName.toLowerCase()) {
    delete current.targetAssigneeAccountId;
    delete current.targetAssigneeName;
    delete current.targetAssigneeEmail;
    current.assigneeDirty = false;
  } else {
    current.targetAssigneeAccountId = targetAccountId;
    current.targetAssigneeName = targetDisplayName;
    current.targetAssigneeEmail = targetEmailAddress;
    current.assigneeDirty = true;
  }

  const hasMove = current.fixDirty === true;
  const hasPriority = current.priorityDirty === true && Number.isInteger(current.targetPriority);
  const hasEstimation = current.estimationDirty === true && Number.isInteger(current.targetEstimation);
  const hasAssignee = current.assigneeDirty === true && !!String(current.targetAssigneeName || "").trim();
  const hasPiScope = current.piScopeDirty === true;
  if (hasMove || hasPriority || hasEstimation || hasAssignee || hasPiScope) pending.set(featureId, current);
  else pending.delete(featureId);

  updateRoadmapPendingUi();
  renderBacklogRoadmap(host._roadmapData || {}, host._capabilitiesData || [], host._roadmapCapacityByFixVersion || {});
  return true;
}

async function showRoadmapContextMenu(featureId, x, y) {
  const menu = document.getElementById("roadmap-context-menu");
  if (!menu) return;
  menu.innerHTML = "";

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "roadmap-context-item";
  openBtn.textContent = "Open in Jira";
  openBtn.addEventListener("click", () => {
    window.open(`https://jira-vira.volvocars.biz/browse/${encodeURIComponent(featureId)}`, "_blank");
    hideRoadmapContextMenu();
  });
  menu.appendChild(openBtn);

  const sep = document.createElement("div");
  sep.className = "roadmap-context-sep";
  menu.appendChild(sep);

  const prioWrap = document.createElement("div");
  prioWrap.className = "roadmap-context-submenu-wrap";
  const prioMainBtn = document.createElement("button");
  prioMainBtn.type = "button";
  prioMainBtn.className = "roadmap-context-item";
  prioMainBtn.textContent = "Set priority ▸";
  prioWrap.appendChild(prioMainBtn);

  const prioMenu = document.createElement("div");
  prioMenu.className = "roadmap-context-submenu";
  for (let p = 1; p <= 10; p += 1) {
    const btn = document.createElement("button");
    btn.type = "button";
    const prioStyle = roadmapPriorityStyle(p);
    btn.className = "roadmap-context-subitem roadmap-context-subitem-prio";
    btn.style.setProperty("--prio-bg", prioStyle.background);
    btn.style.setProperty("--prio-fg", prioStyle.textColor);
    btn.textContent = String(p);
    btn.addEventListener("click", () => {
      setPendingPriority(featureId, p);
      hideRoadmapContextMenu();
    });
    prioMenu.appendChild(btn);
  }
  prioWrap.appendChild(prioMenu);

  let closeTimer = null;
  const cancelClose = () => {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer = setTimeout(() => {
      prioWrap.classList.remove("open");
      closeTimer = null;
    }, 180);
  };

  prioWrap.addEventListener("mouseenter", () => {
    cancelClose();
    prioWrap.classList.add("open");
  });
  prioWrap.addEventListener("mouseleave", scheduleClose);

  prioMenu.addEventListener("mouseenter", () => {
    cancelClose();
    prioWrap.classList.add("open");
  });
  prioMenu.addEventListener("mouseleave", scheduleClose);

  prioMainBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    cancelClose();
    prioWrap.classList.toggle("open");
  });

  menu.appendChild(prioWrap);

  const sepCommit = document.createElement("div");
  sepCommit.className = "roadmap-context-sep";
  menu.appendChild(sepCommit);

  const commitmentWrap = document.createElement("div");
  commitmentWrap.className = "roadmap-context-submenu-wrap";
  const commitmentMainBtn = document.createElement("button");
  commitmentMainBtn.type = "button";
  commitmentMainBtn.className = "roadmap-context-item";
  commitmentMainBtn.textContent = "Set commitment ▸";
  commitmentWrap.appendChild(commitmentMainBtn);

  const commitmentMenu = document.createElement("div");
  commitmentMenu.className = "roadmap-context-submenu";
  const commitmentOptions = ["None", "Committed", "Stretch", "Not Included"];
  commitmentOptions.forEach((optionText) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "roadmap-context-subitem";
    btn.textContent = optionText;
    btn.addEventListener("click", () => {
      setPendingPiScope(featureId, optionText);
      hideRoadmapContextMenu();
    });
    commitmentMenu.appendChild(btn);
  });
  commitmentWrap.appendChild(commitmentMenu);

  let commitmentCloseTimer = null;
  const cancelCommitmentClose = () => {
    if (commitmentCloseTimer) {
      clearTimeout(commitmentCloseTimer);
      commitmentCloseTimer = null;
    }
  };
  const scheduleCommitmentClose = () => {
    cancelCommitmentClose();
    commitmentCloseTimer = setTimeout(() => {
      commitmentWrap.classList.remove("open");
      commitmentCloseTimer = null;
    }, 180);
  };

  commitmentWrap.addEventListener("mouseenter", () => {
    cancelCommitmentClose();
    commitmentWrap.classList.add("open");
  });
  commitmentWrap.addEventListener("mouseleave", scheduleCommitmentClose);

  commitmentMenu.addEventListener("mouseenter", () => {
    cancelCommitmentClose();
    commitmentWrap.classList.add("open");
  });
  commitmentMenu.addEventListener("mouseleave", scheduleCommitmentClose);

  commitmentMainBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    cancelCommitmentClose();
    commitmentWrap.classList.toggle("open");
  });

  menu.appendChild(commitmentWrap);

  const sep2 = document.createElement("div");
  sep2.className = "roadmap-context-sep";
  menu.appendChild(sep2);

  const estWrap = document.createElement("div");
  estWrap.className = "roadmap-context-submenu-wrap";

  const estMainBtn = document.createElement("button");
  estMainBtn.type = "button";
  estMainBtn.className = "roadmap-context-item";
  estMainBtn.textContent = "Set estimation ▸";
  estWrap.appendChild(estMainBtn);

  const estMenu = document.createElement("div");
  estMenu.className = "roadmap-context-submenu roadmap-context-submenu-estimation";

  const estLabel = document.createElement("label");
  estLabel.className = "roadmap-context-estimation-label";
  estLabel.textContent = "Set estimation";

  const estRow = document.createElement("div");
  estRow.className = "roadmap-context-estimation-row";

  const estInput = document.createElement("input");
  estInput.type = "number";
  estInput.step = "1";
  estInput.className = "roadmap-context-estimation-input";
  estInput.placeholder = "Integer";
  const host = document.getElementById("backlog-roadmap");
  const feature = host?._roadmapData?.[featureId];
  const pending = roadmapPendingMoves().get(featureId) || {};
  const currentEstimation = Number.isInteger(pending?.targetEstimation)
    ? Number(pending.targetEstimation)
    : (Number.isFinite(Number(feature?.story_points)) ? Number.parseInt(String(feature.story_points), 10) : 0);
  estInput.value = String(currentEstimation);

  const estSetBtn = document.createElement("button");
  estSetBtn.type = "button";
  estSetBtn.className = "roadmap-context-estimation-btn";
  estSetBtn.textContent = "Set";

  const submitEstimation = () => {
    const raw = String(estInput.value || "").trim();
    if (!/^[-+]?\d+$/.test(raw)) {
      estInput.focus();
      estInput.select();
      return;
    }
    setPendingEstimation(featureId, Number.parseInt(raw, 10));
    hideRoadmapContextMenu();
  };

  estSetBtn.addEventListener("click", submitEstimation);
  estInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      submitEstimation();
    }
  });

  estRow.appendChild(estInput);
  estRow.appendChild(estSetBtn);
  estMenu.appendChild(estLabel);
  estMenu.appendChild(estRow);
  estWrap.appendChild(estMenu);

  let estCloseTimer = null;
  const cancelEstClose = () => {
    if (estCloseTimer) {
      clearTimeout(estCloseTimer);
      estCloseTimer = null;
    }
  };
  const scheduleEstClose = () => {
    cancelEstClose();
    estCloseTimer = setTimeout(() => {
      estWrap.classList.remove("open");
      estCloseTimer = null;
    }, 180);
  };

  estWrap.addEventListener("mouseenter", () => {
    cancelEstClose();
    estWrap.classList.add("open");
  });
  estWrap.addEventListener("mouseleave", scheduleEstClose);

  estMenu.addEventListener("mouseenter", () => {
    cancelEstClose();
    estWrap.classList.add("open");
  });
  estMenu.addEventListener("mouseleave", scheduleEstClose);

  estMainBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    cancelEstClose();
    estWrap.classList.toggle("open");
    if (estWrap.classList.contains("open")) {
      setTimeout(() => {
        estInput.focus();
        estInput.select();
      }, 0);
    }
  });

  menu.appendChild(estWrap);

  const sep3 = document.createElement("div");
  sep3.className = "roadmap-context-sep";
  menu.appendChild(sep3);

  const reassignWrap = document.createElement("div");
  reassignWrap.className = "roadmap-context-submenu-wrap";

  const reassignMainBtn = document.createElement("button");
  reassignMainBtn.type = "button";
  reassignMainBtn.className = "roadmap-context-item";
  reassignMainBtn.textContent = "Reassign to ▸";
  reassignWrap.appendChild(reassignMainBtn);

  const reassignMenu = document.createElement("div");
  reassignMenu.className = "roadmap-context-submenu roadmap-context-submenu-reassign";
  const reassignLoading = document.createElement("div");
  reassignLoading.className = "roadmap-context-loading";
  reassignLoading.textContent = "Loading teammates...";
  reassignMenu.appendChild(reassignLoading);
  reassignWrap.appendChild(reassignMenu);

  let reassignCloseTimer = null;
  const cancelReassignClose = () => {
    if (reassignCloseTimer) {
      clearTimeout(reassignCloseTimer);
      reassignCloseTimer = null;
    }
  };
  const scheduleReassignClose = () => {
    cancelReassignClose();
    reassignCloseTimer = setTimeout(() => {
      reassignWrap.classList.remove("open");
      reassignCloseTimer = null;
    }, 180);
  };

  reassignWrap.addEventListener("mouseenter", () => {
    cancelReassignClose();
    reassignWrap.classList.add("open");
  });
  reassignWrap.addEventListener("mouseleave", scheduleReassignClose);

  reassignMenu.addEventListener("mouseenter", () => {
    cancelReassignClose();
    reassignWrap.classList.add("open");
  });
  reassignMenu.addEventListener("mouseleave", scheduleReassignClose);

  reassignMainBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    cancelReassignClose();
    reassignWrap.classList.toggle("open");
  });

  menu.appendChild(reassignWrap);

  const sep4 = document.createElement("div");
  sep4.className = "roadmap-context-sep";
  menu.appendChild(sep4);

  const infoBtn = document.createElement("button");
  infoBtn.type = "button";
  infoBtn.className = "roadmap-context-item";
  infoBtn.textContent = "Full info";
  infoBtn.addEventListener("click", () => {
    showRoadmapFeatureInfo(featureId);
    hideRoadmapContextMenu();
  });
  menu.appendChild(infoBtn);

  menu.classList.remove("hidden");
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, vw - rect.width - 8);
  const top = Math.min(y, vh - rect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;

  menu.querySelectorAll(".roadmap-context-submenu-wrap").forEach((submenuWrap) => {
    const submenu = submenuWrap.querySelector(".roadmap-context-submenu");
    if (!submenu) return;
    submenuWrap.classList.remove("open-left");
    submenuWrap.classList.remove("open-up");
    const prevDisplay = submenu.style.display;
    const prevVisibility = submenu.style.visibility;
    submenu.style.display = "block";
    submenu.style.visibility = "hidden";
    const submenuWidth = submenu.offsetWidth || 64;
    const submenuHeight = submenu.offsetHeight || 220;
    submenu.style.display = prevDisplay;
    submenu.style.visibility = prevVisibility;

    const menuRect = menu.getBoundingClientRect();
    const wouldOverflowRight = (menuRect.right + 6 + submenuWidth) > (window.innerWidth - 6);
    if (wouldOverflowRight) submenuWrap.classList.add("open-left");

    const wouldOverflowBottom = (menuRect.top + submenuHeight) > (window.innerHeight - 6);
    if (wouldOverflowBottom) submenuWrap.classList.add("open-up");
  });

  const teammates = await getRoadmapTeammates(false);
  reassignMenu.innerHTML = "";
  if (!teammates.length) {
    const empty = document.createElement("div");
    empty.className = "roadmap-context-loading";
    empty.textContent = "No teammates in Team Capacity";
    reassignMenu.appendChild(empty);
    return;
  }

  teammates.forEach((mate) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "roadmap-context-subitem roadmap-context-subitem-user";
    btn.textContent = String(mate?.displayName || "").trim() || "Unknown";
    btn.title = String(mate?.emailAddress || "").trim() || btn.textContent;
    btn.addEventListener("click", () => {
      setPendingAssignee(featureId, mate);
      hideRoadmapContextMenu();
    });
    reassignMenu.appendChild(btn);
  });
}

function showRoadmapNotice(message, type = "success", details = []) {
  let host = document.getElementById("roadmap-toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "roadmap-toast-host";
    host.className = "roadmap-toast-host";
    document.body.appendChild(host);
  }

  const floating = document.getElementById("roadmap-floating-actions");
  if (floating && !floating.classList.contains("hidden")) {
    const rect = floating.getBoundingClientRect();
    host.style.top = `${Math.round(rect.bottom + 8)}px`;
    host.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`;
    host.style.bottom = "auto";
  } else {
    host.style.top = "84px";
    host.style.right = "14px";
    host.style.bottom = "auto";
  }

  const toast = document.createElement("div");
  toast.className = `roadmap-toast roadmap-toast-${type}`;

  if (message) {
    const title = document.createElement("div");
    title.className = "roadmap-toast-title";
    title.textContent = message;
    toast.appendChild(title);
  }

  if (Array.isArray(details) && details.length) {
    const body = document.createElement("div");
    body.className = "roadmap-toast-body";
    details.forEach((entry) => {
      const lines = String(entry || "").split("\n").map(s => s.trim()).filter(Boolean);
      if (!lines.length) return;

      const block = document.createElement("div");
      block.className = "roadmap-toast-feature";

      const head = document.createElement("div");
      head.className = "roadmap-toast-feature-title";
      head.textContent = lines[0];
      block.appendChild(head);

      lines.slice(1).forEach((ln) => {
        const line = document.createElement("div");
        line.className = "roadmap-toast-feature-line";
        if (/\bfailed\b/i.test(ln)) line.classList.add("roadmap-toast-line-fail");
        if (/\bsuccess\b/i.test(ln)) line.classList.add("roadmap-toast-line-success");
        line.textContent = ln;
        block.appendChild(line);
      });

      body.appendChild(block);
    });
    toast.appendChild(body);
  }

  const close = document.createElement("button");
  close.type = "button";
  close.className = "roadmap-toast-close";
  close.textContent = "×";
  close.addEventListener("click", () => toast.remove());
  toast.appendChild(close);

  host.appendChild(toast);
  setTimeout(() => toast.remove(), type === "error" ? 12000 : 7000);
}

function roadmapStatusLockedForMove(statusRaw) {
  const s = String(statusRaw || "").toLowerCase();
  return (
    s.includes("done") ||
    s.includes("resolved") ||
    s.includes("closed") ||
    s.includes("in progress") ||
    s.includes("in-progress") ||
    s.includes("verification")
  );
}

function qsFixVersionFromWeekKey(weekKey) {
  const parsed = parseWeekKey(weekKey);
  if (!parsed) return "";
  const week = Number(parsed.week);
  if (![10, 22, 37, 49].includes(week)) return "";
  return `QS_${String(parsed.year).slice(-2)}w${String(week).padStart(2, "0")}`;
}

function simplifyPushError(rawError) {
  const text = String(rawError || "").trim();
  if (/Invalid Fix Version\(s\)/i.test(text)) return "Invalid Fix Version(s)";
  return text;
}

async function pushRoadmapMovesToJira() {
  const host = document.getElementById("backlog-roadmap");
  if (!host || !host._roadmapData) return;

  const pending = roadmapPendingMoves();
  if (!pending.size) {
    updateRoadmapPendingUi();
    return;
  }

  showLoading();
  try {
    const entries = Array.from(pending.entries());
    const failed = [];
    const succeeded = [];
    const partial = [];

    for (const [featureId, move] of entries) {
      const feature = host._roadmapData?.[featureId];
      if (!feature) {
        failed.push({ featureId, error: "Feature not found in current roadmap data" });
        continue;
      }

      const currentPending = { ...(move || {}) };
      const toFuture = Boolean(currentPending.toFuture);
      const targetFixVersion = String(currentPending.targetFixVersion || "").trim();
      const targetPriority = Number.isInteger(currentPending.targetPriority) ? Number(currentPending.targetPriority) : null;
      const targetEstimation = Number.isInteger(currentPending.targetEstimation) ? Number(currentPending.targetEstimation) : null;
      const targetAssigneeAccountId = String(currentPending.targetAssigneeAccountId || "").trim();
      const targetAssigneeName = String(currentPending.targetAssigneeName || "").trim();
      const targetAssigneeEmail = String(currentPending.targetAssigneeEmail || "").trim();
      const targetPiScope = normalizePiScopeValue(currentPending.targetPiScope);
      const fixDirty = currentPending.fixDirty === true;
      const priorityDirty = currentPending.priorityDirty === true;
      const estimationDirty = currentPending.estimationDirty === true;
      const assigneeDirty = currentPending.assigneeDirty === true;
      const piScopeDirty = currentPending.piScopeDirty === true;
      if (!fixDirty && !priorityDirty && !estimationDirty && !assigneeDirty && !piScopeDirty) {
        pending.delete(featureId);
        continue;
      }

      const fieldMessages = [];
      let hasFieldFailure = false;
      let hasFieldSuccess = false;

      if (fixDirty) {
        const currentQs = parseQsFixVersionLatest(feature?.fixVersions || [], feature?.archived_fixVersions || [])?.raw || "";
        const addFixVersions = toFuture
          ? []
          : (currentQs === targetFixVersion ? [] : [targetFixVersion]);
        const removeFixVersions = toFuture
          ? (currentQs ? [currentQs] : [])
          : ((currentQs && currentQs !== targetFixVersion) ? [currentQs] : []);

        if (!addFixVersions.length && !removeFixVersions.length) {
          currentPending.fixDirty = false;
          currentPending.toFuture = false;
          currentPending.targetFixVersion = "";
          fieldMessages.push("- Fix Version: No update needed");
          hasFieldSuccess = true;
        } else {
          const resp = await fetch("/update_fix_versions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              issueKey: featureId,
              addFixVersions,
              removeFixVersions,
              dryRun: false,
            }),
          });
          const json = await resp.json().catch(() => ({}));
          if (!resp.ok || !json?.ok) {
            fieldMessages.push(`- Fix Version: Failed - ${simplifyPushError(json?.error || `HTTP ${resp.status}`)}`);
            hasFieldFailure = true;
          } else {
            currentPending.fixDirty = false;
            currentPending.toFuture = false;
            currentPending.targetFixVersion = "";
            fieldMessages.push("- Fix Version: Success");
            hasFieldSuccess = true;
          }
        }
      }

      if (priorityDirty) {
        const currentPriority = roadmapPriorityNumber(feature?.priority);
        const priorityNeedsUpdate = targetPriority !== null && targetPriority !== currentPriority;
        if (!priorityNeedsUpdate) {
          currentPending.priorityDirty = false;
          delete currentPending.targetPriority;
          fieldMessages.push("- Priority: No update needed");
          hasFieldSuccess = true;
        } else {
          const resp = await fetch("/update_priority", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              issueKey: featureId,
              priority: targetPriority,
              dryRun: false,
            }),
          });
          const json = await resp.json().catch(() => ({}));
          if (!resp.ok || !json?.ok) {
            fieldMessages.push(`- Priority: Failed - ${simplifyPushError(json?.error || `HTTP ${resp.status}`)}`);
            hasFieldFailure = true;
          } else {
            currentPending.priorityDirty = false;
            delete currentPending.targetPriority;
            fieldMessages.push("- Priority: Success");
            hasFieldSuccess = true;
          }
        }
      }

      if (estimationDirty) {
        const currentEstimation = Number.isFinite(Number(feature?.story_points))
          ? Number.parseInt(String(feature.story_points), 10)
          : 0;
        const estimationNeedsUpdate = targetEstimation !== null && targetEstimation !== currentEstimation;
        if (!estimationNeedsUpdate) {
          currentPending.estimationDirty = false;
          delete currentPending.targetEstimation;
          fieldMessages.push("- Estimation: No update needed");
          hasFieldSuccess = true;
        } else {
          const resp = await fetch("/update_estimation", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              issueKey: featureId,
              estimation: targetEstimation,
              dryRun: false,
            }),
          });
          const json = await resp.json().catch(() => ({}));
          if (!resp.ok || !json?.ok) {
            fieldMessages.push(`- Estimation: Failed - ${simplifyPushError(json?.error || `HTTP ${resp.status}`)}`);
            hasFieldFailure = true;
          } else {
            currentPending.estimationDirty = false;
            delete currentPending.targetEstimation;
            fieldMessages.push("- Estimation: Success");
            hasFieldSuccess = true;
          }
        }
      }

      if (assigneeDirty) {
        const currentAssigneeName = String(feature?.assignee || "").trim();
        const assigneeNeedsUpdate = !!targetAssigneeName && targetAssigneeName.toLowerCase() !== currentAssigneeName.toLowerCase();
        if (!assigneeNeedsUpdate) {
          currentPending.assigneeDirty = false;
          delete currentPending.targetAssigneeAccountId;
          delete currentPending.targetAssigneeName;
          delete currentPending.targetAssigneeEmail;
          fieldMessages.push("- Assignee: No update needed");
          hasFieldSuccess = true;
        } else {
          const resp = await fetch("/update_assignee", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              issueKey: featureId,
              accountId: targetAssigneeAccountId,
              displayName: targetAssigneeName,
              emailAddress: targetAssigneeEmail,
              dryRun: false,
            }),
          });
          const json = await resp.json().catch(() => ({}));
          if (!resp.ok || !json?.ok) {
            fieldMessages.push(`- Assignee: Failed - ${simplifyPushError(json?.error || `HTTP ${resp.status}`)}`);
            hasFieldFailure = true;
          } else {
            currentPending.assigneeDirty = false;
            delete currentPending.targetAssigneeAccountId;
            delete currentPending.targetAssigneeName;
            delete currentPending.targetAssigneeEmail;
            fieldMessages.push("- Assignee: Success");
            hasFieldSuccess = true;
          }
        }
      }

      if (piScopeDirty) {
        const currentScope = normalizePiScopeValue(feature?.pi_scope);
        const scopeNeedsUpdate = targetPiScope !== currentScope;
        if (!scopeNeedsUpdate) {
          currentPending.piScopeDirty = false;
          delete currentPending.targetPiScope;
          fieldMessages.push("- Commitment: No update needed");
          hasFieldSuccess = true;
        } else {
          const resp = await fetch("/update_pi_scope", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              issueKey: featureId,
              piScope: targetPiScope || "None",
              dryRun: false,
            }),
          });
          const json = await resp.json().catch(() => ({}));
          if (!resp.ok || !json?.ok) {
            fieldMessages.push(`- Commitment: Failed - ${simplifyPushError(json?.error || `HTTP ${resp.status}`)}`);
            hasFieldFailure = true;
          } else {
            currentPending.piScopeDirty = false;
            delete currentPending.targetPiScope;
            fieldMessages.push("- Commitment: Success");
            hasFieldSuccess = true;
          }
        }
      }

      const stillDirty =
        currentPending.fixDirty === true ||
        currentPending.priorityDirty === true ||
        currentPending.estimationDirty === true ||
        currentPending.assigneeDirty === true ||
        currentPending.piScopeDirty === true;
      if (stillDirty) pending.set(featureId, currentPending);
      else pending.delete(featureId);

      if (hasFieldFailure && hasFieldSuccess) {
        partial.push({ featureId, messages: fieldMessages });
      } else if (hasFieldFailure) {
        failed.push({ featureId, messages: fieldMessages });
      } else {
        succeeded.push(featureId);
      }
    }

    succeeded.forEach((featureId) => pending.delete(featureId));
    updateRoadmapPendingUi();

    if (failed.length || partial.length) {
      const details = [
        ...partial.slice(0, 5).map(p => `${p.featureId}:\n  - ${p.messages.join("\n  - ")}`),
        ...failed.slice(0, 5).map(f => `${f.featureId}:\n  - ${f.messages.join("\n  - ")}`),
      ];
      const anyFailure = failed.length > 0 || partial.length > 0;
      const anySuccess = succeeded.length > 0 || partial.length > 0;
      const noticeType = anyFailure && !anySuccess ? "error" : "warning";
      showRoadmapNotice(
        "",
        noticeType,
        details
      );
    } else {
      showRoadmapNotice(`Push to Jira completed. Updated ${succeeded.length} feature(s).`, "success");
    }

    await loadBacklogData(true);
  } finally {
    hideLoading();
  }
}

// --- helpers ---
const norm = s => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

function getSelectedFixVersion() {
  const el = document.getElementById("fixVersionSelect");
  return el?.value || localStorage.getItem("selectedFixVersion") || "";
}
function getSelectedWorkGroup() {
  const el = document.getElementById("workGroupSelect");
  return el?.value || localStorage.getItem("selectedWorkGroup") || "";
}

function defaultAppSettings() {
  return {
    fix_versions: ["PI_24w49", "PI_25w10", "QS_25w22", "QS_25w37", "QS_25w49"],
    work_groups: [
      { leadingWorkGroup: "ART - BCRC - BSW TFW", teamName: "Infra Team" },
      { leadingWorkGroup: "ART - BCRC - FPT", teamName: "Web Team" },
      { leadingWorkGroup: "ART - BCRC - SysSW CI", teamName: "CI Team" },
      { leadingWorkGroup: "ART - BCRC - BSW Diag and Com", teamName: "Diag and Com" },
      { leadingWorkGroup: "ART - BCRC - BSW HW Interface", teamName: "HW interface" },
      { leadingWorkGroup: "ART - BCRC - BSW Platform", teamName: "BSW Platform" },
      { leadingWorkGroup: "ART - BCRC - BSW SW Platform and BL", teamName: "BSW SW Platform and BL" },
      { leadingWorkGroup: "ART - BCRC - Domain", teamName: "AiC team" },
      { leadingWorkGroup: "ART - BCRC - FSW", teamName: "FSW team" },
      { leadingWorkGroup: "ART - BCRC - SysSW System Safety and Security", teamName: "Safety & Security" },
      { leadingWorkGroup: "ART - BCRC - Moni", teamName: "TPMS" },
    ],
  };
}

function normalizeAppSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const seenFix = new Set();
  const fix_versions = [];
  (Array.isArray(src.fix_versions) ? src.fix_versions : []).forEach((entry) => {
    const value = String(entry || "").trim();
    if (!value) return;
    const key = value.toLowerCase();
    if (seenFix.has(key)) return;
    seenFix.add(key);
    fix_versions.push(value);
  });

  const seenWg = new Set();
  const work_groups = [];
  (Array.isArray(src.work_groups) ? src.work_groups : []).forEach((row) => {
    const obj = row && typeof row === "object" ? row : {};
    const leadingWorkGroup = String(obj.leadingWorkGroup || "").trim();
    const teamName = String(obj.teamName || "").trim();
    if (!leadingWorkGroup) return;
    const key = leadingWorkGroup.toLowerCase();
    if (seenWg.has(key)) return;
    seenWg.add(key);
    work_groups.push({ leadingWorkGroup, teamName: teamName || leadingWorkGroup });
  });

  const defaults = defaultAppSettings();
  return {
    fix_versions: fix_versions.length ? fix_versions : defaults.fix_versions,
    work_groups: work_groups.length ? work_groups : defaults.work_groups,
  };
}

async function fetchAppSettings(force = false) {
  if (!force && appSettingsCache) return appSettingsCache;
  try {
    const resp = await fetch("/app_settings", { cache: "no-store" });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json?.ok) throw new Error(json?.error || `HTTP ${resp.status}`);
    appSettingsCache = normalizeAppSettings(json.settings);
  } catch {
    appSettingsCache = defaultAppSettings();
  }
  return appSettingsCache;
}

function populateSelectWithOptions(selectEl, options, valueOf, labelOf) {
  if (!selectEl) return;
  const current = String(selectEl.value || "").trim();
  const opts = Array.isArray(options) ? options : [];
  selectEl.innerHTML = "";
  opts.forEach((entry) => {
    const value = String(valueOf(entry) || "").trim();
    if (!value) return;
    const label = String(labelOf(entry) || value).trim() || value;
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    selectEl.appendChild(opt);
  });
  if (current && Array.from(selectEl.options).some((o) => o.value === current)) {
    selectEl.value = current;
  } else if (selectEl.options.length) {
    selectEl.value = selectEl.options[0].value;
  }
}

function applySettingsToPageSelectors(settings) {
  const normalized = normalizeAppSettings(settings);
  const fixSelect = document.getElementById("fixVersionSelect");
  const wgSelect = document.getElementById("workGroupSelect");

  if (fixSelect) {
    populateSelectWithOptions(
      fixSelect,
      normalized.fix_versions,
      (item) => item,
      (item) => item
    );
  }

  if (wgSelect) {
    populateSelectWithOptions(
      wgSelect,
      normalized.work_groups,
      (item) => item.leadingWorkGroup,
      (item) => item.teamName || item.leadingWorkGroup
    );
  }
}

async function ensureGlobalSettingsApplied(force = false) {
  const settings = await fetchAppSettings(force);
  applySettingsToPageSelectors(settings);
  return settings;
}

function restoreGlobalNavSelection() {
  const savedFix = localStorage.getItem("selectedFixVersion") || "";
  const savedWg = localStorage.getItem("selectedWorkGroup") || "";

  const fixEl = document.getElementById("fixVersionSelect");
  if (fixEl) {
    if (savedFix && Array.from(fixEl.options).some((o) => o.value === savedFix)) {
      fixEl.value = savedFix;
    } else if (!fixEl.value && fixEl.options.length) {
      fixEl.value = fixEl.options[0].value;
    }
  }

  const wgEl = document.getElementById("workGroupSelect");
  if (wgEl) {
    if (savedWg && Array.from(wgEl.options).some((o) => o.value === savedWg)) {
      wgEl.value = savedWg;
    } else if (!wgEl.value && wgEl.options.length) {
      wgEl.value = wgEl.options[0].value;
    }
  }
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
  document.querySelectorAll("table").forEach((table) => {
    const isBacklogTable = !!table.closest('#backlog-table');
    const backlogColumnFilters = isBacklogTable ? getBacklogColumnFiltersForTable(table) : {};
    const backlogVisibleKeys = isBacklogTable ? getBacklogVisibleColumnKeys(table) : [];

    const rows = Array.from(table.querySelectorAll("tbody tr"));
    rows.forEach((row) => {
      const rowKind = String(row.getAttribute("data-row-kind") || "");
      if (rowKind === "story") return;
      if (row.classList.contains("capability-block-row")) return;
      if (row.classList.contains("totals-row")) {
        row.style.display = "";
        return;
      }
      const storySearch = String(row.getAttribute("data-story-search") || "").toLowerCase();
      const matchesText = row.innerText.toLowerCase().includes(filter) || (!!filter && storySearch.includes(filter));

      let matchesColumnFilters = true;
      if (isBacklogTable && backlogVisibleKeys.length) {
        for (let i = 0; i < backlogVisibleKeys.length; i += 1) {
          const key = backlogVisibleKeys[i];
          const wanted = Array.isArray(backlogColumnFilters[key])
            ? backlogColumnFilters[key].filter(Boolean)
            : [];
          if (!wanted.length || !BACKLOG_SELECT_FILTER_KEYS.has(key) || key === 'rownum') continue;
          const cellText = String(row.cells[i]?.innerText || '').toLowerCase();
          const isMatch = key === 'fixversions'
            ? wanted.some((expected) => cellText.includes(String(expected || '').toLowerCase()))
            : wanted.some((expected) => cellText === String(expected || '').toLowerCase());
          if (!isMatch) {
            matchesColumnFilters = false;
            break;
          }
        }
      }

      row.style.display = (matchesText && matchesColumnFilters) ? "" : "none";
    });

    if (rows.some((row) => row.classList.contains("capability-block-row"))) {
      rows.forEach((row, index) => {
        if (!row.classList.contains("capability-block-row")) return;
        let hasVisibleItems = false;
        for (let i = index + 1; i < rows.length; i++) {
          const nextRow = rows[i];
          if (nextRow.classList.contains("capability-block-row")) break;
          if (nextRow.style.display !== "none") {
            hasVisibleItems = true;
            break;
          }
        }
        row.style.display = hasVisibleItems ? "" : "none";
      });
    }

    applyCommittedTreeVisibility(table);

    renumberVisibleRows(table);
    recalculateVisibleTotals(table);
  });
}

function recalculateVisibleTotals(table) {
  if (!table) return;
  const totalsRow = table.querySelector("tbody tr.totals-row");
  if (!(totalsRow instanceof HTMLTableRowElement)) return;

  const headers = Array.from(table.querySelectorAll("thead th")).map((th) => (th.textContent || "").trim().toLowerCase());
  const featureNameIdx = headers.findIndex((h) => h === "feature name");
  const featureSpIdx = headers.findIndex((h) => h === "feature st.p.");
  const storySumIdx = headers.findIndex((h) => h === "st.p. sum");
  if (featureSpIdx < 0 || storySumIdx < 0) return;

  let totalFeatureSp = 0;
  let totalStorySum = 0;
  const rows = Array.from(table.querySelectorAll("tbody tr"));
  rows.forEach((row) => {
    if (!(row instanceof HTMLTableRowElement)) return;
    const rowKind = String(row.getAttribute("data-row-kind") || "");
    if (rowKind === "story") return;
    if (row.classList.contains("totals-row") || row.classList.contains("capability-block-row")) return;
    if (row.style.display === "none") return;

    const featureSpText = (row.cells[featureSpIdx]?.textContent || "").trim();
    const storySumText = (row.cells[storySumIdx]?.textContent || "").trim();
    totalFeatureSp += Number.parseFloat(featureSpText) || 0;
    totalStorySum += Number.parseFloat(storySumText) || 0;
  });

  const toDisplay = (value) => formatEstimationValue(value);

  if (featureNameIdx >= 0 && totalsRow.cells[featureNameIdx]) totalsRow.cells[featureNameIdx].textContent = "Total";
  if (totalsRow.cells[featureSpIdx]) totalsRow.cells[featureSpIdx].textContent = toDisplay(totalFeatureSp);
  if (totalsRow.cells[storySumIdx]) totalsRow.cells[storySumIdx].textContent = toDisplay(totalStorySum);
}

function renumberVisibleRows(table) {
  if (!table) return;
  const rows = Array.from(table.querySelectorAll("tbody tr"));
  let next = 1;
  rows.forEach(row => {
    const rowKind = String(row.getAttribute("data-row-kind") || "");
    if (rowKind === "story") return;
    if (row.classList.contains("totals-row") || row.classList.contains("capability-block-row")) return;
    const numCell = row.querySelector("td.col-rownum");
    if (!numCell) return;
    if (row.style.display === "none") return;
    numCell.textContent = String(next++);
  });
}

function sortTable(header) {
  const table = header.closest("table");
  const tbody = table.querySelector("tbody");
  const requestedSortCol = Number(header.getAttribute("data-sort-col"));
  const index = Number.isInteger(requestedSortCol) && requestedSortCol >= 0
    ? requestedSortCol
    : Array.from(header.parentNode.children).indexOf(header);
  const rows = Array.from(tbody.querySelectorAll("tr"));
  const storyRowsByFeature = new Map();
  rows.forEach((row) => {
    const kind = String(row.getAttribute("data-row-kind") || "");
    if (kind !== "story") return;
    const parentFeatureId = String(row.getAttribute("data-parent-feature-id") || "").trim();
    if (!parentFeatureId) return;
    if (!storyRowsByFeature.has(parentFeatureId)) storyRowsByFeature.set(parentFeatureId, []);
    storyRowsByFeature.get(parentFeatureId).push(row);
  });
  const totalsRows = rows.filter(r => r.classList.contains("totals-row"));
  const sortableRows = rows.filter((r) => {
    const kind = String(r.getAttribute("data-row-kind") || "");
    if (kind === "story") return false;
    return !r.classList.contains("totals-row") && !r.classList.contains("capability-block-row");
  });
  const ascending = !header.classList.contains("asc");
  const isCapabilityGroupedTable = table.classList.contains("capability-grouped-table");

  sortableRows.sort((a, b) => {
    const aText = a.cells[index]?.innerText.toLowerCase() || "";
    const bText = b.cells[index]?.innerText.toLowerCase() || "";
    return ascending ? aText.localeCompare(bText) : bText.localeCompare(aText);
  });

  tbody.innerHTML = "";
  if (isCapabilityGroupedTable) {
    let previousCapability = null;
    sortableRows.forEach((row) => {
      const capability = String(row.getAttribute("data-capability-block") || "No Capability");
      const capabilityKey = String(row.getAttribute("data-capability-key") || "").trim();
      const capabilityId = String(row.getAttribute("data-capability-id") || capability || "").trim();
      if (capability !== previousCapability) {
        const blockRow = document.createElement("tr");
        blockRow.className = "capability-block-row";
        blockRow.setAttribute("data-row-kind", "capability");
        blockRow.setAttribute("data-capability-id", capabilityId);
        const blockCell = document.createElement("td");
        const headerCells = Array.from(header.parentNode.children || []);
        const totalColumns = headerCells.reduce((sum, cell) => sum + Math.max(1, Number(cell.colSpan) || 1), 0);
        blockCell.colSpan = Math.max(1, totalColumns);
        const isCommittedTable = !!table.closest("#committed-table");
        if (isCommittedTable) {
          const arrow = document.createElement("button");
          arrow.type = "button";
          arrow.className = "committed-cap-toggle";
          arrow.setAttribute("data-capability-id", capabilityId);
          arrow.textContent = "▼";
          arrow.title = "Collapse/expand capability";
          blockCell.appendChild(arrow);
        }
        if (capabilityKey) {
          const link = document.createElement("a");
          link.href = `https://jira-vira.volvocars.biz/browse/${capabilityKey}`;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = capability;
          blockCell.appendChild(link);
        } else {
          blockCell.textContent = capability;
        }
        blockRow.appendChild(blockCell);
        tbody.appendChild(blockRow);
        previousCapability = capability;
      }
      tbody.appendChild(row);
      const featureId = String(row.getAttribute("data-feature-id") || "").trim();
      const storyRows = storyRowsByFeature.get(featureId) || [];
      storyRows.forEach((storyRow) => tbody.appendChild(storyRow));
    });
  } else {
    sortableRows.forEach((row) => {
      tbody.appendChild(row);
      const featureId = String(row.getAttribute("data-feature-id") || "").trim();
      const storyRows = storyRowsByFeature.get(featureId) || [];
      storyRows.forEach((storyRow) => tbody.appendChild(storyRow));
    });
  }
  totalsRows.forEach(row => tbody.appendChild(row));
  table.querySelectorAll("th").forEach(th => th.classList.remove("asc", "desc"));
  header.classList.add(ascending ? "asc" : "desc");
  applyCommittedTreeVisibility(table);
  renumberVisibleRows(table);
  recalculateVisibleTotals(table);
}

function toggleTable(id, btn) {
  const section = document.getElementById(id);
  const isHidden = section.style.display === "none";
  section.style.display = isHidden ? "block" : "none";
  btn.textContent = isHidden ? "⬆ Collapse" : "⬇ Expand";
}

// --- remember page selections ---
function savePlanningSettings() {
  localStorage.setItem("selectedFixVersion", getSelectedFixVersion() || "");
  localStorage.setItem("selectedWorkGroup", getSelectedWorkGroup() || "");
}
function restorePlanningSettings() {
  const fv = localStorage.getItem("selectedFixVersion");
  const wg = localStorage.getItem("selectedWorkGroup");
  if (fv) { const el = document.getElementById("fixVersionSelect"); if (el) el.value = fv; }
  if (wg) { const el = document.getElementById("workGroupSelect");  if (el) el.value = wg; }
  const fixEl = document.getElementById("fixVersionSelect");
  if (fixEl && !fixEl.value && fixEl.options.length) fixEl.value = fixEl.options[0].value;
  const wgEl = document.getElementById("workGroupSelect");
  if (wgEl && !wgEl.value && wgEl.options.length) wgEl.value = wgEl.options[0].value;
}

function showLoading() { const o = document.getElementById('loading-overlay'); if (o) o.style.display = 'flex'; }
function hideLoading() { const o = document.getElementById('loading-overlay'); if (o) o.style.display = 'none'; }

function updateStickyLayoutOffsets() {
  const root = document.documentElement;
  const menu = document.querySelector(".main-menu");
  const filters = document.querySelector(".filters");
  const toggles = document.getElementById("backlog-column-toggles");

  const menuH = menu ? Math.ceil(menu.getBoundingClientRect().height) : 0;
  const filtersH = filters ? Math.ceil(filters.getBoundingClientRect().height) : 0;
  const togglesH = (toggles && toggles.offsetParent !== null)
    ? Math.ceil(toggles.getBoundingClientRect().height)
    : 0;

  root.style.setProperty("--sticky-menu-h", `${menuH}px`);
  root.style.setProperty("--sticky-filters-h", `${filtersH}px`);
  root.style.setProperty("--sticky-toggles-h", `${togglesH}px`);
}

function setupStickyLayoutOffsets() {
  updateStickyLayoutOffsets();
  if (window.__stickyLayoutBound) return;
  window.__stickyLayoutBound = true;

  let timer = null;
  window.addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(updateStickyLayoutOffsets, 80);
  });
}

/* ========================
   PI Planning main loader
   ======================== */
async function loadPIPlanningData(forceRefresh = false) {
  showLoading();
  try {
    const fixVersion = getSelectedFixVersion();
    const workGroup  = getSelectedWorkGroup();
    if (!fixVersion || !workGroup) return;

    const url = `/pi_planning_data?fixVersion=${encodeURIComponent(fixVersion)}&workGroup=${encodeURIComponent(workGroup)}${forceRefresh ? "&forceRefresh=1" : ""}`;
    const cacheKey = makeCacheKey("piPlanningData", { fixVersion, workGroup });
    const data = await fetchJsonWithClientCache(url, cacheKey, forceRefresh);

    // Define sprint columns
    const sprints = ["Sprint 1","Sprint 2","Sprint 3","Sprint 4","Sprint 5","No Sprint"];

    const featureInSelectedPI = (feature, fv) =>
      Array.isArray(feature.fixVersions) && feature.fixVersions.includes(fv);
    const isDone = feature => (feature.status || "").toLowerCase() === "done";

    const committed = [];
    const backlog   = [];

    for (const [key, feature] of Object.entries(data)) {
      const scope = (feature.pi_scope || "").toLowerCase();
      const inPI = Array.isArray(feature.fixVersions)
        ? feature.fixVersions.includes(fixVersion)
        : false;

      if (scope.startsWith("committed") && inPI) {
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
        await renderCommittedSummary(committed, "committed-summary");
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

function planningPersonNameKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function planningPersonAliasKeys(nameRaw) {
  const name = String(nameRaw || "").trim();
  if (!name) return [];
  const aliases = new Set();
  const normalized = planningPersonNameKey(name);
  if (normalized) aliases.add(normalized);

  const commaParts = name.split(",").map((part) => String(part || "").trim()).filter(Boolean);
  if (commaParts.length >= 2) {
    const reordered = `${commaParts.slice(1).join(" ")} ${commaParts[0]}`.trim();
    const reorderedKey = planningPersonNameKey(reordered);
    if (reorderedKey) aliases.add(reorderedKey);
  }

  const pieces = normalized.split(" ").filter(Boolean);
  if (pieces.length >= 2) {
    aliases.add(`${pieces[0]} ${pieces[pieces.length - 1]}`);
    aliases.add(pieces[0]);
  } else if (pieces.length === 1) {
    aliases.add(pieces[0]);
  }

  return Array.from(aliases);
}

function planningComputeMemberCapacity(member) {
  let total = 0;
  TEAM_CAPACITY_SPRINTS.forEach((sprint) => {
    const weeks = Array.isArray(member?.weekValues?.[sprint]) ? member.weekValues[sprint] : [];
    weeks.forEach((weekValue) => {
      const n = Number(weekValue || 0);
      if (Number.isFinite(n)) total += n;
    });
  });
  const safeTotal = Number.isFinite(total) ? total : 0;
  return {
    total: safeTotal,
    full: teamCapacityRoundInteger(safeTotal * 0.8),
    planned: teamCapacityRoundInteger(safeTotal * 0.6),
  };
}

function planningLoadModeStorageKey() {
  return `piLoadMode::${getSelectedWorkGroup() || ""}::${getSelectedFixVersion() || ""}`;
}

function getPlanningLoadMode() {
  const raw = String(localStorage.getItem(planningLoadModeStorageKey()) || "stories").trim().toLowerCase();
  return raw === "features" ? "features" : "stories";
}

function setPlanningLoadMode(mode) {
  const safe = String(mode || "").trim().toLowerCase() === "features" ? "features" : "stories";
  localStorage.setItem(planningLoadModeStorageKey(), safe);
}

function collapseAllCommittedStories() {
  const tableHost = document.getElementById('committed-table');
  const featureIds = (Array.isArray(tableHost?._features) ? tableHost._features : [])
    .map((row) => String(row?.[0] || '').trim())
    .filter(Boolean);
  committedCollapsedFeatures = new Set(featureIds);
  persistCommittedTreeCollapseState();
  const nextSprints = Array.isArray(tableHost?._treeSprints) ? tableHost._treeSprints : [];
  window._rerenderFeatureTable('committed-table', nextSprints);
  applyFilter();
}

function planningAssignedByStories(rows) {
  const assignedByPerson = new Map();
  rows.forEach(([, feature]) => {
    const details = Array.isArray(feature?.stories_detail) ? feature.stories_detail : [];
    details.forEach((story) => {
      const storyAssignee = String(story?.assignee || "").trim();
      if (!storyAssignee) return;
      const assigneeKey = planningPersonNameKey(storyAssignee);
      if (!assigneeKey || assigneeKey === "unassigned") return;
      const storyPoints = Number(story?.story_points ?? 0);
      const safeStoryPoints = Number.isFinite(storyPoints) ? storyPoints : 0;
      assignedByPerson.set(assigneeKey, Number(assignedByPerson.get(assigneeKey) || 0) + safeStoryPoints);
    });
  });
  return assignedByPerson;
}

function planningAssignedByFeatures(rows) {
  const assignedByPerson = new Map();
  rows.forEach(([, feature]) => {
    const featureAssignee = String(feature?.assignee || "").trim();
    if (!featureAssignee) return;
    const assigneeKey = planningPersonNameKey(featureAssignee);
    if (!assigneeKey || assigneeKey === "unassigned") return;
    const featureEstimation = Number(feature?.story_points ?? 0);
    const safeFeatureEstimation = Number.isFinite(featureEstimation) ? featureEstimation : 0;
    assignedByPerson.set(assigneeKey, Number(assignedByPerson.get(assigneeKey) || 0) + safeFeatureEstimation);
  });
  return assignedByPerson;
}

function formatEstimationValue(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "0";
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

async function fetchPlanningTeamCapacity(workGroup, fixVersion) {
  if (!workGroup || !fixVersion) return [];
  try {
    const url = `/team_capacity_data?workGroup=${encodeURIComponent(workGroup)}&fixVersion=${encodeURIComponent(fixVersion)}`;
    const cacheKey = makeCacheKey("teamCapacityData", { workGroup, fixVersion });
    const json = await fetchJsonWithClientCache(url, cacheKey, false);
    const payload = json?.ok ? (json?.data || {}) : {};
    return Array.isArray(payload?.members) ? payload.members : [];
  } catch {
    return [];
  }
}

function planningCapacityPercent(assigned, fullCapacity) {
  const assignedNum = Number(assigned || 0);
  const fullNum = Number(fullCapacity || 0);
  if (!Number.isFinite(assignedNum) || !Number.isFinite(fullNum) || fullNum <= 0) return 0;
  return Math.max(0, Math.min(100, (assignedNum / fullNum) * 100));
}

function planningCapacityStatusClass(assigned, fullCapacity) {
  const assignedNum = Number(assigned || 0);
  const fullNum = Number(fullCapacity || 0);
  if (!Number.isFinite(fullNum) || fullNum <= 0) return "no-capacity";
  if (assignedNum > fullNum) return "overloaded";
  if (assignedNum >= fullNum * 0.8) return "near-full";
  return "ok";
}

async function renderCommittedSummary(committed, containerId) {
  const host = document.getElementById(containerId);
  if (!host) return;

  const rows = Array.isArray(committed) ? committed : [];
  const workGroup = getSelectedWorkGroup();
  const fixVersion = getSelectedFixVersion();
  const loadMode = getPlanningLoadMode();
  const assignedByPerson = loadMode === "features"
    ? planningAssignedByFeatures(rows)
    : planningAssignedByStories(rows);

  const members = await fetchPlanningTeamCapacity(workGroup, fixVersion);
  const cards = [];
  const matchedAssignedKeys = new Set();

  members.forEach((member) => {
    const displayName = String(member?.displayName || "").trim();
    if (!displayName) return;
    const aliases = planningPersonAliasKeys(displayName);
    let assigned = 0;
    aliases.forEach((alias) => {
      if (!assignedByPerson.has(alias)) return;
      assigned += Number(assignedByPerson.get(alias) || 0);
      matchedAssignedKeys.add(alias);
    });

    const capacity = planningComputeMemberCapacity(member);
    const fullCapacity = Number(capacity.full || 0);
    const usedPercent = planningCapacityPercent(assigned, fullCapacity);
    const buffer = Math.max(0, fullCapacity - assigned);
    const overload = Math.max(0, assigned - fullCapacity);
    const statusClass = planningCapacityStatusClass(assigned, fullCapacity);
    const safePercent = usedPercent.toFixed(1);

    cards.push({
      displayName,
      assigned,
      fullCapacity,
      buffer,
      overload,
      usedPercent: safePercent,
      statusClass,
    });
  });

  assignedByPerson.forEach((assigned, assigneeKey) => {
    if (matchedAssignedKeys.has(assigneeKey)) return;
    if (!assigneeKey) return;
    cards.push({
      displayName: assigneeKey.split(" ").map((part) => part ? part[0].toUpperCase() + part.slice(1) : "").join(" "),
      assigned,
      fullCapacity: 0,
      buffer: 0,
      overload: assigned,
      usedPercent: "0.0",
      statusClass: "no-capacity",
    });
  });

  cards.sort((a, b) => String(a.displayName || "").localeCompare(String(b.displayName || "")));

  const totalAssigned = cards.reduce((sum, item) => sum + Number(item.assigned || 0), 0);
  const totalCapacity = cards.reduce((sum, item) => sum + Number(item.fullCapacity || 0), 0);

  const cardsHtml = cards.length
    ? cards.map((item) => {
        const pieStyle = `--used:${item.usedPercent};`;
        const fullLabel = formatCapacityValue(item.fullCapacity);
        const assignedLabel = formatEstimationValue(item.assigned);
        const bufferLabel = formatCapacityValue(item.buffer);
        const overloadLabel = formatCapacityValue(item.overload);
        return `
          <div class="pi-capacity-card ${item.statusClass}">
            <div class="pi-capacity-person">${escapeHtml(item.displayName)}</div>
            <div class="pi-capacity-pie-wrap">
              <div class="pi-capacity-pie" style="${pieStyle}" title="Assigned ${escapeHtml(assignedLabel)} of ${escapeHtml(fullLabel)}"></div>
              <div class="pi-capacity-pie-label">${escapeHtml(item.usedPercent)}%</div>
            </div>
            <div class="pi-capacity-meta">Load: ${escapeHtml(assignedLabel)} / Capacity: ${escapeHtml(fullLabel)}</div>
            <div class="pi-capacity-meta">Buffer: ${escapeHtml(bufferLabel)}${item.overload > 0 ? ` | Overload: ${escapeHtml(overloadLabel)}` : ""}</div>
          </div>
        `;
      }).join("")
    : '<div class="pi-capacity-empty">No Team Capacity members found for selected Team + PI.</div>';

  const totalUsagePercent = totalCapacity > 0 ? Math.max(0, (totalAssigned / totalCapacity) * 100) : 0;
  const totalUsageLabel = Number.isFinite(totalUsagePercent) ? totalUsagePercent.toFixed(1) : "0.0";

  host.innerHTML = `
    <div class="pi-capacity-summary-header">
      <h3>Story load</h3>
      <div class="pi-load-switcher-wrap" role="group" aria-label="Load mode switcher">
        <span class="pi-load-switcher-label">Mode:</span>
        <button type="button" class="pi-load-switch-btn ${loadMode === "stories" ? "active" : ""}" data-load-mode="stories" aria-pressed="${loadMode === "stories" ? "true" : "false"}">Stories</button>
        <button type="button" class="pi-load-switch-btn ${loadMode === "features" ? "active" : ""}" data-load-mode="features" aria-pressed="${loadMode === "features" ? "true" : "false"}">Features</button>
      </div>
      <div class="pi-capacity-summary-totals">Total load: ${escapeHtml(formatEstimationValue(totalAssigned))} / Total capacity: ${escapeHtml(formatCapacityValue(totalCapacity))} (${escapeHtml(totalUsageLabel)}%)</div>
    </div>
    <div class="pi-capacity-grid">${cardsHtml}</div>
  `;

  host.querySelectorAll('.pi-load-switch-btn[data-load-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = String(btn.getAttribute('data-load-mode') || '').trim();
      setPlanningLoadMode(mode);
      renderCommittedSummary(committed, containerId);
    });
  });
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

function roadmapShowEmptyCapabilitiesStorageKey() {
  return `roadmapShowEmptyCapabilities::${getSelectedWorkGroup() || ""}`;
}

function roadmapQsFilterStorageKey() {
  return `roadmapQsFilter::${getSelectedWorkGroup() || ""}`;
}

function capabilityOrderStorageKey() {
  return `capabilityOrderMode::${getSelectedWorkGroup() || ""}`;
}

function getCapabilityOrderMode() {
  const el = document.getElementById("capability-order-priority");
  if (el instanceof HTMLInputElement) {
    return el.checked ? "priority" : "default";
  }
  const raw = String(localStorage.getItem(capabilityOrderStorageKey()) || "default").trim().toLowerCase();
  return raw === "priority" ? "priority" : "default";
}

function restoreCapabilityOrderMode() {
  const el = document.getElementById("capability-order-priority");
  if (!(el instanceof HTMLInputElement)) return;
  const raw = String(localStorage.getItem(capabilityOrderStorageKey()) || "default").trim().toLowerCase();
  el.checked = raw === "priority";
}

function persistCapabilityOrderMode() {
  localStorage.setItem(capabilityOrderStorageKey(), getCapabilityOrderMode());
}

function getRoadmapShowEmptyCapabilities() {
  const el = document.getElementById("roadmap-show-empty-capabilities") || document.getElementById("roadmap-toggle-empty-capabilities");
  if (el instanceof HTMLInputElement) return el.checked;
  return true;
}

function restoreRoadmapShowEmptyCapabilities() {
  const el = document.getElementById("roadmap-show-empty-capabilities") || document.getElementById("roadmap-toggle-empty-capabilities");
  if (!(el instanceof HTMLInputElement)) return;
  const raw = localStorage.getItem(roadmapShowEmptyCapabilitiesStorageKey());
  if (raw === "0") el.checked = false;
  else el.checked = true;
}

function persistRoadmapShowEmptyCapabilities() {
  localStorage.setItem(roadmapShowEmptyCapabilitiesStorageKey(), getRoadmapShowEmptyCapabilities() ? "1" : "0");
}

function getRoadmapQsFilter() {
  const el = document.getElementById("roadmap-qs-filter");
  if (el instanceof HTMLSelectElement) return String(el.value || "").trim();
  return String(localStorage.getItem(roadmapQsFilterStorageKey()) || "").trim();
}

function restoreRoadmapQsFilter() {
  const el = document.getElementById("roadmap-qs-filter");
  if (!(el instanceof HTMLSelectElement)) return;
  const saved = String(localStorage.getItem(roadmapQsFilterStorageKey()) || "").trim();
  el.dataset.pendingValue = saved;
}

function persistRoadmapQsFilter() {
  localStorage.setItem(roadmapQsFilterStorageKey(), getRoadmapQsFilter());
}

function syncRoadmapQsFilterOptions(qsValues = []) {
  const el = document.getElementById("roadmap-qs-filter");
  if (!(el instanceof HTMLSelectElement)) return "";

  const wanted = new Set((Array.isArray(qsValues) ? qsValues : []).map(v => String(v || "").trim()).filter(Boolean));
  const pending = String(el.dataset.pendingValue || "").trim();
  const current = String(el.value || "").trim();
  const saved = String(localStorage.getItem(roadmapQsFilterStorageKey()) || "").trim();
  const preferred = pending || current || saved;

  el.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "All";
  el.appendChild(allOpt);

  const ordered = Array.from(wanted).sort((a, b) => {
    const ma = a.match(/^QS_(\d{2})w(\d{2})$/i);
    const mb = b.match(/^QS_(\d{2})w(\d{2})$/i);
    const ra = ma ? (2000 + Number(ma[1])) * 100 + Number(ma[2]) : Number.MAX_SAFE_INTEGER;
    const rb = mb ? (2000 + Number(mb[1])) * 100 + Number(mb[2]) : Number.MAX_SAFE_INTEGER;
    return ra - rb;
  });

  ordered.forEach((qs) => {
    const opt = document.createElement("option");
    opt.value = qs;
    opt.textContent = qs;
    el.appendChild(opt);
  });

  el.value = wanted.has(preferred) ? preferred : "";
  el.dataset.pendingValue = "";
  return String(el.value || "").trim();
}

function ensureRoadmapCapabilitiesTooltip() {
  let tip = document.getElementById("roadmap-capabilities-tooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "roadmap-capabilities-tooltip";
    tip.className = "roadmap-capabilities-tooltip hidden";
    document.body.appendChild(tip);
  }
  return tip;
}

function bindRoadmapCapabilitiesCounterHover() {
  const counter = document.getElementById("capabilities-count");
  if (!(counter instanceof HTMLElement) || counter.dataset.hoverBound === "1") return;
  counter.dataset.hoverBound = "1";

  const showTip = (ev) => {
    const details = String(counter.dataset.fullSummary || "").trim();
    if (!details) return;
    const tip = ensureRoadmapCapabilitiesTooltip();
    tip.textContent = details;
    tip.classList.remove("hidden");
    const x = Number(ev?.clientX || 0);
    const y = Number(ev?.clientY || 0);
    tip.style.left = `${Math.max(8, x + 12)}px`;
    tip.style.top = `${Math.max(8, y + 12)}px`;
  };

  const moveTip = (ev) => {
    const tip = document.getElementById("roadmap-capabilities-tooltip");
    if (!(tip instanceof HTMLElement) || tip.classList.contains("hidden")) return;
    const x = Number(ev?.clientX || 0);
    const y = Number(ev?.clientY || 0);
    tip.style.left = `${Math.max(8, x + 12)}px`;
    tip.style.top = `${Math.max(8, y + 12)}px`;
  };

  const hideTip = () => {
    const tip = document.getElementById("roadmap-capabilities-tooltip");
    if (!(tip instanceof HTMLElement)) return;
    tip.classList.add("hidden");
  };

  counter.addEventListener("mouseenter", showTip);
  counter.addEventListener("mousemove", moveTip);
  counter.addEventListener("mouseleave", hideTip);
  counter.addEventListener("blur", hideTip);
}

function ensureRoadmapQsLoadTooltip() {
  let tip = document.getElementById("roadmap-qs-load-tooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "roadmap-qs-load-tooltip";
    tip.className = "roadmap-qs-load-tooltip hidden";
    document.body.appendChild(tip);
  }
  return tip;
}

function bindRoadmapQsMetaHover(host) {
  if (!(host instanceof HTMLElement)) return;
  const metas = Array.from(host.querySelectorAll(".roadmap-qs-meta[data-team-breakdown-json]"));
  if (!metas.length) return;

  const showTip = (ev) => {
    const target = ev.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const encoded = String(target.getAttribute("data-team-breakdown-json") || "").trim();
    if (!encoded) return;
    let rows = [];
    try {
      rows = JSON.parse(decodeURIComponent(encoded));
    } catch {
      rows = [];
    }
    if (!Array.isArray(rows) || !rows.length) return;

    const tip = ensureRoadmapQsLoadTooltip();
    tip.innerHTML = rows.map((row) => {
      const name = escapeHtml(String(row?.name || ""));
      const text = escapeHtml(String(row?.text || ""));
      const cls = String(row?.levelClass || "roadmap-qs-meta--green");
      return `<div class="roadmap-qs-breakdown-row"><span class="roadmap-qs-breakdown-name">${name}</span><span class="roadmap-qs-breakdown-badge ${cls}">${text}</span></div>`;
    }).join("");
    tip.classList.remove("hidden");
    const x = Number(ev?.clientX || 0);
    const y = Number(ev?.clientY || 0);
    tip.style.left = `${Math.max(8, x + 12)}px`;
    tip.style.top = `${Math.max(8, y + 12)}px`;
  };

  const moveTip = (ev) => {
    const tip = document.getElementById("roadmap-qs-load-tooltip");
    if (!(tip instanceof HTMLElement) || tip.classList.contains("hidden")) return;
    const x = Number(ev?.clientX || 0);
    const y = Number(ev?.clientY || 0);
    tip.style.left = `${Math.max(8, x + 12)}px`;
    tip.style.top = `${Math.max(8, y + 12)}px`;
  };

  const hideTip = () => {
    const tip = document.getElementById("roadmap-qs-load-tooltip");
    if (!(tip instanceof HTMLElement)) return;
    tip.classList.add("hidden");
  };

  metas.forEach((meta) => {
    meta.addEventListener("mouseenter", showTip);
    meta.addEventListener("mousemove", moveTip);
    meta.addEventListener("mouseleave", hideTip);
    meta.addEventListener("blur", hideTip);
  });
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

function capabilityLabelWithLeadingGroup(key, summary, leadingWorkGroup, priority) {
  const capabilityKey = (key || "").trim();
  const capabilitySummary = (summary || "").trim();
  const capabilityPriority = (priority || "").trim();
  const baseLabel = capabilityKey
    ? `${capabilityKey} — ${capabilitySummary || capabilityKey}`
    : (capabilitySummary || "No Capability");
  const withPriority = capabilityPriority ? `${baseLabel} [P: ${capabilityPriority}]` : baseLabel;
  const group = (leadingWorkGroup || "").trim();
  return group ? `${withPriority} (${group})` : withPriority;
}

function capabilityLabelToHtml(label) {
  const raw = String(label || "");
  const match = raw.match(/\[P:\s*([^\]]+)\]/i);
  if (!match) return escapeHtml(raw);

  const before = raw.slice(0, match.index || 0).trimEnd();
  const after = raw.slice((match.index || 0) + match[0].length).trimStart();
  const prio = roadmapPriorityStyle(match[1]);
  const badge = `<span class="roadmap-capability-prio-chip" style="--cap-prio-bg: ${prio.background}; --cap-prio-fg: ${prio.textColor};" title="Capability priority">P${escapeHtml(String(prio.priority))}</span>`;

  let html = `${escapeHtml(before)} ${badge}`;
  if (after) html += ` ${escapeHtml(after)}`;
  return html;
}

function roadmapPriorityNumber(priorityRaw) {
  if (typeof priorityRaw === "number" && Number.isFinite(priorityRaw)) {
    const n = Math.round(priorityRaw);
    return Math.max(1, Math.min(10, n));
  }

  const text = String(priorityRaw || "").trim();
  if (!text) return 10;

  const numMatch = text.match(/(?:^|\D)(10|[1-9])(?!\d)/);
  if (numMatch) {
    const n = Number(numMatch[1]);
    if (Number.isFinite(n)) return Math.max(1, Math.min(10, n));
  }

  const t = text.toLowerCase();
  if (/(highest|blocker|critical|urgent)/.test(t)) return 1;
  if (/high/.test(t)) return 3;
  if (/medium|normal/.test(t)) return 5;
  if (/low/.test(t) && !/lowest/.test(t)) return 8;
  if (/(lowest|minor|trivial)/.test(t)) return 10;
  return 10;
}

function roadmapPriorityStyle(priorityRaw) {
  const p = roadmapPriorityNumber(priorityRaw);
  const palette = [
    "#c71f1f", // 1
    "#d63a28", // 2
    "#e85a2f", // 3
    "#f07b35", // 4
    "#e79f3f", // 5
    "#c2a44a", // 6
    "#8aa15f", // 7
    "#5f9d7f", // 8
    "#3f8ea3", // 9
    "#2f75d6", // 10
  ];
  const background = palette[Math.max(1, Math.min(10, p)) - 1];
  const textColor = p >= 5 && p <= 7 ? "#1f2937" : "#ffffff";
  return { priority: p, background, textColor };
}

function roadmapComputeCapacityFromPayload(payload) {
  const members = Array.isArray(payload?.members) ? payload.members : [];
  let total = 0;
  const teammateRows = [];

  members.forEach((member) => {
    let memberTotal = 0;
    TEAM_CAPACITY_SPRINTS.forEach((sprint) => {
      const weeks = Array.isArray(member?.weekValues?.[sprint]) ? member.weekValues[sprint] : [];
      weeks.forEach((weekValue) => {
        const n = Number(weekValue || 0);
        total += n;
        memberTotal += n;
      });
    });

    const memberName = String(member?.displayName || "").trim();
    if (!memberName) return;
    const safeMemberTotal = Number.isFinite(memberTotal) ? memberTotal : 0;
    teammateRows.push({
      name: memberName,
      email: String(member?.emailAddress || "").trim(),
      total: safeMemberTotal,
      full: safeMemberTotal * 0.8,
      planned: safeMemberTotal * 0.6,
    });
  });

  const safeTotal = Number.isFinite(total) ? total : 0;
  return {
    total: safeTotal,
    full: safeTotal * 0.8,
    planned: safeTotal * 0.6,
    teammates: teammateRows,
  };
}

function roadmapQsFixVersionsFromSettings(settings) {
  const src = Array.isArray(settings?.fix_versions) ? settings.fix_versions : [];
  const out = [];
  const seen = new Set();

  src.forEach((value) => {
    const fixVersion = String(value || "").trim();
    if (!/^QS_\d{2}w\d{2}$/i.test(fixVersion)) return;
    const key = fixVersion.toUpperCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(fixVersion);
  });

  return out;
}

async function loadRoadmapCapacityByFixVersion(workGroup, forceRefresh = false) {
  if (!workGroup) return {};

  let settings = null;
  try {
    settings = await fetchAppSettings();
  } catch {
    settings = defaultAppSettings();
  }

  const qsFixVersions = roadmapQsFixVersionsFromSettings(settings);
  if (!qsFixVersions.length) return {};

  const pairs = await Promise.all(qsFixVersions.map(async (fixVersion) => {
    try {
      const url = `/team_capacity_data?workGroup=${encodeURIComponent(workGroup)}&fixVersion=${encodeURIComponent(fixVersion)}`;
      const cacheKey = makeCacheKey("teamCapacityData", { workGroup, fixVersion });
      const json = await fetchJsonWithClientCache(url, cacheKey, forceRefresh);
      const payload = json?.ok ? (json?.data || {}) : {};
      return [fixVersion, roadmapComputeCapacityFromPayload(payload)];
    } catch {
      return [fixVersion, { total: 0, full: 0, planned: 0 }];
    }
  }));

  return Object.fromEntries(pairs);
}

function bindRoadmapDragAndDrop(host) {
  const bars = Array.from(host.querySelectorAll(".roadmap-bar-draggable[data-feature-id]"));
  const qsBands = Array.from(host.querySelectorAll(".roadmap-qs-band[data-week-key]"));
  const futureTarget = host.querySelector(".roadmap-future-header[data-drop-target='future']");
  const dropTargets = futureTarget ? [...qsBands, futureTarget] : [...qsBands];
  if (!bars.length || !dropTargets.length) return;
  const previewCells = Array.from(host.querySelectorAll("[data-cell-week][data-feature-row]"));

  const clearPreview = () => {
    dropTargets.forEach((b) => b.classList.remove("roadmap-drop-preview"));
    previewCells.forEach((c) => c.classList.remove("roadmap-drop-preview-cell"));
  };

  const previewWeeksForTarget = (targetEl) => {
    if (!targetEl) return [];
    const isFuture = String(targetEl.getAttribute("data-drop-target") || "").toLowerCase() === "future";
    if (isFuture) return ["FUTURE"];
    const startWeekKey = String(targetEl.getAttribute("data-week-key") || "").trim();
    const parsed = parseWeekKey(startWeekKey);
    if (!parsed) return [];
    const end = getQsPeriodEnd(parsed.year, parsed.week);
    return buildWeekRange(startWeekKey, makeWeekKey(end.year, end.week));
  };

  const applyCellPreview = (targetEl, featureId) => {
    const weeks = new Set(previewWeeksForTarget(targetEl));
    if (!weeks.size) return;
    previewCells.forEach((cell) => {
      if (String(cell.getAttribute("data-feature-row") || "") !== String(featureId || "")) return;
      const wk = String(cell.getAttribute("data-cell-week") || "").trim();
      if (weeks.has(wk)) cell.classList.add("roadmap-drop-preview-cell");
    });
  };

  const nearestBand = (clientX) => {
    let best = null;
    let bestDist = Number.POSITIVE_INFINITY;
    dropTargets.forEach((band) => {
      const rect = band.getBoundingClientRect();
      const center = rect.left + rect.width / 2;
      const d = Math.abs(center - clientX);
      if (d < bestDist) {
        bestDist = d;
        best = band;
      }
    });
    return best;
  };

  const pending = roadmapPendingMoves();

  bars.forEach((bar) => {
    bar.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      const featureId = String(bar.getAttribute("data-feature-id") || "").trim();
      if (!featureId) return;

      const dragGhost = bar.cloneNode(true);
      dragGhost.classList.add("roadmap-drag-ghost");
      dragGhost.classList.remove("roadmap-bar-grabbed", "roadmap-bar-drag-origin");
      document.body.appendChild(dragGhost);
      const moveGhost = (x, y) => {
        dragGhost.style.left = `${x + 14}px`;
        dragGhost.style.top = `${y + 14}px`;
      };

      let activeBand = nearestBand(ev.clientX);
      if (activeBand) {
        activeBand.classList.add("roadmap-drop-preview");
        applyCellPreview(activeBand, featureId);
      }
      bar.classList.add("roadmap-bar-grabbed");
      bar.classList.add("roadmap-bar-drag-origin");
      moveGhost(ev.clientX, ev.clientY);

      const onMove = (moveEv) => {
        const next = nearestBand(moveEv.clientX);
        if (next !== activeBand) {
          clearPreview();
          activeBand = next;
          if (activeBand) {
            activeBand.classList.add("roadmap-drop-preview");
            applyCellPreview(activeBand, featureId);
          }
        }
        moveGhost(moveEv.clientX, moveEv.clientY);
      };

      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);

        bar.classList.remove("roadmap-bar-grabbed");
        bar.classList.remove("roadmap-bar-drag-origin");
        dragGhost.remove();
        const isFutureDrop = String(activeBand?.getAttribute("data-drop-target") || "").toLowerCase() === "future";
        const targetWeekKey = String(activeBand?.getAttribute("data-week-key") || "").trim();
        clearPreview();

        const feature = host._roadmapData?.[featureId];
        if (!feature) return;
        const currentQs = parseQsFixVersionLatest(feature?.fixVersions || [], feature?.archived_fixVersions || [])?.raw || "";

        if (isFutureDrop) {
          if (!currentQs) {
            const existing = pending.get(featureId) || {};
            existing.fixDirty = false;
            existing.toFuture = false;
            existing.targetFixVersion = "";
            const keepOtherDirty =
              (existing.priorityDirty === true && Number.isInteger(existing.targetPriority)) ||
              (existing.estimationDirty === true && Number.isInteger(existing.targetEstimation)) ||
              (existing.assigneeDirty === true && !!String(existing.targetAssigneeName || "").trim());
            if (keepOtherDirty) pending.set(featureId, existing);
            else pending.delete(featureId);
          } else {
            const existing = pending.get(featureId) || {};
            existing.toFuture = true;
            existing.targetFixVersion = "";
            existing.fixDirty = true;
            pending.set(featureId, existing);
          }
          updateRoadmapPendingUi();
          renderBacklogRoadmap(host._roadmapData || {}, host._capabilitiesData || [], host._roadmapCapacityByFixVersion || {});
          return;
        }

        if (!targetWeekKey) return;

        const targetFixVersion = qsFixVersionFromWeekKey(targetWeekKey);
        if (!targetFixVersion) return;

        if (currentQs === targetFixVersion) {
          const existing = pending.get(featureId) || {};
          existing.fixDirty = false;
          existing.toFuture = false;
          existing.targetFixVersion = "";
          const keepOtherDirty =
            (existing.priorityDirty === true && Number.isInteger(existing.targetPriority)) ||
            (existing.estimationDirty === true && Number.isInteger(existing.targetEstimation)) ||
            (existing.assigneeDirty === true && !!String(existing.targetAssigneeName || "").trim());
          if (keepOtherDirty) pending.set(featureId, existing);
          else pending.delete(featureId);
        } else {
          const existing = pending.get(featureId) || {};
          existing.targetFixVersion = targetFixVersion;
          existing.toFuture = false;
          existing.fixDirty = true;
          pending.set(featureId, existing);
        }

        updateRoadmapPendingUi();
        renderBacklogRoadmap(host._roadmapData || {}, host._capabilitiesData || [], host._roadmapCapacityByFixVersion || {});
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
      ev.preventDefault();
    });
  });

  host.querySelectorAll(".roadmap-bar-feature[data-feature-id]").forEach((bar) => {
    bar.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const featureId = String(bar.getAttribute("data-feature-id") || "").trim();
      if (!featureId) return;
      showRoadmapContextMenu(featureId, ev.clientX, ev.clientY);
    });
  });
}

function renderBacklogRoadmap(featuresObj, capabilitiesList = [], roadmapCapacityByFixVersion = {}) {
  const host = document.getElementById("backlog-roadmap");
  if (!host) return;
  host._roadmapData = featuresObj || {};
  host._capabilitiesData = Array.isArray(capabilitiesList) ? capabilitiesList : [];
  host._roadmapCapacityByFixVersion = roadmapCapacityByFixVersion && typeof roadmapCapacityByFixVersion === "object"
    ? roadmapCapacityByFixVersion
    : {};
  const capabilitiesCountEl = document.getElementById("capabilities-count");
  const hasSavedCollapseState = restoreRoadmapCollapseState();
  const showEmptyCapabilities = getRoadmapShowEmptyCapabilities();
  const capabilityOrderMode = getCapabilityOrderMode();

  const entries = Object.entries(featuresObj || {});
  const capabilityItems = Array.isArray(capabilitiesList) ? capabilitiesList : [];
  const capabilityMetaByKey = new Map();
  capabilityItems.forEach((cap) => {
    const key = (cap?.key || "").trim();
    if (!key) return;
    capabilityMetaByKey.set(key, {
      summary: (cap?.summary || "").trim(),
      leadingWorkGroup: (cap?.leading_work_group || "").trim(),
      created: (cap?.created || "").trim(),
      priority: (cap?.priority || "").trim(),
    });
  });
  if (!entries.length && !capabilityItems.length) {
    host.innerHTML = '<div class="roadmap-empty">No backlog items to display.</div>';
    return;
  }

  const items = [];
  const availableQsSet = new Set();
  const qsLoadByFixVersion = new Map();
  const qsLoadByFixVersionByAssignee = new Map();
  const pendingMoves = roadmapPendingMoves();
  for (const [featureId, feature] of entries) {
    let slot = roadmapSlotForFeature(feature);
    const pending = pendingMoves.get(featureId);
    const pendingFixVersion = String(pending?.targetFixVersion || "").trim();
    const pendingToFuture = Boolean(pending?.toFuture);
    const pendingMatch = pendingFixVersion.match(/^QS_(\d{2})w(\d{2})$/i);
    if (pendingToFuture) {
      slot = {
        startKey: "FUTURE",
        endKey: "FUTURE",
        isFuture: true,
        periodLabel: "Future (pending)",
      };
    } else if (pendingMatch) {
      const year = 2000 + Number(pendingMatch[1]);
      const week = Number(pendingMatch[2]);
      const end = getQsPeriodEnd(year, week);
      slot = {
        startKey: makeWeekKey(year, week),
        endKey: makeWeekKey(end.year, end.week),
        isFuture: false,
        periodLabel: `${pendingFixVersion} (pending)`,
      };
    }
    const capabilityKey = (feature?.parent_link || "").trim();
    const capabilityMeta = capabilityKey ? capabilityMetaByKey.get(capabilityKey) : null;
    const capabilitySummary = (capabilityMeta?.summary || feature?.parent_summary || capabilityKey || "").trim();
    const capabilityLeadingGroup = (capabilityMeta?.leadingWorkGroup || feature?.parent_leading_work_group || "").trim();
    const capabilityPriority = (capabilityMeta?.priority || feature?.parent_priority || "").trim();
    const capLabel = capabilityLabelWithLeadingGroup(
      capabilityKey,
      capabilitySummary,
      capabilityLeadingGroup,
      capabilityPriority
    );
    const effectivePriority = Number.isInteger(pending?.targetPriority)
      ? Number(pending.targetPriority)
      : feature?.priority;
    const effectiveStoryPoints = Number.isInteger(pending?.targetEstimation)
      ? Number(pending.targetEstimation)
      : feature?.story_points;
    const effectiveAssignee = String(pending?.targetAssigneeName || "").trim() || String(feature?.assignee || "").trim();
    const effectivePiScope = pending?.piScopeDirty === true
      ? normalizePiScopeValue(pending?.targetPiScope)
      : normalizePiScopeValue(feature?.pi_scope);
    items.push({
      featureId,
      feature,
      effectivePriority,
      effectiveStoryPoints,
      effectiveAssignee,
      effectivePiScope,
      capabilityKey,
      capability: capLabel,
      isMovable: !roadmapStatusLockedForMove(feature?.status),
      isPendingMove: pendingToFuture || !!pendingMatch,
      isPendingPriority: Number.isInteger(pending?.targetPriority),
      isPendingEstimation: Number.isInteger(pending?.targetEstimation),
      isPendingAssignee: pending?.assigneeDirty === true && !!String(pending?.targetAssigneeName || "").trim(),
      isPendingPiScope: pending?.piScopeDirty === true,
      startKey: slot.startKey,
      endKey: slot.endKey,
      isFuture: slot.isFuture,
      periodLabel: slot.periodLabel,
    });

    if (!slot.isFuture) {
      const slotFixVersion = qsFixVersionFromWeekKey(slot.startKey);
      if (slotFixVersion) {
        availableQsSet.add(slotFixVersion);
        const current = Number(qsLoadByFixVersion.get(slotFixVersion) || 0);
        const featureLoad = Number(effectiveStoryPoints || 0);
        qsLoadByFixVersion.set(slotFixVersion, current + (Number.isFinite(featureLoad) ? featureLoad : 0));

        const assigneeKey = String(effectiveAssignee || "").trim().toLowerCase();
        if (assigneeKey && assigneeKey !== "unassigned") {
          if (!qsLoadByFixVersionByAssignee.has(slotFixVersion)) {
            qsLoadByFixVersionByAssignee.set(slotFixVersion, new Map());
          }
          const byAssignee = qsLoadByFixVersionByAssignee.get(slotFixVersion);
          const prev = Number(byAssignee.get(assigneeKey) || 0);
          byAssignee.set(assigneeKey, prev + (Number.isFinite(featureLoad) ? featureLoad : 0));
        }
      }
    }
  }

  const selectedQsFilter = syncRoadmapQsFilterOptions(Array.from(availableQsSet));
  const visibleItems = selectedQsFilter
    ? items.filter((it) => {
        if (it?.isFuture) return false;
        const fv = qsFixVersionFromWeekKey(it?.startKey);
        return String(fv || "").trim() === selectedQsFilter;
      })
    : items;

  const qsFixVersionRank = (fixVersion) => {
    const m = String(fixVersion || "").trim().match(/^QS_(\d{2})w(\d{2})$/i);
    if (!m) return null;
    const year = 2000 + Number(m[1]);
    const week = Number(m[2]);
    if (!Number.isFinite(year) || !Number.isFinite(week)) return null;
    return year * 100 + week;
  };

  const getCurrentQsFixVersion = () => {
    const now = getIsoWeekParts(new Date());
    const starts = [10, 22, 37, 49];
    let year = Number(now.year);
    let startWeek = 49;

    if (Number(now.week) >= 10) {
      startWeek = 10;
      starts.forEach((w) => {
        if (Number(now.week) >= w) startWeek = w;
      });
    } else {
      year -= 1;
      startWeek = 49;
    }

    return `QS_${String(year).slice(-2)}w${String(startWeek).padStart(2, "0")}`;
  };

  const currentQsRank = qsFixVersionRank(getCurrentQsFixVersion());

  const qsHeaderWithLoadCapacity = (label, fixVersion) => {
    const safeFixVersion = String(fixVersion || "").trim();
    const headerQsRank = qsFixVersionRank(safeFixVersion);
    if (headerQsRank != null && currentQsRank != null && headerQsRank < currentQsRank) {
      return `${escapeHtml(label)}`;
    }

    const load = Number(qsLoadByFixVersion.get(safeFixVersion) || 0);
    const plannedCapacity = Number(host._roadmapCapacityByFixVersion?.[safeFixVersion]?.planned || 0);
    const fullCapacity = Number(host._roadmapCapacityByFixVersion?.[safeFixVersion]?.full || 0);
    const teammateCapacity = Array.isArray(host._roadmapCapacityByFixVersion?.[safeFixVersion]?.teammates)
      ? host._roadmapCapacityByFixVersion[safeFixVersion].teammates
      : [];
    const teammateLoadMap = qsLoadByFixVersionByAssignee.get(safeFixVersion) || new Map();

    const teammateRows = [];
    const seenAssignees = new Set();

    teammateCapacity.forEach((row) => {
      const teammateName = String(row?.name || "").trim();
      if (!teammateName) return;
      const teammateKey = teammateName.toLowerCase();
      seenAssignees.add(teammateKey);
      const teammateLoad = Number(teammateLoadMap.get(teammateKey) || 0);
      const teammatePlanned = Number(row?.planned || 0);
      const teammateFull = Number(row?.full || 0);
      let teammateLevelClass = "roadmap-qs-meta--green";
      if (teammateLoad > teammateFull) teammateLevelClass = "roadmap-qs-meta--red";
      else if (teammateLoad > teammatePlanned) teammateLevelClass = "roadmap-qs-meta--yellow";
      teammateRows.push({
        name: teammateName,
        levelClass: teammateLevelClass,
        text: `Load: ${formatCapacityValue(teammateLoad)} / Cap: ${formatCapacityValue(teammatePlanned)}(${formatCapacityValue(teammateFull)})`,
      });
    });

    teammateLoadMap.forEach((value, teammateKey) => {
      if (seenAssignees.has(teammateKey)) return;
      const teammateName = teammateKey.split(" ").map(x => x ? x[0].toUpperCase() + x.slice(1) : "").join(" ");
      const teammateLoad = Number(value || 0);
      teammateRows.push({
        name: teammateName || "Unknown",
        levelClass: teammateLoad > 0 ? "roadmap-qs-meta--red" : "roadmap-qs-meta--green",
        text: `Load: ${formatCapacityValue(teammateLoad)} / Cap: 0(0)`,
      });
    });

    teammateRows.sort((a, b) => String(a?.name || "").localeCompare(String(b?.name || "")));

    let levelClass = "roadmap-qs-meta--green";
    if (load > fullCapacity) levelClass = "roadmap-qs-meta--red";
    else if (load > plannedCapacity) levelClass = "roadmap-qs-meta--yellow";
    const breakdownJson = teammateRows.length ? encodeURIComponent(JSON.stringify(teammateRows)) : "";
    const breakdownAttr = breakdownJson ? ` data-team-breakdown-json="${escapeHtml(breakdownJson)}"` : "";
    const hasBreakdownClass = breakdownJson ? " has-breakdown" : "";
    return `${escapeHtml(label)}<span class="roadmap-qs-meta ${levelClass}${hasBreakdownClass}"${breakdownAttr}>Load: ${escapeHtml(formatCapacityValue(load))} / Cap: ${escapeHtml(formatCapacityValue(plannedCapacity))}(${escapeHtml(formatCapacityValue(fullCapacity))})</span>`;
  };

  const datedItems = visibleItems.filter(i => !i.isFuture);
  const hasFutureItems = visibleItems.some(i => i.isFuture);
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

  timelineSlots.push({ type: "future", year: "Future", isYearStart: true });

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
  const capabilityCreatedByLabel = new Map();
  const capabilityPriorityByLabel = new Map();
  const officialCapabilityLabels = new Set();

  capabilityItems.forEach((cap) => {
    const key = (cap?.key || "").trim();
    const summary = (cap?.summary || "").trim();
    const groupedLabel = capabilityLabelWithLeadingGroup(key, summary, cap?.leading_work_group || "", cap?.priority || "");
    if (!byCapability.has(groupedLabel)) byCapability.set(groupedLabel, []);
    const created = (cap?.created || "").trim();
    if (created && !capabilityCreatedByLabel.has(groupedLabel)) {
      capabilityCreatedByLabel.set(groupedLabel, created);
    }
    const rawPriority = String(cap?.priority || "").trim();
    if (rawPriority && !capabilityPriorityByLabel.has(groupedLabel)) {
      capabilityPriorityByLabel.set(groupedLabel, roadmapPriorityNumber(rawPriority));
    }
    officialCapabilityLabels.add(groupedLabel);
  });

  visibleItems.forEach(it => {
    const capKey = (it.capabilityKey || "").trim();
    const capMeta = capKey ? capabilityMetaByKey.get(capKey) : null;
    const featureSummary = (it.feature?.parent_summary || capKey || "No Capability").trim();
    const featureLeadingGroup = (it.feature?.parent_leading_work_group || "").trim();
    const groupLabel = capabilityLabelWithLeadingGroup(
      capKey,
      capMeta?.summary || featureSummary,
      capMeta?.leadingWorkGroup || featureLeadingGroup,
      capMeta?.priority || it?.feature?.parent_priority || ""
    );
    if (!byCapability.has(groupLabel)) byCapability.set(groupLabel, []);
    byCapability.get(groupLabel).push(it);
    const created = (capMeta?.created || it?.feature?.parent_created || "").trim();
    if (created && !capabilityCreatedByLabel.has(groupLabel)) {
      capabilityCreatedByLabel.set(groupLabel, created);
    }
    if (!capabilityPriorityByLabel.has(groupLabel)) {
      const rawPriority = String(capMeta?.priority || it?.feature?.parent_priority || "").trim();
      if (rawPriority) capabilityPriorityByLabel.set(groupLabel, roadmapPriorityNumber(rawPriority));
    }
  });

  if (capabilitiesCountEl) {
    const selectedWorkGroup = (getSelectedWorkGroup() || "").trim();
    const officialKeys = new Set();
    const groups = new Map();

    const ensureGroup = (groupName) => {
      const key = (groupName || "").trim() || "Unspecified";
      if (!groups.has(key)) {
        groups.set(key, { total: new Set(), withFeatures: new Set() });
      }
      return groups.get(key);
    };

    capabilityItems.forEach((cap) => {
      const capKey = (cap?.key || "").trim();
      if (!capKey) return;
      const grp = ensureGroup(cap?.leading_work_group || selectedWorkGroup || "Unspecified");
      grp.total.add(capKey);
      officialKeys.add(capKey);
    });

    visibleItems.forEach((it) => {
      const capKey = (it?.capabilityKey || "").trim();
      if (!capKey) return;
      const capMeta = capabilityMetaByKey.get(capKey);
      const leadingGroup = (capMeta?.leadingWorkGroup || it?.feature?.parent_leading_work_group || selectedWorkGroup || "").trim() || "Unspecified";
      const grp = ensureGroup(leadingGroup);
      if (!officialKeys.has(capKey)) grp.total.add(capKey);
      grp.withFeatures.add(capKey);
    });

    const order = Array.from(groups.keys()).sort((a, b) => {
      if (a === selectedWorkGroup) return -1;
      if (b === selectedWorkGroup) return 1;
      if (a === "Unspecified") return 1;
      if (b === "Unspecified") return -1;
      return a.localeCompare(b);
    });

    const summary = order
      .map((name) => {
        const row = groups.get(name);
        return `${name}: ${row.total.size}`;
      })
      .join("; ");

    const totalCapabilities = new Set();
    order.forEach((name) => {
      const row = groups.get(name);
      if (!row) return;
      row.total.forEach((capKey) => totalCapabilities.add(capKey));
    });

    capabilitiesCountEl.textContent = `Capabilities: ${totalCapabilities.size}`;
    capabilitiesCountEl.dataset.fullSummary = summary;
    capabilitiesCountEl.title = "";
  }

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
  const qsHeaderCells = [];
  let carryOverQs49CellIndex = -1;

  yearHeaderBands.forEach((band) => {
    const yy = String(band.year).slice(-2);
    const slotStartCol = band.startSlotIdx + 2;

    if (band.isCollapsed) {
      carryOverQs49CellIndex = -1;
      qsHeaderCells.push({
        startCol: slotStartCol,
        span: band.count,
        classes: "roadmap-header roadmap-qs-header roadmap-year-sep",
        weekKey: "",
        content: escapeHtml(`${yy}QS`),
      });
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
      carryOverQs49CellIndex = -1;
      qsHeaderCells.push({
        startCol: slotStartCol,
        span: band.count,
        classes: "roadmap-header roadmap-qs-header roadmap-year-sep",
        weekKey: "",
        content: "",
      });
      return;
    }

    const firstQsSlot = qsStarts[0].slotIdx;
    if (firstQsSlot > band.startSlotIdx) {
      const leadingSpan = firstQsSlot - band.startSlotIdx;
      if (carryOverQs49CellIndex >= 0 && qsHeaderCells[carryOverQs49CellIndex]) {
        qsHeaderCells[carryOverQs49CellIndex].span += leadingSpan;
      } else {
        const prevYearYY = String(Number(band.year) - 1).slice(-2);
        const leadingLabel = `${prevYearYY}QS49`;
        const leadingFixVersion = `QS_${prevYearYY}w49`;
        qsHeaderCells.push({
          startCol: band.startSlotIdx + 2,
          span: leadingSpan,
          classes: "roadmap-header roadmap-qs-header roadmap-qs-band",
          weekKey: "",
          content: qsHeaderWithLoadCapacity(leadingLabel, leadingFixVersion),
        });
      }
    }

    for (let i = 0; i < qsStarts.length; i += 1) {
      const start = qsStarts[i];
      const next = qsStarts[i + 1];
      const endSlot = next ? (next.slotIdx - 1) : (band.startSlotIdx + band.count - 1);
      const span = Math.max(1, endSlot - start.slotIdx + 1);
      const label = `${yy}QS${String(start.week).padStart(2, "0")}`;
      const fixVersion = `QS_${yy}w${String(start.week).padStart(2, "0")}`;
      const sepClass = start.slotIdx === band.startSlotIdx ? " roadmap-year-sep" : "";
      const weekKeyAttr = (timelineSlots[start.slotIdx]?.weekKey || "");
      qsHeaderCells.push({
        startCol: start.slotIdx + 2,
        span,
        classes: `roadmap-header roadmap-qs-header roadmap-qs-band${sepClass}`,
        weekKey: weekKeyAttr,
        content: qsHeaderWithLoadCapacity(label, fixVersion),
      });

      if (!next && start.week === 49) carryOverQs49CellIndex = qsHeaderCells.length - 1;
      else carryOverQs49CellIndex = -1;
    }
  });

  qsHeaderCells.forEach((cell) => {
    const weekKeyData = cell.weekKey ? ` data-week-key="${escapeHtml(cell.weekKey)}"` : "";
    html += `<div class="${cell.classes}"${weekKeyData} style="grid-column: ${cell.startCol} / span ${cell.span}; grid-row: 2;">${cell.content}</div>`;
  });

  timelineSlots.forEach((slot, slotIdx) => {
    const gridCol = slotIdx + 2;
    if (slot.type === "future") {
      html += `<div class="roadmap-header roadmap-future-header" data-drop-target="future" data-cell-week="FUTURE" style="grid-column: ${gridCol}; grid-row: span 3;">Future</div>`;
      return;
    }

    if (slot.type === "year") {
      html += `<div class="roadmap-header roadmap-week-header roadmap-year-collapsed-cell ${slot.isYearStart ? "roadmap-year-sep" : ""}" style="grid-column: ${gridCol}; grid-row: 3;">…</div>`;
      return;
    }

    const wk = parseWeekKey(slot.weekKey)?.week;
    const wkLabel = wk ? String(wk).padStart(2, "0") : slot.weekKey;
    const qsClass = slot.isQsStart ? " roadmap-qs-sep" : "";
    html += `<div class="roadmap-header roadmap-week-header ${slot.isYearStart ? "roadmap-year-sep" : ""}${qsClass}" data-cell-week="${escapeHtml(slot.weekKey)}" style="grid-column: ${gridCol}; grid-row: 3;">${escapeHtml(wkLabel)}</div>`;
  });

  const capabilityEntries = Array.from(byCapability.entries())
    .sort((a, b) => {
      const selectedWorkGroup = (getSelectedWorkGroup() || "").trim().toLowerCase();
      const aLabel = (a[0] || "").trim().toLowerCase();
      const bLabel = (b[0] || "").trim().toLowerCase();
      const isBottomLabel = (label) => label === "capability" || label.startsWith("no capability");
      const extractLeadingGroup = (label) => {
        const m = (label || "").match(/\(([^()]*)\)\s*$/);
        return m ? (m[1] || "").trim().toLowerCase() : "";
      };
      const extractId = (label) => {
        const clean = (label || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
        const dashIdx = clean.indexOf("—");
        if (dashIdx >= 0) return clean.slice(0, dashIdx).trim().toLowerCase();
        return clean.toLowerCase();
      };
      const parseIdParts = (id) => {
        const m = (id || "").match(/^([a-z]+)-?(\d+)$/i);
        if (!m) return { prefix: id || "", number: Number.MAX_SAFE_INTEGER };
        return { prefix: (m[1] || "").toLowerCase(), number: Number(m[2]) };
      };

      const aBottom = isBottomLabel(aLabel);
      const bBottom = isBottomLabel(bLabel);
      if (aBottom && !bBottom) return 1;
      if (!aBottom && bBottom) return -1;

      const aSelected = selectedWorkGroup && extractLeadingGroup(a[0]) === selectedWorkGroup;
      const bSelected = selectedWorkGroup && extractLeadingGroup(b[0]) === selectedWorkGroup;
      if (capabilityOrderMode !== "priority") {
        if (aSelected && !bSelected) return -1;
        if (!aSelected && bSelected) return 1;
      }

      if (capabilityOrderMode === "priority") {
        const aPrio = capabilityPriorityByLabel.has(a[0]) ? Number(capabilityPriorityByLabel.get(a[0])) : Number.POSITIVE_INFINITY;
        const bPrio = capabilityPriorityByLabel.has(b[0]) ? Number(capabilityPriorityByLabel.get(b[0])) : Number.POSITIVE_INFINITY;
        if (aPrio !== bPrio) return aPrio - bPrio;
      }

      const parseCreatedMs = (label) => {
        const raw = capabilityCreatedByLabel.get(label);
        if (!raw) return Number.POSITIVE_INFINITY;
        const ms = Date.parse(raw);
        return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
      };
      const aCreated = parseCreatedMs(a[0]);
      const bCreated = parseCreatedMs(b[0]);
      if (aCreated !== bCreated) return aCreated - bCreated;

      const aId = extractId(a[0]);
      const bId = extractId(b[0]);
      const aParts = parseIdParts(aId);
      const bParts = parseIdParts(bId);
      const byNumber = aParts.number - bParts.number;
      if (byNumber !== 0) return byNumber;
      const byPrefix = aParts.prefix.localeCompare(bParts.prefix);
      if (byPrefix !== 0) return byPrefix;
      return a[0].localeCompare(b[0]);
    });

  const visibleCapabilityEntries = showEmptyCapabilities
    ? capabilityEntries
    : capabilityEntries.filter(([, capItems]) => Array.isArray(capItems) && capItems.length > 0);

  let featureDisplayIndex = 1;
  visibleCapabilityEntries
    .forEach(([capability, capItems], capIndex) => {
      const isCollapsed = roadmapCollapsedCapabilities.has(capability);
      const capabilityAttr = encodeURIComponent(capability);
      const arrow = isCollapsed ? "▶" : "▼";
      html += `<div class="roadmap-capability roadmap-capability-toggle" data-capability="${capabilityAttr}" style="grid-column: 1 / span ${timelineCols + 1};"><span class="roadmap-capability-arrow">${arrow}</span><span class="roadmap-capability-index">${capIndex + 1}.</span><span>${capabilityLabelToHtml(capability)}</span><span class="roadmap-capability-count">(${capItems.length})</span></div>`;

      capItems.sort((a, b) => {
        const pa = roadmapPriorityNumber(a?.effectivePriority);
        const pb = roadmapPriorityNumber(b?.effectivePriority);
        if (pa !== pb) return pa - pb;
        return a.featureId.localeCompare(b.featureId);
      });

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
            const wk = timelineSlots[idx]?.type === "week" ? (timelineSlots[idx]?.weekKey || "") : (timelineSlots[idx]?.type === "future" ? "FUTURE" : "");
            const wkAttr = wk ? ` data-cell-week="${escapeHtml(wk)}"` : "";
            html += `<div class="roadmap-cell roadmap-summary-cell${sepClass}${qsClass}"${wkAttr}></div>`;
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
        const prio = roadmapPriorityStyle(item.effectivePriority);
        const storyPointsRaw = item.effectiveStoryPoints;
        const storyPoints = Number.isFinite(Number(storyPointsRaw)) ? Number(storyPointsRaw) : 0;
        const storyPointsLabel = Number.isInteger(storyPoints) ? String(storyPoints) : String(storyPoints.toFixed(1));

        const activeSlots = timelineSlots.map((slot) => {
          if (item.isFuture) return slot.type === "future";
          if (slot.type === "future") return false;
          if (slot.type === "week") return slot.weekIdx >= startWeek && slot.weekIdx <= endWeek;
          return !(endWeek < slot.startWeekIdx || startWeek > slot.endWeekIdx);
        });

        const label = `${item.featureId} — ${item.feature?.summary || ""}`;
        html += `<div class="roadmap-feature-col" data-feature-row="${escapeHtml(item.featureId)}" title="${escapeHtml(label)}"><span class="roadmap-feature-index">${featureDisplayIndex}.</span> <a href="https://jira-vira.volvocars.biz/browse/${encodeURIComponent(item.featureId)}" target="_blank">${escapeHtml(item.featureId)}</a> ${escapeHtml(item.feature?.summary || "")}</div>`;
        featureDisplayIndex += 1;
        let idx = 0;
        while (idx < timelineCols) {
          if (!activeSlots[idx]) {
            const sepClass = timelineSlots[idx]?.isYearStart ? " roadmap-year-sep" : "";
            const qsClass = timelineSlots[idx]?.isQsStart ? " roadmap-qs-sep" : "";
            const wk = timelineSlots[idx]?.type === "week" ? (timelineSlots[idx]?.weekKey || "") : (timelineSlots[idx]?.type === "future" ? "FUTURE" : "");
            const wkAttr = wk ? ` data-cell-week="${escapeHtml(wk)}"` : "";
            html += `<div class="roadmap-cell${sepClass}${qsClass}" data-feature-row="${escapeHtml(item.featureId)}"${wkAttr}></div>`;
            idx += 1;
            continue;
          }
          let endIdx = idx;
          while (endIdx + 1 < timelineCols && activeSlots[endIdx + 1]) endIdx += 1;
          const span = endIdx - idx + 1;
          const prioLabel = item.isPendingPriority
            ? `Priority ${prio.priority} (pending)`
            : `Priority ${prio.priority}`;
          const titleText = item.isFuture
            ? "Future"
            : `${item.periodLabel || "QS"}: ${item.startKey} → ${item.endKey} | ${prioLabel} | Commitment ${item.effectivePiScope || "None"} | Assignee ${item.effectiveAssignee || "Unassigned"} | Story Points ${storyPointsLabel}`;
          const sepClass = timelineSlots[idx]?.isYearStart ? " roadmap-year-sep" : "";
          const qsClass = timelineSlots[idx]?.isQsStart ? " roadmap-qs-sep" : "";
          const style = `grid-column: ${idx + 2} / span ${span}; --bar-color: ${prio.background}; color: ${prio.textColor};`;
          const moveClass = item.isMovable ? " roadmap-bar-draggable" : " roadmap-bar-locked";
          const pendingClass = (item.isPendingMove || item.isPendingPriority || item.isPendingEstimation || item.isPendingAssignee || item.isPendingPiScope) ? " roadmap-bar-pending" : "";
          const pendingPrioClass = item.isPendingPriority ? " roadmap-bar-pending-priority" : "";
          const assigneeFull = String(item.effectiveAssignee || "Unassigned").trim() || "Unassigned";
          const assigneeLabel = escapeHtml(roadmapAssigneeShortName(assigneeFull) || assigneeFull);
          const commitmentLabel = escapeHtml(item.effectivePiScope || "None");
          html += `<div class="roadmap-bar roadmap-bar-feature${sepClass}${qsClass}${moveClass}${pendingClass}${pendingPrioClass}" data-feature-id="${escapeHtml(item.featureId)}" data-feature-row="${escapeHtml(item.featureId)}" data-cell-week="${item.isFuture ? "FUTURE" : escapeHtml(item.startKey)}" data-movable="${item.isMovable ? "1" : "0"}" style="${style}" title="${escapeHtml(titleText)}"><span class="roadmap-bar-priority" title="Priority">P${prio.priority}</span><span class="roadmap-bar-commitment" title="Commitment">${commitmentLabel}</span><span class="roadmap-bar-assignee" title="Assignee: ${escapeHtml(assigneeFull)}">${assigneeLabel}</span><span class="roadmap-bar-estimate" title="Story points">SP ${escapeHtml(storyPointsLabel)}</span></div>`;
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
        renderBacklogRoadmap(host._roadmapData || {}, host._capabilitiesData || [], host._roadmapCapacityByFixVersion || {});
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
      renderBacklogRoadmap(host._roadmapData || {}, host._capabilitiesData || [], host._roadmapCapacityByFixVersion || {});
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
      renderBacklogRoadmap(host._roadmapData || {}, host._capabilitiesData || [], host._roadmapCapacityByFixVersion || {});
    });
  });

  bindRoadmapQsMetaHover(host);
  bindRoadmapDragAndDrop(host);
  updateRoadmapPendingUi();
  updateStickyLayoutOffsets();
}

async function loadBacklogData(forceRefresh = false) {
  showLoading();
  try {
    const workGroup = getSelectedWorkGroup();
    if (!workGroup) return;

    const url = `/backlog_data?workGroup=${encodeURIComponent(workGroup)}${forceRefresh ? "&forceRefresh=1" : ""}`;
    const capabilitiesUrl = `/capabilities_data?workGroup=${encodeURIComponent(workGroup)}${forceRefresh ? "&forceRefresh=1" : ""}`;
    const cacheKey = makeCacheKey("backlogDataV3", { workGroup });
    const capabilitiesCacheKey = makeCacheKey("capabilitiesDataV3", { workGroup });
    const [data, capabilities, roadmapCapacityByFixVersion] = await Promise.all([
      fetchJsonWithClientCache(url, cacheKey, forceRefresh),
      fetchJsonWithClientCache(capabilitiesUrl, capabilitiesCacheKey, forceRefresh),
      loadRoadmapCapacityByFixVersion(workGroup, forceRefresh),
    ]);

    const backlogTableHost = document.getElementById("backlog-table");
    if (backlogTableHost) backlogTableHost._rawBacklogData = data;

    renderBacklogRoadmap(data, capabilities, roadmapCapacityByFixVersion);

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
  { key: 'reporter', label: 'Reporter' },
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

  if (containerId === 'backlog-table') {
    togglesDiv.innerHTML = '';
    togglesDiv.style.display = 'none';
    renderBacklogColumnToggleMenu(sprints);
    return;
  }

  togglesDiv.style.display = '';

  const columns = [...piPlanningColumns.map(col => col.label), ...sprints];
  const forceHiddenColumns = (containerId === 'committed-table' || containerId === 'backlog-table') ? new Set([1]) : new Set();
  togglesDiv.innerHTML = '';
  columns.forEach((colLabel, idx) => {
    if (forceHiddenColumns.has(idx)) return;
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

function renderBacklogColumnToggleMenu(sprints) {
  const section = document.getElementById('capabilityColumnsSection');
  if (!section) return;

  section.querySelectorAll('.backlog-status-option[data-col-toggle="1"]').forEach((el) => el.remove());

  const title = section.querySelector('.backlog-column-toggle-title');
  if (title) title.textContent = 'Columns hide/show';

  const tableKey = 'backlog-table';
  const hidden = hiddenColumns[tableKey] || new Set();
  const sprintCount = Array.isArray(sprints) ? sprints.length : 0;
  const fixVersionColIndex = piPlanningColumns.length + sprintCount;

  const rows = [];
  piPlanningColumns.forEach((col, idx) => {
    rows.push({ idx, label: col.label });
  });
  rows.push({ idx: fixVersionColIndex, label: 'Fix Version' });

  rows.forEach(({ idx, label }) => {
    const row = document.createElement('label');
    row.className = 'backlog-status-option';
    row.setAttribute('data-col-toggle', '1');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !hidden.has(idx);
    checkbox.setAttribute('data-col-idx', String(idx));
    if (idx === 0) {
      checkbox.disabled = true;
      checkbox.checked = true;
    }

    const text = document.createElement('span');
    text.textContent = label;

    checkbox.addEventListener('change', () => {
      if (idx === 0) return;
      if (checkbox.checked) hiddenColumns[tableKey].delete(idx);
      else hiddenColumns[tableKey].add(idx);
      window._rerenderFeatureTable(tableKey, Array.isArray(sprints) ? sprints : []);
      renderBacklogColumnToggleMenu(Array.isArray(sprints) ? sprints : []);
      applyFilter();
    });

    row.appendChild(checkbox);
    row.appendChild(text);
    section.appendChild(row);
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
  container._treeSprints = Array.isArray(sprints) ? [...sprints] : [];

  const isBacklogTable = containerId === 'backlog-table' && (!Array.isArray(sprints) || sprints.length === 0);
  const isCommittedTable = containerId === 'committed-table';
  const isCapabilityGroupedTable = isBacklogTable || isCommittedTable;
  const includeBacklogFixVersionColumn = isBacklogTable;
  const backlogFixVersionColIndex = piPlanningColumns.length + ((Array.isArray(sprints) ? sprints.length : 0));
  const capabilityOrderMode = getCapabilityOrderMode();
  if (isCommittedTable) restoreCommittedTreeCollapseState();

  const renderedFeatures = isCapabilityGroupedTable
    ? [...(Array.isArray(features) ? features : [])].sort((a, b) => {
        const featureA = a?.[1] || {};
        const featureB = b?.[1] || {};
        const capabilityA = `${featureA.parent_link || ''} ${featureA.parent_summary || ''}`.trim().toLowerCase();
        const capabilityB = `${featureB.parent_link || ''} ${featureB.parent_summary || ''}`.trim().toLowerCase();
        const aHasCapability = capabilityA.length > 0;
        const bHasCapability = capabilityB.length > 0;
        if (aHasCapability !== bHasCapability) return aHasCapability ? -1 : 1;

        let byCapability = 0;
        if (isBacklogTable && capabilityOrderMode === "priority") {
          const capPrioA = String(featureA.parent_priority || "").trim();
          const capPrioB = String(featureB.parent_priority || "").trim();
          const capPrioNumA = capPrioA ? roadmapPriorityNumber(capPrioA) : Number.POSITIVE_INFINITY;
          const capPrioNumB = capPrioB ? roadmapPriorityNumber(capPrioB) : Number.POSITIVE_INFINITY;
          if (capPrioNumA !== capPrioNumB) byCapability = capPrioNumA - capPrioNumB;
        }
        if (byCapability === 0) byCapability = capabilityA.localeCompare(capabilityB);
        if (byCapability !== 0) return byCapability;

        const featurePrioA = roadmapPriorityNumber(featureA.priority);
        const featurePrioB = roadmapPriorityNumber(featureB.priority);
        if (featurePrioA !== featurePrioB) return featurePrioA - featurePrioB;

        return String(a?.[0] || '').localeCompare(String(b?.[0] || ''));
      })
    : features;

  if (isCommittedTable) {
    const hasSavedFeatureCollapseState = localStorage.getItem(committedFeatureCollapseStorageKey()) != null;
    if (!hasSavedFeatureCollapseState) {
      committedCollapsedFeatures = new Set(
        (Array.isArray(renderedFeatures) ? renderedFeatures : [])
          .map((row) => String(row?.[0] || '').trim())
          .filter(Boolean)
      );
      persistCommittedTreeCollapseState();
    }
  }

  container._features = renderedFeatures;
  renderColumnToggles(containerId, sprints);

  const hidden = new Set(hiddenColumns[containerId] || []);
  if (isCommittedTable || isBacklogTable) hidden.add(1);
  const backlogColumnFilterState = isBacklogTable ? getBacklogColumnFilterState() : {};
  const backlogFilterOptionsByKey = {
    assignee: new Set(),
    reporter: new Set(),
    status: new Set(),
    piscope: new Set(),
    fixversions: new Set(),
  };

  if (isBacklogTable) {
    renderedFeatures.forEach(([, feature]) => {
      const assignee = String(feature?.assignee || '').trim();
      const reporter = String(feature?.reporter || '').trim();
      const status = String(feature?.status || '').trim();
      const piScope = String(feature?.pi_scope || '').trim();
      const fixVersionsText = Array.isArray(feature?.fixVersions) ? feature.fixVersions.join(', ').trim() : '';
      if (assignee) backlogFilterOptionsByKey.assignee.add(assignee);
      if (reporter) backlogFilterOptionsByKey.reporter.add(reporter);
      if (status) backlogFilterOptionsByKey.status.add(status);
      if (piScope) backlogFilterOptionsByKey.piscope.add(piScope);
      if (fixVersionsText) backlogFilterOptionsByKey.fixversions.add(fixVersionsText);
    });
  }

  const columnClasses = [
    'col-rownum',
    'col-capability',
    'col-feature-id',
    'col-feature-name',
    'col-story-points',
    'col-story-points',
    'col-assignee',
    'col-reporter',
    'col-priority',
    'col-status',
    'col-pi-scope',
    'col-links'
  ];

  let tableHtml = `<table class="pi-planning-table${isCapabilityGroupedTable ? ' capability-grouped-table' : ''}"><thead><tr>`;
  const headerLabels = ['#','Capability','Feature ID','Feature name','Feature Est.','Stories est. sum','Assignee','Reporter','Prio','Status','PI Scope','Links'];
  const visibleColumnKeys = [];
  for (let idx = 0; idx < headerLabels.length; idx += 1) {
    const label = headerLabels[idx];
    if (!hidden.has(idx)) {
      if (idx === 3 && !hidden.has(4) && !hidden.has(5)) {
        visibleColumnKeys.push(
          String(piPlanningColumns[3]?.key || 'col_3'),
          String(piPlanningColumns[4]?.key || 'col_4'),
          String(piPlanningColumns[5]?.key || 'col_5')
        );
        const mergedHead = '<div class="feature-merged-header"><span class="feature-merged-left">Feature name</span><span class="feature-merged-right-group"><span class="feature-merged-sep">|</span><span>Feature Est.</span><span class="feature-merged-sep">|</span><span>Stories est. sum</span></span></div>';
        tableHtml += `<th class="col-feature-merged-head" colspan="3" data-sort-col="3" onclick="sortTable(this)">${mergedHead}</th>`;
        idx = 5;
        continue;
      }
      const colKey = String(piPlanningColumns[idx]?.key || `col_${idx}`);
      visibleColumnKeys.push(colKey);
      const sortAttr = ' onclick="sortTable(this)"';
      if (isBacklogTable && BACKLOG_SELECT_FILTER_KEYS.has(colKey)) {
        const selectedValues = Array.isArray(backlogColumnFilterState[colKey])
          ? backlogColumnFilterState[colKey].map((x) => String(x || '').trim()).filter(Boolean)
          : [];
        const selectedSet = new Set(selectedValues);
        const options = Array.from(backlogFilterOptionsByKey[colKey] || [])
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        if (colKey === 'fixversions') options.reverse();
        const optionsHtml = options.map((opt) => {
          const checked = selectedSet.has(opt) ? ' checked' : '';
          return `<label class="backlog-col-filter-option"><input type="checkbox" value="${escapeHtml(opt)}"${checked} /><span>${escapeHtml(opt)}</span></label>`;
        }).join('');
        const btnText = backlogFilterButtonText(colKey, selectedValues, options.length);
        const actionsHtml = `<div class="backlog-col-filter-actions"><button type="button" class="backlog-col-filter-action-btn" data-action="reset">Reset</button></div>`;
        const dropdownHtml = `<div class="backlog-col-filter-dropdown" data-filter-key="${escapeHtml(colKey)}" data-options-count="${options.length}"><button type="button" class="backlog-col-filter-btn" title="${escapeHtml(backlogFilterTitleByKey(colKey))} selected count">${escapeHtml(btnText)}</button><div class="backlog-col-filter-menu">${actionsHtml}${optionsHtml || '<div class="backlog-col-filter-empty">No values</div>'}</div></div>`;
        tableHtml += `<th class="${columnClasses[idx]} backlog-head-filter-cell"${sortAttr}><div class="backlog-head-filter-inline"><span>${label}</span>${dropdownHtml}</div></th>`;
      } else {
        tableHtml += `<th class="${columnClasses[idx]}"${sortAttr}>${label}</th>`;
      }
    }
  }
  sprints.forEach((sprint, i) => {
    if (!hidden.has(piPlanningColumns.length + i))
      tableHtml += `<th class="story-cell">${sprint}</th>`;
  });
  if (includeBacklogFixVersionColumn && !hidden.has(backlogFixVersionColIndex)) {
    visibleColumnKeys.push('fixversions');
    if (isBacklogTable && BACKLOG_SELECT_FILTER_KEYS.has('fixversions')) {
      const selectedValues = Array.isArray(backlogColumnFilterState.fixversions)
        ? backlogColumnFilterState.fixversions.map((x) => String(x || '').trim()).filter(Boolean)
        : [];
      const selectedSet = new Set(selectedValues);
      const options = Array.from(backlogFilterOptionsByKey.fixversions || [])
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      options.reverse();
      const optionsHtml = options.map((opt) => {
        const checked = selectedSet.has(opt) ? ' checked' : '';
        return `<label class="backlog-col-filter-option"><input type="checkbox" value="${escapeHtml(opt)}"${checked} /><span>${escapeHtml(opt)}</span></label>`;
      }).join('');
      const btnText = backlogFilterButtonText('fixversions', selectedValues, options.length);
      const actionsHtml = `<div class="backlog-col-filter-actions"><button type="button" class="backlog-col-filter-action-btn" data-action="reset">Reset</button></div>`;
      const dropdownHtml = `<div class="backlog-col-filter-dropdown" data-filter-key="fixversions" data-options-count="${options.length}"><button type="button" class="backlog-col-filter-btn" title="Fix Version selected count">${escapeHtml(btnText)}</button><div class="backlog-col-filter-menu">${actionsHtml}${optionsHtml || '<div class="backlog-col-filter-empty">No values</div>'}</div></div>`;
      tableHtml += `<th class="col-fix-versions backlog-head-filter-cell" onclick="sortTable(this)"><div class="backlog-head-filter-inline"><span>Fix Version</span>${dropdownHtml}</div></th>`;
    } else {
      tableHtml += `<th class="col-fix-versions" onclick="sortTable(this)">Fix Version</th>`;
    }
  }
  tableHtml += '</tr>';

  tableHtml += '</thead><tbody>';

  let rowIndex = 1;
  const visibleBaseColumnCount = headerLabels.reduce((count, _, idx) => count + (hidden.has(idx) ? 0 : 1), 0);
  const visibleSprintCount = (Array.isArray(sprints) ? sprints : []).reduce((count, _, i) => count + (hidden.has(piPlanningColumns.length + i) ? 0 : 1), 0);
  const visibleExtraColumns = (includeBacklogFixVersionColumn && !hidden.has(backlogFixVersionColIndex)) ? 1 : 0;
  const visibleColumnCount = visibleBaseColumnCount + visibleSprintCount + visibleExtraColumns;
  let previousCapabilityBlock = null;

  for (const [featureId, feature] of renderedFeatures) {
    if (isCapabilityGroupedTable) {
      const capabilityKey = (feature.parent_link || '').trim();
      const capabilitySummary = (feature.parent_summary || '').trim();
      const capabilityLeadingGroup = (feature.parent_leading_work_group || '').trim();
      const capabilityPriority = (feature.parent_priority || '').trim();
      const capabilityBlockKey = `${capabilityKey}||${capabilitySummary}||${capabilityLeadingGroup}||${capabilityPriority}`;
      if (capabilityBlockKey !== previousCapabilityBlock) {
        const label = capabilityLabelWithLeadingGroup(
          capabilityKey,
          capabilitySummary || capabilityKey,
          capabilityLeadingGroup,
          capabilityPriority
        );
        const capabilityStableId = capabilityKey || label;
        if (capabilityKey) {
          if (isCommittedTable) {
            tableHtml += `<tr class="capability-block-row" data-row-kind="capability" data-capability-id="${escapeHtml(capabilityStableId)}"><td colspan="${visibleColumnCount}"><button type="button" class="committed-cap-toggle" data-capability-id="${escapeHtml(capabilityStableId)}" title="Collapse/expand capability">▼</button><a href="https://jira-vira.volvocars.biz/browse/${escapeHtml(capabilityKey)}" target="_blank" rel="noopener noreferrer">${capabilityLabelToHtml(label)}</a></td></tr>`;
          } else {
            tableHtml += `<tr class="capability-block-row"><td colspan="${visibleColumnCount}"><a href="https://jira-vira.volvocars.biz/browse/${escapeHtml(capabilityKey)}" target="_blank" rel="noopener noreferrer">${capabilityLabelToHtml(label)}</a></td></tr>`;
          }
        } else {
          if (isCommittedTable) {
            tableHtml += `<tr class="capability-block-row" data-row-kind="capability" data-capability-id="${escapeHtml(capabilityStableId)}"><td colspan="${visibleColumnCount}"><button type="button" class="committed-cap-toggle" data-capability-id="${escapeHtml(capabilityStableId)}" title="Collapse/expand capability">▼</button>${capabilityLabelToHtml(label)}</td></tr>`;
          } else {
            tableHtml += `<tr class="capability-block-row"><td colspan="${visibleColumnCount}">${capabilityLabelToHtml(label)}</td></tr>`;
          }
        }
        previousCapabilityBlock = capabilityBlockKey;
      }
    }

    const rowStatus = (feature.status || "").replace(/"/g, '&quot;');
    const capabilityLeadingGroup = (feature.parent_leading_work_group || '').trim();
    const capabilityPriority = (feature.parent_priority || '').trim();
    const capabilityLabel = capabilityLabelWithLeadingGroup(
      (feature.parent_link || '').trim(),
      ((feature.parent_summary || '').trim() || (feature.parent_link || '').trim() || 'No Capability'),
      capabilityLeadingGroup,
      capabilityPriority
    );
    const capabilityStableId = (feature.parent_link || '').trim() || capabilityLabel;
    const capabilityKeyAttr = escapeHtml((feature.parent_link || '').trim());
    const storiesDetail = Array.isArray(feature.stories_detail) ? feature.stories_detail : [];
    const storySearchTokens = storiesDetail.map((story) => String(story?.key || '').trim()).filter(Boolean).join(' ').toLowerCase();
    tableHtml += `<tr data-row-kind="feature" data-feature-id="${escapeHtml(featureId)}" data-status="${rowStatus}" data-capability-id="${escapeHtml(capabilityStableId)}" data-capability-block="${escapeHtml(capabilityLabel)}" data-capability-key="${capabilityKeyAttr}" data-story-search="${escapeHtml(storySearchTokens)}">`;
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
    if (!hidden.has(colIdx++)) {
      const treeToggle = isCommittedTable
        ? `<button type="button" class="committed-feature-toggle" data-feature-id="${escapeHtml(featureId)}" title="Collapse/expand stories">▼</button>`
        : "";
      tableHtml += `<td class="col-feature-name">${treeToggle}<a href="https://jira-vira.volvocars.biz/browse/${featureId}" target="_blank">${feature.summary}</a></td>`;
    }
    if (!hidden.has(colIdx++)) {
      let sp = feature.story_points ?? "";
      if (sp !== "" && !isNaN(Number(sp))) sp = formatEstimationValue(sp);
      tableHtml += `<td class="col-story-points">${sp !== "" ? sp : ""}</td>`;
    }
    if (!hidden.has(colIdx++)) {
      let total = feature.sum_story_points ?? "";
      if (total !== "" && !isNaN(Number(total))) total = formatEstimationValue(total);
      tableHtml += `<td class="col-story-points">${total !== "" ? total : ""}</td>`;
    }
    if (!hidden.has(colIdx++))
      tableHtml += `<td class="col-assignee">${feature.assignee || ""}</td>`;
    if (!hidden.has(colIdx++))
      tableHtml += `<td class="col-reporter">${feature.reporter || ""}</td>`;
    if (!hidden.has(colIdx++)) {
      const rawPriority = String(feature.priority || '').trim();
      const priorityText = rawPriority.toLowerCase() === 'not set' ? 'NS' : rawPriority;
      tableHtml += `<td class="col-priority">${escapeHtml(priorityText)}</td>`;
    }
    if (!hidden.has(colIdx++))
      tableHtml += `<td class="col-status">${feature.status || ""}</td>`;
    if (!hidden.has(colIdx++))
      tableHtml += `<td class="col-pi-scope">${feature.pi_scope || ""}</td>`;
    if (!hidden.has(colIdx++)) {
      const linksArr = feature.linked_issues || [];
      const linksHtml = linksArr
        .map((link) => {
          const url = String(link?.url || '').trim();
          const key = String(link?.key || '').trim();
          if (!url || !key) return '';
          return `<a class="compact-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(key)}</a>`;
        })
        .filter(Boolean)
        .join(', ');
      tableHtml += `<td class="col-links">${linksHtml}</td>`;
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

    if (includeBacklogFixVersionColumn && !hidden.has(backlogFixVersionColIndex)) {
      const fixVersionsText = Array.isArray(feature.fixVersions) ? feature.fixVersions.join(", ") : "";
      tableHtml += `<td class="col-fix-versions">${fixVersionsText}</td>`;
    }

    tableHtml += '</tr>';

    if (isCommittedTable) {
      const storySprintMap = new Map();
      sprints.forEach((sprintName) => {
        const arr = Array.isArray(feature?.sprints?.[sprintName]) ? feature.sprints[sprintName] : [];
        arr.forEach((storyKey) => {
          const key = String(storyKey || '').trim();
          if (!key) return;
          if (!storySprintMap.has(key)) storySprintMap.set(key, new Set());
          storySprintMap.get(key).add(sprintName);
        });
      });

      const sortedStories = [...storiesDetail]
        .filter((story) => String(story?.key || '').trim())
        .sort((a, b) => String(a?.key || '').localeCompare(String(b?.key || '')));

      sortedStories.forEach((story) => {
        const storyKey = String(story?.key || '').trim();
        const storySpRaw = story?.story_points;
        const storySpNum = Number(storySpRaw || 0);
        const storySpText = (storySpRaw === "" || storySpRaw == null)
          ? ""
          : (Number.isFinite(storySpNum) ? formatEstimationValue(storySpNum) : "");
        const storyAssignee = String(story?.assignee || '').trim();
        const storyStatus = String(story?.status || '').trim();
        const storySprints = storySprintMap.get(storyKey) || new Set();

        tableHtml += `<tr class="committed-story-row" data-row-kind="story" data-parent-feature-id="${escapeHtml(featureId)}" data-capability-id="${escapeHtml(capabilityStableId)}" data-status="${escapeHtml(storyStatus)}">`;
        let storyColIdx = 0;
        if (!hidden.has(storyColIdx++)) tableHtml += `<td class="col-rownum"></td>`;
        if (!hidden.has(storyColIdx++)) tableHtml += `<td class="col-capability"></td>`;
        if (!hidden.has(storyColIdx++)) tableHtml += `<td class="col-feature-id committed-story-id"><a href="https://jira-vira.volvocars.biz/browse/${escapeHtml(storyKey)}" target="_blank">↳ ${escapeHtml(storyKey)}</a></td>`;
        if (!hidden.has(storyColIdx++)) tableHtml += `<td class="col-feature-name committed-story-name">Story</td>`;
        if (!hidden.has(storyColIdx++)) tableHtml += `<td class="col-story-points">${escapeHtml(storySpText)}</td>`;
        if (!hidden.has(storyColIdx++)) tableHtml += `<td class="col-story-points"></td>`;
        if (!hidden.has(storyColIdx++)) tableHtml += `<td class="col-assignee">${escapeHtml(storyAssignee)}</td>`;
        if (!hidden.has(storyColIdx++)) tableHtml += `<td class="col-reporter"></td>`;
        if (!hidden.has(storyColIdx++)) tableHtml += `<td class="col-priority"></td>`;
        if (!hidden.has(storyColIdx++)) tableHtml += `<td class="col-status">${escapeHtml(storyStatus)}</td>`;
        if (!hidden.has(storyColIdx++)) tableHtml += `<td class="col-pi-scope"></td>`;
        if (!hidden.has(storyColIdx++)) tableHtml += `<td class="col-links"></td>`;

        sprints.forEach((sprintName, sprintIdx) => {
          if (!hidden.has(piPlanningColumns.length + sprintIdx)) {
            tableHtml += storySprints.has(sprintName)
              ? `<td class="story-cell committed-story-sprint">•</td>`
              : `<td class="story-cell"></td>`;
          }
        });

        tableHtml += '</tr>';
      });
    }

    rowIndex++;
  }

  if (containerId === 'committed-table' || containerId === 'backlog-table') {
    let totalFeatureSP = 0;
    let totalStoriesSP = 0;
    for (const [, feature] of renderedFeatures) {
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
    if (includeBacklogFixVersionColumn && !hidden.has(backlogFixVersionColIndex)) {
      tableHtml += `<td class="col-fix-versions"></td>`;
    }
    tableHtml += '</tr>';
  }

  tableHtml += '</tbody></table>';
  container.innerHTML = tableHtml;
  const renderedTable = container.querySelector("table");
  if (isBacklogTable && renderedTable instanceof HTMLTableElement) {
    renderedTable.dataset.visibleColumnKeys = JSON.stringify(visibleColumnKeys);
    bindBacklogColumnFilters(renderedTable);
  }
  if (isCommittedTable) {
    bindCommittedTreeToggles(containerId, sprints);
    applyCommittedTreeVisibility(renderedTable);
  }
  renumberVisibleRows(renderedTable);
  recalculateVisibleTotals(renderedTable);
  updateStickyLayoutOffsets();

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

function bindCommittedTreeToggles(containerId, sprints) {
  const container = document.getElementById(containerId);
  if (!container || containerId !== 'committed-table') return;
  if (container.dataset.treeBound === '1') return;
  container.dataset.treeBound = '1';

  container.addEventListener('click', (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;

    const capBtn = target.closest('.committed-cap-toggle[data-capability-id]');
    if (capBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      const capId = String(capBtn.getAttribute('data-capability-id') || '').trim();
      if (!capId) return;
      if (committedCollapsedCapabilities.has(capId)) committedCollapsedCapabilities.delete(capId);
      else committedCollapsedCapabilities.add(capId);
      persistCommittedTreeCollapseState();
      const nextSprints = Array.isArray(container._treeSprints) ? container._treeSprints : sprints;
      window._rerenderFeatureTable(containerId, nextSprints);
      applyFilter();
      return;
    }

    const featureBtn = target.closest('.committed-feature-toggle[data-feature-id]');
    if (featureBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      const featureId = String(featureBtn.getAttribute('data-feature-id') || '').trim();
      if (!featureId) return;
      if (committedCollapsedFeatures.has(featureId)) committedCollapsedFeatures.delete(featureId);
      else committedCollapsedFeatures.add(featureId);
      persistCommittedTreeCollapseState();
      const nextSprints = Array.isArray(container._treeSprints) ? container._treeSprints : sprints;
      window._rerenderFeatureTable(containerId, nextSprints);
      applyFilter();
    }
  });
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
  localStorage.setItem("selectedFixVersion", getSelectedFixVersion() || "");
  localStorage.setItem("selectedWorkGroup", getSelectedWorkGroup() || "");
}
function restoreDashboardSettings() {
  const fv = localStorage.getItem("selectedFixVersion");
  const wg = localStorage.getItem("selectedWorkGroup");
  if (fv) { const el = document.getElementById("fixVersionSelect"); if (el) el.value = fv; }
  if (wg) { const el = document.getElementById("workGroupSelect");  if (el) el.value = wg; }
  const fixEl = document.getElementById("fixVersionSelect");
  if (fixEl && !fixEl.value && fixEl.options.length) fixEl.value = fixEl.options[0].value;
  const wgEl = document.getElementById("workGroupSelect");
  if (wgEl && !wgEl.value && wgEl.options.length) wgEl.value = wgEl.options[0].value;
}
function saveBacklogSettings() {
  localStorage.setItem("selectedWorkGroup", getSelectedWorkGroup() || "");
}
function restoreBacklogSettings() {
  const wg = localStorage.getItem("selectedWorkGroup");
  if (wg) { const el = document.getElementById("workGroupSelect"); if (el) el.value = wg; }
  const wgEl = document.getElementById("workGroupSelect");
  if (wgEl && !wgEl.value && wgEl.options.length) wgEl.value = wgEl.options[0].value;
}

let settingsEditState = { fix_versions: [], work_groups: [] };
let settingsSavedSignature = "";
let settingsNoticeTimer = null;

function setSettingsStatus(message, kind = "info") {
  const el = document.getElementById("settings-status");
  if (!el) return;
  el.textContent = message || "";
  el.className = `team-capacity-status ${kind}`;
}

function settingsStateSignature(stateObj) {
  return JSON.stringify(normalizeAppSettings(stateObj || {}));
}

function settingsHasUnsavedChanges() {
  return settingsStateSignature(settingsEditState) !== settingsSavedSignature;
}

function updateSettingsSaveUi() {
  const saveBtn = document.getElementById("settings-save");
  const dirty = settingsHasUnsavedChanges();
  if (saveBtn) saveBtn.disabled = !dirty;
  if (dirty) setSettingsStatus("Unsaved changes.", "warning");
  else setSettingsStatus("No changes yet.", "info");
}

function showSettingsCenterNotice(message, kind = "success") {
  const el = document.getElementById("settings-center-notice");
  if (!el) return;
  el.textContent = message || "";
  el.className = `settings-center-notice ${kind === "error" ? "error" : ""}`.trim();
  if (settingsNoticeTimer) {
    clearTimeout(settingsNoticeTimer);
    settingsNoticeTimer = null;
  }
  settingsNoticeTimer = setTimeout(() => {
    el.classList.add("hidden");
    settingsNoticeTimer = null;
  }, 1800);
}

function renderSettingsFixList() {
  const host = document.getElementById("settings-fix-list");
  if (!host) return;
  const rows = settingsEditState.fix_versions.map((value, idx) => `
    <div class="settings-row">
      <input type="text" class="settings-row-input" data-fix-idx="${idx}" value="${escapeHtml(value)}" />
      <button type="button" class="team-capacity-remove" data-fix-remove="${idx}">Delete</button>
    </div>
  `).join("");
  host.innerHTML = rows || '<div class="team-capacity-empty">No Fix Versions configured.</div>';
}

function renderSettingsWgList() {
  const host = document.getElementById("settings-wg-list");
  if (!host) return;
  const rows = settingsEditState.work_groups.map((row, idx) => `
    <div class="settings-row settings-row-wg">
      <input type="text" class="settings-row-input" data-wg-leading="${idx}" value="${escapeHtml(row.leadingWorkGroup || "")}" placeholder="Leading Work Group" />
      <input type="text" class="settings-row-input" data-wg-team="${idx}" value="${escapeHtml(row.teamName || "")}" placeholder="Team Name" />
      <button type="button" class="team-capacity-remove" data-wg-remove="${idx}">Delete</button>
    </div>
  `).join("");
  host.innerHTML = rows || '<div class="team-capacity-empty">No Work Group mappings configured.</div>';
}

function renderSettingsLists() {
  renderSettingsFixList();
  renderSettingsWgList();
}

async function bindSettingsPage() {
  restorePlanningSettings();

  document.getElementById("fixVersionSelect")?.addEventListener("change", () => {
    savePlanningSettings();
    setSettingsStatus("Default Fix Version updated.", "info");
  });
  document.getElementById("workGroupSelect")?.addEventListener("change", () => {
    savePlanningSettings();
    setSettingsStatus("Default Team updated.", "info");
  });

  const settings = await fetchAppSettings(true);
  settingsEditState = normalizeAppSettings(settings);
  renderSettingsLists();
  settingsSavedSignature = settingsStateSignature(settingsEditState);
  updateSettingsSaveUi();

  document.getElementById("settings-fix-add")?.addEventListener("click", () => {
    const input = document.getElementById("settings-fix-input");
    if (!(input instanceof HTMLInputElement)) return;
    const value = String(input.value || "").trim();
    if (!value) return;
    settingsEditState.fix_versions.push(value);
    input.value = "";
    renderSettingsFixList();
    updateSettingsSaveUi();
  });

  document.getElementById("settings-wg-add")?.addEventListener("click", () => {
    const wgInput = document.getElementById("settings-wg-input");
    const teamInput = document.getElementById("settings-team-input");
    if (!(wgInput instanceof HTMLInputElement) || !(teamInput instanceof HTMLInputElement)) return;
    const leadingWorkGroup = String(wgInput.value || "").trim();
    const teamName = String(teamInput.value || "").trim();
    if (!leadingWorkGroup) return;
    settingsEditState.work_groups.push({ leadingWorkGroup, teamName: teamName || leadingWorkGroup });
    wgInput.value = "";
    teamInput.value = "";
    renderSettingsWgList();
    updateSettingsSaveUi();
  });

  document.getElementById("settings-fix-list")?.addEventListener("input", (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement)) return;
    const idx = Number(target.getAttribute("data-fix-idx"));
    if (!Number.isInteger(idx) || idx < 0 || idx >= settingsEditState.fix_versions.length) return;
    settingsEditState.fix_versions[idx] = String(target.value || "");
    updateSettingsSaveUi();
  });

  document.getElementById("settings-fix-list")?.addEventListener("click", (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const removeRaw = target.getAttribute("data-fix-remove");
    if (removeRaw == null) return;
    const idx = Number(removeRaw);
    if (!Number.isInteger(idx) || idx < 0 || idx >= settingsEditState.fix_versions.length) return;
    settingsEditState.fix_versions.splice(idx, 1);
    renderSettingsFixList();
    updateSettingsSaveUi();
  });

  document.getElementById("settings-wg-list")?.addEventListener("input", (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement)) return;
    const idxLeading = Number(target.getAttribute("data-wg-leading"));
    const idxTeam = Number(target.getAttribute("data-wg-team"));
    if (Number.isInteger(idxLeading) && idxLeading >= 0 && idxLeading < settingsEditState.work_groups.length) {
      settingsEditState.work_groups[idxLeading].leadingWorkGroup = String(target.value || "");
      updateSettingsSaveUi();
      return;
    }
    if (Number.isInteger(idxTeam) && idxTeam >= 0 && idxTeam < settingsEditState.work_groups.length) {
      settingsEditState.work_groups[idxTeam].teamName = String(target.value || "");
      updateSettingsSaveUi();
    }
  });

  document.getElementById("settings-wg-list")?.addEventListener("click", (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const removeRaw = target.getAttribute("data-wg-remove");
    if (removeRaw == null) return;
    const idx = Number(removeRaw);
    if (!Number.isInteger(idx) || idx < 0 || idx >= settingsEditState.work_groups.length) return;
    settingsEditState.work_groups.splice(idx, 1);
    renderSettingsWgList();
    updateSettingsSaveUi();
  });

  document.getElementById("settings-save")?.addEventListener("click", async () => {
    if (!settingsHasUnsavedChanges()) return;
    const normalized = normalizeAppSettings(settingsEditState);
    try {
      setSettingsStatus("Saving settings...", "info");
      const resp = await fetch("/app_settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: normalized }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok || !json?.ok) {
        throw new Error(json?.error || `HTTP ${resp.status}`);
      }
      appSettingsCache = normalizeAppSettings(json.settings);
      settingsEditState = normalizeAppSettings(json.settings);
      renderSettingsLists();
      settingsSavedSignature = settingsStateSignature(settingsEditState);
      updateSettingsSaveUi();
      setSettingsStatus("Settings saved. All pages now use this mapping.", "success");
      showSettingsCenterNotice("Settings saved", "success");
    } catch (err) {
      setSettingsStatus(`Save failed: ${String(err || "Unknown error")}`, "error");
      showSettingsCenterNotice("Save failed", "error");
    }
  });
}

function setupCapabilityFilterDropdown() {
  const toggle = document.getElementById("capabilityFilterToggle");
  const menu = document.getElementById("capabilityFilterMenu");
  if (!toggle || !menu || toggle.dataset.bound === "1") return;

  const setSubmenu = (name) => {
    const orderPanel = document.getElementById('capabilitySubmenuOrder');
    const columnsPanel = document.getElementById('capabilitySubmenuColumns');
    const buttons = menu.querySelectorAll('.backlog-menu-level1-item[data-submenu-target]');
    buttons.forEach((btn) => {
      const target = String(btn.getAttribute('data-submenu-target') || '').trim();
      btn.classList.toggle('active', target === name);
    });
    if (orderPanel) orderPanel.classList.toggle('open', name === 'order');
    if (columnsPanel) columnsPanel.classList.toggle('open', name === 'columns');
  };

  toggle.dataset.bound = "1";
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = !menu.classList.contains("open");
    menu.classList.toggle("open", willOpen);
    if (willOpen) setSubmenu('order');
  });

  menu.querySelectorAll('.backlog-menu-level1-item[data-submenu-target]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = String(btn.getAttribute('data-submenu-target') || '').trim();
      if (!target) return;
      setSubmenu(target);
    });
  });

  document.addEventListener("click", (e) => {
    if (!menu.classList.contains("open")) return;
    if (menu.contains(e.target) || toggle.contains(e.target)) return;
    menu.classList.remove("open");
  });
}

/* ========================
   Team Capacity
   ======================== */
const TEAM_CAPACITY_SPRINTS = ["Sprint 1", "Sprint 2", "Sprint 3", "Sprint 4", "Sprint 5"];
let teamCapacityMembers = [];
let teamCapacityAutosaveTimer = null;
let teamCapacityStartWeekOverride = "";
let teamCapacitySprintWeeks = {
  "Sprint 1": 2,
  "Sprint 2": 2,
  "Sprint 3": 2,
  "Sprint 4": 2,
  "Sprint 5": 2,
};

function normalizeTeamCapacitySprintWeeks(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  TEAM_CAPACITY_SPRINTS.forEach((sprint) => {
    const n = Number.parseInt(src[sprint], 10);
    const fallback = Number(teamCapacitySprintWeeks[sprint] || 2);
    const safe = Number.isFinite(n) ? n : fallback;
    out[sprint] = Math.max(1, Math.min(8, safe));
  });
  return out;
}

function parseStartWeekFromFixVersion(fixVersion) {
  const m = String(fixVersion || "").match(/_(\d{2})w(\d{2})$/i);
  if (!m) return { year: new Date().getFullYear(), week: 1 };
  const year = 2000 + Number(m[1]);
  const week = Math.max(1, Math.min(53, Number(m[2])));
  return { year, week };
}

function normalizeWeekKey(raw) {
  const parsed = parseWeekKey(String(raw || "").trim());
  if (!parsed) return "";
  const safeWeek = Math.max(1, Math.min(53, Number(parsed.week || 1)));
  return makeWeekKey(Number(parsed.year || new Date().getFullYear()), safeWeek);
}

function htmlWeekToWeekKey(htmlWeekValue) {
  const m = String(htmlWeekValue || "").trim().match(/^(\d{4})-W(\d{2})$/i);
  if (!m) return "";
  return normalizeWeekKey(`${m[1]}-W${m[2]}`);
}

function weekKeyToHtmlWeek(weekKey) {
  const parsed = parseWeekKey(weekKey);
  if (!parsed) return "";
  return `${parsed.year}-W${String(parsed.week).padStart(2, "0")}`;
}

function getTeamCapacityEffectiveStartWeek(fixVersion) {
  const override = normalizeWeekKey(teamCapacityStartWeekOverride);
  if (override) return override;
  const auto = parseStartWeekFromFixVersion(fixVersion);
  return makeWeekKey(auto.year, auto.week);
}

function buildTeamCapacitySprintWeekPlan(fixVersion, sprintWeeks) {
  let cursor = getTeamCapacityEffectiveStartWeek(fixVersion);
  const plan = {};
  TEAM_CAPACITY_SPRINTS.forEach((sprint) => {
    const count = Number(sprintWeeks?.[sprint] || 2);
    const list = [];
    for (let i = 0; i < count; i += 1) {
      list.push(cursor);
      cursor = nextWeekKey(cursor);
    }
    plan[sprint] = list;
  });
  return plan;
}

function normalizeWeekDayValue(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.max(0, Math.min(5, n)) * 100) / 100;
}

function ensureMemberWeekValues(member, sprintWeeks) {
  if (!member.weekValues || typeof member.weekValues !== "object") member.weekValues = {};
  TEAM_CAPACITY_SPRINTS.forEach((sprint) => {
    const targetCount = Number(sprintWeeks?.[sprint] || 2);
    let rows = Array.isArray(member.weekValues[sprint]) ? member.weekValues[sprint] : [];
    rows = rows.map((v) => normalizeWeekDayValue(v));

    while (rows.length < targetCount) rows.push(0);
    if (rows.length > targetCount) rows = rows.slice(0, targetCount);
    member.weekValues[sprint] = rows;
  });
}

function normalizeTeamCapacityMember(raw) {
  const row = raw && typeof raw === "object" ? raw : {};
  const displayName = String(row.displayName || row.name || "").trim();
  const accountId = String(row.accountId || "").trim();
  const emailAddress = String(row.emailAddress || row.email || "").trim();
  const member = {
    accountId,
    displayName,
    emailAddress,
    weekValues: row.weekValues && typeof row.weekValues === "object" ? row.weekValues : {},
  };

  const legacyDays = row.days && typeof row.days === "object" ? row.days : {};
  const legacyWeekDays = row.weekDays && typeof row.weekDays === "object" ? row.weekDays : {};
  ensureMemberWeekValues(member, teamCapacitySprintWeeks);

  TEAM_CAPACITY_SPRINTS.forEach((sprint) => {
    const hasAny = (member.weekValues[sprint] || []).some((v) => Number(v || 0) > 0);
    if (hasAny) return;

    // backward compatibility from previous per-day weekDays structure
    const legacyRows = Array.isArray(legacyWeekDays[sprint]) ? legacyWeekDays[sprint] : [];
    if (legacyRows.length) {
      const converted = legacyRows.map((w) => {
        const src = w && typeof w === "object" ? w : {};
        return normalizeWeekDayValue(
          Number(src.Mon || 0) + Number(src.Tue || 0) + Number(src.Wed || 0) + Number(src.Thu || 0) + Number(src.Fri || 0)
        );
      });
      if (converted.some((v) => v > 0)) {
        member.weekValues[sprint] = converted;
        ensureMemberWeekValues(member, teamCapacitySprintWeeks);
        return;
      }
    }

    const legacyTotal = Number(legacyDays[sprint] || 0);
    if (!Number.isFinite(legacyTotal) || legacyTotal <= 0) return;
    if (!member.weekValues[sprint] || !member.weekValues[sprint].length) member.weekValues[sprint] = [0];
    member.weekValues[sprint][0] = normalizeWeekDayValue(legacyTotal);
    ensureMemberWeekValues(member, teamCapacitySprintWeeks);
  });

  return member;
}

function showTeamCapacityStatus(message, kind = "info") {
  const el = document.getElementById("team-capacity-status");
  if (!el) return;
  el.textContent = message || "";
  el.className = `team-capacity-status ${kind}`;
}

function showTeamCapacityConfirm(message) {
  const modal = document.getElementById("team-capacity-confirm-modal");
  const text = document.getElementById("team-capacity-confirm-message");
  const okBtn = document.getElementById("team-capacity-confirm-ok");
  const cancelBtn = document.getElementById("team-capacity-confirm-cancel");
  if (!modal || !text || !okBtn || !cancelBtn) {
    return Promise.resolve(window.confirm(message));
  }

  text.textContent = String(message || "Are you sure?");
  modal.classList.remove("hidden");

  return new Promise((resolve) => {
    let closed = false;
    const close = (result) => {
      if (closed) return;
      closed = true;
      modal.classList.add("hidden");
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      modal.onclick = null;
      document.removeEventListener("keydown", onKey);
      resolve(Boolean(result));
    };

    const onKey = (ev) => {
      if (ev.key === "Escape") close(false);
    };

    okBtn.onclick = () => close(true);
    cancelBtn.onclick = () => close(false);
    modal.onclick = (ev) => {
      if (ev.target === modal) close(false);
    };

    document.addEventListener("keydown", onKey);
    okBtn.focus();
  });
}

function teamCapacitySprintTotal(member, sprint) {
  const rows = Array.isArray(member?.weekValues?.[sprint]) ? member.weekValues[sprint] : [];
  let sum = 0;
  rows.forEach((weekValue) => {
    sum += Number(weekValue || 0);
  });
  return Math.round(sum * 100) / 100;
}

function teamCapacityMemberTotal(member) {
  return TEAM_CAPACITY_SPRINTS.reduce((sum, sprint) => sum + teamCapacitySprintTotal(member, sprint), 0);
}

function formatCapacityValue(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "0";
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function teamCapacityRoundInteger(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

function renderTeamCapacityMembers() {
  const host = document.getElementById("team-capacity-planner");
  if (!host) return;

  const startWeekInput = document.getElementById("team-capacity-first-week");
  if (startWeekInput instanceof HTMLInputElement) {
    startWeekInput.value = weekKeyToHtmlWeek(getTeamCapacityEffectiveStartWeek(getSelectedFixVersion()));
  }

  const weekPlan = buildTeamCapacitySprintWeekPlan(getSelectedFixVersion(), teamCapacitySprintWeeks);

  if (!teamCapacityMembers.length) {
    host.innerHTML = `<div class="team-capacity-empty" style="padding: 12px;">No team members yet. Search Jira users and add them.</div>`;
    return;
  }

  teamCapacityMembers.forEach((m) => ensureMemberWeekValues(m, teamCapacitySprintWeeks));

  let headRow1 = `<tr><th rowspan="2">#</th><th rowspan="2">Team member</th>`;
  let headRow2 = "<tr>";

  TEAM_CAPACITY_SPRINTS.forEach((sprint) => {
    const weeks = weekPlan[sprint] || [];
    const span = weeks.length;
    const first = weeks[0] || "";
    const last = weeks[weeks.length - 1] || "";
    const range = first && last ? `${first} → ${last}` : "";
    const weekCount = Number(teamCapacitySprintWeeks?.[sprint] || weeks.length || 1);
    headRow1 += `<th colspan="${span}" class="team-capacity-sprint-head"><div class="team-capacity-sprint-head-top"><span class="team-capacity-sprint-title">${escapeHtml(sprint)} (${weekCount}w)</span><span class="team-capacity-sprint-ctrls"><button type="button" class="team-capacity-sprint-btn" data-sprint="${escapeHtml(sprint)}" data-sprint-adjust="-" aria-label="Decrease weeks for ${escapeHtml(sprint)}">−</button><button type="button" class="team-capacity-sprint-btn" data-sprint="${escapeHtml(sprint)}" data-sprint-adjust="+" aria-label="Increase weeks for ${escapeHtml(sprint)}">+</button></span></div><div class="team-capacity-sprint-range">${escapeHtml(range)}</div></th>`;
    weeks.forEach((weekKey) => {
      const parsed = parseWeekKey(weekKey);
      const wLabel = parsed ? `W${String(parsed.week).padStart(2, "0")}` : weekKey;
      headRow2 += `<th class="team-capacity-day-head">${escapeHtml(wLabel)}</th>`;
    });
  });

  headRow1 += `<th rowspan="2" class="team-capacity-cap-head">Total</th><th rowspan="2" class="team-capacity-cap-head">Full capacity</th><th rowspan="2" class="team-capacity-cap-head">Planned capacity</th></tr>`;
  headRow2 += "</tr>";

  const rows = teamCapacityMembers.map((member, idx) => {
    const userLabel = member.emailAddress
      ? `${escapeHtml(member.displayName)} <span class="team-capacity-email">${escapeHtml(member.emailAddress)}</span>`
      : escapeHtml(member.displayName);
    let sprintCells = "";
    TEAM_CAPACITY_SPRINTS.forEach((sprint) => {
      const weeks = weekPlan[sprint] || [];
      weeks.forEach((_, weekIdx) => {
        const val = Number(member?.weekValues?.[sprint]?.[weekIdx] || 0);
        const text = Number.isInteger(val) ? String(val) : String(val);
        sprintCells += `<td><input type="number" class="team-capacity-week-input" data-row="${idx}" data-sprint="${escapeHtml(sprint)}" data-week-index="${weekIdx}" min="0" max="5" step="0.5" value="${escapeHtml(text)}" /></td>`;
      });
    });

    const total = teamCapacityMemberTotal(member);
    const fullCapacity = teamCapacityRoundInteger(total * 0.8);
    const plannedCapacity = teamCapacityRoundInteger(total * 0.6);
    return `<tr>
      <td>${idx + 1}</td>
      <td class="team-capacity-user-cell"><span class="team-capacity-user-main">${userLabel}</span><button type="button" class="team-capacity-remove team-capacity-remove-inline" data-remove-row="${idx}" aria-label="Remove ${escapeHtml(member.displayName || "member")}" title="Remove">[X]</button></td>
      ${sprintCells}
      <td class="team-capacity-total team-capacity-cap-cell">${escapeHtml(formatCapacityValue(total))}</td>
      <td class="team-capacity-total team-capacity-cap-cell">${escapeHtml(formatCapacityValue(fullCapacity))}</td>
      <td class="team-capacity-total team-capacity-cap-cell">${escapeHtml(formatCapacityValue(plannedCapacity))}</td>
    </tr>`;
  }).join("");

  let totalsCells = "";
  TEAM_CAPACITY_SPRINTS.forEach((sprint) => {
    const weeks = weekPlan[sprint] || [];
    weeks.forEach((_, weekIdx) => {
      const weekTotal = teamCapacityMembers.reduce((sum, member) => {
        return sum + Number(member?.weekValues?.[sprint]?.[weekIdx] || 0);
      }, 0);
      const weekText = Number.isInteger(weekTotal) ? String(weekTotal) : weekTotal.toFixed(1);
      totalsCells += `<td class="team-capacity-total team-capacity-bottom-week">${escapeHtml(weekText)}</td>`;
    });
  });
  const bottomTotal = teamCapacityMembers.reduce((sum, member) => sum + teamCapacityMemberTotal(member), 0);
  const bottomFullCapacity = teamCapacityRoundInteger(bottomTotal * 0.8);
  const bottomPlannedCapacity = teamCapacityRoundInteger(bottomTotal * 0.6);
  const bottomBuffer = bottomFullCapacity - bottomPlannedCapacity;
  const totalsRow = `<tr class="team-capacity-bottom-row"><td></td><td class="team-capacity-bottom-label">Total per week</td>${totalsCells}<td class="team-capacity-total team-capacity-bottom-grand team-capacity-cap-cell">${escapeHtml(formatCapacityValue(bottomTotal))}</td><td class="team-capacity-total team-capacity-bottom-grand team-capacity-cap-cell">${escapeHtml(formatCapacityValue(bottomFullCapacity))}</td><td class="team-capacity-total team-capacity-bottom-grand team-capacity-cap-cell">${escapeHtml(formatCapacityValue(bottomPlannedCapacity))}</td></tr>`;

  host.innerHTML = `
    <table class="team-capacity-table team-capacity-table-detailed">
      <thead>${headRow1}${headRow2}</thead>
      <tbody>${rows}${totalsRow}</tbody>
    </table>
    <div class="team-capacity-buffer-row">
      <span class="team-capacity-buffer-cell team-capacity-buffer-label">Buffer</span>
      <span class="team-capacity-buffer-cell team-capacity-buffer-value">${escapeHtml(formatCapacityValue(bottomBuffer))}</span>
    </div>
  `;
}

async function loadTeamCapacityData(forceRefresh = false) {
  const workGroup = getSelectedWorkGroup();
  const fixVersion = getSelectedFixVersion();
  if (!workGroup || !fixVersion) return;
  const url = `/team_capacity_data?workGroup=${encodeURIComponent(workGroup)}&fixVersion=${encodeURIComponent(fixVersion)}`;

  try {
    showTeamCapacityStatus("Loading capacity...", "info");
    const resp = await fetch(url, { cache: "no-store" });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(json?.error || `HTTP ${resp.status}`);
    }
    if (!json?.ok) {
      throw new Error(json?.error || "Failed to load capacity");
    }
    teamCapacityStartWeekOverride = normalizeWeekKey(json?.data?.startWeek || "");
    teamCapacitySprintWeeks = normalizeTeamCapacitySprintWeeks(json?.data?.sprintWeeks || teamCapacitySprintWeeks);
    const members = Array.isArray(json?.data?.members) ? json.data.members : [];
    teamCapacityMembers = members.map(normalizeTeamCapacityMember);
    renderTeamCapacityMembers();
    showTeamCapacityStatus(`Loaded ${teamCapacityMembers.length} members.`, "success");
  } catch (err) {
    teamCapacityMembers = [];
    renderTeamCapacityMembers();
    showTeamCapacityStatus(`Load failed: ${String(err || "Unknown error")}`, "error");
  }
}

async function saveTeamCapacityData() {
  const workGroup = getSelectedWorkGroup();
  const fixVersion = getSelectedFixVersion();
  if (!workGroup || !fixVersion) {
    showTeamCapacityStatus("Work group and Fix Version are required.", "error");
    return;
  }

  const payload = {
    workGroup,
    fixVersion,
    startWeek: normalizeWeekKey(teamCapacityStartWeekOverride),
    sprintWeeks: normalizeTeamCapacitySprintWeeks(teamCapacitySprintWeeks),
    members: teamCapacityMembers.map(normalizeTeamCapacityMember),
  };

  try {
    showTeamCapacityStatus("Saving capacity...", "info");
    const resp = await fetch("/team_capacity_data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json?.ok) {
      throw new Error(json?.error || `HTTP ${resp.status}`);
    }
    const cacheKey = makeCacheKey("teamCapacityData", { workGroup, fixVersion });
    writeClientCache(cacheKey, json);
    showTeamCapacityStatus(`Saved ${teamCapacityMembers.length} members.`, "success");
  } catch (err) {
    showTeamCapacityStatus(`Save failed: ${String(err || "Unknown error")}`, "error");
  }
}

function scheduleTeamCapacityAutosave(delayMs = 350) {
  if (teamCapacityAutosaveTimer) {
    clearTimeout(teamCapacityAutosaveTimer);
    teamCapacityAutosaveTimer = null;
  }
  teamCapacityAutosaveTimer = setTimeout(() => {
    teamCapacityAutosaveTimer = null;
    saveTeamCapacityData();
  }, delayMs);
}

function addTeamCapacityMember(rawUser) {
  const user = normalizeTeamCapacityMember(rawUser);
  if (!user.displayName) return;

  const duplicate = teamCapacityMembers.some((m) => {
    if (user.accountId && m.accountId) return m.accountId === user.accountId;
    return (m.displayName || "").toLowerCase() === user.displayName.toLowerCase();
  });
  if (duplicate) {
    showTeamCapacityStatus(`${user.displayName} is already added.`, "warning");
    return;
  }

  teamCapacityMembers.push(user);
  ensureMemberWeekValues(user, teamCapacitySprintWeeks);
  renderTeamCapacityMembers();
  showTeamCapacityStatus(`${user.displayName} added.`, "success");
  scheduleTeamCapacityAutosave();
}

async function searchTeamCapacityUsers() {
  const input = document.getElementById("team-capacity-user-search");
  const host = document.getElementById("team-capacity-search-results");
  if (!input || !host) return;
  const q = String(input.value || "").trim();
  if (q.length < 2) {
    host.innerHTML = "";
    showTeamCapacityStatus("Type at least 2 characters to search Jira users.", "info");
    return;
  }

  host.innerHTML = '<div class="team-capacity-search-item">Searching...</div>';
  try {
    const resp = await fetch(`/jira_user_search?q=${encodeURIComponent(q)}`, { cache: "no-store" });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json?.ok) {
      throw new Error(json?.error || `HTTP ${resp.status}`);
    }
    const users = Array.isArray(json.users) ? json.users : [];
    if (!users.length) {
      host.innerHTML = '<div class="team-capacity-search-item">No users found.</div>';
      return;
    }

    host.innerHTML = users.map((u, idx) => {
      const display = escapeHtml(String(u.displayName || u.name || "").trim());
      const email = escapeHtml(String(u.emailAddress || "").trim());
      const id = escapeHtml(String(u.accountId || "").trim());
      return `<button type="button" class="team-capacity-search-item" data-user-idx="${idx}" data-user-id="${id}" data-user-name="${display}" data-user-email="${email}">${display}${email ? ` <span>${email}</span>` : ""}</button>`;
    }).join("");

    host.querySelectorAll("[data-user-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-user-idx"));
        const selected = users[idx];
        addTeamCapacityMember(selected);
        input.value = "";
        host.innerHTML = "";
        input.focus();
      });
    });
  } catch (err) {
    host.innerHTML = "";
    showTeamCapacityStatus(`User search failed: ${String(err || "Unknown error")}`, "error");
  }
}

async function copyTeamMembersFromPreviousFixVersion() {
  const workGroup = getSelectedWorkGroup();
  const targetFixVersion = getSelectedFixVersion();
  if (!workGroup || !targetFixVersion) {
    showTeamCapacityStatus("Work group and Fix Version are required.", "error");
    return;
  }

  try {
    showTeamCapacityStatus("Preparing copy from previous QS...", "info");

    const settings = await fetchAppSettings();
    const fixVersions = Array.isArray(settings?.fix_versions) ? settings.fix_versions.map(v => String(v || "").trim()).filter(Boolean) : [];
    const targetIndex = fixVersions.findIndex(v => v === targetFixVersion);
    if (targetIndex <= 0) {
      showTeamCapacityStatus("No previous Fix Version found before current selection.", "warning");
      return;
    }
    const sourceFixVersion = fixVersions[targetIndex - 1];

    const srcResp = await fetch(`/team_capacity_data?workGroup=${encodeURIComponent(workGroup)}&fixVersion=${encodeURIComponent(sourceFixVersion)}`, { cache: "no-store" });
    const srcJson = await srcResp.json().catch(() => ({}));
    if (!srcResp.ok || !srcJson?.ok) {
      throw new Error(srcJson?.error || `Failed loading source (${srcResp.status})`);
    }

    const targetResp = await fetch(`/team_capacity_data?workGroup=${encodeURIComponent(workGroup)}&fixVersion=${encodeURIComponent(targetFixVersion)}`, { cache: "no-store" });
    const targetJson = await targetResp.json().catch(() => ({}));
    if (!targetResp.ok || !targetJson?.ok) {
      throw new Error(targetJson?.error || `Failed loading target (${targetResp.status})`);
    }

    const sourceMembers = (Array.isArray(srcJson?.data?.members) ? srcJson.data.members : []).map(normalizeTeamCapacityMember);
    if (!sourceMembers.length) {
      showTeamCapacityStatus("Source team has no members to copy.", "warning");
      return;
    }

    const targetStartWeek = normalizeWeekKey(targetJson?.data?.startWeek || "");
    const targetSprintWeeks = normalizeTeamCapacitySprintWeeks(targetJson?.data?.sprintWeeks || teamCapacitySprintWeeks);
    const targetMembers = (Array.isArray(targetJson?.data?.members) ? targetJson.data.members : []).map(normalizeTeamCapacityMember);
    targetMembers.forEach((m) => ensureMemberWeekValues(m, targetSprintWeeks));

    const existing = new Set(targetMembers.map((m) => (m.accountId ? `id:${m.accountId}` : `name:${String(m.displayName || "").toLowerCase()}`)));
    let addedCount = 0;

    sourceMembers.forEach((member) => {
      const key = member.accountId ? `id:${member.accountId}` : `name:${String(member.displayName || "").toLowerCase()}`;
      if (existing.has(key)) return;
      const clone = {
        accountId: member.accountId,
        displayName: member.displayName,
        emailAddress: member.emailAddress,
        weekValues: {},
      };
      ensureMemberWeekValues(clone, targetSprintWeeks);
      targetMembers.push(clone);
      existing.add(key);
      addedCount += 1;
    });

    if (addedCount === 0) {
      showTeamCapacityStatus(`All members from ${sourceFixVersion} already exist in ${targetFixVersion}.`, "info");
      return;
    }

    const saveResp = await fetch("/team_capacity_data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workGroup,
        fixVersion: targetFixVersion,
        startWeek: targetStartWeek,
        sprintWeeks: targetSprintWeeks,
        members: targetMembers,
      }),
    });
    const saveJson = await saveResp.json().catch(() => ({}));
    if (!saveResp.ok || !saveJson?.ok) {
      throw new Error(saveJson?.error || `Failed saving target (${saveResp.status})`);
    }

    teamCapacityStartWeekOverride = targetStartWeek;
    teamCapacitySprintWeeks = normalizeTeamCapacitySprintWeeks(targetSprintWeeks);
    teamCapacityMembers = targetMembers.map(normalizeTeamCapacityMember);
    renderTeamCapacityMembers();

    showTeamCapacityStatus(`Copied ${addedCount} member(s) from ${sourceFixVersion} to ${targetFixVersion}.`, "success");
  } catch (err) {
    showTeamCapacityStatus(`Copy failed: ${String(err || "Unknown error")}`, "error");
  }
}

function bindTeamCapacityPage() {
  restorePlanningSettings();
  loadTeamCapacityData();

  document.getElementById("fixVersionSelect")?.addEventListener("change", () => {
    savePlanningSettings();
    loadTeamCapacityData();
  });
  document.getElementById("workGroupSelect")?.addEventListener("change", () => {
    savePlanningSettings();
    loadTeamCapacityData();
  });

  document.getElementById("team-capacity-user-search-btn")?.addEventListener("click", searchTeamCapacityUsers);
  document.getElementById("team-capacity-copy-prev")?.addEventListener("click", copyTeamMembersFromPreviousFixVersion);
  document.getElementById("team-capacity-first-week")?.addEventListener("change", (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement)) return;
    teamCapacityStartWeekOverride = htmlWeekToWeekKey(target.value);
    renderTeamCapacityMembers();
    scheduleTeamCapacityAutosave();
  });
  document.getElementById("team-capacity-first-week-reset")?.addEventListener("click", () => {
    teamCapacityStartWeekOverride = "";
    renderTeamCapacityMembers();
    scheduleTeamCapacityAutosave();
  });
  document.getElementById("team-capacity-user-search")?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      searchTeamCapacityUsers();
    }
  });

  const applyDaysInputValue = (target, rerenderAfter = false) => {
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.classList.contains("team-capacity-week-input")) return;
    const row = Number(target.getAttribute("data-row"));
    const sprint = String(target.getAttribute("data-sprint") || "").trim();
    const weekIdx = Number(target.getAttribute("data-week-index"));
    if (!Number.isInteger(row) || row < 0 || row >= teamCapacityMembers.length) return;
    if (!TEAM_CAPACITY_SPRINTS.includes(sprint)) return;
    if (!Number.isInteger(weekIdx) || weekIdx < 0) return;
    ensureMemberWeekValues(teamCapacityMembers[row], teamCapacitySprintWeeks);
    const safe = normalizeWeekDayValue(target.value);
    teamCapacityMembers[row].weekValues[sprint][weekIdx] = safe;
    if (rerenderAfter) renderTeamCapacityMembers();
  };

  document.getElementById("team-capacity-planner")?.addEventListener("input", (ev) => {
    const target = ev.target;
    applyDaysInputValue(target, false);
    scheduleTeamCapacityAutosave();
  });

  document.getElementById("team-capacity-planner")?.addEventListener("change", (ev) => {
    const target = ev.target;
    applyDaysInputValue(target, true);
    scheduleTeamCapacityAutosave(150);
  });

  document.getElementById("team-capacity-planner")?.addEventListener("click", async (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;

    const adjustBtn = target.closest("[data-sprint-adjust]");
    if (adjustBtn instanceof HTMLElement) {
      const sprint = String(adjustBtn.getAttribute("data-sprint") || "").trim();
      const adjust = String(adjustBtn.getAttribute("data-sprint-adjust") || "").trim();
      if (TEAM_CAPACITY_SPRINTS.includes(sprint) && (adjust === "+" || adjust === "-")) {
        const current = Number(teamCapacitySprintWeeks[sprint] || 2);
        const next = adjust === "+" ? current + 1 : current - 1;
        teamCapacitySprintWeeks[sprint] = Math.max(1, Math.min(8, next));
        teamCapacityMembers.forEach((m) => ensureMemberWeekValues(m, teamCapacitySprintWeeks));
        renderTeamCapacityMembers();
        scheduleTeamCapacityAutosave();
      }
      return;
    }

    const rowRaw = target.getAttribute("data-remove-row");
    if (rowRaw == null) return;
    const row = Number(rowRaw);
    if (!Number.isInteger(row) || row < 0 || row >= teamCapacityMembers.length) return;
    const removed = teamCapacityMembers[row];
    const memberName = String(removed?.displayName || "this member").trim() || "this member";
    const confirmDelete = await showTeamCapacityConfirm(`Are you sure you want to delete ${memberName}?`);
    if (!confirmDelete) return;
    teamCapacityMembers.splice(row, 1);
    renderTeamCapacityMembers();
    showTeamCapacityStatus(`${removed.displayName} removed.`, "warning");
    scheduleTeamCapacityAutosave();
  });

}

/* ===============
   Page bootstrap
   =============== */
document.addEventListener("DOMContentLoaded", async () => {
  const isDashboard = document.getElementById("statsChart") && document.getElementById("issueTable");
  const isPlanning  = !!document.getElementById("committed-table");
  const isBacklog   = !!document.getElementById("backlog-table") && !document.getElementById("committed-table");
  const isRoadmap   = !!document.getElementById("backlog-roadmap") && !document.getElementById("backlog-table");
  const isProjectFR = !!document.getElementById("project-fr-table");
  const isTeamCapacity = !!document.getElementById("team-capacity-page");
  const isSettings = !!document.getElementById("settings-page");

  if (isDashboard || isPlanning || isBacklog || isRoadmap || isTeamCapacity || isSettings) {
    await ensureGlobalSettingsApplied();
    restoreGlobalNavSelection();
  }

  setupStickyLayoutOffsets();

  document.getElementById("fixVersionSelect")?.addEventListener("change", () => {
    savePlanningSettings();
  });
  document.getElementById("workGroupSelect")?.addEventListener("change", () => {
    savePlanningSettings();
  });

  if (isDashboard) {
    restoreDashboardSettings();
    renderChart(); renderTable();
    document.getElementById("refresh")?.addEventListener("click", () => { renderChart(true); renderTable(true); });
    document.getElementById("fixVersionSelect")?.addEventListener("change", () => { saveDashboardSettings(); renderChart(); renderTable(); });
    document.getElementById("workGroupSelect")?.addEventListener("change", () => { saveDashboardSettings(); renderChart(); renderTable(); });
  }

  if (isPlanning) {
    restorePlanningSettings();
    loadPIPlanningData();

    document.getElementById("fixVersionSelect")?.addEventListener("change", () => { savePlanningSettings(); loadPIPlanningData(); });
    document.getElementById("workGroupSelect")?.addEventListener("change", () => { savePlanningSettings(); loadPIPlanningData(); });
    document.getElementById("globalFilter")?.addEventListener("input", applyFilter);
    document.getElementById("pi-collapse-all-stories")?.addEventListener("click", collapseAllCommittedStories);

    document.getElementById("export-committed-excel")?.addEventListener("click", function () {
      const fv = getSelectedFixVersion();
      const wg = getSelectedWorkGroup();
      const q = (document.getElementById("globalFilter")?.value || "").trim();
      const params = new URLSearchParams();
      params.set("fixVersion", fv || "");
      params.set("workGroup", wg || "");
      if (q) params.set("q", q);
      window.location.href = `/export_committed_excel?${params.toString()}`;
    });
    document.getElementById("planning-refresh")?.addEventListener("click", () => {
      loadPIPlanningData(true);
    });
  }

  if (isBacklog) {
    restoreBacklogSettings();
    restoreCapabilityOrderMode();
    setupCapabilityFilterDropdown();
    loadBacklogData();
    document.getElementById("backlog-reset-column-filters")?.addEventListener("click", () => {
      resetBacklogColumnFilters();
    });
    document.getElementById("workGroupSelect")?.addEventListener("change", () => {
      saveBacklogSettings();
      restoreCapabilityOrderMode();
      loadBacklogData();
    });
    document.getElementById("globalFilter")?.addEventListener("input", applyFilter);
    document.getElementById("export-backlog-excel")?.addEventListener("click", async function () {
      const wg = getSelectedWorkGroup();
      const textFilter = (document.getElementById("globalFilter")?.value || "").trim();
      const backlogTable = document.querySelector("#backlog-table table");

      const columnFilterState = getBacklogColumnFilterState();
      const selectedStatuses = Array.isArray(columnFilterState.status)
        ? columnFilterState.status.filter(Boolean)
        : [];

      const visibleFeatureIds = Array.from(document.querySelectorAll("#backlog-table tbody tr"))
        .filter((row) => {
          if (!(row instanceof HTMLTableRowElement)) return false;
          if (row.classList.contains("capability-block-row")) return false;
          if (row.style.display === "none") return false;
          return true;
        })
        .map((row) => row.querySelector("td.col-feature-id a")?.textContent?.trim() || "")
        .filter(Boolean);

      const visibleHeaders = Array.from(backlogTable?.querySelectorAll("thead th") || [])
        .map((th) => (th.textContent || "").trim())
        .filter(Boolean);

      const visibleRows = Array.from(document.querySelectorAll("#backlog-table tbody tr"))
        .filter((row) => {
          if (!(row instanceof HTMLTableRowElement)) return false;
          if (row.classList.contains("capability-block-row")) return false;
          if (row.style.display === "none") return false;
          return true;
        })
        .map((row) => Array.from(row.cells).map((cell) => (cell.textContent || "").trim()));

      const payload = {
        workGroup: wg || "",
        q: textFilter,
        statuses: selectedStatuses,
        featureIds: visibleFeatureIds,
        visibleTable: {
          headers: visibleHeaders,
          rows: visibleRows,
        },
      };

      try {
        const resp = await fetch("/export_backlog_excel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!resp.ok) {
          throw new Error(`Export failed (HTTP ${resp.status})`);
        }

        const blob = await resp.blob();
        const fileName = `backlog_${(getSelectedWorkGroup() || "team").replace(/[^a-z0-9_-]+/gi, "_")}.xlsx`;
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objectUrl);
      } catch (err) {
        console.error("Backlog export failed:", err);
        alert(`Export failed: ${String(err || "Unknown error")}`);
        window.location.href = `/export_backlog_excel?workGroup=${encodeURIComponent(wg || "")}`;
      }
    });
    document.getElementById("backlog-refresh")?.addEventListener("click", () => {
      loadBacklogData(true);
    });
    document.getElementById("capability-order-priority")?.addEventListener("change", () => {
      persistCapabilityOrderMode();
      const tableHost = document.getElementById("backlog-table");
      const rawData = tableHost?._rawBacklogData || {};
      renderFeatureTable(Object.entries(rawData), "backlog-table", []);
      applyFilter();
    });
  }

  if (isRoadmap) {
    restoreBacklogSettings();
    restoreCapabilityOrderMode();
    restoreRoadmapShowEmptyCapabilities();
    restoreRoadmapQsFilter();
    setupCapabilityFilterDropdown();
    bindRoadmapCapabilitiesCounterHover();
    loadBacklogData();
    document.getElementById("workGroupSelect")?.addEventListener("change", () => {
      saveBacklogSettings();
      restoreCapabilityOrderMode();
      persistRoadmapShowEmptyCapabilities();
      restoreRoadmapShowEmptyCapabilities();
      restoreRoadmapQsFilter();
      roadmapTeammatesByScope.clear();
      loadBacklogData();
      updateRoadmapPendingUi();
    });
    document.getElementById("roadmap-show-empty-capabilities")?.addEventListener("change", () => {
      persistRoadmapShowEmptyCapabilities();
      const host = document.getElementById("backlog-roadmap");
      if (!host) return;
      renderBacklogRoadmap(host._roadmapData || {}, host._capabilitiesData || [], host._roadmapCapacityByFixVersion || {});
    });
    document.getElementById("capability-order-priority")?.addEventListener("change", () => {
      persistCapabilityOrderMode();
      const host = document.getElementById("backlog-roadmap");
      if (!host) return;
      renderBacklogRoadmap(host._roadmapData || {}, host._capabilitiesData || [], host._roadmapCapacityByFixVersion || {});
    });
    document.getElementById("roadmap-qs-filter")?.addEventListener("change", () => {
      persistRoadmapQsFilter();
      const host = document.getElementById("backlog-roadmap");
      if (!host) return;
      renderBacklogRoadmap(host._roadmapData || {}, host._capabilitiesData || [], host._roadmapCapacityByFixVersion || {});
    });
    document.getElementById("roadmap-refresh")?.addEventListener("click", () => {
      loadBacklogData(true);
    });
    document.getElementById("roadmap-push-jira")?.addEventListener("click", () => {
      pushRoadmapMovesToJira();
    });
    document.addEventListener("click", (ev) => {
      const menu = document.getElementById("roadmap-context-menu");
      if (!menu || menu.classList.contains("hidden")) return;
      if (!menu.contains(ev.target)) hideRoadmapContextMenu();
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        hideRoadmapContextMenu();
        hideRoadmapFeatureInfo();
      }
    });
    document.getElementById("roadmap-feature-modal-close")?.addEventListener("click", hideRoadmapFeatureInfo);
    document.getElementById("roadmap-feature-modal")?.addEventListener("click", (ev) => {
      if (ev.target?.id === "roadmap-feature-modal") hideRoadmapFeatureInfo();
    });
    updateRoadmapPendingUi();
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

  if (isTeamCapacity) {
    bindTeamCapacityPage();
  }

  if (isSettings) {
    bindSettingsPage();
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
