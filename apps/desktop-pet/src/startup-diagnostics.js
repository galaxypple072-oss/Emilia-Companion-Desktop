(() => {
  let ready = false;

  function formatIssue(reason, fallback = "未知错误") {
    if (!reason) return fallback;
    const name = typeof reason.name === "string" ? reason.name : "";
    const message = typeof reason.message === "string" ? reason.message : String(reason);
    const heading = [name, message].filter(Boolean).join(": ");
    const stack = typeof reason.stack === "string" ? reason.stack : "";
    return stack.includes(message) ? stack : [heading, stack].filter(Boolean).join("\n");
  }

  function report(reason, { fatal = !ready } = {}) {
    const text = formatIssue(reason).slice(0, 1200);
    globalThis.__TAURI__?.core?.invoke?.("frontend_report_error", { message: text }).catch(() => {});
    if (!fatal) {
      console.error("[desktop] recovered runtime error", reason);
      return;
    }
    document.documentElement.dataset.boot = "error";
    let card = document.querySelector("#startup-error");
    if (!card) {
      card = document.createElement("pre");
      card.id = "startup-error";
      Object.assign(card.style, {
        position: "fixed", inset: "12px", zIndex: "99999", margin: "0", padding: "14px",
        border: "1px solid rgba(160,65,90,.35)", borderRadius: "14px",
        background: "rgba(255,245,248,.96)", color: "#71394b", font: "12px/1.5 -apple-system,sans-serif",
        whiteSpace: "pre-wrap", overflow: "auto",
      });
      document.body.append(card);
    }
    card.textContent = `桌宠初始化失败\n\n${text}`;
  }

  window.addEventListener("error", (event) => report(event.error || event.message));
  window.addEventListener("unhandledrejection", (event) => report(event.reason));
  window.addEventListener("companion:ready", () => {
    ready = true;
    document.documentElement.dataset.boot = "ready";
    document.querySelector("#startup-error")?.remove();
  });
  window.setTimeout(() => { if (!ready) report("初始化超过 30 秒仍未完成", { fatal: true }); }, 30_000);
})();
