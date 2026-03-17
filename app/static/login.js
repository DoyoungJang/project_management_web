const { createApiClient, parseApiError } = window.PMCommon;
const api = createApiClient({ redirectOnUnauthorized: false, includeUnauthorizedBody: true });

const loginForm = document.getElementById("login-form");
const registerForm = document.getElementById("register-form");

async function loginLocal(payload) {
  return api.post("/api/auth/login", payload);
}

async function registerLocal(payload) {
  return api.post("/api/auth/register", payload);
}

function redirectAfterLogin(loginResult) {
  const isAdmin = Boolean(loginResult?.user?.is_admin);
  window.location.href = isAdmin ? "/static/admin.html" : "/";
}

loginForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = Object.fromEntries(new FormData(loginForm).entries());
  payload.username = String(payload.username || "").trim();

  try {
    const loginResult = await loginLocal(payload);
    redirectAfterLogin(loginResult);
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
      signup_code: String(payload.signup_code || "").trim(),
      password,
    });

    const loginResult = await loginLocal({ username: payload.username, password });
    redirectAfterLogin(loginResult);
  } catch (err) {
    alert(`회원가입 실패: ${parseApiError(err)}`);
  }
});
