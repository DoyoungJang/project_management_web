const form = document.getElementById("login-form");

async function request(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(await res.text());
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function loginLocal(payload) {
  return request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    await loginLocal(payload);
    window.location.href = "/";
  } catch (err) {
    alert(`로그인 실패: ${err.message}`);
  }
});
