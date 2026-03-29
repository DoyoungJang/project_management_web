const { createApiClient, escapeHtml, parseApiError, applyUserTheme, showTaskDescriptionModal } = window.PMCommon;
const api = createApiClient();
const pageParams = new URLSearchParams(window.location.search);

const els = {
  userInfo: document.getElementById("user-info"),
  heroTitle: document.getElementById("dashboard-hero-title"),
  heroSubtitle: document.getElementById("dashboard-hero-subtitle"),
  adminLink: document.getElementById("admin-link"),
  logoutBtn: document.getElementById("logout-btn"),
  todayNotifications: document.getElementById("today-notifications"),
  dashboard: {
    projects: document.getElementById("stat-projects"),
    active: document.getElementById("stat-active"),
    tasks: document.getElementById("stat-tasks"),
    rate: document.getElementById("stat-rate"),
  },
  projectForm: document.getElementById("project-form"),
  projectTimelineRangeForm: document.getElementById("project-timeline-range-form"),
  projectTimelineRangeStart: document.getElementById("project-timeline-range-start"),
  projectTimelineRangeEnd: document.getElementById("project-timeline-range-end"),
  projectTimelineRangeReset: document.getElementById("project-timeline-range-reset"),
  projectTimelineFilterList: document.getElementById("project-timeline-filter-list"),
  projectTimelineFilterSummary: document.getElementById("project-timeline-filter-summary"),
  projectTimelineFilterSelectAll: document.getElementById("project-timeline-filter-select-all"),
  projectTimelineFilterClearAll: document.getElementById("project-timeline-filter-clear-all"),
  projectTimelineSortSelect: document.getElementById("project-timeline-sort-select"),
  projectTimelineCursorDate: document.getElementById("project-timeline-cursor-date"),
  projectTimelineLegend: document.getElementById("project-timeline-legend"),
  projectTimelineEmpty: document.getElementById("project-timeline-empty"),
  projectTimelineScroll: document.getElementById("project-timeline-scroll"),
  projectTimeline: document.getElementById("project-timeline"),
  projectList: document.getElementById("project-list"),
  upcomingFilter: document.getElementById("upcoming-filter"),
  upcomingCountAll: document.getElementById("upcoming-count-all"),
  upcomingCountOwner: document.getElementById("upcoming-count-owner"),
  upcomingCountParticipant: document.getElementById("upcoming-count-participant"),
};

let projects = [];
let currentUser = null;
let upcomingItems = [];
let upcomingRelationFilter = "all";
const projectTimelineRangeState = {
  start: normalizeDateInputValue(pageParams.get("project_timeline_start")),
  end: normalizeDateInputValue(pageParams.get("project_timeline_end")),
};
let projectTimelineFilterMode = "all";
let selectedProjectTimelineIds = new Set();
let currentProjectTimelineSort = "timeline";
let currentProjectTimelineRenderState = null;
let currentProjectTimelineHoveredTrack = null;
const projectTimelineWeekdayFormatter = new Intl.DateTimeFormat("ko-KR", { weekday: "short" });

function renderSiteBranding(branding) {
  if (els.heroTitle) {
    els.heroTitle.textContent = String(branding?.dashboard_title || "Company Project Hub");
  }
  if (els.heroSubtitle) {
    els.heroSubtitle.textContent = String(
      branding?.dashboard_subtitle || "프로젝트와 작업을 한 화면에서 관리하세요."
    );
  }
}

function statusLabel(raw) {
  const map = {
    planned: "Planned",
    active: "Active",
    done: "Done",
  };
  return map[raw] || raw;
}

function stageLabel(raw) {
  const map = {
    data_acquisition: "데이터 획득",
    labeling: "라벨링",
    development: "개발",
  };
  return map[raw] || raw;
}

function relationLabel(raw) {
  const map = {
    owner: "Owner",
    participant: "참가자",
    viewer: "Viewer",
    admin: "관리자",
  };
  return map[raw] || "기타";
}

function relationBadgeClass(raw) {
  if (raw === "owner") return "badge--owner";
  if (raw === "participant") return "badge--participant";
  if (raw === "viewer") return "badge--viewer";
  return "";
}

function projectStatusColor(raw) {
  const map = {
    planned: "#2a6f97",
    active: "#0f6d66",
    done: "#5d768d",
  };
  return map[raw] || "#2a6f97";
}

function renderProjectTimelineLegend() {
  if (!els.projectTimelineLegend) return;

  const statusLegend = ["planned", "active", "done"]
    .map(
      (status) => `
        <span class="gantt-legend__item">
          <span class="gantt-legend__swatch" style="background:${projectStatusColor(status)}"></span>
          ${escapeHtml(statusLabel(status))}
        </span>
      `
    )
    .join("");

  const markerLegend = `
    <span class="gantt-legend__item gantt-legend__item--marker">
      <span class="gantt-legend__swatch" style="background:#0f6d66"></span>
      오늘
    </span>
    <span class="gantt-legend__item gantt-legend__item--marker">
      <span class="gantt-legend__swatch" style="background:#c0362c"></span>
      프로젝트 마감
    </span>
  `;

  els.projectTimelineLegend.innerHTML = `${statusLegend}${markerLegend}`;
}

function parseDateOnly(value) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return new Date(`${raw}T00:00:00`);
}

function normalizeDateInputValue(value) {
  const raw = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

function parseProjectTimelineFilterSelection(raw) {
  const normalized = String(raw || "").trim();
  if (!normalized) return { mode: "all", ids: new Set() };
  if (normalized === "none") return { mode: "none", ids: new Set() };
  const ids = new Set(
    normalized
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value > 0)
  );
  if (!ids.size) return { mode: "all", ids: new Set() };
  return { mode: "custom", ids };
}

function normalizeProjectTimelineSortKey(raw) {
  const key = String(raw || "timeline").trim();
  return ["timeline", "start_date", "end_date", "due_date", "name"].includes(key) ? key : "timeline";
}

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function diffDays(start, end) {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86400000));
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function formatProjectRange(startRaw, endRaw) {
  return `${startRaw || "-"} ~ ${endRaw || "-"}`;
}

function buildProjectTimelineDays(start, end) {
  const days = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    days.push(new Date(cursor));
    cursor = addDays(cursor, 1);
  }
  return days;
}

function formatProjectTimelineMonthLabel(date, forceYear = false) {
  if (forceYear) return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}`;
  return `${date.getMonth() + 1}월`;
}

function formatProjectTimelineDayLabel(date) {
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function getProjectTimelineMonthSerial(date) {
  return date.getFullYear() * 12 + date.getMonth();
}

function getProjectTimelineHeaderConfig(days, cellWidth) {
  const dayCount = days.length;
  const trackWidth = Math.max(240, dayCount * Math.max(cellWidth, 1));
  const monthStarts = days.filter((day) => day.getDate() === 1);
  const maxLabels = Math.max(4, Math.floor(trackWidth / 72));

  if (dayCount <= 45 && cellWidth >= 14) {
    return { mode: "day", step: Math.max(1, Math.ceil(dayCount / maxLabels)) };
  }

  if (dayCount <= 120 && cellWidth >= 6) {
    return { mode: "day", step: Math.max(7, Math.ceil(dayCount / maxLabels)) };
  }

  if (dayCount <= 540) {
    return {
      mode: "month",
      step: Math.max(1, Math.ceil(Math.max(monthStarts.length, 1) / maxLabels)),
    };
  }

  return {
    mode: "year-month",
    step: Math.max(1, Math.ceil(Math.max(monthStarts.length, 1) / maxLabels)),
  };
}

function getProjectTimelineHeaderLabel(day, index, days, config) {
  const firstMonthSerial = getProjectTimelineMonthSerial(days[0]);
  const monthOffset = getProjectTimelineMonthSerial(day) - firstMonthSerial;
  const isFirst = index === 0;
  const isLast = index === days.length - 1;
  const isMonthStart = day.getDate() === 1;
  const previousDay = index > 0 ? days[index - 1] : null;
  const isYearBoundary = !previousDay || previousDay.getFullYear() !== day.getFullYear();

  if (config.mode === "day") {
    if (isFirst || isLast) return formatProjectTimelineMonthLabel(day, true);
    const shouldLabel = isMonthStart || index % config.step === 0;
    if (!shouldLabel) return "";
    return isYearBoundary ? formatProjectTimelineMonthLabel(day, true) : formatProjectTimelineDayLabel(day);
  }

  if (!isMonthStart && !isFirst && !isLast) return "";

  if (config.mode === "month") {
    if (isFirst || isLast) return formatProjectTimelineMonthLabel(day, true);
    if (monthOffset % config.step !== 0 && !isYearBoundary) return "";
    return isYearBoundary ? formatProjectTimelineMonthLabel(day, true) : formatProjectTimelineMonthLabel(day);
  }

  if (isFirst || isLast) return formatProjectTimelineMonthLabel(day, true);
  if (monthOffset % config.step !== 0 && !isYearBoundary) return "";
  return formatProjectTimelineMonthLabel(day, true);
}

function renderProjectTimelineDayCell(day, index, days, config) {
  const label = getProjectTimelineHeaderLabel(day, index, days, config);
  if (!label) return "";

  const isBoundary = index === 0 || index === days.length - 1 || day.getDate() === 1;
  const weekday = projectTimelineWeekdayFormatter.format(day);

  return `
    <span class="gantt-day__date">${escapeHtml(label)}</span>
    <span class="gantt-day__weekday${isBoundary ? " is-strong" : ""}">${escapeHtml(weekday)}</span>
  `;
}

function setProjectTimelineEmpty(message) {
  if (els.projectTimeline) {
    els.projectTimeline.innerHTML = "";
  }
  if (els.projectTimelineScroll) {
    els.projectTimelineScroll.classList.add("hidden");
  }
  if (els.projectTimelineEmpty) {
    els.projectTimelineEmpty.textContent = message;
    els.projectTimelineEmpty.classList.remove("hidden");
  } else if (els.projectTimeline) {
    els.projectTimeline.innerHTML = `<div class="item gantt-empty">${escapeHtml(message)}</div>`;
  }
}

function showProjectTimelineContent() {
  els.projectTimelineEmpty?.classList.add("hidden");
  els.projectTimelineScroll?.classList.remove("hidden");
}

const initialProjectTimelineFilter = parseProjectTimelineFilterSelection(pageParams.get("visible_projects"));
projectTimelineFilterMode = initialProjectTimelineFilter.mode;
selectedProjectTimelineIds = initialProjectTimelineFilter.ids;
currentProjectTimelineSort = normalizeProjectTimelineSortKey(pageParams.get("project_timeline_sort"));

function syncProjectTimelineUrl() {
  const params = new URLSearchParams(window.location.search);

  if (projectTimelineRangeState.start && projectTimelineRangeState.end) {
    params.set("project_timeline_start", projectTimelineRangeState.start);
    params.set("project_timeline_end", projectTimelineRangeState.end);
  } else {
    params.delete("project_timeline_start");
    params.delete("project_timeline_end");
  }

  if (projectTimelineFilterMode === "all") {
    params.delete("visible_projects");
  } else if (projectTimelineFilterMode === "none") {
    params.set("visible_projects", "none");
  } else {
    const serialized = [...selectedProjectTimelineIds].sort((a, b) => a - b).join(",");
    if (serialized) {
      params.set("visible_projects", serialized);
    } else {
      params.set("visible_projects", "none");
    }
  }

  if (currentProjectTimelineSort === "timeline") {
    params.delete("project_timeline_sort");
  } else {
    params.set("project_timeline_sort", currentProjectTimelineSort);
  }

  const query = params.toString();
  const nextUrl = query ? `${window.location.pathname}?${query}` : window.location.pathname;
  window.history.replaceState({}, "", nextUrl);
}

function syncProjectTimelineInputs(range) {
  if (els.projectTimelineRangeStart) {
    els.projectTimelineRangeStart.value = range?.start ? toDateKey(range.start) : "";
  }
  if (els.projectTimelineRangeEnd) {
    els.projectTimelineRangeEnd.value = range?.end ? toDateKey(range.end) : "";
  }
}

function getProjectTimelineAutoRange(items) {
  if (!items.length) return null;

  const minStart = items.reduce((min, project) => (project.start < min ? project.start : min), items[0].start);
  const maxEnd = items.reduce((max, project) => (project.end > max ? project.end : max), items[0].end);

  return {
    start: addDays(minStart, -2),
    end: addDays(maxEnd, 2),
  };
}

function getProjectTimelineProjects() {
  return projects
    .map((project) => {
      const start = parseDateOnly(project.schedule_start_date);
      const end = parseDateOnly(project.schedule_end_date);
      const due = parseDateOnly(project.schedule_due_date || project.due_date);
      if (!start || !end) return null;
      return { ...project, start, end, due };
    })
    .filter(Boolean)
    .sort(compareProjectTimelineItems);
}

function compareProjectTimelineItems(a, b) {
  const startGap = a.start - b.start;
  const endGap = a.end - b.end;
  const dueA = a.due ? a.due.getTime() : Number.POSITIVE_INFINITY;
  const dueB = b.due ? b.due.getTime() : Number.POSITIVE_INFINITY;
  const dueGap = dueA - dueB;
  const titleGap = String(a.name || "").localeCompare(String(b.name || ""), "ko", { sensitivity: "base" });

  switch (currentProjectTimelineSort) {
    case "start_date":
      return startGap || endGap || dueGap || titleGap;
    case "end_date":
      return endGap || startGap || dueGap || titleGap;
    case "due_date":
      return dueGap || endGap || startGap || titleGap;
    case "name":
      return titleGap || startGap || endGap || dueGap;
    case "timeline":
    default:
      return startGap || endGap || dueGap || titleGap;
  }
}

function syncProjectTimelineFilterSelection(items = []) {
  const availableIds = new Set(items.map((item) => Number(item.id)));

  if (projectTimelineFilterMode === "all") {
    selectedProjectTimelineIds = new Set(availableIds);
    return;
  }

  selectedProjectTimelineIds = new Set([...selectedProjectTimelineIds].filter((id) => availableIds.has(id)));

  if (projectTimelineFilterMode === "custom") {
    if (selectedProjectTimelineIds.size === 0) {
      projectTimelineFilterMode = "none";
    } else if (selectedProjectTimelineIds.size === availableIds.size) {
      projectTimelineFilterMode = "all";
    }
  }
}

function isProjectTimelineVisible(project) {
  const projectId = Number(project.id);
  if (projectTimelineFilterMode === "all") return true;
  if (projectTimelineFilterMode === "none") return false;
  return selectedProjectTimelineIds.has(projectId);
}

function renderProjectTimelineFilterPanel(items) {
  if (!els.projectTimelineFilterList || !els.projectTimelineFilterSummary) return;

  if (els.projectTimelineSortSelect) {
    els.projectTimelineSortSelect.value = currentProjectTimelineSort;
  }

  syncProjectTimelineFilterSelection(items);

  if (!items.length) {
    els.projectTimelineFilterSummary.textContent = "표시 가능한 프로젝트 일정이 없습니다.";
    els.projectTimelineFilterList.innerHTML = "<div class='gantt-filter-empty'>프로젝트 일정이 없습니다.</div>";
    return;
  }

  const selectedCount = projectTimelineFilterMode === "all" ? items.length : selectedProjectTimelineIds.size;
  els.projectTimelineFilterSummary.textContent =
    projectTimelineFilterMode === "all"
      ? `전체 ${items.length}개 프로젝트 표시 중`
      : projectTimelineFilterMode === "none"
        ? `선택된 프로젝트 없음 · 전체 ${items.length}개`
        : `${selectedCount}개 선택 / 전체 ${items.length}개`;

  els.projectTimelineFilterList.innerHTML = items
    .map((project) => {
      const checked = projectTimelineFilterMode === "all" ? true : selectedProjectTimelineIds.has(Number(project.id));
      const badgeColor = projectStatusColor(project.status);
      return `
        <label class="gantt-filter-item">
          <input type="checkbox" data-project-timeline-filter-id="${project.id}" ${checked ? "checked" : ""} />
          <span class="gantt-filter-item__body">
            <span class="gantt-filter-item__top">
              <span class="gantt-filter-item__stage" style="background:${badgeColor}18; color:${badgeColor}; border-color:${badgeColor}33;">
                ${escapeHtml(statusLabel(project.status))}
              </span>
              <span class="gantt-filter-item__date">${escapeHtml(formatProjectRange(project.schedule_start_date, project.schedule_end_date))}</span>
            </span>
            <span class="gantt-filter-item__title">${escapeHtml(project.name || "프로젝트")}</span>
          </span>
        </label>
      `;
    })
    .join("");
}

function formatProjectTimelineCursorDate(date) {
  const weekday = projectTimelineWeekdayFormatter.format(date);
  return `${toDateKey(date)} (${weekday})`;
}

function hideProjectTimelineCursorDate() {
  if (currentProjectTimelineHoveredTrack) {
    currentProjectTimelineHoveredTrack.querySelector(".gantt-cursor-line")?.classList.add("hidden");
    currentProjectTimelineHoveredTrack = null;
  }
  if (els.projectTimelineCursorDate) {
    els.projectTimelineCursorDate.classList.add("hidden");
  }
}

function showProjectTimelineCursorDate(track, clientX, clientY) {
  if (!currentProjectTimelineRenderState || !els.projectTimelineCursorDate) return;

  const rect = track.getBoundingClientRect();
  if (!rect.width || currentProjectTimelineRenderState.totalDays <= 0) return;

  const cellWidth = rect.width / currentProjectTimelineRenderState.totalDays;
  const offsetX = Math.min(Math.max(0, clientX - rect.left), Math.max(rect.width - 1, 0));
  const dayIndex = Math.min(
    currentProjectTimelineRenderState.totalDays - 1,
    Math.max(0, Math.floor(offsetX / Math.max(cellWidth, 1)))
  );
  const lineLeft = Math.min(rect.width - 1, Math.max(0, dayIndex * cellWidth + cellWidth / 2));
  const line = track.querySelector(".gantt-cursor-line");

  if (currentProjectTimelineHoveredTrack && currentProjectTimelineHoveredTrack !== track) {
    currentProjectTimelineHoveredTrack.querySelector(".gantt-cursor-line")?.classList.add("hidden");
  }

  currentProjectTimelineHoveredTrack = track;
  if (line) {
    line.style.left = `${lineLeft}px`;
    line.classList.remove("hidden");
  }

  const hoveredDate = addDays(currentProjectTimelineRenderState.rangeStart, dayIndex);
  const tooltip = els.projectTimelineCursorDate;
  tooltip.textContent = formatProjectTimelineCursorDate(hoveredDate);
  tooltip.classList.remove("hidden");

  const margin = 12;
  const offset = 16;
  const tooltipRect = tooltip.getBoundingClientRect();
  let left = clientX + offset;
  let top = clientY + offset;

  if (left + tooltipRect.width > window.innerWidth - margin) {
    left = clientX - tooltipRect.width - offset;
  }
  if (top + tooltipRect.height > window.innerHeight - margin) {
    top = clientY - tooltipRect.height - offset;
  }

  tooltip.style.left = `${Math.max(margin, left)}px`;
  tooltip.style.top = `${Math.max(margin, top)}px`;
}

function getProjectTimelineAppliedRange(autoRange) {
  const customStart = parseDateOnly(projectTimelineRangeState.start);
  const customEnd = parseDateOnly(projectTimelineRangeState.end);

  if (customStart && customEnd && customStart <= customEnd) {
    return { start: customStart, end: customEnd, isCustom: true };
  }
  if (autoRange) {
    return { ...autoRange, isCustom: false };
  }
  return null;
}

function buildProjectTimelineBands(rangeStart, rangeEnd) {
  const bands = [];
  let cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);
  let bandIndex = 0;

  while (cursor <= rangeEnd) {
    const bandStart = cursor < rangeStart ? rangeStart : cursor;
    const nextMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    const monthEnd = addDays(nextMonth, -1);
    const bandEnd = monthEnd < rangeEnd ? monthEnd : rangeEnd;
    const startIndex = diffDays(rangeStart, bandStart);
    const span = diffDays(bandStart, bandEnd) + 1;
    const forceYear = bandIndex === 0 || nextMonth > rangeEnd || cursor.getMonth() === 0;
    const label = forceYear
      ? `${cursor.getFullYear()}.${String(cursor.getMonth() + 1).padStart(2, "0")}`
      : `${cursor.getMonth() + 1}월`;

    bands.push({
      startIndex,
      span,
      label,
      isEven: bandIndex % 2 === 0,
      isYearBoundary: forceYear,
    });

    cursor = nextMonth;
    bandIndex += 1;
  }

  return {
    monthBandsHtml: bands
      .map(
        (band) => `
          <span
            class="project-overview-gantt__month-band ${band.isEven ? "is-even" : "is-odd"} ${
              band.isYearBoundary ? "is-year-boundary" : ""
            }"
            style="left:calc(${band.startIndex} * var(--project-overview-cell)); width:calc(${band.span} * var(--project-overview-cell));"
          ></span>
        `
      )
      .join(""),
    monthLabelsHtml: bands
      .map(
        (band) => `
          <span
            class="project-overview-gantt__month-label ${band.isYearBoundary ? "is-year-boundary" : ""}"
            style="left:calc(${band.startIndex} * var(--project-overview-cell) + 10px);"
          >
            ${escapeHtml(band.label)}
          </span>
        `
      )
      .join(""),
  };
}

function getProjectTimelineMetrics(totalDays) {
  const isCompact = window.innerWidth <= 900;
  const containerWidth = Math.max(
    320,
    Math.floor(els.projectTimeline?.getBoundingClientRect().width || window.innerWidth - 96)
  );
  const labelWidth = isCompact ? 0 : 240;
  const rowGap = isCompact ? 0 : 14;
  const trackShellPadding = 26;
  const trackWidth = Math.max(260, containerWidth - labelWidth - rowGap - trackShellPadding);
  const minCellWidth = totalDays > 730 ? 0.45 : totalDays > 365 ? 0.7 : totalDays > 180 ? 1 : 1.8;
  const cellWidth = Math.max(trackWidth / Math.max(totalDays, 1), minCellWidth);

  return {
    rowTemplate: isCompact ? "1fr" : "240px auto",
    cellWidth,
  };
}

function renderUpcomingItems(items) {
  upcomingItems = Array.isArray(items) ? items : [];

  const ownerCount = upcomingItems.filter((x) => x.membership_type === "owner").length;
  const participantCount = upcomingItems.filter((x) => x.membership_type === "participant").length;
  if (els.upcomingCountAll) els.upcomingCountAll.textContent = String(upcomingItems.length);
  if (els.upcomingCountOwner) els.upcomingCountOwner.textContent = String(ownerCount);
  if (els.upcomingCountParticipant) els.upcomingCountParticipant.textContent = String(participantCount);

  const visibleItems =
    upcomingRelationFilter === "all"
      ? upcomingItems
      : upcomingItems.filter((x) => x.membership_type === upcomingRelationFilter);

  if (!visibleItems.length) {
    const emptyText =
      upcomingItems.length === 0
        ? "마감 임박 작업이 없습니다."
        : upcomingRelationFilter === "owner"
          ? "Owner 프로젝트의 마감 임박 작업이 없습니다."
          : upcomingRelationFilter === "participant"
            ? "참가자 프로젝트의 마감 임박 작업이 없습니다."
            : "표시할 작업이 없습니다.";
    els.todayNotifications.innerHTML = `<div class='item'>${emptyText}</div>`;
    return;
  }

  els.todayNotifications.innerHTML = visibleItems
    .map(
      (x) => `
      <div class="item">
        <div class="item__head">
          <strong>${escapeHtml(x.project_name)}</strong>
          <div class="actions">
            <span class="badge ${relationBadgeClass(x.membership_type)}">${escapeHtml(
              relationLabel(x.membership_type)
            )}</span>
            <span class="badge">D-${x.days_left}</span>
          </div>
        </div>
        <button
          type="button"
          class="task-detail-trigger task-detail-trigger--list"
          data-open-upcoming-description="${x.checklist_id}"
        >
          ${escapeHtml(x.content)}
        </button>
        <div class="item__meta">단계: ${escapeHtml(stageLabel(x.stage))} | 목표일: ${escapeHtml(x.target_date || "-")}</div>
        <div class="actions">
          <button
            type="button"
            data-open-upcoming-project="${x.project_id}"
            data-open-upcoming-item="${x.checklist_id}"
          >
            프로젝트 보기
          </button>
        </div>
      </div>
    `
    )
    .join("");
}

async function loadSession() {
  const me = await api.get("/api/auth/me");
  currentUser = me;
  applyUserTheme(me);
  els.userInfo.textContent = `${me.display_name} (${me.username})`;
  if (me.is_admin) els.adminLink.classList.remove("hidden");

  if (els.projectForm?.elements?.owner) {
    els.projectForm.elements.owner.value = me.username;
  }
}

async function loadDashboard() {
  const data = await api.get("/api/dashboard");
  els.dashboard.projects.textContent = data.projects;
  els.dashboard.active.textContent = data.active_projects;
  els.dashboard.tasks.textContent = data.tasks;
  els.dashboard.rate.textContent = `${data.completion_rate}%`;
}

async function loadUpcomingItems() {
  const items = await api.get("/api/my/checklists/upcoming?days=30");
  renderUpcomingItems(items);
}

async function loadSiteBranding() {
  const branding = await api.get("/api/site-branding");
  renderSiteBranding(branding);
}

async function loadProjects() {
  projects = await api.get("/api/projects");
  renderProjects();
  renderProjectTimeline();
}

function renderProjects() {
  if (projects.length === 0) {
    els.projectList.innerHTML = "<div class='item'>등록된 프로젝트가 없습니다.</div>";
    return;
  }

  els.projectList.innerHTML = projects
    .map((p) => {
      const canDelete = Boolean(currentUser && (currentUser.is_admin || currentUser.username === p.owner));
      return `
      <div class="item">
        <div class="item__head">
          <strong>${escapeHtml(p.name)}</strong>
          <span class="badge">${statusLabel(p.status)}</span>
        </div>
        <div>${escapeHtml(p.description || "-")}</div>
        <div class="item__meta">담당: ${escapeHtml(p.owner)} | 마감: ${escapeHtml(p.due_date || "-")}</div>
        <div class="actions">
          <button data-open-project="${p.id}">작업 보드</button>
          <button data-open-project-gantt="${p.id}">간트 차트</button>
          <button data-open-project-calendar="${p.id}">캘린더</button>
          <button class="btn-settings" data-open-project-settings="${p.id}">프로젝트 설정</button>
          ${canDelete ? `<button class="danger" data-del-project="${p.id}">삭제</button>` : ""}
        </div>
      </div>
    `;
    })
    .join("");
}

function renderProjectTimeline() {
  if (!els.projectTimeline) return;
  hideProjectTimelineCursorDate();
  currentProjectTimelineRenderState = null;

  const timelineProjects = getProjectTimelineProjects();
  renderProjectTimelineFilterPanel(timelineProjects);
  syncProjectTimelineUrl();

  if (!timelineProjects.length) {
    const customRange = getProjectTimelineAppliedRange(null);
    syncProjectTimelineInputs(customRange);
    els.projectTimeline.innerHTML = "<div class='item project-overview-gantt__empty'>표시할 프로젝트 일정이 없습니다.</div>";
    return;
  }

  const filteredProjects = timelineProjects.filter((project) => isProjectTimelineVisible(project));
  if (!filteredProjects.length) {
    const customRange = getProjectTimelineAppliedRange(null);
    syncProjectTimelineInputs(customRange);
    els.projectTimeline.innerHTML = "<div class='item project-overview-gantt__empty'>선택된 프로젝트가 없습니다.</div>";
    return;
  }

  const autoRange = getProjectTimelineAutoRange(filteredProjects);
  const appliedRange = getProjectTimelineAppliedRange(autoRange);
  if (!appliedRange) {
    els.projectTimeline.innerHTML = "<div class='item project-overview-gantt__empty'>표시할 프로젝트 일정이 없습니다.</div>";
    return;
  }

  syncProjectTimelineInputs(appliedRange);

  const visibleProjects = filteredProjects
    .map((project) => {
      if (project.end < appliedRange.start || project.start > appliedRange.end) return null;

      return {
        ...project,
        visibleStart: project.start < appliedRange.start ? appliedRange.start : project.start,
        visibleEnd: project.end > appliedRange.end ? appliedRange.end : project.end,
      };
    })
    .filter(Boolean);

  if (!visibleProjects.length) {
    els.projectTimeline.innerHTML =
      "<div class='item project-overview-gantt__empty'>선택한 범위에 표시할 프로젝트 일정이 없습니다.</div>";
    return;
  }

  const totalDays = diffDays(appliedRange.start, appliedRange.end) + 1;
  const metrics = getProjectTimelineMetrics(totalDays);
  const styleVars = `--project-overview-days:${totalDays}; --project-overview-cell:${metrics.cellWidth}px;`;
  const { monthBandsHtml, monthLabelsHtml } = buildProjectTimelineBands(appliedRange.start, appliedRange.end);
  currentProjectTimelineRenderState = {
    rangeStart: new Date(appliedRange.start),
    totalDays,
  };

  const rowsHtml = visibleProjects
    .map((project) => {
      const barLeft = diffDays(appliedRange.start, project.visibleStart);
      const barSpan = diffDays(project.visibleStart, project.visibleEnd) + 1;
      const dueIndex =
        project.due && project.due >= appliedRange.start && project.due <= appliedRange.end
          ? diffDays(appliedRange.start, project.due)
          : null;
      const barColor = projectStatusColor(project.status);
      return `
        <div class="project-overview-gantt__row" style="grid-template-columns:${metrics.rowTemplate};">
          <div class="project-overview-gantt__label">
            <div class="item__head">
              <strong>${escapeHtml(project.name)}</strong>
              <span class="badge">${escapeHtml(statusLabel(project.status))}</span>
            </div>
            <div class="item__meta">기간: ${escapeHtml(
              formatProjectRange(project.schedule_start_date, project.schedule_end_date)
            )}</div>
            <div class="item__meta">담당: ${escapeHtml(project.owner)} | 마감: ${escapeHtml(project.due_date || "-")}</div>
          </div>
          <div class="project-overview-gantt__track-wrap">
            <div class="project-overview-gantt__track" style="${styleVars}">
              ${monthBandsHtml}
              ${
                dueIndex !== null
                  ? `<span class="project-overview-gantt__marker" style="left:calc(${dueIndex} * var(--project-overview-cell))"></span>`
                  : ""
              }
              <button
                type="button"
                class="project-overview-gantt__bar"
                data-open-project-gantt="${project.id}"
                style="left:calc(${barLeft} * var(--project-overview-cell)); width:calc(${barSpan} * var(--project-overview-cell) - 8px); background:${barColor};"
                title="${escapeHtml(project.name)} 간트 차트 열기"
              >
                <span class="project-overview-gantt__bar-title">${escapeHtml(project.name)}</span>
              </button>
              <span class="project-overview-gantt__cursor-line hidden" aria-hidden="true"></span>
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  els.projectTimeline.innerHTML = `
    <div class="project-overview-gantt__scroll">
      <div class="project-overview-gantt__board">
        <div class="project-overview-gantt__row project-overview-gantt__row--header" style="grid-template-columns:${metrics.rowTemplate};">
          <div class="project-overview-gantt__label project-overview-gantt__label--header">
            <span class="project-overview-gantt__eyebrow">Project Timeline</span>
            <strong>프로젝트</strong>
          </div>
          <div class="project-overview-gantt__track-wrap">
            <div class="project-overview-gantt__track project-overview-gantt__track--header" style="${styleVars}">
              ${monthBandsHtml}
              <div class="project-overview-gantt__month-labels">${monthLabelsHtml}</div>
              <span class="project-overview-gantt__cursor-line hidden" aria-hidden="true"></span>
            </div>
          </div>
        </div>
        ${rowsHtml}
      </div>
    </div>
  `;
}

function hideProjectTimelineCursorDate() {
  if (currentProjectTimelineHoveredTrack) {
    currentProjectTimelineHoveredTrack.querySelector(".gantt-cursor-line")?.classList.add("hidden");
    currentProjectTimelineHoveredTrack = null;
  }
  if (els.projectTimelineCursorDate) {
    els.projectTimelineCursorDate.classList.add("hidden");
  }
}

function showProjectTimelineCursorDate(track, clientX, clientY) {
  if (!currentProjectTimelineRenderState || !els.projectTimelineCursorDate) return;

  const rect = track.getBoundingClientRect();
  if (!rect.width || currentProjectTimelineRenderState.totalDays <= 0) return;

  const cellWidth = rect.width / currentProjectTimelineRenderState.totalDays;
  const offsetX = Math.min(Math.max(0, clientX - rect.left), Math.max(rect.width - 1, 0));
  const dayIndex = Math.min(
    currentProjectTimelineRenderState.totalDays - 1,
    Math.max(0, Math.floor(offsetX / Math.max(cellWidth, 1)))
  );
  const lineLeft = Math.min(rect.width - 1, Math.max(0, dayIndex * cellWidth + cellWidth / 2));
  const line = track.querySelector(".gantt-cursor-line");

  if (currentProjectTimelineHoveredTrack && currentProjectTimelineHoveredTrack !== track) {
    currentProjectTimelineHoveredTrack.querySelector(".gantt-cursor-line")?.classList.add("hidden");
  }

  currentProjectTimelineHoveredTrack = track;
  if (line) {
    line.style.left = `${lineLeft}px`;
    line.classList.remove("hidden");
  }

  const hoveredDate = addDays(currentProjectTimelineRenderState.rangeStart, dayIndex);
  const tooltip = els.projectTimelineCursorDate;
  tooltip.textContent = formatProjectTimelineCursorDate(hoveredDate);
  tooltip.classList.remove("hidden");

  const margin = 12;
  const offset = 16;
  const tooltipRect = tooltip.getBoundingClientRect();
  let left = clientX + offset;
  let top = clientY + offset;

  if (left + tooltipRect.width > window.innerWidth - margin) {
    left = clientX - tooltipRect.width - offset;
  }
  if (top + tooltipRect.height > window.innerHeight - margin) {
    top = clientY - tooltipRect.height - offset;
  }

  tooltip.style.left = `${Math.max(margin, left)}px`;
  tooltip.style.top = `${Math.max(margin, top)}px`;
}

function buildProjectTimelineBands(days, cellWidth, headerConfig) {
  if (!days.length) {
    return {
      monthBandsHtml: "",
      trackBandsHtml: "",
      headerLabelsHtml: "",
    };
  }

  const bands = [];
  let startIndex = 0;
  let bandIndex = 0;

  for (let index = 1; index <= days.length; index += 1) {
    const current = days[index];
    const previous = days[index - 1];
    const crossedMonth =
      index === days.length ||
      current.getMonth() !== previous.getMonth() ||
      current.getFullYear() !== previous.getFullYear();

    if (!crossedMonth) continue;

    const startDay = days[startIndex];
    bands.push({
      day: startDay,
      startIndex,
      span: index - startIndex,
      isEven: bandIndex % 2 === 0,
      isYearBoundary: startDay.getMonth() === 0,
    });
    startIndex = index;
    bandIndex += 1;
  }

  const headerLabelsHtml =
    headerConfig?.mode === "day"
      ? ""
      : (() => {
          const lastIndex = days.length - 1;
          const startText = formatProjectTimelineMonthLabel(days[0], true);
          const endText = formatProjectTimelineMonthLabel(days[lastIndex], true);
          const minGapPx = headerConfig?.mode === "year-month" ? 150 : 110;
          const edgeGapPx = 84;

          const rawLabels = days
            .map((day, index) => ({
              day,
              index,
              text: getProjectTimelineHeaderLabel(day, index, days, headerConfig),
              isYearBoundary: index === 0 || index === lastIndex || day.getMonth() === 0,
            }))
            .filter((entry) => entry.text && entry.index !== 0 && entry.index !== lastIndex);

          const filtered = [];

          for (const entry of rawLabels) {
            const distanceFromStart = entry.index * cellWidth;
            const distanceFromEnd = (lastIndex - entry.index) * cellWidth;
            const previous = filtered[filtered.length - 1];
            const gapFromPrevious = previous
              ? (entry.index - previous.index) * cellWidth
              : Number.POSITIVE_INFINITY;

            if (distanceFromStart < edgeGapPx || distanceFromEnd < edgeGapPx) continue;
            if (gapFromPrevious < minGapPx && !entry.isYearBoundary) continue;
            if (previous?.isYearBoundary && gapFromPrevious < minGapPx * 0.8) continue;

            filtered.push(entry);
          }

          const middleLabels = filtered
            .map(
              (entry) => `
                <span
                  class="gantt-header-label ${entry.isYearBoundary ? "is-year-boundary" : ""}"
                  style="left:calc(${entry.index} * var(--gantt-cell-width));"
                  title="${toDateKey(entry.day)}"
                >
                  ${escapeHtml(entry.text)}
                </span>
              `
            )
            .join("");

          return `
            <span class="gantt-header-label is-start" title="${toDateKey(days[0])}">
              ${escapeHtml(startText)}
            </span>
            ${middleLabels}
            <span class="gantt-header-label is-end" title="${toDateKey(days[lastIndex])}">
              ${escapeHtml(endText)}
            </span>
          `;
        })();

  return {
    monthBandsHtml: `
      <div class="gantt-month-bands">
        ${bands
          .map(
            (band) => `
              <span
                class="gantt-month-band ${band.isYearBoundary ? "is-year-start" : ""}"
                style="left:calc(${band.startIndex} * var(--gantt-cell-width)); width:calc(${band.span} * var(--gantt-cell-width));"
              ></span>
            `
          )
          .join("")}
      </div>
    `,
    trackBandsHtml: `
      <div class="gantt-track-bands">
        ${bands
          .map(
            (band) => `
              <span
                class="gantt-track-band ${band.isEven ? "is-even" : "is-odd"} ${
                  band.isYearBoundary ? "is-year-start" : ""
                }"
                style="left:calc(${band.startIndex} * var(--gantt-cell-width)); width:calc(${band.span} * var(--gantt-cell-width));"
              ></span>
            `
          )
          .join("")}
      </div>
    `,
    headerLabelsHtml,
  };
}

function buildProjectTimelineMarkerHtml(todayIndex, dueIndex) {
  return `
    ${
      todayIndex !== null && todayIndex !== undefined
        ? `<span class="gantt-marker gantt-marker--today" style="left:calc(${todayIndex} * var(--gantt-cell-width))"></span>`
        : ""
    }
    ${
      dueIndex !== null && dueIndex !== undefined
        ? `<span class="gantt-marker gantt-marker--due" style="left:calc(${dueIndex} * var(--gantt-cell-width))"></span>`
        : ""
    }
  `;
}

function formatProjectTimelineDuration(start, end) {
  return `${diffDays(start, end) + 1}d`;
}

function buildProjectTimelineLanes(projects) {
  const lanes = [];

  projects.forEach((project) => {
    const startTime = project.visibleStart.getTime();
    const endTime = project.visibleEnd.getTime();
    let targetLane = null;

    for (const lane of lanes) {
      if (startTime > lane.lastEndTime) {
        targetLane = lane;
        break;
      }
    }

    if (!targetLane) {
      targetLane = {
        items: [],
        lastEndTime: Number.NEGATIVE_INFINITY,
      };
      lanes.push(targetLane);
    }

    targetLane.items.push(project);
    targetLane.lastEndTime = endTime;
  });

  return lanes;
}

function renderProjectTimelineRows({
  projects,
  appliedRange,
  styleVars,
  labelWidth,
  todayIndex,
  trackBandsHtml,
  headerMode,
}) {
  const packedProjects = [...projects].sort((a, b) => {
    return (
      a.visibleStart - b.visibleStart ||
      a.visibleEnd - b.visibleEnd ||
      a.start - b.start ||
      String(a.name || "").localeCompare(String(b.name || ""), "ko", { sensitivity: "base" })
    );
  });
  const lanes = buildProjectTimelineLanes(packedProjects);

  return lanes
    .map((lane, laneIndex) => {
      if (lane.items.length === 1) {
        const project = lane.items[0];
        const barLeft = diffDays(appliedRange.start, project.visibleStart);
        const barSpan = diffDays(project.visibleStart, project.visibleEnd) + 1;
        const dueIndex =
          project.due && project.due >= appliedRange.start && project.due <= appliedRange.end
            ? diffDays(appliedRange.start, project.due)
            : null;
        const barColor = projectStatusColor(project.status);
        const durationLabel = formatProjectTimelineDuration(project.start, project.end);

        return `
          <div class="gantt-row gantt-row--task" style="grid-template-columns:${labelWidth}px auto;">
            <div class="gantt-label gantt-label--card project-overview-gantt__label-card">
              <div class="gantt-label__top">
                <span
                  class="gantt-stage-pill"
                  style="background:${barColor}18; color:${barColor}; border-color:${barColor}33;"
                >
                  ${escapeHtml(statusLabel(project.status))}
                </span>
                <span class="gantt-duration-pill">${durationLabel}</span>
              </div>
              <div class="project-overview-gantt__title-row">
                <strong class="gantt-task-title project-overview-gantt__title">${escapeHtml(project.name)}</strong>
                <span class="project-overview-gantt__owner">Owner ${escapeHtml(project.owner)}</span>
              </div>
              <div class="project-overview-gantt__facts">
                <span class="project-overview-gantt__fact">
                  <span class="project-overview-gantt__fact-label">시작</span>
                  <span class="project-overview-gantt__fact-value">${escapeHtml(project.schedule_start_date || toDateKey(project.start))}</span>
                </span>
                <span class="project-overview-gantt__fact">
                  <span class="project-overview-gantt__fact-label">종료</span>
                  <span class="project-overview-gantt__fact-value">${escapeHtml(project.schedule_end_date || toDateKey(project.end))}</span>
                </span>
                ${
                  project.due_date
                    ? `
                      <span class="project-overview-gantt__fact project-overview-gantt__fact--due">
                        <span class="project-overview-gantt__fact-label">마감</span>
                        <span class="project-overview-gantt__fact-value">${escapeHtml(project.due_date)}</span>
                      </span>
                    `
                    : ""
                }
              </div>
            </div>
            <div class="gantt-track-shell">
              <div class="gantt-track ${headerMode !== "day" ? "gantt-track--overview" : ""}" style="${styleVars}">
                ${headerMode !== "day" ? trackBandsHtml : ""}
                ${buildProjectTimelineMarkerHtml(todayIndex, dueIndex)}
                <button
                  type="button"
                  class="gantt-bar"
                  data-open-project-gantt="${project.id}"
                  style="left:calc(${barLeft} * var(--gantt-cell-width)); width:calc(${barSpan} * var(--gantt-cell-width) - 8px); background:${barColor};"
                  title="${escapeHtml(project.name)} 간트 차트 열기"
                  aria-label="${escapeHtml(project.name)} 간트 차트 열기"
                >
                  <span class="gantt-bar__title">${escapeHtml(project.name)}</span>
                  ${barSpan >= 4 ? `<span class="gantt-bar__duration">${durationLabel}</span>` : ""}
                </button>
                <span class="gantt-cursor-line hidden" aria-hidden="true"></span>
              </div>
            </div>
          </div>
        `;
      }

      const laneBarsHtml = lane.items
        .map((project) => {
          const barLeft = diffDays(appliedRange.start, project.visibleStart);
          const barSpan = diffDays(project.visibleStart, project.visibleEnd) + 1;
          const dueIndex =
            project.due && project.due >= appliedRange.start && project.due <= appliedRange.end
              ? diffDays(appliedRange.start, project.due)
              : null;
          const barColor = projectStatusColor(project.status);
          const durationLabel = formatProjectTimelineDuration(project.start, project.end);

          return `
            ${
              dueIndex !== null
                ? `<span class="gantt-marker gantt-marker--due" style="left:calc(${dueIndex} * var(--gantt-cell-width))"></span>`
                : ""
            }
            <button
              type="button"
              class="gantt-bar"
              data-open-project-gantt="${project.id}"
              style="left:calc(${barLeft} * var(--gantt-cell-width)); width:calc(${barSpan} * var(--gantt-cell-width) - 8px); background:${barColor};"
              title="${escapeHtml(project.name)} 간트 차트 열기"
              aria-label="${escapeHtml(project.name)} 간트 차트 열기"
            >
              <span class="gantt-bar__title">${escapeHtml(project.name)}</span>
              ${barSpan >= 4 ? `<span class="gantt-bar__duration">${durationLabel}</span>` : ""}
            </button>
          `;
        })
        .join("");

      const laneItemsHtml = lane.items
        .map((project) => {
          const barColor = projectStatusColor(project.status);
          const rangeLabel = `${project.schedule_start_date || toDateKey(project.start)} ~ ${
            project.schedule_end_date || toDateKey(project.end)
          }`;
          return `
            <button
              type="button"
              class="gantt-lane-chip"
              data-open-project-gantt="${project.id}"
              style="--lane-chip-bg:${barColor}18; --lane-chip-border:${barColor}33; --lane-chip-fg:${barColor};"
              title="${escapeHtml(project.name)} | ${escapeHtml(rangeLabel)}"
              aria-label="${escapeHtml(project.name)} 간트 차트 열기"
            >
              ${escapeHtml(project.name)}
            </button>
          `;
        })
        .join("");

      return `
        <div class="gantt-row gantt-row--task" style="grid-template-columns:${labelWidth}px auto;">
          <div class="gantt-label gantt-label--card gantt-lane-card">
            <div class="gantt-label__top">
              <span class="gantt-duration-pill">겹침 레인 ${laneIndex + 1}</span>
              <span class="gantt-duration-pill">${lane.items.length}개 일정</span>
            </div>
            <div class="gantt-lane-chip-list">
              ${laneItemsHtml}
            </div>
          </div>
          <div class="gantt-track-shell">
            <div class="gantt-track ${headerMode !== "day" ? "gantt-track--overview" : ""}" style="${styleVars}">
              ${headerMode !== "day" ? trackBandsHtml : ""}
              ${buildProjectTimelineMarkerHtml(todayIndex, null)}
              ${laneBarsHtml}
              <span class="gantt-cursor-line hidden" aria-hidden="true"></span>
            </div>
          </div>
        </div>
      `;
    })
    .join("");
}

function getProjectTimelineMetrics(totalDays) {
  const labelWidth = window.innerWidth <= 900 ? 200 : 260;
  const viewportWidth = Math.max(
    320,
    Math.floor(els.projectTimelineScroll?.getBoundingClientRect().width || window.innerWidth - 96)
  );
  const trackWidth = Math.max(240, viewportWidth - labelWidth - 16);
  const cellWidth = clampNumber(trackWidth / Math.max(totalDays, 1), 2, 38);

  return {
    labelWidth,
    cellWidth,
  };
}

function renderProjectTimeline() {
  if (!els.projectTimeline) return;
  hideProjectTimelineCursorDate();
  currentProjectTimelineRenderState = null;
  renderProjectTimelineLegend();

  const timelineProjects = getProjectTimelineProjects();
  renderProjectTimelineFilterPanel(timelineProjects);
  syncProjectTimelineUrl();

  if (!timelineProjects.length) {
    const customRange = getProjectTimelineAppliedRange(null);
    syncProjectTimelineInputs(customRange);
    setProjectTimelineEmpty("표시할 프로젝트 일정이 없습니다.");
    return;
  }

  const filteredProjects = timelineProjects.filter((project) => isProjectTimelineVisible(project));
  if (!filteredProjects.length) {
    const customRange = getProjectTimelineAppliedRange(null);
    syncProjectTimelineInputs(customRange);
    setProjectTimelineEmpty("선택된 프로젝트가 없습니다.");
    return;
  }

  const autoRange = getProjectTimelineAutoRange(filteredProjects);
  const appliedRange = getProjectTimelineAppliedRange(autoRange);
  if (!appliedRange) {
    setProjectTimelineEmpty("표시할 프로젝트 일정이 없습니다.");
    return;
  }

  syncProjectTimelineInputs(appliedRange);

  const visibleProjects = filteredProjects
    .map((project) => {
      if (project.end < appliedRange.start || project.start > appliedRange.end) return null;

      return {
        ...project,
        visibleStart: project.start < appliedRange.start ? appliedRange.start : project.start,
        visibleEnd: project.end > appliedRange.end ? appliedRange.end : project.end,
      };
    })
    .filter(Boolean);

  if (!visibleProjects.length) {
    setProjectTimelineEmpty("선택한 범위에 표시할 프로젝트 일정이 없습니다.");
    return;
  }

  showProjectTimelineContent();

  const days = buildProjectTimelineDays(appliedRange.start, appliedRange.end);
  const totalDays = days.length;
  const metrics = getProjectTimelineMetrics(totalDays);
  const styleVars = `--gantt-days:${totalDays}; --gantt-cell-width:${metrics.cellWidth}px;`;
  const headerConfig = getProjectTimelineHeaderConfig(days, metrics.cellWidth);
  const { monthBandsHtml, trackBandsHtml, headerLabelsHtml } = buildProjectTimelineBands(
    days,
    metrics.cellWidth,
    headerConfig
  );
  const today = parseDateOnly(toDateKey(new Date()));
  const todayIndex = today && today >= appliedRange.start && today <= appliedRange.end ? diffDays(appliedRange.start, today) : null;
  currentProjectTimelineRenderState = {
    rangeStart: new Date(appliedRange.start),
    totalDays,
  };

  const headerDaysHtml = days
    .map((day, index) => {
      const classes = [
        "gantt-day",
        day.getDay() === 0 || day.getDay() === 6 ? "is-weekend" : "",
        day.getDay() === 1 ? "is-week-start" : "",
        day.getDate() === 1 ? "is-month-start" : "",
        headerConfig.mode === "day" ? "is-day-mode" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<div class="${classes}" title="${toDateKey(day)}">${
        headerConfig.mode === "day" ? renderProjectTimelineDayCell(day, index, days, headerConfig) : ""
      }</div>`;
    })
    .join("");

  const rowsHtml = renderProjectTimelineRows({
    projects: visibleProjects,
    appliedRange,
    styleVars,
    labelWidth: metrics.labelWidth,
    todayIndex,
    trackBandsHtml,
    headerMode: headerConfig.mode,
  });

  els.projectTimeline.innerHTML = `
    <div class="gantt-board">
      <div class="gantt-row gantt-row--header" style="grid-template-columns:${metrics.labelWidth}px auto;">
        <div class="gantt-label gantt-label--header-card">
          <span class="gantt-label__eyebrow">Project Timeline</span>
          <strong>프로젝트</strong>
        </div>
        <div class="gantt-track-shell gantt-track-shell--header">
          <div class="gantt-days ${headerConfig.mode !== "day" ? "gantt-days--condensed gantt-days--overview" : ""}" style="${styleVars}">
            ${monthBandsHtml}
            ${headerDaysHtml}
            ${headerLabelsHtml ? `<div class="gantt-header-labels">${headerLabelsHtml}</div>` : ""}
            <span class="gantt-cursor-line hidden" aria-hidden="true"></span>
          </div>
        </div>
      </div>
      ${rowsHtml}
    </div>
  `;
}

function applyProjectTimelineRangeFromInputs() {
  const start = normalizeDateInputValue(els.projectTimelineRangeStart?.value);
  const end = normalizeDateInputValue(els.projectTimelineRangeEnd?.value);

  if (!start || !end) return;
  if (start > end) return;

  projectTimelineRangeState.start = start;
  projectTimelineRangeState.end = end;
  syncProjectTimelineUrl();
  renderProjectTimeline();
}

function resetProjectTimelineRange() {
  projectTimelineRangeState.start = "";
  projectTimelineRangeState.end = "";
  syncProjectTimelineUrl();
  renderProjectTimeline();
}

function setProjectTimelineFilterMode(nextMode, ids = new Set()) {
  projectTimelineFilterMode = nextMode;
  selectedProjectTimelineIds = new Set(ids);
  syncProjectTimelineUrl();
  renderProjectTimeline();
}

els.logoutBtn.addEventListener("click", async () => {
  await api.post("/api/auth/logout", {});
  window.location.href = "/static/login.html";
});

els.projectForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const payload = Object.fromEntries(new FormData(els.projectForm).entries());
    payload.name = String(payload.name || "").trim();
    payload.owner = String(payload.owner || "").trim();
    payload.due_date = String(payload.due_date || "").trim();
    payload.description = String(payload.description || "").trim();

    const requiredFields = [
      { key: "name", label: "프로젝트명" },
      { key: "owner", label: "Owner" },
      { key: "due_date", label: "연도-월-일" },
      { key: "description", label: "설명" },
    ];
    const missing = requiredFields.filter((f) => !payload[f.key]);
    if (missing.length > 0) {
      alert(`빈 곳이 있습니다: ${missing.map((x) => x.label).join(", ")}`);
      const first = missing[0];
      els.projectForm.elements[first.key]?.focus();
      return;
    }

    await api.post("/api/projects", payload);
    els.projectForm.reset();
    if (currentUser && els.projectForm?.elements?.owner) {
      els.projectForm.elements.owner.value = currentUser.username;
    }
    await refreshAll();
  } catch (err) {
    alert(parseApiError(err));
  }
});

els.projectList?.addEventListener("click", async (e) => {
  const openBtn = e.target.closest("[data-open-project]");
  if (openBtn) {
    const id = openBtn.getAttribute("data-open-project");
    window.location.href = `/static/project.html?project_id=${id}`;
    return;
  }

  const settingsBtn = e.target.closest("[data-open-project-settings]");
  if (settingsBtn) {
    const id = settingsBtn.getAttribute("data-open-project-settings");
    window.location.href = `/static/project_settings.html?project_id=${id}`;
    return;
  }

  const ganttBtn = e.target.closest("[data-open-project-gantt]");
  if (ganttBtn) {
    const id = ganttBtn.getAttribute("data-open-project-gantt");
    window.location.href = `/static/project_gantt.html?project_id=${id}`;
    return;
  }

  const calendarBtn = e.target.closest("[data-open-project-calendar]");
  if (calendarBtn) {
    const id = calendarBtn.getAttribute("data-open-project-calendar");
    window.location.href = `/static/project_calendar.html?project_id=${id}`;
    return;
  }

  const delBtn = e.target.closest("[data-del-project]");
  if (!delBtn) return;

  const id = delBtn.getAttribute("data-del-project");
  if (!confirm("프로젝트를 삭제하면 관련 작업도 함께 삭제됩니다. 계속할까요?")) return;

  const password = prompt("프로젝트 삭제를 위해 본인 비밀번호를 입력하세요.");
  if (password === null) return;
  if (!String(password).trim()) {
    alert("비밀번호를 입력해야 삭제할 수 있습니다.");
    return;
  }

  try {
    await api.del(`/api/projects/${id}`, { password: String(password).trim() });
    await refreshAll();
  } catch (err) {
    alert(parseApiError(err));
  }
});

els.projectTimelineScroll?.addEventListener("click", (e) => {
  const ganttBtn = e.target.closest("[data-open-project-gantt]");
  if (!ganttBtn) return;
  const id = ganttBtn.getAttribute("data-open-project-gantt");
  window.location.href = `/static/project_gantt.html?project_id=${id}`;
});

els.projectTimelineRangeForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  applyProjectTimelineRangeFromInputs();
});

els.projectTimelineRangeStart?.addEventListener("change", () => {
  applyProjectTimelineRangeFromInputs();
});

els.projectTimelineRangeEnd?.addEventListener("change", () => {
  window.setTimeout(() => {
    applyProjectTimelineRangeFromInputs();
  }, 0);
});

els.projectTimelineRangeReset?.addEventListener("click", () => {
  resetProjectTimelineRange();
});

els.projectTimelineFilterList?.addEventListener("change", (e) => {
  const checkbox = e.target.closest("[data-project-timeline-filter-id]");
  if (!checkbox) return;

  const projectId = Number(checkbox.getAttribute("data-project-timeline-filter-id"));
  if (!Number.isFinite(projectId)) return;

  if (checkbox.checked) {
    selectedProjectTimelineIds.add(projectId);
  } else {
    selectedProjectTimelineIds.delete(projectId);
  }

  const availableProjects = getProjectTimelineProjects();
  if (selectedProjectTimelineIds.size === 0) {
    projectTimelineFilterMode = "none";
  } else if (selectedProjectTimelineIds.size === availableProjects.length) {
    projectTimelineFilterMode = "all";
  } else {
    projectTimelineFilterMode = "custom";
  }

  syncProjectTimelineUrl();
  renderProjectTimeline();
});

els.projectTimelineFilterSelectAll?.addEventListener("click", () => {
  const allProjectIds = getProjectTimelineProjects().map((project) => Number(project.id));
  setProjectTimelineFilterMode("all", new Set(allProjectIds));
});

els.projectTimelineFilterClearAll?.addEventListener("click", () => {
  setProjectTimelineFilterMode("none", new Set());
});

els.projectTimelineSortSelect?.addEventListener("change", (e) => {
  currentProjectTimelineSort = normalizeProjectTimelineSortKey(e.target.value);
  syncProjectTimelineUrl();
  renderProjectTimeline();
});

els.projectTimelineScroll?.addEventListener("mousemove", (e) => {
  const track = e.target.closest(".gantt-track, .gantt-days");
  if (!track || !els.projectTimelineScroll.contains(track)) {
    hideProjectTimelineCursorDate();
    return;
  }
  showProjectTimelineCursorDate(track, e.clientX, e.clientY);
});

els.projectTimelineScroll?.addEventListener("mouseleave", () => {
  hideProjectTimelineCursorDate();
});

window.addEventListener("resize", () => {
  renderProjectTimeline();
});

els.todayNotifications?.addEventListener("click", (e) => {
  const detailBtn = e.target.closest("[data-open-upcoming-description]");
  if (detailBtn) {
    const checklistId = Number(detailBtn.getAttribute("data-open-upcoming-description"));
    const item = upcomingItems.find((x) => Number(x.checklist_id) === checklistId);
    if (!item) return;

    showTaskDescriptionModal({
      title: item.content || "작업 설명",
      description: item.description || "",
      projectName: item.project_name || "",
      stageName: stageLabel(item.stage),
      startDate: item.start_date || "",
      targetDate: item.target_date || "",
      workflowStatus: item.workflow_status || "upcoming",
      editable: Boolean(
        currentUser?.is_admin ||
          item.membership_type === "owner" ||
          item.membership_type === "participant" ||
          item.membership_type === "admin"
      ),
      onSave: async (payload) => {
        const saved = await api.patch(`/api/checklists/${checklistId}`, {
          content: payload.content,
          description: payload.description,
          start_date: payload.start_date,
          target_date: payload.target_date,
          workflow_status: payload.workflow_status,
        });
        await refreshAll();
        return {
          ...saved,
          stageName: stageLabel(saved.stage || item.stage),
        };
      },
    });
    return;
  }

  const btn = e.target.closest("[data-open-upcoming-project]");
  if (!btn) return;

  const projectId = btn.getAttribute("data-open-upcoming-project");
  const itemId = btn.getAttribute("data-open-upcoming-item");
  window.location.href = `/static/project.html?project_id=${projectId}&checklist_id=${itemId}`;
});

els.upcomingFilter?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-upcoming-filter]");
  if (!btn) return;
  const filter = btn.getAttribute("data-upcoming-filter") || "all";
  upcomingRelationFilter = filter;
  els.upcomingFilter.querySelectorAll("[data-upcoming-filter]").forEach((x) => {
    x.classList.toggle("is-active", x.getAttribute("data-upcoming-filter") === filter);
  });
  renderUpcomingItems(upcomingItems);
});

async function refreshAll() {
  await Promise.all([loadDashboard(), loadProjects(), loadUpcomingItems()]);
}

Promise.resolve()
  .then(async () => {
    await loadSession();
    await Promise.all([loadSiteBranding(), refreshAll()]);
  })
  .catch((err) => {
    console.error(err);
    if (!String(err.message).includes("Unauthorized")) {
      alert(`오류가 발생했습니다: ${parseApiError(err)}`);
    }
  });
