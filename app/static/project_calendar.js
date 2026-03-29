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
  projectGanttLink: document.getElementById("project-gantt-link"),
  projectSettingsLink: document.getElementById("project-settings-link"),
  adminLink: document.getElementById("admin-link"),
  logoutBtn: document.getElementById("logout-btn"),
  projectDue: document.getElementById("calendar-project-due"),
  currentMonth: document.getElementById("calendar-current-month"),
  visibleCount: document.getElementById("calendar-visible-count"),
  unscheduledCount: document.getElementById("calendar-unscheduled-count"),
  legend: document.getElementById("calendar-legend"),
  empty: document.getElementById("calendar-empty"),
  scroll: document.getElementById("calendar-scroll"),
  board: document.getElementById("calendar-board"),
  weekdays: document.getElementById("calendar-weekdays"),
  grid: document.getElementById("calendar-grid"),
  unscheduledList: document.getElementById("calendar-unscheduled-list"),
  filterList: document.getElementById("calendar-filter-list"),
  filterSummary: document.getElementById("calendar-filter-summary"),
  filterSelectAll: document.getElementById("calendar-filter-select-all"),
  filterClearAll: document.getElementById("calendar-filter-clear-all"),
  sortSelect: document.getElementById("calendar-sort-select"),
  prevMonthBtn: document.getElementById("calendar-prev-month"),
  nextMonthBtn: document.getElementById("calendar-next-month"),
  todayBtn: document.getElementById("calendar-today-btn"),
  monthInput: document.getElementById("calendar-month-input"),
};

const STAGE_COLORS = ["#0f6d66", "#2a6f97", "#c06c2c", "#7a4fb0", "#3b7a57", "#9b2226"];
const WEEKDAY_LABELS = ["\uC77C", "\uC6D4", "\uD654", "\uC218", "\uBAA9", "\uAE08", "\uD1A0"];
const CALENDAR_LABEL = "캘린더";
const CALENDAR_SUBTITLE = "작업 일정을 월간 캘린더 형태로 확인합니다.";
const monthLabelFormatter = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long" });

let currentProject = null;
let projectStages = [];
let checklistItems = [];
let projectTitle = "프로젝트";
let currentUser = null;
let canEditTasks = false;
let taskFilterMode = "all";
let selectedTaskIds = new Set();
let currentSort = normalizeSortKey(params.get("sort_by"));
let currentMonth = parseMonthParam(params.get("month")) || startOfMonth(new Date());
let hasAppliedReturnFocus = false;

const initialTaskFilter = parseTaskFilterSelection(params.get("visible_tasks"));
taskFilterMode = initialTaskFilter.mode;
selectedTaskIds = initialTaskFilter.ids;

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

function normalizeSortKey(raw) {
  const key = String(raw || "timeline").trim();
  return ["timeline", "manual", "start_date", "target_date", "title"].includes(key) ? key : "timeline";
}

function parseLocalDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
  return new Date(`${value}T00:00:00`);
}

function parseMonthParam(value) {
  if (!value || !/^\d{4}-\d{2}$/.test(String(value))) return null;
  return new Date(`${String(value)}-01T00:00:00`);
}

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function addDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function addMonths(date, amount) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function startOfWeek(date) {
  return addDays(date, -date.getDay());
}

function endOfWeek(date) {
  return addDays(date, 6 - date.getDay());
}

function isSameDay(a, b) {
  return Boolean(a && b && toDateKey(a) === toDateKey(b));
}

function rangesIntersect(startA, endA, startB, endB) {
  return startA <= endB && endA >= startB;
}

function isDateWithin(range, date) {
  return Boolean(range && range.start <= date && range.end >= date);
}

function formatMonthHeading(date) {
  return monthLabelFormatter.format(date);
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

function syncUrlState() {
  const nextParams = new URLSearchParams();
  nextParams.set("project_id", String(projectId));
  const thisMonthKey = toMonthKey(startOfMonth(new Date()));
  const selectedMonthKey = toMonthKey(currentMonth);
  if (selectedMonthKey !== thisMonthKey) {
    nextParams.set("month", selectedMonthKey);
  }

  if (taskFilterMode === "none") {
    nextParams.set("visible_tasks", "none");
  } else if (taskFilterMode === "custom") {
    nextParams.set("visible_tasks", [...selectedTaskIds].sort((a, b) => a - b).join(","));
  }

  if (currentSort !== "timeline") {
    nextParams.set("sort_by", currentSort);
  }

  const nextQuery = nextParams.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`);
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

function compareManualOrder(a, b, stageOrder) {
  return (
    (stageOrder.get(a.stage) ?? 999) - (stageOrder.get(b.stage) ?? 999) ||
    Number(a.position || 0) - Number(b.position || 0) ||
    Number(a.id) - Number(b.id)
  );
}

function compareChecklistItems(a, b, stageOrder) {
  const manualGap = compareManualOrder(a, b, stageOrder);
  const startA = a.calendarRange ? a.calendarRange.start.getTime() : Number.POSITIVE_INFINITY;
  const startB = b.calendarRange ? b.calendarRange.start.getTime() : Number.POSITIVE_INFINITY;
  const targetA = a.calendarRange ? a.calendarRange.end.getTime() : Number.POSITIVE_INFINITY;
  const targetB = b.calendarRange ? b.calendarRange.end.getTime() : Number.POSITIVE_INFINITY;
  const titleGap = String(a.content || "").localeCompare(String(b.content || ""), "ko", { sensitivity: "base" });

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
      return startA - startB || targetA - targetB || manualGap;
  }
}

function resolveCalendarRange(item) {
  const startDate = parseLocalDate(item.start_date);
  const targetDate = parseLocalDate(item.target_date);

  if (startDate && targetDate) {
    const start = startDate <= targetDate ? startDate : targetDate;
    const end = startDate <= targetDate ? targetDate : startDate;
    return {
      start,
      end,
      startLabel: toDateKey(start),
      endLabel: toDateKey(end),
    };
  }

  if (startDate) {
    return {
      start: startDate,
      end: startDate,
      startLabel: item.start_date,
      endLabel: item.start_date,
    };
  }

  if (targetDate) {
    return {
      start: targetDate,
      end: targetDate,
      startLabel: item.target_date,
      endLabel: item.target_date,
    };
  }

  return null;
}

function normalizeItems(items = checklistItems) {
  const stageOrder = new Map(projectStages.map((stage, idx) => [stage.stage_key, idx]));
  return [...items]
    .map((item) => ({ ...item, calendarRange: resolveCalendarRange(item) }))
    .sort((a, b) => compareChecklistItems(a, b, stageOrder));
}

function getFilterableChecklistItems() {
  return normalizeItems(checklistItems);
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
      \uC624\uB298
    </span>
    <span class="gantt-legend__item gantt-legend__item--marker">
      <span class="gantt-legend__swatch" style="background:#c0362c"></span>
      \uD504\uB85C\uC81D\uD2B8 \uB9C8\uAC10\uC77C
    </span>
  `;

  els.legend.innerHTML = `${stageLegend}${markerLegend}`;
}

function renderTaskFilterPanel() {
  if (!els.filterList || !els.filterSummary) return;

  const items = getFilterableChecklistItems();
  syncTaskFilterSelection(items);

  if (!items.length) {
    els.filterSummary.textContent = "\uC120\uD0DD\uD560 \uC791\uC5C5\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.";
    els.filterList.innerHTML = "<div class='gantt-filter-empty'>\uC791\uC5C5\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.</div>";
    return;
  }

  const selectedCount = taskFilterMode === "all" ? items.length : selectedTaskIds.size;
  if (taskFilterMode === "all") {
    els.filterSummary.textContent = `\uC804\uCCB4 ${items.length}\uAC1C \uC791\uC5C5 \uD45C\uC2DC \uC911`;
  } else if (taskFilterMode === "none") {
    els.filterSummary.textContent = `\uC120\uD0DD\uB41C \uC791\uC5C5 \uC5C6\uC74C / \uC804\uCCB4 ${items.length}\uAC1C`;
  } else {
    els.filterSummary.textContent = `${selectedCount}\uAC1C \uC120\uD0DD / \uC804\uCCB4 ${items.length}\uAC1C`;
  }

  els.filterList.innerHTML = items
    .map((item) => {
      const checked = taskFilterMode === "all" ? true : selectedTaskIds.has(Number(item.id));
      const stageName = stageLabel(item.stage);
      const dateLabel = item.start_date && item.target_date ? `${item.start_date} ~ ${item.target_date}` : item.start_date || item.target_date || "";
      return `
        <label class="gantt-filter-item">
          <input type="checkbox" data-task-filter-id="${item.id}" ${checked ? "checked" : ""} />
          <span class="gantt-filter-item__body">
            <span class="gantt-filter-item__top">
              <span class="gantt-filter-item__stage" style="background:${stageColor(item.stage)}18; color:${stageColor(item.stage)}; border-color:${stageColor(item.stage)}33;">
                ${escapeHtml(stageName)}
              </span>
              ${dateLabel ? `<span class="gantt-filter-item__date">${escapeHtml(dateLabel)}</span>` : ""}
            </span>
            <span class="gantt-filter-item__title">${escapeHtml(item.content || "\uC791\uC5C5")}</span>
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
    title: item.content || "\uC791\uC5C5 \uC124\uBA85",
    description: item.description || "",
    projectName: projectTitle,
    stageName: stageLabel(item.stage),
    startDate: item.start_date || "",
    targetDate: item.target_date || "",
    workflowStatus: item.workflow_status || "upcoming",
    editable: canEditTasks,
    editLabel: "\uAD00\uB9AC \uD398\uC774\uC9C0\uB85C \uC774\uB3D9",
    editHref: canEditTasks ? buildTaskManagerUrl(checklistId) : "",
  });
}

function renderWeekdayHeaders() {
  if (!els.weekdays) return;
  els.weekdays.innerHTML = WEEKDAY_LABELS.map((label, idx) => {
    const classes = ["calendar-weekday"];
    if (idx === 0) classes.push("is-sunday");
    if (idx === 6) classes.push("is-saturday");
    return `<div class="${classes.join(" ")}">${label}</div>`;
  }).join("");
}

function buildMonthCells(monthDate) {
  const monthStart = startOfMonth(monthDate);
  const monthEnd = endOfMonth(monthDate);
  const gridStart = startOfWeek(monthStart);
  const gridEnd = endOfWeek(monthEnd);
  const cells = [];

  let cursor = new Date(gridStart);
  while (cursor <= gridEnd) {
    cells.push(new Date(cursor));
    cursor = addDays(cursor, 1);
  }

  return cells;
}

function formatChipMeta(range, currentDate) {
  if (!range) return "";
  if (range.startLabel === range.endLabel) return range.startLabel;

  const currentDateKey = toDateKey(currentDate);
  if (currentDateKey === range.startLabel) return `시작 ${range.startLabel}`;
  if (currentDateKey === range.endLabel) return `마감 ${range.endLabel}`;
  return `${range.startLabel} ~ ${range.endLabel}`;
}

function renderTaskChip(item, currentDate) {
  const color = stageColor(item.stage);
  const meta = [stageLabel(item.stage), formatChipMeta(item.calendarRange, currentDate)].filter(Boolean).join(" · ");
  const titleParts = [item.content || "작업", meta].filter(Boolean);

  return `
    <button
      type="button"
      class="calendar-task-chip"
      data-open-calendar-task="${item.id}"
      style="background:${color}16; color:${color}; border-color:${color}33;"
      title="${escapeHtml(titleParts.join(" | "))}"
    >
      <span class="calendar-task-chip__title">${escapeHtml(item.content || "작업")}</span>
      ${meta ? `<span class="calendar-task-chip__meta">${escapeHtml(meta)}</span>` : ""}
    </button>
  `;
}

function renderCalendarCell(date, monthDate, dayItems, today, dueDate) {
  const isCurrentMonth = date.getMonth() === monthDate.getMonth();
  const isToday = isSameDay(date, today);
  const isDue = isSameDay(date, dueDate);
  const classes = ["calendar-day"];
  if (!isCurrentMonth) classes.push("is-outside-month");
  if (isToday) classes.push("is-today");
  if (isDue) classes.push("is-due");

  const badges = [
    isToday ? '<span class="calendar-day__badge is-today">\uC624\uB298</span>' : "",
    isDue ? '<span class="calendar-day__badge is-due">\uB9C8\uAC10</span>' : "",
  ]
    .filter(Boolean)
    .join("");

  return `
    <article class="${classes.join(" ")}">
      <div class="calendar-day__header">
        <strong class="calendar-day__date">${date.getDate()}</strong>
        <div class="calendar-day__badges">${badges}</div>
      </div>
      <div class="calendar-day__tasks">
        ${
          dayItems.length
            ? dayItems.map((item) => renderTaskChip(item, date)).join("")
            : isCurrentMonth
              ? '<div class="calendar-day__empty">일정 없음</div>'
              : ""
        }
      </div>
    </article>
  `;
}

function renderUnscheduledItems(items) {
  if (!els.unscheduledList) return;

  if (!items.length) {
    els.unscheduledList.innerHTML =
      "<div class='item calendar-unscheduled-empty'>\uC77C\uC815 \uBBF8\uC124\uC815 \uC791\uC5C5\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.</div>";
    return;
  }

  els.unscheduledList.innerHTML = items
    .map((item) => {
      const color = stageColor(item.stage);
      return `
        <article class="item calendar-unscheduled-card">
          <div class="calendar-unscheduled-card__top">
            <div class="calendar-unscheduled-card__copy">
              <div class="calendar-unscheduled-card__meta">
                <span class="gantt-stage-pill" style="background:${color}18; color:${color}; border-color:${color}33;">
                  ${escapeHtml(stageLabel(item.stage))}
                </span>
                <span class="item__meta">${escapeHtml(item.workflow_status || "upcoming")}</span>
              </div>
              <button type="button" class="task-detail-trigger calendar-unscheduled-card__title" data-open-calendar-task="${item.id}">
                ${escapeHtml(item.content || "\uC791\uC5C5")}
              </button>
            </div>
          </div>
          <div class="calendar-unscheduled-card__body">${escapeHtml(item.description || "\uC124\uBA85 \uC5C6\uC74C")}</div>
        </article>
      `;
    })
    .join("");
}

function renderCalendar() {
  renderWeekdayHeaders();

  const today = parseLocalDate(toDateKey(new Date()));
  const dueDate = parseLocalDate(currentProject?.due_date);
  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const allItems = normalizeItems(checklistItems);
  const visibleItems = allItems.filter((item) => isChecklistVisible(item));
  const scheduledItems = visibleItems.filter((item) => item.calendarRange);
  const unscheduledItems = visibleItems.filter((item) => !item.calendarRange);
  const monthItems = scheduledItems.filter((item) =>
    rangesIntersect(item.calendarRange.start, item.calendarRange.end, monthStart, monthEnd)
  );
  const cells = buildMonthCells(currentMonth);

  if (els.projectDue) els.projectDue.textContent = currentProject?.due_date || "-";
  if (els.currentMonth) els.currentMonth.textContent = formatMonthHeading(currentMonth);
  if (els.visibleCount) els.visibleCount.textContent = String(monthItems.length);
  if (els.unscheduledCount) els.unscheduledCount.textContent = String(unscheduledItems.length);
  if (els.monthInput) els.monthInput.value = toMonthKey(currentMonth);

  if (els.empty) {
    els.empty.classList.toggle("hidden", monthItems.length > 0);
    els.empty.textContent =
      taskFilterMode === "none"
        ? "\uC120\uD0DD\uB41C \uC791\uC5C5\uC774 \uC5C6\uC5B4 \uC774\uBC88 \uB2EC \uCEA8\uB9B0\uB354\uAC00 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4."
        : "\uC774\uBC88 \uB2EC\uC5D0 \uD45C\uC2DC\uD560 \uC791\uC5C5\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.";
  }

  if (els.grid) {
    els.grid.innerHTML = cells
      .map((date) => {
        const dayItems = monthItems.filter((item) => isDateWithin(item.calendarRange, date));
        return renderCalendarCell(date, currentMonth, dayItems, today, dueDate);
      })
      .join("");
  }

  renderUnscheduledItems(unscheduledItems);
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
  projectTitle = project.name || "\uD504\uB85C\uC81D\uD2B8";
  syncTaskFilterSelection(checklistItems);
  if (els.sortSelect) els.sortSelect.value = currentSort;
  renderLegend();
  renderTaskFilterPanel();

  document.title = `${projectTitle} - ${CALENDAR_LABEL}`;
  els.title.textContent = `${projectTitle} - ${CALENDAR_LABEL}`;
  els.subtitle.textContent = `${projectTitle}의 ${CALENDAR_SUBTITLE}`;
  els.projectBoardLink.href = `/static/project.html?project_id=${projectId}`;
  els.projectGanttLink.href = `/static/project_gantt.html?project_id=${projectId}`;
  els.projectSettingsLink.href = buildTaskManagerUrl();
  els.projectSettingsLink.textContent = "\uC791\uC5C5 \uCD94\uAC00/\uAD00\uB9AC";
}

els.grid?.addEventListener("click", (e) => {
  const taskBtn = e.target.closest("[data-open-calendar-task]");
  if (!taskBtn) return;
  openChecklistDetails(taskBtn.getAttribute("data-open-calendar-task"));
});

els.unscheduledList?.addEventListener("click", (e) => {
  const taskBtn = e.target.closest("[data-open-calendar-task]");
  if (!taskBtn) return;
  openChecklistDetails(taskBtn.getAttribute("data-open-calendar-task"));
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

  syncUrlState();
  renderTaskFilterPanel();
  renderCalendar();
});

els.filterSelectAll?.addEventListener("click", () => {
  taskFilterMode = "all";
  syncTaskFilterSelection(checklistItems);
  syncUrlState();
  renderTaskFilterPanel();
  renderCalendar();
});

els.filterClearAll?.addEventListener("click", () => {
  taskFilterMode = "none";
  selectedTaskIds = new Set();
  syncUrlState();
  renderTaskFilterPanel();
  renderCalendar();
});

els.sortSelect?.addEventListener("change", (e) => {
  currentSort = normalizeSortKey(e.target.value);
  syncUrlState();
  renderTaskFilterPanel();
  renderCalendar();
});

els.prevMonthBtn?.addEventListener("click", () => {
  currentMonth = addMonths(currentMonth, -1);
  syncUrlState();
  renderCalendar();
});

els.nextMonthBtn?.addEventListener("click", () => {
  currentMonth = addMonths(currentMonth, 1);
  syncUrlState();
  renderCalendar();
});

els.todayBtn?.addEventListener("click", () => {
  currentMonth = startOfMonth(new Date());
  syncUrlState();
  renderCalendar();
});

els.monthInput?.addEventListener("change", () => {
  const nextMonth = parseMonthParam(els.monthInput.value);
  if (!nextMonth) return;
  currentMonth = startOfMonth(nextMonth);
  syncUrlState();
  renderCalendar();
});

els.logoutBtn?.addEventListener("click", async () => {
  await api.post("/api/auth/logout", {});
  window.location.href = "/static/login.html";
});

Promise.resolve()
  .then(async () => {
    await loadSession();
    await loadProjectData();
    renderCalendar();
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
