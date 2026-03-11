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

  function appendLinkedText(container, value) {
    const text = String(value || "");
    const pattern = /((?:https?:\/\/|www\.)[^\s<]+)/gi;
    const matches = text.matchAll(pattern);
    let lastIndex = 0;

    function appendPlain(target, plain) {
      const lines = String(plain || "").split("\n");
      lines.forEach((line, idx) => {
        if (idx > 0) target.appendChild(document.createElement("br"));
        if (line) target.appendChild(document.createTextNode(line));
      });
    }

    for (const match of matches) {
      const urlText = match[0];
      const index = Number(match.index || 0);
      appendPlain(container, text.slice(lastIndex, index));

      const anchor = document.createElement("a");
      const href = /^https?:\/\//i.test(urlText) ? urlText : `https://${urlText}`;
      anchor.href = href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.textContent = urlText;
      anchor.className = "task-desc-link";
      container.appendChild(anchor);

      lastIndex = index + urlText.length;
    }

    appendPlain(container, text.slice(lastIndex));
  }

  let taskDescriptionDialog = null;

  function ensureTaskDescriptionDialog() {
    if (taskDescriptionDialog) return taskDescriptionDialog;

    const dialog = document.createElement("dialog");
    dialog.className = "task-desc-dialog";
    dialog.innerHTML = `
      <form method="dialog" class="task-desc-dialog__sheet">
        <div class="task-desc-dialog__header">
          <div>
            <h3 id="task-desc-dialog-title">\uC791\uC5C5 \uC124\uBA85</h3>
            <div id="task-desc-dialog-meta" class="item__meta"></div>
          </div>
          <div class="actions">
            <button id="task-desc-copy-btn" type="button">\uBCF5\uC0AC</button>
            <button type="submit">\uB2EB\uAE30</button>
          </div>
        </div>
        <div id="task-desc-dialog-body" class="task-desc-dialog__body"></div>
      </form>
    `;
    document.body.appendChild(dialog);

    dialog.addEventListener("click", (e) => {
      const rect = dialog.getBoundingClientRect();
      const isOutside =
        e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom;
      if (isOutside) dialog.close();
    });

    const copyBtn = dialog.querySelector("#task-desc-copy-btn");
    copyBtn?.addEventListener("click", async () => {
      const raw = String(copyBtn.getAttribute("data-copy-text") || "");
      try {
        await navigator.clipboard.writeText(raw);
        copyBtn.textContent = "\uBCF5\uC0AC\uB428";
        window.setTimeout(() => {
          copyBtn.textContent = "\uBCF5\uC0AC";
        }, 1200);
      } catch (_) {
        alert("\uBCF5\uC0AC\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.");
      }
    });

    taskDescriptionDialog = dialog;
    return dialog;
  }

  function showTaskDescriptionModal(options = {}) {
    const dialog = ensureTaskDescriptionDialog();
    const title = dialog.querySelector("#task-desc-dialog-title");
    const meta = dialog.querySelector("#task-desc-dialog-meta");
    const body = dialog.querySelector("#task-desc-dialog-body");
    const copyBtn = dialog.querySelector("#task-desc-copy-btn");

    const rawTitle =
      String(options.title || "\uC791\uC5C5 \uC124\uBA85").trim() || "\uC791\uC5C5 \uC124\uBA85";
    const rawDescription = String(options.description || "").trim();
    const metaParts = [
      options.projectName ? `\uD504\uB85C\uC81D\uD2B8: ${String(options.projectName).trim()}` : "",
      options.stageName ? `\uB300\uD56D\uBAA9: ${String(options.stageName).trim()}` : "",
      options.targetDate ? `\uBAA9\uD45C\uC77C: ${String(options.targetDate).trim()}` : "",
    ].filter(Boolean);

    if (title) title.textContent = rawTitle;
    if (meta) meta.textContent = metaParts.join(" | ");
    if (copyBtn) copyBtn.setAttribute("data-copy-text", rawDescription);
    if (body) {
      body.innerHTML = "";
      if (rawDescription) {
        appendLinkedText(body, rawDescription);
      } else {
        body.textContent = "\uB4F1\uB85D\uB41C \uC124\uBA85\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.";
      }
    }

    if (!dialog.open) {
      dialog.showModal();
    }
  }

  global.PMCommon = {
    appendLinkedText,
    applyThemeColor,
    applyUserTheme,
    createApiClient,
    escapeHtml,
    getCookie,
    normalizeThemeColor,
    parseApiError,
    showTaskDescriptionModal,
    withCsrfHeader,
  };
})(window);
