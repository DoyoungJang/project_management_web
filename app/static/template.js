const STAGES = [
  { key: "data_acquisition", title: "1. 데이터 획득" },
  { key: "labeling", title: "2. 라벨링" },
  { key: "development", title: "3. 개발" },
];

const els = {
  createForm: document.getElementById("template-create-form"),
  list: document.getElementById("template-list"),
  detailPanel: document.getElementById("template-detail-panel"),
  updateForm: document.getElementById("template-update-form"),
  deleteBtn: document.getElementById("template-delete-btn"),
  stageContainer: document.getElementById("template-stage-container"),
  adminLink: document.getElementById("admin-link"),
  logoutBtn: document.getElementById("logout-btn"),
};

const api = {
  async request(url, options = {}) {
    const res = await fetch(url, options);
    if (res.status === 401) {
      window.location.href = "/static/login.html";
      throw new Error("Unauthorized");
    }
    if (!res.ok) throw new Error(await res.text());
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  },
  get(url) {
    return this.request(url);
  },
  post(url, body) {
    return this.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },
  patch(url, body) {
    return this.request(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },
  put(url, body) {
    return this.request(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },
  del(url) {
    return this.request(url, { method: "DELETE" });
  },
};

let templates = [];
let selectedTemplateId = null;
let selectedTemplateItems = [];
let isDirty = false;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseApiError(error) {
  try {
    const parsed = JSON.parse(String(error.message || ""));
    if (parsed && typeof parsed.detail === "string") return parsed.detail;
  } catch (_) {
    // no-op
  }
  return String(error.message || "요청 처리 중 오류가 발생했습니다.");
}

function markDirty() {
  isDirty = true;
}

function clearDirty() {
  isDirty = false;
}

async function loadSession() {
  const me = await api.get("/api/auth/me");
  if (me.is_admin) els.adminLink.classList.remove("hidden");
}

async function loadTemplates() {
  templates = await api.get("/api/templates");
  renderTemplateList();

  if (selectedTemplateId !== null && !templates.find((t) => t.id === selectedTemplateId)) {
    selectedTemplateId = null;
    selectedTemplateItems = [];
    els.detailPanel.classList.add("hidden");
  }
}

function renderTemplateList() {
  if (templates.length === 0) {
    els.list.innerHTML = "<div class='item'>사용 가능한 템플릿이 없습니다.</div>";
    return;
  }

  els.list.innerHTML = templates
    .map(
      (tpl) => `
      <article class="item">
        <div class="item__head">
          <strong>${escapeHtml(tpl.name)}</strong>
          <span class="badge">${escapeHtml(tpl.creator_name || "")}</span>
        </div>
        <div class="item__meta">${escapeHtml(tpl.description || "-")}</div>
        <div class="actions">
          <button data-select-template="${tpl.id}">선택</button>
        </div>
      </article>
    `
    )
    .join("");
}

async function selectTemplate(templateId) {
  if (isDirty) {
    const ok = confirm("저장되지 않은 변경사항이 있습니다. 버리고 이동할까요?");
    if (!ok) return;
  }

  selectedTemplateId = Number(templateId);
  const selected = templates.find((t) => t.id === selectedTemplateId);
  if (!selected) return;

  els.updateForm.elements.name.value = selected.name || "";
  els.updateForm.elements.description.value = selected.description || "";

  selectedTemplateItems = await api.get(`/api/templates/${selectedTemplateId}/items`);
  clearDirty();
  renderSelectedTemplateDetail();
  els.detailPanel.classList.remove("hidden");
}

function renderSelectedTemplateDetail() {
  els.stageContainer.innerHTML = STAGES.map((stage) => renderStage(stage)).join("");
}

function renderStage(stage) {
  const items = selectedTemplateItems.filter((x) => x.stage === stage.key);
  return `
    <article class="stage">
      <h3>${stage.title}</h3>
      <div class="check-list">
        ${
          items.length === 0
            ? "<div class='item__meta'>작업 항목이 없습니다.</div>"
            : items
                .map(
                  (item) => `
                    <div class="check-item read-only">
                      <span><span class="badge stage-tag">${escapeHtml(stage.title)}</span> ${escapeHtml(item.content)}</span>
                      <button type="button" class="danger check-del" data-del-item="${item.position}" data-del-stage="${item.stage}">삭제</button>
                    </div>
                  `
                )
                .join("")
        }
      </div>
      <form class="check-form" data-stage="${stage.key}">
        <input name="content" placeholder="작업 항목 입력" required minlength="1" maxlength="200" />
        <button type="submit">추가</button>
      </form>
    </article>
  `;
}

function normalizeStagePositions(stage) {
  const stageItems = selectedTemplateItems.filter((x) => x.stage === stage);
  stageItems
    .sort((a, b) => a.position - b.position)
    .forEach((item, idx) => {
      item.position = idx;
    });
}

els.logoutBtn.addEventListener("click", async () => {
  await api.post("/api/auth/logout", {});
  window.location.href = "/static/login.html";
});

els.createForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const payload = Object.fromEntries(new FormData(els.createForm).entries());
    const created = await api.post("/api/templates", payload);
    els.createForm.reset();
    await loadTemplates();
    await selectTemplate(created.id);
  } catch (err) {
    alert(parseApiError(err));
  }
});

els.list.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-select-template]");
  if (!btn) return;
  await selectTemplate(btn.getAttribute("data-select-template"));
});

els.updateForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!selectedTemplateId) return;

  try {
    const payload = Object.fromEntries(new FormData(els.updateForm).entries());
    await api.patch(`/api/templates/${selectedTemplateId}`, payload);

    const replacePayload = {
      items: selectedTemplateItems
        .slice()
        .sort((a, b) => {
          const order = { data_acquisition: 1, labeling: 2, development: 3 };
          return order[a.stage] - order[b.stage] || a.position - b.position;
        })
        .map((x) => ({ stage: x.stage, content: x.content, position: x.position })),
    };
    await api.put(`/api/templates/${selectedTemplateId}/items`, replacePayload);

    clearDirty();
    await loadTemplates();
    await selectTemplate(selectedTemplateId);
    alert("템플릿 정보를 저장했습니다.");
  } catch (err) {
    alert(parseApiError(err));
  }
});

els.updateForm.addEventListener("input", () => {
  if (selectedTemplateId) markDirty();
});

els.deleteBtn.addEventListener("click", async () => {
  if (!selectedTemplateId) return;
  if (!confirm("선택한 템플릿을 삭제할까요?")) return;

  try {
    await api.del(`/api/templates/${selectedTemplateId}`);
    selectedTemplateId = null;
    selectedTemplateItems = [];
    clearDirty();
    els.detailPanel.classList.add("hidden");
    await loadTemplates();
  } catch (err) {
    alert(parseApiError(err));
  }
});

els.stageContainer.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-stage]");
  if (!form || !selectedTemplateId) return;
  e.preventDefault();

  const stage = form.getAttribute("data-stage");
  const payload = Object.fromEntries(new FormData(form).entries());

  const nextPos =
    selectedTemplateItems
      .filter((x) => x.stage === stage)
      .reduce((max, x) => Math.max(max, x.position), -1) + 1;

  selectedTemplateItems.push({
    id: `draft_${Date.now()}_${Math.random()}`,
    stage,
    content: String(payload.content).trim(),
    position: nextPos,
  });

  form.reset();
  markDirty();
  renderSelectedTemplateDetail();
});

els.stageContainer.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-del-item]");
  if (!btn) return;

  const stage = btn.getAttribute("data-del-stage");
  const position = Number(btn.getAttribute("data-del-item"));
  selectedTemplateItems = selectedTemplateItems.filter(
    (x) => !(x.stage === stage && x.position === position)
  );
  normalizeStagePositions(stage);
  markDirty();
  renderSelectedTemplateDetail();
});

Promise.resolve()
  .then(loadSession)
  .then(loadTemplates)
  .catch((err) => {
    console.error(err);
    if (!String(err.message).includes("Unauthorized")) {
      alert(`오류가 발생했습니다: ${parseApiError(err)}`);
    }
  });
