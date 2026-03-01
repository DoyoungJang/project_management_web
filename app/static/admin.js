const { createApiClient, escapeHtml, parseApiError } = window.PMCommon;

function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function includesKeyword(item, keys, keyword) {
  if (!keyword) return true;
  return keys.some((key) => normalizeText(item[key]).includes(keyword));
}

function setOverflowControls({ controls, info, toggle, total, shown, showAll, unitLabel }) {
  if (!controls || !info || !toggle) return;
  if (total <= shown) {
    controls.classList.add("hidden");
    return;
  }

  const hiddenCount = Math.max(total - shown, 0);
  info.textContent = `총 ${total}${unitLabel} 중 ${shown}${unitLabel} 표시`;
  toggle.textContent = showAll ? "접기" : `더 보기 (${hiddenCount}${unitLabel})`;
  controls.classList.remove("hidden");
}

const api = createApiClient();

const els = {
  createForm: document.getElementById("create-user-form"),
  usersList: document.getElementById("users-list"),
  userFilterInput: document.getElementById("user-filter-input"),
  usersOverflowControls: document.getElementById("users-overflow-controls"),
  usersOverflowInfo: document.getElementById("users-overflow-info"),
  usersOverflowToggle: document.getElementById("users-overflow-toggle"),
  expandUsersBtn: document.getElementById("expand-users-btn"),
  collapseUsersBtn: document.getElementById("collapse-users-btn"),
  projectsList: document.getElementById("projects-list"),
  projectsOverflowControls: document.getElementById("projects-overflow-controls"),
  projectsOverflowInfo: document.getElementById("projects-overflow-info"),
  projectsOverflowToggle: document.getElementById("projects-overflow-toggle"),
  projectFilterInput: document.getElementById("project-filter-input"),
  expandProjectsBtn: document.getElementById("expand-projects-btn"),
  collapseProjectsBtn: document.getElementById("collapse-projects-btn"),
  reloadProjectsBtn: document.getElementById("reload-projects-btn"),
  logoutBtn: document.getElementById("logout-btn"),
};

const LIMITS = {
  users: 8,
  projects: 8,
};

const state = {
  currentUser: null,
  users: [],
  projects: [],
  participantsByProject: new Map(),
  userFilterKeyword: "",
  projectFilterKeyword: "",
  showAllUsers: false,
  showAllProjects: false,
};

function statusLabel(raw) {
  const map = { planned: "Planned", active: "Active", done: "Done" };
  return map[raw] || raw;
}

function buildUserItemHtml(user) {
  return `
    <details class="item" data-user-details="${user.id}">
      <summary class="item__head admin-user-summary">
        <div class="actions">
          <strong>${escapeHtml(user.username)}</strong>
          <span class="badge">${user.is_admin ? "Admin" : "Member"}</span>
        </div>
        <span class="item__meta">${escapeHtml(user.display_name || "-")}</span>
      </summary>
      <div class="form-grid compact" style="margin-top: 8px;">
        <input data-user-name="${user.id}" value="${escapeHtml(user.display_name)}" />
        <input data-user-email="${user.id}" type="email" value="${escapeHtml(user.email || "")}" placeholder="email@company.local" />
        <input data-user-pass="${user.id}" type="password" placeholder="새 비밀번호(선택)" />
        <label class="inline-check"><input data-user-admin="${user.id}" type="checkbox" ${user.is_admin ? "checked" : ""} /> 관리자</label>
      </div>
      <div class="actions" style="margin-top: 8px;">
        <button data-user-save="${user.id}">저장</button>
        <button class="danger" data-user-del="${user.id}" ${user.id === state.currentUser.id ? "disabled" : ""}>삭제</button>
      </div>
    </details>
  `;
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
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function buildProjectItemHtml(project) {
  const members = state.participantsByProject.get(Number(project.id)) || [];
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
}

function renderUsers() {
  const keyword = state.userFilterKeyword.toLowerCase();
  const filteredUsers = state.users.filter((user) =>
    includesKeyword(user, ["username", "display_name", "email"], keyword)
  );

  if (!filteredUsers.length) {
    els.usersList.innerHTML = keyword
      ? "<div class='item'>검색 결과가 없습니다.</div>"
      : "<div class='item'>사용자가 없습니다.</div>";
    els.usersOverflowControls?.classList.add("hidden");
    return;
  }

  const visibleUsers = state.showAllUsers
    ? filteredUsers
    : filteredUsers.slice(0, LIMITS.users);

  els.usersList.innerHTML = visibleUsers.map(buildUserItemHtml).join("");

  setOverflowControls({
    controls: els.usersOverflowControls,
    info: els.usersOverflowInfo,
    toggle: els.usersOverflowToggle,
    total: filteredUsers.length,
    shown: visibleUsers.length,
    showAll: state.showAllUsers,
    unitLabel: "명",
  });
}

function renderProjects() {
  const keyword = state.projectFilterKeyword.toLowerCase();
  const filteredProjects = state.projects.filter((project) => {
    if (!keyword) return true;
    return (
      includesKeyword(project, ["name", "owner", "description", "status"], keyword) ||
      normalizeText(project.id).includes(keyword)
    );
  });

  if (!filteredProjects.length) {
    els.projectsList.innerHTML = "<div class='item'>프로젝트가 없습니다.</div>";
    els.projectsOverflowControls?.classList.add("hidden");
    return;
  }

  const visibleProjects = state.showAllProjects
    ? filteredProjects
    : filteredProjects.slice(0, LIMITS.projects);

  els.projectsList.innerHTML = visibleProjects.map(buildProjectItemHtml).join("");

  setOverflowControls({
    controls: els.projectsOverflowControls,
    info: els.projectsOverflowInfo,
    toggle: els.projectsOverflowToggle,
    total: filteredProjects.length,
    shown: visibleProjects.length,
    showAll: state.showAllProjects,
    unitLabel: "개",
  });
}

function setPanelsOpen(container, selector, open) {
  container?.querySelectorAll(selector).forEach((element) => {
    element.open = open;
  });
}

async function loadSession() {
  state.currentUser = await api.get("/api/auth/me");
  if (!state.currentUser.is_admin) {
    alert("관리자 권한이 필요합니다.");
    window.location.href = "/";
    throw new Error("Not admin");
  }
}

async function loadUsers() {
  state.users = await api.get("/api/admin/users");
  renderUsers();
}

async function loadProjects() {
  state.projects = await api.get("/api/projects");
  const participantsList = await Promise.all(
    state.projects.map(async (project) => {
      try {
        const list = await api.get(`/api/projects/${project.id}/participants`);
        return [project.id, list];
      } catch (_) {
        return [project.id, []];
      }
    })
  );

  state.participantsByProject.clear();
  for (const [projectId, members] of participantsList) {
    state.participantsByProject.set(Number(projectId), Array.isArray(members) ? members : []);
  }

  renderProjects();
}

async function refreshAll() {
  await Promise.all([loadUsers(), loadProjects()]);
}

async function handleCreateUser(event) {
  event.preventDefault();

  try {
    const payload = Object.fromEntries(new FormData(els.createForm).entries());
    payload.username = String(payload.username || "").trim();
    payload.display_name = String(payload.display_name || "").trim();
    payload.email = String(payload.email || "").trim();
    payload.password = String(payload.password || "");

    const requiredFields = [
      { key: "username", label: "아이디" },
      { key: "display_name", label: "이름" },
      { key: "email", label: "이메일" },
      { key: "password", label: "초기 비밀번호" },
    ];
    const missing = requiredFields.filter((field) => !payload[field.key]);
    if (missing.length > 0) {
      alert(`빈 곳이 있습니다: ${missing.map((x) => x.label).join(", ")}`);
      els.createForm.elements[missing[0].key]?.focus();
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
      alert("이메일 형식이 올바르지 않습니다.");
      els.createForm.elements.email?.focus();
      return;
    }

    payload.is_admin = Boolean(payload.is_admin);

    await api.post("/api/admin/users", payload);
    els.createForm.reset();
    await loadUsers();
  } catch (error) {
    alert(parseApiError(error));
  }
}

async function handleUsersListClick(event) {
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
}

async function handleProjectsListClick(event) {
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
  setPanelsOpen(els.projectsList, "[data-project-details]", true);
});

els.collapseProjectsBtn?.addEventListener("click", () => {
  setPanelsOpen(els.projectsList, "[data-project-details]", false);
});

els.expandUsersBtn?.addEventListener("click", () => {
  setPanelsOpen(els.usersList, "[data-user-details]", true);
});

els.collapseUsersBtn?.addEventListener("click", () => {
  setPanelsOpen(els.usersList, "[data-user-details]", false);
});

els.projectFilterInput?.addEventListener("input", () => {
  state.projectFilterKeyword = String(els.projectFilterInput.value || "").trim();
  state.showAllProjects = false;
  renderProjects();
});

els.userFilterInput?.addEventListener("input", () => {
  state.userFilterKeyword = String(els.userFilterInput.value || "").trim();
  state.showAllUsers = false;
  renderUsers();
});

els.usersOverflowToggle?.addEventListener("click", () => {
  state.showAllUsers = !state.showAllUsers;
  renderUsers();
});

els.projectsOverflowToggle?.addEventListener("click", () => {
  state.showAllProjects = !state.showAllProjects;
  renderProjects();
});

els.createForm?.addEventListener("submit", handleCreateUser);
els.usersList?.addEventListener("click", handleUsersListClick);
els.projectsList?.addEventListener("click", handleProjectsListClick);

Promise.resolve()
  .then(loadSession)
  .then(refreshAll)
  .catch((error) => {
    console.error(error);
    if (!String(error.message || "").includes("Unauthorized")) {
      alert(parseApiError(error));
    }
  });
