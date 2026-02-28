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
  createForm: document.getElementById("create-user-form"),
  list: document.getElementById("users-list"),
  logoutBtn: document.getElementById("logout-btn"),
};

let currentUser = null;
let users = [];

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
  del(url) {
    return this.request(url, { method: "DELETE", headers: withCsrfHeader() });
  },
};

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderUsers() {
  if (users.length === 0) {
    els.list.innerHTML = "<div class='item'>사용자가 없습니다.</div>";
    return;
  }
  els.list.innerHTML = users
    .map(
      (u) => `
      <div class="item">
        <div class="item__head">
          <strong>${escapeHtml(u.username)}</strong>
          <span class="badge">${u.is_admin ? "Admin" : "Member"}</span>
        </div>
        <div class="form-grid compact">
          <input data-name="${u.id}" value="${escapeHtml(u.display_name)}" />
          <input data-email="${u.id}" type="email" value="${escapeHtml(u.email || "")}" placeholder="email@company.local" />
          <input data-pass="${u.id}" type="password" placeholder="새 비밀번호(선택)" />
          <label class="inline-check"><input data-admin="${u.id}" type="checkbox" ${u.is_admin ? "checked" : ""} /> 관리자</label>
        </div>
        <div class="actions">
          <button data-save="${u.id}">저장</button>
          <button class="danger" data-del="${u.id}" ${u.id === currentUser.id ? "disabled" : ""}>삭제</button>
        </div>
      </div>
    `
    )
    .join("");
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

els.logoutBtn.addEventListener("click", async () => {
  await api.post("/api/auth/logout", {});
  window.location.href = "/static/login.html";
});

els.createForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = Object.fromEntries(new FormData(els.createForm).entries());
  payload.is_admin = Boolean(payload.is_admin);
  if (!payload.email) payload.email = null;
  await api.post("/api/admin/users", payload);
  els.createForm.reset();
  await loadUsers();
});

els.list.addEventListener("click", async (e) => {
  const saveBtn = e.target.closest("[data-save]");
  if (saveBtn) {
    const id = Number(saveBtn.getAttribute("data-save"));
    const nameEl = els.list.querySelector(`[data-name="${id}"]`);
    const emailEl = els.list.querySelector(`[data-email="${id}"]`);
    const passEl = els.list.querySelector(`[data-pass="${id}"]`);
    const adminEl = els.list.querySelector(`[data-admin="${id}"]`);
    const payload = {
      display_name: nameEl.value,
      email: emailEl.value || null,
      is_admin: adminEl.checked,
    };
    if (passEl.value.trim()) payload.password = passEl.value.trim();
    await api.patch(`/api/admin/users/${id}`, payload);
    await loadUsers();
    return;
  }

  const delBtn = e.target.closest("[data-del]");
  if (!delBtn) return;
  const id = Number(delBtn.getAttribute("data-del"));
  if (!confirm("사용자를 삭제할까요?")) return;
  await api.del(`/api/admin/users/${id}`);
  await loadUsers();
});

Promise.resolve()
  .then(loadSession)
  .then(loadUsers)
  .catch((err) => {
    console.error(err);
    if (!String(err.message).includes("Unauthorized")) {
      alert(`오류가 발생했습니다: ${err.message}`);
    }
  });
