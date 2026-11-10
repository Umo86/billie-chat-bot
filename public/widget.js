/*!
 * Billie chat widget loader.
 * <script src="https://<billie address>/widget.js" data-bot="<bot>" async></script>
 * Adds a chat button; the chat itself opens in a frame served by Billie, so
 * nothing from the chat touches this page. Styles are set through the DOM
 * (no inline <style>), so it works under strict Content-Security-Policies.
 * On BluePrint, the exhibitor manual, data-exhibitor-token="<sign-in>" opens
 * the chat signed in as that exhibitor; it goes to the frame after the "#",
 * which browsers never send to a server.
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
  var signIn = script.getAttribute("data-exhibitor-token") || "";
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(signIn) || signIn.length > 2048)
    signIn = "";

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
    // Words beside the icon ("Ask Billie"), set on the bot's Look step. Text only, never HTML.
    var label = typeof bot.launcherLabel === "string" ? bot.launcherLabel.trim().slice(0, 24) : "";
    var icon =
      '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    var close =
      '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    function face() {
      var pill = Boolean(label) && !open;
      button.innerHTML = open ? close : icon;
      if (pill) {
        var words = document.createElement("span");
        words.textContent = label;
        css(words, {
          "font-family": "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          "font-size": "15px",
          "font-weight": "700",
          "line-height": "1",
          "white-space": "nowrap",
        });
        button.appendChild(words);
      }
      css(button, {
        width: pill ? "auto" : "60px",
        height: pill ? "56px" : "60px",
        padding: pill ? "0 20px 0 16px" : "0",
        "border-radius": pill ? "28px" : "50%",
        gap: "8px",
        "grid-auto-flow": "column",
        "align-items": "center",
      });
      if (pill) {
        var svg = button.querySelector("svg");
        svg.setAttribute("width", "24");
        svg.setAttribute("height", "24");
      }
    }
    face();

    // The bar: an alternative to the round button, along the bottom of the page
    // ("Ask me about ..." cycling through the bot's topics). Set on the Look step.
    var tuckKey = "billie-bar-hidden-" + slug;
    var tucked = false;
    try {
      tucked = sessionStorage.getItem(tuckKey) === "1";
    } catch (e) {
      /* No storage: the bar shows. */
    }
    var bar = bot.launcher && bot.launcher.style === "bar" ? makeBar(bot.launcher) : null;

    function shade(hex, amount) {
      var m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
      if (!m) return hex;
      var n = parseInt(m[1], 16);
      function ch(c) {
        var v = amount >= 0 ? c + (255 - c) * amount : c * (1 + amount);
        v = Math.max(0, Math.min(255, Math.round(v))).toString(16);
        return v.length < 2 ? "0" + v : v;
      }
      return "#" + ch((n >> 16) & 255) + ch((n >> 8) & 255) + ch(n & 255);
    }

    function makeBar(cfg) {
      var lead = String(cfg.lead || "Ask me about").slice(0, 30);
      var topics = (Array.isArray(cfg.topics) ? cfg.topics : [])
        .filter(function (t) {
          return typeof t === "string" && t.trim();
        })
        .slice(0, 6)
        .map(function (t) {
          return t.trim().slice(0, 60);
        });
      if (!topics.length) topics = ["anything"];
      var still =
        cfg.motion === false ||
        (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      var move = function (el, frames, opts) {
        if (!still && el.animate) el.animate(frames, opts);
      };

      var wrap = document.createElement("div");
      var el = document.createElement("button");
      el.type = "button";
      el.setAttribute(
        "aria-label",
        "Chat with " +
          bot.name +
          ": " +
          lead +
          " " +
          (topics.length > 1
            ? topics.slice(0, -1).join(", ") + " or " + topics[topics.length - 1]
            : topics[0]),
      );
      el.setAttribute("aria-expanded", "false");
      el.setAttribute("aria-controls", id);
      css(el, {
        flex: "1",
        "min-width": "0",
        height: "100%",
        display: "flex",
        "align-items": "center",
        gap: "12px",
        padding: "0",
        margin: "0",
        border: "0",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        cursor: "pointer",
        "text-align": "left",
        "white-space": "nowrap",
        overflow: "hidden",
      });
      css(wrap, {
        position: "fixed",
        bottom: "12px",
        left: "50%",
        transform: "translateX(-50%)",
        width: "min(720px, calc(100vw - 24px))",
        height: "54px",
        "box-sizing": "border-box",
        display: "flex",
        "align-items": "center",
        gap: "4px",
        padding: "0 6px 0 14px",
        margin: "0",
        border: "0",
        "border-radius": "16px",
        background:
          "linear-gradient(180deg," + shade(colour, 0.1) + "," + shade(colour, -0.1) + ")",
        color: on,
        "box-shadow": "0 6px 28px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.25)",
        "z-index": "2147483000",
        "font-family": "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        "font-size": "15px",
        "line-height": "1",
        overflow: "hidden",
        transition: "transform .25s ease, box-shadow .25s ease",
      });
      wrap.appendChild(el);
      var eyes = [];

      if (cfg.mascot === "picture" && bot.avatarUrl) {
        var pic = document.createElement("img");
        pic.alt = "";
        pic.src = bot.avatarUrl;
        css(pic, {
          width: "34px",
          height: "34px",
          flex: "none",
          "border-radius": "50%",
          "object-fit": "cover",
          background: "#ffffff",
        });
        pic.addEventListener("error", function () {
          pic.remove();
        });
        el.appendChild(pic);
      } else if (cfg.mascot !== "none") {
        // A small robot face that bobs and blinks.
        var head = document.createElement("span");
        head.setAttribute("aria-hidden", "true");
        css(head, {
          position: "relative",
          flex: "none",
          width: "30px",
          height: "24px",
          "margin-top": "6px",
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          gap: "6px",
          background: "#ffffff",
          "border-radius": "48% 48% 42% 42% / 58% 58% 42% 42%",
          "box-shadow": "0 2px 6px rgba(0,0,0,0.25)",
        });
        var stalk = document.createElement("span");
        css(stalk, {
          position: "absolute",
          top: "-6px",
          left: "50%",
          width: "2px",
          height: "7px",
          "margin-left": "-1px",
          background: "#ffffff",
          "border-radius": "2px",
        });
        var bulb = document.createElement("span");
        css(bulb, {
          position: "absolute",
          top: "-10px",
          left: "50%",
          width: "6px",
          height: "6px",
          "margin-left": "-3px",
          background: "#ffffff",
          "border-radius": "50%",
        });
        head.appendChild(stalk);
        head.appendChild(bulb);
        for (var i = 0; i < 2; i++) {
          var eye = document.createElement("span");
          css(eye, {
            display: "block",
            width: "4px",
            height: "8px",
            "border-radius": "3px",
            background: shade(colour, -0.65),
          });
          move(
            eye,
            [
              { transform: "scaleY(1)", offset: 0 },
              { transform: "scaleY(1)", offset: 0.45 },
              { transform: "scaleY(0.12)", offset: 0.48 },
              { transform: "scaleY(1)", offset: 0.51 },
              { transform: "scaleY(1)", offset: 1 },
            ],
            { duration: 4200, iterations: Infinity },
          );
          // The blink is on the eye; looking around moves this holder.
          var socket = document.createElement("span");
          css(socket, { display: "block", transition: "transform .2s ease" });
          socket.appendChild(eye);
          eyes.push(socket);
          head.appendChild(socket);
        }
        move(
          head,
          [
            { transform: "translateY(0)" },
            { transform: "translateY(-2px)" },
            { transform: "translateY(0)" },
          ],
          { duration: 3200, iterations: Infinity, easing: "ease-in-out" },
        );
        el.appendChild(head);
      }

      var words = document.createElement("span");
      words.setAttribute("aria-hidden", "true");
      css(words, {
        flex: "1",
        "min-width": "0",
        display: "flex",
        "align-items": "center",
        gap: "0.35em",
        overflow: "hidden",
      });
      var first = document.createElement("span");
      first.textContent = lead;
      css(first, { opacity: "0.85", flex: "none" });
      var topic = document.createElement("span");
      topic.textContent = topics[0];
      css(topic, {
        "font-weight": "700",
        "min-width": "0",
        overflow: "hidden",
        "text-overflow": "ellipsis",
        padding: "4px 0",
      });
      words.appendChild(first);
      words.appendChild(topic);
      el.appendChild(words);

      var go = document.createElement("span");
      go.setAttribute("aria-hidden", "true");
      css(go, {
        flex: "none",
        width: "38px",
        height: "38px",
        display: "grid",
        "place-items": "center",
        "border-radius": "50%",
        background: "#ffffff",
        color: on === "#ffffff" ? colour : "#111111",
        "box-shadow": "0 2px 6px rgba(0,0,0,0.2)",
      });
      go.innerHTML =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
      el.appendChild(go);

      // Tucks the bar away for this visit: the round button takes its place.
      var hide = document.createElement("button");
      hide.type = "button";
      hide.setAttribute("aria-label", "Hide the chat bar");
      hide.title = "Hide";
      css(hide, {
        flex: "none",
        width: "30px",
        height: "30px",
        display: "grid",
        "place-items": "center",
        padding: "0",
        margin: "0",
        border: "0",
        "border-radius": "50%",
        background: "transparent",
        color: "inherit",
        opacity: "0.7",
        cursor: "pointer",
      });
      hide.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
      hide.addEventListener("click", function () {
        tucked = true;
        try {
          sessionStorage.setItem(tuckKey, "1");
        } catch (e) {
          /* Private browsing: hidden for this page only. */
        }
        layout();
        button.focus();
      });
      wrap.appendChild(hide);

      // The next topic every few seconds; it waits while the pointer is on the bar.
      var at = 0;
      var paused = false;
      wrap.addEventListener("mouseenter", function () {
        paused = true;
        wrap.style.setProperty("transform", "translateX(-50%) translateY(-2px)");
      });
      wrap.addEventListener("mouseleave", function () {
        paused = false;
        wrap.style.setProperty("transform", "translateX(-50%)");
      });

      // Small reactions to what the visitor does (none when movement is off):
      // the robot's eyes follow the pointer and look the way the page scrolls,
      // and after a quiet spell it hops once, and only once.
      if (!still) {
        var look = function (x, y) {
          for (var k = 0; k < eyes.length; k++)
            eyes[k].style.setProperty("transform", "translate(" + x + "px," + y + "px)");
        };
        var settle;
        var glance = function (x, y) {
          look(x, y);
          clearTimeout(settle);
          settle = setTimeout(function () {
            look(0, 0);
          }, 900);
        };
        var busy = false;
        var lastY = window.scrollY;
        window.addEventListener(
          "pointermove",
          function (e) {
            if (busy || !eyes.length) return;
            busy = true;
            requestAnimationFrame(function () {
              busy = false;
              var r = wrap.getBoundingClientRect();
              var dx = e.clientX - (r.left + 29);
              var dy = e.clientY - (r.top + r.height / 2);
              var d = Math.sqrt(dx * dx + dy * dy) || 1;
              glance((dx / d) * 2.5, (dy / d) * 1.5);
            });
          },
          { passive: true },
        );
        window.addEventListener(
          "scroll",
          function () {
            var y = window.scrollY;
            if (Math.abs(y - lastY) > 4) glance(0, y > lastY ? 1.5 : -1.5);
            lastY = y;
          },
          { passive: true },
        );
        var nudged = false;
        var quiet;
        var wait = function () {
          clearTimeout(quiet);
          if (nudged) return;
          quiet = setTimeout(function () {
            if (open || tucked || document.hidden) return;
            nudged = true;
            if (go.animate)
              go.animate(
                [
                  { transform: "scale(1)" },
                  { transform: "scale(1.18)" },
                  { transform: "scale(1)" },
                ],
                { duration: 700, iterations: 2, easing: "ease-in-out" },
              );
          }, 15000);
        };
        ["pointerdown", "keydown", "scroll"].forEach(function (name) {
          window.addEventListener(name, wait, { passive: true });
        });
        wait();
      }
      if (topics.length > 1)
        setInterval(function () {
          if (paused || open || document.hidden) return;
          at = (at + 1) % topics.length;
          topic.textContent = topics[at];
          move(
            topic,
            [
              { opacity: 0, transform: "translateY(70%)" },
              { opacity: 1, transform: "none" },
            ],
            { duration: 380, easing: "cubic-bezier(.3,.8,.3,1)" },
          );
        }, 3000);
      move(wrap, [{ opacity: 0 }, { opacity: 1 }], { duration: 600 });
      wrap.main = el;
      return wrap;
    }

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
      if (bar && !tucked) {
        // The bar when closed; the round button (a cross) while the chat is open.
        bar.style.setProperty("display", open ? "none" : "flex");
        button.style.setProperty("display", open && !small.matches ? "grid" : "none");
      } else {
        if (bar) bar.style.setProperty("display", "none");
        button.style.setProperty("display", open && small.matches ? "none" : "grid");
      }
    }
    if (small.addEventListener) small.addEventListener("change", layout);

    function setOpen(next) {
      open = next;
      if (open && !frame.src) {
        frame.src =
          origin +
          "/embed/" +
          slug +
          "?page=" +
          // Address and path only: query strings can hold private tokens.
          encodeURIComponent((location.origin + location.pathname).slice(0, 900)) +
          (signIn ? "#exhibitor-token=" + signIn : "");
      }
      panel.style.setProperty("display", open ? "block" : "none");
      button.setAttribute("aria-expanded", open ? "true" : "false");
      if (bar) bar.main.setAttribute("aria-expanded", open ? "true" : "false");
      face();
      layout();
      if (open) frame.focus();
      else (bar && !tucked ? bar.main : button).focus();
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

    if (bar)
      bar.main.addEventListener("click", function () {
        setOpen(true);
      });
    layout();
    document.body.appendChild(panel);
    if (bar) document.body.appendChild(bar);
    document.body.appendChild(button);
  }
})();
