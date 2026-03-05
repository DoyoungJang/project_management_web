(function initPMCommon(global) {
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
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function parseApiError(error) {
    try {
      const parsed = JSON.parse(String(error?.message || ""));
      if (parsed && typeof parsed.detail === "string") return parsed.detail;
    } catch (_) {
      // no-op
    }
    return String(error?.message || "요청 처리 중 오류가 발생했습니다.");
  }

  function normalizeThemeColor(value) {
    const raw = String(value || "").trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(raw)) return "#0f6d66";
    return raw.toLowerCase();
  }

  function hexToRgb(hex) {
    const normalized = normalizeThemeColor(hex).slice(1);
    return {
      r: parseInt(normalized.slice(0, 2), 16),
      g: parseInt(normalized.slice(2, 4), 16),
      b: parseInt(normalized.slice(4, 6), 16),
    };
  }

  function rgbToHex(r, g, b) {
    const toHex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  function mixColor(baseHex, targetHex, ratio) {
    const base = hexToRgb(baseHex);
    const target = hexToRgb(targetHex);
    const p = Math.max(0, Math.min(1, Number(ratio) || 0));
    return rgbToHex(
      base.r + (target.r - base.r) * p,
      base.g + (target.g - base.g) * p,
      base.b + (target.b - base.b) * p
    );
  }

  function applyThemeColor(color) {
    const root = document.documentElement;
    const accent = normalizeThemeColor(color);
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-soft", mixColor(accent, "#ffffff", 0.84));
    root.style.setProperty("--hero-from", mixColor(accent, "#000000", 0.18));
    root.style.setProperty("--hero-to", mixColor(accent, "#000000", 0.06));
    return accent;
  }

  function applyUserTheme(user) {
    return applyThemeColor(user?.theme_color || "#0f6d66");
  }

  function createApiClient(options = {}) {
    const {
      loginPath = "/static/login.html",
      redirectOnUnauthorized = true,
      credentials = "same-origin",
      includeUnauthorizedBody = false,
    } = options;

    async function request(url, requestOptions = {}) {
      const response = await fetch(url, { credentials, ...requestOptions });
      if (response.status === 401) {
        if (redirectOnUnauthorized) {
          window.location.href = loginPath;
        }
        if (includeUnauthorizedBody) {
          const body = await response.text();
          throw new Error(body || "Unauthorized");
        }
        throw new Error("Unauthorized");
      }
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const text = await response.text();
      return text ? JSON.parse(text) : {};
    }

    return {
      request,
      get(url) {
        return request(url);
      },
      post(url, body) {
        return request(url, {
          method: "POST",
          headers: withCsrfHeader({ "Content-Type": "application/json" }),
          body: JSON.stringify(body),
        });
      },
      put(url, body) {
        return request(url, {
          method: "PUT",
          headers: withCsrfHeader({ "Content-Type": "application/json" }),
          body: JSON.stringify(body),
        });
      },
      patch(url, body) {
        return request(url, {
          method: "PATCH",
          headers: withCsrfHeader({ "Content-Type": "application/json" }),
          body: JSON.stringify(body),
        });
      },
      del(url, body = null) {
        const requestOptions = { method: "DELETE", headers: withCsrfHeader() };
        if (body !== null && body !== undefined) {
          requestOptions.headers = withCsrfHeader({ "Content-Type": "application/json" });
          requestOptions.body = JSON.stringify(body);
        }
        return request(url, requestOptions);
      },
    };
  }

  global.PMCommon = {
    applyThemeColor,
    applyUserTheme,
    createApiClient,
    escapeHtml,
    getCookie,
    normalizeThemeColor,
    parseApiError,
    withCsrfHeader,
  };
})(window);
