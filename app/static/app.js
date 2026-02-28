const api = {
  async request(url, options = {}) {
    const res = await fetch(url, { credentials: "same-origin", ...options });
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
      headers: withCsrfHeader({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
  },
  del(url, body = null) {
    const options = { method: "DELETE", headers: withCsrfHeader() };
    if (body !== null && body !== undefined) {
      options.headers = withCsrfHeader({ "Content-Type": "application/json" });
      options.body = JSON.stringify(body);
    }
    return this.request(url, options);
  },
};

function getCookie(name) {
  const encoded = `${encodeURIComponent(name)}=`;
  const parts = document.cookie ? document.cookie.split("; ") : [];
  for (const part of parts) {
    if (part.startsWith(encoded)) return decodeURIComponent(part.slice(encoded.length));
  }
  return "";
}

function withCsrfHeader(headers = {}) {
  const csrf = getCookie("csrf_token");
  return csrf ? { ...headers, "X-CSRF-Token": csrf } : { ...headers };
}

const els = {
  userInfo: document.getElementById("user-info"),
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
    admin: "관리자",
  };
  return map[raw] || "기타";
}

function relationBadgeClass(raw) {
  if (raw === "owner") return "badge--owner";
  if (raw === "participant") return "badge--participant";
  return "";
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
        <div>${escapeHtml(x.content)}</div>
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

async function loadProjects() {
  projects = await api.get("/api/projects");
  renderProjects();
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
          <button data-open-project="${p.id}">보드</button>
          <button class="btn-settings" data-open-project-settings="${p.id}">프로젝트 설정</button>
          ${canDelete ? `<button class="danger" data-del-project="${p.id}">삭제</button>` : ""}
        </div>
      </div>
    `;
    })
    .join("");
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

els.todayNotifications?.addEventListener("click", (e) => {
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
  .then(loadSession)
  .then(refreshAll)
  .catch((err) => {
    console.error(err);
    if (!String(err.message).includes("Unauthorized")) {
      alert(`오류가 발생했습니다: ${parseApiError(err)}`);
    }
  });
