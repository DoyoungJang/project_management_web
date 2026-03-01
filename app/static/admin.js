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

function escapeHtml(value) {
  return String(value || "")
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
  patch(url, body) {
    return this.request(url, {
      method: "PATCH",
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

const els = {
  createForm: document.getElementById("create-user-form"),
  usersList: document.getElementById("users-list"),
  projectsList: document.getElementById("projects-list"),
  projectFilterInput: document.getElementById("project-filter-input"),
  expandProjectsBtn: document.getElementById("expand-projects-btn"),
  collapseProjectsBtn: document.getElementById("collapse-projects-btn"),
  reloadProjectsBtn: document.getElementById("reload-projects-btn"),
  logoutBtn: document.getElementById("logout-btn"),
};

let currentUser = null;
let users = [];
let projects = [];
const participantsByProject = new Map();
let projectFilterKeyword = "";

function statusLabel(raw) {
  const map = { planned: "Planned", active: "Active", done: "Done" };
  return map[raw] || raw;
}

async function loadSession() {
  currentUser = await api.get("/api/auth/me");
  if (!currentUser.is_admin) {
    alert("관리자 권한이 필요합니다.");
    window.location.href = "/";
    throw new Error("Not admin");
  }
}

async function loadUsers() {
  users = await api.get("/api/admin/users");
  renderUsers();
}

function renderUsers() {
  if (!users.length) {
    els.usersList.innerHTML = "<div class='item'>사용자가 없습니다.</div>";
    return;
  }

  els.usersList.innerHTML = users
    .map(
      (u) => `
      <div class="item">
        <div class="item__head">
          <strong>${escapeHtml(u.username)}</strong>
          <span class="badge">${u.is_admin ? "Admin" : "Member"}</span>
        </div>
        <div class="form-grid compact">
          <input data-user-name="${u.id}" value="${escapeHtml(u.display_name)}" />
          <input data-user-email="${u.id}" type="email" value="${escapeHtml(u.email || "")}" placeholder="email@company.local" />
          <input data-user-pass="${u.id}" type="password" placeholder="새 비밀번호(선택)" />
          <label class="inline-check"><input data-user-admin="${u.id}" type="checkbox" ${u.is_admin ? "checked" : ""} /> 관리자</label>
        </div>
        <div class="actions">
          <button data-user-save="${u.id}">저장</button>
          <button class="danger" data-user-del="${u.id}" ${u.id === currentUser.id ? "disabled" : ""}>삭제</button>
        </div>
      </div>
    `
    )
    .join("");
}

async function loadProjects() {
  projects = await api.get("/api/projects");
  const participantsList = await Promise.all(
    projects.map(async (p) => {
      try {
        const list = await api.get(`/api/projects/${p.id}/participants`);
        return [p.id, list];
      } catch (_) {
        return [p.id, []];
      }
    })
  );

  participantsByProject.clear();
  for (const [projectId, members] of participantsList) {
    participantsByProject.set(Number(projectId), Array.isArray(members) ? members : []);
  }

  renderProjects();
}

function buildParticipantsHtml(project, members) {
  if (!members.length) {
    return "<div class='item__meta'>참가자가 없습니다.</div>";
  }

  const rows = members
    .map((member) => {
      const isOwner = member.username === project.owner;
      return `
        <tr>
          <td><strong>${escapeHtml(member.username)}</strong></td>
          <td class="item__meta">${escapeHtml(member.display_name || "-")}</td>
          <td>${isOwner ? '<span class="badge badge--owner">소유자</span>' : '<span class="badge">참가자</span>'}</td>
          <td class="participant-action-col">
            ${
              isOwner
                ? "<span class='item__meta'>보호됨</span>"
                : `<button type="button" class="participant-delete-btn" data-participant-del="${project.id}" data-username="${escapeHtml(member.username)}" aria-label="${escapeHtml(member.username)} 삭제">삭제</button>`
            }
          </td>
        </tr>
      `;
    })
    .join("");

  return `
    <div class="participant-table">
      <table class="participant-grid">
        <thead>
          <tr>
            <th>아이디</th>
            <th>이름</th>
            <th>역할</th>
            <th class="participant-action-col">삭제</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

function renderProjects() {
  const keyword = projectFilterKeyword.toLowerCase();
  const visibleProjects = projects.filter((project) => {
    if (!keyword) return true;
    return (
      String(project.name || "").toLowerCase().includes(keyword) ||
      String(project.owner || "").toLowerCase().includes(keyword) ||
      String(project.description || "").toLowerCase().includes(keyword)
    );
  });

  if (!visibleProjects.length) {
    els.projectsList.innerHTML = "<div class='item'>프로젝트가 없습니다.</div>";
    return;
  }

  els.projectsList.innerHTML = visibleProjects
    .map((project) => {
      const members = participantsByProject.get(Number(project.id)) || [];
      const participantsHtml = buildParticipantsHtml(project, members);

      return `
        <details class="item" data-project-details="${project.id}">
          <summary class="item__head admin-project-summary">
            <div class="actions">
              <strong>${escapeHtml(project.name)}</strong>
              <span class="badge">${escapeHtml(statusLabel(project.status))}</span>
            </div>
            <span class="item__meta">Owner: ${escapeHtml(project.owner)} | 참가자: ${members.length}명</span>
          </summary>

          <div class="item__meta" style="margin-top: 8px;">마감: ${escapeHtml(project.due_date || "-")} | ID: ${project.id}</div>
          <div>${escapeHtml(project.description || "-")}</div>

          <div class="form-grid compact" style="margin-top: 10px;">
            <input data-project-owner="${project.id}" value="${escapeHtml(project.owner)}" placeholder="owner username" />
            <button type="button" data-project-save-owner="${project.id}">Owner 변경</button>
          </div>

          <div style="margin-top: 10px;">
            <strong>참가자 목록</strong>
            <div style="margin-top: 6px;">${participantsHtml}</div>
          </div>

          <div class="form-grid compact" style="margin-top: 8px;">
            <input data-project-add-participant="${project.id}" placeholder="참가자 username" />
            <button type="button" data-project-add-btn="${project.id}">참가자 추가</button>
          </div>

          <div class="actions" style="margin-top: 10px;">
            <button class="danger" data-project-del="${project.id}">프로젝트 삭제</button>
          </div>
        </details>
      `;
    })
    .join("");
}

function setProjectPanelsOpen(open) {
  els.projectsList?.querySelectorAll("[data-project-details]").forEach((element) => {
    element.open = open;
  });
}

async function refreshAll() {
  await Promise.all([loadUsers(), loadProjects()]);
}

els.logoutBtn.addEventListener("click", async () => {
  await api.post("/api/auth/logout", {});
  window.location.href = "/static/login.html";
});

els.reloadProjectsBtn?.addEventListener("click", async () => {
  try {
    await loadProjects();
  } catch (error) {
    alert(parseApiError(error));
  }
});

els.expandProjectsBtn?.addEventListener("click", () => {
  setProjectPanelsOpen(true);
});

els.collapseProjectsBtn?.addEventListener("click", () => {
  setProjectPanelsOpen(false);
});

els.projectFilterInput?.addEventListener("input", () => {
  projectFilterKeyword = String(els.projectFilterInput.value || "").trim();
  renderProjects();
});

els.createForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = Object.fromEntries(new FormData(els.createForm).entries());
    payload.is_admin = Boolean(payload.is_admin);
    if (!payload.email) payload.email = null;

    await api.post("/api/admin/users", payload);
    els.createForm.reset();
    await loadUsers();
  } catch (error) {
    alert(parseApiError(error));
  }
});

els.usersList?.addEventListener("click", async (event) => {
  const saveButton = event.target.closest("[data-user-save]");
  if (saveButton) {
    const userId = Number(saveButton.getAttribute("data-user-save"));
    const nameInput = els.usersList.querySelector(`[data-user-name="${userId}"]`);
    const emailInput = els.usersList.querySelector(`[data-user-email="${userId}"]`);
    const passInput = els.usersList.querySelector(`[data-user-pass="${userId}"]`);
    const adminInput = els.usersList.querySelector(`[data-user-admin="${userId}"]`);

    const payload = {
      display_name: nameInput.value,
      email: emailInput.value || null,
      is_admin: adminInput.checked,
    };
    if (passInput.value.trim()) payload.password = passInput.value.trim();

    try {
      await api.patch(`/api/admin/users/${userId}`, payload);
      await loadUsers();
    } catch (error) {
      alert(parseApiError(error));
    }
    return;
  }

  const deleteButton = event.target.closest("[data-user-del]");
  if (!deleteButton) return;

  const userId = Number(deleteButton.getAttribute("data-user-del"));
  if (!confirm("사용자를 삭제할까요?")) return;

  try {
    await api.del(`/api/admin/users/${userId}`);
    await loadUsers();
  } catch (error) {
    alert(parseApiError(error));
  }
});

els.projectsList?.addEventListener("click", async (event) => {
  const saveOwnerButton = event.target.closest("[data-project-save-owner]");
  if (saveOwnerButton) {
    const projectId = Number(saveOwnerButton.getAttribute("data-project-save-owner"));
    const ownerInput = els.projectsList.querySelector(`[data-project-owner="${projectId}"]`);
    const owner = String(ownerInput?.value || "").trim();
    if (!owner) {
      alert("Owner username을 입력하세요.");
      ownerInput?.focus();
      return;
    }

    try {
      await api.patch(`/api/projects/${projectId}`, { owner });
      await loadProjects();
    } catch (error) {
      alert(parseApiError(error));
    }
    return;
  }

  const addParticipantButton = event.target.closest("[data-project-add-btn]");
  if (addParticipantButton) {
    const projectId = Number(addParticipantButton.getAttribute("data-project-add-btn"));
    const input = els.projectsList.querySelector(`[data-project-add-participant="${projectId}"]`);
    const username = String(input?.value || "").trim();
    if (!username) {
      alert("참가자 username을 입력하세요.");
      input?.focus();
      return;
    }

    try {
      await api.post(`/api/projects/${projectId}/participants`, { username });
      if (input) input.value = "";
      await loadProjects();
    } catch (error) {
      alert(parseApiError(error));
    }
    return;
  }

  const deleteParticipantButton = event.target.closest("[data-participant-del]");
  if (deleteParticipantButton) {
    const projectId = Number(deleteParticipantButton.getAttribute("data-participant-del"));
    const username = String(deleteParticipantButton.getAttribute("data-username") || "").trim();
    if (!username) return;
    if (!confirm(`참가자 '${username}'를 삭제할까요?`)) return;

    try {
      await api.del(`/api/projects/${projectId}/participants/${encodeURIComponent(username)}`);
      await loadProjects();
    } catch (error) {
      alert(parseApiError(error));
    }
    return;
  }

  const deleteProjectButton = event.target.closest("[data-project-del]");
  if (!deleteProjectButton) return;

  const projectId = Number(deleteProjectButton.getAttribute("data-project-del"));
  if (!confirm("프로젝트를 삭제할까요?")) return;

  const password = prompt("관리자 본인 비밀번호를 입력하세요.");
  if (password === null) return;
  if (!String(password).trim()) {
    alert("비밀번호를 입력해야 삭제할 수 있습니다.");
    return;
  }

  try {
    await api.del(`/api/projects/${projectId}`, { password: String(password).trim() });
    await loadProjects();
  } catch (error) {
    alert(parseApiError(error));
  }
});

Promise.resolve()
  .then(loadSession)
  .then(refreshAll)
  .catch((error) => {
    console.error(error);
    if (!String(error.message || "").includes("Unauthorized")) {
      alert(parseApiError(error));
    }
  });
