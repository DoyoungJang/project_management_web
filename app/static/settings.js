const { createApiClient, applyThemeColor, applyUserTheme, normalizeThemeColor, parseApiError } = window.PMCommon;
const api = createApiClient();

const DEFAULT_THEME_COLOR = "#0f6d66";

const els = {
  userInfo: document.getElementById("user-info"),
  adminLink: document.getElementById("admin-link"),
  logoutBtn: document.getElementById("logout-btn"),
  themeForm: document.getElementById("theme-form"),
  themeColorInput: document.getElementById("theme-color-input"),
  themeColorText: document.getElementById("theme-color-text"),
  themeColorChip: document.getElementById("theme-color-chip"),
  themeColorValue: document.getElementById("theme-color-value"),
  themeResetBtn: document.getElementById("theme-reset-btn"),
  themePresets: document.getElementById("theme-presets"),
  profileForm: document.getElementById("profile-form"),
  profileUsername: document.getElementById("profile-username"),
  profileDisplayName: document.getElementById("profile-display-name"),
  profileEmail: document.getElementById("profile-email"),
  passwordForm: document.getElementById("password-form"),
};

let currentUser = null;

function isHexColor(value) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value || "").trim());
}

function setUserInfoText(user) {
  if (!user) return;
  els.userInfo.textContent = `${user.display_name} (${user.username})`;
}

function updatePresetActive(color) {
  const normalized = normalizeThemeColor(color);
  els.themePresets?.querySelectorAll("[data-theme-preset]").forEach((btn) => {
    const preset = normalizeThemeColor(btn.getAttribute("data-theme-preset"));
    btn.classList.toggle("is-active", preset === normalized);
  });
}

function syncThemeInputs(color, { applyPreview = true } = {}) {
  const normalized = normalizeThemeColor(color);
  els.themeColorInput.value = normalized;
  els.themeColorText.value = normalized;
  if (els.themeColorChip) els.themeColorChip.style.backgroundColor = normalized;
  if (els.themeColorValue) els.themeColorValue.textContent = normalized;
  updatePresetActive(normalized);
  if (applyPreview) applyThemeColor(normalized);
}

function fillProfile(user) {
  els.profileUsername.value = user.username || "";
  els.profileDisplayName.value = user.display_name || "";
  els.profileEmail.value = user.email || "";
  syncThemeInputs(user.theme_color || DEFAULT_THEME_COLOR);
}

async function loadSettings() {
  const data = await api.get("/api/auth/settings");
  currentUser = data.user;
  applyUserTheme(currentUser);
  if (currentUser.is_admin) els.adminLink.classList.remove("hidden");
  setUserInfoText(currentUser);
  fillProfile(currentUser);
}

els.logoutBtn.addEventListener("click", async () => {
  await api.post("/api/auth/logout", {});
  window.location.href = "/static/login.html";
});

els.themeColorInput.addEventListener("input", (e) => {
  syncThemeInputs(e.target.value);
});

els.themeColorText.addEventListener("input", (e) => {
  const raw = String(e.target.value || "").trim();
  if (isHexColor(raw)) syncThemeInputs(raw);
});

els.themePresets?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-theme-preset]");
  if (!btn) return;
  syncThemeInputs(btn.getAttribute("data-theme-preset"));
});

els.themeResetBtn.addEventListener("click", () => {
  syncThemeInputs(DEFAULT_THEME_COLOR);
});

els.themeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = String(els.themeColorText.value || "").trim();
  if (!isHexColor(raw)) {
    alert("테마 색상은 #RRGGBB 형식으로 입력해 주세요.");
    els.themeColorText.focus();
    return;
  }

  try {
    const updated = await api.patch("/api/auth/settings/profile", {
      theme_color: raw.toLowerCase(),
    });
    currentUser = updated.user;
    applyUserTheme(currentUser);
    syncThemeInputs(currentUser.theme_color || DEFAULT_THEME_COLOR, { applyPreview: false });
    alert("테마 색상을 저장했습니다.");
  } catch (err) {
    alert(parseApiError(err));
  }
});

els.profileForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const displayName = String(els.profileDisplayName.value || "").trim();
  const email = String(els.profileEmail.value || "").trim();
  if (!displayName) {
    alert("이름을 입력해 주세요.");
    els.profileDisplayName.focus();
    return;
  }

  try {
    const updated = await api.patch("/api/auth/settings/profile", {
      display_name: displayName,
      email,
    });
    currentUser = updated.user;
    setUserInfoText(currentUser);
    fillProfile(currentUser);
    alert("기본 정보를 저장했습니다.");
  } catch (err) {
    alert(parseApiError(err));
  }
});

els.passwordForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = Object.fromEntries(new FormData(els.passwordForm).entries());
  const currentPassword = String(payload.current_password || "");
  const newPassword = String(payload.new_password || "");
  const confirmPassword = String(payload.new_password_confirm || "");

  if (newPassword !== confirmPassword) {
    alert("새 비밀번호 확인이 일치하지 않습니다.");
    return;
  }

  try {
    await api.patch("/api/auth/settings/password", {
      current_password: currentPassword,
      new_password: newPassword,
    });
    els.passwordForm.reset();
    alert("비밀번호를 변경했습니다.");
  } catch (err) {
    alert(parseApiError(err));
  }
});

Promise.resolve()
  .then(loadSettings)
  .catch((err) => {
    console.error(err);
    if (!String(err.message || "").includes("Unauthorized")) {
      alert(parseApiError(err));
    }
  });
