const params = new URLSearchParams(window.location.search);
const projectId = Number(params.get("project_id"));
const returnChecklistId = Number(params.get("checklist_id") || "0");

if (!projectId) {
  alert("유효하지 않은 프로젝트입니다.");
  window.location.href = "/";
  throw new Error("Invalid project_id");
}

const { createApiClient, escapeHtml, parseApiError, applyUserTheme, showTaskDescriptionModal } = window.PMCommon;
const api = createApiClient();

const els = {
  title: document.getElementById("project-title"),
  subtitle: document.getElementById("project-subtitle"),
  projectBoardLink: document.getElementById("project-board-link"),
  projectCalendarLink: document.getElementById("project-calendar-link"),
  projectSettingsLink: document.getElementById("project-settings-link"),
  adminLink: document.getElementById("admin-link"),
  logoutBtn: document.getElementById("logout-btn"),
  projectDue: document.getElementById("gantt-project-due"),
  scheduledCount: document.getElementById("gantt-scheduled-count"),
  unscheduledCount: document.getElementById("gantt-unscheduled-count"),
  rangeLabel: document.getElementById("gantt-range-label"),
  legend: document.getElementById("gantt-legend"),
  empty: document.getElementById("gantt-empty"),
  scroll: document.getElementById("gantt-scroll"),
  unscheduledList: document.getElementById("gantt-unscheduled-list"),
  rangeForm: document.getElementById("gantt-range-form"),
  rangeStart: document.getElementById("gantt-range-start"),
  rangeEnd: document.getElementById("gantt-range-end"),
  rangeReset: document.getElementById("gantt-range-reset"),
  filterList: document.getElementById("gantt-filter-list"),
  filterSummary: document.getElementById("gantt-filter-summary"),
  filterSelectAll: document.getElementById("gantt-filter-select-all"),
  filterClearAll: document.getElementById("gantt-filter-clear-all"),
  sortSelect: document.getElementById("gantt-sort-select"),
  cursorDate: document.getElementById("gantt-cursor-date"),
};

const STAGE_COLORS = ["#0f6d66", "#2a6f97", "#c06c2c", "#7a4fb0", "#3b7a57", "#9b2226"];

let currentProject = null;
let projectStages = [];
let checklistItems = [];
let projectTitle = "프로젝트";
let manualTimelineRange = null;
let currentUser = null;
let canEditTasks = false;
let taskFilterMode = "all";
let selectedTaskIds = new Set();
let currentSort = "timeline";
let currentGanttRenderState = null;
let currentGanttHoveredTrack = null;
let hasAppliedReturnFocus = false;
const ganttCursorWeekdayFormatter = new Intl.DateTimeFormat("ko-KR", { weekday: "short" });

function parseTaskFilterSelection(raw) {
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

function getCurrentRelativeUrl() {
  return `${window.location.pathname}${window.location.search}${window.location.hash || ""}`;
}

function buildTaskManagerUrl(checklistId = null) {
  const next = new URL("/static/project_settings.html", window.location.origin);
  next.searchParams.set("project_id", String(projectId));
  next.searchParams.set("return_to", getCurrentRelativeUrl());
  next.searchParams.set("task_action", checklistId ? "edit" : "create");
  if (checklistId) {
    next.searchParams.set("edit_checklist_id", String(checklistId));
  }
  next.hash = "task-management";
  return `${next.pathname}${next.search}${next.hash}`;
}

const initialTaskFilter = parseTaskFilterSelection(params.get("visible_tasks"));
taskFilterMode = initialTaskFilter.mode;
selectedTaskIds = initialTaskFilter.ids;
currentSort = normalizeSortKey(params.get("sort_by"));

function normalizeSortKey(raw) {
  const key = String(raw || "timeline").trim();
  return ["timeline", "manual", "start_date", "target_date", "title"].includes(key) ? key : "timeline";
}

function parseLocalDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
  return new Date(`${value}T00:00:00`);
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

function formatRange(start, end) {
  if (!start || !end) return "-";
  const formatter = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "short", day: "numeric" });
  return `${formatter.format(start)} - ${formatter.format(end)}`;
}

function formatTimelineDayLabel(date) {
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function stageLabel(stageKey) {
  const found = projectStages.find((stage) => stage.stage_key === stageKey);
  return found ? found.stage_name : stageKey;
}

function stageColor(stageKey) {
  const index = Math.max(
    0,
    projectStages.findIndex((stage) => stage.stage_key === stageKey)
  );
  return STAGE_COLORS[index % STAGE_COLORS.length];
}

function buildTimelineDays(start, end) {
  const days = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    days.push(new Date(cursor));
    cursor = addDays(cursor, 1);
  }
  return days;
}

function getTimelineMetrics(dayCount) {
  const labelWidth = window.innerWidth <= 900 ? 200 : 260;
  const viewportWidth = Math.max(320, Math.floor(els.scroll?.getBoundingClientRect().width || window.innerWidth - 96));
  const trackWidth = Math.max(240, viewportWidth - labelWidth - 16);
  const cellWidth = clampNumber(trackWidth / Math.max(dayCount, 1), 2, 38);
  const approxLabelWidth = 56;
  const maxLabels = Math.max(4, Math.floor(trackWidth / approxLabelWidth));
  const labelStep = Math.max(1, Math.ceil(dayCount / maxLabels));
  return {
    labelWidth,
    trackWidth,
    cellWidth,
    labelStep,
  };
}

function getMonthSerial(date) {
  return date.getFullYear() * 12 + date.getMonth();
}

function formatMonthLabel(date) {
  return `${date.getMonth() + 1}월`;
}

function formatYearMonthLabel(date) {
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function getTimelineHeaderConfig(days, metrics) {
  const dayCount = days.length;
  const monthStarts = days.filter((day) => day.getDate() === 1);
  const maxLabels = Math.max(4, Math.floor(metrics.trackWidth / 72));

  if (dayCount <= 45 && metrics.cellWidth >= 14) {
    return { mode: "day", step: Math.max(1, Math.ceil(dayCount / maxLabels)) };
  }

  if (dayCount <= 120 && metrics.cellWidth >= 6) {
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

function getTimelineLabel(day, index, days, config) {
  const firstMonthSerial = getMonthSerial(days[0]);
  const monthOffset = getMonthSerial(day) - firstMonthSerial;
  const isFirst = index === 0;
  const isLast = index === days.length - 1;
  const isMonthStart = day.getDate() === 1;
  const previousDay = index > 0 ? days[index - 1] : null;
  const isYearBoundary = !previousDay || previousDay.getFullYear() !== day.getFullYear();

  if (config.mode === "day") {
    if (isFirst || isLast) return formatYearMonthLabel(day);
    const shouldLabel = isMonthStart || index % config.step === 0;
    if (!shouldLabel) return "";
    return isYearBoundary ? formatYearMonthLabel(day) : formatTimelineDayLabel(day);
  }

  if (!isMonthStart && !isFirst && !isLast) return "";

  if (config.mode === "month") {
    if (isFirst || isLast) return formatYearMonthLabel(day);
    if ((monthOffset % config.step !== 0) && !isYearBoundary) return "";
    return isYearBoundary ? formatYearMonthLabel(day) : formatMonthLabel(day);
  }

  if (isFirst || isLast) return formatYearMonthLabel(day);
  if ((monthOffset % config.step !== 0) && !isYearBoundary) return "";
  return formatYearMonthLabel(day);
}

function buildTimelineHeaderLabels(days, config) {
  if (config.mode === "day") return "";

  const lastIndex = days.length - 1;
  const startText = formatYearMonthLabel(days[0]);
  const endText = formatYearMonthLabel(days[lastIndex]);

  const rawLabels = days
    .map((day, index) => ({
      day,
      index,
      text: getTimelineLabel(day, index, days, config),
    }))
    .filter((entry) => entry.text && entry.index !== 0 && entry.index !== lastIndex);

  const minGapCells = config.mode === "month" ? 10 : 14;
  const filtered = [];

  for (const entry of rawLabels) {
    const previous = filtered[filtered.length - 1];
    const distanceFromStart = entry.index;
    const distanceFromEnd = lastIndex - entry.index;

    if (distanceFromStart < minGapCells) continue;
    if (distanceFromEnd < minGapCells) continue;

    if (previous && entry.index - previous.index < minGapCells) continue;

    filtered.push(entry);
  }

  const middleHtml = filtered
    .map((entry) => {
      return `
        <span
          class="gantt-header-label"
          style="left:calc(${entry.index} * var(--gantt-cell-width));"
          title="${toDateKey(entry.day)}"
        >
          ${escapeHtml(entry.text)}
        </span>
      `;
    })
    .join("");

  return `
    <span class="gantt-header-label is-start" title="${toDateKey(days[0])}">
      ${escapeHtml(startText)}
    </span>
    ${middleHtml}
    <span class="gantt-header-label is-end" title="${toDateKey(days[lastIndex])}">
      ${escapeHtml(endText)}
    </span>
  `;
}

function rangesIntersect(startA, endA, startB, endB) {
  return startA <= endB && endA >= startB;
}

function clampDate(date, min, max) {
  if (date < min) return min;
  if (date > max) return max;
  return date;
}

function syncTimelineRangeToUrl(range) {
  const nextParams = new URLSearchParams(window.location.search);
  if (range?.start && range?.end) {
    nextParams.set("timeline_start", toDateKey(range.start));
    nextParams.set("timeline_end", toDateKey(range.end));
  } else {
    nextParams.delete("timeline_start");
    nextParams.delete("timeline_end");
  }
  const nextQuery = nextParams.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`);
}

function syncTaskFilterToUrl() {
  const nextParams = new URLSearchParams(window.location.search);
  if (taskFilterMode === "all") {
    nextParams.delete("visible_tasks");
  } else if (taskFilterMode === "none") {
    nextParams.set("visible_tasks", "none");
  } else {
    const serialized = [...selectedTaskIds].sort((a, b) => a - b).join(",");
    nextParams.set("visible_tasks", serialized);
  }
  const nextQuery = nextParams.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`);
}

function syncSortToUrl() {
  const nextParams = new URLSearchParams(window.location.search);
  if (currentSort === "timeline") {
    nextParams.delete("sort_by");
  } else {
    nextParams.set("sort_by", currentSort);
  }
  const nextQuery = nextParams.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`);
}

function syncTaskFilterSelection(items = checklistItems) {
  const availableIds = new Set(items.map((item) => Number(item.id)));
  if (taskFilterMode === "all") {
    selectedTaskIds = new Set(availableIds);
    return;
  }
  selectedTaskIds = new Set([...selectedTaskIds].filter((id) => availableIds.has(id)));
  if (taskFilterMode === "custom") {
    if (selectedTaskIds.size === 0) {
      taskFilterMode = "none";
    } else if (selectedTaskIds.size === availableIds.size) {
      taskFilterMode = "all";
    }
  }
}

function isChecklistVisible(item) {
  const itemId = Number(item.id);
  if (taskFilterMode === "all") return true;
  if (taskFilterMode === "none") return false;
  return selectedTaskIds.has(itemId);
}

function formatTaskCount(visibleCount, totalCount) {
  if (taskFilterMode === "all") return String(totalCount);
  return `${visibleCount} / ${totalCount}`;
}

function stageOrderIndex(stageKey) {
  return Math.max(
    0,
    projectStages.findIndex((stage) => stage.stage_key === stageKey)
  );
}

function compareManualOrder(a, b, stageOrder) {
  return (
    (stageOrder.get(a.stage) ?? 999) - (stageOrder.get(b.stage) ?? 999) ||
    Number(a.position || 0) - Number(b.position || 0) ||
    Number(a.id) - Number(b.id)
  );
}

function compareChecklistItems(a, b, stageOrder) {
  const manualGap = compareManualOrder(a, b, stageOrder);
  const startA = a.ganttRange ? a.ganttRange.start.getTime() : Number.POSITIVE_INFINITY;
  const startB = b.ganttRange ? b.ganttRange.start.getTime() : Number.POSITIVE_INFINITY;
  const targetA = a.ganttRange ? a.ganttRange.end.getTime() : Number.POSITIVE_INFINITY;
  const targetB = b.ganttRange ? b.ganttRange.end.getTime() : Number.POSITIVE_INFINITY;
  const titleGap = String(a.content || "").localeCompare(String(b.content || ""), "ko", {
    sensitivity: "base",
  });

  switch (currentSort) {
    case "manual":
      return manualGap;
    case "start_date":
      return startA - startB || targetA - targetB || manualGap;
    case "target_date":
      return targetA - targetB || startA - startB || manualGap;
    case "title":
      return titleGap || targetA - targetB || manualGap;
    case "timeline":
    default:
      return targetA - targetB || startA - startB || manualGap;
  }
}

function getFilterableChecklistItems() {
  const today = parseLocalDate(toDateKey(new Date()));
  return normalizeItems(today, checklistItems);
}

function renderTaskFilterPanel() {
  if (!els.filterList || !els.filterSummary) return;

  const items = getFilterableChecklistItems();
  syncTaskFilterSelection(items);

  if (!items.length) {
    els.filterSummary.textContent = "선택할 작업이 없습니다.";
    els.filterList.innerHTML = "<div class='gantt-filter-empty'>작업이 없습니다.</div>";
    return;
  }

  const selectedCount = taskFilterMode === "all" ? items.length : selectedTaskIds.size;
  els.filterSummary.textContent =
    taskFilterMode === "all"
      ? `전체 ${items.length}개 작업 표시 중`
      : taskFilterMode === "none"
        ? `선택된 작업 없음 · 전체 ${items.length}개`
        : `${selectedCount}개 선택 / 전체 ${items.length}개`;

  els.filterList.innerHTML = items
    .map((item) => {
      const checked = taskFilterMode === "all" ? true : selectedTaskIds.has(Number(item.id));
      const stageName = stageLabel(item.stage);
      return `
        <label class="gantt-filter-item">
          <input type="checkbox" data-task-filter-id="${item.id}" ${checked ? "checked" : ""} />
          <span class="gantt-filter-item__body">
            <span class="gantt-filter-item__top">
              <span class="gantt-filter-item__stage" style="background:${stageColor(item.stage)}18; color:${stageColor(item.stage)}; border-color:${stageColor(item.stage)}33;">
                ${escapeHtml(stageName)}
              </span>
              ${item.target_date ? `<span class="gantt-filter-item__date">${escapeHtml(item.target_date)}</span>` : ""}
            </span>
            <span class="gantt-filter-item__title">${escapeHtml(item.content || "작업")}</span>
          </span>
        </label>
      `;
    })
    .join("");
}

function findChecklistItem(checklistId) {
  return checklistItems.find((item) => Number(item.id) === Number(checklistId));
}

function openChecklistDetails(checklistId) {
  const item = findChecklistItem(checklistId);
  if (!item) return;

  showTaskDescriptionModal({
    title: item.content || "작업 설명",
    description: item.description || "",
    projectName: projectTitle,
    stageName: stageLabel(item.stage),
    startDate: item.start_date || "",
    targetDate: item.target_date || "",
    workflowStatus: item.workflow_status || "upcoming",
    editable: canEditTasks,
    editLabel: "관리 페이지로 이동",
    editHref: canEditTasks ? buildTaskManagerUrl(checklistId) : "",
  });
}

function resolveItemRange(item, today) {
  const targetDate = parseLocalDate(item.target_date);
  if (!targetDate) return null;

  const configuredStart = parseLocalDate(item.start_date);
  const effectiveStart = configuredStart || today;
  if (!effectiveStart) return null;

  const start = effectiveStart <= targetDate ? effectiveStart : targetDate;
  const end = effectiveStart <= targetDate ? targetDate : effectiveStart;

  return {
    start,
    end,
    startLabel: configuredStart ? item.start_date : `${toDateKey(today)} (자동)`,
    targetLabel: item.target_date,
  };
}

function normalizeItems(today, items = checklistItems) {
  const stageOrder = new Map(projectStages.map((stage, idx) => [stage.stage_key, idx]));
  return [...items]
    .map((item) => ({ ...item, ganttRange: resolveItemRange(item, today) }))
    .sort((a, b) => compareChecklistItems(a, b, stageOrder));
}

function getAutoTimelineRange(scheduledItems, dueDate, today) {
  if (!scheduledItems.length && !dueDate) return null;

  const allDates = scheduledItems.flatMap((item) => [item.ganttRange.start, item.ganttRange.end]);
  if (dueDate) allDates.push(dueDate);
  if (today) allDates.push(today);

  const minDate = allDates.reduce((min, current) => (current < min ? current : min), allDates[0]);
  const maxDate = allDates.reduce((max, current) => (current > max ? current : max), allDates[0]);

  return {
    start: addDays(minDate, -2),
    end: addDays(maxDate, 2),
  };
}

function syncTimelineInputs(range) {
  if (!els.rangeStart || !els.rangeEnd) return;
  els.rangeStart.value = range?.start ? toDateKey(range.start) : "";
  els.rangeEnd.value = range?.end ? toDateKey(range.end) : "";
}

function applyManualTimelineRange() {
  const start = parseLocalDate(els.rangeStart?.value);
  const end = parseLocalDate(els.rangeEnd?.value);

  if (!start || !end) {
    alert("시작일과 종료일을 모두 입력해 주세요.");
    return;
  }
  if (start > end) {
    alert("시작일은 종료일보다 늦을 수 없습니다.");
    return;
  }

  manualTimelineRange = { start, end };
  syncTimelineRangeToUrl(manualTimelineRange);
  renderGanttChart();
}

function renderLegend() {
  if (!els.legend) return;

  const stageLegend = projectStages
    .map(
      (stage) => `
        <span class="gantt-legend__item">
          <span class="gantt-legend__swatch" style="background:${stageColor(stage.stage_key)}"></span>
          ${escapeHtml(stage.stage_name)}
        </span>
      `
    )
    .join("");

  const markerLegend = `
    <span class="gantt-legend__item">
      <span class="gantt-legend__swatch" style="background:#0f6d66"></span>
      오늘
    </span>
    <span class="gantt-legend__item">
      <span class="gantt-legend__swatch" style="background:#c0362c"></span>
      프로젝트 마감
    </span>
  `;

  els.legend.innerHTML = `${stageLegend}${markerLegend}`;
}

function renderUnscheduledItems(items) {
  if (!els.unscheduledList) return;

  if (!items.length) {
    els.unscheduledList.innerHTML = "<div class='item'>범위가 없는 작업이 없습니다.</div>";
    return;
  }

  els.unscheduledList.innerHTML = items
    .map(
      (item) => `
        <article class="item">
          <div class="item__head">
            <button type="button" class="task-detail-trigger" data-open-gantt-description="${item.id}">
              ${escapeHtml(item.content)}
            </button>
            <span class="badge" style="background:${stageColor(item.stage)}22; color:${stageColor(item.stage)}">
              ${escapeHtml(stageLabel(item.stage))}
            </span>
          </div>
          <div class="item__meta">시작일: ${escapeHtml(item.start_date || "-")} | 목표일: 없음</div>
          <div class="item__meta">${escapeHtml(item.description || "설명 없음")}</div>
        </article>
      `
    )
    .join("");
}

function buildMarkerHtml(todayIndex, dueIndex) {
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

function renderScheduledRows({ scheduledItems, dayIndexMap, todayIndex, dueIndex, styleVars, labelWidth, headerMode, trackBandsHtml }) {
  if (!scheduledItems.length) {
    return `
      <div class="gantt-row gantt-row--empty" style="grid-template-columns:${labelWidth}px auto;">
        <div class="gantt-label gantt-label--card gantt-label--empty">
          <strong>선택한 범위에 표시할 작업이 없습니다.</strong>
          <div class="item__meta">범위를 조정하면 차트가 해당 기간에 맞게 다시 배치됩니다.</div>
        </div>
        <div class="gantt-track-shell">
          <div class="gantt-track ${headerMode !== "day" ? "gantt-track--overview" : ""}" style="${styleVars}">
            ${headerMode !== "day" ? trackBandsHtml : ""}
            ${buildMarkerHtml(todayIndex, dueIndex)}
            <span class="gantt-cursor-line hidden" aria-hidden="true"></span>
          </div>
        </div>
      </div>
    `;
  }

  return scheduledItems
    .map((item) => {
      const range = item.ganttRange;
      const visibleStart = item.visibleRange?.start || range.start;
      const visibleEnd = item.visibleRange?.end || range.end;
      const startIndex = dayIndexMap.get(toDateKey(visibleStart));
      const endIndex = dayIndexMap.get(toDateKey(visibleEnd));
      const stageName = stageLabel(item.stage);
      const color = stageColor(item.stage);
      const span = Math.max(1, endIndex - startIndex + 1);
      const durationLabel = `${getInclusiveDaySpan(range.start, range.end)}d`;
      return `
        <div class="gantt-row gantt-row--task" style="grid-template-columns:${labelWidth}px auto;">
          <div class="gantt-label gantt-label--card">
            <div class="gantt-label__top">
              <span class="gantt-stage-pill" style="background:${color}18; color:${color}; border-color:${color}33;">
                ${escapeHtml(stageName)}
              </span>
              <span class="gantt-duration-pill">${durationLabel}</span>
            </div>
            <strong class="gantt-task-title">${escapeHtml(item.content)}</strong>
            <div class="gantt-date-pills">
              <span class="gantt-date-pill">시작 ${escapeHtml(range.startLabel)}</span>
              <span class="gantt-date-pill">목표 ${escapeHtml(range.targetLabel)}</span>
            </div>
          </div>
          <div class="gantt-track-shell">
            <div class="gantt-track ${headerMode !== "day" ? "gantt-track--overview" : ""}" style="${styleVars}">
              ${headerMode !== "day" ? trackBandsHtml : ""}
              ${buildMarkerHtml(todayIndex, dueIndex)}
              <button
                type="button"
                class="gantt-bar"
                data-open-gantt-description="${item.id}"
                style="left:calc(${startIndex} * var(--gantt-cell-width)); width:calc(${span} * var(--gantt-cell-width) - 8px); background:${color};"
                title="${escapeHtml(item.content)}"
                aria-label="${escapeHtml(item.content)} 설명 보기"
              >
                <span class="gantt-bar__title">${escapeHtml(item.content)}</span>
                ${span >= 4 ? `<span class="gantt-bar__duration">${durationLabel}</span>` : ""}
              </button>
              <span class="gantt-cursor-line hidden" aria-hidden="true"></span>
            </div>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderGanttChart() {
  hideGanttCursorDate();
  currentGanttRenderState = null;
  const today = parseLocalDate(toDateKey(new Date()));
  const allSortedItems = normalizeItems(today, checklistItems);
  const filteredSourceItems = checklistItems.filter((item) => isChecklistVisible(item));
  const sortedItems = normalizeItems(today, filteredSourceItems);
  const allScheduledCount = allSortedItems.filter((item) => item.ganttRange).length;
  const allUnscheduledCount = allSortedItems.filter((item) => !item.ganttRange).length;
  const scheduledItems = sortedItems.filter((item) => item.ganttRange);
  const unscheduledItems = sortedItems.filter((item) => !item.ganttRange);
  const dueDate = parseLocalDate(currentProject?.due_date);
  const autoRange = filteredSourceItems.length ? getAutoTimelineRange(scheduledItems, dueDate, today) : null;

  if (els.projectDue) els.projectDue.textContent = currentProject?.due_date || "-";
  if (els.scheduledCount) els.scheduledCount.textContent = formatTaskCount(scheduledItems.length, allScheduledCount);
  if (els.unscheduledCount) els.unscheduledCount.textContent = formatTaskCount(unscheduledItems.length, allUnscheduledCount);

  renderLegend();
  renderUnscheduledItems(unscheduledItems);

  if (!autoRange) {
    syncTimelineInputs(manualTimelineRange);
    els.rangeLabel.textContent = manualTimelineRange ? formatRange(manualTimelineRange.start, manualTimelineRange.end) : "-";
    if (els.empty) {
      els.empty.textContent = filteredSourceItems.length ? "표시할 일정이 없습니다." : "체크박스로 표시할 작업을 선택해 주세요.";
    }
    els.empty.classList.remove("hidden");
    els.scroll.classList.add("hidden");
    els.scroll.innerHTML = "";
    return;
  }

  const appliedRange = manualTimelineRange || autoRange;
  syncTimelineInputs(appliedRange);

  const visibleScheduledItems = scheduledItems
    .filter((item) => rangesIntersect(item.ganttRange.start, item.ganttRange.end, appliedRange.start, appliedRange.end))
    .map((item) => ({
      ...item,
      visibleRange: {
        start: clampDate(item.ganttRange.start, appliedRange.start, appliedRange.end),
        end: clampDate(item.ganttRange.end, appliedRange.start, appliedRange.end),
      },
    }));

  els.empty.classList.add("hidden");
  els.scroll.classList.remove("hidden");

  const days = buildTimelineDays(appliedRange.start, appliedRange.end);
  const dayIndexMap = new Map(days.map((day, idx) => [toDateKey(day), idx]));
  const todayIndex = today ? dayIndexMap.get(toDateKey(today)) : null;
  const dueIndex = dueDate ? dayIndexMap.get(toDateKey(dueDate)) : null;
  const metrics = getTimelineMetrics(days.length);
  const styleVars = `--gantt-days:${days.length}; --gantt-cell-width:${metrics.cellWidth}px;`;
  const headerConfig = getTimelineHeaderConfig(days, metrics);
  const headerLabelsHtml = buildTimelineHeaderLabels(days, headerConfig, metrics.cellWidth);
  const monthBandsHtml = buildTimelineMonthBands(days);
  const trackBandsHtml = buildTimelineTrackBands(days);
  currentGanttRenderState = {
    rangeStart: new Date(appliedRange.start),
    totalDays: days.length,
  };

  els.rangeLabel.textContent = formatRange(appliedRange.start, appliedRange.end);
  els.empty.classList.add("hidden");
  els.scroll.classList.remove("hidden");

  const headerHtml = `
    <div class="gantt-row gantt-row--header" style="grid-template-columns:${metrics.labelWidth}px auto;">
      <div class="gantt-label gantt-label--header-card">
        <span class="gantt-label__eyebrow">Task Lane</span>
        <strong>작업</strong>
      </div>
      <div class="gantt-track-shell gantt-track-shell--header">
        <div class="gantt-days ${headerConfig.mode !== "day" ? "gantt-days--condensed gantt-days--overview" : ""}" style="${styleVars}">
          ${monthBandsHtml}
          ${days
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
                headerConfig.mode === "day" ? renderTimelineDayCell(day, index, days, headerConfig) : ""
              }</div>`;
            })
            .join("")}
          ${headerLabelsHtml ? `<div class="gantt-header-labels">${headerLabelsHtml}</div>` : ""}
          <span class="gantt-cursor-line hidden" aria-hidden="true"></span>
        </div>
      </div>
    </div>
  `;

  const rowsHtml = renderScheduledRows({
    scheduledItems: visibleScheduledItems,
    dayIndexMap,
    todayIndex,
    dueIndex,
    styleVars,
    labelWidth: metrics.labelWidth,
    headerMode: headerConfig.mode,
    trackBandsHtml,
  });

  els.scroll.innerHTML = `<div class="gantt-board">${headerHtml}${rowsHtml}</div>`;
}

function getTimelineMetrics(dayCount) {
  const labelWidth = window.innerWidth <= 900 ? 220 : 320;
  const surface = els.scroll?.closest(".gantt-surface") || els.scroll?.parentElement || els.scroll;
  const surfaceWidth = Math.max(360, Math.floor(surface?.getBoundingClientRect().width || window.innerWidth - 96));
  const surfacePadding = 32;
  const rowGap = 14;
  const trackWidth = Math.max(220, surfaceWidth - surfacePadding - labelWidth - rowGap);
  const minCellWidth = dayCount > 365 ? 0.55 : dayCount > 180 ? 0.8 : 1.2;
  const cellWidth = Math.max(trackWidth / Math.max(dayCount, 1), minCellWidth);
  const approxLabelWidth = 72;
  const maxLabels = Math.max(4, Math.floor(trackWidth / approxLabelWidth));
  const labelStep = Math.max(1, Math.ceil(dayCount / maxLabels));
  return {
    labelWidth,
    trackWidth,
    cellWidth,
    labelStep,
  };
}

function renderLegend() {
  if (!els.legend) return;

  const stageLegend = projectStages
    .map(
      (stage) => `
        <span class="gantt-legend__item">
          <span class="gantt-legend__swatch" style="background:${stageColor(stage.stage_key)}"></span>
          ${escapeHtml(stage.stage_name)}
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

  els.legend.innerHTML = `${stageLegend}${markerLegend}`;
}

function renderUnscheduledItems(items) {
  if (!els.unscheduledList) return;

  if (!items.length) {
    els.unscheduledList.innerHTML = "<div class='item gantt-unscheduled-card'>범위 미표시 작업이 없습니다.</div>";
    return;
  }

  els.unscheduledList.innerHTML = items
    .map(
      (item) => `
        <article class="item gantt-unscheduled-card">
          <div class="gantt-unscheduled-card__top">
            <div class="gantt-unscheduled-card__copy">
              <button
                type="button"
                class="task-detail-trigger gantt-unscheduled-card__title"
                data-open-gantt-description="${item.id}"
              >
                ${escapeHtml(item.content)}
              </button>
              <div class="gantt-date-pills gantt-date-pills--compact">
                <span class="gantt-date-pill">시작 ${escapeHtml(item.start_date || "-")}</span>
                <span class="gantt-date-pill gantt-date-pill--muted">목표일 없음</span>
              </div>
            </div>
            <span
              class="gantt-stage-pill"
              style="background:${stageColor(item.stage)}18; color:${stageColor(item.stage)}; border-color:${stageColor(item.stage)}33;"
            >
              ${escapeHtml(stageLabel(item.stage))}
            </span>
          </div>
          <div class="gantt-unscheduled-card__body">${escapeHtml(item.description || "설명 없음")}</div>
        </article>
      `
    )
    .join("");
}

function getInclusiveDaySpan(start, end) {
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
}

function formatTimelineWeekdayLabel(date) {
  return ganttCursorWeekdayFormatter.format(date);
}

function formatGanttCursorDate(date) {
  return `${toDateKey(date)} (${formatTimelineWeekdayLabel(date)})`;
}

function hideGanttCursorDate() {
  if (currentGanttHoveredTrack) {
    currentGanttHoveredTrack.querySelector(".gantt-cursor-line")?.classList.add("hidden");
    currentGanttHoveredTrack = null;
  }

  if (els.cursorDate) {
    els.cursorDate.classList.add("hidden");
  }
}

function showGanttCursorDate(track, clientX, clientY) {
  if (!currentGanttRenderState || !els.cursorDate) return;

  const rect = track.getBoundingClientRect();
  if (!rect.width || currentGanttRenderState.totalDays <= 0) return;

  const cellWidth = rect.width / currentGanttRenderState.totalDays;
  const offsetX = Math.min(Math.max(0, clientX - rect.left), Math.max(rect.width - 1, 0));
  const dayIndex = Math.min(
    currentGanttRenderState.totalDays - 1,
    Math.max(0, Math.floor(offsetX / Math.max(cellWidth, 1)))
  );
  const lineLeft = Math.min(rect.width - 1, Math.max(0, dayIndex * cellWidth + cellWidth / 2));
  const line = track.querySelector(".gantt-cursor-line");

  if (currentGanttHoveredTrack && currentGanttHoveredTrack !== track) {
    currentGanttHoveredTrack.querySelector(".gantt-cursor-line")?.classList.add("hidden");
  }

  currentGanttHoveredTrack = track;
  if (line) {
    line.style.left = `${lineLeft}px`;
    line.classList.remove("hidden");
  }

  const hoveredDate = addDays(currentGanttRenderState.rangeStart, dayIndex);
  const tooltip = els.cursorDate;
  tooltip.textContent = formatGanttCursorDate(hoveredDate);
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

function formatTimelineMonthBandLabel(date, forceYear = false) {
  if (forceYear) return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}`;
  return `${date.getMonth() + 1}월`;
}

function buildTimelineMonthBands(days) {
  if (!days.length) return "";

  const bands = [];
  let startIndex = 0;

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
      startIndex,
      span: index - startIndex,
      yearStart: startDay.getMonth() === 0,
    });
    startIndex = index;
  }

  return `
    <div class="gantt-month-bands">
      ${bands
        .map(
          (band) => `
            <span
              class="gantt-month-band ${band.yearStart ? "is-year-start" : ""}"
              style="left:calc(${band.startIndex} * var(--gantt-cell-width)); width:calc(${band.span} * var(--gantt-cell-width));"
            ></span>
          `
        )
        .join("")}
    </div>
  `;
}

function buildTimelineHeaderLabels(days, config, cellWidth = 12) {
  if (config.mode === "day") return "";

  const lastIndex = days.length - 1;
  const startText = formatYearMonthLabel(days[0]);
  const endText = formatYearMonthLabel(days[lastIndex]);
  const minGapPx = config.mode === "year-month" ? 150 : 110;
  const edgeGapPx = 84;

  const rawLabels = days
    .map((day, index) => ({
      day,
      index,
      text: getTimelineLabel(day, index, days, config),
      isYearBoundary: index === 0 || index === lastIndex || day.getMonth() === 0,
    }))
    .filter((entry) => entry.text && entry.index !== 0 && entry.index !== lastIndex);

  const filtered = [];

  for (const entry of rawLabels) {
    const distanceFromStart = entry.index * cellWidth;
    const distanceFromEnd = (lastIndex - entry.index) * cellWidth;
    const previous = filtered[filtered.length - 1];
    const gapFromPrevious = previous ? (entry.index - previous.index) * cellWidth : Number.POSITIVE_INFINITY;

    if (distanceFromStart < edgeGapPx || distanceFromEnd < edgeGapPx) continue;
    if (gapFromPrevious < minGapPx && !entry.isYearBoundary) continue;
    if (previous?.isYearBoundary && gapFromPrevious < minGapPx * 0.8) continue;

    filtered.push(entry);
  }

  const middleHtml = filtered
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
    ${middleHtml}
    <span class="gantt-header-label is-end" title="${toDateKey(days[lastIndex])}">
      ${escapeHtml(endText)}
    </span>
  `;
}

function buildTimelineTrackBands(days) {
  if (!days.length) return "";

  const bands = [];
  let startIndex = 0;

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
      startIndex,
      span: index - startIndex,
      yearStart: startDay.getMonth() === 0,
    });
    startIndex = index;
  }

  return `
    <div class="gantt-track-bands">
      ${bands
        .map(
          (band, bandIndex) => `
            <span
              class="gantt-track-band ${band.yearStart ? "is-year-start" : ""} ${bandIndex % 2 === 0 ? "is-even" : "is-odd"}"
              style="left:calc(${band.startIndex} * var(--gantt-cell-width)); width:calc(${band.span} * var(--gantt-cell-width));"
            ></span>
          `
        )
        .join("")}
    </div>
  `;
}

function renderTimelineDayCell(day, index, days, config) {
  const label = getTimelineLabel(day, index, days, config);
  if (!label) return "";

  const isBoundary = index === 0 || index === days.length - 1 || day.getDate() === 1;
  const weekday = formatTimelineWeekdayLabel(day);

  return `
    <span class="gantt-day__date">${escapeHtml(label)}</span>
    <span class="gantt-day__weekday${isBoundary ? " is-strong" : ""}">${escapeHtml(weekday)}</span>
  `;
}

function buildScheduledItemLanes(items) {
  const lanes = [];

  items.forEach((item) => {
    const visibleStart = item.visibleRange?.start || item.ganttRange.start;
    const visibleEnd = item.visibleRange?.end || item.ganttRange.end;
    const startTime = visibleStart.getTime();
    const endTime = visibleEnd.getTime();
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

    targetLane.items.push(item);
    targetLane.lastEndTime = endTime;
  });

  return lanes;
}

function renderScheduledRows({ scheduledItems, dayIndexMap, todayIndex, dueIndex, styleVars, labelWidth, headerMode, trackBandsHtml }) {
  if (!scheduledItems.length) {
    return `
      <div class="gantt-row gantt-row--empty" style="grid-template-columns:${labelWidth}px auto;">
        <div class="gantt-label gantt-label--card gantt-label--empty">
          <strong>선택한 범위에 표시할 작업이 없습니다.</strong>
          <div class="item__meta">범위를 조정하면 차트가 해당 기간에 맞게 다시 배치됩니다.</div>
        </div>
        <div class="gantt-track-shell">
          <div class="gantt-track ${headerMode !== "day" ? "gantt-track--overview" : ""}" style="${styleVars}">
            ${headerMode !== "day" ? trackBandsHtml : ""}
            ${buildMarkerHtml(todayIndex, dueIndex)}
            <span class="gantt-cursor-line hidden" aria-hidden="true"></span>
          </div>
        </div>
      </div>
    `;
  }

  const packedItems = [...scheduledItems].sort((a, b) => {
    const startA = a.visibleRange?.start || a.ganttRange.start;
    const startB = b.visibleRange?.start || b.ganttRange.start;
    const endA = a.visibleRange?.end || a.ganttRange.end;
    const endB = b.visibleRange?.end || b.ganttRange.end;
    return (
      startA - startB ||
      endA - endB ||
      a.ganttRange.start - b.ganttRange.start ||
      String(a.content || "").localeCompare(String(b.content || ""), "ko", { sensitivity: "base" })
    );
  });
  const lanes = buildScheduledItemLanes(packedItems);

  return lanes
    .map((lane, laneIndex) => {
      if (lane.items.length === 1) {
        const item = lane.items[0];
        const range = item.ganttRange;
        const visibleStart = item.visibleRange?.start || range.start;
        const visibleEnd = item.visibleRange?.end || range.end;
        const startIndex = dayIndexMap.get(toDateKey(visibleStart));
        const endIndex = dayIndexMap.get(toDateKey(visibleEnd));
        const stageName = stageLabel(item.stage);
        const color = stageColor(item.stage);
        const span = Math.max(1, endIndex - startIndex + 1);
        const durationLabel = `${getInclusiveDaySpan(range.start, range.end)}d`;
        return `
          <div class="gantt-row gantt-row--task" style="grid-template-columns:${labelWidth}px auto;">
            <div class="gantt-label gantt-label--card">
              <div class="gantt-label__top">
                <span class="gantt-stage-pill" style="background:${color}18; color:${color}; border-color:${color}33;">
                  ${escapeHtml(stageName)}
                </span>
                <span class="gantt-duration-pill">${durationLabel}</span>
              </div>
              <strong class="gantt-task-title">${escapeHtml(item.content)}</strong>
              <div class="gantt-date-pills">
                <span class="gantt-date-pill">시작 ${escapeHtml(range.startLabel)}</span>
                <span class="gantt-date-pill">목표 ${escapeHtml(range.targetLabel)}</span>
              </div>
            </div>
            <div class="gantt-track-shell">
              <div class="gantt-track ${headerMode !== "day" ? "gantt-track--overview" : ""}" style="${styleVars}">
                ${headerMode !== "day" ? trackBandsHtml : ""}
                ${buildMarkerHtml(todayIndex, dueIndex)}
                <button
                  type="button"
                  class="gantt-bar"
                  data-open-gantt-description="${item.id}"
                  style="left:calc(${startIndex} * var(--gantt-cell-width)); width:calc(${span} * var(--gantt-cell-width) - 8px); background:${color};"
                  title="${escapeHtml(item.content)}"
                  aria-label="${escapeHtml(item.content)} 설명 보기"
                >
                  <span class="gantt-bar__title">${escapeHtml(item.content)}</span>
                  ${span >= 4 ? `<span class="gantt-bar__duration">${durationLabel}</span>` : ""}
                </button>
                <span class="gantt-cursor-line hidden" aria-hidden="true"></span>
              </div>
            </div>
          </div>
        `;
      }

      const laneBarsHtml = lane.items
        .map((item) => {
          const range = item.ganttRange;
          const visibleStart = item.visibleRange?.start || range.start;
          const visibleEnd = item.visibleRange?.end || range.end;
          const startIndex = dayIndexMap.get(toDateKey(visibleStart));
          const endIndex = dayIndexMap.get(toDateKey(visibleEnd));
          const color = stageColor(item.stage);
          const span = Math.max(1, endIndex - startIndex + 1);
          const durationLabel = `${getInclusiveDaySpan(range.start, range.end)}d`;

          return `
            <button
              type="button"
              class="gantt-bar"
              data-open-gantt-description="${item.id}"
              style="left:calc(${startIndex} * var(--gantt-cell-width)); width:calc(${span} * var(--gantt-cell-width) - 8px); background:${color};"
              title="${escapeHtml(item.content)}"
              aria-label="${escapeHtml(item.content)} 설명 보기"
            >
              <span class="gantt-bar__title">${escapeHtml(item.content)}</span>
              ${span >= 4 ? `<span class="gantt-bar__duration">${durationLabel}</span>` : ""}
            </button>
          `;
        })
        .join("");

      const laneItemsHtml = lane.items
        .map((item) => {
          const color = stageColor(item.stage);
          const range = item.ganttRange;
          return `
            <button
              type="button"
              class="gantt-lane-chip"
              data-open-gantt-description="${item.id}"
              style="--lane-chip-bg:${color}18; --lane-chip-border:${color}33; --lane-chip-fg:${color};"
              title="${escapeHtml(item.content)} | ${escapeHtml(range.startLabel)} ~ ${escapeHtml(range.targetLabel)}"
              aria-label="${escapeHtml(item.content)} 설명 보기"
            >
              ${escapeHtml(item.content)}
            </button>
          `;
        })
        .join("");

      return `
        <div class="gantt-row gantt-row--task" style="grid-template-columns:${labelWidth}px auto;">
          <div class="gantt-label gantt-label--card gantt-lane-card">
            <div class="gantt-label__top">
              <span class="gantt-duration-pill">겹침 레인 ${laneIndex + 1}</span>
              <span class="gantt-duration-pill">${lane.items.length}개 작업</span>
            </div>
            <div class="gantt-lane-chip-list">
              ${laneItemsHtml}
            </div>
          </div>
          <div class="gantt-track-shell">
            <div class="gantt-track ${headerMode !== "day" ? "gantt-track--overview" : ""}" style="${styleVars}">
              ${headerMode !== "day" ? trackBandsHtml : ""}
              ${buildMarkerHtml(todayIndex, dueIndex)}
              ${laneBarsHtml}
              <span class="gantt-cursor-line hidden" aria-hidden="true"></span>
            </div>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderGanttChart() {
  hideGanttCursorDate();
  currentGanttRenderState = null;
  const today = parseLocalDate(toDateKey(new Date()));
  const allSortedItems = normalizeItems(today, checklistItems);
  const filteredSourceItems = checklistItems.filter((item) => isChecklistVisible(item));
  const sortedItems = normalizeItems(today, filteredSourceItems);
  const allScheduledCount = allSortedItems.filter((item) => item.ganttRange).length;
  const allUnscheduledCount = allSortedItems.filter((item) => !item.ganttRange).length;
  const scheduledItems = sortedItems.filter((item) => item.ganttRange);
  const unscheduledItems = sortedItems.filter((item) => !item.ganttRange);
  const dueDate = parseLocalDate(currentProject?.due_date);
  const autoRange = filteredSourceItems.length ? getAutoTimelineRange(scheduledItems, dueDate, today) : null;

  if (els.projectDue) els.projectDue.textContent = currentProject?.due_date || "-";
  if (els.scheduledCount) els.scheduledCount.textContent = formatTaskCount(scheduledItems.length, allScheduledCount);
  if (els.unscheduledCount) els.unscheduledCount.textContent = formatTaskCount(unscheduledItems.length, allUnscheduledCount);

  renderLegend();
  renderUnscheduledItems(unscheduledItems);

  if (!autoRange) {
    syncTimelineInputs(manualTimelineRange);
    els.rangeLabel.textContent = manualTimelineRange ? formatRange(manualTimelineRange.start, manualTimelineRange.end) : "-";
    if (els.empty) {
      els.empty.textContent = filteredSourceItems.length ? "표시할 일정이 없습니다." : "체크박스로 표시할 작업을 선택해 주세요.";
    }
    els.empty.classList.remove("hidden");
    els.scroll.classList.add("hidden");
    els.scroll.innerHTML = "";
    return;
  }

  const appliedRange = manualTimelineRange || autoRange;
  syncTimelineInputs(appliedRange);

  const visibleScheduledItems = scheduledItems
    .filter((item) => rangesIntersect(item.ganttRange.start, item.ganttRange.end, appliedRange.start, appliedRange.end))
    .map((item) => ({
      ...item,
      visibleRange: {
        start: clampDate(item.ganttRange.start, appliedRange.start, appliedRange.end),
        end: clampDate(item.ganttRange.end, appliedRange.start, appliedRange.end),
      },
    }));

  els.empty.classList.add("hidden");
  els.scroll.classList.remove("hidden");

  const days = buildTimelineDays(appliedRange.start, appliedRange.end);
  const dayIndexMap = new Map(days.map((day, idx) => [toDateKey(day), idx]));
  const todayIndex = today ? dayIndexMap.get(toDateKey(today)) : null;
  const dueIndex = dueDate ? dayIndexMap.get(toDateKey(dueDate)) : null;
  const metrics = getTimelineMetrics(days.length);
  const styleVars = `--gantt-days:${days.length}; --gantt-cell-width:${metrics.cellWidth}px;`;
  const headerConfig = getTimelineHeaderConfig(days, metrics);
  const headerLabelsHtml = buildTimelineHeaderLabels(days, headerConfig, metrics.cellWidth);
  const monthBandsHtml = buildTimelineMonthBands(days);
  const trackBandsHtml = buildTimelineTrackBands(days);
  currentGanttRenderState = {
    rangeStart: new Date(appliedRange.start),
    totalDays: days.length,
  };

  els.rangeLabel.textContent = formatRange(appliedRange.start, appliedRange.end);

  const headerHtml = `
    <div class="gantt-row gantt-row--header" style="grid-template-columns:${metrics.labelWidth}px auto;">
      <div class="gantt-label gantt-label--header-card">
        <span class="gantt-label__eyebrow">Task Lane</span>
        <strong>작업</strong>
      </div>
      <div class="gantt-track-shell gantt-track-shell--header">
        <div class="gantt-days ${headerConfig.mode !== "day" ? "gantt-days--condensed gantt-days--overview" : ""}" style="${styleVars}">
          ${monthBandsHtml}
          ${days
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
                headerConfig.mode === "day" ? renderTimelineDayCell(day, index, days, headerConfig) : ""
              }</div>`;
            })
            .join("")}
          ${headerLabelsHtml ? `<div class="gantt-header-labels">${headerLabelsHtml}</div>` : ""}
          <span class="gantt-cursor-line hidden" aria-hidden="true"></span>
        </div>
      </div>
    </div>
  `;

  const rowsHtml = renderScheduledRows({
    scheduledItems: visibleScheduledItems,
    dayIndexMap,
    todayIndex,
    dueIndex,
    styleVars,
    labelWidth: metrics.labelWidth,
    headerMode: headerConfig.mode,
    trackBandsHtml,
  });

  els.scroll.innerHTML = `<div class="gantt-board">${headerHtml}${rowsHtml}</div>`;
}

async function loadSession() {
  const me = await api.get("/api/auth/me");
  currentUser = me;
  applyUserTheme(me);
  if (me.is_admin) els.adminLink.classList.remove("hidden");
}

async function loadProjectData() {
  const [project, stages, checklists] = await Promise.all([
    api.get(`/api/projects/${projectId}`),
    api.get(`/api/projects/${projectId}/stages`),
    api.get(`/api/projects/${projectId}/checklists`),
  ]);

  currentProject = project;
  projectStages = Array.isArray(stages) ? stages : [];
  checklistItems = Array.isArray(checklists) ? checklists : [];
  canEditTasks = Boolean(project.can_edit_tasks ?? (currentUser?.is_admin || project.owner === currentUser?.username));
  projectTitle = project.name || "프로젝트";
  syncTaskFilterSelection(checklistItems);
  if (els.sortSelect) els.sortSelect.value = currentSort;
  renderTaskFilterPanel();

  els.title.textContent = `${projectTitle} - 간트 차트`;
  els.subtitle.textContent = `${projectTitle}의 시작일과 목표일 기준 일정을 확인합니다.`;
  els.projectBoardLink.href = `/static/project.html?project_id=${projectId}`;
  if (els.projectCalendarLink) {
    els.projectCalendarLink.href = `/static/project_calendar.html?project_id=${projectId}`;
  }
  els.projectSettingsLink.href = buildTaskManagerUrl();
  els.projectSettingsLink.textContent = "작업 추가/관리";
}

els.scroll?.addEventListener("click", (e) => {
  const detailBtn = e.target.closest("[data-open-gantt-description]");
  if (!detailBtn) return;
  openChecklistDetails(detailBtn.getAttribute("data-open-gantt-description"));
});

els.scroll?.addEventListener("mousemove", (e) => {
  const track = e.target.closest(".gantt-track, .gantt-days");
  if (!track || !els.scroll.contains(track)) {
    hideGanttCursorDate();
    return;
  }
  showGanttCursorDate(track, e.clientX, e.clientY);
});

els.scroll?.addEventListener("mouseleave", () => {
  hideGanttCursorDate();
});

els.unscheduledList?.addEventListener("click", (e) => {
  const detailBtn = e.target.closest("[data-open-gantt-description]");
  if (!detailBtn) return;
  openChecklistDetails(detailBtn.getAttribute("data-open-gantt-description"));
});

els.filterList?.addEventListener("change", (e) => {
  const checkbox = e.target.closest("[data-task-filter-id]");
  if (!checkbox) return;
  const itemId = Number(checkbox.getAttribute("data-task-filter-id"));
  if (!Number.isFinite(itemId)) return;

  if (checkbox.checked) {
    selectedTaskIds.add(itemId);
  } else {
    selectedTaskIds.delete(itemId);
  }

  if (selectedTaskIds.size === 0) {
    taskFilterMode = "none";
  } else if (selectedTaskIds.size === checklistItems.length) {
    taskFilterMode = "all";
  } else {
    taskFilterMode = "custom";
  }

  syncTaskFilterToUrl();
  renderTaskFilterPanel();
  renderGanttChart();
});

els.filterSelectAll?.addEventListener("click", () => {
  taskFilterMode = "all";
  syncTaskFilterSelection(checklistItems);
  syncTaskFilterToUrl();
  renderTaskFilterPanel();
  renderGanttChart();
});

els.filterClearAll?.addEventListener("click", () => {
  taskFilterMode = "none";
  selectedTaskIds = new Set();
  syncTaskFilterToUrl();
  renderTaskFilterPanel();
  renderGanttChart();
});

els.sortSelect?.addEventListener("change", (e) => {
  currentSort = normalizeSortKey(e.target.value);
  syncSortToUrl();
  renderTaskFilterPanel();
  renderGanttChart();
});

window.addEventListener("resize", () => {
  renderGanttChart();
});

els.logoutBtn.addEventListener("click", async () => {
  await api.post("/api/auth/logout", {});
  window.location.href = "/static/login.html";
});

Promise.resolve()
  .then(async () => {
    const initialStart = parseLocalDate(params.get("timeline_start"));
    const initialEnd = parseLocalDate(params.get("timeline_end"));
    if (initialStart && initialEnd && initialStart <= initialEnd) {
      manualTimelineRange = { start: initialStart, end: initialEnd };
    }
    await loadSession();
    await loadProjectData();
    renderGanttChart();
    if (returnChecklistId && !hasAppliedReturnFocus) {
      hasAppliedReturnFocus = true;
      openChecklistDetails(returnChecklistId);
    }
  })
  .catch((error) => {
    console.error(error);
    if (!String(error.message || "").includes("Unauthorized")) {
      alert(parseApiError(error));
    }
  });
