const params = new URLSearchParams(window.location.search);
const projectId = Number(params.get("project_id"));

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
};

const STAGE_COLORS = ["#0f6d66", "#2a6f97", "#c06c2c", "#7a4fb0", "#3b7a57", "#9b2226"];

let currentProject = null;
let projectStages = [];
let checklistItems = [];
let projectTitle = "프로젝트";
let manualTimelineRange = null;
let currentUser = null;
let canEditTasks = false;

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
    onSave: async (payload) => {
      await api.patch(`/api/checklists/${checklistId}`, {
        content: payload.content,
        description: payload.description,
        start_date: payload.start_date,
        target_date: payload.target_date,
        workflow_status: payload.workflow_status,
      });
      await loadProjectData();
      renderGanttChart();
      const refreshed = findChecklistItem(checklistId);
      return refreshed
        ? {
            ...refreshed,
            stageName: stageLabel(refreshed.stage),
          }
        : null;
    },
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

function normalizeItems(today) {
  const stageOrder = new Map(projectStages.map((stage, idx) => [stage.stage_key, idx]));
  return [...checklistItems]
    .map((item) => ({ ...item, ganttRange: resolveItemRange(item, today) }))
    .sort((a, b) => {
      const endA = a.ganttRange ? a.ganttRange.end.getTime() : Number.POSITIVE_INFINITY;
      const endB = b.ganttRange ? b.ganttRange.end.getTime() : Number.POSITIVE_INFINITY;
      const startA = a.ganttRange ? a.ganttRange.start.getTime() : Number.POSITIVE_INFINITY;
      const startB = b.ganttRange ? b.ganttRange.start.getTime() : Number.POSITIVE_INFINITY;
      return (
        endA - endB ||
        startA - startB ||
        (stageOrder.get(a.stage) ?? 999) - (stageOrder.get(b.stage) ?? 999) ||
        Number(a.position || 0) - Number(b.position || 0)
      );
    });
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

function renderScheduledRows({ scheduledItems, days, dayIndexMap, todayIndex, dueIndex, styleVars, labelWidth }) {
  if (!scheduledItems.length) {
    return `
      <div class="gantt-row" style="grid-template-columns:${labelWidth}px auto;">
        <div class="gantt-label">
          <strong>선택한 범위에 표시할 작업이 없습니다.</strong>
          <div class="item__meta">범위를 조정하면 간트 차트가 즉시 다시 그려집니다.</div>
        </div>
        <div class="gantt-track-wrap">
          <div class="gantt-track" style="${styleVars}">
            ${buildMarkerHtml(todayIndex, dueIndex)}
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
      return `
        <div class="gantt-row" style="grid-template-columns:${labelWidth}px auto;">
          <div class="gantt-label">
            <strong>${escapeHtml(item.content)}</strong>
            <div class="item__meta">
              ${escapeHtml(stageName)} | 시작일: ${escapeHtml(range.startLabel)} | 목표일: ${escapeHtml(range.targetLabel)}
            </div>
          </div>
          <div class="gantt-track-wrap">
            <div class="gantt-track" style="${styleVars}">
              ${buildMarkerHtml(todayIndex, dueIndex)}
              <button
                type="button"
                class="gantt-bar"
                data-open-gantt-description="${item.id}"
                style="left:calc(${startIndex} * var(--gantt-cell-width)); width:calc(${span} * var(--gantt-cell-width) - 8px); background:${color};"
                title="${escapeHtml(item.content)}"
                aria-label="${escapeHtml(item.content)} 설명 보기"
              >
                ${escapeHtml(item.content)}
              </button>
            </div>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderGanttChart() {
  const today = parseLocalDate(toDateKey(new Date()));
  const sortedItems = normalizeItems(today);
  const scheduledItems = sortedItems.filter((item) => item.ganttRange);
  const unscheduledItems = sortedItems.filter((item) => !item.ganttRange);
  const dueDate = parseLocalDate(currentProject?.due_date);
  const autoRange = getAutoTimelineRange(scheduledItems, dueDate, today);

  if (els.projectDue) els.projectDue.textContent = currentProject?.due_date || "-";
  if (els.scheduledCount) els.scheduledCount.textContent = String(scheduledItems.length);
  if (els.unscheduledCount) els.unscheduledCount.textContent = String(unscheduledItems.length);

  renderLegend();
  renderUnscheduledItems(unscheduledItems);

  if (!autoRange) {
    syncTimelineInputs(manualTimelineRange);
    els.rangeLabel.textContent = "-";
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

  const days = buildTimelineDays(appliedRange.start, appliedRange.end);
  const dayIndexMap = new Map(days.map((day, idx) => [toDateKey(day), idx]));
  const todayIndex = today ? dayIndexMap.get(toDateKey(today)) : null;
  const dueIndex = dueDate ? dayIndexMap.get(toDateKey(dueDate)) : null;
  const metrics = getTimelineMetrics(days.length);
  const styleVars = `--gantt-days:${days.length}; --gantt-cell-width:${metrics.cellWidth}px;`;
  const headerConfig = getTimelineHeaderConfig(days, metrics);
  const headerLabelsHtml = buildTimelineHeaderLabels(days, headerConfig);

  els.rangeLabel.textContent = formatRange(appliedRange.start, appliedRange.end);
  els.empty.classList.add("hidden");
  els.scroll.classList.remove("hidden");

  const headerHtml = `
    <div class="gantt-row gantt-row--header" style="grid-template-columns:${metrics.labelWidth}px auto;">
      <div class="gantt-label gantt-label--header">작업</div>
      <div class="gantt-track-wrap">
        <div class="gantt-days ${headerConfig.mode !== "day" ? "gantt-days--condensed" : ""}" style="${styleVars}">
          ${days
            .map((day, index) => {
              const classes = [
                "gantt-day",
                day.getDay() === 1 ? "is-week-start" : "",
                day.getDate() === 1 ? "is-month-start" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return `<div class="${classes}" title="${toDateKey(day)}">${
                headerConfig.mode === "day" ? getTimelineLabel(day, index, days, headerConfig) : ""
              }</div>`;
            })
            .join("")}
          ${headerLabelsHtml ? `<div class="gantt-header-labels">${headerLabelsHtml}</div>` : ""}
        </div>
      </div>
    </div>
  `;

  const rowsHtml = renderScheduledRows({
    scheduledItems: visibleScheduledItems,
    days,
    dayIndexMap,
    todayIndex,
    dueIndex,
    styleVars,
    labelWidth: metrics.labelWidth,
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
  canEditTasks = Boolean(currentUser?.is_admin || project.owner === currentUser?.username);
  projectTitle = project.name || "프로젝트";

  els.title.textContent = `${projectTitle} - 간트 차트`;
  els.subtitle.textContent = `${projectTitle}의 시작일과 목표일 기준 일정을 확인합니다.`;
  els.projectBoardLink.href = `/static/project.html?project_id=${projectId}`;
  els.projectSettingsLink.href = `/static/project_settings.html?project_id=${projectId}`;
}

els.scroll?.addEventListener("click", (e) => {
  const detailBtn = e.target.closest("[data-open-gantt-description]");
  if (!detailBtn) return;
  openChecklistDetails(detailBtn.getAttribute("data-open-gantt-description"));
});

els.unscheduledList?.addEventListener("click", (e) => {
  const detailBtn = e.target.closest("[data-open-gantt-description]");
  if (!detailBtn) return;
  openChecklistDetails(detailBtn.getAttribute("data-open-gantt-description"));
});

els.rangeForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  applyManualTimelineRange();
});

els.rangeStart?.addEventListener("change", () => {
  if (!els.rangeStart?.value || !els.rangeEnd?.value) return;
  applyManualTimelineRange();
});

els.rangeEnd?.addEventListener("change", () => {
  if (!els.rangeStart?.value || !els.rangeEnd?.value) return;
  applyManualTimelineRange();
});

els.rangeReset?.addEventListener("click", () => {
  manualTimelineRange = null;
  syncTimelineRangeToUrl(null);
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
  })
  .catch((error) => {
    console.error(error);
    if (!String(error.message || "").includes("Unauthorized")) {
      alert(parseApiError(error));
    }
  });
