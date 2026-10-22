/*!
 * Billie chat widget loader.
 * <script src="https://<billie address>/widget.js" data-bot="<bot>" async></script>
 * Adds a chat button; the chat itself opens in a frame served by Billie, so
 * nothing from the chat touches this page. Styles are set through the DOM
 * (no inline <style>), so it works under strict Content-Security-Policies.
 */
(function () {
  "use strict";
  var script =
    document.currentScript || document.querySelector('script[src*="/widget.js"][data-bot]');
  if (!script || !script.getAttribute("data-bot")) return;
  var slug = script.getAttribute("data-bot");
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) return;
  var origin = new URL(script.src, location.href).origin;
  var registry = (window.__billie = window.__billie || {});
  if (registry[slug]) return;
  registry[slug] = true;
  var side = script.getAttribute("data-position") === "left" ? "left" : "right";

  function textOn(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return "#ffffff";
    var n = parseInt(m[1], 16);
    var l = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
    return l > 0.6 ? "#111111" : "#ffffff";
  }

  function css(el, styles) {
    for (var k in styles) el.style.setProperty(k, styles[k]);
  }

  fetch(origin + "/api/public/chat/" + slug + "/config", { credentials: "omit" })
    .then(function (r) {
      return r.ok ? r.json() : null;
    })
    .then(function (bot) {
      if (bot) mount(bot);
    })
    .catch(function () {
      /* Billie unreachable: show nothing rather than a broken button. */
    });

  function mount(bot) {
    var colour = bot.color || "#0d6a5b";
    var on = textOn(colour);
    var open = false;
    var id = "billie-chat-" + slug;

    var button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", "Chat with " + bot.name);
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", id);
    css(button, {
      position: "fixed",
      bottom: "20px",
      width: "60px",
      height: "60px",
      "border-radius": "50%",
      border: "0",
      padding: "0",
      margin: "0",
      cursor: "pointer",
      background: colour,
      color: on,
      "box-shadow": "0 6px 24px rgba(0,0,0,0.22)",
      "z-index": "2147483000",
      display: "grid",
      "place-items": "center",
      transition: "transform .15s ease",
    });
    button.style.setProperty(side, "20px");
    var icon =
      '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    var close =
      '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    button.innerHTML = icon;

    var panel = document.createElement("div");
    panel.id = id;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Chat with " + bot.name);
    css(panel, {
      position: "fixed",
      "z-index": "2147483001",
      display: "none",
      overflow: "hidden",
      background: "#ffffff",
      "box-shadow": "0 12px 48px rgba(0,0,0,0.25)",
    });

    var frame = document.createElement("iframe");
    frame.title = "Chat with " + bot.name;
    frame.setAttribute("allow", "clipboard-write");
    css(frame, { width: "100%", height: "100%", border: "0", display: "block" });
    panel.appendChild(frame);

    var small = window.matchMedia("(max-width: 520px)");
    function layout() {
      if (small.matches) {
        css(panel, {
          top: "0",
          left: "0",
          right: "0",
          bottom: "0",
          width: "100%",
          height: "100%",
          "border-radius": "0",
        });
      } else {
        css(panel, {
          top: "auto",
          bottom: "92px",
          width: "380px",
          height: "min(640px, calc(100vh - 120px))",
          "border-radius": "16px",
        });
        panel.style.setProperty(side, "20px");
        panel.style.setProperty(side === "right" ? "left" : "right", "auto");
      }
      button.style.setProperty("display", open && small.matches ? "none" : "grid");
    }
    if (small.addEventListener) small.addEventListener("change", layout);

    function setOpen(next) {
      open = next;
      if (open && !frame.src) {
        frame.src =
          origin + "/embed/" + slug + "?page=" + encodeURIComponent(location.href.slice(0, 900));
      }
      panel.style.setProperty("display", open ? "block" : "none");
      button.setAttribute("aria-expanded", open ? "true" : "false");
      button.innerHTML = open ? close : icon;
      layout();
      if (open) frame.focus();
      else button.focus();
    }

    button.addEventListener("click", function () {
      setOpen(!open);
    });
    document.addEventListener("keydown", function (e) {
      if (open && e.key === "Escape") setOpen(false);
    });
    window.addEventListener("message", function (e) {
      if (e.origin !== origin || !e.data || e.data.type !== "billie:close") return;
      setOpen(false);
    });

    layout();
    document.body.appendChild(panel);
    document.body.appendChild(button);
  }
})();
