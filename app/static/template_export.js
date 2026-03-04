const { createApiClient, escapeHtml, parseApiError } = window.PMCommon;
const api = createApiClient();

const els = {
  adminLink: document.getElementById("admin-link"),
  logoutBtn: document.getElementById("logout-btn"),
  reloadBtn: document.getElementById("reload-btn"),
  selectAll: document.getElementById("select-all"),
  selectedCount: document.getElementById("selected-count"),
  exportSelectedBtn: document.getElementById("export-selected-btn"),
  list: document.getElementById("template-export-list"),
};

let templates = [];
const selectedIds = new Set();

function toSafeFileToken(value) {
  return String(value || "template")
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "template";
}

function downloadJson(data, fileName) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function normalizeTemplateItems(items, stages) {
  const stageOrder = new Map(
    (Array.isArray(stages) ? stages : []).map((x) => [String(x.key || x.stage_key), Number(x.position || 0)])
  );
  const grouped = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const stage = String(item.stage || "").trim();
    const content = String(item.content || "").trim();
    if (!stage || !content) continue;
    if (!grouped.has(stage)) grouped.set(stage, []);
    grouped.get(stage).push({
      stage,
      content,
      position: Number.isFinite(Number(item.position)) ? Number(item.position) : 0,
    });
  }
  const orderedStageKeys = Array.from(grouped.keys()).sort((a, b) => {
    const ao = stageOrder.has(a) ? stageOrder.get(a) : 999999;
    const bo = stageOrder.has(b) ? stageOrder.get(b) : 999999;
    return ao - bo || String(a).localeCompare(String(b));
  });
  const out = [];
  for (const stageKey of orderedStageKeys) {
    const rows = grouped.get(stageKey).sort((a, b) => a.position - b.position);
    rows.forEach((row, idx) => {
      out.push({
        stage: row.stage,
        content: row.content,
        position: idx,
      });
    });
  }
  return out;
}

function normalizeTemplateStages(stages, items) {
  const out = [];
  const keySet = new Set();
  const sortedStages = (Array.isArray(stages) ? stages : [])
    .slice()
    .sort((a, b) => Number(a.position || 0) - Number(b.position || 0));

  for (const stage of sortedStages) {
    const key = String(stage.key || stage.stage_key || "").trim();
    const name = String(stage.name || stage.stage_name || "").trim();
    if (!key || !name || keySet.has(key)) continue;
    keySet.add(key);
    out.push({ key, name, position: out.length });
  }

  for (const item of Array.isArray(items) ? items : []) {
    const key = String(item.stage || "").trim();
    if (!key || keySet.has(key)) continue;
    keySet.add(key);
    out.push({ key, name: key, position: out.length });
  }

  if (!out.length) {
    return [
      { key: "data_acquisition", name: "1. 데이터 획득", position: 0 },
      { key: "labeling", name: "2. 라벨링", position: 1 },
      { key: "development", name: "3. 개발", position: 2 },
    ];
  }

  return out;
}

function shouldFallbackExportApi(error) {
  const message = String(parseApiError(error) || "").toLowerCase();
  return (
    message.includes("not found") ||
    message.includes("method not allowed") ||
    message.includes("404") ||
    message.includes("405")
  );
}

async function buildExportPayloadByClient(templateIds) {
  const idSet = new Set(templateIds.map((x) => Number(x)));
  const selectedTemplates = templates.filter((tpl) => idSet.has(Number(tpl.id)));

  const templatePayloads = await Promise.all(
    selectedTemplates.map(async (tpl) => {
      const [stages, items] = await Promise.all([
        api.get(`/api/templates/${tpl.id}/stages`),
        api.get(`/api/templates/${tpl.id}/items`),
      ]);
      const normalizedStages = normalizeTemplateStages(stages, items);
      return {
        id: Number(tpl.id),
        name: tpl.name,
        description: tpl.description || "",
        creator_name: tpl.creator_name || "",
        stages: normalizedStages,
        items: normalizeTemplateItems(items, normalizedStages),
      };
    })
  );

  return {
    version: 1,
    exported_at: new Date().toISOString(),
    templates: templatePayloads,
  };
}

function updateSelectionState() {
  const total = templates.length;
  const selectedCount = selectedIds.size;
  els.selectedCount.textContent = `${selectedCount}개 선택`;
  els.exportSelectedBtn.disabled = selectedCount === 0;
  els.selectAll.checked = total > 0 && selectedCount === total;
  els.selectAll.indeterminate = selectedCount > 0 && selectedCount < total;
}

function renderList() {
  if (!templates.length) {
    els.list.innerHTML = "<div class='item'>백업 가능한 템플릿이 없습니다.</div>";
    updateSelectionState();
    return;
  }

  els.list.innerHTML = templates
    .map((tpl) => {
      const checked = selectedIds.has(Number(tpl.id)) ? "checked" : "";
      return `
      <label class="item template-export-item">
        <div class="item__head">
          <div class="actions">
            <input type="checkbox" data-select-template="${tpl.id}" ${checked} />
            <strong>${escapeHtml(tpl.name)}</strong>
          </div>
          <span class="badge">${escapeHtml(tpl.creator_name || "")}</span>
        </div>
        <div class="item__meta">${escapeHtml(tpl.description || "-")}</div>
      </label>
      `;
    })
    .join("");

  updateSelectionState();
}

async function loadSession() {
  const me = await api.get("/api/auth/me");
  if (me.is_admin) els.adminLink.classList.remove("hidden");
}

async function loadTemplates() {
  templates = await api.get("/api/templates");
  selectedIds.clear();
  renderList();
}

async function exportSelectedTemplates() {
  if (!selectedIds.size) {
    alert("백업할 템플릿을 선택하세요.");
    return;
  }

  const ids = Array.from(selectedIds);
  let payload;
  try {
    payload = await api.post("/api/template-export/selected", { template_ids: ids });
  } catch (err) {
    if (!shouldFallbackExportApi(err)) throw err;
    payload = await buildExportPayloadByClient(ids);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const nameToken =
    ids.length === 1
      ? toSafeFileToken((templates.find((x) => Number(x.id) === Number(ids[0])) || {}).name)
      : `selected_${ids.length}`;
  downloadJson(payload, `template_export_${nameToken}_${stamp}.json`);
}

els.logoutBtn?.addEventListener("click", async () => {
  await api.post("/api/auth/logout", {});
  window.location.href = "/static/login.html";
});

els.reloadBtn?.addEventListener("click", async () => {
  try {
    await loadTemplates();
  } catch (err) {
    alert(parseApiError(err));
  }
});

els.selectAll?.addEventListener("change", () => {
  if (els.selectAll.checked) {
    templates.forEach((tpl) => selectedIds.add(Number(tpl.id)));
  } else {
    selectedIds.clear();
  }
  renderList();
});

els.list?.addEventListener("change", (e) => {
  const input = e.target.closest("[data-select-template]");
  if (!input) return;
  const templateId = Number(input.getAttribute("data-select-template"));
  if (input.checked) {
    selectedIds.add(templateId);
  } else {
    selectedIds.delete(templateId);
  }
  updateSelectionState();
});

els.exportSelectedBtn?.addEventListener("click", async () => {
  try {
    els.exportSelectedBtn.disabled = true;
    els.exportSelectedBtn.textContent = "백업 중...";
    await exportSelectedTemplates();
  } catch (err) {
    alert(`백업 실패: ${parseApiError(err)}`);
  } finally {
    els.exportSelectedBtn.textContent = "선택한 템플릿 백업";
    updateSelectionState();
  }
});

Promise.resolve()
  .then(loadSession)
  .then(loadTemplates)
  .catch((err) => {
    console.error(err);
    if (!String(err.message || "").includes("Unauthorized")) {
      alert(`오류가 발생했습니다: ${parseApiError(err)}`);
    }
  });
