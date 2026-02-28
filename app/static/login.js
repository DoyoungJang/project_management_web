const loginForm = document.getElementById("login-form");
const registerForm = document.getElementById("register-form");

async function request(url, options = {}) {
  const res = await fetch(url, { credentials: "same-origin", ...options });
  if (!res.ok) throw new Error(await res.text());
  const text = await res.text();
  return text ? JSON.parse(text) : {};
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

async function loginLocal(payload) {
  return request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function registerLocal(payload) {
  return request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

loginForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = Object.fromEntries(new FormData(loginForm).entries());
  payload.username = String(payload.username || "").trim();

  try {
    await loginLocal(payload);
    window.location.href = "/";
  } catch (err) {
    alert(`로그인 실패: ${parseApiError(err)}`);
  }
});

registerForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = Object.fromEntries(new FormData(registerForm).entries());
  payload.username = String(payload.username || "").trim();
  payload.display_name = String(payload.display_name || "").trim();

  const password = String(payload.password || "");
  const confirmPassword = String(payload.confirm_password || "");

  if (password !== confirmPassword) {
    alert("비밀번호 확인이 일치하지 않습니다.");
    registerForm.elements.confirm_password?.focus();
    return;
  }

  try {
    await registerLocal({
      username: payload.username,
      display_name: payload.display_name,
      password,
    });

    await loginLocal({ username: payload.username, password });
    window.location.href = "/";
  } catch (err) {
    alert(`회원가입 실패: ${parseApiError(err)}`);
  }
});
