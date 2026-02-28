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
  reloadProjectsBtn: document.getElementById("reload-projects-btn"),
  logoutBtn: document.getElementById("logout-btn"),
};

let currentUser = null;
let users = [];
let projects = [];
const participantsByProject = new Map();

function statusLabel(raw) {
  const map = {
    planned: "Planned",
    active: "Active",
    done: "Done",
  };
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

function renderProjects() {
  if (!projects.length) {
    els.projectsList.innerHTML = "<div class='item'>프로젝트가 없습니다.</div>";
    return;
  }

  els.projectsList.innerHTML = projects
    .map((p) => {
      const members = participantsByProject.get(Number(p.id)) || [];
      const participantsHtml =
        members.length === 0
          ? "<div class='item__meta'>참가자 없음</div>"
          : members
              .map((m) => {
                const isOwner = m.username === p.owner;
                return `
                  <div class="actions" style="justify-content: space-between; margin: 4px 0;">
                    <div>
                      <strong>${escapeHtml(m.username)}</strong>
                      ${isOwner ? '<span class="badge badge--owner">Owner</span>' : ""}
                      <span class="item__meta">${escapeHtml(m.display_name || "")}</span>
                    </div>
                    ${
                      isOwner
                        ? ""
                        : `<button type="button" class="danger" data-participant-del="${p.id}" data-username="${escapeHtml(m.username)}">삭제</button>`
                    }
                  </div>
                `;
              })
              .join("");

      return `
        <div class="item">
          <div class="item__head">
            <strong>${escapeHtml(p.name)}</strong>
            <span class="badge">${escapeHtml(statusLabel(p.status))}</span>
          </div>
          <div class="item__meta">마감: ${escapeHtml(p.due_date || "-")} | ID: ${p.id}</div>
          <div>${escapeHtml(p.description || "-")}</div>

          <div class="form-grid compact" style="margin-top: 10px;">
            <input data-project-owner="${p.id}" value="${escapeHtml(p.owner)}" placeholder="owner username" />
            <button type="button" data-project-save-owner="${p.id}">Owner 변경</button>
          </div>

          <div style="margin-top: 10px;">
            <strong>참가자 목록</strong>
            <div style="margin-top: 6px;">${participantsHtml}</div>
          </div>

          <div class="form-grid compact" style="margin-top: 8px;">
            <input data-project-add-participant="${p.id}" placeholder="참가자 username" />
            <button type="button" data-project-add-btn="${p.id}">참가자 추가</button>
          </div>

          <div class="actions" style="margin-top: 10px;">
            <button class="danger" data-project-del="${p.id}">프로젝트 삭제</button>
          </div>
        </div>
      `;
    })
    .join("");
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
  } catch (err) {
    alert(parseApiError(err));
  }
});

els.createForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const payload = Object.fromEntries(new FormData(els.createForm).entries());
    payload.is_admin = Boolean(payload.is_admin);
    if (!payload.email) payload.email = null;
    await api.post("/api/admin/users", payload);
    els.createForm.reset();
    await loadUsers();
  } catch (err) {
    alert(parseApiError(err));
  }
});

els.usersList?.addEventListener("click", async (e) => {
  const saveBtn = e.target.closest("[data-user-save]");
  if (saveBtn) {
    const id = Number(saveBtn.getAttribute("data-user-save"));
    const nameEl = els.usersList.querySelector(`[data-user-name="${id}"]`);
    const emailEl = els.usersList.querySelector(`[data-user-email="${id}"]`);
    const passEl = els.usersList.querySelector(`[data-user-pass="${id}"]`);
    const adminEl = els.usersList.querySelector(`[data-user-admin="${id}"]`);
    const payload = {
      display_name: nameEl.value,
      email: emailEl.value || null,
      is_admin: adminEl.checked,
    };
    if (passEl.value.trim()) payload.password = passEl.value.trim();

    try {
      await api.patch(`/api/admin/users/${id}`, payload);
      await loadUsers();
    } catch (err) {
      alert(parseApiError(err));
    }
    return;
  }

  const delBtn = e.target.closest("[data-user-del]");
  if (!delBtn) return;

  const id = Number(delBtn.getAttribute("data-user-del"));
  if (!confirm("사용자를 삭제할까요?")) return;

  try {
    await api.del(`/api/admin/users/${id}`);
    await loadUsers();
  } catch (err) {
    alert(parseApiError(err));
  }
});

els.projectsList?.addEventListener("click", async (e) => {
  const saveOwnerBtn = e.target.closest("[data-project-save-owner]");
  if (saveOwnerBtn) {
    const projectId = Number(saveOwnerBtn.getAttribute("data-project-save-owner"));
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
    } catch (err) {
      alert(parseApiError(err));
    }
    return;
  }

  const addParticipantBtn = e.target.closest("[data-project-add-btn]");
  if (addParticipantBtn) {
    const projectId = Number(addParticipantBtn.getAttribute("data-project-add-btn"));
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
    } catch (err) {
      alert(parseApiError(err));
    }
    return;
  }

  const delParticipantBtn = e.target.closest("[data-participant-del]");
  if (delParticipantBtn) {
    const projectId = Number(delParticipantBtn.getAttribute("data-participant-del"));
    const username = String(delParticipantBtn.getAttribute("data-username") || "").trim();
    if (!username) return;
    if (!confirm(`참가자 '${username}'를 삭제할까요?`)) return;

    try {
      await api.del(`/api/projects/${projectId}/participants/${encodeURIComponent(username)}`);
      await loadProjects();
    } catch (err) {
      alert(parseApiError(err));
    }
    return;
  }

  const delProjectBtn = e.target.closest("[data-project-del]");
  if (!delProjectBtn) return;
  const projectId = Number(delProjectBtn.getAttribute("data-project-del"));
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
  } catch (err) {
    alert(parseApiError(err));
  }
});

Promise.resolve()
  .then(loadSession)
  .then(refreshAll)
  .catch((err) => {
    console.error(err);
    if (!String(err.message || "").includes("Unauthorized")) {
      alert(parseApiError(err));
    }
  });
