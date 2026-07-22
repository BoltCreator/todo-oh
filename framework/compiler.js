'use strict';

/**
 * The client runtime. Serialized via .toString() and injected by compile().
 * Exposes window.App and wires declarative attributes.
 *
 * Reads / writes (per-instance, routed via basePath):
 *   App.get(query, params)      App.post(action, data)
 *   App.state()                 App.subscribe(cb, ms)
 *   [data-bind="path"]          [data-post="action"] [data-payload]   [data-get="query"]
 *
 * Composition (links + embedding other apps/instances, dynamic mode only):
 *   App.links(appName?)   -> link tree from the database (/api/links or /api/apps/:app/links)
 *   App.children()        -> children of THIS instance's app (basePath/__app/links)
 *   App.embed(target,url) -> render another app/instance in an <iframe>
 *   [data-links]            -> auto-fill a container with links to all apps + saved states
 *   [data-links="app"]      -> only that app's instances
 *   [data-links][data-embed-into="#sel"] -> clicking a link embeds it into #sel instead of navigating
 *
 * Auth links: any <a> to the login page without ?next= gets ?next=<current
 * page> appended at click time (wireLoginNext), so sign-in returns the user
 * to the page they were on — in every app, with no per-app code.
 *   [data-embed="/apps/x/y"] -> auto-embed that url as an iframe on load
 */
/**
 * If `href` points at the shared login page WITHOUT an explicit ?next=, return
 * the same href with ?next=<current page> appended (path-relative); otherwise
 * return null (leave the link alone). Pure and environment-free so it can be
 * unit-tested in Node; it is serialized into the injected runtime alongside
 * clientMain and used by wireLoginNext there.
 *
 * ctx: { origin: location.origin, loginPath: '<auth mount>/login',
 *        current: location.pathname + location.search }
 */
function loginNextHref(href, ctx) {
  try {
    var current = ctx.current || '/';
    var u = new URL(href, ctx.origin + current);
    if (u.origin !== ctx.origin) return null;            // cross-origin: not ours
    if (u.pathname !== ctx.loginPath) return null;       // not the login page
    if (u.searchParams.has('next')) return null;         // app passed its own
    if (current.indexOf(ctx.loginPath) === 0) return null; // already on the login page
    u.searchParams.set('next', current);
    return u.pathname + u.search + u.hash;
  } catch (e) {
    return null; // unparsable href (javascript:, malformed, …): leave alone
  }
}

function clientMain() {
  var CFG = window.__APP_CONFIG__ || {};
  var BASE = CFG.basePath || '';
  var GET_URL = BASE + (CFG.getPath || '/__app/get');
  var POST_URL = BASE + (CFG.postPath || '/__app/post');
  var STATE_URL = BASE + (CFG.statePath || '/__app/state');
  var CHILDREN_URL = BASE + (CFG.childrenPath || '/__app/links');

  // Record this page (per tab, top window only — preview iframes must not
  // clobber it) so the shared login page can bring the user back even when
  // it is reached with no ?next= at all: programmatic location.assign after
  // a logout, a stripped Referer header, hand-rolled app code — anything.
  // The login page falls back to this value (see auth.js loginPage), making
  // "return to where I was" work for every app without per-app code.
  try {
    if (window.top === window) sessionStorage.setItem('app:next', location.pathname + location.search);
  } catch (e) {}

  function call(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || data.ok === false) {
          throw new Error((data && data.error) || ('Request failed: ' + res.status));
        }
        return data.result;
      });
    });
  }

  var App = {
    get: function (query, params) { return call(GET_URL, { query: query, params: params || {} }); },
    post: function (action, data) { return call(POST_URL, { action: action, data: data || {} }); },
    state: function () {
      return fetch(STATE_URL).then(function (r) { return r.json(); }).then(function (d) { return d.result; });
    },
    subscribe: function (cb, interval) {
      var ms = interval || CFG.pollInterval || 1000;
      var stopped = false;
      function tick() {
        if (stopped) return;
        App.state().then(function (s) {
          if (stopped) return;
          applyBindings(s);
          if (typeof cb === 'function') { try { cb(s); } catch (e) { console.error(e); } }
        }).catch(function () {}).then(function () {
          if (!stopped) setTimeout(tick, ms);
        });
      }
      tick();
      return function () { stopped = true; };
    },

    // ---- composition: links + embedding -------------------------------
    /** Link tree from the database. No arg = all apps; appName = one app's instances. */
    links: function (appName) {
      if (!CFG.linksApi) return Promise.reject(new Error('links API not available'));
      var url = appName
        ? (CFG.appLinksApi || '/api/apps/{app}/links').replace('{app}', encodeURIComponent(appName))
        : CFG.linksApi;
      return fetch(url).then(function (r) { return r.json(); });
    },
    /** Children (saved + live instances) of THIS instance's app. */
    children: function () {
      return fetch(CHILDREN_URL).then(function (r) { return r.json(); }).then(function (d) { return d.children || []; });
    },
    /** Embed another app/instance url inside `target` (selector, element, or iframe). */
    embed: function (target, url) {
      var host = typeof target === 'string' ? document.querySelector(target) : target;
      if (!host) return null;
      var frame = host.tagName === 'IFRAME' ? host : host.querySelector('iframe');
      if (!frame) {
        frame = document.createElement('iframe');
        frame.style.width = '100%';
        frame.style.minHeight = '480px';
        frame.style.border = '0';
        host.appendChild(frame);
      }
      frame.src = url;
      return frame;
    },
    /** Download URL for this app with current state baked in (static|node|electron). */
    exportUrl: function (format) { return BASE + '/__app/export?format=' + encodeURIComponent(format || 'static'); },
    /** Force a save now; resolves to { saved, size, limit, error }. Rejected if over the size limit. */
    save: function () {
      return fetch(BASE + (CFG.savePath || '/__app/save'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (!d.ok) throw new Error(d.error || 'save failed'); return d.result; });
    },
    /** Last save status { ok, saved, size, limit, error } without forcing a save. */
    saveStatus: function () {
      return fetch(BASE + (CFG.healthPath || '/__app/health')).then(function (r) { return r.json(); }).then(function (d) { return d.save; });
    }
  };

  // ---- auth (shared session cookie => single sign-on across apps) -----
  var AUTH = CFG.authApi || '/auth';
  var _csrf = null;
  function authCsrf() {
    return fetch(AUTH + '/csrf', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); }).then(function (d) { _csrf = d.csrfToken; return _csrf; });
  }
  function authReq(path, opts) {
    opts = opts || {};
    var method = opts.method || 'GET';
    var headers = { Accept: 'application/json' };
    var pre = (method !== 'GET' && !_csrf) ? authCsrf() : Promise.resolve();
    return pre.then(function () {
      if (method !== 'GET') headers['X-CSRF-Token'] = _csrf;
      if (opts.body != null) headers['Content-Type'] = 'application/json';
      return fetch(AUTH + path, { method: method, headers: headers, credentials: 'same-origin', body: opts.body != null ? JSON.stringify(opts.body) : undefined });
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || data.ok === false) {
          var err = new Error((data && data.error) || ('Request failed (' + res.status + ').'));
          err.status = res.status; err.code = data && data.code; throw err;
        }
        return data;
      });
    });
  }
  function cacheUser(u) { try { if (u) sessionStorage.setItem('app:user', JSON.stringify(u)); else sessionStorage.removeItem('app:user'); } catch (e) {} }

  App.auth = {
    /** Current user + session, or null when signed out. */
    me: function () {
      return authReq('/me', {}).then(function (d) { cacheUser(d.user); return d; })
        .catch(function (e) { if (e.status === 401) { cacheUser(null); return null; } throw e; });
    },
    /** Boolean auth check (verified against the server via the cookie). */
    isLoggedIn: function () { return App.auth.me().then(function (d) { return !!(d && d.user); }).catch(function () { return false; }); },
    /** Last-known user from sessionStorage — synchronous UI hint only. */
    cachedUser: function () { try { return JSON.parse(sessionStorage.getItem('app:user') || 'null'); } catch (e) { return null; } },
    login: function (email, password, next) {
      return authReq('/login', { method: 'POST', body: { email: email, password: password, next: next } })
        .then(function (d) { _csrf = null; cacheUser(d.user); if (!next && d) d.redirect = location.pathname + location.search; return d; }, function (e) { _csrf = null; throw e; });
    },
    register: function (email, password, name, next) {
      return authReq('/register', { method: 'POST', body: { email: email, password: password, name: name, next: next } })
        .then(function (d) { _csrf = null; cacheUser(d.user); if (!next && d) d.redirect = location.pathname + location.search; return d; }, function (e) { _csrf = null; throw e; });
    },
    logout: function () {
      return authReq('/logout', { method: 'POST' })
        .then(function (d) { _csrf = null; cacheUser(null); return d; }, function (e) { _csrf = null; throw e; });
    },
    googleUrl: function (next) { return AUTH + '/google' + (next ? ('?next=' + encodeURIComponent(next)) : ''); },
    /** Client-side gate: redirect to the login page if not signed in. */
    require: function (next) {
      return App.auth.isLoggedIn().then(function (ok) {
        if (!ok) location.assign(AUTH + '/login?next=' + encodeURIComponent(next || (location.pathname + location.search)));
        return ok;
      });
    }
  };

  function wireAuth() {
    // Delegated at the document level so sign-out controls work no matter
    // WHEN they are rendered. Apps with soft auth gates build their auth UI
    // dynamically after checking me() — long after DOMContentLoaded — so a
    // one-time querySelectorAll would miss those [data-logout] elements
    // entirely and the click would silently do nothing.
    document.addEventListener('click', function (e) {
      var t = e.target;
      var el = t && t.closest ? t.closest('[data-logout]') : null;
      if (!el) return;
      e.preventDefault();
      var done = function () {
        // Stay where you are: just reload this page signed out. Apps that
        // don't REQUIRE auth keep the visitor right here — the Sign in
        // link is there whenever they want it (and carries ?next= back
        // automatically). Apps that DO require auth get bounced by the
        // server's HTML gate to the login page with this page as the
        // comeback address. The server is the single source of truth for
        // which is which — no client-side flag needed.
        location.reload();
      };
      App.auth.logout().then(done, done);
    });
    var us = document.querySelectorAll('[data-auth-user]');
    if (us.length) {
      App.auth.me().then(function (d) {
        var u = d && d.user;
        for (var j = 0; j < us.length; j++) {
          var field = us[j].getAttribute('data-auth-user');
          us[j].textContent = u ? (field && u[field] != null ? u[field] : (u.name || u.email)) : '';
        }
      }).catch(function () {});
    }
  }

  // ---- general login-link handling ------------------------------------
  // Every app gets this for free: any <a> that points at the shared login
  // page without an explicit ?next= has the CURRENT page appended at click
  // time, so signing in always returns the user exactly where they were —
  // on any app, any instance — without hand-building the link and without
  // relying on the Referer header (which browsers/privacy settings strip).
  // Links that already carry their own ?next= are respected. Click-time
  // rewriting (capture phase) also covers links rendered dynamically after
  // load; 'auxclick' covers middle-click "open in new tab".
  function wireLoginNext() {
    function fix(e) {
      var t = e.target;
      var a = t && t.closest ? t.closest('a[href]') : null;
      if (!a) return;
      var fixed = loginNextHref(a.getAttribute('href'), {
        origin: location.origin,
        loginPath: AUTH + '/login',
        current: location.pathname + location.search
      });
      if (fixed) a.setAttribute('href', fixed);
    }
    document.addEventListener('click', fix, true);
    document.addEventListener('auxclick', fix, true);
  }

  // ---- bindings -------------------------------------------------------
  function resolvePath(obj, path) {
    if (!path) return obj;
    return path.split('.').reduce(function (acc, k) { return acc == null ? undefined : acc[k]; }, obj);
  }
  function render(v) {
    if (v == null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  function applyBindings(state) {
    var nodes = document.querySelectorAll('[data-bind]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = render(resolvePath(state, nodes[i].getAttribute('data-bind')));
    }
  }

  function wireActions() {
    var posts = document.querySelectorAll('[data-post]');
    for (var i = 0; i < posts.length; i++) {
      (function (el) {
        el.addEventListener('click', function () {
          var payload = {};
          var raw = el.getAttribute('data-payload');
          if (raw) { try { payload = JSON.parse(raw); } catch (e) {} }
          App.post(el.getAttribute('data-post'), payload)
            .then(function (r) { applyBindings(r); })
            .catch(function (e) { console.error(e); });
        });
      })(posts[i]);
    }
    var gets = document.querySelectorAll('[data-get]');
    for (var j = 0; j < gets.length; j++) {
      (function (el) {
        App.get(el.getAttribute('data-get')).then(function (r) { el.textContent = render(r); }).catch(function () {});
      })(gets[j]);
    }
  }

  // ---- declarative links + embeds ------------------------------------
  function linkLabel(appName, child) {
    return appName + (child.id === 'default' ? '' : (' / ' + child.id));
  }
  function renderLinkList(container, groups) {
    var embedInto = container.getAttribute('data-embed-into');
    var ul = document.createElement('ul');
    ul.className = 'app-links';
    groups.forEach(function (g) {
      (g.children || []).forEach(function (child) {
        var li = document.createElement('li');
        var a = document.createElement('a');
        a.href = child.url;
        a.textContent = linkLabel(g.app, child);
        if (child.live) a.setAttribute('data-live', '1');
        if (embedInto) {
          a.addEventListener('click', function (e) { e.preventDefault(); App.embed(embedInto, child.url); });
        }
        li.appendChild(a);
        ul.appendChild(li);
      });
    });
    container.innerHTML = '';
    container.appendChild(ul);
  }
  function renderLinks() {
    if (!CFG.linksApi) return;
    var containers = document.querySelectorAll('[data-links]');
    for (var i = 0; i < containers.length; i++) {
      (function (c) {
        var appName = c.getAttribute('data-links'); // '' => all apps
        App.links(appName || undefined).then(function (data) {
          renderLinkList(c, data.apps ? data.apps : [data]);
        }).catch(function () {});
      })(containers[i]);
    }
  }
  function renderEmbeds() {
    var els = document.querySelectorAll('[data-embed]');
    for (var i = 0; i < els.length; i++) {
      var url = els[i].getAttribute('data-embed');
      if (url) App.embed(els[i], url);
    }
  }

  function init() {
    wireActions();
    wireAuth();
    wireLoginNext();
    renderLinks();
    renderEmbeds();
    if (CFG.autoSubscribe !== false && document.querySelector('[data-bind]')) {
      App.subscribe(null);
    }
    window.dispatchEvent(new Event('app:ready'));
  }

  window.App = App;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}

function buildRuntime(config) {
  return 'window.__APP_CONFIG__=' + JSON.stringify(config || {}) + ';\n' +
    loginNextHref.toString() + '\n(' + clientMain.toString() + ')();';
}

function compile(html, config) {
  var script = '\n<script data-app-runtime>\n' + buildRuntime(config) + '\n</script>\n';
  // Inject before the LAST closing tag: a page's own scripts may legitimately
  // contain the literal text "</body>" (a template string, a comment about the
  // page structure, …), and matching the FIRST occurrence would split that
  // script in half and spill the rest of it into the document as markup.
  var insertBeforeLast = function (tag) {
    var idx = html.toLowerCase().lastIndexOf(tag);
    if (idx === -1) return null;
    return html.slice(0, idx) + script + html.slice(idx);
  };
  return insertBeforeLast('</body>') || insertBeforeLast('</html>') || (html + script);
}

module.exports = { compile, buildRuntime, loginNextHref };
