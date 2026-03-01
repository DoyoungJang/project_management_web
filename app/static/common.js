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
    createApiClient,
    escapeHtml,
    getCookie,
    parseApiError,
    withCsrfHeader,
  };
})(window);
