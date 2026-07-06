// Ohana viewer preload. Runs at document-start, but in an ISOLATED world — so
// wrapping window.fetch here would NOT affect the page. Instead we inject a
// <script> into the page's MAIN world (where the app's fetch/XHR live) so the
// per-endpoint "data states" actually intercept the app's API calls (like Hermes).
(function () {
  // This whole function is stringified and injected into the main world.
  function __ohanaShimMain() {
    if (window.__ohanaShim) return;
    window.__ohanaShim = true;
    try { window.__ohanaOverrides = JSON.parse(sessionStorage.getItem("__ohanaOverrides") || "[]"); }
    catch (e) { window.__ohanaOverrides = window.__ohanaOverrides || []; }

    function findOv(url) {
      var o = window.__ohanaOverrides || []; url = url || ""; var p = url;
      try { p = new URL(url, location.href).pathname; } catch (e) {}
      for (var i = 0; i < o.length; i++) { var m = o[i].match; if (m && (p.indexOf(m) !== -1 || url.indexOf(m) !== -1)) return o[i]; }
      return null;
    }
    function dupAny(d) {
      var N = 40, CAP = 500;
      function du(a) { var o = []; for (var i = 0; i < N && o.length < CAP; i++) { o = o.concat(a); } return o; }
      if (Array.isArray(d)) return d.length ? du(d) : d;
      if (d && typeof d === "object") { for (var k in d) { if (Array.isArray(d[k]) && d[k].length) { d[k] = du(d[k]); return d; } } }
      return d;
    }
    function rewrite(t, s) { if (s === "empty") return "[]"; if (s === "many") { try { return JSON.stringify(dupAny(JSON.parse(t))); } catch (e) { return t; } } return t; }

    var of = window.fetch;
    if (of) window.fetch = function (input, init) {
      var u = (typeof input === "string") ? input : ((input && input.url) || "");
      var ov = findOv(u); var s = ov ? ov.state : "normal";
      if (s === "normal") return of.apply(this, arguments);
      if (s === "loading") return new Promise(function () {});
      if (s === "custom") return Promise.resolve(new Response(ov.body != null ? ov.body : "{}", { status: ov.status || 200, headers: { "Content-Type": "application/json" } }));
      if (s === "empty") return Promise.resolve(new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
      if (s === "status") {
        var code = ov.status || 500;
        return of.apply(this, arguments).then(function (r) {
          return r.clone().text().then(function (t) { return new Response(t, { status: code, statusText: "", headers: r.headers }); })
            .catch(function () { return new Response("{}", { status: code, headers: { "Content-Type": "application/json" } }); });
        }).catch(function () { return new Response("{}", { status: code, headers: { "Content-Type": "application/json" } }); });
      }
      return of.apply(this, arguments).then(function (r) {
        return r.clone().text().then(function (t) { return new Response(rewrite(t, s), { status: r.status, statusText: r.statusText, headers: r.headers }); })
          .catch(function () { return r; });
      });
    };

    var OX = window.XMLHttpRequest;
    if (OX) {
      var op = OX.prototype.open, sn = OX.prototype.send, rt = Object.getOwnPropertyDescriptor(OX.prototype, "responseText");
      OX.prototype.open = function (m, u) { try { this.__ohanaUrl = u; } catch (e) {} return op.apply(this, arguments); };
      OX.prototype.send = function () {
        var ov = findOv(this.__ohanaUrl), s = ov ? ov.state : "normal", x = this, a = arguments;
        if (s === "normal") return sn.apply(this, a);
        if (s === "loading") return;
        if (s === "empty" || s === "custom") {
          var body = s === "custom" ? (ov.body != null ? ov.body : "{}") : "[]";
          var code = s === "custom" ? (ov.status || 200) : 200;
          setTimeout(function () {
            try { Object.defineProperty(x, "readyState", { configurable: true, value: 4 }); Object.defineProperty(x, "status", { configurable: true, value: code }); Object.defineProperty(x, "responseText", { configurable: true, value: body }); Object.defineProperty(x, "response", { configurable: true, value: body }); } catch (e) {}
            try { if (typeof x.onreadystatechange === "function") x.onreadystatechange(); } catch (e) {}
            try { x.dispatchEvent(new Event("readystatechange")); } catch (e) {}
            try { if (typeof x.onload === "function") x.onload(); } catch (e) {}
            try { x.dispatchEvent(new Event("load")); x.dispatchEvent(new Event("loadend")); } catch (e) {}
          }, 10);
          return;
        }
        if (s === "status") { var code2 = ov.status || 500; try { Object.defineProperty(x, "status", { configurable: true, get: function () { return code2; } }); } catch (e) {} return sn.apply(this, a); }
        if (s === "many") {
          try {
            Object.defineProperty(x, "responseText", { configurable: true, get: function () { var t = rt && rt.get ? rt.get.call(x) : ""; return rewrite(t, "many"); } });
            Object.defineProperty(x, "response", { configurable: true, get: function () { var t = rt && rt.get ? rt.get.call(x) : ""; return rewrite(t, "many"); } });
          } catch (e) {}
        }
        return sn.apply(this, a);
      };
    }
  }

  // main.js attaches this preload with contextIsolation:false (via
  // will-attach-webview), so we run in the page's MAIN world — wrapping fetch/XHR
  // here affects the app's own calls.
  try { __ohanaShimMain(); } catch (e) {}
})();
