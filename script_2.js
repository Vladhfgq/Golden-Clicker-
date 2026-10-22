/**
 * =========================================
 * LOCALIZATION BRIDGE (t / tp / getLanguage / TRANSLATIONS)
 * =========================================
 * script_2.js calls the localization helpers t(), tp() and getLanguage() as bare globals and reads TRANSLATIONS.
 * They are normally provided by i18n.js, which index.html loads BEFORE this file. If i18n.js is missing, failed to
 * load, or exposes its API only under window.i18n, those names were undeclared and the first call threw
 * "ReferenceError: t is not defined" (breaking save loading, tabs and currency rendering).
 *
 * This bridge runs first and, for each helper, keeps the real one when it exists, otherwise adapts window.i18n,
 * otherwise installs a minimal English fallback (text taken from the data-i18n attributes already in index.html;
 * unknown keys return the key itself). A warning is logged whenever a fallback is used so the cause stays visible.
 * It never overrides a working i18n.js.
 */
(function installLocalizationBridge() {
    'use strict';
    const g = window;
    const i18n = (g.i18n && typeof g.i18n === 'object') ? g.i18n : null;
    const used = [];

    // English text for static keys, harvested from the markup (read once, before any translation pass).
    let domEnglish = null;
    function getDomEnglish() {
        if (domEnglish) return domEnglish;
        domEnglish = {};
        try {
            document.querySelectorAll('[data-i18n]').forEach(function (el) {
                const k = el.getAttribute('data-i18n');
                if (k && !(k in domEnglish)) domEnglish[k] = el.textContent.trim();
            });
        } catch (e) { console.warn('[i18n bridge] could not read data-i18n defaults:', e); }
        return domEnglish;
    }

    function interpolate(str, params) {
        if (!params || typeof params !== 'object') return str;
        return str.replace(/\{\{\s*(\w+)\s*\}\}|\{(\w+)\}/g, function (m, a, b) {
            const key = a || b;
            return Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : m;
        });
    }

    if (!g.TRANSLATIONS || typeof g.TRANSLATIONS !== 'object') {
        g.TRANSLATIONS = { en: {} };
        used.push('TRANSLATIONS');
    } else if (!g.TRANSLATIONS.en) {
        g.TRANSLATIONS.en = {};
    }

    if (typeof g.t !== 'function') {
        if (i18n && typeof i18n.t === 'function') {
            g.t = function (key, params) { return i18n.t(key, params); };
        } else {
            used.push('t');
            g.t = function (key, params) {
                const en = g.TRANSLATIONS.en || {};
                const base = (key in en) ? en[key] : getDomEnglish()[key];
                return (typeof base === 'string' && base) ? interpolate(base, params) : String(key);
            };
        }
    }

    if (typeof g.tp !== 'function') {
        if (i18n && typeof i18n.tp === 'function') {
            g.tp = function (key, count, params) { return i18n.tp(key, count, params); };
        } else {
            used.push('tp');
            g.tp = function (key, count, params) {
                const p = Object.assign({ n: count, count: count }, params || {});
                const suffix = (Number(count) === 1) ? '_one' : '_other';
                const en = g.TRANSLATIONS.en || {};
                if ((key + suffix) in en) return g.t(key + suffix, p);
                return g.t(key, p);
            };
        }
    }

    if (typeof g.getLanguage !== 'function') {
        if (i18n && typeof i18n.getLanguage === 'function') {
            g.getLanguage = function () { return i18n.getLanguage(); };
        } else {
            used.push('getLanguage');
            g.getLanguage = function () {
                try { return (g.localStorage && g.localStorage.getItem('gci_lang')) || 'en'; } catch (e) { return 'en'; }
            };
        }
    }

    if (used.length) {
        console.warn('[i18n bridge] i18n.js did not provide: ' + used.join(', ') +
            ' - using English fallbacks. Check that i18n.js loads (index.html) and exposes t/tp/getLanguage/TRANSLATIONS.');
    }
})();

/**
 * =========================================
 * SAFE STORAGE LAYER (GCStore)
 * =========================================
 * Every localStorage access in this file goes through here. It never throws:
 *   - availability is probed once (real write/read/remove) and re-probed after a failure,
 *   - SecurityError / private mode / disabled storage / quota errors are swallowed and reported as `false`/`null`,
 *   - when storage is unusable the game keeps running from an in-memory copy (progress just cannot persist),
 *   - on a quota error one retry is made after dropping the disposable backup/quarantine keys.
 * The save format and key names are unchanged, so existing saves load exactly as before.
 */
window.GCStore = window.GCStore || (function () {
    'use strict';
    const memory = {};            // in-memory fallback (also mirrors the last successful writes)
    let usable = null;            // null = not probed yet
    let lastError = '';
    const DISPOSABLE = ['goldClickerSave_backup', 'goldClickerSave_corrupt'];

    function raw() {
        try { return window.localStorage || null; } catch (e) { lastError = String(e && e.name || e); return null; }   // SecurityError
    }

    function probe() {
        const ls = raw();
        if (!ls) return false;
        try {
            const k = '__gc_probe__';
            ls.setItem(k, '1');
            const ok = ls.getItem(k) === '1';
            ls.removeItem(k);
            return ok;
        } catch (e) { lastError = String(e && e.name || e); return false; }
    }

    function isAvailable() {
        if (usable === null) usable = probe();
        return usable;
    }

    function getItem(key) {
        if (isAvailable()) {
            try { return raw().getItem(key); } catch (e) { lastError = String(e && e.name || e); usable = null; }
        }
        return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
    }

    function setItem(key, value) {
        const str = String(value);
        memory[key] = str;
        if (!isAvailable()) return false;
        try { raw().setItem(key, str); return true; } catch (e) {
            lastError = String(e && e.name || e);
            const quota = e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
            if (quota) {
                try {
                    DISPOSABLE.forEach((k) => { if (k !== key) raw().removeItem(k); });
                    raw().setItem(key, str);
                    return true;
                } catch (e2) { lastError = String(e2 && e2.name || e2); }
            } else {
                usable = null;   // re-probe next time (storage may have become unavailable)
            }
            return false;
        }
    }

    function removeItem(key) {
        delete memory[key];
        if (!isAvailable()) return false;
        try { raw().removeItem(key); return true; } catch (e) { lastError = String(e && e.name || e); return false; }
    }

    /** Parses a JSON object stored under `key`. Returns null when absent, unreadable or not a plain object. */
    function getJSON(key) {
        const str = getItem(key);
        if (str === null || str === undefined || str === '') return null;
        try {
            const o = JSON.parse(str);
            return (o && typeof o === 'object' && !Array.isArray(o)) ? o : null;
        } catch (e) { return null; }
    }

    return { isAvailable: isAvailable, getItem: getItem, setItem: setItem, removeItem: removeItem, getJSON: getJSON,
             getLastError: function () { return lastError; } };
})();

/**
 * =========================================
 * PERFORMANCE: FRAME BATCHER + ELEMENT POOLS
 * =========================================
 * Presentation-only helpers (no game logic):
 *   GCFrame.queue(prepare, start)  Runs every queued `prepare` (style resets), performs ONE forced
 *                                  reflow for the whole frame, then runs every `start` (re-adds
 *                                  animation classes). N animation restarts per frame cost one reflow
 *                                  instead of N. Returns false (and does nothing) while the tab is hidden.
 *   GCFrame.restartClass(el, cls)  Restarts a CSS animation driven by a class.
 *   GCFrame.createPool(opts)       Reusable absolutely-positioned text popups (floating "+X" numbers,
 *                                  boss hit numbers). Elements are recycled instead of being created /
 *                                  removed per hit, and the total number alive is hard-capped.
 */
window.GCFrame = (function () {
    const prepQ = [];
    const startQ = [];
    let raf = 0;

    function flush() {
        raf = 0;
        const preps = prepQ.splice(0);
        const starts = startQ.splice(0);
        for (let i = 0; i < preps.length; i++) preps[i]();
        if (starts.length) void document.body.offsetWidth; // the single forced reflow for this frame
        for (let i = 0; i < starts.length; i++) starts[i]();
    }

    function queue(prepare, start) {
        if (document.hidden) return false; // nobody can see it; also keeps queues from growing in background tabs
        if (prepare) prepQ.push(prepare);
        if (start) startQ.push(start);
        if (!raf) raf = requestAnimationFrame(flush);
        return true;
    }

    function restartClass(el, cls) {
        if (!el) return false;
        return queue(() => el.classList.remove(cls), () => el.classList.add(cls));
    }

    function createPool(opts) {
        const max = opts.max || 40;
        const life = opts.lifeMs || 900;
        const idle = [];
        const active = []; // oldest first; expiry times are monotonic
        let timer = 0;

        function sweep() {
            timer = 0;
            const now = performance.now();
            while (active.length && active[0].__gcExpire <= now) {
                const el = active.shift();
                el.style.display = 'none';
                idle.push(el);
            }
            if (active.length) timer = setTimeout(sweep, Math.max(16, active[0].__gcExpire - now + 5));
        }

        function show(cfg) {
            if (document.hidden) return;
            let el = idle.pop();
            if (!el) {
                if (active.length >= max) {
                    el = active.shift(); // recycle the oldest popup instead of growing the DOM
                } else {
                    el = document.createElement('div');
                    el.style.display = 'none';
                    el.setAttribute('aria-hidden', 'true');
                    document.body.appendChild(el);
                }
            }
            el.__gcExpire = performance.now() + life;
            active.push(el);
            queue(() => {
                el.style.animation = 'none';
                el.className = cfg.className;
                el.textContent = cfg.text;
                el.style.left = cfg.left;
                el.style.top = cfg.top;
                el.style.color = cfg.color || '';
                el.style.display = '';
            }, () => {
                el.style.animation = ''; // restarts the CSS animation
            });
            if (!timer) timer = setTimeout(sweep, life + 5);
        }

        return { show };
    }

    return { queue, restartClass, createPool };
})();

/**
 * =========================================
 * ANTI-TIME-CHEAT: TRUSTED CLOCK  (GCTime)
 * =========================================
 * One centralized time-validation layer. Every time-dependent system in the game reads time from
 * here instead of the raw OS clock.
 *
 *   GCTime.now()       Trusted real-world time (ms epoch). Computed as
 *                        anchor.wall + (performance.now() - anchor.perf)
 *                      so changing the OS clock while the game is open has NO effect on it. The anchor is
 *                      set from a verified server time when available (see sync()), otherwise from the
 *                      local clock under strict validation (see resolveOfflineGap()).
 *                      Use for: persistent timestamps (saves, buff/VIP expiry, cooldowns, daily resets).
 *   GCTime.mono()      performance.now(). Monotonic. Use for: pure elapsed time inside the open page
 *                      (tick deltas, "last action" recency, animation-ish timers). Never persist it.
 *   GCTime.sync()      Fire-and-forget server-time verification (cached, rate-limited, backoff on failure).
 *   GCTime.settled()   Promise that resolves once the startup verification finished OR its deadline hit.
 *   GCTime.resolveOfflineGap(lastSave)
 *                      The single place that turns "last saved stamp" into "seconds the player was away".
 *                      Handles rollback, huge forward jumps, unverified (offline) mode and stale stamps.
 *
 * Verified mode   (server time reachable): the server decides. Local clock skew > tolerance is logged and ignored.
 * Unverified mode (API unreachable):        the local clock is never trusted blindly. Stamps can never move
 *                      backwards, each calculation is capped (unverifiedMaxGapSeconds) and ALL unverified
 *                      credit draws from a pool that only refills with real active play time or the next
 *                      successful server verification.
 *
 * Honest limits: this is a client-side game. A determined attacker who edits localStorage / patches the JS
 * or intercepts the Time API requests can still cheat. The goal is to make ordinary system-clock
 * manipulation useless without needing a backend.
 */
window.GCTime = window.GCTime || (function () {
    'use strict';

    /* ---------------- tunables ---------------- */
    const CFG = {
        toleranceMs: 2 * 60 * 1000,          // local-vs-server (and drift) tolerance: +-2 minutes
        syncTtlMs: 10 * 60 * 1000,           // a successful verification stays "fresh" this long (no re-request)
        retryBaseMs: 60 * 1000,              // after a failed attempt: wait 1 min, then 2, 4 ... (capped below)
        retryMaxMs: 15 * 60 * 1000,
        requestTimeoutMs: 2500,              // per provider
        startupDeadlineMs: 4500,             // offline calculation waits at most this long for the server
        unverifiedMaxGapSeconds: 4 * 3600,   // max offline gap credited per calculation when time is unverified
        unverifiedPoolSeconds: 12 * 3600,    // total unverified credit available before a server check is needed
        poolRefillPerActiveSecond: 1,        // pool regains this much per second of REAL active play
        reanchorThresholdMs: 2000,           // ignore sub-2s server corrections (avoids timer jitter)
        watchIntervalMs: 5000,               // cheap local drift check (no network)
        resumeMinHiddenMs: 30 * 1000,        // re-verify (TTL permitting) after the tab was hidden this long
        clockJumpResyncMinMs: 30 * 1000,     // min gap between forced re-verifications after a detected jump
        onlineRetryMinMs: 10 * 1000,
        maxAnomalies: 20,
        minPlausibleMs: Date.UTC(2024, 0, 1),
        maxPlausibleMs: Date.UTC(2100, 0, 1),
        patchDateNow: true,                  // make Date.now() return trusted time too (covers adventures.js / bosses.js)
        storageKey: 'goldClickerTimeGuard',
        providers: [
            { name: 'worldtimeapi', url: 'https://worldtimeapi.org/api/timezone/Etc/UTC', parse: parseWorldTimeApi },
            { name: 'timeapi.io', url: 'https://timeapi.io/api/time/current/zone?timeZone=UTC', parse: parseTimeApiIo },
            { name: 'same-origin', sameOrigin: true }   // HTTP Date header of the page's own server (http/https only)
        ]
    };

    /* ---------------- raw clocks ---------------- */
    const realNow = Date.now.bind(Date); // the untouched OS clock (captured BEFORE Date.now may be patched below)
    const perf = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? () => performance.now()
        : (function () { const b = realNow(); return () => realNow() - b; })();

    /* ---------------- state ---------------- */
    let anchor = { wall: realNow(), perf: perf() };   // trusted wall time at a given perf instant
    let verified = false;          // a server time was obtained this session
    let baselineSet = false;       // resolveOfflineGap() has run (hw may now be corrected downwards by a server time)
    let restored = false;
    let lastSyncPerf = -Infinity;
    let nextAttemptPerf = 0;
    let lastAttemptPerf = -Infinity;
    let failCount = 0;
    let lastError = '';
    let inflight = null;
    let startupPromise = null;
    let localSkewMs = 0;
    let loggedSkewMs = 0;
    let poolPerf = perf();
    let watching = false;
    let lastD = 0;
    let lastP = 0;
    let hiddenAtPerf = 0;
    const syncListeners = [];

    // Persistent guard record (saved in its own localStorage key AND inside the main save blob).
    const guard = {
        hw: 0,                                   // high-water mark: highest trusted time ever stamped
        pool: CFG.unverifiedPoolSeconds,         // remaining unverified offline credit (seconds)
        va: 0,                                   // trusted time of the last server verification
        n: 0,                                    // lifetime anomaly counter
        an: []                                   // recent anomalies [{t, k, d}]
    };

    /* ---------------- helpers ---------------- */
    function cleanTs(v) {
        const n = Number(v);
        return (Number.isFinite(n) && n > 0 && n <= 8.64e15) ? n : 0;
    }

    function plausible(ms) {
        return Number.isFinite(ms) && ms >= CFG.minPlausibleMs && ms <= CFG.maxPlausibleMs;
    }

    function now() {
        return Math.floor(anchor.wall + (perf() - anchor.perf));
    }

    function noteAnomaly(kind, detail) {
        guard.n = (guard.n || 0) + 1;
        guard.an.push({ t: now(), k: String(kind), d: detail || null });
        if (guard.an.length > CFG.maxAnomalies) guard.an.splice(0, guard.an.length - CFG.maxAnomalies);
        try { console.warn('[GCTime] time anomaly:', kind, detail || ''); } catch (e) { /* ignore */ }
    }

    let activeTimePaused = false;   // true while the game is paused (ads etc.): paused time is NOT active play time
    function refillPool() {
        if (activeTimePaused) { poolPerf = perf(); return; }
        const t = perf();
        const add = Math.max(0, (t - poolPerf) / 1000) * CFG.poolRefillPerActiveSecond;
        poolPerf = t;
        guard.pool = Math.min(CFG.unverifiedPoolSeconds, Math.max(0, guard.pool) + add);
    }

    /* ---------------- response parsing ---------------- */
    function parseIsoUtc(s) {
        if (typeof s !== 'string') return NaN;
        let t = s.trim();
        t = t.replace(/(\.\d{3})\d+/, '$1');                    // keep millisecond precision only
        if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(t)) t += 'Z';        // timeapi.io UTC strings carry no zone designator
        return Date.parse(t);
    }

    function parseWorldTimeApi(j) {
        if (!j || typeof j !== 'object') return NaN;
        if (typeof j.unixtime === 'number') return j.unixtime * 1000 + 500;   // whole seconds -> mid-second
        return parseIsoUtc(j.utc_datetime);
    }

    function parseTimeApiIo(j) {
        if (!j || typeof j !== 'object') return NaN;
        return parseIsoUtc(j.dateTime || j.currentDateTime);
    }

    /* ---------------- network ---------------- */
    function fetchWithTimeout(url, opts, ms) {
        if (typeof fetch !== 'function') return Promise.reject(new Error('no-fetch'));
        const ctl = (typeof AbortController === 'function') ? new AbortController() : null;
        let timer = 0;
        const killer = new Promise((_, reject) => {
            timer = setTimeout(() => {
                if (ctl) { try { ctl.abort(); } catch (e) { /* ignore */ } }
                reject(new Error('timeout'));
            }, ms);
        });
        const req = fetch(url, Object.assign({}, opts, ctl ? { signal: ctl.signal } : {}));
        return Promise.race([req, killer]).then(
            (v) => { clearTimeout(timer); return v; },
            (e) => { clearTimeout(timer); throw e; }
        );
    }

    function canUseSameOrigin() {
        try {
            const p = location.protocol;
            if (p !== 'http:' && p !== 'https:') return false;
            const h = location.hostname;
            // A local dev server / wrapper reports the DEVICE clock in its Date header: useless as a reference.
            if (!h || h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || /\.local$/i.test(h)) return false;
            return true;
        } catch (e) { return false; }
    }

    /** Asks one provider. Resolves { wall, perfAt }: true time `wall` at perf instant `perfAt` (round-trip centred). */
    function queryProvider(p) {
        let url;
        let opts;
        if (p.sameOrigin) {
            if (!canUseSameOrigin()) return Promise.reject(new Error('same-origin-unavailable'));
            url = location.href.split('#')[0].split('?')[0] + '?gc_t=' + realNow();
            opts = { method: 'HEAD', cache: 'no-store', credentials: 'omit' };
        } else {
            url = p.url;
            opts = { method: 'GET', cache: 'no-store', credentials: 'omit', mode: 'cors' };
        }
        const t0 = perf();
        return fetchWithTimeout(url, opts, CFG.requestTimeoutMs).then((res) => {
            const tResp = perf();
            if (p.sameOrigin) {
                const d = Date.parse(res.headers.get('date') || '');
                const age = Number(res.headers.get('age')) || 0;       // a cache in front adds its age
                return { serverMs: d + age * 1000 + 500, t0, tResp };   // Date header has 1 s resolution
            }
            if (!res.ok) throw new Error('http-' + res.status);
            return res.json().then((j) => ({ serverMs: p.parse(j), t0, tResp }));
        }).then((r) => {
            if (!plausible(r.serverMs)) throw new Error('implausible-time');
            const rtt = r.tResp - r.t0;
            if (!(rtt >= 0) || rtt > CFG.requestTimeoutMs * 2) throw new Error('bad-rtt');
            return { wall: r.serverMs, perfAt: (r.t0 + r.tResp) / 2 };
        });
    }

    function runProviders() {
        let i = 0;
        const errors = [];
        const next = () => {
            if (i >= CFG.providers.length) return Promise.reject(new Error(errors.join(' | ') || 'no-provider'));
            const p = CFG.providers[i++];
            return queryProvider(p).catch((e) => {
                errors.push(p.name + ':' + (e && e.message ? e.message : 'error'));
                return next();
            });
        };
        return next();
    }

    function applyServerTime(wall, perfAt) {
        const cur = anchor.wall + (perfAt - anchor.perf);
        if (!verified || Math.abs(wall - cur) >= CFG.reanchorThresholdMs) anchor = { wall: wall, perf: perfAt };
        verified = true;
        lastSyncPerf = perfAt;
        failCount = 0;
        guard.va = Math.floor(wall);

        localSkewMs = realNow() - now();
        if (Math.abs(localSkewMs) > CFG.toleranceMs && Math.abs(localSkewMs - loggedSkewMs) > 60 * 1000) {
            loggedSkewMs = localSkewMs;
            noteAnomaly('local-clock-skew', { skewSec: Math.round(localSkewMs / 1000) });
        } else if (Math.abs(localSkewMs) <= CFG.toleranceMs) {
            loggedSkewMs = 0;
        }
        if (baselineSet) {                 // late / repeated verification: the server is authoritative
            guard.hw = now();
            guard.pool = CFG.unverifiedPoolSeconds;
        }
        syncListeners.slice().forEach((cb) => { try { cb(); } catch (e) { /* ignore */ } });
    }

    /**
     * Verifies against the external Time API. Cached: a fresh successful result is reused for syncTtlMs and
     * failures back off exponentially, so this can never turn into per-tick / per-click traffic.
     * @param {boolean} [force] bypass the cache + backoff (startup and detected clock jumps only)
     * @returns {Promise<boolean>} true if the session has verified server time
     */
    function sync(force) {
        if (inflight) return inflight;
        const t = perf();
        if (!force) {
            if (verified && (t - lastSyncPerf) < CFG.syncTtlMs) return Promise.resolve(true);
            if (t < nextAttemptPerf) return Promise.resolve(verified);
        }
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            lastError = 'navigator-offline';
            return Promise.resolve(verified);
        }
        lastAttemptPerf = t;
        inflight = runProviders().then((r) => {
            applyServerTime(r.wall, r.perfAt);
            return true;
        }).catch((err) => {
            failCount++;
            lastError = String(err && err.message ? err.message : err);
            nextAttemptPerf = perf() + Math.min(CFG.retryMaxMs, CFG.retryBaseMs * Math.pow(2, failCount - 1));
            return verified;
        }).then((v) => {
            inflight = null;
            return v;
        });
        return inflight;
    }

    /** Resolves when startup verification finished (true/false) or the deadline passed - whichever is first. */
    function settled(maxWaitMs) {
        const wait = (typeof maxWaitMs === 'number') ? maxWaitMs : CFG.startupDeadlineMs;
        const base = (startupPromise || Promise.resolve(false)).then((v) => v, () => false);
        return Promise.race([base, new Promise((resolve) => setTimeout(() => resolve(false), wait))]);
    }

    /* ---------------- offline gap ---------------- */
    /**
     * Turns the stored "last saved" timestamp into the number of seconds the player may be credited for.
     * Call once per page load, after settled(). Also establishes the session baseline (anchor + high-water).
     * @returns {{seconds:number, rawSeconds:number, verified:boolean, suspicious:boolean, reasons:string[]}}
     */
    function resolveOfflineGap(lastSave) {
        refillPool();
        const tolS = CFG.toleranceMs / 1000;
        const ref = Math.max(cleanTs(lastSave), cleanTs(guard.hw));   // never earlier than anything we ever stamped
        const res = { seconds: 0, rawSeconds: 0, verified: verified, suspicious: false, reasons: [] };

        if (verified) {
            const trueNow = now();                                     // anchor already holds the server time
            if (ref > 0) {
                const diff = (trueNow - ref) / 1000;
                res.rawSeconds = diff;
                if (diff < -tolS) {
                    // Stamps are in the FUTURE of real time: the clock was set forward earlier. No reward; stamps get corrected.
                    res.suspicious = true;
                    res.reasons.push('stamp-in-future');
                    noteAnomaly('stamp-in-future', { aheadSec: Math.round(-diff) });
                } else if (diff > 0) {
                    res.seconds = diff;
                }
            }
            guard.hw = trueNow;
            guard.pool = CFG.unverifiedPoolSeconds;
        } else {
            const local = realNow();
            if (!(ref > 0)) {
                anchor = { wall: local, perf: perf() };                // first run / save without any stamp: nothing to protect yet
            } else {
                const rawMs = local - ref;
                let advanceMs = 0;
                res.rawSeconds = rawMs / 1000;
                if (rawMs < 0) {
                    // Clock moved backwards (or stamps are ahead of it): grant nothing and NEVER move trusted time back.
                    if (-rawMs > CFG.toleranceMs) {
                        res.suspicious = true;
                        res.reasons.push('clock-rollback');
                        noteAnomaly('clock-rollback', { behindSec: Math.round(-rawMs / 1000) });
                    }
                } else {
                    const rawS = rawMs / 1000;
                    const allowance = Math.max(0, Math.min(CFG.unverifiedMaxGapSeconds, guard.pool));
                    const credited = Math.min(rawS, allowance);
                    if (rawS > CFG.unverifiedMaxGapSeconds) {
                        res.suspicious = true;
                        res.reasons.push('large-forward-jump-unverified');
                        noteAnomaly('large-forward-jump-unverified', { gapSec: Math.round(rawS), creditedSec: Math.round(credited) });
                    } else if (credited < rawS) {
                        res.reasons.push('unverified-pool-exhausted');
                        noteAnomaly('unverified-pool-exhausted', { gapSec: Math.round(rawS), creditedSec: Math.round(credited) });
                    }
                    res.seconds = credited;
                    guard.pool = Math.max(0, guard.pool - credited);
                    advanceMs = credited * 1000;        // trusted time only advances by what was actually credited
                }
                anchor = { wall: ref + advanceMs, perf: perf() };
            }
            guard.hw = Math.max(cleanTs(guard.hw), now());
        }
        baselineSet = true;
        return res;
    }

    /* ---------------- persistence ---------------- */
    function checksum(o) {
        const s = [o.v, Math.floor(o.hw || 0), Math.floor(o.pool || 0), Math.floor(o.va || 0), o.n || 0].join('|') + '|gc-time-guard';
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h.toString(16);
    }

    function exportState() {
        const o = {
            v: 1,
            hw: Math.floor(cleanTs(guard.hw)),
            pool: Math.floor(Math.max(0, guard.pool)),
            va: Math.floor(cleanTs(guard.va)),
            n: guard.n || 0,
            an: guard.an.slice(-CFG.maxAnomalies)
        };
        o.c = checksum(o);
        return o;
    }

    function persist() {
        try { GCStore.setItem(CFG.storageKey, JSON.stringify(exportState())); } catch (e) { /* storage full / blocked */ }
    }

    /** Returns null (absent), {bad:true} (present but corrupt / edited) or the validated record. */
    function readRecord(raw) {
        if (raw === null || raw === undefined || raw === '') return null;
        let o = raw;
        if (typeof raw === 'string') {
            try { o = JSON.parse(raw); } catch (e) { return { bad: true }; }
        }
        if (!o || typeof o !== 'object' || Array.isArray(o)) return { bad: true };
        if (o.v !== 1 || o.c !== checksum(o)) return { bad: true };
        if (!Number.isFinite(o.hw) || !Number.isFinite(o.pool) || o.hw < 0 || o.pool < 0) return { bad: true };
        return o;
    }

    /**
     * Loads the guard record(s) and sets a CONSERVATIVE provisional clock (so nothing reads a manipulated
     * time while the server check is still running), then starts the startup verification.
     * Must run before any time-dependent load logic; loadGame() calls it first. Idempotent.
     */
    function restore(parsedSave) {
        if (restored) return;
        restored = true;

        const candidates = [];
        let anyBad = false;
        try {
            const r = readRecord(GCStore.getItem(CFG.storageKey));
            if (r && r.bad) anyBad = true; else if (r) candidates.push(r);
        } catch (e) { /* storage unavailable */ }
        if (parsedSave && parsedSave.timeGuard !== undefined) {
            const r = readRecord(parsedSave.timeGuard);
            if (r && r.bad) anyBad = true; else if (r) candidates.push(r);
        }

        if (candidates.length) {
            // Two redundant copies: always take the stricter value, so wiping/editing ONE copy gains nothing.
            guard.hw = Math.max.apply(null, candidates.map((c) => c.hw));
            guard.pool = Math.min.apply(null, candidates.map((c) => c.pool));
            guard.va = Math.max.apply(null, candidates.map((c) => c.va || 0));
            const richest = candidates.reduce((a, b) => ((b.n || 0) > (a.n || 0) ? b : a));
            guard.n = richest.n || 0;
            guard.an = Array.isArray(richest.an) ? richest.an.slice(-CFG.maxAnomalies) : [];
        } else {
            guard.pool = CFG.unverifiedPoolSeconds;      // existing saves from before the anti-cheat: start clean, nothing wiped
        }

        // Provisional trusted time: never before any stamp we know, and never more than one unverified-cap ahead of it.
        let ref = cleanTs(guard.hw);
        if (parsedSave) {
            ref = Math.max(ref, cleanTs(parsedSave.lastSaveTime), cleanTs(parsedSave.lastOnlineTime), cleanTs(parsedSave.lastSaved));
        }
        const local = realNow();
        let wall;
        if (!(ref > 0)) wall = local;
        else if (local < ref) wall = ref;
        else wall = Math.min(local, ref + CFG.unverifiedMaxGapSeconds * 1000);
        anchor = { wall: wall, perf: perf() };
        poolPerf = perf();

        if (anyBad) {
            guard.pool = 0;                               // tampered guard data: no unverified credit until the server confirms the time
            noteAnomaly('guard-data-tampered', null);
        }

        startWatchers();
        startupPromise = sync(true);
    }

    /**
     * Called by saveGame(). Returns the trusted timestamp to persist. While the startup offline calculation
     * is still pending (`locked`) the high-water mark is left alone so the unpaid gap cannot shrink.
     */
    function beforeSave(locked) {
        refillPool();
        const t = now();
        if (!locked) guard.hw = Math.max(cleanTs(guard.hw), t);
        persist();
        return t;
    }

    /* ---------------- runtime clock watchers (no network unless a jump is detected) ---------------- */
    function checkClockJump(afterResume) {
        const d = realNow();
        const p = perf();
        const drift = (d - lastD) - (p - lastP);       // 0 when the OS clock and the monotonic clock agree
        lastD = d;
        lastP = p;
        if (Math.abs(drift) <= CFG.toleranceMs) return;
        const kind = drift < 0 ? 'clock-set-back-while-running' : (afterResume ? 'clock-forward-or-device-sleep' : 'clock-set-forward-while-running');
        noteAnomaly(kind, { driftSec: Math.round(drift / 1000) });
        // now() ignores the OS clock, so nothing was gained. Re-verify (rate-limited) so a legit device sleep gets corrected.
        if (perf() - lastAttemptPerf >= CFG.clockJumpResyncMinMs) sync(true);
    }

    function startWatchers() {
        if (watching) return;
        watching = true;
        lastD = realNow();
        lastP = perf();
        try {
            setInterval(() => checkClockJump(false), CFG.watchIntervalMs);
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) { hiddenAtPerf = perf(); return; }
                const hiddenFor = hiddenAtPerf ? perf() - hiddenAtPerf : 0;
                hiddenAtPerf = 0;
                checkClockJump(true);
                if (hiddenFor >= CFG.resumeMinHiddenMs) sync(false);   // TTL + backoff still apply
            });
            window.addEventListener('online', () => {
                const t = perf();
                const stale = !verified || (t - lastSyncPerf) >= CFG.syncTtlMs;
                if (stale && (t - lastAttemptPerf) >= CFG.onlineRetryMinMs) sync(true);
            });
        } catch (e) { /* non-browser environment */ }
    }

    /* ---------------- public API ---------------- */
    const api = {
        now: now,
        mono: perf,
        sync: sync,
        settled: settled,
        restore: restore,
        resolveOfflineGap: resolveOfflineGap,
        beforeSave: beforeSave,
        exportState: exportState,
        noteAnomaly: noteAnomaly,
        pauseActiveTime: function () { if (activeTimePaused) return; refillPool(); activeTimePaused = true; },
        resumeActiveTime: function () { if (!activeTimePaused) return; activeTimePaused = false; poolPerf = perf(); },
        onSync: function (cb) { if (typeof cb === 'function') syncListeners.push(cb); },
        isVerified: function () { return verified; },
        getAnomalies: function () { return guard.an.slice(); },
        getStatus: function () {
            return {
                verified: verified,
                trustedNow: now(),
                localMinusTrustedMs: realNow() - now(),
                lastVerifiedAgoMs: verified ? Math.round(perf() - lastSyncPerf) : null,
                unverifiedPoolSeconds: Math.floor(guard.pool),
                failCount: failCount,
                lastError: lastError,
                anomalies: guard.n
            };
        },
        config: CFG
    };

    // Optional: make Date.now() return the trusted clock too, so modules not shipped with this file
    // (adventures.js, bosses.js, ...) automatically get monotonic, clock-change-proof timestamps.
    if (CFG.patchDateNow && !Date.now.__gcPatched) {
        const patched = function () { return now(); };
        patched.__gcPatched = true;
        Date.now = patched;
    }

    return api;
})();

/**
 * =========================================
 * GAME STATE
 * =========================================
 * Central object holding all mutable game data.
 * Kept in one place to simplify saving/loading later.
 *
 * Upgrade "type" field determines how it affects gameplay:
 *   - "flatCps"      : adds a flat coins-per-second value (per unit owned)
 *   - "percentCps"   : multiplies total CPS by (1 + percent * owned)
 *   - "clickPower"   : adds flat bonus gold per manual click (per unit owned)
 *   - "critChance"   : adds to the chance of a critical click (per unit owned)
 *   - "xpBoost"      : adds to the XP multiplier applied to all XP gains
 */
const gameState = {
    // UI language code (see i18n.js). Not part of progression; the choice itself persists as localStorage 'gci_lang'.
    language: (typeof getLanguage === 'function') ? getLanguage() : 'en',

    // ---- First-time tutorial (see TutorialManager). false = the guided tour still has to run; true = finished or skipped.
    // Saved in the main save blob through saveGame()/GCStore like everything else (no separate storage key). ----
    tutorialCompleted: false,

    coins: 0,
    coinsPerClick: 1,
    coinsPerSecond: 0,
    level: 1,
    xp: 0,
    xpToNextLevel: 177, // base XP requirement for level 2 (see calculateXpRequirement)
    soundEnabled: true,
    volume: 1.0, // master volume 0.0 - 1.0 (0 = muted); see setMasterVolume()
    bgmEnabled: true, // procedural background music on/off (Settings > Background Music); mixed through the master volume
    buyAmount: 1, // current bulk-buy multiplier selection: 1, 10, 100, or 'MAX'
    critChance: 0,     // chance (0-1) of a critical click, from Lucky Charm
    critMultiplier: 10, // critical clicks earn 10x normal gold
    xpMultiplier: 1,    // multiplier applied to all XP gains, from Wisdom Potion
    currentBiome: 'surface', // key of the current Mine Depth / Biome (see BIOMES)

    // ---- Prestige system ----
    totalCoinsEarned: 0,  // lifetime coins earned, survives prestige, used for Gem calc
    gems: 0,              // spendable premium currency
    prestigeGems: 0,      // lifetime Gems EARNED BY PRESTIGING (drives the permanent +1%/Gem bonus; never spent)
    prestigeMultiplier: 1, // permanent global multiplier from Gems (1 = +0%)
    skillLevels: {},       // object mapping skill key -> current level (0-5) in the Dwarven Forge; survives prestige

    // ---- Dwarven Relics (Relic Excavation) ----
    relics: {},             // object mapping relic key -> current level (0-MAX_RELIC_LEVEL); survives prestige

    // ---- Random Mini-Events (Golden Meteor / Glowing Crystal) ----
    eventBuff: null,        // { key, label, icon, clickMult, cpsMult, expiresAt } - temporary buff from a mini-event, or null
    lastOnlineTime: null,   // trusted timestamp (GCTime.now()) written on save/unload (legacy key, kept for old saves)
    lastSaveTime: null,     // trusted timestamp (GCTime.now()) written on EVERY save (auto-save + unload); drives offline progress
    timeGuard: null,        // anti-time-cheat record (high-water mark, unverified-credit pool, anomaly log); see GCTime

    // ---- AFK / Offline time limit (hours). Derived from shopState.afkLevel (see AFK_LEVEL_HOURS); saved with the blob. ----
    maxOfflineHours: 2,

    // ---- Offline Progress (see OFFLINE_CONFIG) ----
    offline: {
        extraMaxSeconds: 0,   // bonus seconds added to OFFLINE_CONFIG.maxSeconds (VIP / upgrades / relics later)
        extraEfficiency: 0,   // bonus added to OFFLINE_CONFIG.efficiency (e.g. 0.1 = +10 percentage points)
        pending: null         // { gold, seconds, cappedSeconds, createdAt } - unclaimed offline reward (survives reloads)
    },

    // ---- Helpers / Automation (see HELPER_DEFINITIONS) ----
    helpers: {
        levels: {},           // helperId -> current level (0 = not owned)
        stats: {}             // helperId -> { actions, gold } lifetime counters for the UI
    },

    // ---- Daily Login streak ----
    dailyLogin: {
        streak: 0,          // current consecutive-day streak (1-14, wraps back to 1)
        lastClaimDate: null, // date string 'YYYY-MM-DD' of the last successful claim
        activeBuff: null    // { key, label, icon, clickMult, cpsMult, expiresAt } - currently active buff, or null
    },

    // ---- Permanent Achievement progress (lifetime, never resets) ----
    achievementProgress: {
        clicks: 0,             // lifetime manual clicks
        upgradesBought: 0,     // lifetime upgrades purchased
        critClicks: 0          // lifetime critical clicks landed
    },
    completedAchievements: [], // achievement keys whose reward has been claimed

    // ---- Daily Quests (rotate every 24 hours) ----
    questProgress: {
        clicks: 0,              // manual clicks since the last quest reset
        upgradesBought: 0,      // upgrades purchased since the last quest reset
        coinsEarnedSession: 0,  // coins earned since the last quest reset
        critClicks: 0,          // critical clicks landed since the last quest reset
        levelsGainedToday: 0    // levels gained since the last quest reset
    },
    completedQuests: [], // quest keys whose reward has been claimed this cycle
    dailyQuests: [],     // the 5-6 randomly generated quest instances for the current cycle
    lastQuestReset: null, // timestamp (ms) of the last time daily quests were regenerated

    // ---- Lifetime counters used by Pass weekly quests ----
    totalPrestiges: 0, // lifetime number of times the player has Prestiged

    // ---- Dwarven Expedition Pass ----
    pass: {
        level: 1,                 // current Pass level (1-60)
        xp: 0,                    // XP earned toward the next Pass level
        claimedFree: [],          // level numbers whose Free reward has been claimed
        claimedPremium: [],       // level numbers whose Premium reward has been claimed
        premiumOwned: false,      // legacy/unused: Premium ownership lives in gameState.shopState.isPremiumPassUnlocked

        // Quest progress trackers, mirroring questProgress but scoped to the Pass
        dailyProgress: {
            clicks: 0,             // manual clicks since the last Pass daily reset
            upgradesBought: 0,     // upgrade levels bought since the last Pass daily reset
            passiveEarned: 0,      // passive (CPS) coins earned since the last Pass daily reset
            critClicks: 0          // critical clicks landed since the last Pass daily reset
        },
        weeklyProgress: {
            prestiges: 0,           // prestiges performed since the last Pass weekly reset
            clicks: 0,               // manual clicks since the last Pass weekly reset
            upgradesBought: 0        // upgrade levels bought since the last Pass weekly reset
        },
        completedDailyQuests: [],   // daily pass quest keys claimed this cycle
        completedWeeklyQuests: [],  // weekly pass quest keys claimed this cycle
        lastDailyReset: null,       // timestamp (ms) of the last Pass daily quest reset
        lastWeeklyReset: null       // timestamp (ms) of the last Pass weekly quest reset
    },

    // ---- Boss Key Inventory (Key Altar / Boss Fights) ----
    keys: {
        common: 0,
        rare: 0,
        legendary: 0
    },

    // ---- Shop state (Gems only - see SHOP_PRODUCTS). Saved with the main blob. ----
    shopState: {
        isVIP: false,                // VIP: x2 gold, +50% drops, +1 Rune slot
        vipExpires: null,            // timestamp (ms) for timed VIP, null = permanent
        starterPackPurchased: false, // legacy flag kept so existing saves stay intact
        isPremiumPassUnlocked: false, // Premium Expedition Pass owned (unlocks the Premium reward track)
        afkLevel: 0,                 // AFK limit tier: 0=2h, 1=4h, 2=8h, 3=16h, 4=24h (see AFK_LEVEL_HOURS)
        frenzyPotions: 0,            // unused Frenzy Potions
        frenzyExpiresAt: null,       // timestamp (ms) the active Frenzy ends
        vipRuneSlotRune: null        // rune parked when VIP lapses
    },

    upgrades: {
        clickerBot: {
            get name() { return t('upg_clickerBot_name'); },
            get description() { return t('upg_clickerBot_desc'); },
            type: "flatCps",
            basePrice: 15,
            price: 15,
            growthRate: 1.15, // price multiplier per purchase (tiered 1.15 -> 1.08, see economy notes)
            cps: 0.075,
            owned: 0
        },
        mine: {
            get name() { return t('upg_mine_name'); },
            get description() { return t('upg_mine_desc'); },
            type: "flatCps",
            basePrice: 100,
            price: 100,
            growthRate: 1.15, // price multiplier per purchase (tiered 1.15 -> 1.08, see economy notes)
            cps: 0.25,
            owned: 0
        },
        goldenPickaxe: {
            get name() { return t('upg_goldenPickaxe_name'); },
            get description() { return t('upg_goldenPickaxe_desc'); },
            type: "clickPower",
            basePrice: 150,
            price: 150,
            growthRate: 1.15, // price multiplier per purchase (tiered 1.15 -> 1.08, see economy notes)
            clickBonus: 1, // flat bonus gold per click, per unit owned
            owned: 0
        },
        luckyCharm: {
            get name() { return t('upg_luckyCharm_name'); },
            get description() { return t('upg_luckyCharm_desc'); },
            type: "critChance",
            basePrice: 250,
            price: 250,
            growthRate: 1.15, // price multiplier per purchase (tiered 1.15 -> 1.08, see economy notes)
            critChanceBonus: 0.05, // +5% crit chance per unit owned
            owned: 0
        },
        dwarfGuild: {
            get name() { return t('upg_dwarfGuild_name'); },
            get description() { return t('upg_dwarfGuild_desc'); },
            type: "percentCps",
            basePrice: 500,
            price: 500,
            growthRate: 1.15, // price multiplier per purchase (tiered 1.15 -> 1.08, see economy notes)
            percentBonus: 0.05, // +5% total CPS per unit owned
            owned: 0
        },
        wisdomPotion: {
            get name() { return t('upg_wisdomPotion_name'); },
            get description() { return t('upg_wisdomPotion_desc'); },
            type: "xpBoost",
            basePrice: 300,
            price: 300,
            growthRate: 1.15, // price multiplier per purchase (tiered 1.15 -> 1.08, see economy notes)
            xpBonus: 0.1, // +10% XP multiplier per unit owned
            owned: 0
        },
        steamDrill: {
            get name() { return t('upg_steamDrill_name'); },
            get description() { return t('upg_steamDrill_desc'); },
            type: "flatCps",
            basePrice: 1100,
            price: 1100,
            growthRate: 1.14, // price multiplier per purchase (tiered 1.15 -> 1.08, see economy notes)
            cps: 1.4,
            owned: 0
        },
        smeltingForge: {
            get name() { return t('upg_smeltingForge_name'); },
            get description() { return t('upg_smeltingForge_desc'); },
            type: "flatCps",
            basePrice: 12000,
            price: 12000,
            growthRate: 1.13, // price multiplier per purchase (tiered 1.15 -> 1.08, see economy notes)
            cps: 7.5,
            owned: 0
        },
        goldFactory: {
            get name() { return t('upg_goldFactory_name'); },
            get description() { return t('upg_goldFactory_desc'); },
            type: "flatCps",
            basePrice: 130000,
            price: 130000,
            growthRate: 1.12, // price multiplier per purchase (tiered 1.15 -> 1.08, see economy notes)
            cps: 40,
            owned: 0
        },
        mithrilRefinery: {
            get name() { return t('upg_mithrilRefinery_name'); },
            get description() { return t('upg_mithrilRefinery_desc'); },
            type: "flatCps",
            basePrice: 1400000,
            price: 1400000,
            growthRate: 1.11, // price multiplier per purchase (tiered 1.15 -> 1.08, see economy notes)
            cps: 220,
            owned: 0
        },
        magmaReactor: {
            get name() { return t('upg_magmaReactor_name'); },
            get description() { return t('upg_magmaReactor_desc'); },
            type: "flatCps",
            basePrice: 20000000,
            price: 20000000,
            growthRate: 1.1, // price multiplier per purchase (tiered 1.15 -> 1.08, see economy notes)
            cps: 1560,
            owned: 0
        },
        voidEngine: {
            get name() { return t('upg_voidEngine_name'); },
            get description() { return t('upg_voidEngine_desc'); },
            type: "flatCps",
            basePrice: 330000000,
            price: 330000000,
            growthRate: 1.09, // price multiplier per purchase (tiered 1.15 -> 1.08, see economy notes)
            cps: 12900,
            owned: 0
        },
        celestialForge: {
            get name() { return t('upg_celestialForge_name'); },
            get description() { return t('upg_celestialForge_desc'); },
            type: "flatCps",
            basePrice: 5100000000,
            price: 5100000000,
            growthRate: 1.08, // price multiplier per purchase (tiered 1.15 -> 1.08, see economy notes)
            cps: 100000,
            owned: 0
        }
    }
};

// ---- Biome / Mine Depth configuration ----
// Each biome unlocks automatically at a given player level and grants a
// multiplicative zone bonus applied on top of the level/prestige multiplier.
// REBALANCED: zone multipliers are now a gentle 1 -> 4x ramp. The old x10-per-biome jump
// outran every price in the game, so biomes fell in minutes; growth now comes from the
// 9-tier shop, the level multiplier and Gems instead.
// Progression is intentionally slow: with the steeper XP curve used below,
// reaching each new biome is a genuine long-term milestone.
const BIOMES = [
    {
        key: 'surface',
        get name() { return t('biome_surface_name'); },
        icon: '⛰️',
        requiredLevel: 1,
        bodyClass: null, // default look, no extra class needed
        zoneMultiplier: 1,
        get clickLabel() { return t('biome_surface_click'); },
        announcement: null, // no announcement for the starting biome
        // === NEW: Adaptive biome particles ===
        // Drives the color/shape/motion of the ambient particle field so
        // it visually matches each biome (dust motes here vs. embers in
        // lava, spores in the grotto, etc). See updateBiomeParticles().
        particleStyle: { symbol: '·', color: '#d8c9a3', glow: 'rgba(216, 201, 163, 0.5)', className: 'particle-surface' }
    },
    {
        key: 'slateiron',
        get name() { return t('biome_slateiron_name'); },
        icon: '⛓️',
        requiredLevel: 15,
        bodyClass: 'biome-slateiron',
        zoneMultiplier: 1.25,
        get clickLabel() { return t('biome_slateiron_click'); },
        get announcement() { return t('biome_slateiron_announce'); },
        particleStyle: { symbol: '✦', color: '#b9c2cc', glow: 'rgba(185, 194, 204, 0.55)', className: 'particle-slateiron' }
    },
    {
        key: 'grotto',
        get name() { return t('biome_grotto_name'); },
        icon: '🍄',
        requiredLevel: 35,
        bodyClass: 'biome-grotto',
        zoneMultiplier: 1.6,
        get clickLabel() { return t('biome_grotto_click'); },
        get announcement() { return t('biome_grotto_announce'); },
        particleStyle: { symbol: '✿', color: '#7dffb0', glow: 'rgba(125, 255, 176, 0.65)', className: 'particle-grotto' }
    },
    {
        key: 'mithril',
        get name() { return t('biome_mithril_name'); },
        icon: '💠',
        requiredLevel: 60,
        bodyClass: 'biome-mithril',
        zoneMultiplier: 2,
        get clickLabel() { return t('biome_mithril_click'); },
        get announcement() { return t('biome_mithril_announce'); },
        particleStyle: { symbol: '◆', color: '#5ee9ff', glow: 'rgba(94, 233, 255, 0.6)', className: 'particle-mithril' }
    },
    {
        key: 'magma',
        get name() { return t('biome_magma_name'); },
        icon: '🌋',
        requiredLevel: 100,
        bodyClass: 'biome-magma',
        zoneMultiplier: 2.5,
        get clickLabel() { return t('biome_magma_click'); },
        get announcement() { return t('biome_magma_announce'); },
        particleStyle: { symbol: '✷', color: '#ff8a3d', glow: 'rgba(255, 138, 61, 0.7)', className: 'particle-magma' }
    },
    {
        key: 'voidrift',
        get name() { return t('biome_voidrift_name'); },
        icon: '🌌',
        requiredLevel: 160,
        bodyClass: 'biome-voidrift',
        zoneMultiplier: 3.2,
        get clickLabel() { return t('biome_voidrift_click'); },
        get announcement() { return t('biome_voidrift_announce'); },
        particleStyle: { symbol: '✧', color: '#b06bff', glow: 'rgba(176, 107, 255, 0.7)', className: 'particle-voidrift' }
    },
    {
        key: 'celestial',
        get name() { return t('biome_celestial_name'); },
        icon: '✨',
        requiredLevel: 250,
        bodyClass: 'biome-celestial',
        zoneMultiplier: 4,
        get clickLabel() { return t('biome_celestial_click'); },
        get announcement() { return t('biome_celestial_announce'); },
        particleStyle: { symbol: '★', color: '#fff2b0', glow: 'rgba(255, 242, 176, 0.8)', className: 'particle-celestial' }
    }
];

// ---- Prestige configuration ----
const PRESTIGE_CONFIG = {
    baseRequiredLevel: 80,           // Level requirement for the FIRST prestige (~2.5h of play)
    baseRequiredTotalCoins: 1e12,    // Run-coin requirement for the FIRST prestige
    requiredLevelStep: 5,            // +5 required levels per completed prestige
    requiredTotalCoinsMultiplier: 3, // requirement x3 per completed prestige
    // Gems = floor( gemCoefficient * (runCoins / gemCoinDivisor) ^ gemExponent )
    gemCoefficient: 0.02,            // "A" in the gem formula (calibrated by simulation)
    gemCoinDivisor: 1e6,
    gemExponent: 0.5,
    gemBonusPerGem: 0.01             // each prestige Gem = +1% global production (additive between Gems)
};

/**
 * Returns the Level requirement to Prestige, scaled dynamically by how
 * many prestiges the player has already completed.
 * Level 25 -> 30 -> 35 -> 40... (+5 per completed prestige)
 * @returns {number}
 */
function getRequiredPrestigeLevel() {
    return PRESTIGE_CONFIG.baseRequiredLevel + (gameState.totalPrestiges * PRESTIGE_CONFIG.requiredLevelStep);
}

/**
 * Returns the lifetime total-coins requirement to Prestige, scaled
 * dynamically by how many prestiges the player has already completed.
 * 30,000 -> 90,000 -> 270,000 -> 810,000... (x3 per completed prestige)
 * @returns {number}
 */
function getRequiredPrestigeTotalCoins() {
    return PRESTIGE_CONFIG.baseRequiredTotalCoins * Math.pow(PRESTIGE_CONFIG.requiredTotalCoinsMultiplier, gameState.totalPrestiges);
}

/**
 * =========================================
 * DAILY LOGIN REWARDS (Dynamic 14-Day Streak System)
 * =========================================
 * A 14-day repeating streak. Each day's reward is granted once per real-world
 * day (24h since last claim); missing a day resets the streak back to Day 1.
 *
 * Rewards are NEVER flat numbers - every reward is computed at claim time
 * (and at render time, for the calendar preview) from the player's CURRENT
 * progression, so Day 1 on a level-300 Celestial Core save is just as
 * meaningful as Day 1 on a fresh save:
 *
 *   - "coins" : a slice of the player's current earning power, expressed as
 *               "N seconds/minutes of income" -> coinsPerSecond * TIME_SECONDS
 *               (falls back to a click-power-based estimate for players with
 *               ~0 CPS so early rewards are never worthless).
 *   - "xp"    : a percentage of the XP required for the player's CURRENT
 *               level, e.g. 25% or 50% of xpToNextLevel.
 *   - "gems"  : flat premium currency (Gems are already a slow-earned,
 *               level-independent currency, so a flat scale from 5 -> 50
 *               across milestone days is the correct kind of scaling here).
 *   - "buff"  : a temporary multiplier effect (e.g. 2x Click Power) lasting
 *               a fixed real-time duration, granted on milestone days.
 *
 * DAILY_REWARD_TEMPLATES defines the *shape* of each of the 14 days; call
 * computeDailyReward(day) to resolve a template into a concrete reward with
 * real numbers for display or granting.
 */
const DAILY_REWARD_TEMPLATES = [
    { day: 1,  type: 'coins', seconds: 60,   icon: '🪙' },   // 1 minute of income
    { day: 2,  type: 'coins', seconds: 120,  icon: '🪙' },   // 2 minutes of income
    { day: 3,  type: 'xp',    percent: 0.25, icon: '⭐' },   // 25% of current level XP
    { day: 4,  type: 'coins', seconds: 300,  icon: '🪙' },   // 5 minutes of income
    { day: 5,  type: 'xp',    percent: 0.35, icon: '⭐' },   // 35% of current level XP
    { day: 6,  type: 'coins', seconds: 600,  icon: '🪙' },   // 10 minutes of income
    {
        day: 7, type: 'buff', icon: '⚡', milestone: true,
        buff: { key: 'clickPower2x', get label() { return t('buff_clickPower2x'); }, icon: '⚡', clickMult: 2, cpsMult: 1, durationMinutes: 30 },
        bonus: { type: 'gems', amount: 15 } // Day 7 also grants a flat Gem bonus alongside the buff
    },
    { day: 8,  type: 'coins', seconds: 900,  icon: '🪙' },   // 15 minutes of income
    { day: 9,  type: 'xp',    percent: 0.50, icon: '⭐' },   // 50% of current level XP
    { day: 10, type: 'coins', seconds: 1800, icon: '🪙' },   // 30 minutes of income
    { day: 11, type: 'gems',  amount: 20,    icon: '💎' },
    { day: 12, type: 'coins', seconds: 2700, icon: '🪙' },   // 45 minutes of income
    { day: 13, type: 'xp',    percent: 0.75, icon: '⭐' },   // 75% of current level XP
    {
        day: 14, type: 'buff', icon: '🌟', milestone: true,
        buff: { key: 'megaBoost2x', get label() { return t('buff_megaBoost2x'); }, icon: '🌟', clickMult: 2, cpsMult: 2, durationMinutes: 30 },
        bonus: { type: 'gems', amount: 50 } // Day 14 (full cycle) grants the biggest flat Gem bonus
    }
];

const DAILY_LOGIN_CYCLE_LENGTH = DAILY_REWARD_TEMPLATES.length; // 14

/**
 * Resolves a fallback "coins per second" figure for reward math so that
 * players with little/no passive income (very early game) still get a
 * meaningful Daily Login coin reward, based on click power instead.
 * @returns {number}
 */
function getEffectiveIncomeRate() {
    const liveCps = gameState.coinsPerSecond * getTotalMultiplier();
    const clickBased = getBaseClickAmount() * getTotalMultiplier() * 0.5; // ~1 click every 2 seconds, sustained
    return Math.max(liveCps, clickBased, 1);
}

/**
 * Resolves a Daily Login template (from DAILY_REWARD_TEMPLATES) into a
 * concrete reward object with real numbers/labels, computed from the
 * player's CURRENT stats. Safe to call repeatedly (e.g. every render) since
 * it never mutates state.
 * @param {number} day - 1-14
 * @returns {{day:number,type:string,amount?:number,icon:string,label:string,buff?:object,bonus?:object,milestone?:boolean}}
 */
function computeDailyReward(day) {
    const template = DAILY_REWARD_TEMPLATES.find(t => t.day === day);
    if (!template) return null;

    switch (template.type) {
        case 'coins': {
            const amount = Math.max(1, Math.round(getEffectiveIncomeRate() * template.seconds));
            return {
                day, type: 'coins', amount, icon: template.icon,
                label: t('daily_reward_coins', { amount: formatNumber(amount) })
            };
        }
        case 'xp': {
            const amount = Math.max(1, Math.round(gameState.xpToNextLevel * template.percent));
            return {
                day, type: 'xp', amount, icon: template.icon,
                label: t('daily_reward_xp', { amount: formatNumber(amount), percent: Math.round(template.percent * 100) })
            };
        }
        case 'gems': {
            return {
                day, type: 'gems', amount: template.amount, icon: template.icon,
                label: t('daily_reward_gems', { amount: template.amount })
            };
        }
        case 'buff': {
            return {
                day, type: 'buff', icon: template.icon, milestone: true,
                buff: template.buff,
                bonus: template.bonus,
                label: t('daily_reward_buff', { buff: localizedBuffLabel(template.buff), minutes: template.buff.durationMinutes, bonus: template.bonus ? ` + ${template.bonus.amount} 💎` : '' })
            };
        }
        default:
            return null;
    }
}

/**
 * =========================================
 * PERMANENT ACHIEVEMENTS
 * =========================================
 * One-time, lifetime goals. Unlike Daily Quests, these never reset and are
 * tracked against gameState.achievementProgress / other permanent gameState
 * fields (level, currentBiome, gems, etc). Reward "type" matches the Daily
 * Login reward shape: "coins", "xp", or "gems".
 */
/**
 * Multi-tiered achievement families. Each family shares one lifetime-tracked
 * stat but exposes 3 progressively harder tiers, each with its own key,
 * target, and reward so tiers can be claimed independently as the player
 * crosses each threshold.
 *
 * "tiers" is an array of { target, reward } pairs, ascending in difficulty.
 */
const ACHIEVEMENT_FAMILIES = [
    {
        familyKey: 'clickerMaster',
        get name() { return t('ach_clickerMaster'); },
        icon: '⛏️',
        track: (state) => state.achievementProgress.clicks,
        describe: (target) => t('ach_clickerMaster_desc', { n: formatNumber(target) }),
        tiers: [
            { target: 1000, reward: { type: 'coins', amount: 1000 } },
            { target: 25000, reward: { type: 'gems', amount: 8 } },
            { target: 500000, reward: { type: 'gems', amount: 40 } }
        ]
    },
    {
        familyKey: 'goldTycoon',
        get name() { return t('ach_goldTycoon'); },
        icon: '💰',
        track: (state) => state.totalCoinsEarned,
        describe: (target) => t('ach_goldTycoon_desc', { n: formatNumber(target) }),
        tiers: [
            { target: 10000, reward: { type: 'coins', amount: 5000 } },
            { target: 1000000, reward: { type: 'gems', amount: 12 } },
            { target: 1000000000, reward: { type: 'gems', amount: 60 } }
        ]
    },
    {
        familyKey: 'upgradeCollector',
        get name() { return t('ach_upgradeCollector'); },
        icon: '🛒',
        track: (state) => state.achievementProgress.upgradesBought,
        describe: (target) => t('ach_upgradeCollector_desc', { n: formatNumber(target) }),
        tiers: [
            { target: 50, reward: { type: 'coins', amount: 2500 } },
            { target: 250, reward: { type: 'gems', amount: 10 } },
            { target: 1000, reward: { type: 'gems', amount: 45 } }
        ]
    },
    {
        familyKey: 'veteranMiner',
        get name() { return t('ach_veteranMiner'); },
        icon: '📈',
        track: (state) => state.level,
        describe: (target) => t('ach_veteranMiner_desc', { n: target }),
        tiers: [
            { target: 25, reward: { type: 'xp', amount: 500 } },
            { target: 100, reward: { type: 'gems', amount: 15 } },
            { target: 250, reward: { type: 'gems', amount: 75 } }
        ]
    },
    {
        familyKey: 'fortunesFavorite',
        get name() { return t('ach_fortunesFavorite'); },
        icon: '✨',
        track: (state) => state.achievementProgress.critClicks,
        describe: (target) => t('ach_fortunesFavorite_desc', { n: formatNumber(target) }),
        tiers: [
            { target: 100, reward: { type: 'gems', amount: 5 } },
            { target: 1000, reward: { type: 'gems', amount: 20 } },
            { target: 10000, reward: { type: 'gems', amount: 50 } }
        ]
    }
];

const TIER_LABELS = ['I', 'II', 'III'];

/**
 * Flattens ACHIEVEMENT_FAMILIES into individual claimable achievement
 * definitions (one per tier), each with a stable unique key so save data
 * (gameState.completedAchievements) keeps working across tiers/updates.
 */
function buildAchievementDefinitions() {
    const defs = [];
    ACHIEVEMENT_FAMILIES.forEach(family => {
        family.tiers.forEach((tier, tierIndex) => {
            defs.push({
                key: `${family.familyKey}_t${tierIndex + 1}`,
                get name() { return t('ach_tier', { name: family.name, tier: TIER_LABELS[tierIndex] }); },
                icon: family.icon,
                get description() { return family.describe(tier.target); },
                target: tier.target,
                track: family.track,
                reward: tier.reward
            });
        });
    });
    return defs;
}

// Standalone one-off achievements that don't fit the tiered-family pattern.
const MISC_ACHIEVEMENT_DEFINITIONS = [
    {
        key: 'reachVoidRift',
        get name() { return t('ach_reachVoidRift'); },
        icon: '🌌',
        get description() { return t('ach_reachVoidRift_desc'); },
        target: 1,
        track: (state) => (BIOMES.findIndex(b => b.key === state.currentBiome) >= BIOMES.findIndex(b => b.key === 'voidrift') ? 1 : 0),
        reward: { type: 'gems', amount: 10 }
    },
    {
        key: 'firstPrestige',
        get name() { return t('ach_firstPrestige'); },
        icon: '👑',
        get description() { return t('ach_firstPrestige_desc'); },
        target: 1,
        track: (state) => (state.gems > 0 || state.prestigeMultiplier > 1 ? 1 : 0),
        reward: { type: 'gems', amount: 3 }
    }
];

const ACHIEVEMENT_DEFINITIONS = [...buildAchievementDefinitions(), ...MISC_ACHIEVEMENT_DEFINITIONS];

/**
 * =========================================
 * DAILY QUESTS
 * =========================================
 * A pool of quest "templates". Each template's target/reward is a function
 * of the player's current progression (Level and Biome/zone multiplier) so
 * quests stay meaningful at every stage of the game, not just early on.
 * Every 24 hours, generateDailyQuests() rolls 5-6 of these into concrete
 * quest instances stored in gameState.dailyQuests.
 *
 * scale: a small helper representing how "far along" the player is, derived
 * from Level and the current Biome's zoneMultiplier, used to scale both
 * targets (so quests stay challenging) and rewards (so they stay worthwhile).
 */
function getQuestScale() {
    const levelFactor = 1 + (gameState.level - 1) * 0.06;
    // log-based dampening: zoneMultiplier jumps 10x per biome, but quest
    // difficulty should only grow gently with depth, not multiply directly.
    const biomeFactor = 1 + Math.log10(getZoneMultiplier()) * 0.5;
    return levelFactor * biomeFactor;
}

/**
 * Returns the "Gain N Levels Today" bracket target based on overall level.
 * Early game: 10 levels/day. Mid game: 25/day. Late game: 50/day.
 * Levels get exponentially more expensive (see calculateXpRequirement), so
 * these brackets assume active/idle play roughly matched to that curve.
 */
function getLevelsGainedTarget() {
    const level = gameState.level;
    if (level < 50) return 10;
    if (level < 150) return 25;
    return 50;
}

/**
 * Returns the target Critical Click count for today's quest, scaled gently
 * with level between the design range of 50-150.
 */
function getCritClickTarget() {
    const level = gameState.level;
    const target = 50 + Math.floor(level * 0.6);
    return Math.min(150, Math.max(50, target));
}

/**
 * Returns the target number of Upgrades to purchase today, scaled gently
 * with level between the design range of 25-100.
 */
function getUpgradesBoughtTarget() {
    const level = gameState.level;
    const target = 25 + Math.floor(level * 0.5);
    return Math.min(100, Math.max(25, target));
}

const DAILY_QUEST_POOL = [
    {
        type: 'clicks',
        get name() { return t('quest_clicks_name'); },
        icon: '⛏️',
        describe: (target) => t('quest_clicks_desc', { n: formatNumber(target) }),
        track: (state) => state.questProgress.clicks,
        // Target = 500 + (Level * 50), e.g. Level 100 -> 5,500 clicks/day.
        computeTarget: (state) => 500 + (state.level * 50),
        baseReward: { type: 'gems', amount: 6 }
    },
    {
        type: 'coinsEarned',
        get name() { return t('quest_coinsEarned_name'); },
        icon: '💰',
        describe: (target) => t('quest_coinsEarned_desc', { n: formatNumber(target) }),
        track: (state) => state.questProgress.coinsEarnedSession,
        // Target ~= current CPS * 1200 (20 minutes of idle income at current
        // depth). Falls back to a click-power-based estimate for players
        // with little/no CPS yet, so the quest never asks for the impossible.
        computeTarget: (state) => {
            const cpsBased = state.coinsPerSecond * 1200;
            const clickBased = Math.max(state.coinsPerClick, 1) * 300; // ~300 clicks worth
            return Math.max(cpsBased, clickBased, 500);
        },
        baseReward: { type: 'gems', amount: 10 }
    },
    {
        type: 'upgradesBought',
        get name() { return t('quest_upgradesBought_name'); },
        icon: '🛒',
        describe: (target) => t('quest_upgradesBought_desc', { n: formatNumber(target) }),
        track: (state) => state.questProgress.upgradesBought,
        // 25-100 upgrades/day depending on level bracket.
        computeTarget: (state) => getUpgradesBoughtTarget(),
        baseReward: { type: 'gems', amount: 12 }
    },
    {
        type: 'critClicks',
        get name() { return t('quest_critClicks_name'); },
        icon: '✨',
        describe: (target) => t('quest_critClicks_desc', { n: formatNumber(target) }),
        track: (state) => state.questProgress.critClicks,
        // 50-150 crits/day depending on level.
        computeTarget: (state) => getCritClickTarget(),
        baseReward: { type: 'gems', amount: 8 }
    },
    {
        type: 'levelsGained',
        get name() { return t('quest_levelsGained_name'); },
        icon: '📈',
        describe: (target) => tp('quest_levelsGained_desc', target, { n: formatNumber(target) }),
        track: (state) => state.questProgress.levelsGainedToday,
        // 10 / 25 / 50 levels/day depending on overall level bracket.
        computeTarget: (state) => getLevelsGainedTarget(),
        baseReward: { type: 'gems', amount: 15 }
    }
];

/**
 * Builds one concrete quest instance from a pool template, using the
 * template's own computeTarget() (level/CPS/biome-aware) and then scaling
 * the reward by the player's overall progression via getQuestScale().
 * @param {Object} template - an entry from DAILY_QUEST_POOL
 * @param {number} scale - value from getQuestScale(), used only for rewards
 * @param {number} variantIndex - lets the same template appear twice per day
 *   (e.g. two "Click X times" quests) with a distinct key and difficulty.
 */
function buildQuestInstance(template, scale, variantIndex) {
    // Slightly vary difficulty between duplicate picks of the same type so
    // a day with two quests of the same type still feels distinct (easy + hard).
    const variantMultiplier = 1 + variantIndex * 0.6;
    const rawTarget = template.computeTarget(gameState) * variantMultiplier;

    // Round targets to friendly numbers depending on magnitude
    let target = rawTarget < 20 ? Math.max(1, Math.round(rawTarget))
        : Math.round(rawTarget / 5) * 5;

    if (template.maxTarget) {
        target = Math.min(target, template.maxTarget);
    }

    // Rewards scale with overall progression (level/biome) AND the
    // variant's relative difficulty, so tougher variants pay out more.
    // Gem rewards are clamped to the 5-20 range called out in the design
    // so every quest stays meaningfully worth completing without runaway
    // inflation at very high levels.
    const rewardAmount = template.baseReward.type === 'gems'
        ? Math.min(20, Math.max(5, Math.round(template.baseReward.amount * Math.sqrt(scale) * variantMultiplier)))
        : Math.max(1, Math.round(template.baseReward.amount * scale * variantMultiplier));
    const reward = { type: template.baseReward.type, amount: rewardAmount };

    // IMPORTANT: this object is persisted to localStorage (JSON.stringify),
    // so it must only ever contain plain, serializable data — no functions.
    // The "track" logic lives solely on DAILY_QUEST_POOL templates and is
    // looked up via getQuestTemplate()/trackQuestProgress() at use time.
    return {
        key: `${template.type}_${variantIndex}`,
        type: template.type,
        name: template.name,
        icon: template.icon,
        description: template.describe(target),
        target,
        reward
    };
}

/**
 * Looks up the static template (tracking rules/behavior) for a given quest
 * or quest instance. Returns undefined if no matching template exists
 * (e.g. a saved quest whose type was removed from DAILY_QUEST_POOL in a
 * later update).
 * @param {Object} questInstanceOrDef - anything with a `.type` field
 */
function getQuestTemplate(questInstanceOrDef) {
    if (!questInstanceOrDef) return undefined;
    return DAILY_QUEST_POOL.find(t => t.type === questInstanceOrDef.type);
}

/**
 * Safely reads a quest/achievement's current progress value. Looks up the
 * live template's track() function rather than relying on a `track` method
 * living on the (possibly localStorage-restored) quest object itself.
 * Returns 0 if no template/track function can be found, instead of throwing.
 * @param {Object} questDef - a quest instance or achievement definition
 */
function trackQuestProgress(questDef) {
    if (!questDef) return 0;

    // Achievements carry their own track() function directly on the
    // (always in-memory, never-serialized) ACHIEVEMENT_DEFINITIONS entries.
    if (typeof questDef.track === 'function') {
        return questDef.track(gameState);
    }

    // Daily Quest instances are plain data restored from localStorage; find
    // the matching static template to get the real track() implementation.
    const template = getQuestTemplate(questDef);
    if (template && typeof template.track === 'function') {
        return template.track(gameState);
    }

    console.warn('No track() function found for quest:', questDef && questDef.key);
    return 0;
}

/**
 * Generates a fresh set of 5-6 Daily Quests, picking randomly from
 * DAILY_QUEST_POOL (allowing at most one repeat of any given type) and
 * scaling each one to the player's current Level/Biome via getQuestScale().
 * Resets quest progress counters and records the new reset timestamp.
 */
function generateDailyQuests() {
    const scale = getQuestScale();
    const questCount = 5 + Math.round(Math.random()); // 5 or 6 quests

    // Build a pick order: every template once, then re-shuffle for any extra slot
    const shuffledPool = [...DAILY_QUEST_POOL].sort(() => Math.random() - 0.5);
    const picks = [];
    for (let i = 0; i < questCount; i++) {
        const template = shuffledPool[i % shuffledPool.length];
        const variantIndex = picks.filter(p => p.type === template.type).length;
        picks.push({ template, variantIndex });
    }

    gameState.dailyQuests = picks.map(p => buildQuestInstance(p.template, scale, p.variantIndex));

    // Reset progress counters and claimed state for the new cycle
    gameState.questProgress = {
        clicks: 0,
        upgradesBought: 0,
        coinsEarnedSession: 0,
        critClicks: 0,
        levelsGainedToday: 0
    };
    gameState.completedQuests = [];

    gameState.lastQuestReset = GCTime.now();
    GCStore.setItem('lastQuestReset', String(gameState.lastQuestReset));
}

/** Milliseconds in a full quest cycle (24 hours). */
const QUEST_RESET_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Checks whether 24 hours have passed since the last Daily Quest reset (or
 * if quests have never been generated) and regenerates them if so. Safe to
 * call frequently (on load and on an interval).
 */
function checkDailyQuestReset() {
    const last = gameState.lastQuestReset;
    if (!last || GCTime.now() - last >= QUEST_RESET_INTERVAL_MS || !Array.isArray(gameState.dailyQuests) || gameState.dailyQuests.length === 0) {
        generateDailyQuests();
        return true;
    }
    return false;
}

/** Returns the ms remaining until the next Daily Quest reset. */
function getQuestResetTimeRemaining() {
    if (!gameState.lastQuestReset) return 0;
    const elapsed = GCTime.now() - gameState.lastQuestReset;
    return Math.max(0, QUEST_RESET_INTERVAL_MS - elapsed);
}

/** Formats a millisecond duration as "Xh Ym", e.g. "14h 22m". */
/** Localized label for a buff object (stored buffs keep an English label from save time). */
function localizedBuffLabel(buff) {
    if (!buff) return '';
    const k = String(buff.key || '');
    if (k === 'clickPower2x' || k === 'megaBoost2x' || k === 'passMaxBuff') return t('buff_' + k);
    if (k === 'frenzy') return t('buff_frenzy');
    if (k.indexOf('passBuff') === 0) return t('buff_pass_mult', { mult: Number(buff.clickMult).toFixed(1) });
    return buff.label || '';
}

/** Localized display name / description for a (possibly saved) Daily Quest or Achievement object. */
function questDisplayName(def) {
    if (def && def.type && DAILY_QUEST_POOL.some((q) => q.type === def.type)) return t('quest_' + def.type + '_name');
    return def ? def.name : '';
}
function questDisplayDescription(def) {
    const tpl = def && def.type ? getQuestTemplate(def) : null;
    if (tpl) return tpl.describe(def.target);
    return def ? def.description : '';
}

function formatCountdown(ms) {
    const totalMinutes = Math.floor(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return t('countdown_hm', { hours, minutes });
}

/**
 * =========================================
 * SKILL TREE (Dwarven Forge)
 * =========================================
 * 5-level permanent upgrades purchased with Prestige Gems. Unlike shop
 * upgrades, these persist THROUGH prestige resets and are saved
 * independently in gameState.skillLevels (an object of skillKey -> level,
 * 0 through MAX_SKILL_LEVEL).
 *
 * Skill "type" field determines how it affects gameplay:
 *   - "clickMultiplier" : multiplies base click power (multiplicative, stacks with others), scales with level
 *   - "critChanceFlat"  : adds a flat amount to critChance, scales with level
 *   - "cpsMultiplier"   : multiplies total CPS (multiplicative, stacks with others), scales with level
 *   - "shopEfficiency"  : multiplies the effect of every shop upgrade (flatCps/percentCps/clickPower/etc.), scales with level
 *   - "costReduction"   : reduces the growthRate scaling of all shop upgrade prices, scales with level
 *   - "xpBoostFlat"     : adds a flat amount to the XP multiplier, scales with level
 *
 * "costs" is an array of Gem costs indexed by [levelBeingPurchased - 1],
 * i.e. costs[0] is the price to go from level 0 -> 1, costs[4] is the
 * price to go from level 4 -> 5 (MAX).
 * "valuePerLevel" is the per-level increment used by the skill's type
 * (e.g. clickMultiplier grows by +valuePerLevel for every level owned).
 */
const MAX_SKILL_LEVEL = 5;

const SKILL_TREE = {
    // ---- Path of the Miner (Active) ----
    mithrilPickaxe: {
        get name() { return t('skill_mithrilPickaxe_name'); },
        icon: "⛏️",
        path: "miner",
        get description() { return t('skill_mithrilPickaxe_desc'); },
        costs: [5, 15, 40, 100, 250],
        type: "clickMultiplier",
        valuePerLevel: 0.50 // +50% click power per level (multiplicative: (1 + 0.5*level))
    },
    runedExplosives: {
        get name() { return t('skill_runedExplosives_name'); },
        icon: "💥",
        path: "miner",
        get description() { return t('skill_runedExplosives_desc'); },
        costs: [8, 20, 50, 120, 300],
        type: "critChanceFlat",
        valuePerLevel: 0.05 // +5% flat crit chance per level
    },

    // ---- Path of the Engineer (Passive) ----
    deepEarthDrilling: {
        get name() { return t('skill_deepEarthDrilling_name'); },
        icon: "🛠️",
        path: "engineer",
        get description() { return t('skill_deepEarthDrilling_desc'); },
        costs: [6, 18, 45, 110, 280],
        type: "cpsMultiplier",
        valuePerLevel: 0.25 // +25% CPS per level (multiplicative: (1 + 0.25*level))
    },
    automatedMinecarts: {
        get name() { return t('skill_automatedMinecarts_name'); },
        icon: "🚃",
        path: "engineer",
        get description() { return t('skill_automatedMinecarts_desc'); },
        costs: [10, 25, 60, 150, 350],
        type: "shopEfficiency",
        valuePerLevel: 0.10 // +10% effect from every owned shop upgrade, per level
    },

    // ---- Path of the Merchant (Utility) ----
    dwarvenHaggling: {
        get name() { return t('skill_dwarvenHaggling_name'); },
        icon: "🤝",
        path: "merchant",
        get description() { return t('skill_dwarvenHaggling_desc'); },
        costs: [7, 20, 50, 125, 300],
        type: "costReduction",
        valuePerLevel: 0.03 // reduces (growthRate - 1) by 3% per level
    },
    ancientWisdom: {
        get name() { return t('skill_ancientWisdom_name'); },
        icon: "📜",
        path: "merchant",
        get description() { return t('skill_ancientWisdom_desc'); },
        costs: [4, 12, 30, 80, 200],
        type: "xpBoostFlat",
        valuePerLevel: 0.10 // +10% XP multiplier per level
    }
};

/**
 * =========================================
 * DWARVEN RELICS (Relic Excavation)
 * =========================================
 * Passive-effect artifacts dug up at random with Gems inside the "Relic
 * Excavation" section of the Dwarven Forge modal. Unlike the Skill Tree
 * (deliberate, player-chosen purchases), digging is a gamble: each dig
 * spends Gems and either grants a new relic or levels up one you already
 * own, chosen at random and weighted so common relics surface more often
 * than legendary ones. Relics persist through Prestige, exactly like
 * Skill Tree levels, and are saved in gameState.relics (key -> level).
 *
 * Relic "type" field determines how it affects gameplay:
 *   - "critMultiplier" : adds to the Critical Click damage multiplier, scales with level
 *   - "gemYield"        : multiplies Gems earned from Prestige, scales with level
 *   - "shopCostReduction": reduces shop upgrade prices (flat %), scales with level
 *   - "cpsMultiplier"    : multiplies total CPS, scales with level
 *   - "clickMultiplier"  : multiplies base click power, scales with level
 *   - "eventLuck"        : increases mini-event spawn frequency, scales with level
 *
 * "rarity" only affects dig-weighting and visual flair — it does not
 * change how the effect itself is computed.
 */
const MAX_RELIC_LEVEL = 5;
const RELIC_DIG_COST_MIN = 25;
const RELIC_DIG_COST_MAX = 50;

const RELIC_DEFINITIONS = {
    dwarvenSignetRing: {
        get name() { return t('relic_dwarvenSignetRing_name'); },
        icon: "💍",
        rarity: "Common",
        get description() { return t('relic_dwarvenSignetRing_desc'); },
        type: "critMultiplier",
        valuePerLevel: 1.5, // +150% of a "1x" unit... scaled down below; see getRelicCritMultiplierBonus
        digWeight: 35
    },
    prospectorsCompass: {
        get name() { return t('relic_prospectorsCompass_name'); },
        icon: "🧭",
        rarity: "Common",
        get description() { return t('relic_prospectorsCompass_desc'); },
        type: "cpsMultiplier",
        valuePerLevel: 0.08,
        digWeight: 35
    },
    merchantsLedger: {
        get name() { return t('relic_merchantsLedger_name'); },
        icon: "📒",
        rarity: "Common",
        get description() { return t('relic_merchantsLedger_desc'); },
        type: "shopCostReduction",
        valuePerLevel: 0.03,
        digWeight: 30
    },
    glowcapLantern: {
        get name() { return t('relic_glowcapLantern_name'); },
        icon: "🏮",
        rarity: "Rare",
        get description() { return t('relic_glowcapLantern_desc'); },
        type: "clickMultiplier",
        valuePerLevel: 0.10,
        digWeight: 18
    },
    geodeOfFortune: {
        get name() { return t('relic_geodeOfFortune_name'); },
        icon: "🔮",
        rarity: "Rare",
        get description() { return t('relic_geodeOfFortune_desc'); },
        type: "gemYield",
        valuePerLevel: 0.20,
        digWeight: 15
    },
    stormforgedAmulet: {
        get name() { return t('relic_stormforgedAmulet_name'); },
        icon: "⚡",
        rarity: "Rare",
        get description() { return t('relic_stormforgedAmulet_desc'); },
        type: "eventLuck",
        valuePerLevel: 0.15,
        digWeight: 12
    },
    heartOfTheMountain: {
        get name() { return t('relic_heartOfTheMountain_name'); },
        icon: "❤️‍🔥",
        rarity: "Legendary",
        get description() { return t('relic_heartOfTheMountain_desc'); },
        type: "cpsMultiplier",
        valuePerLevel: 0.50,
        digWeight: 4
    },
    crownOfTheDeepKing: {
        get name() { return t('relic_crownOfTheDeepKing_name'); },
        icon: "👑",
        rarity: "Legendary",
        get description() { return t('relic_crownOfTheDeepKing_desc'); },
        type: "critMultiplier",
        valuePerLevel: 2.5,
        digWeight: 3
    }
};

/** Global helper: current level (0-MAX_RELIC_LEVEL) of a given relic. */
function getRelicLevel(key) {
    return gameState.relics[key] || 0;
}

/**
 * =========================================
 * PERFORMANCE: DERIVED-STAT CACHE (dirty flags)
 * =========================================
 * Relic and skill bonuses are pure functions of gameState.relics / gameState.skillLevels, so they
 * are recomputed only when one of those objects actually changes. Both objects are wrapped in a
 * tiny Proxy that raises the dirty flag on any write (dig, chest reward, skill purchase, load,
 * or code in other files), so no mutation path can forget to invalidate.
 *
 * getTotalMultiplier() / getBaseClickAmount() are additionally memoized against the cheap inputs
 * that feed them (level, prestige multiplier, biome, active buffs, VIP, relic/skill versions) and
 * against the earliest buff/VIP expiry timestamp, so time-based expiry still takes effect on time.
 * The formulas themselves are unchanged.
 */
const statCache = {
    relicsDirty: true,
    skillsDirty: true,
    relicVer: 0,
    skillVer: 0,
    relic: { crit: 0, cps: 1, click: 1, shop: 1, gem: 1, luck: 1 },
    skill: { click: 1, cps: 1, crit: 0, xp: 0, shopEff: 1, costRed: 1 },
    total: { valid: false, value: 1, level: NaN, prestige: NaN, biome: null, dBuff: null, eBuff: null,
             vip: null, vipExp: null, relicVer: -1, validUntil: 0 },
    click: { valid: false, value: 1, cpc: NaN, pickaxeOwned: NaN, skillVer: -1, relicVer: -1,
             dBuff: null, eBuff: null, validUntil: 0 }
};

function invalidateRelicCache() {
    statCache.relicsDirty = true;
    statCache.relicVer++;
    statCache.total.valid = false;
    statCache.click.valid = false;
}

function invalidateSkillCache() {
    statCache.skillsDirty = true;
    statCache.skillVer++;
    statCache.click.valid = false;
}

/** Drops every cached derived stat (called after purchases / loads / prestige). */
function invalidateStatCaches() {
    invalidateRelicCache();
    invalidateSkillCache();
}

/** Wraps gameState[prop] so any write to it (or replacement of it) raises `onChange`. */
function watchStateObject(prop, onChange) {
    const wrap = (obj) => new Proxy(obj, {
        set(t, k, v) { t[k] = v; onChange(); return true; },
        deleteProperty(t, k) { delete t[k]; onChange(); return true; }
    });
    let proxied = wrap(gameState[prop] && typeof gameState[prop] === 'object' ? gameState[prop] : {});
    Object.defineProperty(gameState, prop, {
        enumerable: true,
        configurable: true,
        get() { return proxied; },
        set(v) { proxied = wrap(v && typeof v === 'object' ? v : {}); onChange(); }
    });
}
watchStateObject('relics', invalidateRelicCache);
watchStateObject('skillLevels', invalidateSkillCache);

/** Recomputes all relic bonuses in ONE pass (same math/ordering as the original per-type loops). */
function ensureRelicCache() {
    const c = statCache.relic;
    if (!statCache.relicsDirty) return c;
    let crit = 0, cps = 1, click = 1, shop = 0, gem = 1, luck = 1;
    for (const key in RELIC_DEFINITIONS) {
        const relic = RELIC_DEFINITIONS[key];
        const level = getRelicLevel(key);
        if (level <= 0) continue;
        switch (relic.type) {
            case 'critMultiplier': crit += relic.valuePerLevel * level; break;
            case 'cpsMultiplier': cps *= (1 + relic.valuePerLevel * level); break;
            case 'clickMultiplier': click *= (1 + relic.valuePerLevel * level); break;
            case 'shopCostReduction': shop += relic.valuePerLevel * level; break;
            case 'gemYield': gem *= (1 + relic.valuePerLevel * level); break;
            case 'eventLuck': luck *= (1 + relic.valuePerLevel * level); break;
        }
    }
    c.crit = crit; c.cps = cps; c.click = click; c.shop = Math.max(0, 1 - shop); c.gem = gem; c.luck = luck;
    statCache.relicsDirty = false;
    return c;
}

/** Recomputes all Dwarven Forge skill bonuses in ONE pass. */
function ensureSkillCache() {
    const c = statCache.skill;
    if (!statCache.skillsDirty) return c;
    let click = 1, cps = 1, crit = 0, xp = 0, shopEff = 1, costRed = 0;
    for (const key in SKILL_TREE) {
        const skill = SKILL_TREE[key];
        const level = getSkillLevel(key);
        if (level <= 0) continue;
        switch (skill.type) {
            case 'clickMultiplier': click *= (1 + skill.valuePerLevel * level); break;
            case 'cpsMultiplier': cps *= (1 + skill.valuePerLevel * level); break;
            case 'critChanceFlat': crit += skill.valuePerLevel * level; break;
            case 'xpBoostFlat': xp += skill.valuePerLevel * level; break;
            case 'shopEfficiency': shopEff *= (1 + skill.valuePerLevel * level); break;
            case 'costReduction': costRed += skill.valuePerLevel * level; break;
        }
    }
    c.click = click; c.cps = cps; c.crit = crit; c.xp = xp; c.shopEff = shopEff; c.costRed = Math.max(0, 1 - costRed);
    statCache.skillsDirty = false;
    return c;
}

/** Earliest timestamp at which a currently-active timed multiplier (buff / timed VIP) stops applying. */
function earliestStatExpiry() {
    let until = Infinity;
    const d = gameState.dailyLogin && gameState.dailyLogin.activeBuff;
    if (d && d.expiresAt < until) until = d.expiresAt;
    const e = gameState.eventBuff;
    if (e && e.expiresAt < until) until = e.expiresAt;
    const s = gameState.shopState;
    if (s && s.isVIP && s.vipExpires != null && s.vipExpires < until) until = s.vipExpires;
    return until;
}

/** Combined additive bonus to Critical Click multiplier from all owned relics. */
function getRelicCritMultiplierBonus() {
    return ensureRelicCache().crit;
}

/** Combined multiplier to total CPS from all owned relics (multiplicative). */
function getRelicCpsMultiplier() {
    return ensureRelicCache().cps;
}

/** Combined multiplier to manual click power from all owned relics (multiplicative). */
function getRelicClickMultiplier() {
    return ensureRelicCache().click;
}

/** Combined shop price reduction factor from all owned relics, in (0, 1]. */
function getRelicShopCostReductionFactor() {
    return ensureRelicCache().shop;
}

/** Combined multiplier to Gems earned from Prestige, from all owned relics. */
function getRelicGemYieldMultiplier() {
    return ensureRelicCache().gem;
}

/** Combined multiplier to how frequently mini-events spawn, from all owned relics (>1 = more frequent). */
function getRelicEventLuckMultiplier() {
    return ensureRelicCache().luck;
}

/**
 * Picks a random relic to dig up or upgrade, weighted by rarity
 * (digWeight). Relics already at MAX_RELIC_LEVEL are excluded. Returns
 * null if every relic is already maxed.
 * @returns {string|null} relic key
 */
function pickRandomRelicKey() {
    const candidates = Object.keys(RELIC_DEFINITIONS).filter(
        (key) => getRelicLevel(key) < MAX_RELIC_LEVEL
    );
    if (candidates.length === 0) return null;

    const totalWeight = candidates.reduce((sum, key) => sum + RELIC_DEFINITIONS[key].digWeight, 0);
    let roll = Math.random() * totalWeight;
    for (const key of candidates) {
        roll -= RELIC_DEFINITIONS[key].digWeight;
        if (roll <= 0) return key;
    }
    return candidates[candidates.length - 1]; // fallback for floating-point edge cases
}

/**
 * Spends Gems to excavate a random relic (dig up a new one, or level up
 * one already owned). Cost is randomized within
 * [RELIC_DIG_COST_MIN, RELIC_DIG_COST_MAX] each time. Returns the relic
 * key that was affected, or null if the dig failed (can't afford, or
 * every relic already maxed).
 * @returns {string|null}
 */
function digRelic() {
    const digCost = Math.floor(
        RELIC_DIG_COST_MIN + Math.random() * (RELIC_DIG_COST_MAX - RELIC_DIG_COST_MIN + 1)
    );
    if (gameState.gems < digCost) return null;

    const relicKey = pickRandomRelicKey();
    if (!relicKey) return null; // every relic maxed

    gameState.gems -= digCost;
    gameState.relics[relicKey] = getRelicLevel(relicKey) + 1;

    recalculateDerivedStats();
    saveGame();
    return relicKey;
}

// Cache DOM elements to avoid repeated lookups
const dom = {
    coinCount: document.getElementById('coin-count'),
    cpsCount: document.getElementById('cps-count'),
    clickButton: document.getElementById('click-button'),
    shopContainer: document.getElementById('shop-container'),
    buyAmountBar: document.getElementById('buy-amount-bar'),
    buyAmountButtons: document.querySelectorAll('#buy-amount-bar .buy-amount-btn'),
    soundToggle: document.getElementById('sound-toggle'),
    volumeSlider: document.getElementById('volume-slider'),
    volumeIcon: document.getElementById('volume-icon'),
    volumePercent: document.getElementById('volume-percent'),
    bgmToggle: document.getElementById('bgm-toggle'),
    statsPanel: document.getElementById('stats-panel'),
    depthIndicator: document.getElementById('depth-indicator'),
    depthIcon: document.getElementById('depth-icon'),
    depthName: document.getElementById('depth-name'),
    depthNext: document.getElementById('depth-next'),
    zoneInfo: document.getElementById('zone-info'),
    zoneInfoName: document.getElementById('zone-info-name'),
    zoneInfoMult: document.getElementById('zone-info-mult'),
    depthModalOverlay: document.getElementById('depth-modal-overlay'),
    depthModal: document.getElementById('depth-modal'),
    depthModalIcon: document.getElementById('depth-modal-icon'),
    depthModalName: document.getElementById('depth-modal-name'),
    depthModalMult: document.getElementById('depth-modal-mult'),
    depthModalText: document.getElementById('depth-modal-text'),
    depthModalClose: document.getElementById('depth-modal-close'),
    levelPanel: document.getElementById('level-panel'),
    levelLabel: document.getElementById('level-label'),
    xpBarInner: document.getElementById('xp-bar-inner'),
    xpLabel: document.getElementById('xp-label'),
    prestigeButton: document.getElementById('prestige-button'),
    prestigeHint: document.getElementById('prestige-hint'),
    gemCount: document.getElementById('gem-count'),
    gemMultiplierLabel: document.getElementById('gem-multiplier-label'),
    skillTreeOverlay: document.getElementById('skill-tree-overlay'),
    skillTreeClose: document.getElementById('skill-tree-close'),
    skillTreeGemCount: document.getElementById('skill-tree-gem-count'),
    skillColumns: {
        miner: document.getElementById('skill-column-miner'),
        engineer: document.getElementById('skill-column-engineer'),
        merchant: document.getElementById('skill-column-merchant')
    },

    // ---- Bosses & Key Chests Modal (Key Altar inventory) ----
    keyInventoryGrid: document.getElementById('key-inventory-grid'),

    // ---- Key Altar chest opening ----
    keyAltarChest: document.getElementById('key-altar-chest'),
    keyAltarOpenBtn: document.getElementById('key-altar-open-btn'),
    keyAltarResult: document.getElementById('key-altar-result'),
    keyAltarTypeBar: document.getElementById('key-altar-type-bar'),
    bossFab: document.getElementById('boss-fab'),
    bossOverlay: document.getElementById('boss-overlay'),
    bossClose: document.getElementById('boss-close'),
    bossTabBtnFights: document.getElementById('boss-tab-btn-fights'),
    bossTabBtnAltar: document.getElementById('boss-tab-btn-altar'),
    bossTabPanelFights: document.getElementById('boss-tab-panel-fights'),
    bossTabPanelAltar: document.getElementById('boss-tab-panel-altar'),

    // ---- Achievements Modal ----
    achievementsOverlay: document.getElementById('achievements-overlay'),
    achievementsClose: document.getElementById('achievements-close'),
    achievementList: document.getElementById('achievement-list'),

    // ---- Daily Login / Daily Quests (now live inside the Pass & Quests modal) ----
    activeBuffIndicator: document.getElementById('active-buff-indicator'),
    dailyStreakLabel: document.getElementById('daily-streak-label'),
    dailyNextLabel: document.getElementById('daily-next-label'),
    dailyLoginGrid: document.getElementById('daily-login-grid'),
    questResetTimer: document.getElementById('quest-reset-timer'),
    dailyQuestList: document.getElementById('daily-quest-list'),

    // ---- Dwarven Expedition Pass ("Battle Pass" modal — rewards track ONLY) ----
    passOverlay: document.getElementById('pass-overlay'),
    passClose: document.getElementById('pass-close'),
    passLevelBadgeNum: document.getElementById('pass-level-badge-num'),
    passXpLabel: document.getElementById('pass-xp-label'),
    passNextLevelLabel: document.getElementById('pass-next-level-label'),
    passProgressInner: document.getElementById('pass-progress-inner'),
    passMaxBadge: document.getElementById('pass-max-badge'),
    passTabPanelRewards: document.getElementById('pass-tab-panel-rewards'),
    passTrackScroll: document.getElementById('pass-track-scroll'),

    // ---- Quests Modal (Daily/Weekly Quests + Daily Login Calendar) ----
    questsOverlay: document.getElementById('quests-overlay'),
    questsClose: document.getElementById('quests-close'),
    passBodyTabBtnQuests: document.getElementById('pass-tab-btn-quests'),
    passBodyTabBtnDaily: document.getElementById('pass-tab-btn-daily'),
    passTabPanelQuests: document.getElementById('pass-tab-panel-quests'),
    passTabPanelDaily: document.getElementById('pass-tab-panel-daily'),
    passQuestTabBtnDaily: document.getElementById('pass-quest-tab-btn-daily'),
    passQuestTabBtnWeekly: document.getElementById('pass-quest-tab-btn-weekly'),

    // ---- Fixed 3D Bottom Navigation Bar ----
    navTabMain: document.getElementById('nav-tab-main'),
    navTabPass: document.getElementById('nav-tab-pass'),
    navTabQuests: document.getElementById('nav-tab-quests'),
    navTabAchievements: document.getElementById('nav-tab-achievements'),
    navTabPrestige: document.getElementById('nav-tab-prestige'),
    navTabShop: document.getElementById('nav-tab-shop'),
    navTabDotPass: document.getElementById('nav-tab-dot-pass'),
    navTabDotQuests: document.getElementById('nav-tab-dot-quests'),
    navTabDotAchievements: document.getElementById('nav-tab-dot-achievements'),
    navTabDotPrestige: document.getElementById('nav-tab-dot-prestige'),
    mainView: document.getElementById('main-view'),
    passQuestSectionTitle: document.getElementById('pass-quest-section-title'),
    passQuestResetTimer: document.getElementById('pass-quest-reset-timer'),
    passQuestListDaily: document.getElementById('pass-quest-list-daily'),
    passQuestListWeekly: document.getElementById('pass-quest-list-weekly'),

    // ---- Offline Progress ("Welcome Back") Modal ----
    offlineOverlay: document.getElementById('offline-modal-overlay'),
    offlineDuration: document.getElementById('offline-modal-duration'),
    offlineAmount: document.getElementById('offline-modal-amount'),
    offlineClaimBtn: document.getElementById('offline-modal-claim'),
    offlineNote: document.getElementById('offline-modal-note'),
    offlineCounted: document.getElementById('offline-modal-counted'),

    // ---- Relic Excavation (inside the Dwarven Forge modal) ----
    forgeTabBtnSkills: document.getElementById('forge-tab-btn-skills'),
    forgeTabBtnRelics: document.getElementById('forge-tab-btn-relics'),
    forgeTabPanelSkills: document.getElementById('forge-tab-panel-skills'),
    forgeTabPanelRelics: document.getElementById('forge-tab-panel-relics'),
    relicGemCount: document.getElementById('relic-gem-count'),
    relicDigBtn: document.getElementById('relic-dig-btn'),
    relicDigCostLabel: document.getElementById('relic-dig-cost-label'),
    relicGrid: document.getElementById('relic-grid'),
    relicResultBanner: document.getElementById('relic-result-banner')
};

/**
 * =========================================
 * AUDIO SYSTEM (Web Audio API)
 * =========================================
 * Audio is initialized lazily on the user's first interaction
 * to comply with modern browser autoplay restrictions.
 *
 * === REWRITTEN: Soft, musical, "mobile idle game" sound design ===
 *
 * Signal chain (every sound goes through it):
 *
 *   voices -> audioMaster (gain) -> soft low-pass -> gentle compressor -> speakers
 *                  ^
 *                  +-- shared reverb: convolver (shaped, darkening IR) -> 140 Hz high-pass -> wet gain
 *
 *  - Only SINE and TRIANGLE oscillators are ever used (harsh square /
 *    sawtooth requests are automatically softened to triangle).
 *  - Every voice has its own GainNode envelope: a short linear attack
 *    (no clicks) followed by an exponential decay (natural fade-out).
 *  - All sounds are built from the same few "voices" (bell, pluck, soft
 *    pad, sub-bass, thump) and the same C-major scale, so they sound
 *    like they belong to one family while each keeps its own character.
 *  - The compressor + a voice limit keep things pleasant when many
 *    effects fire at once (fast clicking, crit streaks, boss fights).
 *
 * Public helpers (also used by bosses.js):
 *   sfxNote(opts)   - one musical note   { freq, delay, duration, volume, timbre, hold, glideFrom, glideTo, reverb }
 *   sfxChord(opts)  - several notes together / lightly staggered
 *   sfxThump(opts)  - soft, low, dense impact
 *   sfxNoise(opts)  - short filtered noise (texture for taps / thuds)
 *   sfxThrottle(key, ms) - returns false if `key` fired less than `ms` ago
 *   playTone(opts)  - legacy single-oscillator helper (kept for compatibility)
 */
let audioCtx = null;
let audioMaster = null;        // master bus input
let audioReverb = null;        // shared reverb input (may be null if unavailable)
let audioNoiseBuffer = null;   // lazily created, softened noise buffer (shared by SFX fallback + music percussion)
let sfxActiveVoices = 0;       // currently sounding voices (polyphony guard)
let adAudioMuted = false;      // true ONLY while an advertisement is being shown (see GCAds). Never touches gameState.volume / soundEnabled,
                               // so the player's own volume / mute choice is automatically what comes back after the ad.

const SFX_MASTER_VOLUME = 1.0;   // overall loudness of the whole game (raised from 0.8 to offset the ~2 dB less make-up gain of the gentler compressor, so perceived loudness is unchanged)
const SFX_MAX_VOICES = 36;       // non-priority sounds are skipped above this
const SFX_SOFT_WAVEFORMS = { square: 'triangle', sawtooth: 'triangle' };

/** C-major scale notes used across the game so every sound is harmonically compatible. */
const SFX_NOTES = {
    C3: 130.81, G3: 196.00,
    C4: 261.63, E4: 329.63, G4: 392.00,
    C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880.00, B5: 987.77,
    C6: 1046.50, D6: 1174.66, E6: 1318.51, G6: 1567.98, A6: 1760.00,
    C7: 2093.00
};

/**
 * Instrument "voices". Each is a small stack of sine/triangle partials
 * (ratio = multiple of the note frequency, gain = level, decay = fraction
 * of the note length the partial lasts, detune in cents for gentle warmth).
 */
const SFX_TIMBRES = {
    // Glassy, crystal-like chime with a slightly detuned twin for shimmer.
    bell: {
        attack: 0.006,
        partials: [
            { ratio: 1, gain: 0.70, type: 'sine', decay: 1 },
            { ratio: 1, gain: 0.25, type: 'sine', decay: 1, detune: 7 },
            { ratio: 2, gain: 0.16, type: 'sine', decay: 0.5 },
            { ratio: 3, gain: 0.05, type: 'sine', decay: 0.3 }
        ]
    },
    // Warm kalimba / marimba style pluck (cozy, rounded).
    pluck: {
        attack: 0.008,
        partials: [
            { ratio: 1, gain: 0.75, type: 'triangle', decay: 1 },
            { ratio: 2, gain: 0.22, type: 'sine', decay: 0.45 }
        ]
    },
    // Slow-blooming, gently chorused pad for sustained chords.
    soft: {
        attack: 0.06,
        partials: [
            { ratio: 1, gain: 0.50, type: 'sine', decay: 1 },
            { ratio: 1, gain: 0.26, type: 'triangle', decay: 1, detune: 5 },
            { ratio: 2, gain: 0.10, type: 'sine', decay: 1, detune: -4 }
        ]
    },
    // Round bass with a touch of 2nd harmonic so it is audible on phone speakers.
    sub: {
        attack: 0.015,
        partials: [
            { ratio: 1, gain: 0.85, type: 'sine', decay: 1 },
            { ratio: 2, gain: 0.16, type: 'triangle', decay: 0.6 }
        ]
    },
    // Pure sine.
    sine: {
        attack: 0.008,
        partials: [{ ratio: 1, gain: 1, type: 'sine', decay: 1 }]
    }
};

function initAudio() {
    if (audioCtx) {
        // Some browsers (Safari / iOS) create or leave the context "suspended".
        if (audioCtx.state === 'suspended') sfxResume();
        bgmSync();   // a user gesture may now allow the background music to start
        return;
    }
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContextClass();
    } catch (e) {
        console.warn('Web Audio API not supported:', e);
        return;
    }
    sfxBuildGraph();
    sfxPrewarm(); // pre-render the mining-click voices during idle time
    bgmOnAudioReady();   // background music: hook the new context (starts once it is running)
}

/**
 * One shared noise buffer (1 s, mono). Plain white noise is gently tilted (one-pole low-pass at ~12 kHz, DC removed,
 * RMS-normalised) so the harsh top octave is already tamed before any filter sees it. Built once per context.
 */
function sfxGetNoiseBuffer() {
    const ctx = audioCtx;
    if (audioNoiseBuffer && audioNoiseBuffer.sampleRate === ctx.sampleRate) return audioNoiseBuffer;
    const len = ctx.sampleRate;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    const a = 1 - Math.exp(-2 * Math.PI * 12000 / ctx.sampleRate);
    let lp = 0, sum = 0;
    for (let i = 0; i < len; i++) { lp += a * ((Math.random() * 2 - 1) - lp); d[i] = lp; sum += lp; }
    const mean = sum / len;
    let sq = 0;
    for (let i = 0; i < len; i++) { d[i] -= mean; sq += d[i] * d[i]; }
    const k = 0.5774 / Math.sqrt(sq / len);        // same RMS as uniform white noise in [-1, 1]
    for (let i = 0; i < len; i++) d[i] *= k;
    // Short fades so the 1-second buffer never starts/ends on a step if a take reaches its edge
    const f = Math.floor(ctx.sampleRate * 0.004);
    for (let i = 0; i < f; i++) { const w = i / f; d[i] *= w; d[len - 1 - i] *= w; }
    audioNoiseBuffer = buf;
    return buf;
}

/** Resumes a suspended context without ever throwing / leaving an unhandled rejection. */
function sfxResume() {
    try {
        const p = audioCtx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* ignore */ }
}

/** Builds master gain -> low-pass -> compressor -> output, plus the shared reverb. */
function sfxBuildGraph() {
    const ctx = audioCtx;
    try {
        const master = ctx.createGain();
        master.gain.value = adAudioMuted ? 0 : SFX_MASTER_VOLUME * clampVolume(gameState.volume);

        // Gently rolls off anything piercing above ~9 kHz.
        const tone = ctx.createBiquadFilter();
        tone.type = 'lowpass';
        tone.frequency.value = 9000;
        tone.Q.value = 0.6;

        // Light "glue" compression so stacked sounds never get harsh or clip.
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -18;
        comp.knee.value = 24;      // wider knee = gradual onset of compression (less pumping)
        comp.ratio.value = 4;
        comp.attack.value = 0.008; // lets the click transient through before the glue kicks in
        comp.release.value = 0.30;

        master.connect(tone);
        tone.connect(comp);
        comp.connect(ctx.destination);
        audioMaster = master;
    } catch (e) {
        console.warn('Audio graph setup failed, using direct output:', e);
        audioMaster = ctx.destination;
        audioReverb = null;
        return;
    }

    // Soft, dark reverb tail from a shaped, decaying impulse response (no external files needed).
    try {
        const convolver = ctx.createConvolver();
        convolver.buffer = sfxBuildImpulseResponse(ctx);
        // The wet signal is high-passed so low notes / bass never build up mud in the tail
        // (which would otherwise push the compressor and make the whole mix pump).
        const wetHp = ctx.createBiquadFilter();
        wetHp.type = 'highpass';
        wetHp.frequency.value = 140;
        wetHp.Q.value = 0.5;
        const wet = ctx.createGain();
        wet.gain.value = 0.55;
        convolver.connect(wetHp);
        wetHp.connect(wet);
        wet.connect(audioMaster);
        audioReverb = convolver;
    } catch (e) {
        audioReverb = null;
    }
}

/**
 * Procedural stereo impulse response (built ONCE per AudioContext and shared by every sound + the music).
 *  - 12 ms pre-delay + a short fade-in: no hard onset, so there is no "tick" at the start of the tail
 *  - exponential decay (-60 dB at ~1.3 s) instead of a polynomial window: a natural, smooth fade-out
 *  - TIME-VARYING damping: a one-pole low-pass that closes as the tail ages (about 6.5 kHz -> 1 kHz),
 *    so the late tail is dark and warm instead of a constant band of "sandy" noise
 *  - the two channels use independent noise (wide, decorrelated image) and the last 80 ms fade to exact zero
 */
function sfxBuildImpulseResponse(ctx) {
    const rate = ctx.sampleRate;
    const seconds = 1.6;
    const length = Math.floor(rate * seconds);
    const preDelay = Math.floor(rate * 0.012);
    const fadeIn = Math.floor(rate * 0.015);
    const fadeOut = Math.floor(rate * 0.08);
    const rt60 = 1.3;
    const decayPerSample = Math.log(0.001) / (rt60 * rate);   // amplitude -60 dB at rt60
    const impulse = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
        const data = impulse.getChannelData(ch);
        let lp1 = 0, lp2 = 0;
        for (let i = preDelay; i < length; i++) {
            const age = (i - preDelay) / (length - preDelay);          // 0..1
            const cutoff = 6500 * Math.pow(1000 / 6500, Math.min(1, age * 1.15));   // Hz, closes over time
            const a = 1 - Math.exp(-2 * Math.PI * cutoff / rate);       // one-pole coefficient
            const white = Math.random() * 2 - 1;
            lp1 += a * (white - lp1);
            lp2 += a * (lp1 - lp2);                                     // 2 poles = 12 dB/oct (smooth, no hiss band)
            let env = Math.exp(decayPerSample * (i - preDelay));
            if (i - preDelay < fadeIn) env *= 0.5 - 0.5 * Math.cos(Math.PI * (i - preDelay) / fadeIn);
            if (i > length - fadeOut) env *= 0.5 + 0.5 * Math.cos(Math.PI * (i - (length - fadeOut)) / fadeOut);
            data[i] = lp2 * env;
        }
    }
    // Peak-normalise to a sane level (the ConvolverNode additionally power-normalises on its own).
    let peak = 0;
    for (let ch = 0; ch < 2; ch++) {
        const d = impulse.getChannelData(ch);
        for (let i = 0; i < length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
    }
    if (peak > 0) {
        const k = 0.9 / peak;
        for (let ch = 0; ch < 2; ch++) {
            const d = impulse.getChannelData(ch);
            for (let i = 0; i < length; i++) d[i] *= k;
        }
    }
    return impulse;
}

/**
 * Browsers only allow audio after a user gesture. The game already calls
 * initAudio() from its click handlers; this just makes sure the very first
 * tap / key press anywhere also unlocks audio (and it removes itself once
 * the context is actually running).
 */
(function setupAudioUnlock() {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    const events = ['pointerdown', 'touchend', 'click', 'keydown'];
    const unlock = () => {
        initAudio();
        if (audioCtx && audioCtx.state === 'running') {
            events.forEach(ev => window.removeEventListener(ev, unlock, true));
        }
    };
    events.forEach(ev => window.addEventListener(ev, unlock, { capture: true, passive: true }));
})();





/**
 * Creates the per-voice gain envelope and routes it to the master bus
 * (and optionally to the reverb).
 *  - starts at ~0, linear attack (no click / pop)
 *  - optional `hold` plateau (sustained chords)
 *  - exponential decay to ~0 = natural fade-out
 */
function sfxEnvelope(t, volume, attack, hold, duration, reverbAmount) {
    const ctx = audioCtx;
    const env = ctx.createGain();
    const g = env.gain;
    const peak = Math.max(volume, 0.0002);
    const end = t + duration;
    const attackEnd = Math.min(t + Math.max(attack, 0.003), end - 0.01);

    g.setValueAtTime(0.0001, t);
    g.linearRampToValueAtTime(peak, attackEnd);
    const holdEnd = Math.min(attackEnd + hold, end - 0.02);
    if (hold > 0 && holdEnd > attackEnd) g.setValueAtTime(peak, holdEnd);
    g.exponentialRampToValueAtTime(0.0001, end);

    env.connect(audioMaster);
    let send = null;
    if (reverbAmount > 0 && audioReverb) {
        send = ctx.createGain();
        send.gain.value = reverbAmount;
        env.connect(send);
        send.connect(audioReverb);
    }
    return { env, send };
}

/** Frees the nodes of a finished voice. */
function sfxReleaseVoice(env, send) {
    sfxActiveVoices = Math.max(0, sfxActiveVoices - 1);
    try { env.disconnect(); } catch (e) { /* already gone */ }
    if (send) { try { send.disconnect(); } catch (e) { /* already gone */ } }
}

/**
 * Plays one musical note.
 * @param {Object} o
 *   freq       Hz (default 440)
 *   delay      seconds from now (sample-accurate scheduling)
 *   duration   seconds until the note has faded to silence
 *   volume     peak gain (0..1, keep small - typical 0.05 - 0.15)
 *   timbre     'bell' | 'pluck' | 'soft' | 'sub' | 'sine'
 *   attack     override attack time (s)
 *   hold       seconds to sustain at full level before decaying (pads)
 *   glideFrom / glideTo / glideTime   smooth pitch slide (Hz, Hz, s)
 *   detune     cents
 *   reverb     0..1 send amount to the shared reverb
 *   priority   true = never skipped by the polyphony guard
 */
function sfxNoteLive(o = {}) {
    if (!sfxReady()) return;
    if (sfxActiveVoices >= SFX_MAX_VOICES && !o.priority) return;
    try {
        const ctx = audioCtx;
        const timbre = SFX_TIMBRES[o.timbre] || SFX_TIMBRES.bell;
        const freq = o.freq || 440;
        const duration = Math.max(o.duration || 0.4, 0.06);
        const volume = o.volume !== undefined ? o.volume : 0.12;
        const t = ctx.currentTime + Math.max(0, o.delay || 0) + 0.01;
        const attack = o.attack !== undefined ? o.attack : timbre.attack;
        const startF = o.glideFrom || freq;
        const endF = o.glideTo || freq;
        const glideTime = Math.max(0.01, Math.min(o.glideTime || duration, duration));
        const nyquistSafe = ctx.sampleRate * 0.45;

        const partials = timbre.partials.filter(p => Math.max(startF, endF) * p.ratio < nyquistSafe);
        if (partials.length === 0) return;

        const { env, send } = sfxEnvelope(t, volume, attack, o.hold || 0, duration, o.reverb || 0);
        sfxActiveVoices++;
        let remaining = partials.length;

        partials.forEach(p => {
            const osc = ctx.createOscillator();
            osc.type = p.type;
            const f0 = startF * p.ratio;
            const f1 = endF * p.ratio;
            osc.frequency.setValueAtTime(f0, t);
            if (Math.abs(f1 - f0) > 0.001) {
                osc.frequency.exponentialRampToValueAtTime(f1, t + glideTime);
            }
            const cents = (p.detune || 0) + (o.detune || 0);
            if (cents) osc.detune.value = cents;

            const pg = ctx.createGain();
            pg.gain.setValueAtTime(p.gain, t);
            if (p.decay < 1) {
                pg.gain.exponentialRampToValueAtTime(0.0001, t + duration * p.decay);
            }

            osc.connect(pg);
            pg.connect(env);
            osc.start(t);
            osc.stop(t + duration + 0.05);
            osc.onended = () => {
                try { osc.disconnect(); pg.disconnect(); } catch (e) { /* ignore */ }
                remaining -= 1;
                if (remaining === 0) sfxReleaseVoice(env, send);
            };
        });
    } catch (e) {
        console.warn('sfxNote failed:', e);
    }
}

/**
 * Plays several notes as a chord (optionally lightly staggered = strummed arpeggio).
 * Accepts the same options as sfxNote plus `freqs` and `stagger` (seconds between notes).
 * Per-note volume is scaled so bigger chords don't get louder than single notes.
 */
function sfxChord(o = {}) {
    const freqs = o.freqs || [];
    if (!freqs.length) return;
    const perNote = (o.volume !== undefined ? o.volume : 0.12) / Math.sqrt(freqs.length);
    freqs.forEach((f, i) => {
        sfxNote(Object.assign({}, o, {
            freq: f,
            delay: (o.delay || 0) + i * (o.stagger || 0),
            volume: perNote
        }));
    });
}

/**
 * Short burst of filtered noise. Used only as quiet texture underneath
 * taps and impacts (never as a standalone "hiss").
 */
function sfxNoiseLive(o = {}) {
    if (!sfxReady()) return;
    if (sfxActiveVoices >= SFX_MAX_VOICES && !o.priority) return;
    try {
        const ctx = audioCtx;
        sfxGetNoiseBuffer();
        const duration = Math.max(o.duration || 0.05, 0.02);
        const volume = o.volume !== undefined ? o.volume : 0.05;
        const t = ctx.currentTime + Math.max(0, o.delay || 0) + 0.01;

        const src = ctx.createBufferSource();
        src.buffer = audioNoiseBuffer;
        const filter = ctx.createBiquadFilter();
        filter.type = o.filterType || 'lowpass';
        filter.frequency.value = o.filterFreq || 800;
        filter.Q.value = o.q || 0.7;

        const { env, send } = sfxEnvelope(t, volume, 0.003, 0, duration, o.reverb || 0);
        sfxActiveVoices++;
        src.connect(filter);
        filter.connect(env);
        src.start(t, Math.random() * 0.8);
        src.stop(t + duration + 0.02);
        src.onended = () => {
            try { src.disconnect(); filter.disconnect(); } catch (e) { /* ignore */ }
            sfxReleaseVoice(env, send);
        };
    } catch (e) {
        console.warn('sfxNoise failed:', e);
    }
}

/**
 * Soft, low, "dense" impact: a pitch-dropping sine body, a triangle layer
 * an octave up (so it is audible on small speakers) and a whisper of
 * low-passed noise for weight. No harsh transient anywhere.
 * @param {Object} o - { freq, endFreq, duration, volume, noise (0..1), delay, reverb }
 */
function sfxThumpLive(o = {}) {
    if (!sfxReady()) return;
    if (sfxActiveVoices >= SFX_MAX_VOICES && !o.priority) return;
    try {
        const ctx = audioCtx;
        const freq = o.freq || 120;
        const endFreq = Math.max(o.endFreq || 45, 20);
        const duration = Math.max(o.duration || 0.22, 0.08);
        const volume = o.volume !== undefined ? o.volume : 0.25;
        const delay = Math.max(0, o.delay || 0);
        const t = ctx.currentTime + delay + 0.01;

        const { env, send } = sfxEnvelope(t, volume, 0.004, 0, duration, o.reverb || 0);
        sfxActiveVoices++;
        let remaining = 2;
        const done = () => {
            remaining -= 1;
            if (remaining === 0) sfxReleaseVoice(env, send);
        };

        // Body: sine sweeping down
        const body = ctx.createOscillator();
        body.type = 'sine';
        body.frequency.setValueAtTime(freq, t);
        body.frequency.exponentialRampToValueAtTime(endFreq, t + duration * 0.75);
        const bodyGain = ctx.createGain();
        bodyGain.gain.value = 0.9;
        body.connect(bodyGain);
        bodyGain.connect(env);
        body.start(t);
        body.stop(t + duration + 0.05);
        body.onended = () => {
            try { body.disconnect(); bodyGain.disconnect(); } catch (e) { /* ignore */ }
            done();
        };

        // Presence: triangle one octave up, fades faster
        const mid = ctx.createOscillator();
        mid.type = 'triangle';
        mid.frequency.setValueAtTime(freq * 2, t);
        mid.frequency.exponentialRampToValueAtTime(Math.max(endFreq * 2, 40), t + duration * 0.6);
        const midGain = ctx.createGain();
        midGain.gain.setValueAtTime(0.32, t);
        midGain.gain.exponentialRampToValueAtTime(0.0001, t + duration * 0.55);
        mid.connect(midGain);
        midGain.connect(env);
        mid.start(t);
        mid.stop(t + duration + 0.05);
        mid.onended = () => {
            try { mid.disconnect(); midGain.disconnect(); } catch (e) { /* ignore */ }
            done();
        };

        // Body texture: very short, dark noise
        if (o.noise > 0) {
            sfxNoise({ delay, duration: 0.06, volume: volume * o.noise, filterFreq: 450, filterType: 'lowpass', priority: o.priority });
        }
    } catch (e) {
        console.warn('sfxThump failed:', e);
    }
}

/**
 * Plays a simple tone using an oscillator + gain envelope.
 * (Legacy helper - kept so any other script that calls playTone keeps working.)
 *
 * Improvements over the old version:
 *  - harsh 'square' / 'sawtooth' requests are softened to 'triangle'
 *  - short linear attack + exponential decay (no clicks or pops)
 *  - routed through the master bus (soft low-pass + compressor)
 *  - optional `delay` (seconds), `reverb` (0..1) and `attack` (seconds)
 * @param {Object} opts - { freq, duration, type, endFreq, volume, delay, reverb, attack }
 */
function playToneLive({ freq = 440, duration = 0.12, type = 'sine', endFreq = null, volume = 0.2, delay = 0, reverb = 0, attack = null } = {}) {
    if (!sfxReady()) return;
    try {
        const ctx = audioCtx;
        const safeDuration = Math.max(duration, 0.05);
        const t = ctx.currentTime + Math.max(0, delay) + 0.005;
        const attackTime = attack !== null ? attack : Math.min(0.03, Math.max(0.006, safeDuration * 0.12));

        const osc = ctx.createOscillator();
        osc.type = SFX_SOFT_WAVEFORMS[type] || type;
        osc.frequency.setValueAtTime(freq, t);
        if (endFreq !== null && Math.abs(endFreq - freq) > 0.001) {
            osc.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 1), t + safeDuration);
        }

        const { env, send } = sfxEnvelope(t, volume, attackTime, 0, safeDuration, reverb);
        sfxActiveVoices++;
        osc.connect(env);
        osc.start(t);
        osc.stop(t + safeDuration + 0.05);
        osc.onended = () => {
            try { osc.disconnect(); } catch (e) { /* ignore */ }
            sfxReleaseVoice(env, send);
        };
    } catch (e) {
        console.warn('playTone failed:', e);
    }
}

/* ---------------------------------------------------------
 * PERFORMANCE: PRE-RENDERED VOICE CACHE (replaces per-note oscillator graphs)
 * ---------------------------------------------------------
 * OscillatorNodes are one-shot (they cannot be restarted or pooled), so building every note from
 * 1-4 oscillators + a gain per partial + an envelope gain + a reverb-send gain meant ~10-25 fresh
 * nodes per click. Instead each distinct sound (timbre + pitch + glide + length + volume ...) is
 * synthesised ONCE into a mono AudioBuffer using exactly the same partials, glides, detune and
 * envelope curves as the original node graph, cached (LRU, memory-capped) and then played with a
 * single AudioBufferSourceNode. Reverb sends are persistent shared gain nodes (pooled per amount).
 * The sound, scheduling (sample-accurate delay) and routing are unchanged.
 */
const SFX_CACHE_MAX_BYTES = 24 * 1024 * 1024; // LRU cap for pre-rendered voices
const SFX_NOISE_VARIANTS = 4;                 // random noise takes are cached, so the texture still varies
const sfxBufferCache = new Map();             // key -> AudioBuffer (Map order = LRU order)
let sfxBufferBytes = 0;
const sfxSendNodes = new Map();               // reverb amount -> persistent send GainNode -> reverb

function sfxR4(x) { return Math.round(x * 10000) / 10000; }

function sfxCacheGet(key) {
    const buf = sfxBufferCache.get(key);
    if (buf) { sfxBufferCache.delete(key); sfxBufferCache.set(key, buf); } // mark most-recently used
    return buf;
}

function sfxCachePut(key, buf) {
    sfxBufferCache.set(key, buf);
    sfxBufferBytes += buf.length * 4;
    while (sfxBufferBytes > SFX_CACHE_MAX_BYTES && sfxBufferCache.size > 1) {
        const oldestKey = sfxBufferCache.keys().next().value;
        const old = sfxBufferCache.get(oldestKey);
        sfxBufferCache.delete(oldestKey);
        sfxBufferBytes -= old.length * 4;
    }
}

/** Persistent, shared reverb-send gain (one per distinct amount) instead of one new GainNode per voice. */
function sfxGetSend(amount) {
    if (!(amount > 0) || !audioReverb) return null;
    const key = Math.round(amount * 1000);
    let node = sfxSendNodes.get(key);
    if (!node) {
        node = audioCtx.createGain();
        node.gain.value = amount;
        node.connect(audioReverb);
        sfxSendNodes.set(key, node);
    }
    return node;
}

/** Biquad coefficients (RBJ cookbook, Web Audio conventions: lowpass/highpass Q is in dB). */
function sfxBiquadCoeffs(type, freq, q, rate) {
    const w0 = 2 * Math.PI * Math.min(freq, rate * 0.49) / rate;
    const cos = Math.cos(w0), sin = Math.sin(w0);
    let b0, b1, b2, alpha;
    if (type === 'bandpass') {
        alpha = sin / (2 * Math.max(q, 0.0001));
        b0 = alpha; b1 = 0; b2 = -alpha;
    } else {
        alpha = sin / (2 * Math.pow(10, q / 20));
        if (type === 'highpass') { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2; }
        else { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2; }
    }
    const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Gain envelope identical to sfxEnvelope(): linear attack, optional hold, exponential decay to 0.0001. */
function sfxApplyEnvelope(out, rate, volume, attack, hold, duration) {
    const peak = Math.max(volume, 0.0002);
    const attackLen = Math.min(Math.max(attack, 0.003), duration - 0.01);
    let decayStart = attackLen;
    if (hold > 0) {
        const holdEnd = Math.min(attackLen + hold, duration - 0.02);
        if (holdEnd > attackLen) decayStart = holdEnd;
    }
    const aN = attackLen * rate;
    const dsN = decayStart * rate;
    const dN = Math.max(1, (duration - decayStart) * rate);
    const ratio = Math.pow(0.0001 / peak, 1 / dN);
    let e = peak;
    const len = out.length;
    for (let i = 0; i < len; i++) {
        let g;
        if (i < aN) g = 0.0001 + (peak - 0.0001) * (i / aN);
        else if (i < dsN) g = peak;
        else if (i < dsN + dN) { g = e; e *= ratio; }
        else g = 0.0001;
        out[i] *= g;
    }
}

/** Adds one short filtered-noise take (same chain as sfxNoise: noise -> biquad -> envelope) into `out`. */
function sfxRenderNoiseInto(out, rate, n) {
    const dur = Math.max(n.duration, 0.02);
    const count = Math.min(out.length, Math.ceil((dur + 0.02) * rate));
    const tmp = new Float32Array(count);
    const c = sfxBiquadCoeffs(n.filterType, n.filterFreq, n.q, rate);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < count; i++) {
        const x0 = Math.random() * 2 - 1;
        const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
        x2 = x1; x1 = x0; y2 = y1; y1 = y0;
        tmp[i] = y0;
    }
    sfxApplyEnvelope(tmp, rate, n.volume, 0.003, 0, dur);
    for (let i = 0; i < count; i++) out[i] += tmp[i];
}

/**
 * Synthesises one voice into an AudioBuffer.
 * spec: { duration, volume, attack, hold, partials:[{type,f0,f1,glideTime,gain,decayTime}], noise? }
 */
function sfxRenderVoice(spec) {
    const ctx = audioCtx;
    const rate = ctx.sampleRate;
    const dur = spec.duration;
    const len = Math.max(1, Math.ceil((dur + 0.03) * rate));
    const buf = ctx.createBuffer(1, len, rate);
    const out = buf.getChannelData(0);
    const TWO_PI = 2 * Math.PI;

    for (let pi = 0; pi < spec.partials.length; pi++) {
        const p = spec.partials[pi];
        const glides = Math.abs(p.f1 - p.f0) > 0.001;
        const glideN = glides ? Math.max(1, p.glideTime * rate) : 0;
        const fRatio = glides ? Math.pow(p.f1 / p.f0, 1 / glideN) : 1;
        const gN = p.decayTime > 0 ? Math.max(1, p.decayTime * rate) : 0;
        const gRatio = gN ? Math.pow(0.0001 / p.gain, 1 / gN) : 1;
        const isTri = p.type === 'triangle';
        let f = p.f0, g = p.gain, phase = 0;
        for (let i = 0; i < len; i++) {
            let s;
            if (isTri) {
                const x = phase - Math.floor(phase);
                s = x < 0.25 ? 4 * x : (x < 0.75 ? 2 - 4 * x : 4 * x - 4);
            } else {
                s = Math.sin(TWO_PI * phase);
            }
            out[i] += s * g;
            phase += f / rate;
            if (phase >= 1) phase -= Math.floor(phase);
            if (i < glideN) f *= fRatio;
            if (gN) { if (i < gN) g *= gRatio; else g = 0.0001; }
        }
    }

    // The shared voice envelope applies to the oscillator partials only; a noise layer carries its own envelope.
    if (spec.partials.length) sfxApplyEnvelope(out, rate, spec.volume, spec.attack, spec.hold || 0, dur);
    if (spec.noise) sfxRenderNoiseInto(out, rate, spec.noise);
    return buf;
}

/** Plays a cached voice with ONE AudioBufferSourceNode; the node frees itself when it ends. */
function sfxPlayBuffer(buf, t, reverbAmount) {
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioMaster);
    const send = sfxGetSend(reverbAmount);
    if (send) src.connect(send);
    sfxActiveVoices++;
    src.onended = () => {
        src.onended = null;
        try { src.disconnect(); } catch (e) { /* already gone */ }
        sfxActiveVoices = Math.max(0, sfxActiveVoices - 1);
    };
    src.start(t);
}

const sfxLastPlayed = {};
/**
 * Rate limiter so rapid-fire events never pile up into a harsh wall of sound.
 * Adaptive: the minimum gap is unchanged while the engine is lightly loaded, and stretches
 * (up to 3x) as the polyphony budget fills, so extreme autoclick / boss-hit storms are thinned
 * smoothly instead of hammering the audio thread and the garbage collector.
 */
function sfxThrottle(key, minMs) {
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : GCTime.now();
    const load = sfxActiveVoices / SFX_MAX_VOICES;
    const gap = load > 0.5 ? minMs * (1 + (load - 0.5) * 4) : minMs;
    if (sfxLastPlayed[key] !== undefined && now - sfxLastPlayed[key] < gap) return false;
    sfxLastPlayed[key] = now;
    return true;
}

/** True when sound is enabled and the audio engine can play. */
function sfxReady() {
    if (!gameState.soundEnabled || adAudioMuted || !audioCtx || !audioMaster) return false;
    if (audioCtx.state === 'suspended') {
        sfxResume();
        // While the context is still suspended nothing is audible and nodes would only pile up.
        if (sfxActiveVoices >= 8) return false;
    }
    return true;
}

/** Plays one musical note (see option list on sfxNoteLive). Pre-rendered + cached; one node per note. */
function sfxNote(o = {}) {
    if (o.dry ? !audioCtx : !sfxReady()) return;
    if (!o.dry && sfxActiveVoices >= SFX_MAX_VOICES && !o.priority) return;
    try {
        const ctx = audioCtx;
        const timbreName = SFX_TIMBRES[o.timbre] ? o.timbre : 'bell';
        const timbre = SFX_TIMBRES[timbreName];
        const freq = o.freq || 440;
        const duration = Math.max(o.duration || 0.4, 0.06);
        const volume = o.volume !== undefined ? o.volume : 0.12;
        const attack = o.attack !== undefined ? o.attack : timbre.attack;
        const startF = o.glideFrom || freq;
        const endF = o.glideTo || freq;
        const glideTime = Math.max(0.01, Math.min(o.glideTime || duration, duration));
        const hold = o.hold || 0;
        const nyquistSafe = ctx.sampleRate * 0.45;

        const partials = timbre.partials.filter(p => Math.max(startF, endF) * p.ratio < nyquistSafe);
        if (partials.length === 0) return;

        const key = ['n', timbreName, sfxR4(startF), sfxR4(endF), sfxR4(glideTime), sfxR4(duration),
            sfxR4(volume), sfxR4(attack), sfxR4(hold), sfxR4(o.detune || 0)].join('|');
        let buf = sfxCacheGet(key);
        if (!buf) {
            buf = sfxRenderVoice({
                duration, volume, attack, hold,
                partials: partials.map(p => {
                    const dc = Math.pow(2, ((p.detune || 0) + (o.detune || 0)) / 1200);
                    return {
                        type: p.type,
                        f0: startF * p.ratio * dc,
                        f1: endF * p.ratio * dc,
                        glideTime,
                        gain: p.gain,
                        decayTime: p.decay < 1 ? duration * p.decay : 0
                    };
                })
            });
            sfxCachePut(key, buf);
        }
        if (o.dry) return;
        sfxPlayBuffer(buf, ctx.currentTime + Math.max(0, o.delay || 0) + 0.01, o.reverb || 0);
    } catch (e) {
        console.warn('sfxNote failed, using live graph:', e);
        sfxNoteLive(o);
    }
}

/** Short filtered noise burst. A few random takes per setting are cached and picked at random. */
function sfxNoise(o = {}) {
    if (o.dry ? !audioCtx : !sfxReady()) return;
    if (!o.dry && sfxActiveVoices >= SFX_MAX_VOICES && !o.priority) return;
    try {
        const ctx = audioCtx;
        const duration = Math.max(o.duration || 0.05, 0.02);
        const volume = o.volume !== undefined ? o.volume : 0.05;
        const filterType = o.filterType || 'lowpass';
        const filterFreq = o.filterFreq || 800;
        const q = o.q || 0.7;
        const variant = Math.floor(Math.random() * SFX_NOISE_VARIANTS);
        const key = ['z', filterType, sfxR4(filterFreq), sfxR4(q), sfxR4(duration), sfxR4(volume), variant].join('|');
        let buf = sfxCacheGet(key);
        if (!buf) {
            buf = sfxRenderVoice({
                duration: duration + 0.02, volume: 0, attack: 0.003, partials: [],
                noise: { duration, volume, filterType, filterFreq, q }
            });
            sfxCachePut(key, buf);
        }
        if (o.dry) return;
        sfxPlayBuffer(buf, ctx.currentTime + Math.max(0, o.delay || 0) + 0.01, o.reverb || 0);
    } catch (e) {
        console.warn('sfxNoise failed, using live graph:', e);
        sfxNoiseLive(o);
    }
}

/** Soft, low impact (pitch-dropping sine + octave-up triangle + optional dark noise, baked into one voice). */
function sfxThump(o = {}) {
    if (o.dry ? !audioCtx : !sfxReady()) return;
    if (!o.dry && sfxActiveVoices >= SFX_MAX_VOICES && !o.priority) return;
    try {
        const ctx = audioCtx;
        const freq = o.freq || 120;
        const endFreq = Math.max(o.endFreq || 45, 20);
        const duration = Math.max(o.duration || 0.22, 0.08);
        const volume = o.volume !== undefined ? o.volume : 0.25;
        const delay = Math.max(0, o.delay || 0);
        const reverb = o.reverb || 0;
        const noiseAmt = o.noise > 0 ? o.noise : 0;
        const bakeNoise = noiseAmt > 0 && !(reverb > 0); // noise had no reverb send, so it can share this voice only when the thump has none

        const variant = bakeNoise ? Math.floor(Math.random() * SFX_NOISE_VARIANTS) : 0;
        const key = ['t', sfxR4(freq), sfxR4(endFreq), sfxR4(duration), sfxR4(volume),
            bakeNoise ? sfxR4(noiseAmt) : 0, variant].join('|');
        let buf = sfxCacheGet(key);
        if (!buf) {
            buf = sfxRenderVoice({
                duration, volume, attack: 0.004, hold: 0,
                partials: [
                    { type: 'sine', f0: freq, f1: endFreq, glideTime: duration * 0.75, gain: 0.9, decayTime: 0 },
                    { type: 'triangle', f0: freq * 2, f1: Math.max(endFreq * 2, 40), glideTime: duration * 0.6, gain: 0.32, decayTime: duration * 0.55 }
                ],
                noise: bakeNoise ? { duration: 0.06, volume: volume * noiseAmt, filterType: 'lowpass', filterFreq: 450, q: 0.7 } : null
            });
            sfxCachePut(key, buf);
        }
        if (o.dry) return;
        sfxPlayBuffer(buf, ctx.currentTime + delay + 0.01, reverb);
        if (noiseAmt > 0 && !bakeNoise) {
            sfxNoise({ delay, duration: 0.06, volume: volume * noiseAmt, filterFreq: 450, filterType: 'lowpass', priority: o.priority });
        }
    } catch (e) {
        console.warn('sfxThump failed, using live graph:', e);
        sfxThumpLive(o);
    }
}

/**
 * Legacy single-oscillator helper (used by bosses.js). Same behaviour as before (harsh waveforms
 * softened to triangle, soft attack, exponential decay) but pre-rendered, cached and de-duplicated:
 * identical tones fired faster than ~18 ms apart (autoclicker boss hits) are thinned adaptively, and
 * a hard voice ceiling protects the audio thread without ever blocking the first sounds of a burst.
 */
function playTone({ freq = 440, duration = 0.12, type = 'sine', endFreq = null, volume = 0.2, delay = 0, reverb = 0, attack = null } = {}) {
    if (!sfxReady()) return;
    if (sfxActiveVoices >= SFX_MAX_VOICES * 2) return;
    try {
        const ctx = audioCtx;
        const safeDuration = Math.max(duration, 0.05);
        const attackTime = attack !== null ? attack : Math.min(0.03, Math.max(0.006, safeDuration * 0.12));
        const wave = SFX_SOFT_WAVEFORMS[type] || type;
        const endF = (endFreq !== null && Math.abs(endFreq - freq) > 0.001) ? Math.max(endFreq, 1) : freq;

        if (delay === 0 && !sfxThrottle('tone|' + freq + '|' + endF + '|' + wave, 18)) return;

        const key = ['p', wave, sfxR4(freq), sfxR4(endF), sfxR4(safeDuration), sfxR4(volume), sfxR4(attackTime)].join('|');
        let buf = sfxCacheGet(key);
        if (!buf) {
            buf = sfxRenderVoice({
                duration: safeDuration, volume, attack: attackTime, hold: 0,
                partials: [{ type: wave === 'triangle' ? 'triangle' : 'sine', f0: freq, f1: endF, glideTime: safeDuration, gain: 1, decayTime: 0 }]
            });
            sfxCachePut(key, buf);
        }
        sfxPlayBuffer(buf, ctx.currentTime + Math.max(0, delay) + 0.005, reverb);
    } catch (e) {
        console.warn('playTone failed, using live graph:', e);
        playToneLive(arguments[0]);
    }
}

/** Renders the most frequent sounds (mining click) ahead of time so the first click never hitches. */
function sfxPrewarm() {
    if (!audioCtx || !audioMaster) return;
    let i = 0;
    const steps = [];
    CLICK_PITCHES.forEach((p) => steps.push(() => sfxNote(Object.assign({ dry: true }, clickBellOpts(p)))));
    for (let v = 0; v < SFX_NOISE_VARIANTS; v++) steps.push(() => sfxThump(Object.assign({ dry: true }, clickThumpOpts())));
    // Spread the work over idle time so it can never cost a frame.
    const next = () => {
        if (i >= steps.length) return;
        try { steps[i++](); } catch (e) { /* ignore */ }
        setTimeout(next, 12);
    };
    setTimeout(next, 400);
}

/* ---------------------------------------------------------
 * GAME SOUNDS
 * --------------------------------------------------------- */

const CLICK_PITCHES = [SFX_NOTES.C6, SFX_NOTES.D6, SFX_NOTES.E6, SFX_NOTES.G6, SFX_NOTES.A6]; // C-major pentatonic
let lastClickPitchIndex = -1;

/**
 * Mining click: a soft wooden "tock" with a tiny crystal "tink" on top.
 * The tink picks a random note from a pentatonic scale (never the same
 * note twice in a row) so fast clicking sounds like a gentle wind-chime
 * instead of a repeating beep.
 */
function clickThumpOpts() {
    return { freq: 260, endFreq: 150, duration: 0.07, volume: 0.07, noise: 0.5 };
}
function clickBellOpts(pitch) {
    return { freq: pitch, glideFrom: pitch * 1.03, glideTime: 0.02, duration: 0.22, volume: 0.06, timbre: 'bell', reverb: 0.2 };
}
function playClickSound() {
    if (!sfxReady() || !sfxThrottle('click', 28)) return;
    let idx;
    do { idx = Math.floor(Math.random() * CLICK_PITCHES.length); } while (idx === lastClickPitchIndex);
    lastClickPitchIndex = idx;
    const pitch = CLICK_PITCHES[idx];

    sfxThump(clickThumpOpts());
    sfxNote(clickBellOpts(pitch));
}

/** Critical click: the same tock, but with a bright rising C-major sparkle (C6-E6-G6-C7). */
function playCritSound() {
    if (!sfxReady() || !sfxThrottle('crit', 40)) return;
    sfxThump({ freq: 190, endFreq: 95, duration: 0.14, volume: 0.10, noise: 0.3 });
    [SFX_NOTES.C6, SFX_NOTES.E6, SFX_NOTES.G6, SFX_NOTES.C7].forEach((f, i) => {
        sfxNote({ freq: f, delay: i * 0.05, duration: 0.4, volume: 0.075, timbre: 'bell', reverb: 0.3 });
    });
}

/** Buying an upgrade: cozy ascending 3-note pluck (C5 - E5 - G5). */
function playUpgradeSound() {
    if (!sfxReady() || !sfxThrottle('upgrade', 60)) return;
    [SFX_NOTES.C5, SFX_NOTES.E5, SFX_NOTES.G5].forEach((f, i) => {
        sfxNote({ freq: f, delay: i * 0.075, duration: i === 2 ? 0.7 : 0.34, volume: 0.13, timbre: 'pluck', reverb: 0.18 });
    });
}

/** Level up: celebratory C-major bell arpeggio that blooms into a soft, shimmering chord. */
function playLevelUpSound() {
    // Throttled: leveling up can also open the "New Depth Discovered" modal, which would
    // otherwise stack a second, identical fanfare on top of this one.
    if (!sfxReady() || !sfxThrottle('levelup', 600)) return;
    [SFX_NOTES.C5, SFX_NOTES.E5, SFX_NOTES.G5, SFX_NOTES.C6].forEach((f, i) => {
        sfxNote({ freq: f, delay: i * 0.085, duration: 0.55, volume: 0.12, timbre: 'bell', reverb: 0.25, priority: true });
    });
    sfxChord({
        freqs: [SFX_NOTES.C5, SFX_NOTES.E5, SFX_NOTES.G5, SFX_NOTES.C6],
        delay: 0.36, duration: 1.3, volume: 0.15, timbre: 'soft', hold: 0.25, reverb: 0.3, priority: true
    });
    sfxNote({ freq: SFX_NOTES.E6, delay: 0.36, duration: 1.1, volume: 0.07, timbre: 'bell', reverb: 0.35, priority: true });
}

/** Grand, layered fanfare for Prestige/Ascension: warm bass pad + rising bell arpeggio + big soft chord + sparkle. */
function playPrestigeSound() {
    if (!sfxReady() || !sfxThrottle('prestige', 800)) return;
    // Warm foundation
    sfxChord({
        freqs: [SFX_NOTES.C3, SFX_NOTES.G3], delay: 0, duration: 2.6, volume: 0.16,
        timbre: 'soft', attack: 0.25, hold: 1.2, reverb: 0.25, priority: true
    });
    // Rising arpeggio G4 -> E6
    [SFX_NOTES.G4, SFX_NOTES.C5, SFX_NOTES.E5, SFX_NOTES.G5, SFX_NOTES.C6, SFX_NOTES.E6].forEach((f, i) => {
        sfxNote({ freq: f, delay: 0.05 + i * 0.11, duration: 0.7, volume: 0.11, timbre: 'bell', reverb: 0.3, priority: true });
    });
    // Big soft chord landing
    sfxChord({
        freqs: [SFX_NOTES.C5, SFX_NOTES.E5, SFX_NOTES.G5, SFX_NOTES.C6, SFX_NOTES.E6],
        delay: 0.78, duration: 2.2, volume: 0.17, timbre: 'soft', hold: 0.6, reverb: 0.4, priority: true
    });
    // Twinkles on top
    sfxNote({ freq: SFX_NOTES.G6, delay: 1.0, duration: 1.2, volume: 0.05, timbre: 'bell', reverb: 0.45, priority: true });
    sfxNote({ freq: SFX_NOTES.C7, delay: 1.15, duration: 1.3, volume: 0.04, timbre: 'bell', reverb: 0.5, priority: true });
}

/** Toggles sound on/off and updates the toggle button label. */
function toggleSound() {
    gameState.soundEnabled = !gameState.soundEnabled;
    dom.soundToggle.textContent = t(gameState.soundEnabled ? 'sound_on' : 'sound_off');
    saveGame();
}

/* ===== Master volume (Settings slider) =====
 * Volume 0 = muted, > 0 = sound on. The value drives the EXISTING master gain node
 * (audioMaster), so every sound effect / reverb tail is scaled together.
 * gameState.soundEnabled is kept in sync so the legacy mute check in sfxReady() still works. */

/** Coerces any value to a number within 0..1 (invalid -> 1). */
function clampVolume(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 1;
    return Math.min(1, Math.max(0, n));
}

/** Smoothly ramps the master gain to the current volume (no clicks/zipper noise). */
function applyMasterVolume() {
    try {
        if (!audioCtx || !audioMaster || !audioMaster.gain) return;
        const target = adAudioMuted ? 0 : SFX_MASTER_VOLUME * clampVolume(gameState.volume);   // ad mute wins over the volume setting
        const now = audioCtx.currentTime;
        audioMaster.gain.cancelScheduledValues(now);
        audioMaster.gain.setValueAtTime(audioMaster.gain.value, now);
        audioMaster.gain.linearRampToValueAtTime(target, now + 0.03);
    } catch (e) { /* ignore */ }
}

/** Updates slider position, percentage text and icon from gameState.volume. */
function updateVolumeUI() {
    const v = clampVolume(gameState.volume);
    const pct = Math.round(v * 100);
    if (dom.volumeSlider) {
        if (Number(dom.volumeSlider.value) !== v) dom.volumeSlider.value = String(v);
        dom.volumeSlider.style.setProperty('--vol-fill', pct + '%');
        dom.volumeSlider.setAttribute('aria-valuetext', pct + '%');
    }
    if (dom.volumePercent) dom.volumePercent.textContent = pct + '%';
    if (dom.volumeIcon) dom.volumeIcon.textContent = v === 0 ? '🔇' : (v < 0.5 ? '🔉' : '🔊');
    if (dom.soundToggle) dom.soundToggle.textContent = t(gameState.soundEnabled ? 'sound_on' : 'sound_off');
}

/** Sets the master volume everywhere (state, audio graph, UI). Saving is optional (skipped while dragging). */
function setMasterVolume(value, persist) {
    const v = Math.round(clampVolume(value) * 100) / 100;
    gameState.volume = v;
    gameState.soundEnabled = v > 0;
    applyMasterVolume();
    updateVolumeUI();
    bgmSync();   // volume 0 stops the music scheduler; > 0 starts it again
    if (persist) saveGame();
}

/**
 * =========================================
 * BACKGROUND MUSIC (procedural, Web Audio API)
 * =========================================
 * Cozy-cave lofi ambient in C major (the same key as every sound effect, so SFX always harmonise).
 *
 *   72 BPM, 16th-note grid, light swing, 8-bar form:
 *     Cmaj9 | Am9 | Fmaj7 | G6/9 || Cmaj9 | Em7 | Am9 | Dm9
 *
 * Layers: warm detuned-sine pad (slow low-pass sweep) + low drone + soft sub bass, kalimba arpeggio,
 * sparse pentatonic kalimba melody (motifs repeat/answer each other), very soft lofi drums (they rest
 * in the first two bars of every 8-bar form), and occasional "water drop" cave textures.
 *
 * Signal chain (no second volume system - it rides on the existing master bus):
 *   voices -> session gain -> bus -> low-pass -> bgmOut (fade gain) -> audioMaster (master volume + ad mute)
 *                                  \-> dotted-8th echo                \-> shared reverb (audioReverb)
 *
 *  - audioMaster already applies gameState.volume and the ad mute, so effective BGM volume =
 *    master volume x BGM_LEVEL (never applied twice, never bypassed).
 *  - Exactly ONE lookahead scheduler (setInterval) exists, and only while the music is actually playing.
 *  - bgmSync() is the single decision point: music plays only if BGM is enabled AND sound is not muted AND
 *    no ad is playing AND the game is not paused AND the tab is visible AND the AudioContext is running.
 *  - Every note is a short-lived oscillator that disconnects itself when it ends (no leaks).
 */
const BGM_TEMPO = 72;
const BGM_BEAT = 60 / BGM_TEMPO;
const BGM_STEP = BGM_BEAT / 4;          // one 16th note
const BGM_BAR = BGM_STEP * 16;          // ~3.33 s
const BGM_LEVEL = 0.55;                 // music bus level relative to the SFX (music sits underneath the effects)
const BGM_FADE_IN = 1.6;                // seconds
const BGM_FADE_OUT = 0.45;              // seconds
const BGM_LOOKAHEAD = 1.0;              // seconds of music scheduled ahead of the audio clock
const BGM_TICK_MS = 250;                // scheduler wake-up interval
const BGM_SWING = 0.35;                 // off-8th delay, as a fraction of a 16th

const BGM_CHORDS = {
    Cmaj9: { bass: 36, pad: [52, 55, 59, 62] },
    Am9:   { bass: 33, pad: [52, 55, 60, 64] },
    Fmaj7: { bass: 41, pad: [53, 57, 60, 64] },
    G69:   { bass: 43, pad: [55, 59, 62, 64] },
    Em7:   { bass: 40, pad: [55, 59, 62, 67] },
    Dm9:   { bass: 38, pad: [53, 57, 60, 64] }
};
const BGM_FORM = ['Cmaj9', 'Am9', 'Fmaj7', 'G69', 'Cmaj9', 'Em7', 'Am9', 'Dm9'];
const BGM_PENTA = [67, 69, 72, 74, 76, 79, 81, 84];     // C major pentatonic ladder, G4..C6 (safe over every chord above)
const BGM_ARP_PATTERNS = [
    [[0, 0], [3, 1], [6, 2], [8, 3], [11, 2], [14, 1]],
    [[0, 0], [2, 1], [4, 2], [6, 3], [8, 2], [10, 1], [12, 2], [14, 1]],
    [[0, 0], [4, 2], [6, 1], [8, 3], [12, 2], [14, 0]],
    [[0, 0], [3, 2], [6, 1], [10, 3], [13, 2]]
];

const bgm = {
    inited: false,
    graph: null,        // persistent nodes: { out, bus }
    session: null,      // per-play gain; disconnecting it silences every note still scheduled by that play
    running: false,
    timer: null,
    step: 0,            // global 16th-note counter
    nextTime: 0,        // audio-clock time of the next step
    plan: null,         // current bar plan
    lastPattern: -1,
    melIdx: 3,
    lastMotif: null,
    noise: null,
    noiseChains: null,  // per-session band-pass/low-pass chains for the percussion noise
    noiseChainsFor: null
};

function bgmHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

/** One enveloped oscillator -> dest. Self-cleaning. o: { t, freq, type, peak, attack, hold, dur, detune, glideFrom, glideTime } */
function bgmTone(dest, o) {
    const ctx = audioCtx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const t = o.t, attack = o.attack || 0.01, hold = o.hold || 0;
    const end = t + Math.max(o.dur, attack + hold + 0.05);
    osc.type = o.type || 'sine';
    if (o.glideFrom) {
        osc.frequency.setValueAtTime(o.glideFrom, t);
        osc.frequency.exponentialRampToValueAtTime(o.freq, t + (o.glideTime || 0.05));
    } else {
        osc.frequency.setValueAtTime(o.freq, t);
    }
    if (o.detune) osc.detune.value = o.detune;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(Math.max(o.peak, 0.0002), t + attack);
    if (hold > 0) g.gain.setValueAtTime(Math.max(o.peak, 0.0002), t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(g);
    g.connect(dest);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch (e) { /* ignore */ } };
    osc.start(t);
    osc.stop(end + 0.05);
    return osc;
}

/**
 * Short band-passed noise hit (soft rim / hat).
 * Hiss fix: the old hit was raw white noise through a very wide band-pass (Q 0.7), so it carried a lot of
 * energy above 6 kHz on every 8th note. Now: shared softened noise -> narrower band-pass -> low-pass that
 * removes the top end -> envelope. Filters live in a small per-session chain (one pair per freq/Q) instead of
 * being rebuilt for every hit, and each hit only creates the source + its envelope.
 */
function bgmNoiseChain(dest, freq, q) {
    if (!bgm.noiseChains || bgm.noiseChainsFor !== dest) { bgm.noiseChains = {}; bgm.noiseChainsFor = dest; }
    const key = freq + '|' + q;
    let c = bgm.noiseChains[key];
    if (!c) {
        const ctx = audioCtx;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = Math.max(q, 1.2);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = Math.min(freq * 1.5, 4000); lp.Q.value = 0.5;
        bp.connect(lp); lp.connect(dest);
        c = bgm.noiseChains[key] = { input: bp };
    }
    return c;
}
function bgmNoiseHit(dest, t, freq, q, peak, dur) {
    const ctx = audioCtx;
    if (!bgm.noise || bgm.noise.sampleRate !== ctx.sampleRate) bgm.noise = sfxGetNoiseBuffer();
    const chain = bgmNoiseChain(dest, freq, q);
    const src = ctx.createBufferSource();
    src.buffer = bgm.noise;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.006);              // slightly softer onset than before (no "tick")
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(g); g.connect(chain.input);
    src.onended = () => { try { src.disconnect(); g.disconnect(); } catch (e) { /* ignore */ } };
    src.start(t, Math.random() * 0.6, dur + 0.05);
}

/** Warm pad + low drone + soft bass for one bar (pad releases over the next bar = smooth chord changes). */
function bgmPadAndBass(dest, chord, t) {
    const ctx = audioCtx;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass'; filt.Q.value = 0.3;
    const f0 = 800 * (0.85 + Math.random() * 0.35);
    filt.frequency.setValueAtTime(f0, t);
    filt.frequency.linearRampToValueAtTime(f0 * 1.6, t + BGM_BAR * 0.6);
    filt.frequency.linearRampToValueAtTime(f0 * 0.9, t + BGM_BAR + 1.8);
    filt.connect(dest);
    const attack = 1.0, hold = BGM_BAR - attack, dur = BGM_BAR + 1.8;
    let last = null;
    chord.pad.forEach((m) => {
        const hz = bgmHz(m);
        bgmTone(filt, { t, freq: hz, peak: 0.020, attack, hold, dur, detune: -5 });
        last = bgmTone(filt, { t, freq: hz, peak: 0.020, attack, hold, dur, detune: 5 });
    });
    if (last) { const prev = last.onended; last.onended = () => { if (prev) prev(); try { filt.disconnect(); } catch (e) { /* ignore */ } }; }
    // Low cozy drone (octave above the bass, slow bloom)
    bgmTone(dest, { t, freq: bgmHz(chord.bass + 12), peak: 0.030, attack: 1.4, hold: BGM_BAR - 1.4, dur: BGM_BAR + 2.0 });
    // Soft sub bass (sine + quiet 2nd harmonic so phone speakers can still hear it)
    const bf = bgmHz(chord.bass);
    bgmTone(dest, { t, freq: bf, peak: 0.100, attack: 0.03, dur: BGM_BAR * 0.92 });
    bgmTone(dest, { t, freq: bf * 2, type: 'triangle', peak: 0.020, attack: 0.03, dur: BGM_BAR * 0.5 });
}

/** Kalimba-style pluck: round fundamental + short octave + faint twelfth. */
function bgmKalimba(dest, t, midi, peak, dur) {
    const f = bgmHz(midi);
    bgmTone(dest, { t, freq: f, peak, attack: 0.004, dur });
    bgmTone(dest, { t, freq: f * 2, peak: peak * 0.26, attack: 0.003, dur: dur * 0.35 });
    bgmTone(dest, { t, freq: f * 3, peak: peak * 0.07, attack: 0.003, dur: 0.22 });
}

function bgmChordPcs(chord) {
    const pcs = chord.pad.map((m) => m % 12);
    pcs.push(chord.bass % 12);
    return pcs;
}

/** Sparse pentatonic motif (2-4 notes); sometimes repeats the previous one so it feels like a hook. */
function bgmPlanMelody(chord, barInForm) {
    const out = {};
    if (Math.random() < 0.30) return out;                                   // rest bar = breathing room
    if (bgm.lastMotif && Math.random() < 0.35) {                            // call & response
        bgm.lastMotif.forEach((n) => { out[n.s] = n.idx; });
        return out;
    }
    const slots = [0, 2, 3, 4, 6, 8, 10, 12, 14];
    const count = 2 + Math.floor(Math.random() * 3);
    const chosen = [];
    for (let tries = 0; tries < 20 && chosen.length < count; tries++) {
        const s = slots[Math.floor(Math.random() * slots.length)];
        if (chosen.every((c) => Math.abs(c - s) >= 2)) chosen.push(s);
    }
    chosen.sort((a, b) => a - b);
    const pcs = bgmChordPcs(chord);
    const snap = (from) => {                                                // nearest ladder note that is a chord tone
        let best = from, bestD = 99;
        BGM_PENTA.forEach((m, i) => { if (pcs.indexOf(m % 12) !== -1 && Math.abs(i - from) < bestD) { best = i; bestD = Math.abs(i - from); } });
        return best;
    };
    let idx = snap(bgm.melIdx);
    const motif = [];
    chosen.forEach((s, k) => {
        if (k > 0) {
            const deltas = [-2, -1, -1, 0, 1, 1, 2];
            idx = Math.min(BGM_PENTA.length - 1, Math.max(0, idx + deltas[Math.floor(Math.random() * deltas.length)]));
            if (k === chosen.length - 1 && barInForm % 2 === 1) idx = snap(idx);   // resolve on chord tone at phrase ends
        }
        motif.push({ s, idx });
        out[s] = idx;
    });
    bgm.melIdx = idx;
    bgm.lastMotif = motif;
    return out;
}

/** Builds the plan for the bar starting at time t and schedules its pad/bass. */
function bgmBeginBar(bar, t) {
    const barInForm = bar % 8, cycle = Math.floor(bar / 8);
    const chord = BGM_CHORDS[BGM_FORM[barInForm]];
    bgmPadAndBass(bgm.session, chord, t);

    // Melody first, so the arpeggio can leave those steps free
    const melody = bgmPlanMelody(chord, barInForm);

    // Arpeggio: different pattern from last bar, density breathes over the cycles
    let p;
    do { p = Math.floor(Math.random() * BGM_ARP_PATTERNS.length); } while (p === bgm.lastPattern && BGM_ARP_PATTERNS.length > 1);
    bgm.lastPattern = p;
    const skip = [0.10, 0.12, 0.30][cycle % 3];
    const arp = {};
    BGM_ARP_PATTERNS[p].forEach(([s, i]) => {
        if (s !== 0 && Math.random() < skip) return;
        if (melody[s] !== undefined) return;
        arp[s] = { midi: chord.pad[i] + 12, vel: 0.7 + Math.random() * 0.3 };
    });

    // Optional water-drop texture
    let drip = -1;
    if (Math.random() < 0.30) drip = 1 + Math.floor(Math.random() * 14);

    bgm.plan = { chord, barInForm, melody, arp, drip, drums: barInForm >= 2, ghost: Math.random() < 0.4 && barInForm % 2 === 1 };
}

function bgmScheduleStep(step, t) {
    const s = step % 16;
    if (s === 0) bgmBeginBar((step - s) / 16, t);
    const plan = bgm.plan, dest = bgm.session;
    if (!plan || !dest) return;
    const tt = t + ((s % 4 === 2) ? BGM_STEP * BGM_SWING : 0);

    if (plan.arp[s]) bgmKalimba(dest, tt, plan.arp[s].midi, 0.040 * plan.arp[s].vel, 1.1);
    if (plan.melody[s] !== undefined) bgmKalimba(dest, tt, BGM_PENTA[plan.melody[s]], 0.070, 1.8);

    if (plan.drums) {
        if (s === 0 || s === 8) bgmTone(dest, { t: tt, freq: 52, glideFrom: 125, glideTime: 0.13, peak: 0.12, attack: 0.003, dur: 0.38 });
        else if (s === 11 && plan.ghost) bgmTone(dest, { t: tt, freq: 52, glideFrom: 110, glideTime: 0.12, peak: 0.06, attack: 0.003, dur: 0.30 });
        if (s === 4 || s === 12) bgmNoiseHit(dest, tt, 1500, 0.9, 0.035, 0.12);
        if (s % 2 === 0) bgmNoiseHit(dest, tt, 2400, 0.7, s % 4 === 2 ? 0.020 : 0.012, 0.05);   // hat: centre 3000 -> 2400 Hz (warmer, less sizzle)
    }
    if (s === plan.drip) {
        const m = [84, 86, 88, 91][Math.floor(Math.random() * 4)];
        const f = bgmHz(m);
        bgmTone(dest, { t: tt, freq: f, glideFrom: f * 0.82, glideTime: 0.06, peak: 0.035, attack: 0.003, dur: 1.3 });
        bgmTone(dest, { t: tt + 0.19, freq: f, glideFrom: f * 0.82, glideTime: 0.06, peak: 0.014, attack: 0.003, dur: 0.9 });
    }
}

/** Lookahead scheduler tick: schedules only the next ~1 s of music. */
function bgmTick() {
    if (!bgm.running) return;
    const ctx = audioCtx;
    if (!ctx || ctx.state !== 'running') { bgmSync(); return; }
    try {
        const now = ctx.currentTime;
        if (bgm.nextTime < now - 0.25) {                       // timer was starved: jump to the next bar instead of bursting
            bgm.step = Math.ceil(bgm.step / 16) * 16;
            bgm.nextTime = now + 0.1;
        }
        const horizon = now + BGM_LOOKAHEAD;
        let guard = 0;
        while (bgm.nextTime < horizon && guard++ < 48) {
            bgmScheduleStep(bgm.step, bgm.nextTime);
            bgm.nextTime += BGM_STEP;
            bgm.step++;
        }
    } catch (e) {
        console.warn('Background music error:', e);
        bgmStop();
    }
}

/** Builds the persistent music graph once. */
function bgmEnsureGraph() {
    if (bgm.graph) return true;
    if (!audioCtx || !audioMaster) return false;
    try {
        const ctx = audioCtx;
        const out = ctx.createGain(); out.gain.value = 0;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3600; lp.Q.value = 0.5;
        const bus = ctx.createGain();
        bus.connect(lp); lp.connect(out); out.connect(audioMaster);
        // Dotted-eighth echo (tempo synced, dark feedback) for depth
        const send = ctx.createGain(); send.gain.value = 0.30;
        const delay = ctx.createDelay(2.0); delay.delayTime.value = BGM_BEAT * 0.75;
        const fb = ctx.createGain(); fb.gain.value = 0.36;
        const fl = ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 2200;
        bus.connect(send); send.connect(delay); delay.connect(fl); fl.connect(fb); fb.connect(delay); fl.connect(lp);
        // Shared reverb (post fade gain, so it fades with the music)
        if (audioReverb) { const rv = ctx.createGain(); rv.gain.value = 0.40; out.connect(rv); rv.connect(audioReverb); }
        bgm.graph = { out, bus };
        return true;
    } catch (e) {
        console.warn('Background music graph failed:', e);
        bgm.graph = null;
        return false;
    }
}

/** Everything except the AudioContext state: should the player be hearing music right now? */
function bgmWanted() {
    if (gameState.bgmEnabled === false) return false;
    if (adAudioMuted) return false;                                                       // advertisement running
    if (!gameState.soundEnabled || !(clampVolume(gameState.volume) > 0)) return false;   // master muted / volume 0
    if (typeof document !== 'undefined' && document.hidden) return false;
    try { if (isGamePaused()) return false; } catch (e) { /* pause system not ready yet */ }
    return true;
}

function bgmStart() {
    if (bgm.running || !bgmEnsureGraph()) return;
    const ctx = audioCtx, now = ctx.currentTime;
    bgm.session = ctx.createGain();
    bgm.session.connect(bgm.graph.bus);
    bgm.running = true;
    bgm.step = Math.ceil(bgm.step / 16) * 16;          // always begin on a bar line
    bgm.nextTime = now + 0.12;
    const g = bgm.graph.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(BGM_LEVEL, now + BGM_FADE_IN);
    clearInterval(bgm.timer);
    bgm.timer = setInterval(bgmTick, BGM_TICK_MS);
    bgmTick();
}

function bgmStop() {
    if (!bgm.running) return;
    bgm.running = false;
    clearInterval(bgm.timer);
    bgm.timer = null;
    const old = bgm.session;
    bgm.session = null;
    bgm.plan = null;
    try {
        const ctx = audioCtx, g = bgm.graph.out.gain, now = ctx.currentTime;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(0, now + BGM_FADE_OUT);
    } catch (e) { /* ignore */ }
    // After the fade, cut whatever that play had already scheduled (so it can never sound later).
    setTimeout(() => { try { if (old) old.disconnect(); } catch (e) { /* ignore */ } }, BGM_FADE_OUT * 1000 + 80);
}

/** The single decision point. Cheap and idempotent: call it whenever anything audio-related changes. */
function bgmSync() {
    try {
        if (bgmWanted() && audioCtx && audioMaster && audioCtx.state === 'running') bgmStart();
        else bgmStop();
    } catch (e) { /* TDZ / audio errors must never break the game */ }
}

/** Called by initAudio() right after the AudioContext + master bus are created. */
function bgmOnAudioReady() {
    try {
        if (audioCtx.addEventListener) audioCtx.addEventListener('statechange', bgmSync);
        if (audioCtx.state !== 'running') sfxResume();
    } catch (e) { /* ignore */ }
    bgmSync();
}

/** Settings button state. */
function updateBgmUI() {
    const btn = dom.bgmToggle;
    if (!btn) return;
    const on = gameState.bgmEnabled !== false;
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    btn.classList.toggle('is-on', on);
    const st = btn.querySelector('.bgm-toggle-state');
    if (st) st.textContent = on ? 'ON' : 'OFF';
}

/** One-time wiring (called from initGame). Never creates an AudioContext by itself. */
function initBgm() {
    if (bgm.inited) return;
    bgm.inited = true;
    updateBgmUI();
    if (dom.bgmToggle) {
        dom.bgmToggle.addEventListener('click', () => {
            initAudio();                                   // valid user gesture: creates / resumes the context
            gameState.bgmEnabled = gameState.bgmEnabled === false;
            updateBgmUI();
            bgmSync();
            saveGame();
        });
    }
    // Pause / resume (manual pause, ads) and tab visibility all funnel into bgmSync().
    window.addEventListener('gc:pause', bgmSync);
    window.addEventListener('gc:resume', bgmSync);
    const wake = () => {
        if (document.hidden) { bgmSync(); return; }
        if (audioCtx && audioCtx.state !== 'running' && bgmWanted()) sfxResume();   // iOS "interrupted" / suspended after a tab switch
        bgmSync();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('pageshow', wake);
    // A suspended context can only be resumed by a gesture: nudge it on the next tap if the music should be playing.
    ['pointerdown', 'touchend', 'keydown'].forEach((ev) => {
        window.addEventListener(ev, () => {
            if (audioCtx && audioCtx.state !== 'running' && bgmWanted()) sfxResume();
        }, { capture: true, passive: true });
    });
}

/** Shimmering ascending arpeggio played when a Golden Meteor / Glowing Crystal spawns (A-major, airy). */
function playMiniEventSpawnSound() {
    if (!sfxReady() || !sfxThrottle('miniSpawn', 200)) return;
    [880, 1108.73, 1318.51].forEach((f, i) => { // A5, C#6, E6
        sfxNote({ freq: f, delay: i * 0.07, duration: 0.5, volume: 0.07, timbre: 'bell', reverb: 0.35 });
    });
}

/** Rewarding chime played when the player successfully clicks a mini-event (G5 -> D6 -> G6). */
function playMiniEventCollectSound() {
    if (!sfxReady() || !sfxThrottle('miniCollect', 80)) return;
    sfxThump({ freq: 200, endFreq: 110, duration: 0.1, volume: 0.07, noise: 0.3 });
    sfxNote({ freq: SFX_NOTES.G5, duration: 0.4, volume: 0.13, timbre: 'pluck', reverb: 0.2 });
    sfxNote({ freq: SFX_NOTES.D6, delay: 0.07, duration: 0.5, volume: 0.12, timbre: 'bell', reverb: 0.25 });
    sfxNote({ freq: SFX_NOTES.G6, delay: 0.14, duration: 0.7, volume: 0.09, timbre: 'bell', reverb: 0.35 });
}

/** Soft descending "fizzle" sound played when a mini-event despawns unclicked. */
function playMiniEventDespawnSound() {
    if (!sfxReady() || !sfxThrottle('miniDespawn', 200)) return;
    sfxNote({ freq: 520, glideTo: 260, duration: 0.45, volume: 0.06, timbre: 'sine', attack: 0.02, reverb: 0.2 });
}

/** Chest opening, part 1: the chest shakes - soft wooden rattles with a rising shimmer. */
function playChestShakeSound() {
    if (!sfxReady()) return;
    [170, 195, 180, 205].forEach((f, i) => {
        sfxThump({ freq: f, endFreq: f * 0.7, duration: 0.09, volume: 0.06, noise: 0.6, delay: i * 0.115 });
    });
    sfxNote({
        freq: SFX_NOTES.C5, glideTo: SFX_NOTES.C6, glideTime: 0.5, duration: 0.55,
        volume: 0.035, timbre: 'soft', attack: 0.25, reverb: 0.3
    });
}

/** Chest opening, part 2: the lid pops open - sparkling crystalline arpeggio (C6-E6-G6-C7) with random twinkles. */
function playChestOpenChime() {
    if (!sfxReady()) return;
    sfxThump({ freq: 150, endFreq: 70, duration: 0.2, volume: 0.10, noise: 0.4 });
    sfxChord({
        freqs: [SFX_NOTES.C5, SFX_NOTES.E5, SFX_NOTES.G5],
        delay: 0.04, duration: 0.9, volume: 0.09, timbre: 'soft', hold: 0.1, reverb: 0.3
    });
    [SFX_NOTES.C6, SFX_NOTES.E6, SFX_NOTES.G6, SFX_NOTES.C7].forEach((f, i) => {
        sfxNote({ freq: f, delay: 0.04 + i * 0.055, duration: 0.6, volume: 0.09, timbre: 'bell', reverb: 0.35 });
    });
    const sparkles = [SFX_NOTES.E6, SFX_NOTES.G6, SFX_NOTES.A6, SFX_NOTES.C7];
    for (let i = 0; i < 3; i++) {
        const f = sparkles[Math.floor(Math.random() * sparkles.length)];
        sfxNote({ freq: f, delay: 0.28 + i * 0.07 + Math.random() * 0.04, duration: 0.35, volume: 0.035, timbre: 'bell', reverb: 0.4 });
    }
}

/**
 * Chest opening, part 3: the reward is revealed. Scales with rarity:
 * common = single chime, rare = two-note lift, legendary = mini fanfare.
 * @param {'common'|'rare'|'legendary'} rarity
 */
function playChestRewardSound(rarity) {
    if (!sfxReady()) return;
    if (rarity === 'legendary') {
        [SFX_NOTES.C5, SFX_NOTES.E5, SFX_NOTES.G5, SFX_NOTES.C6].forEach((f, i) => {
            sfxNote({ freq: f, delay: i * 0.09, duration: 0.5, volume: 0.12, timbre: 'pluck', reverb: 0.3, priority: true });
        });
        sfxChord({
            freqs: [SFX_NOTES.C5, SFX_NOTES.G5, SFX_NOTES.C6, SFX_NOTES.E6],
            delay: 0.36, duration: 1.4, volume: 0.15, timbre: 'soft', hold: 0.3, reverb: 0.35, priority: true
        });
        sfxNote({ freq: SFX_NOTES.G6, delay: 0.5, duration: 1.0, volume: 0.05, timbre: 'bell', reverb: 0.45, priority: true });
    } else if (rarity === 'rare') {
        sfxNote({ freq: SFX_NOTES.G5, duration: 0.4, volume: 0.13, timbre: 'pluck', reverb: 0.25 });
        sfxNote({ freq: SFX_NOTES.D6, delay: 0.09, duration: 0.7, volume: 0.12, timbre: 'bell', reverb: 0.3 });
        sfxNote({ freq: SFX_NOTES.G6, delay: 0.18, duration: 0.8, volume: 0.07, timbre: 'bell', reverb: 0.35 });
    } else {
        sfxNote({ freq: SFX_NOTES.E6, duration: 0.6, volume: 0.11, timbre: 'bell', reverb: 0.25 });
    }
}

/**
 * Formats large numbers for readability using standard short-scale suffixes
 * (K, M, B, T, Qa, Qi), automatically falling back to scientific notation
 * (e.g. 1.23e21) once a number exceeds the largest named suffix so labels
 * never overflow or become unreadable at extreme late-game values.
 * @param {number} num
 * @returns {string}
 */
function formatNumber(num) {
    // === Hardened: explicitly guard against NaN/Infinity/-Infinity so
    // extreme values (overflow from runaway multipliers, corrupted
    // saves, etc.) never leak "NaN" or "Infinity" into the UI.
    if (num === null || num === undefined || typeof num !== 'number' || isNaN(num) || !isFinite(num)) {
        return '0';
    }

    const sign = num < 0 ? '-' : '';
    const abs = Math.abs(num);

    if (abs < 1000) {
        // Preserve two decimal places for small fractional values (e.g. XP costs),
        // but show whole numbers cleanly when there's no fractional part.
        return sign + (Number.isInteger(abs) ? abs.toString() : abs.toFixed(2));
    }

    const units = ["K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No"];
    const maxUnitValue = 1000 ** (units.length + 1); // beyond this, switch to scientific notation

    if (abs >= maxUnitValue) {
        return sign + abs.toExponential(2).replace('+', '');
    }

    let unitIndex = -1;
    let n = abs;
    while (n >= 1000 && unitIndex < units.length - 1) {
        n /= 1000;
        unitIndex++;
    }
    return sign + n.toFixed(2) + units[unitIndex];
}

/**
 * Returns the current level multiplier applied to all gold earnings.
 * Each level grants a +10% multiplier (level 1 = no bonus).
 * @returns {number}
 */
function getLevelMultiplier() {
    return 1 + (gameState.level - 1) * 0.1;
}

/**
 * Returns the combined multiplier applied to ALL gold earnings:
 * the per-level multiplier stacked with the permanent Prestige (Gem)
 * multiplier. Used everywhere gold is granted (clicks, CPS, offline).
 * @returns {number}
 */
function getTotalMultiplier() {
    const tc = statCache.total;
    const gs = gameState;
    const now = GCTime.now();
    const dBuff = gs.dailyLogin ? gs.dailyLogin.activeBuff : null;
    const shop = gs.shopState;
    const vip = shop ? shop.isVIP : null;
    const vipExp = shop ? shop.vipExpires : null;
    if (tc.valid && now < tc.validUntil && tc.level === gs.level && tc.prestige === gs.prestigeMultiplier
        && tc.biome === gs.currentBiome && tc.dBuff === dBuff && tc.eBuff === gs.eventBuff
        && tc.vip === vip && tc.vipExp === vipExp && tc.relicVer === statCache.relicVer) {
        return tc.value;
    }
    // Same formula as always - just evaluated once per change instead of on every click / tick.
    const value = getLevelMultiplier() * gs.prestigeMultiplier * getZoneMultiplier() * getBuffCpsMultiplier()
        * getRelicCpsMultiplier() * getEventBuffCpsMultiplier() * getGoldMultiplier();
    tc.value = value;
    tc.level = gs.level;
    tc.prestige = gs.prestigeMultiplier;
    tc.biome = gs.currentBiome;
    tc.dBuff = gs.dailyLogin ? gs.dailyLogin.activeBuff : null; // re-read: expired buffs were just cleared
    tc.eBuff = gs.eventBuff;
    tc.vip = gs.shopState ? gs.shopState.isVIP : null;
    tc.vipExp = gs.shopState ? gs.shopState.vipExpires : null;
    tc.relicVer = statCache.relicVer;
    tc.validUntil = earliestStatExpiry();
    tc.valid = true;
    return value;
}

/**
 * =========================================
 * BIOME / MINE DEPTH SYSTEM
 * =========================================
 */

/** Returns the highest biome the player's current level qualifies for. */
function getBiomeForLevel(level) {
    let result = BIOMES[0];
    for (const biome of BIOMES) {
        if (level >= biome.requiredLevel) {
            result = biome;
        }
    }
    return result;
}

/** Returns the full biome config object for gameState.currentBiome. */
function getCurrentBiomeData() {
    return BIOMES.find(b => b.key === gameState.currentBiome) || BIOMES[0];
}

/** Returns the current zone multiplier (Surface = 1x, Iron = 5x, etc). */
function getZoneMultiplier() {
    return getCurrentBiomeData().zoneMultiplier;
}

/**
 * Checks the player's level against the biome list and transitions to a
 * deeper biome if they now qualify, applying visuals and an announcement.
 * Safe to call on every level-up and once on load.
 */
function checkBiomeProgression() {
    const eligible = getBiomeForLevel(gameState.level);
    if (eligible.key !== gameState.currentBiome) {
        gameState.currentBiome = eligible.key;
        applyBiomeVisuals(true);
        if (eligible.announcement) {
            setTimeout(() => showDepthDiscoveredModal(eligible), 400);
        }
    }
}

/**
 * Displays the "New Depth Discovered!" modal for a given biome.
 * @param {Object} biome - a BIOMES entry
 */
let lastDepthBiome = null;
function showDepthDiscoveredModal(biome) {
    lastDepthBiome = biome;
    dom.depthModalIcon.textContent = biome.icon;
    dom.depthModalName.textContent = biome.name;
    dom.depthModalMult.textContent = t('zone_multiplier', { mult: formatNumber(biome.zoneMultiplier) });
    dom.depthModalText.textContent = biome.announcement || '';
    dom.depthModalOverlay.classList.add('open');
    playLevelUpSound();
}

/** Closes the "New Depth Discovered!" modal. */
function closeDepthDiscoveredModal() {
    dom.depthModalOverlay.classList.remove('open');
}

/**
 * Applies the current biome's body class and updates the depth indicator UI.
 * @param {boolean} animateTransition - whether to play the glow transition
 */
function applyBiomeVisuals(animateTransition = false) {
    const biome = getCurrentBiomeData();

    // Remove all biome classes, then apply the current one (if any)
    for (const b of BIOMES) {
        if (b.bodyClass) document.body.classList.remove(b.bodyClass);
    }
    if (biome.bodyClass) document.body.classList.add(biome.bodyClass);

    // Update the depth indicator text
    dom.depthIcon.textContent = biome.icon;
    dom.depthName.textContent = biome.name;

    // Update the zone info bar shown above the clicker button
    if (dom.zoneInfoName && dom.zoneInfoMult) {
        dom.zoneInfoName.textContent = `${biome.icon} ${biome.name}`;
        dom.zoneInfoMult.textContent = t('zone_multiplier', { mult: formatNumber(biome.zoneMultiplier) });
    }

    // Update the click button's label to match the current biome's material
    if (dom.clickButton && biome.clickLabel) {
        dom.clickButton.textContent = biome.clickLabel;
    }

    // === NEW: Adaptive biome particles ===
    // Re-style the ambient particle field to match the new biome (fiery
    // sparks for lava, glowing spores for the grotto, etc). Safe no-op
    // if the particle field element isn't present in the DOM.
    updateBiomeParticles(biome);

    const currentIndex = BIOMES.findIndex(b => b.key === biome.key);
    const next = BIOMES[currentIndex + 1];
    dom.depthNext.textContent = next
        ? t('depth_next', { level: next.requiredLevel, name: next.name })
        : t('depth_deepest');

    if (animateTransition) {
        dom.depthIndicator.classList.remove('depth-transition');
        void dom.depthIndicator.offsetWidth; // force reflow to allow re-trigger
        dom.depthIndicator.classList.add('depth-transition');
        setTimeout(() => dom.depthIndicator.classList.remove('depth-transition'), 1200);
    }
}

/**
 * === NEW: Adaptive Biome Particles ===
 * Re-styles the ambient "#biome-particle-field" (populated with plain
 * <span> children by the inline bootstrap script in the HTML) so its
 * color and visual character changes per biome — e.g. dusty motes on
 * the Surface, fiery embers in the Magma Core, glowing spores in the
 * Grotto, starlight motes in the Celestial Core.
 *
 * Approach: rather than requiring a full markup change, this stamps a
 * biome-specific class onto the field container (for CSS-driven glow/
 * color hooks games may already style via body.biome-xxx selectors)
 * AND writes small inline touches (color, glyph, text-shadow) directly
 * onto each existing particle <span>, so it works even if no matching
 * CSS class exists yet for a given biome. This keeps the existing particle
 * count/positions/timing (still governed by the original inline
 * initBiomeParticles script) untouched — only their look changes.
 * @param {Object} biome - a BIOMES entry (with the new `particleStyle` field)
 */
const biomeParticleCache = { field: null, spans: null, key: null };
function updateBiomeParticles(biome) {
    let field = biomeParticleCache.field;
    if (!field || !field.isConnected) {
        field = document.getElementById('biome-particle-field');
        biomeParticleCache.field = field;
        biomeParticleCache.spans = null;
        biomeParticleCache.key = null;
    }
    if (!field) return;

    const style = biome.particleStyle || { symbol: '·', color: '#d8c9a3', glow: 'rgba(216, 201, 163, 0.5)', className: 'particle-surface' };

    // The particle <span>s are created once and reused for the whole session (fixed count, no per-frame
    // churn). The span list is cached, and nothing is touched again unless the biome look really changed.
    if (!biomeParticleCache.spans || biomeParticleCache.spans.length !== field.childElementCount) {
        biomeParticleCache.spans = Array.from(field.querySelectorAll('span'));
        biomeParticleCache.key = null;
    }
    if (biomeParticleCache.key === style.className) return;
    biomeParticleCache.key = style.className;

    // Swap the field's biome-specific class (all past ones removed first)
    for (const b of BIOMES) {
        if (b.particleStyle && b.particleStyle.className) {
            field.classList.remove(b.particleStyle.className);
        }
    }
    field.classList.add(style.className);

    // Re-skin each existing particle span in place (color/glyph/glow), leaving position/timing/
    // animation-delay untouched so the ambient motion doesn't restart on a biome transition.
    const shadow = `0 0 6px ${style.glow}`;
    const spans = biomeParticleCache.spans;
    for (let i = 0; i < spans.length; i++) {
        const span = spans[i];
        if (span.textContent !== style.symbol) span.textContent = style.symbol;
        span.style.color = style.color;
        span.style.textShadow = shadow;
    }
}

/**
 * Returns the current effective gold-per-click, including all
 * Golden Pickaxe bonuses and any Dwarven Forge click-multiplier skills,
 * before crit and level/prestige multipliers are applied.
 * @returns {number}
 */
function getBaseClickAmount() {
    const cc = statCache.click;
    const gs = gameState;
    const pickaxe = gs.upgrades.goldenPickaxe;
    const owned = pickaxe ? pickaxe.owned : 0;
    const dBuff = gs.dailyLogin ? gs.dailyLogin.activeBuff : null;
    if (cc.valid && GCTime.now() < cc.validUntil && cc.cpc === gs.coinsPerClick && cc.pickaxeOwned === owned
        && cc.skillVer === statCache.skillVer && cc.relicVer === statCache.relicVer
        && cc.dBuff === dBuff && cc.eBuff === gs.eventBuff) {
        return cc.value;
    }
    const clickBonus = pickaxe ? pickaxe.clickBonus * pickaxe.owned * getShopEfficiencyMultiplier() : 0;
    const value = (gs.coinsPerClick + clickBonus) * getSkillClickMultiplier() * getBuffClickMultiplier()
        * getRelicClickMultiplier() * getEventBuffClickMultiplier();
    cc.value = value;
    cc.cpc = gs.coinsPerClick;
    cc.pickaxeOwned = owned;
    cc.skillVer = statCache.skillVer;
    cc.relicVer = statCache.relicVer;
    cc.dBuff = gs.dailyLogin ? gs.dailyLogin.activeBuff : null;
    cc.eBuff = gs.eventBuff;
    cc.validUntil = earliestStatExpiry();
    cc.valid = true;
    return value;
}

/**
 * =========================================
 * SKILL TREE HELPERS
 * =========================================
 * These read gameState.skillLevels and fold each owned skill's
 * level-scaled effect into the relevant part of the game's math. Called
 * from the existing click/CPS/crit/XP/cost calculations above and below.
 */

/**
 * Global helper: returns the current upgrade level (0-MAX_SKILL_LEVEL)
 * of a given skill. This is the single source of truth for "how many
 * levels of this skill does the player currently own" across all game
 * calculations and UI rendering.
 * @param {string} key
 * @returns {number}
 */
function getSkillLevel(key) {
    return gameState.skillLevels[key] || 0;
}

/** Whether a given skill has at least one level purchased. */
function hasSkill(key) {
    return getSkillLevel(key) > 0;
}

/** Whether a given skill is at its maximum level. */
function isSkillMaxed(key) {
    return getSkillLevel(key) >= MAX_SKILL_LEVEL;
}

/** Combined multiplier from all owned "clickMultiplier" skills (multiplicative, scales with level). */
function getSkillClickMultiplier() {
    return ensureSkillCache().click;
}

/** Combined multiplier from all owned "cpsMultiplier" skills (multiplicative, scales with level). */
function getSkillCpsMultiplier() {
    return ensureSkillCache().cps;
}

/** Combined flat bonus from all owned "critChanceFlat" skills (scales with level). */
function getSkillCritChanceBonus() {
    return ensureSkillCache().crit;
}

/** Combined flat bonus from all owned "xpBoostFlat" skills (scales with level). */
function getSkillXpBonus() {
    return ensureSkillCache().xp;
}

/**
 * Combined multiplier applied to the effect of every shop upgrade
 * (e.g. Automated Minecarts). Applied on top of flatCps/percentCps/
 * clickPower/critChance/xpBoost contributions from owned shop items.
 * Scales with each shopEfficiency skill's current level.
 * @returns {number}
 */
function getShopEfficiencyMultiplier() {
    return ensureSkillCache().shopEff;
}

/**
 * Combined reduction applied to shop price growth rates (e.g. Dwarven
 * Haggling). A growthRate of 1.15 with a 10% total reduction on its
 * "growth portion" becomes 1 + 0.15 * (1 - 0.10) = 1.135. Scales with
 * each costReduction skill's current level.
 * @returns {number} a value in (0, 1] to multiply against (growthRate - 1)
 */
function getSkillCostReductionFactor() {
    return ensureSkillCache().costRed;
}

/**
 * Returns the effective growth rate for a shop upgrade after applying
 * any Dwarven Haggling-style cost-reduction skills.
 * @param {Object} upgrade
 * @returns {number}
 */
function getEffectiveGrowthRate(upgrade) {
    const growthPortion = upgrade.growthRate - 1;
    return 1 + growthPortion * getSkillCostReductionFactor() * getRelicShopCostReductionFactor();
}

/**
 * Adds gold to the player's balance and keeps the lifetime earnings
 * counter (used for Gem calculations) in sync. All gold gains should
 * flow through this helper rather than mutating gameState.coins directly.
 * @param {number} amount
 */
function addCoins(amount) {
    gameState.coins += amount;
    gameState.totalCoinsEarned += amount;
    gameState.questProgress.coinsEarnedSession += amount;
}

/**
 * Handles a manual click on the main mining button.
 * Adds coins (with click upgrades, crit chance, and level/prestige multipliers),
 * grants experience, and triggers visual feedback.
 */
function handleManualClick(event) {
    if (isGamePaused()) return;   // no input while an advertisement (or any other pause reason) is active
    initAudio(); // Ensure audio context exists after first user interaction

    const isCrit = Math.random() < gameState.critChance;
    let earned = getBaseClickAmount() * getTotalMultiplier();

    if (isCrit) {
        earned *= (gameState.critMultiplier + getRelicCritMultiplierBonus());
    }

    addCoins(earned);

    // Quest/Achievement tracking: manual clicks and critical clicks
    gameState.questProgress.clicks += 1;
    gameState.achievementProgress.clicks += 1;
    if (isCrit) {
        gameState.questProgress.critClicks += 1;
        gameState.achievementProgress.critClicks += 1;
    }

    // Expedition Pass quest tracking: manual clicks and critical clicks
    gameState.pass.dailyProgress.clicks += 1;
    gameState.pass.weeklyProgress.clicks += 1;
    if (isCrit) {
        gameState.pass.dailyProgress.critClicks += 1;
    }

    if (isCrit) {
        playCritSound();
    } else {
        playClickSound();
    }

    spawnFloatingText(event, earned, isCrit);
    gainExperience(earned);
    updateUI(); // batched: quest / pass / shop UI refresh from the frame renderer, not per click
}

/**
 * Creates a floating "+X" text near the click position for visual feedback.
 * Multiple instances can coexist since each is an independent DOM element.
 * @param {MouseEvent} event
 * @param {number} amount - actual gold earned from this click
 * @param {boolean} isCrit - whether this click was a Critical Click
 */
let floatTextPool = null;
function spawnFloatingText(event, amount, isCrit = false) {
    // Popups are recycled (hard-capped pool) and restarted in one batched reflow per frame,
    // instead of creating + removing a DOM node and forcing styles for every click.
    if (!floatTextPool) floatTextPool = GCFrame.createPool({ max: 40, lifeMs: 800 });
    const offsetX = (Math.random() - 0.5) * 40; // slight randomness for a natural feel
    floatTextPool.show({
        className: 'float-text' + (isCrit ? ' float-text-crit' : ''),
        text: isCrit ? t('crit_float', { amount: formatNumber(amount) }) : '+' + formatNumber(amount),
        left: (event.clientX + offsetX) + 'px',
        top: (event.clientY - 20) + 'px'
    });
}

/**
 * Computes the total cost to buy `n` additional levels of an upgrade,
 * starting from its current `owned` count, taking the upgrade's geometric
 * price growth into account:
 *
 *   total = price(owned) * (growthRate^n - 1) / (growthRate - 1)
 *
 * where price(owned) is the cost of the NEXT single unit (upgrade.price,
 * which already reflects `owned` purchases). This is the standard closed
 * form for summing a geometric series, and matches the incremental math
 * used by buyUpgrade for n = 1.
 * @param {Object} upgrade
 * @param {number} n - number of levels to buy (n >= 1)
 * @returns {number} total gold cost for n levels
 */
function getBulkCost(upgrade, n) {
    if (n <= 0) return 0;
    const r = getEffectiveGrowthRate(upgrade);
    if (Math.abs(r - 1) < 1e-9) {
        // Degenerate case: no growth, cost is just price * n
        return upgrade.price * n;
    }
    return upgrade.price * (Math.pow(r, n) - 1) / (r - 1);
}

/**
 * Determines the maximum number of levels of an upgrade the player can
 * currently afford, along with the total gold cost for that quantity.
 * Uses the closed-form geometric series inverse (solving for n given a
 * gold budget) rather than a purchase-by-purchase loop, so it stays fast
 * even for huge affordable quantities.
 * @param {Object} upgrade
 * @param {number} availableGold
 * @returns {{count: number, totalCost: number}}
 */
function getMaxAffordable(upgrade, availableGold) {
    const r = getEffectiveGrowthRate(upgrade);
    const price = upgrade.price;

    if (availableGold < price) {
        return { count: 0, totalCost: 0 };
    }

    let count;
    if (Math.abs(r - 1) < 1e-9) {
        count = Math.floor(availableGold / price);
    } else {
        // Solve availableGold >= price * (r^n - 1) / (r - 1) for n:
        // n <= log_r( availableGold * (r - 1) / price + 1 )
        const inner = (availableGold * (r - 1)) / price + 1;
        count = Math.floor(Math.log(inner) / Math.log(r));
        // Guard against floating-point rounding pushing us one level too far
        // or leaving one level on the table.
        while (count > 0 && getBulkCost(upgrade, count) > availableGold) count--;
        while (getBulkCost(upgrade, count + 1) <= availableGold) count++;
    }

    return { count, totalCost: getBulkCost(upgrade, count) };
}

/**
 * Resolves the current buy-amount selection ('MAX' or a fixed number) into
 * a concrete { count, totalCost } for a specific upgrade, given the
 * player's current gold.
 * @param {Object} upgrade
 * @returns {{count: number, totalCost: number}}
 */
function resolveBuyQuantity(upgrade) {
    if (gameState.buyAmount === 'MAX') {
        return getMaxAffordable(upgrade, gameState.coins);
    }
    const n = gameState.buyAmount;
    return { count: n, totalCost: getBulkCost(upgrade, n) };
}

/**
 * Sets the active bulk-buy multiplier and refreshes the shop so prices/
 * labels update instantly.
 * @param {number|string} amount - 1, 10, 100, or 'MAX'
 */
function setBuyAmount(amount) {
    gameState.buyAmount = amount;

    if (dom.buyAmountButtons) {
        dom.buyAmountButtons.forEach((btn) => {
            const btnAmount = btn.dataset.amount === 'MAX' ? 'MAX' : parseInt(btn.dataset.amount, 10);
            btn.classList.toggle('active', btnAmount === amount);
        });
    }

    renderShop();
}

/**
 * Attempts to purchase a given upgrade by key, buying as many levels as
 * the current bulk-buy selection (x1 / x10 / x100 / MAX) allows.
 * Deducts the total geometric-growth cost, increases owned count by the
 * purchased quantity, updates price for the next purchase, then
 * recalculates any derived stats affected by this upgrade's type.
 * @param {string} upgradeKey
 */
function buyUpgrade(upgradeKey) {
    initAudio();
    const upgrade = gameState.upgrades[upgradeKey];
    if (!upgrade) return;

    const { count, totalCost } = resolveBuyQuantity(upgrade);
    if (count <= 0 || gameState.coins < totalCost) return;

    gameState.coins -= totalCost;
    upgrade.owned += count;

    // Recompute the price for the NEXT single unit after this bulk purchase
    upgrade.price = upgrade.basePrice * Math.pow(getEffectiveGrowthRate(upgrade), upgrade.owned);

    // Quest/Achievement tracking: upgrades purchased (counts each level bought)
    gameState.questProgress.upgradesBought += count;
    gameState.achievementProgress.upgradesBought += count;

    // Expedition Pass quest tracking: upgrade levels bought
    gameState.pass.dailyProgress.upgradesBought += count;
    gameState.pass.weeklyProgress.upgradesBought += count;

    playUpgradeSound();
    recalculateDerivedStats();
    updateQuestUI();
    updatePassUI();
    updateUIForce();
}

/**
 * Recalculates all stats derived from owned upgrades: CPS (flat + percent),
 * crit chance, and XP multiplier. Called after any purchase or load.
 */
/**
 * Rebuilds every upgrade's displayed price from basePrice * effectiveGrowth^owned. Keeps prices
 * correct after loads (old saves hold old prices), skill/relic cost reductions and prestige.
 */
function refreshUpgradePrices() {
    for (const key in gameState.upgrades) {
        const up = gameState.upgrades[key];
        const p = up.basePrice * Math.pow(getEffectiveGrowthRate(up), up.owned || 0);
        up.price = Number.isFinite(p) ? p : up.basePrice;
    }
}

function recalculateDerivedStats() {
    invalidateStatCaches(); // purchases / loads / prestige: relic + skill + multiplier caches rebuild lazily
    refreshUpgradePrices();
    recalculateCPS();
    recalculateCritChance();
    recalculateXpMultiplier();
}

/**
 * Recalculates total coins-per-second based on all owned upgrades.
 * Flat CPS upgrades are summed first, then percentage-based upgrades
 * (like Dwarf Guild) are applied as a multiplier on top of that total.
 */
function recalculateCPS() {
    let flatCPS = 0;
    let percentBonus = 0;

    for (const key in gameState.upgrades) {
        const upgrade = gameState.upgrades[key];
        if (upgrade.type === 'flatCps') {
            flatCPS += upgrade.cps * upgrade.owned;
        } else if (upgrade.type === 'percentCps') {
            percentBonus += upgrade.percentBonus * upgrade.owned;
        }
    }

    // Automated Minecarts (and similar) boost the flat CPS contributed by shop upgrades
    flatCPS *= getShopEfficiencyMultiplier();

    // Deep Earth Drilling (and similar) multiply the final total
    gameState.coinsPerSecond = flatCPS * (1 + percentBonus) * getSkillCpsMultiplier();
}

/**
 * Recalculates the player's total critical click chance from Lucky Charm
 * (and any other critChance-type upgrades), capped at 100%.
 */
function recalculateCritChance() {
    let totalChance = 0;
    for (const key in gameState.upgrades) {
        const upgrade = gameState.upgrades[key];
        if (upgrade.type === 'critChance') {
            totalChance += upgrade.critChanceBonus * upgrade.owned * getShopEfficiencyMultiplier();
        }
    }
    // Runed Explosives (and similar) add a flat bonus on top of shop-derived crit chance
    totalChance += getSkillCritChanceBonus();
    gameState.critChance = Math.min(1, totalChance);
}

/**
 * Recalculates the player's total XP multiplier from Wisdom Potion
 * (and any other xpBoost-type upgrades).
 */
function recalculateXpMultiplier() {
    let bonus = 0;
    for (const key in gameState.upgrades) {
        const upgrade = gameState.upgrades[key];
        if (upgrade.type === 'xpBoost') {
            bonus += upgrade.xpBonus * upgrade.owned * getShopEfficiencyMultiplier();
        }
    }
    // Ancient Wisdom (and similar) add a flat XP bonus on top
    bonus += getSkillXpBonus();
    gameState.xpMultiplier = 1 + bonus;
}

/**
 * Adds experience points and triggers a level-up when the threshold is reached.
 * Experience gained is proportional to gold earned, scaled further by the
 * player's XP multiplier from Wisdom Potion upgrades.
 * @param {number} goldEarned
 */
function gainExperience(goldEarned) {
    // XP gain scaled down from gold earned to keep progression balanced,
    // then boosted by any Wisdom Potion multiplier.
    gameState.xp += goldEarned * 0.5 * gameState.xpMultiplier;

    // A single gain could theoretically cross multiple level thresholds
    while (gameState.xp >= gameState.xpToNextLevel) {
        gameState.xp -= gameState.xpToNextLevel;
        levelUp();
    }

    // NOTE: Expedition Pass XP is intentionally NOT awarded here. Pass XP
    // comes exclusively from claimPassQuestReward() via addPassXP().
}

/**
 * Increments the player's level, scales the XP requirement for the next level,
 * plays a level-up sound, and triggers a visual flash/glow effect.
 */
function levelUp() {
    gameState.level += 1;

    gameState.xpToNextLevel = calculateXpRequirement(gameState.level + 1); // FIX: was (level) - off by one vs. load/prestige

    // Quest tracking: levels gained since the last daily reset
    gameState.questProgress.levelsGainedToday += 1;

    playLevelUpSound();
    triggerLevelUpEffect();
    checkBiomeProgression();
}

/**
 * XP curve knots: [level, ln(cumulative XP to reach that level)]. See calculateXpRequirement().
 */
const XP_CURVE_KNOTS = [
    [1, 4.605170185988092],
    [15, 12.622365711652776],
    [35, 16.9424603125068],
    [60, 22.87091497612262],
    [100, 28.166785865179683],
    [160, 30.466354142911932],
    [250, 32.31324570948502]
];

function xpCumulative(L) {
    if (L <= 1) return 0;
    let seg = 0;
    for (let k = 0; k < XP_CURVE_KNOTS.length - 1; k++) {
        if (L >= XP_CURVE_KNOTS[k][0]) seg = k;
    }
    const l0 = XP_CURVE_KNOTS[seg][0], l1 = XP_CURVE_KNOTS[seg + 1][0];
    const y0 = XP_CURVE_KNOTS[seg][1], y1 = XP_CURVE_KNOTS[seg + 1][1];
    return Math.exp(y0 + ((y1 - y0) / (l1 - l0)) * (L - l0));
}

/**
 * Computes the XP required to advance FROM (level - 1) TO `level`.
 *
 * Designed for a long-haul, 250+ level game with 7 biome milestones:
 *   - A polynomial term (level^2.35) drives steady, ever-increasing costs
 *     so early levels are quick but the curve keeps climbing without a flat plateau.
 *   - A mild exponential term (1.045^level) kicks in more aggressively at high
 *     levels, ensuring the stretch from Magma Core (100) to Void Rift (160) to
 *     Celestial Core (250) remains a genuine long-term climb rather than trivial.
 * @param {number} level - the level being leveled up TO
 * @returns {number}
 */
function calculateXpRequirement(level) {
    // REBALANCED: cumulative XP is interpolated log-linearly between milestone knots placed at
    // each biome entry level, so every biome takes a planned amount of time (~12 min, 30 min,
    // 1.1 h, 2 h, 3.7 h, 7.5 h to reach biomes 2..7 at ~2 clicks/s) instead of the old
    // curve that let biomes 2-7 fall in minutes. Past level 250 the last segment extends.
    const L = Math.floor(Number(level));
    if (!Number.isFinite(L) || L <= 1) return 1;
    return Math.max(1, Math.floor(xpCumulative(L) - xpCumulative(L - 1)));
}

/**
 * Applies a temporary CSS animation class to visually celebrate a level-up.
 */
let levelFxQueued = false;
let levelFxTimer = 0;
function triggerLevelUpEffect() {
    // Several level-ups in one gain (late game) used to force one reflow each; now they share one restart per frame.
    if (levelFxQueued) return;
    levelFxQueued = GCFrame.queue(() => {
        dom.levelPanel.classList.remove('level-up-flash');
        dom.levelLabel.classList.remove('level-up-text-pop');
    }, () => {
        levelFxQueued = false;
        dom.levelPanel.classList.add('level-up-flash');
        dom.levelLabel.classList.add('level-up-text-pop');
        clearTimeout(levelFxTimer);
        levelFxTimer = setTimeout(() => {
            dom.levelPanel.classList.remove('level-up-flash');
            dom.levelLabel.classList.remove('level-up-text-pop');
        }, 1000);
    });
}

/**
 * =========================================
 * PRESTIGE SYSTEM
 * =========================================
 */

/**
 * Whether the player currently meets the milestone required to Prestige
 * (reaching a minimum level OR earning a minimum amount of lifetime coins).
 * Both thresholds scale dynamically based on gameState.totalPrestiges —
 * see getRequiredPrestigeLevel() and getRequiredPrestigeTotalCoins().
 * @returns {boolean}
 */
function isPrestigeUnlocked() {
    return gameState.level >= getRequiredPrestigeLevel() ||
        gameState.totalCoinsEarned >= getRequiredPrestigeTotalCoins();
}

/**
 * Calculates how many Gems the player would earn from prestiging right now,
 * based on their lifetime coins earned. Uses a square-root curve so early
 * prestiges aren't overly punishing while still rewarding long play sessions.
 * @returns {number}
 */
function calculateGemsToEarn() {
    const P = PRESTIGE_CONFIG;
    const coins = Math.max(0, Number(gameState.totalCoinsEarned) || 0);
    const base = P.gemCoefficient * Math.pow(coins / P.gemCoinDivisor, P.gemExponent);
    const gems = Math.floor(base * getRelicGemYieldMultiplier());
    return Number.isFinite(gems) && gems > 0 ? gems : 0;
}

/**
 * Recalculates the permanent global multiplier granted by PRESTIGE Gems.
 * Each Gem earned by prestiging grants +1% (PRESTIGE_CONFIG.gemBonusPerGem), additive
 * between Gems and multiplicative with the biome / level multipliers. It is derived from
 * gameState.prestigeGems (lifetime gems earned via prestige), NOT the spendable balance,
 * so spending Gems on skills/relics/helpers never weakens the permanent bonus.
 */
function recalculatePrestigeMultiplier() {
    const earned = Math.max(0, Number(gameState.prestigeGems) || 0);
    gameState.prestigeMultiplier = 1 + earned * PRESTIGE_CONFIG.gemBonusPerGem;
}

/**
 * Handles a click on the Prestige button: confirms with the player,
 * then resets progress in exchange for permanent Gems.
 */
function handlePrestigeClick() {
    initAudio();

    if (!isPrestigeUnlocked()) return;

    const gemsToEarn = calculateGemsToEarn();

    if (gemsToEarn <= 0) {
        alert(t('prestige_not_worth'));
        return;
    }

    const confirmed = confirm(tp('prestige_confirm', gemsToEarn, {
        gems: gemsToEarn,
        percent: (gemsToEarn * PRESTIGE_CONFIG.gemBonusPerGem * 100).toFixed(0)
    }));

    if (!confirmed) return;

    performPrestige(gemsToEarn);
}

/**
 * Performs the actual prestige reset: awards Gems, recalculates the
 * permanent multiplier, and resets all resettable progress to its
 * starting state. Gems, the prestige multiplier, and sound settings persist.
 * @param {number} gemsToEarn
 */
function performPrestige(gemsToEarn) {
    // Award the permanent currency first
    gameState.gems += gemsToEarn;
    gameState.prestigeGems = (Number(gameState.prestigeGems) || 0) + gemsToEarn;
    recalculatePrestigeMultiplier();

    // Lifetime + Expedition Pass weekly quest tracking
    gameState.totalPrestiges += 1;
    gameState.pass.weeklyProgress.prestiges += 1;

    // Reset resettable progress
    gameState.coins = 0;
    gameState.coinsPerClick = 1;
    gameState.coinsPerSecond = 0;
    gameState.level = 1;
    gameState.xp = 0;
    gameState.xpToNextLevel = calculateXpRequirement(2);
    gameState.critChance = 0;
    gameState.xpMultiplier = 1;
    gameState.totalCoinsEarned = 0;
    gameState.currentBiome = 'surface';
    applyBiomeVisuals(false);

    for (const key in gameState.upgrades) {
        const upgrade = gameState.upgrades[key];
        upgrade.owned = 0;
        upgrade.price = upgrade.basePrice;
    }

    // Helpers persist through Prestige unless a helper opts in via resetOnPrestige.
    resetHelpersForPrestige();

    // Note: gameState.skillLevels is intentionally NOT reset here —
    // Dwarven Forge skill levels are permanent purchases that survive
    // Prestige, same as Gems and the prestige multiplier.
    recalculateDerivedStats();
    playPrestigeSound();
    saveGame();
    updatePassUI();
    updateUI(true); // paint synchronously: alert() below blocks the frame loop

    alert(tp('prestige_done', gameState.gems, {
        gems: gameState.gems,
        percent: ((gameState.prestigeMultiplier - 1) * 100).toFixed(0)
    }));

    // Natural break (progress saved above): Poki decides whether an ad is actually shown.
    try { GCAds.commercialBreak('prestige'); } catch (e) { /* never break gameplay for an ad */ }
}

/**
 * Updates the Prestige button's visibility/state and the Gems display.
 */
function updatePrestigeUI() {
    const unlocked = isPrestigeUnlocked();
    setDisplayIfChanged(dom.prestigeButton, unlocked ? 'inline-block' : 'none');
    if (dom.prestigeHint) {
        setDisplayIfChanged(dom.prestigeHint, unlocked ? 'none' : 'block');
        // Reflect the current dynamically-scaled requirement (grows with each completed prestige)
        setTextIfChanged(dom.prestigeHint,
            t('prestige_hint', { level: getRequiredPrestigeLevel(), coins: formatNumber(getRequiredPrestigeTotalCoins()) }));
    }

    let gemsToEarn = 0;
    if (unlocked) {
        gemsToEarn = calculateGemsToEarn();
        setTextIfChanged(dom.prestigeButton, t('prestige_button', { gems: gemsToEarn }));
        const disabled = gemsToEarn <= 0;
        if (dom.prestigeButton.disabled !== disabled) dom.prestigeButton.disabled = disabled;
    }

    // Bottom-nav Prestige tab notification dot: lights up once Prestige is
    // unlocked and ready to bank gems.
    if (dom.navTabDotPrestige) {
        const ready = unlocked && gemsToEarn > 0;
        setDisplayIfChanged(dom.navTabDotPrestige, ready ? 'flex' : 'none');
    }

    setTextIfChanged(dom.gemCount, t('gems_count', { amount: formatNumber(gameState.gems) }));
    setTextIfChanged(dom.gemMultiplierLabel,
        t('permanent_bonus', { percent: ((gameState.prestigeMultiplier - 1) * 100).toFixed(0) }));
}

/**
 * =========================================
 * SKILL TREE UI (Dwarven Forge)
 * =========================================
 */

/** Opens the Dwarven Forge modal and renders its current contents. */
function openSkillTree() {
    renderSkillTree();
    renderRelicExcavation();
    dom.skillTreeOverlay.classList.add('open');
    setActiveNavTab('prestige');
}

/** Closes the Dwarven Forge modal. */
function closeSkillTree() {
    dom.skillTreeOverlay.classList.remove('open');
    setActiveNavTab('main');
}

/**
 * Attempts to purchase the NEXT level of a given skill by key. Does
 * nothing if the skill is already at MAX_SKILL_LEVEL or if the player
 * can't afford the next level's Gem cost.
 * @param {string} skillKey
 */
function buySkill(skillKey) {
    const skill = SKILL_TREE[skillKey];
    if (!skill) return;

    const currentLevel = getSkillLevel(skillKey);
    if (currentLevel >= MAX_SKILL_LEVEL) return; // already maxed

    const nextLevelCost = skill.costs[currentLevel]; // costs[0] = price for level 1, etc.
    if (gameState.gems < nextLevelCost) return; // can't afford

    gameState.gems -= nextLevelCost;
    gameState.skillLevels[skillKey] = currentLevel + 1;

    playUpgradeSound();
    recalculateDerivedStats();
    saveGame();
    updateUIForce();
    renderSkillTree();
}

/**
 * Renders the three skill-path columns inside the Dwarven Forge modal,
 * reflecting current Gem balance (affordability) and ownership state.
 */
let skillTreeRenderedGems = null;
function renderSkillTree() {
    skillTreeRenderedGems = gameState.gems;
    // Reset each column
    for (const path in dom.skillColumns) {
        dom.skillColumns[path].innerHTML = '';
    }

    dom.skillTreeGemCount.textContent = t('gems_count', { amount: formatNumber(gameState.gems) });

    for (const key in SKILL_TREE) {
        const skill = SKILL_TREE[key];
        const level = getSkillLevel(key);
        const maxed = level >= MAX_SKILL_LEVEL;
        const nextLevelCost = maxed ? null : skill.costs[level];
        const canAfford = !maxed && gameState.gems >= nextLevelCost;

        const node = document.createElement('div');
        node.className = 'skill-node' + (maxed ? ' unlocked' : (level > 0 ? ' partial' : (canAfford ? ' affordable' : ' locked')));

        const levelLabel = maxed ? t('buy_max_btn') : t('skill_level_status', { level, max: MAX_SKILL_LEVEL });
        const buyBtnLabel = maxed ? t('buy_max_btn') : (level > 0 ? t('skill_btn_upgrade') : t('skill_btn_unlock'));
        const buyBtnDisabled = maxed || !canAfford;
        const costLabel = maxed ? t('skill_btn_max') : `💎 ${nextLevelCost}`;

        node.innerHTML = `
            <div class="skill-icon-name">
                <span class="skill-icon">${skill.icon}</span>
                <span>${skill.name}</span>
            </div>
            <div class="skill-desc">${skill.description}</div>
            <div class="skill-level-status">${levelLabel}</div>
            <div class="skill-footer">
                <span class="skill-cost">${costLabel}</span>
                <button class="skill-buy-btn${maxed ? ' owned' : ''}" ${buyBtnDisabled ? 'disabled' : ''}>${buyBtnLabel}</button>
            </div>
        `;

        const buyBtn = node.querySelector('.skill-buy-btn');
        buyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            buySkill(key);
        });

        // Also allow clicking the whole node (when affordable and not maxed)
        if (!maxed && canAfford) {
            node.addEventListener('click', () => buySkill(key));
        }

        dom.skillColumns[skill.path].appendChild(node);
    }
}

/**
 * =========================================
 * RELIC EXCAVATION UI (inside the Dwarven Forge modal)
 * =========================================
 */

/** Switches between the "Skill Tree" and "Relic Excavation" tabs inside the Dwarven Forge modal. */
function switchForgeTab(tab) {
    if (dom.forgeTabBtnSkills) dom.forgeTabBtnSkills.classList.toggle('active', tab === 'skills');
    if (dom.forgeTabBtnRelics) dom.forgeTabBtnRelics.classList.toggle('active', tab === 'relics');
    if (dom.forgeTabPanelSkills) dom.forgeTabPanelSkills.classList.toggle('active', tab === 'skills');
    if (dom.forgeTabPanelRelics) dom.forgeTabPanelRelics.classList.toggle('active', tab === 'relics');
    if (tab === 'relics') renderRelicExcavation();
}

/** Returns the CSS class suffix used to color a relic card by rarity. */
function getRelicRarityClass(rarity) {
    return 'relic-rarity-' + rarity.toLowerCase();
}

/**
 * Builds a short, human-readable summary of a relic's current per-level
 * effect, scaled by its level, for display on its card.
 * @param {Object} relic
 * @param {number} level
 * @returns {string}
 */
function getRelicEffectLabel(relic, level) {
    const effective = relic.valuePerLevel * level;
    switch (relic.type) {
        case 'critMultiplier':
            return t('relic_eff_crit', { value: (effective * 100).toFixed(0) });
        case 'gemYield':
            return t('relic_eff_gem', { value: (effective * 100).toFixed(0) });
        case 'shopCostReduction':
            return t('relic_eff_shop', { value: (effective * 100).toFixed(0) });
        case 'cpsMultiplier':
            return t('relic_eff_cps', { value: (effective * 100).toFixed(0) });
        case 'clickMultiplier':
            return t('relic_eff_click', { value: (effective * 100).toFixed(0) });
        case 'eventLuck':
            return t('relic_eff_event', { value: (effective * 100).toFixed(0) });
        default:
            return '';
    }
}

/**
 * Attempts to spend Gems excavating a random relic. Shows a result
 * banner naming whichever relic was dug up or upgraded, or an
 * explanatory message if the dig couldn't happen.
 */
function handleDigRelic() {
    const gemsBefore = gameState.gems;
    const relicKey = digRelic();

    if (!relicKey) {
        const allMaxed = Object.keys(RELIC_DEFINITIONS).every((k) => getRelicLevel(k) >= MAX_RELIC_LEVEL);
        showRelicResultBanner(
            allMaxed ? t('relic_no_more') : t('relic_no_gems'),
            allMaxed
        );
        return;
    }

    const relic = RELIC_DEFINITIONS[relicKey];
    const newLevel = getRelicLevel(relicKey);
    const wasNew = newLevel === 1;

    playUpgradeSound();
    showRelicResultBanner(
        t(wasNew ? 'relic_result_new' : 'relic_result_up', { icon: relic.icon, name: relic.name, level: newLevel }),
        true
    );

    updateUI();
    renderRelicExcavation();

    void gemsBefore; // retained for potential future "gems spent" display
}

/** Shows a temporary result message above the relic grid after a dig attempt. */
function showRelicResultBanner(message, success) {
    if (!dom.relicResultBanner) return;
    dom.relicResultBanner.textContent = message;
    dom.relicResultBanner.classList.remove('relic-banner-success', 'relic-banner-fail');
    dom.relicResultBanner.classList.add(success ? 'relic-banner-success' : 'relic-banner-fail');
    dom.relicResultBanner.classList.add('show');
    clearTimeout(showRelicResultBanner._timer);
    showRelicResultBanner._timer = setTimeout(() => {
        dom.relicResultBanner.classList.remove('show');
    }, 3200);
}

/**
 * Renders the Relic Excavation tab: the Gem balance, the dig button
 * (with its randomized cost range), and a grid of every relic showing
 * its current level and effect.
 */
function renderRelicExcavation() {
    if (!dom.relicGrid) return;

    if (dom.relicGemCount) {
        dom.relicGemCount.textContent = t('gems_count', { amount: formatNumber(gameState.gems) });
    }
    if (dom.relicDigCostLabel) {
        dom.relicDigCostLabel.textContent = `💎 ${RELIC_DIG_COST_MIN}-${RELIC_DIG_COST_MAX}`;
    }
    if (dom.relicDigBtn) {
        dom.relicDigBtn.disabled = gameState.gems < RELIC_DIG_COST_MIN;
    }

    dom.relicGrid.innerHTML = '';
    for (const key in RELIC_DEFINITIONS) {
        const relic = RELIC_DEFINITIONS[key];
        const level = getRelicLevel(key);
        const maxed = level >= MAX_RELIC_LEVEL;
        const owned = level > 0;

        const card = document.createElement('div');
        card.className = `relic-card ${getRelicRarityClass(relic.rarity)}` + (owned ? ' owned' : ' undiscovered') + (maxed ? ' maxed' : '');

        card.innerHTML = `
            <div class="relic-icon">${owned ? relic.icon : '❓'}</div>
            <div class="relic-name">${owned ? relic.name : t('relic_unknown_name')}</div>
            <div class="relic-rarity-badge">${t('rarity_' + String(relic.rarity).toLowerCase())}</div>
            <div class="relic-desc">${owned ? relic.description : t('relic_undiscovered')}</div>
            <div class="relic-level-row">
                <span class="relic-level-status">${maxed ? t('buy_max_btn') : t('skill_level_status', { level, max: MAX_RELIC_LEVEL })}</span>
                ${owned ? `<span class="relic-effect-label">${getRelicEffectLabel(relic, level)}</span>` : ''}
            </div>
        `;

        dom.relicGrid.appendChild(card);
    }
}

/**
 * Builds the small stat-line shown under an upgrade's description,
 * tailored to what that upgrade's type actually does.
 * @param {Object} upgrade
 * @returns {string}
 */
function getUpgradeEffectLabel(upgrade) {
    switch (upgrade.type) {
        case 'flatCps':
            return t('upg_eff_cps', { value: upgrade.cps >= 1000 ? formatNumber(upgrade.cps) : Number(upgrade.cps.toPrecision(3)) });
        case 'percentCps':
            return t('upg_eff_percent', { value: (upgrade.percentBonus * 100).toFixed(0) });
        case 'clickPower':
            return t('upg_eff_click', { value: upgrade.clickBonus });
        case 'critChance':
            return t('upg_eff_crit', { value: (upgrade.critChanceBonus * 100).toFixed(0) });
        case 'xpBoost':
            return t('upg_eff_xp', { value: (upgrade.xpBonus * 100).toFixed(0) });
        default:
            return '';
    }
}

/**
 * Renders the upgrade shop. The card DOM is built ONCE (and only rebuilt if the
 * set of upgrade keys ever changes); every later call only touches the text /
 * class of cards whose displayed values actually changed. One delegated click
 * listener on the container replaces the old per-card onclick handlers.
 */
const shopCardCache = { keySig: null, cards: {} };

function buildShopCard(key) {
    const item = document.createElement('div');
    item.className = 'upgrade-item';
    item.dataset.key = key;
    item.innerHTML = `
        <div class="frame-corner top-left"></div>
        <div class="frame-corner top-right"></div>
        <div class="frame-corner bottom-left"></div>
        <div class="frame-corner bottom-right"></div>
        <div class="upgrade-info">
            <span class="upgrade-name"></span>
            <span class="upgrade-desc"></span>
            <span class="upgrade-buy-label"></span>
        </div>
        <div class="upgrade-stats">
            <span class="upgrade-price"></span>
            <span class="upgrade-owned"></span>
        </div>
    `;
    item.querySelector('.upgrade-name').textContent = gameState.upgrades[key].name;
    return {
        root: item,
        desc: item.querySelector('.upgrade-desc'),
        buyLabel: item.querySelector('.upgrade-buy-label'),
        price: item.querySelector('.upgrade-price'),
        owned: item.querySelector('.upgrade-owned'),
        disabled: null, descText: null, buyLabelText: null, priceText: null, ownedText: null
    };
}

function renderShop() {
    const container = dom.shopContainer;
    const keys = Object.keys(gameState.upgrades);
    const keySig = keys.join('|');

    if (shopCardCache.keySig !== keySig) {
        shopCardCache.keySig = keySig;
        shopCardCache.cards = {};
        container.innerHTML = '';
        const fragment = document.createDocumentFragment();
        keys.forEach((key) => {
            const card = buildShopCard(key);
            shopCardCache.cards[key] = card;
            fragment.appendChild(card.root);
        });
        container.appendChild(fragment);

        if (!container.dataset.bound) {
            container.dataset.bound = '1';
            container.addEventListener('click', (e) => {
                const item = e.target.closest('.upgrade-item');
                if (item && container.contains(item)) buyUpgrade(item.dataset.key);
            });
        }
    }

    for (const key of keys) {
        const upgrade = gameState.upgrades[key];
        const card = shopCardCache.cards[key];
        const { count, totalCost } = resolveBuyQuantity(upgrade);
        const canAfford = count > 0 && gameState.coins >= totalCost;

        // Label reflects the active bulk-buy mode: "+10 Level", "Buy Max (x42)", etc.
        const buyLabel = gameState.buyAmount === 'MAX'
            ? t('buy_max_x', { count })
            : tp('buy_levels', gameState.buyAmount, { n: gameState.buyAmount });

        const disabled = !canAfford;
        if (card.disabled !== disabled) {
            card.disabled = disabled;
            card.root.classList.toggle('disabled', disabled);
        }
        const descText = t('upg_desc_with_eff', { desc: upgrade.description, effect: getUpgradeEffectLabel(upgrade) });
        if (card.descText !== descText) { card.descText = descText; card.desc.textContent = descText; }
        if (card.buyLabelText !== buyLabel) { card.buyLabelText = buyLabel; card.buyLabel.textContent = buyLabel; }
        const priceText = `${formatNumber(totalCost)} 🪙`;
        if (card.priceText !== priceText) { card.priceText = priceText; card.price.textContent = priceText; }
        const ownedText = t('owned_count', { count: formatNumber(upgrade.owned) });
        if (card.ownedText !== ownedText) { card.ownedText = ownedText; card.owned.textContent = ownedText; }
    }
}

/**
 * Updates the level/XP panel UI (progress bar, labels).
 */
function updateLevelUI() {
    setTextIfChanged(dom.levelLabel, t('level_label', { level: gameState.level }));
    const pct = Math.min(100, (gameState.xp / gameState.xpToNextLevel) * 100);
    setWidthIfChanged(dom.xpBarInner, pct.toFixed(2) + '%'); // 0.01% of the bar is far below one pixel
    setTextIfChanged(dom.xpLabel, t('xp_progress', { current: formatNumber(gameState.xp), max: formatNumber(gameState.xpToNextLevel) }));
}

/**
 * Updates all dynamic text and states in the UI.
 * Should be called after any state change (click, purchase, tick).
 */
/**
 * Rarity metadata for the Key Altar inventory display: label text and icon
 * for each key rarity. Kept in one place so updateKeyInventoryUI() and any
 * future key-related UI can share it.
 */
const KEY_RARITY_INFO = {
    common: { get label() { return t('key_common'); }, icon: '🔑' },
    rare: { get label() { return t('key_rare'); }, icon: '🔑' },
    legendary: { get label() { return t('key_legendary'); }, icon: '🔑' }
};

/**
 * Renders the "Your Keys" inventory grid in the Key Altar tab of the
 * Bosses & Key Chests modal, reading counts from gameState.keys.
 * Safe to call even if the modal isn't currently open.
 */
let keyInventorySig = null;
let keyInventoryFirstCard = null;
function updateKeyInventoryUI() {
    if (!dom.keyInventoryGrid) return;

    // Only rebuild when a key count changed (or another module re-skinned the grid).
    let sig = '';
    for (const rarity in KEY_RARITY_INFO) sig += (gameState.keys[rarity] || 0) + '|';
    if (sig === keyInventorySig && dom.keyInventoryGrid.firstElementChild === keyInventoryFirstCard) return;
    keyInventorySig = sig;

    dom.keyInventoryGrid.innerHTML = '';

    for (const rarity in KEY_RARITY_INFO) {
        const info = KEY_RARITY_INFO[rarity];
        const count = gameState.keys[rarity] || 0;

        const card = document.createElement('div');
        card.className = `key-card key-card-${rarity}`;
        card.innerHTML = `
            <div class="key-card-icon">${info.icon}</div>
            <div class="key-card-name">${info.label}</div>
            <div class="key-card-count">${formatNumber(count)}</div>
        `;
        dom.keyInventoryGrid.appendChild(card);
    }
    keyInventoryFirstCard = dom.keyInventoryGrid.firstElementChild;
}

/**
 * =========================================
 * BOSS KEY REWARDS & FREE BOSS ENTRY
 * =========================================
 * Keys are a BOSS DROP. Boss fights never cost a rarity key (that would
 * create a loop with the Key Altar, where chests need those same keys).
 * Entry is free and gated only by a per-boss recovery cooldown.
 *
 * Boss code (bosses.js) should use:
 *   canEnterBossFight(bossId)          -> { ok, remainingMs }   (never checks keys)
 *   startBossCooldown(bossId, [ms])    -> begins the recovery timer
 *   awardBossKeys(tierOrBoss)          -> adds keys, returns [{rarity, amount}]
 *   formatBossKeyRewardText(rewards)   -> "🔑 +1 Rare Key" style text
 */

/** Default recovery time (ms) before the same boss can be fought again. */
const BOSS_ENTRY_COOLDOWN_MS = 30 * 1000;

/**
 * Key drop tables by boss difficulty tier. `guaranteed` keys are always
 * awarded; `chances` are independent extra-drop rolls (0-1). Harder bosses
 * guarantee higher-rarity keys, so progression feeds the Key Altar.
 */
const BOSS_KEY_DROP_TABLES = {
    easy:      { guaranteed: { common: 1 },              chances: { common: 0.30, rare: 0.10 } },
    medium:    { guaranteed: { common: 1, rare: 0 },     chances: { common: 0.50, rare: 0.35, legendary: 0.03 } },
    hard:      { guaranteed: { rare: 1 },                chances: { common: 0.60, rare: 0.40, legendary: 0.10 } },
    legendary: { guaranteed: { rare: 1, legendary: 1 },  chances: { common: 0.75, rare: 0.60, legendary: 0.25 } }
};

/** Normalises whatever bosses.js passes (tier string, boss object, or nothing) to a table key. */
function resolveBossKeyTier(bossOrTier) {
    let tier = bossOrTier;
    if (tier && typeof tier === 'object') {
        tier = tier.difficulty || tier.tier || tier.rarity || tier.keyTier || tier.keyRarity;
    }
    tier = String(tier || '').toLowerCase();
    if (tier === 'common' || tier === 'normal' || tier === 'basic') tier = 'easy';
    if (tier === 'rare') tier = 'hard';
    if (tier === 'epic' || tier === 'mythic') tier = 'legendary';
    return BOSS_KEY_DROP_TABLES[tier] ? tier : 'easy';
}

/**
 * Awards keys for defeating a boss. Call this from handleBossVictory().
 * Adds directly to gameState.keys.common / .rare / .legendary.
 * @param {string|object} bossOrTier boss object or difficulty ('easy'|'medium'|'hard'|'legendary')
 * @returns {{rarity:string, amount:number}[]} the keys granted (for the victory screen)
 */
function awardBossKeys(bossOrTier) {
    if (!gameState.keys || typeof gameState.keys !== 'object') {
        gameState.keys = { common: 0, rare: 0, legendary: 0 };
    }
    const table = BOSS_KEY_DROP_TABLES[resolveBossKeyTier(bossOrTier)];
    const totals = { common: 0, rare: 0, legendary: 0 };

    for (const rarity in table.guaranteed) {
        totals[rarity] += table.guaranteed[rarity] || 0;
    }
    for (const rarity in table.chances) {
        if (Math.random() < table.chances[rarity]) totals[rarity] += 1;
    }

    const rewards = [];
    for (const rarity in totals) {
        if (totals[rarity] > 0) {
            gameState.keys[rarity] = (gameState.keys[rarity] || 0) + totals[rarity];
            rewards.push({ rarity, amount: totals[rarity] });
        }
    }
    // Every victory drops at least one key.
    if (rewards.length === 0) {
        gameState.keys.common = (gameState.keys.common || 0) + 1;
        rewards.push({ rarity: 'common', amount: 1 });
    }

    updateKeyInventoryUI();
    updateKeyAltarControls();
    return rewards;
}

/** "🔑 +1 Common Key, 🔑 +1 Rare Key" for victory screens. */
function formatBossKeyRewardText(rewards) {
    if (!rewards || !rewards.length) return '';
    return rewards.map((r) => {
        const info = KEY_RARITY_INFO[r.rarity] || { label: r.rarity, icon: '🔑' };
        const keyName = KEY_RARITY_INFO[r.rarity] ? tp('key_name_' + r.rarity, r.amount) : info.label;
        return t('key_reward', { icon: info.icon, n: r.amount, name: keyName });
    }).join(', ');
}

/** Persistent bossId -> timestamp (ms) map, saved with gameState. */
function getBossCooldownMap() {
    if (!gameState.bossCooldowns || typeof gameState.bossCooldowns !== 'object') gameState.bossCooldowns = {};
    return gameState.bossCooldowns;
}

/** Free boss entry check: only a cooldown gates it. Rarity keys are never required. */
function canEnterBossFight(bossId) {
    const remainingMs = Math.max(0, (getBossCooldownMap()[bossId] || 0) - GCTime.now());
    return { ok: remainingMs === 0, remainingMs };
}

/** Starts the recovery timer after a boss fight ends (win or lose). */
function startBossCooldown(bossId, durationMs) {
    getBossCooldownMap()[bossId] = GCTime.now() + (typeof durationMs === 'number' ? durationMs : BOSS_ENTRY_COOLDOWN_MS);
}

// Expose to other scripts (bosses.js loads after this file).
window.awardBossKeys = awardBossKeys;
window.formatBossKeyRewardText = formatBossKeyRewardText;
window.canEnterBossFight = canEnterBossFight;
window.startBossCooldown = startBossCooldown;
window.BOSS_KEY_DROP_TABLES = BOSS_KEY_DROP_TABLES;
window.BOSS_ENTRY_COOLDOWN_MS = BOSS_ENTRY_COOLDOWN_MS;

/**
 * =========================================
 * KEY ALTAR — CHEST OPENING
 * =========================================
 * Spend 1 key of a given tier to open a chest. Each tier has its own
 * reward table; higher tiers pay out more coins/XP/gems and can grant
 * relics. Coin and XP amounts scale with the player's current
 * progression (CPS / XP-to-next-level) so rewards stay meaningful from
 * early game to late game.
 */

/** How long (ms) the shake + open animations run before the reward is revealed. */
const CHEST_SHAKE_MS = 500;   // matches @keyframes chestShake (0.5s)
const CHEST_OPEN_MS = 600;    // matches @keyframes chestOpenPop (0.6s)

/**
 * Reward tables per key tier. Each entry has a relative `weight` and a
 * `roll()` returning a concrete reward. Reward shapes:
 *   { type: 'coins'|'xp'|'gems', amount }   -> handled by grantReward()
 *   { type: 'relic' }                        -> handled by applyChestRelicReward()
 * Higher tiers have larger multipliers, more gems, and better relic odds.
 * RULE: no entry may ever grant keys — keys come only from bosses.
 */
const CHEST_REWARD_TABLES = {
    common: {
        get label() { return t('chest_name_common'); },
        entries: [
            { weight: 55, roll: () => ({ type: 'coins', amount: chestCoinAmount(60, 120) }) },
            { weight: 35, roll: () => ({ type: 'xp', amount: chestXpAmount(0.06, 0.12) }) },
            { weight: 10, roll: () => ({ type: 'gems', amount: randInt(1, 3) }) }
        ]
    },
    rare: {
        get label() { return t('chest_name_rare'); },
        entries: [
            { weight: 40, roll: () => ({ type: 'coins', amount: chestCoinAmount(300, 600) }) },
            { weight: 27, roll: () => ({ type: 'xp', amount: chestXpAmount(0.20, 0.35) }) },
            { weight: 20, roll: () => ({ type: 'gems', amount: randInt(5, 12) }) },
            { weight: 13, roll: () => ({ type: 'relic', rarity: 'Common' }) }
        ]
    },
    legendary: {
        get label() { return t('chest_name_legendary'); },
        entries: [
            { weight: 28, roll: () => ({ type: 'coins', amount: chestCoinAmount(1500, 3000) }) },
            { weight: 22, roll: () => ({ type: 'xp', amount: chestXpAmount(0.60, 1.00) }) },
            { weight: 22, roll: () => ({ type: 'gems', amount: randInt(20, 45) }) },
            { weight: 20, roll: () => ({ type: 'relic', rarity: 'Rare' }) },
            { weight: 8, roll: () => ({ type: 'relic', rarity: 'Legendary' }) }
        ]
    }
};

/** Inclusive random integer in [min, max]. */
function randInt(min, max) {
    return Math.floor(min + Math.random() * (max - min + 1));
}

/**
 * Coin reward scaled to the player's economy: `minSecs`-`maxSecs` worth of
 * current passive income, with a flat floor so brand-new players still get
 * a satisfying payout.
 */
function chestCoinAmount(minSecs, maxSecs) {
    const cps = Math.max(0, gameState.coinsPerSecond * getTotalMultiplier());
    const seconds = randInt(minSecs, maxSecs);
    const floor = seconds * 2; // early-game floor
    return Math.max(floor, Math.floor(cps * seconds));
}

/**
 * XP reward as a fraction (minFrac-maxFrac) of the XP needed for the
 * next level, so it always feels proportionate to the player's level.
 */
function chestXpAmount(minFrac, maxFrac) {
    const frac = minFrac + Math.random() * (maxFrac - minFrac);
    return Math.max(1, Math.round(gameState.xpToNextLevel * frac));
}

/** Weighted random pick from a reward table's entries. */
function pickChestReward(chestType) {
    const table = CHEST_REWARD_TABLES[chestType];
    const total = table.entries.reduce((sum, e) => sum + e.weight, 0);
    let roll = Math.random() * total;
    for (const entry of table.entries) {
        roll -= entry.weight;
        if (roll <= 0) return entry.roll();
    }
    return table.entries[table.entries.length - 1].roll();
}

/**
 * Generates a reward for the given key tier. Relic rewards are resolved
 * to a concrete relic here (so the result text can name it); if every
 * relic of that rarity (or all relics) is maxed, it falls back to a
 * Gem payout so the player is never given nothing.
 * @param {'common'|'rare'|'legendary'} chestType
 * @returns {{type:string, amount?:number, relicKey?:string, relicLevel?:number, fallback?:boolean}}
 */
function generateChestReward(chestType) {
    let reward = pickChestReward(chestType);
    // Chests must never give keys: re-roll (bounded) and finally fall back to gems.
    for (let i = 0; i < 5 && (reward.type === 'key' || reward.type === 'keys'); i++) {
        reward = pickChestReward(chestType);
    }
    if (reward.type === 'key' || reward.type === 'keys') {
        reward = { type: 'gems', amount: { common: 3, rare: 10, legendary: 30 }[chestType] || 3, fallback: true };
    }
    reward.chestType = chestType;
    if (reward.type !== 'relic') return reward;

    // Prefer a relic of the rolled rarity, otherwise any non-maxed relic.
    const notMaxed = Object.keys(RELIC_DEFINITIONS).filter((k) => getRelicLevel(k) < MAX_RELIC_LEVEL);
    const sameRarity = notMaxed.filter((k) => RELIC_DEFINITIONS[k].rarity === reward.rarity);
    const pool = sameRarity.length ? sameRarity : notMaxed;

    if (pool.length === 0) {
        // Every relic is maxed: convert to a tier-appropriate Gem bonus.
        const gemBonus = { common: 3, rare: 10, legendary: 30 }[chestType] || 3;
        return { type: 'gems', amount: gemBonus, fallback: true };
    }

    const totalWeight = pool.reduce((sum, k) => sum + RELIC_DEFINITIONS[k].digWeight, 0);
    let r = Math.random() * totalWeight;
    let relicKey = pool[pool.length - 1];
    for (const k of pool) {
        r -= RELIC_DEFINITIONS[k].digWeight;
        if (r <= 0) { relicKey = k; break; }
    }
    return { type: 'relic', relicKey };
}

/**
 * Applies a generated reward to gameState. Coins/XP/Gems reuse the
 * shared grantReward() (same path as Daily Login, Quests, etc.); relics
 * level up through the same state the Relic Excavation system uses.
 * Returns the reward with any final details (e.g. new relic level).
 */
function applyChestReward(reward) {
    // Hard guard: chests never pay out keys of any kind (prevents boss/chest key loops).
    if (reward.type === 'key' || reward.type === 'keys') {
        const gemBonus = { common: 3, rare: 10, legendary: 30 }[reward.chestType] || 3;
        reward = { type: 'gems', amount: gemBonus, fallback: true };
    }
    if (reward.type === 'relic') {
        gameState.relics[reward.relicKey] = getRelicLevel(reward.relicKey) + 1;
        reward.relicLevel = getRelicLevel(reward.relicKey);
        recalculateDerivedStats();
    } else {
        grantReward({ type: reward.type, amount: reward.amount });
    }
    return reward;
}

/** Human-readable result line for the reveal text. */
function formatChestRewardText(reward) {
    switch (reward.type) {
        case 'coins': return t('chest_reward_coins', { amount: formatNumber(reward.amount) });
        case 'xp': return t('chest_reward_xp', { amount: formatNumber(reward.amount) });
        case 'gems': return t('chest_reward_gems', { amount: formatNumber(reward.amount) });
        case 'relic': {
            const relic = RELIC_DEFINITIONS[reward.relicKey];
            return t(reward.relicLevel === 1 ? 'relic_result_new' : 'relic_result_up', { icon: relic.icon, name: relic.name, level: reward.relicLevel }).replace(/[!！]$/, '');
        }
        default: return t('chest_reward_nothing');
    }
}

/** Currently selected chest/key tier in the Key Altar. */
let selectedChestType = 'common';

/** True while a chest is mid-animation; blocks re-entry/double-spend. */
let chestOpeningInProgress = false;

/** Pending timers for the current chest opening (so they can be cancelled). */
let chestOpenTimers = [];

/** Shows a brief on-screen notification (reuses the result area if the altar is visible). */
function showChestNotice(message) {
    if (!dom.keyAltarResult) return;
    dom.keyAltarResult.className = 'key-altar-result result-empty';
    dom.keyAltarResult.textContent = message;
    // Restart the pop animation
    void dom.keyAltarResult.offsetWidth;
    dom.keyAltarResult.classList.add('result-pop');
}

/** Refreshes the open button's label/disabled state for the selected chest tier. */
function updateKeyAltarControls() {
    if (dom.keyAltarTypeBar) {
        dom.keyAltarTypeBar.querySelectorAll('.key-altar-type-btn').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.chest === selectedChestType);
            btn.disabled = chestOpeningInProgress;
        });
    }
    if (dom.keyAltarOpenBtn) {
        const label = CHEST_REWARD_TABLES[selectedChestType].label;
        const owned = gameState.keys[selectedChestType] || 0;
        dom.keyAltarOpenBtn.textContent = t('chest_open_btn', { chest: label, owned: formatNumber(owned) });
        dom.keyAltarOpenBtn.disabled = chestOpeningInProgress;
    }
}

/** Selects which key tier the altar will spend. Ignored mid-animation. */
function selectChestType(chestType) {
    if (chestOpeningInProgress || !CHEST_REWARD_TABLES[chestType]) return;
    selectedChestType = chestType;
    updateKeyAltarControls();
}

/**
 * Opens a chest using one key of the given tier.
 *  1. Validates the key exists (notifies and stops if not).
 *  2. Consumes 1 key, refreshes the key inventory, disables the button.
 *  3. Plays .chest-shake then .chest-opening.
 *  4. After the animation: generates + applies the reward, reveals it via
 *     .key-altar-result + .result-pop, updates UI, resets animation
 *     classes, and re-enables the button.
 * @param {'common'|'rare'|'legendary'} chestType
 */
function openKeyChest(chestType) {
    if (!CHEST_REWARD_TABLES[chestType]) return;
    if (chestOpeningInProgress) return; // already opening a chest

    // 1) Key check
    if (!gameState.keys || (gameState.keys[chestType] || 0) < 1) {
        const label = CHEST_REWARD_TABLES[chestType].label;
        showChestNotice(t('chest_need_key', { key: tp('key_name_' + chestType, 1) }));
        return;
    }

    initAudio(); // make sure audio can play after a user gesture

    // 2) Consume the key, refresh inventory, lock the button
    gameState.keys[chestType] -= 1;
    chestOpeningInProgress = true;
    updateKeyInventoryUI();
    updateKeyAltarControls();
    saveGame(); // persist the spend immediately so a refresh can't refund the key

    // Clear any previous result while the chest animates
    if (dom.keyAltarResult) {
        dom.keyAltarResult.className = 'key-altar-result';
        dom.keyAltarResult.textContent = '';
    }

    // 3) Animations: shake first, then the open pop
    const chestEl = dom.keyAltarChest;
    if (chestEl) {
        chestEl.classList.remove('chest-shake', 'chest-opening');
        void chestEl.offsetWidth; // restart animation
        chestEl.classList.add('chest-shake');
    }
    playChestShakeSound(); // soft wooden rattle + rising shimmer while the chest shakes

    chestOpenTimers.push(setTimeout(() => {
        if (chestEl) {
            chestEl.classList.remove('chest-shake');
            void chestEl.offsetWidth;
            chestEl.classList.add('chest-opening');
        }
        playChestOpenChime(); // sparkling crystalline arpeggio as the lid pops open
    }, CHEST_SHAKE_MS));

    // 4) Reveal the reward after both animations finish
    chestOpenTimers.push(setTimeout(() => {
        const reward = applyChestReward(generateChestReward(chestType));

        if (dom.keyAltarResult) {
            dom.keyAltarResult.className = `key-altar-result result-${chestType}`;
            dom.keyAltarResult.textContent = formatChestRewardText(reward);
            void dom.keyAltarResult.offsetWidth;
            dom.keyAltarResult.classList.add('result-pop');
        }
        playChestRewardSound(chestType); // reward chime, richer for rarer chests

        // Reset animation classes and re-enable controls
        if (chestEl) chestEl.classList.remove('chest-shake', 'chest-opening');
        chestOpeningInProgress = false;
        chestOpenTimers = [];

        updateUI();
        updateKeyInventoryUI();
        updateKeyAltarControls();
        saveGame();
    }, CHEST_SHAKE_MS + CHEST_OPEN_MS));
}

/** Switches between the Boss Fights and Key Altar sub-tabs. */
function switchBossTab(tab) {
    if (dom.bossTabBtnFights) dom.bossTabBtnFights.classList.toggle('active', tab === 'fights');
    if (dom.bossTabBtnAltar) dom.bossTabBtnAltar.classList.toggle('active', tab === 'altar');
    if (dom.bossTabPanelFights) dom.bossTabPanelFights.classList.toggle('active', tab === 'fights');
    if (dom.bossTabPanelAltar) dom.bossTabPanelAltar.classList.toggle('active', tab === 'altar');
    if (tab === 'altar') {
        updateKeyInventoryUI();
        updateKeyAltarControls();
    }
}

/** Opens the Bosses & Key Chests modal. */
function openBossModal() {
    if (!dom.bossOverlay) return;
    updateKeyInventoryUI();
    updateKeyAltarControls();
    dom.bossOverlay.classList.add('open');
}

/** Closes the Bosses & Key Chests modal (an in-flight chest still completes and pays out). */
function closeBossModal() {
    if (!dom.bossOverlay) return;
    dom.bossOverlay.classList.remove('open');
}

/**
 * Wires the Key Altar UI. Idempotent: if another script (e.g. bosses.js)
 * has already bound the modal shell, only the chest controls are added,
 * so nothing is double-bound.
 */
function initKeyAltar() {
    // Chest tier selector
    if (dom.keyAltarTypeBar && !dom.keyAltarTypeBar.dataset.bound) {
        dom.keyAltarTypeBar.dataset.bound = '1';
        dom.keyAltarTypeBar.addEventListener('click', (e) => {
            const btn = e.target.closest('.key-altar-type-btn');
            if (btn) selectChestType(btn.dataset.chest);
        });
    }

    // Open button -> spend the selected key tier
    if (dom.keyAltarOpenBtn && !dom.keyAltarOpenBtn.dataset.bound) {
        dom.keyAltarOpenBtn.dataset.bound = '1';
        dom.keyAltarOpenBtn.addEventListener('click', () => openKeyChest(selectedChestType));
    }

    // Modal shell: FAB, close, overlay click, sub-tabs, Escape
    if (dom.bossFab && !dom.bossFab.dataset.bound) {
        dom.bossFab.dataset.bound = '1';
        dom.bossFab.addEventListener('click', openBossModal);
    }
    if (dom.bossClose && !dom.bossClose.dataset.bound) {
        dom.bossClose.dataset.bound = '1';
        dom.bossClose.addEventListener('click', closeBossModal);
    }
    if (dom.bossOverlay && !dom.bossOverlay.dataset.bound) {
        dom.bossOverlay.dataset.bound = '1';
        dom.bossOverlay.addEventListener('click', (e) => {
            if (e.target === dom.bossOverlay) closeBossModal();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && dom.bossOverlay.classList.contains('open')) closeBossModal();
        });
    }
    if (dom.bossTabBtnFights && !dom.bossTabBtnFights.dataset.bound) {
        dom.bossTabBtnFights.dataset.bound = '1';
        dom.bossTabBtnFights.addEventListener('click', () => switchBossTab('fights'));
    }
    if (dom.bossTabBtnAltar && !dom.bossTabBtnAltar.dataset.bound) {
        dom.bossTabBtnAltar.dataset.bound = '1';
        dom.bossTabBtnAltar.addEventListener('click', () => switchBossTab('altar'));
    }

    updateKeyAltarControls();
}

/**
 * =========================================
 * PERFORMANCE: BATCHED UI RENDERING
 * =========================================
 * updateUI() no longer touches the DOM synchronously. It marks the UI dirty and a single
 * requestAnimationFrame callback renders it (at most once per frame no matter how many clicks,
 * ticks or helper payouts happened). Game state is always updated immediately and accurately;
 * only the *painting* is coalesced.
 *
 *   core pass  (every frame while dirty)   coin / CPS / level+XP text — written only when the
 *                                          displayed string actually changed
 *   heavy pass (at most every 200 ms)      shop affordability, prestige panel, quest/pass badges,
 *                                          helper panel, keys, VIP/Frenzy HUD, open Forge modal
 *
 * updateUI(true) renders synchronously (used before blocking alert()s); updateUIForce() makes the
 * next frame run the heavy pass immediately (used right after purchases).
 */
const UI_HEAVY_INTERVAL_MS = 200;
const uiScheduler = { rafId: 0, dirty: false, heavyDirty: false, forceHeavy: false, lastHeavyAt: 0 };

function updateUI(immediate) {
    uiScheduler.dirty = true;
    uiScheduler.heavyDirty = true;
    if (immediate === true) {
        if (uiScheduler.rafId) { cancelAnimationFrame(uiScheduler.rafId); uiScheduler.rafId = 0; }
        runUIFrame(true);
        return;
    }
    scheduleUIFrame();
}

/** Like updateUI() but the next frame also refreshes the heavy panels right away (after purchases). */
function updateUIForce() {
    uiScheduler.forceHeavy = true;
    updateUI();
}

function scheduleUIFrame() {
    if (uiScheduler.rafId) return;
    if (typeof requestAnimationFrame !== 'function') { runUIFrame(true); return; }
    uiScheduler.rafId = requestAnimationFrame(() => {
        uiScheduler.rafId = 0;
        runUIFrame(false);
    });
}

function runUIFrame(immediate) {
    if (!uiScheduler.dirty) return;
    uiScheduler.dirty = false;

    renderCoreUI();

    if (uiScheduler.heavyDirty) {
        const now = performance.now();
        if (immediate || uiScheduler.forceHeavy || now - uiScheduler.lastHeavyAt >= UI_HEAVY_INTERVAL_MS) {
            uiScheduler.heavyDirty = false;
            uiScheduler.forceHeavy = false;
            uiScheduler.lastHeavyAt = now;
            renderHeavyUI();
        } else {
            // Not time for the heavy pass yet: keep it pending (costs nothing but an empty frame).
            uiScheduler.dirty = true;
            scheduleUIFrame();
        }
    }
}

/** Per-frame pass: the numbers the player is actually watching. */
function renderCoreUI() {
    setTextIfChanged(dom.coinCount, formatNumber(gameState.coins) + ' 🪙');
    setTextIfChanged(dom.cpsCount, t('coins_per_second', { amount: formatNumber(gameState.coinsPerSecond * getPassiveIncomeMultiplier()) }));
    updateLevelUI();
}

/** Throttled pass: everything that does not need to follow every single coin. */
function renderHeavyUI() {
    updatePrestigeUI();

    // Re-render shop to update afford-states and prices
    renderShop();

    // Keep the Dwarven Forge modal's Gem count in sync if it's currently open
    // (only rebuilt when the gem balance changed - skill purchases re-render it themselves).
    if (dom.skillTreeOverlay.classList.contains('open') && skillTreeRenderedGems !== gameState.gems) {
        renderSkillTree();
    }

    // Keep quest progress bars and the Quest Book badge in sync
    updateQuestUI();

    // Keep the Expedition Pass badge (and modal, if open) in sync
    updatePassUI();

    // Keep the Key Altar inventory in sync
    updateKeyInventoryUI();

    // Keep helper cards / status strip in sync
    refreshHelpersUI(false);

    // Keep the AFK upgrade cards (Gem Shop tab) in sync
    if (typeof refreshAfkUI === 'function') refreshAfkUI(false);

    // Keep the VIP / Frenzy HUD badges in sync
    updateShopHud();
}

/**
 * Main game loop, executed once per second.
 * Adds passive income from upgrades to the coin total, scaled by the
 * level and prestige multipliers, and grants experience for the automatic gold earned.
 */
function gameLoop() {
    // Shop: VIP / Frenzy expiry + HUD timers (once per tick)
    tickShop();

    // Helpers run inside the SAME 1s tick (no per-helper intervals).
    const helperGold = tickHelpers();

    if (gameState.coinsPerSecond <= 0 && helperGold > 0) {
        updateUI(); // helpers produced gold but the CPS branch below won't refresh the UI
    }

    if (gameState.coinsPerSecond > 0) {
        // Passive income gets every normal multiplier (incl. VIP) x Frenzy Potion
        const earned = gameState.coinsPerSecond * getPassiveIncomeMultiplier();
        addCoins(earned);
        gainExperience(earned);
        // Expedition Pass quest tracking: passive (CPS) income earned
        gameState.pass.dailyProgress.passiveEarned += earned;
        updateUI();
    }

    // Roll over Expedition Pass Daily/Weekly quests if their windows elapsed
    if (checkPassQuestResets()) {
        saveGame();
    }
    updatePassUI();

    // Roll over Daily Quests if 24 hours have passed, even with the
    // Pass & Quests modal closed, and keep the countdown ticking while open.
    if (checkDailyQuestReset()) {
        saveGame();
        updateQuestUI();
    } else if (dom.questsOverlay && dom.questsOverlay.classList.contains('open') && dom.passTabPanelQuests && dom.passTabPanelQuests.classList.contains('active')) {
        renderQuestResetTimer();
    }
    updateQuestBookBadge();
    updateActiveBuffUI();
}

/**
 * =========================================
 * QUEST BOOK: DAILY LOGIN REWARDS
 * =========================================
 */

/** Returns today's date as a 'YYYY-MM-DD' string in the player's local time. */
function getTodayDateString() {
    const now = new Date(GCTime.now()); // trusted clock, not the raw OS date
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * Normalizes any stored Daily Login date into a strict local 'YYYY-MM-DD' string, or null if it is
 * missing/invalid. Accepts the current format, ISO strings ('2025-01-31T10:00:00Z' -> date part),
 * and legacy numeric timestamps (ms since epoch -> local date). Never throws.
 * @param {*} value
 * @returns {string|null}
 */
function normalizeDailyDate(value) {
    if (value === null || value === undefined || value === '') return null;
    let y, m, d;
    if (typeof value === 'number' || (typeof value === 'string' && /^\d{9,}$/.test(value.trim()))) {
        const ts = Number(value);
        if (!Number.isFinite(ts) || ts <= 0) return null;
        const dt = new Date(ts);
        if (isNaN(dt.getTime())) return null;
        y = dt.getFullYear(); m = dt.getMonth() + 1; d = dt.getDate();
    } else if (typeof value === 'string') {
        const match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value.trim());
        if (!match) return null;
        y = Number(match[1]); m = Number(match[2]); d = Number(match[3]);
    } else {
        return null;
    }
    // Reject impossible dates such as 2025-13-45 or 2025-02-31.
    const check = new Date(Date.UTC(y, m - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
    return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Returns the number of whole calendar days between two 'YYYY-MM-DD' strings (b - a), or NaN if either is invalid. */
function daysBetweenDateStrings(a, b) {
    const na = normalizeDailyDate(a);
    const nb = normalizeDailyDate(b);
    if (!na || !nb) return NaN;
    const [ya, ma, da] = na.split('-').map(Number);
    const [yb, mb, db] = nb.split('-').map(Number);
    // UTC math on pure calendar dates: immune to DST shifts and time-zone offsets.
    return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000);
}

/**
 * Determines whether today's Daily Login reward has already been claimed.
 * Missing / invalid saved dates count as "not claimed".
 * @returns {boolean}
 */
function isDailyRewardClaimedToday() {
    const last = normalizeDailyDate(gameState.dailyLogin.lastClaimDate);
    if (!last) return false;
    // '>=' (YYYY-MM-DD sorts chronologically): a clock moved backwards can never re-open an already claimed day.
    return last >= getTodayDateString();
}

/**
 * Checks the gap since the last claim and resets the streak to 0 (so the
 * next claim starts fresh at Day 1) if the player missed a day. Safe to
 * call anytime; does nothing if the streak is already up to date or unset.
 * Invalid saved dates are cleaned up (streak restarts) instead of crashing.
 */
function checkDailyStreakReset() {
    const dl = gameState.dailyLogin;
    const streak = Number(dl.streak) || 0;
    dl.streak = (streak > 0 && streak <= DAILY_LOGIN_CYCLE_LENGTH) ? Math.floor(streak) : 0;

    const last = normalizeDailyDate(dl.lastClaimDate);
    dl.lastClaimDate = last; // store the canonical format (null if invalid/missing)
    if (!last || dl.streak === 0) {
        if (!last) dl.streak = 0; // a streak with no valid claim date cannot be continued
        return;
    }

    const gap = daysBetweenDateStrings(last, getTodayDateString());
    // gap <= 0: claimed today (or clock moved backwards). gap === 1: still an active streak, claimable today.
    // gap >= 2: at least one full day was missed, streak is broken.
    if (gap >= 2) {
        dl.streak = 0;
    }
}

let dailyClaimInProgress = false;

/**
 * Claims today's Daily Login reward, grants it, advances the streak
 * (wrapping back to Day 1 after Day 14), and records today's date.
 * Idempotent per calendar day: repeated clicks / re-renders can never grant twice.
 */
function claimDailyReward() {
    if (dailyClaimInProgress) return;
    dailyClaimInProgress = true;
    try {
        checkDailyStreakReset();

        if (isDailyRewardClaimedToday()) {
            if (typeof showIapToast === 'function') showIapToast(t('daily_claimed_today'));
            renderDailyLoginTab();
            return;
        }

        const nextStreakDay = (gameState.dailyLogin.streak % DAILY_LOGIN_CYCLE_LENGTH) + 1;
        const reward = computeDailyReward(nextStreakDay);
        if (!reward) return;

        // Record the claim BEFORE granting so nothing (UI rerender, re-entrant click) can claim twice.
        const prevStreak = gameState.dailyLogin.streak;
        const prevDate = gameState.dailyLogin.lastClaimDate;
        gameState.dailyLogin.streak = nextStreakDay;
        gameState.dailyLogin.lastClaimDate = getTodayDateString();

        try {
            grantReward(reward);
        } catch (err) {
            console.error('[DailyLogin] reward grant failed, claim rolled back:', err);
            gameState.dailyLogin.streak = prevStreak;
            gameState.dailyLogin.lastClaimDate = prevDate;
            renderDailyLoginTab();
            return;
        }

        saveGame();
        renderDailyLoginTab();
        updateUI();
        if (typeof showIapToast === 'function') showIapToast('✅ ' + reward.label);
    } finally {
        dailyClaimInProgress = false;
    }
}

/**
 * Grants a reward object ({ type, amount }) to the player, matching the
 * same reward shape used by Daily Login, Quests, and Achievements. Also
 * supports the Daily Login "buff" type and its optional bundled "bonus".
 * @param {{type: string, amount?: number, buff?: object, bonus?: object}} reward
 */
function grantReward(reward) {
    switch (reward.type) {
        case 'coins':
            addCoins(reward.amount);
            break;
        case 'xp':
            gainExperience(reward.amount / Math.max(gameState.xpMultiplier, 0.0001));
            break;
        case 'gems':
            gameState.gems += reward.amount;
            recalculatePrestigeMultiplier();
            break;
        case 'buff':
            activateDailyBuff(reward.buff);
            if (reward.bonus) {
                grantReward(reward.bonus); // e.g. the flat Gem bonus bundled with Day 7 / Day 14
            }
            break;
    }
    playUpgradeSound();
}

/** Formats a reward object into a short display label, e.g. "200 🪙". */
function formatRewardLabel(reward) {
    const k = 'reward_label_' + reward.type;
    return TRANSLATIONS.en[k] !== undefined ? t(k, { amount: formatNumber(reward.amount) }) : String(formatNumber(reward.amount));
}

/**
 * =========================================
 * DAILY LOGIN TEMPORARY BUFFS
 * =========================================
 * Activates a temporary multiplier buff (e.g. "2x Click Power for 30 mins")
 * granted by milestone Daily Login rewards. Only one buff is active at a
 * time; activating a new one overwrites the previous.
 * @param {{key:string,label:string,icon:string,clickMult:number,cpsMult:number,durationMinutes:number}} buffDef
 */
function activateDailyBuff(buffDef) {
    gameState.dailyLogin.activeBuff = {
        key: buffDef.key,
        label: buffDef.label,
        icon: buffDef.icon,
        clickMult: buffDef.clickMult || 1,
        cpsMult: buffDef.cpsMult || 1,
        expiresAt: GCTime.now() + buffDef.durationMinutes * 60 * 1000
    };
    updateActiveBuffUI();
}

/** Returns the active Daily Login buff if it exists and hasn't expired yet, else null (and clears expired buffs). */
function getActiveDailyBuff() {
    const buff = gameState.dailyLogin.activeBuff;
    if (!buff) return null;
    if (GCTime.now() >= buff.expiresAt) {
        gameState.dailyLogin.activeBuff = null;
        return null;
    }
    return buff;
}

/** Current click-power multiplier contributed by an active Daily Login buff (1 = no buff). */
function getBuffClickMultiplier() {
    const buff = getActiveDailyBuff();
    return buff ? buff.clickMult : 1;
}

/** Current CPS/income multiplier contributed by an active Daily Login buff (1 = no buff). */
function getBuffCpsMultiplier() {
    const buff = getActiveDailyBuff();
    return buff ? buff.cpsMult : 1;
}

/**
 * Returns the active Mini-Event buff (e.g. "Frenzy" from a Glowing
 * Crystal) if it exists and hasn't expired yet, else null (and clears
 * expired buffs). Kept as a separate slot from the Daily Login buff so
 * the two systems never clobber each other; their multipliers stack.
 */
function getActiveEventBuff() {
    const buff = gameState.eventBuff;
    if (!buff) return null;
    if (GCTime.now() >= buff.expiresAt) {
        gameState.eventBuff = null;
        return null;
    }
    return buff;
}

/** Current click-power multiplier contributed by an active Mini-Event buff (1 = no buff). */
function getEventBuffClickMultiplier() {
    const buff = getActiveEventBuff();
    return buff ? buff.clickMult : 1;
}

/** Current CPS/income multiplier contributed by an active Mini-Event buff (1 = no buff). */
function getEventBuffCpsMultiplier() {
    const buff = getActiveEventBuff();
    return buff ? buff.cpsMult : 1;
}

/**
 * Updates the on-screen active-buff indicator (icon, label, and remaining
 * time). Prefers showing the Mini-Event buff (Frenzy) when active, since
 * it's short and urgent; falls back to the Daily Login buff otherwise.
 * Clears the indicator once both buffs have expired.
 */
let lastBuffUiSig = null;
function updateActiveBuffUI() {
    if (!dom.activeBuffIndicator) return;
    const eventBuff = getActiveEventBuff();
    const dailyBuff = getActiveDailyBuff();
    const buff = eventBuff || dailyBuff;

    if (!buff) {
        if (lastBuffUiSig !== 'none') {
            lastBuffUiSig = 'none';
            dom.activeBuffIndicator.style.display = 'none';
        }
        return;
    }

    const remainingMs = Math.max(0, buff.expiresAt - GCTime.now());
    const minutes = Math.floor(remainingMs / 60000);
    const seconds = Math.floor((remainingMs % 60000) / 1000);

    const html = `
        <span class="active-buff-icon">${buff.icon}</span>
        <span class="active-buff-label">${localizedBuffLabel(buff)}</span>
        <span class="active-buff-timer">${minutes}:${String(seconds).padStart(2, '0')}</span>
    `;
    const sig = (eventBuff ? 'e' : 'd') + html;
    if (sig === lastBuffUiSig) return; // nothing visible changed
    lastBuffUiSig = sig;

    dom.activeBuffIndicator.style.display = 'flex';
    dom.activeBuffIndicator.classList.toggle('active-buff-indicator-event', !!eventBuff);
    dom.activeBuffIndicator.innerHTML = html;
}

/**
 * =========================================
 * RANDOM MINI-EVENTS (Golden Meteor / Glowing Crystal)
 * =========================================
 * A glowing collectible spawns at a random screen position every 2-4
 * minutes (scaled faster by any owned "eventLuck" relics). Clicking it
 * before it despawns (7 seconds) grants one of three randomized rewards:
 * a Gold Burst, a temporary Frenzy click-power buff, or a handful of
 * Gems. Purely additive to the main game loop — never blocks or alters
 * existing mechanics.
 */
const MINI_EVENT_CONFIG = {
    minDelayMs: 2 * 60 * 1000,   // 2 minutes
    maxDelayMs: 4 * 60 * 1000,   // 4 minutes
    lifetimeMs: 7 * 1000,        // despawns after 7 seconds if unclicked
    frenzy: {
        clickMult: 5,            // +400% Click Power (5x total) for the duration
        durationMs: 20 * 1000    // 20 seconds
    },
    goldBurstCpsSeconds: 300,    // Gold Burst = CPS * 300
    goldBurstClickFallbackClicks: 150, // fallback multiplier on click power when CPS is 0
    gemClusterMin: 1,
    gemClusterMax: 3
};

let miniEventTimeoutId = null;
let activeMiniEventEl = null;

/** Schedules the next mini-event spawn after a random 2-4 minute delay (faster with eventLuck relics). */
function scheduleNextMiniEvent() {
    if (miniEventTimeoutId) clearTimeout(miniEventTimeoutId);
    const luck = getRelicEventLuckMultiplier(); // > 1 shortens the wait
    const baseDelay = MINI_EVENT_CONFIG.minDelayMs
        + Math.random() * (MINI_EVENT_CONFIG.maxDelayMs - MINI_EVENT_CONFIG.minDelayMs);
    const delay = Math.max(15000, baseDelay / luck); // never faster than a 15s floor, however lucky

    miniEventTimeoutId = setTimeout(() => {
        spawnMiniEvent();
        scheduleNextMiniEvent();
    }, delay);
}

/**
 * Creates the glowing event element at a random on-screen position and
 * wires up its click handler and despawn timer. Only one event can be
 * active at a time — if one is already on screen, this call is skipped
 * (the next scheduled attempt will try again).
 */
function spawnMiniEvent() {
    if (activeMiniEventEl) return; // one at a time
    if (isGamePaused()) return;    // never spawn while paused (the next scheduled attempt retries)

    // Randomly flavor it as a "meteor" or "crystal" — purely cosmetic.
    const isMeteor = Math.random() < 0.5;
    const icon = isMeteor ? '☄️' : '💎';

    const el = document.createElement('div');
    el.className = 'mini-event' + (isMeteor ? ' mini-event-meteor' : ' mini-event-crystal');
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', t(isMeteor ? 'mini_meteor_aria' : 'mini_crystal_aria'));
    el.innerHTML = `<span class="mini-event-glow"></span><span class="mini-event-icon">${icon}</span>`;

    // Keep it fully within the viewport, away from the very edges.
    const margin = 60;
    const maxX = Math.max(margin, window.innerWidth - margin);
    const maxY = Math.max(margin, window.innerHeight - margin);
    const x = margin + Math.random() * (maxX - margin);
    const y = margin + Math.random() * (maxY - margin);
    el.style.left = x + 'px';
    el.style.top = y + 'px';

    document.body.appendChild(el);
    activeMiniEventEl = el;
    playMiniEventSpawnSound();

    // Lifetime only counts down while the game runs (paused time does not use it up).
    let despawnTimer = null;
    let lifeLeftMs = MINI_EVENT_CONFIG.lifetimeMs;
    const lifeStep = 250;
    const lifeTick = () => {
        if (!el.isConnected) return;
        if (!isGamePaused()) lifeLeftMs -= lifeStep;
        if (lifeLeftMs <= 0) { despawnMiniEvent(el, false); return; }
        despawnTimer = setTimeout(lifeTick, lifeStep);
    };
    despawnTimer = setTimeout(lifeTick, lifeStep);

    el.addEventListener('click', () => {
        clearTimeout(despawnTimer);
        collectMiniEvent(el);
    });
}

/**
 * Removes the mini-event element from the DOM, playing the appropriate
 * sound depending on whether it was collected or simply expired.
 * @param {HTMLElement} el
 * @param {boolean} wasCollected
 */
function despawnMiniEvent(el, wasCollected) {
    if (!el || !el.isConnected) {
        activeMiniEventEl = null;
        return;
    }
    if (!wasCollected) {
        playMiniEventDespawnSound();
        el.classList.add('mini-event-fizzle');
    }
    setTimeout(() => el.remove(), wasCollected ? 0 : 350);
    if (activeMiniEventEl === el) activeMiniEventEl = null;
}

/**
 * Handles a successful click on a mini-event: rolls one of the three
 * reward types, applies it, shows floating feedback text, and removes
 * the element.
 * @param {HTMLElement} el
 */
function collectMiniEvent(el) {
    initAudio();
    const rect = el.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const rewardRoll = Math.floor(Math.random() * 3);
    let label = '';

    if (rewardRoll === 0) {
        // a) Gold Burst: CPS * 300, falling back to a click-power-based
        // amount for players with little/no passive income yet.
        const cps = gameState.coinsPerSecond * getTotalMultiplier();
        let amount = cps * MINI_EVENT_CONFIG.goldBurstCpsSeconds;
        if (amount <= 0) {
            amount = getBaseClickAmount() * getTotalMultiplier() * MINI_EVENT_CONFIG.goldBurstClickFallbackClicks;
        }
        amount = Math.max(amount, 10); // guarantee a meaningful reward even at the very start
        addCoins(amount);
        label = t('mini_gold_burst', { amount: formatNumber(amount) });
    } else if (rewardRoll === 1) {
        // b) Frenzy Buff: +400% Click Power (5x total) for 20 seconds.
        gameState.eventBuff = {
            key: 'frenzy',
            get label() { return t('buff_frenzy'); },
            icon: '🔥',
            clickMult: MINI_EVENT_CONFIG.frenzy.clickMult,
            cpsMult: 1,
            expiresAt: GCTime.now() + MINI_EVENT_CONFIG.frenzy.durationMs
        };
        updateActiveBuffUI();
        label = t('mini_frenzy_text');
    } else {
        // c) Gem Cluster: +1 to 3 Gems.
        const gemsWon = MINI_EVENT_CONFIG.gemClusterMin
            + Math.floor(Math.random() * (MINI_EVENT_CONFIG.gemClusterMax - MINI_EVENT_CONFIG.gemClusterMin + 1));
        gameState.gems += gemsWon;
        label = tp('mini_gems', gemsWon, { n: gemsWon });
    }

    playMiniEventCollectSound();
    spawnMiniEventRewardText(centerX, centerY, label);
    despawnMiniEvent(el, true);

    updateUI();
    saveGame();
}

/** Floating reward-label text shown at the mini-event's position when collected. */
function spawnMiniEventRewardText(x, y, text) {
    const floatEl = document.createElement('div');
    floatEl.className = 'mini-event-reward-text';
    floatEl.textContent = text;
    floatEl.style.left = x + 'px';
    floatEl.style.top = y + 'px';
    document.body.appendChild(floatEl);
    setTimeout(() => floatEl.remove(), 1400);
}

/**
 * Renders the 14-day Daily Login calendar and claim button based on the
 * player's current streak and claim status. Every card's reward is
 * recomputed live from the player's current stats (see computeDailyReward),
 * so the calendar always reflects rewards that are valuable right now.
 */
function renderDailyLoginTab() {
    checkDailyStreakReset();
    bindDailyLoginEvents();

    const { streak } = gameState.dailyLogin;
    const claimedToday = isDailyRewardClaimedToday();
    // The day about to be claimed (or just claimed) this cycle
    const activeDay = claimedToday ? streak : (streak % DAILY_LOGIN_CYCLE_LENGTH) + 1;

    setTextIfChanged(dom.dailyStreakLabel, t('daily_streak', { day: streak || 0, total: DAILY_LOGIN_CYCLE_LENGTH }));
    setTextIfChanged(dom.dailyNextLabel, claimedToday ? t('daily_come_back') : t('daily_claim_below'));

    const grid = dom.dailyLoginGrid;
    let cards = grid.querySelectorAll(':scope > .daily-day-card');
    let claimBtn = grid.querySelector(':scope > #daily-claim-button');

    // Build the structure once. Afterwards the SAME elements are updated in place, so a rerender
    // (this runs ~5x/second via updateQuestUI) can never swap the button out from under a click.
    if (cards.length !== DAILY_LOGIN_CYCLE_LENGTH || !claimBtn) {
        grid.innerHTML = '';
        for (let day = 1; day <= DAILY_LOGIN_CYCLE_LENGTH; day++) {
            const card = document.createElement('div');
            card.dataset.day = String(day);
            grid.appendChild(card);
        }
        claimBtn = document.createElement('button');
        claimBtn.id = 'daily-claim-button';
        claimBtn.className = 'quest-claim-btn';
        claimBtn.type = 'button';
        grid.appendChild(claimBtn);
        cards = grid.querySelectorAll(':scope > .daily-day-card, :scope > div[data-day]');
    }

    cards.forEach((card, i) => {
        const day = i + 1;
        const reward = computeDailyReward(day);
        const isClaimed = day < activeDay || (day === activeDay && claimedToday);
        const isToday = day === activeDay && !claimedToday;
        const isMilestone = !!reward.milestone;

        const className = 'daily-day-card'
            + (isClaimed ? ' claimed' : '')
            + (isToday ? ' today' : '')
            + (!isClaimed && !isToday ? ' locked' : '')
            + (isMilestone ? ' milestone' : '');
        if (card.className !== className) card.className = className;

        const html = `
            <div class="frame-corner top-left"></div>
            <div class="frame-corner top-right"></div>
            <div class="frame-corner bottom-left"></div>
            <div class="frame-corner bottom-right"></div>
            <span class="day-label">${t('daily_day_label', { day })}</span>
            <span class="day-icon">${reward.icon}</span>
            <span class="day-reward">${reward.label}</span>
        `;
        if (card.__html !== html) { card.innerHTML = html; card.__html = html; }
        card.dataset.day = String(day);
    });

    const btnText = claimedToday ? t('daily_claimed_today') : t('daily_claim_day', { day: activeDay });
    if (claimBtn.textContent !== btnText) claimBtn.textContent = btnText;
    if (claimBtn.disabled !== claimedToday) claimBtn.disabled = claimedToday;
}

/**
 * Event delegation for the Daily Login calendar. ONE listener lives on the stable #daily-login-grid
 * container (never replaced), so the claim button / today's card keep working no matter how often the
 * inner DOM is rebuilt. Idempotent: calling it repeatedly never adds a second listener.
 */
function bindDailyLoginEvents() {
    const grid = dom.dailyLoginGrid;
    if (!grid || grid.__dailyClaimBound) return;
    grid.__dailyClaimBound = true;
    grid.addEventListener('click', (e) => {
        const target = e.target instanceof Element ? e.target : null;
        if (!target) return;
        const btn = target.closest('#daily-claim-button');
        const todayCard = target.closest('.daily-day-card.today');
        if ((btn && !btn.disabled) || todayCard) {
            claimDailyReward();
        }
    });
}

/**
 * =========================================
 * QUEST BOOK: DAILY QUESTS & ACHIEVEMENTS
 * =========================================
 */

/** Returns true if the given quest/achievement's target has been reached. */
function isQuestComplete(questDef) {
    if (!questDef) return false;
    return trackQuestProgress(questDef) >= questDef.target;
}

/** Returns true if the given Daily Quest's reward has already been claimed this cycle. */
function isQuestClaimed(questKey) {
    return gameState.completedQuests.includes(questKey);
}

/** Returns true if the given Achievement's reward has already been claimed. */
function isAchievementClaimed(achievementKey) {
    return gameState.completedAchievements.includes(achievementKey);
}

/**
 * Claims the reward for a completed Daily Quest, marks it as claimed, and
 * persists/re-renders.
 * @param {string} questKey
 */
function claimQuestReward(questKey) {
    const questDef = gameState.dailyQuests.find(q => q.key === questKey);
    if (!questDef) return;
    if (isQuestClaimed(questKey) || !isQuestComplete(questDef)) return;

    grantReward(questDef.reward);
    gameState.completedQuests.push(questKey);

    saveGame();
    renderQuestsTab();
    updateUI();
}

/**
 * Claims the reward for a completed permanent Achievement, marks it as
 * claimed, and persists/re-renders.
 * @param {string} achievementKey
 */
function claimAchievementReward(achievementKey) {
    const achievementDef = ACHIEVEMENT_DEFINITIONS.find(a => a.key === achievementKey);
    if (!achievementDef) return;
    if (isAchievementClaimed(achievementKey) || !isQuestComplete(achievementDef)) return;

    grantReward(achievementDef.reward);
    gameState.completedAchievements.push(achievementKey);

    saveGame();
    renderQuestsTab();
    updateUI();
}

/** Builds one quest/achievement card element. Shared by both lists. */
function buildQuestCard(def, complete, claimed, onClaim) {
    const progress = Math.min(trackQuestProgress(def), def.target);
    const pct = Math.min(100, (progress / def.target) * 100);

    const card = document.createElement('div');
    card.className = 'quest-card' + (complete ? ' completed' : '') + (claimed ? ' claimed' : '') + ' reward-' + String(def.reward && def.reward.type).replace(/[^a-z0-9_-]/gi, '');

    card.innerHTML = `
        <div class="quest-card-top">
            <span class="quest-card-name">${def.icon} ${questDisplayName(def)}</span>
            <span class="quest-card-reward">${formatRewardLabel(def.reward)}</span>
        </div>
        <div class="quest-progress-outer">
            <div class="quest-progress-inner" style="width:${pct}%;"></div>
        </div>
        <div class="quest-progress-label">${t('quest_progress_line', { progress: formatNumber(progress), target: formatNumber(def.target), desc: questDisplayDescription(def) })}</div>
        <div class="quest-card-bottom">
            <button class="quest-claim-btn" ${(!complete || claimed) ? 'disabled' : ''}>
                ${claimed ? t('quest_btn_claimed') : (complete ? t('quest_btn_claim') : t('quest_btn_progress'))}
            </button>
        </div>
    `;

    card.querySelector('.quest-claim-btn').onclick = onClaim;
    return card;
}

/** Updates the "Quests Reset In: Xh Ym" countdown label. */
function renderQuestResetTimer() {
    if (!dom.questResetTimer) return;
    dom.questResetTimer.textContent = t('quests_reset_in', { time: formatCountdown(getQuestResetTimeRemaining()) });
}

/** Renders the 5-6 active Daily Quest cards with live progress and the reset timer. */
function renderDailyQuests() {
    if (checkDailyQuestReset()) {
        saveGame();
    }
    renderQuestResetTimer();

    dom.dailyQuestList.innerHTML = '';
    gameState.dailyQuests.forEach(questDef => {
        const complete = isQuestComplete(questDef);
        const claimed = isQuestClaimed(questDef.key);
        const card = buildQuestCard(questDef, complete, claimed, () => claimQuestReward(questDef.key));
        dom.dailyQuestList.appendChild(card);
    });
}

/** Renders every permanent Achievement card. */
function renderAchievements() {
    dom.achievementList.innerHTML = '';
    ACHIEVEMENT_DEFINITIONS.forEach(achievementDef => {
        const complete = isQuestComplete(achievementDef);
        const claimed = isAchievementClaimed(achievementDef.key);
        const card = buildQuestCard(achievementDef, complete, claimed, () => claimAchievementReward(achievementDef.key));
        dom.achievementList.appendChild(card);
    });
}

/** Renders the Daily Quests list (Achievements now render in their own modal). */
function renderQuestsTab() {
    renderDailyQuests();
}

/** Counts how many daily quests + daily login rewards are ready to claim (for the Pass & Quests nav dot). */
function countClaimableQuests() {
    const claimableQuests = gameState.dailyQuests.filter(q => isQuestComplete(q) && !isQuestClaimed(q.key)).length;
    return claimableQuests + (isDailyRewardClaimedToday() ? 0 : 1);
}

/** Counts how many achievements are complete but not yet claimed (for the Achievements nav dot). */
function countClaimableAchievements() {
    return ACHIEVEMENT_DEFINITIONS.filter(a => isQuestComplete(a) && !isAchievementClaimed(a.key)).length;
}

/** Updates the Achievements nav dot. (The Pass & Quests dot is handled by updatePassUI.) */
function updateQuestBookBadge() {
    const achievementCount = countClaimableAchievements();
    if (dom.navTabDotAchievements) {
        dom.navTabDotAchievements.style.display = achievementCount > 0 ? 'flex' : 'none';
    }
}

/** Refreshes whichever Quests modal sub-tab is currently visible, plus badges. */
function updateQuestUI() {
    updateQuestBookBadge();
    if (!dom.questsOverlay || !dom.questsOverlay.classList.contains('open')) return;

    if (dom.passTabPanelDaily && dom.passTabPanelDaily.classList.contains('active')) {
        renderDailyLoginTab();
    } else if (dom.passTabPanelQuests && dom.passTabPanelQuests.classList.contains('active')) {
        renderPassQuestTab();
        renderDailyQuests();
    }
}

/** Opens the Achievements modal and renders the current achievement state. */
function openAchievements() {
    dom.achievementsOverlay.classList.add('open');
    renderAchievements();
    setActiveNavTab('achievements');
}

/** Closes the Achievements modal. */
function closeAchievements() {
    dom.achievementsOverlay.classList.remove('open');
    setActiveNavTab('main');
}

/**
 * =========================================
 * FIXED 3D BOTTOM NAVIGATION BAR
 * =========================================
 * A single sticky bar with 4 tabs: Main, Pass & Quests, Achievements,
 * Prestige. "Main" scrolls back to the clicker/shop screen; the other
 * three open their respective full-screen modals. Whichever destination
 * is currently active gets the .active highlight, and any open modal is
 * closed automatically when another tab is picked so only one view shows
 * at a time.
 */

/**
 * Highlights the given tab as active and clears the others. Does not open
 * or close anything itself — callers handle that — this only keeps the
 * bar's visual state in sync with whatever is currently on screen.
 * @param {string} tabName 'main' | 'pass' | 'quests' | 'achievements' | 'prestige'
 */
function setActiveNavTab(tabName) {
    if (dom.navTabMain) dom.navTabMain.classList.toggle('active', tabName === 'main');
    if (dom.navTabPass) dom.navTabPass.classList.toggle('active', tabName === 'pass');
    if (dom.navTabQuests) dom.navTabQuests.classList.toggle('active', tabName === 'quests');
    if (dom.navTabAchievements) dom.navTabAchievements.classList.toggle('active', tabName === 'achievements');
    if (dom.navTabPrestige) dom.navTabPrestige.classList.toggle('active', tabName === 'prestige');
    if (dom.navTabShop) dom.navTabShop.classList.toggle('active', tabName === 'shop');
    const advTab = document.getElementById('nav-tab-adventures');
    if (advTab) advTab.classList.toggle('active', tabName === 'adventures');
}

/** Closes any currently-open full-screen modal (used when switching nav tabs). */
function closeAllNavModals() {
    if (dom.passOverlay && dom.passOverlay.classList.contains('open')) dom.passOverlay.classList.remove('open');
    if (dom.questsOverlay && dom.questsOverlay.classList.contains('open')) dom.questsOverlay.classList.remove('open');
    if (dom.achievementsOverlay && dom.achievementsOverlay.classList.contains('open')) dom.achievementsOverlay.classList.remove('open');
    if (dom.skillTreeOverlay && dom.skillTreeOverlay.classList.contains('open')) dom.skillTreeOverlay.classList.remove('open');
    if (dom.bossOverlay && dom.bossOverlay.classList.contains('open')) dom.bossOverlay.classList.remove('open');
    const iapOverlayEl = document.getElementById('iap-overlay');
    if (iapOverlayEl && iapOverlayEl.classList.contains('open')) iapOverlayEl.classList.remove('open');
}

/** Wires up the bottom nav's 5 tabs to their destinations. */
function initBottomNav() {
    if (dom.navTabMain) {
        dom.navTabMain.addEventListener('click', () => {
            closeAllNavModals();
            setActiveNavTab('main');
            if (dom.mainView) {
                dom.mainView.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } else {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        });
    }

    if (dom.navTabPass) {
        dom.navTabPass.addEventListener('click', () => {
            closeAllNavModals();
            openExpeditionPass();
        });
    }

    if (dom.navTabQuests) {
        dom.navTabQuests.addEventListener('click', () => {
            closeAllNavModals();
            openQuestsModal('quests');
        });
    }

    if (dom.navTabAchievements) {
        dom.navTabAchievements.addEventListener('click', () => {
            closeAllNavModals();
            setActiveNavTab('achievements');
            openAchievements();
        });
    }

    if (dom.navTabPrestige) {
        dom.navTabPrestige.addEventListener('click', () => {
            closeAllNavModals();
            openSkillTree();
        });
    }
}

/**
 * =========================================
 * DWARVEN EXPEDITION PASS
 * =========================================
 * A 60-level Battle Pass with a Free and Premium reward track. Both
 * tracks are unlocked by default (no payment gating) so
 * every reward is claimable purely through play. XP requirement is a flat
 * 1,000 XP per level (60,000 XP total to max rank), earned ONLY by
 * claiming Daily/Weekly Pass Quests (see addPassXP), and tracked completely
 * separately from player XP in gameState.pass.
 *
 * Reward design goals (see grantPassReward / buildPassLevelRewards):
 *  - Always relevant regardless of current level/biome: time-warps grant
 *    a fraction of the player's CURRENT CPS, so they scale automatically.
 *  - Gems are the steady mid-value reward, escalating gently with level.
 *  - Milestone levels (every 5th) hand out temporary click/CPS multiplier
 *    buffs (reusing the existing Daily Login buff engine) or big Gem/
 *    time-warp bundles, so the pacing has periodic high points.
 *  - Level 60 (max rank) is the biggest single payout.
 */
const PASS_MAX_LEVEL = 60;
const PASS_XP_PER_LEVEL = 1000;

/** Total Pass XP required to go from level N to level N+1. Flat by design. */
function getPassXpForLevel(level) {
    return PASS_XP_PER_LEVEL;
}

/**
 * Builds the { free, premium } reward pair for a given Pass level (1-60).
 * Rewards are computed fresh from the player's CURRENT stats every time
 * they're displayed/claimed, so a reward "3 hours of current CPS" is always
 * worth 3 hours of whatever the player is earning right now — never stale.
 * @param {number} level
 * @returns {{free: object, premium: object}}
 */
function buildPassLevelRewards(level) {
    const isMilestone = level % 5 === 0;
    const isMaxLevel = level === PASS_MAX_LEVEL;

    // ---- FREE TRACK ----
    // Baseline: modest Gems every level, scaling gently with level.
    let free;
    if (isMaxLevel) {
        free = { type: 'gems', amount: 100, icon: '💎', label: t('pass_free_gems', { amount: 100 }) };
    } else if (isMilestone) {
        // Every 5th level on the Free track: a short time-warp of current CPS.
        const minutes = 15 + Math.floor(level / 5) * 2; // grows slowly, 17m -> ~41m by lvl60
        free = { type: 'timewarp', minutes, icon: '⏳', label: t('pass_free_timewarp', { minutes }) };
    } else {
        const amount = 3 + Math.floor(level / 4);
        free = { type: 'gems', amount, icon: '💎', label: t('pass_free_gems', { amount }) };
    }

    // ---- PREMIUM TRACK ----
    // Always strictly more valuable than the Free reward at the same level.
    let premium;
    if (isMaxLevel) {
        premium = {
            type: 'bundle',
            icon: '👑',
            label: t('pass_premium_max'),
            parts: [
                { type: 'gems', amount: 250 },
                { type: 'timewarp', minutes: 120 },
                { type: 'buff', buff: { key: 'passMaxBuff', label: t('buff_passMaxBuff'), icon: '👑', clickMult: 3, cpsMult: 3, durationMinutes: 60 } }
            ]
        };
    } else if (isMilestone) {
        // Every 5th level on Premium: a temporary click/CPS multiplier buff,
        // strength and duration both growing with level.
        const tier = level / 5; // 1..11 (excludes 60, handled above as max)
        const mult = Math.min(3, 1.5 + tier * 0.15);
        const durationMinutes = 20 + tier * 4;
        premium = {
            type: 'buff',
            icon: '⚡',
            label: t('pass_premium_buff', { mult: mult.toFixed(1), minutes: durationMinutes }),
            buff: {
                key: `passBuff${level}`,
                label: t('buff_pass_mult', { mult: mult.toFixed(1) }),
                icon: '⚡',
                clickMult: mult,
                cpsMult: mult,
                durationMinutes
            }
        };
    } else {
        // Regular premium levels: a bigger Gem grant plus a short time-warp,
        // both scaled by level so they never feel trivial late-game.
        const gemAmount = 8 + Math.floor(level / 2);
        const minutes = 10 + Math.floor(level / 3);
        premium = {
            type: 'bundle',
            icon: '👑',
            label: t('pass_premium_bundle', { gems: gemAmount, minutes }),
            parts: [
                { type: 'gems', amount: gemAmount },
                { type: 'timewarp', minutes }
            ]
        };
    }

    return { free, premium };
}

/**
 * Grants a single Pass reward slot (free or premium) to the player.
 * Understands the extra "timewarp" and "bundle" reward shapes on top of
 * the base coins/xp/gems/buff types already handled by grantReward().
 * A "timewarp" grants coins equal to N minutes of the player's CURRENT
 * effective CPS, so it always stays proportional to their progression.
 * @param {object} rewardSlot - a `free` or `premium` object from buildPassLevelRewards()
 */
function grantPassReward(rewardSlot) {
    switch (rewardSlot.type) {
        case 'timewarp': {
            const effectiveCps = gameState.coinsPerSecond * getTotalMultiplier();
            const amount = effectiveCps * rewardSlot.minutes * 60;
            if (amount > 0) addCoins(amount);
            break;
        }
        case 'bundle':
            rewardSlot.parts.forEach(part => grantPassReward(part));
            break;
        case 'buff':
            activateDailyBuff(rewardSlot.buff);
            break;
        default:
            // coins / xp / gems all match grantReward()'s existing shape
            grantReward(rewardSlot);
            break;
    }
}

/** Returns true if the player has reached (or passed) a given Pass level. */
function passLevelReached(level) {
    return gameState.pass.level > level || (gameState.pass.level === level && level === PASS_MAX_LEVEL)
        ? true
        : gameState.pass.level >= level;
}

/** Returns true if a given level's Free reward has already been claimed. */
function isPassFreeClaimed(level) {
    return gameState.pass.claimedFree.includes(level);
}

/** Returns true if a given level's Premium reward has already been claimed. */
function isPassPremiumClaimed(level) {
    return gameState.pass.claimedPremium.includes(level);
}

/**
 * Claims one track's reward (free or premium) for a given Pass level, if
 * the player has reached that level and hasn't already claimed it.
 * @param {number} level
 * @param {'free'|'premium'} track
 */
function claimPassReward(level, track) {
    if (level > gameState.pass.level) return;
    // Premium rewards require ownership of the Premium Expedition Pass.
    if (track === 'premium' && !isPremiumPassUnlocked()) return;
    const claimedList = track === 'free' ? gameState.pass.claimedFree : gameState.pass.claimedPremium;
    if (claimedList.includes(level)) return;

    const { free, premium } = buildPassLevelRewards(level);
    if (track === 'premium' && !isPremiumPassUnlocked()) return; // defense in depth: never grant premium without the pass
    grantPassReward(track === 'free' ? free : premium);
    claimedList.push(level);

    playUpgradeSound();
    saveGame();
    renderPassRewardsTrack();
    updatePassUI();
    updateUI();
}

/**
 * SOLE writer of gameState.pass.xp / gameState.pass.level progression.
 * Must ONLY be called from claimPassQuestReward() (Daily/Weekly Pass Quest
 * claims). Never call from clicking, mining, CPS, offline earnings or
 * gainExperience() -- those award main character XP only.
 * Handles level-ups up to the level cap; excess XP past level 60 is discarded.
 * @param {number} xpAmount
 */
function addPassXP(xpAmount) {
    if (gameState.pass.level >= PASS_MAX_LEVEL) return;
    gameState.pass.xp += xpAmount;

    let leveledUp = false;
    while (gameState.pass.level < PASS_MAX_LEVEL && gameState.pass.xp >= getPassXpForLevel(gameState.pass.level)) {
        gameState.pass.xp -= getPassXpForLevel(gameState.pass.level);
        gameState.pass.level += 1;
        leveledUp = true;
    }
    if (gameState.pass.level >= PASS_MAX_LEVEL) {
        gameState.pass.xp = 0; // no overflow display once maxed
    }
    if (leveledUp) {
        updatePassUI();
        updateQuestBookBadge();
    }
}

/**
 * =========================================
 * DWARVEN EXPEDITION PASS — QUEST POOLS
 * =========================================
 * Fixed (non-randomized) Daily and Weekly quest lists, exactly as specified.
 * Unlike the existing Daily Quest system (randomly rotated from a pool),
 * every Pass quest below is always active every cycle — they represent the
 * Pass's own curated task list.
 */
const PASS_DAILY_QUESTS = [
    {
        key: 'manualMining',
        get name() { return t('pass_q_manualMining'); },
        icon: '⛏️',
        description: (target) => t('pass_q_manualMining_desc', { n: formatNumber(target) }),
        target: 1500,
        track: (state) => state.pass.dailyProgress.clicks,
        reward: { type: 'xp', amount: 500 }
    },
    {
        key: 'upgrader',
        get name() { return t('pass_q_upgrader'); },
        icon: '🛠️',
        description: (target) => t('pass_q_upgrader_desc', { n: formatNumber(target) }),
        target: 50,
        track: (state) => state.pass.dailyProgress.upgradesBought,
        reward: { type: 'xp', amount: 300 }
    },
    {
        key: 'goldHoarder',
        get name() { return t('pass_q_goldHoarder'); },
        icon: '💰',
        description: () => t('pass_q_goldHoarder_desc'),
        // Target recalculated each render from the player's CURRENT CPS, so
        // it always represents "2 hours of passive income" fairly.
        computeTarget: (state) => Math.max(1, state.coinsPerSecond * getTotalMultiplier() * 2 * 60 * 60),
        track: (state) => state.pass.dailyProgress.passiveEarned,
        reward: { type: 'xp', amount: 400 }
    },
    {
        key: 'precisionStrike',
        get name() { return t('pass_q_precisionStrike'); },
        icon: '✨',
        description: (target) => t('pass_q_precisionStrike_desc', { n: formatNumber(target) }),
        target: 30,
        track: (state) => state.pass.dailyProgress.critClicks,
        reward: { type: 'xp', amount: 300 }
    }
];

const PASS_WEEKLY_QUESTS = [
    {
        key: 'deepReset',
        get name() { return t('pass_q_deepReset'); },
        icon: '🌀',
        description: (target) => tp('pass_q_deepReset_desc', target, { n: formatNumber(target) }),
        target: 1,
        track: (state) => state.pass.weeklyProgress.prestiges,
        reward: { type: 'xp', amount: 2000 }
    },
    {
        key: 'marathonMiner',
        get name() { return t('pass_q_marathonMiner'); },
        icon: '🏃',
        description: (target) => t('pass_q_marathonMiner_desc', { n: formatNumber(target) }),
        target: 15000,
        track: (state) => state.pass.weeklyProgress.clicks,
        reward: { type: 'xp', amount: 2500 }
    },
    {
        key: 'industrialist',
        get name() { return t('pass_q_industrialist'); },
        icon: '🏭',
        description: (target) => t('pass_q_industrialist_desc', { n: formatNumber(target) }),
        target: 500,
        // Cumulative, so this tracks total upgrades owned right now rather
        // than a "since last reset" counter — always fair even mid-week.
        track: (state) => {
            let total = 0;
            for (const key in state.upgrades) total += state.upgrades[key].owned;
            return total;
        },
        reward: { type: 'xp', amount: 1500 }
    }
];

/** Resolves a Pass quest's numeric target, supporting fixed or dynamic (computeTarget) targets. */
function getPassQuestTarget(questDef) {
    return typeof questDef.computeTarget === 'function' ? questDef.computeTarget(gameState) : questDef.target;
}

/** Returns true if a Pass quest (daily or weekly) has reached its target. */
function isPassQuestComplete(questDef) {
    return questDef.track(gameState) >= getPassQuestTarget(questDef);
}

/** Returns true if a Pass quest's reward has already been claimed this cycle. */
function isPassQuestClaimed(questDef, cycle) {
    const list = cycle === 'daily' ? gameState.pass.completedDailyQuests : gameState.pass.completedWeeklyQuests;
    return list.includes(questDef.key);
}

/** Claims a Pass Daily or Weekly quest's XP reward. */
function claimPassQuestReward(questKey, cycle) {
    const pool = cycle === 'daily' ? PASS_DAILY_QUESTS : PASS_WEEKLY_QUESTS;
    const questDef = pool.find(q => q.key === questKey);
    if (!questDef) return;
    if (isPassQuestClaimed(questDef, cycle) || !isPassQuestComplete(questDef)) return;

    addPassXP(questDef.reward.amount);
    const list = cycle === 'daily' ? gameState.pass.completedDailyQuests : gameState.pass.completedWeeklyQuests;
    list.push(questKey);

    playUpgradeSound();
    saveGame();
    renderPassQuestTab();
    renderPassRewardsTrack();
    updatePassUI();
    updateUI();
}

const PASS_DAILY_RESET_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PASS_WEEKLY_RESET_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** Resets Pass Daily quest progress/claims and records the new reset timestamp. */
function resetPassDailyQuests() {
    gameState.pass.dailyProgress = { clicks: 0, upgradesBought: 0, passiveEarned: 0, critClicks: 0 };
    gameState.pass.completedDailyQuests = [];
    gameState.pass.lastDailyReset = GCTime.now();
}

/** Resets Pass Weekly quest progress/claims and records the new reset timestamp. */
function resetPassWeeklyQuests() {
    gameState.pass.weeklyProgress = { prestiges: 0, clicks: 0, upgradesBought: 0 };
    gameState.pass.completedWeeklyQuests = [];
    gameState.pass.lastWeeklyReset = GCTime.now();
}

/**
 * Checks whether the Pass Daily and/or Weekly windows have elapsed (or
 * never been initialized) and resets whichever have. Safe to call often.
 * @returns {boolean} true if anything was reset (caller should saveGame()).
 */
function checkPassQuestResets() {
    let didReset = false;
    if (!gameState.pass.lastDailyReset || GCTime.now() - gameState.pass.lastDailyReset >= PASS_DAILY_RESET_INTERVAL_MS) {
        resetPassDailyQuests();
        didReset = true;
    }
    if (!gameState.pass.lastWeeklyReset || GCTime.now() - gameState.pass.lastWeeklyReset >= PASS_WEEKLY_RESET_INTERVAL_MS) {
        resetPassWeeklyQuests();
        didReset = true;
    }
    return didReset;
}

/**
 * =========================================
 * DWARVEN EXPEDITION PASS — UI
 * =========================================
 */

/** Builds one reward-slot cell (free or premium) for a level row. Static content only; state classes are applied by refreshPassRewardsTrack(). */
function buildPassRewardSlotEl(level, track, rewardSlot) {
    const slot = document.createElement('div');
    slot.className = `pass-reward-slot ${track}-slot`;
    slot.innerHTML = `
        <span class="pass-reward-icon">${rewardSlot.icon}</span>
        <span class="pass-reward-text">${rewardSlot.label}</span>
    `;
    return slot;
}

/** Adds / removes the "Premium Pass Required" overlay (and its a11y attrs) on a premium slot. */
function setPassPremiumLock(slot, locked) {
    const overlay = slot.querySelector('.pass-premium-lock');
    if (locked) {
        if (overlay) return;
        // Rewards stay visible but dimmed, with a clear "Premium Pass Required" overlay.
        slot.title = t('pass_premium_lock_tip');
        slot.setAttribute('role', 'button');
        slot.tabIndex = 0;
        const lock = document.createElement('div');
        lock.className = 'pass-premium-lock';
        lock.innerHTML = '<span class="pass-premium-lock-icon">🔒</span><span class="pass-premium-lock-text"><b>' + t('pass_premium_reward') + '</b><small>' + t('pass_premium_required') + '</small></span>';
        slot.appendChild(lock);
    } else if (overlay) {
        overlay.remove();
        slot.removeAttribute('title');
        slot.removeAttribute('role');
        slot.removeAttribute('tabindex');
    }
}

/** Opens the Shop from the Expedition Pass and highlights the Premium Expedition Pass card. */
function openShopForPremiumPass() {
    if (typeof closeExpeditionPass === 'function' && dom.passOverlay) dom.passOverlay.classList.remove('open');
    openShop();
    const card = document.querySelector('#iap-overlay .iap-card[data-product="premiumExpeditionPass"]');
    if (card) {
        card.scrollIntoView({ block: 'center', behavior: 'smooth' });
        card.classList.add('iap-flash');
        setTimeout(() => card.classList.remove('iap-flash'), 1400);
    }
}

/** Cached row references for the 60-level reward track (built once). */
const passTrackRows = [];
let passTrackBuilt = false;

/** Builds all 60 level rows ONCE and wires a single delegated listener set. */
function buildPassRewardsTrack() {
    const fragment = document.createDocumentFragment();
    passTrackRows.length = 0;

    for (let level = 1; level <= PASS_MAX_LEVEL; level++) {
        const { free, premium } = buildPassLevelRewards(level);

        const row = document.createElement('div');
        row.className = 'pass-level-row';
        row.dataset.level = level;

        const numCell = document.createElement('div');
        numCell.className = 'pass-level-num';
        numCell.innerHTML = `${level}<span>${t('pass_row_lvl')}</span>`;
        row.appendChild(numCell);

        const freeSlot = buildPassRewardSlotEl(level, 'free', free);
        const premiumSlot = buildPassRewardSlotEl(level, 'premium', premium);
        row.appendChild(freeSlot);
        row.appendChild(premiumSlot);

        // Single Claim cell: claims whichever track(s) are ready. The Free
        // reward is always claimable; the Premium reward is claimed in the
        // same tap only when the Premium Expedition Pass is owned.
        const claimCell = document.createElement('div');
        claimCell.className = 'pass-claim-cell';
        const btn = document.createElement('button');
        btn.className = 'pass-claim-btn';
        claimCell.appendChild(btn);
        row.appendChild(claimCell);

        fragment.appendChild(row);
        passTrackRows.push({ level, row, freeSlot, premiumSlot, btn, sig: null });
    }

    dom.passTrackScroll.innerHTML = '';
    dom.passTrackScroll.appendChild(fragment);

    if (!dom.passTrackScroll.dataset.bound) {
        dom.passTrackScroll.dataset.bound = '1';

        // Event delegation: one click + one keydown listener for the whole track.
        dom.passTrackScroll.addEventListener('click', (e) => {
            const btn = e.target.closest('.pass-claim-btn');
            if (btn && dom.passTrackScroll.contains(btn)) {
                if (btn.disabled) return;
                const rowEl = btn.closest('.pass-level-row');
                if (!rowEl) return;
                const level = Number(rowEl.dataset.level);
                if (!isPassFreeClaimed(level)) claimPassReward(level, 'free');
                if (!isPassPremiumClaimed(level) && isPremiumPassUnlocked()) claimPassReward(level, 'premium');
                return;
            }
            if (e.target.closest('.pass-reward-slot.premium-locked')) openShopForPremiumPass();
        });
        dom.passTrackScroll.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            if (e.target.closest('.pass-reward-slot.premium-locked')) {
                e.preventDefault();
                openShopForPremiumPass();
            }
        });
    }
    passTrackBuilt = true;
}

/**
 * Syncs the existing rows with the current game state. Each row keeps a
 * state signature, so only rows whose state really changed touch the DOM.
 */
function refreshPassRewardsTrack() {
    const passLevel = gameState.pass.level;
    const premiumOwned = isPremiumPassUnlocked();

    for (let i = 0; i < passTrackRows.length; i++) {
        const r = passTrackRows[i];
        const level = r.level;
        const reached = level <= passLevel;
        const current = level === passLevel && level < PASS_MAX_LEVEL;
        const freeClaimed = isPassFreeClaimed(level);
        const premiumClaimed = isPassPremiumClaimed(level);

        const sig = (reached ? 1 : 0) + '' + (current ? 1 : 0) + (freeClaimed ? 1 : 0) + (premiumClaimed ? 1 : 0) + (premiumOwned ? 1 : 0);
        if (r.sig === sig) continue;
        r.sig = sig;

        r.row.classList.toggle('reached', reached);
        r.row.classList.toggle('current-level', current);

        r.freeSlot.classList.toggle('locked', !reached);
        r.freeSlot.classList.toggle('collected', freeClaimed);

        const premiumLocked = !premiumOwned;
        r.premiumSlot.classList.toggle('locked', !reached);
        r.premiumSlot.classList.toggle('collected', premiumClaimed);
        r.premiumSlot.classList.toggle('premium-locked', premiumLocked);
        setPassPremiumLock(r.premiumSlot, premiumLocked);

        // Without the Premium Pass only the Free reward counts as claimable.
        const allClaimed = freeClaimed && (premiumClaimed || !premiumOwned);
        r.btn.classList.toggle('is-claimed', allClaimed);
        r.btn.disabled = !reached || allClaimed;
        r.btn.textContent = allClaimed
            ? (premiumOwned || !freeClaimed ? t('pass_btn_claimed') : t('pass_btn_free_claimed'))
            : (reached ? t('pass_btn_claim') : t('pass_btn_locked'));
    }
}

/** Builds the reward track the first time it is needed, then only refreshes changed rows. */
function renderPassRewardsTrack() {
    if (!dom.passTrackScroll) return;
    if (!passTrackBuilt) buildPassRewardsTrack();
    refreshPassRewardsTrack();
}

/** Updates the "Resets In: Xh Ym" label for whichever Pass quest tab is active. */
function renderPassQuestResetTimer(cycle) {
    if (!dom.passQuestResetTimer) return;
    const last = cycle === 'daily' ? gameState.pass.lastDailyReset : gameState.pass.lastWeeklyReset;
    const interval = cycle === 'daily' ? PASS_DAILY_RESET_INTERVAL_MS : PASS_WEEKLY_RESET_INTERVAL_MS;
    const remaining = last ? Math.max(0, interval - (GCTime.now() - last)) : interval;
    dom.passQuestResetTimer.textContent = t('pass_resets_in', { time: formatCountdown(remaining) });
}

/** Builds one Pass quest card (daily or weekly), reusing buildQuestCard's visual language. */
function buildPassQuestCard(questDef, cycle) {
    const target = getPassQuestTarget(questDef);
    const progress = Math.min(questDef.track(gameState), target);
    const complete = isPassQuestComplete(questDef);
    const claimed = isPassQuestClaimed(questDef, cycle);
    const pct = target > 0 ? Math.min(100, (progress / target) * 100) : 0;

    const card = document.createElement('div');
    card.className = 'quest-card' + (complete ? ' completed' : '') + (claimed ? ' claimed' : '');
    card.innerHTML = `
        <div class="quest-card-top">
            <span class="quest-card-name">${questDef.icon} ${questDef.name}</span>
            <span class="quest-card-reward">${t('pass_xp_reward', { amount: formatNumber(questDef.reward.amount) })}</span>
        </div>
        <div class="quest-progress-outer">
            <div class="quest-progress-inner" style="width:${pct}%;"></div>
        </div>
        <div class="quest-progress-label">${t('quest_progress_line', { progress: formatNumber(progress), target: formatNumber(target), desc: questDef.description(target) })}</div>
        <div class="quest-card-bottom">
            <button class="quest-claim-btn" ${(!complete || claimed) ? 'disabled' : ''}>
                ${claimed ? t('quest_btn_claimed') : (complete ? t('quest_btn_claim') : t('quest_btn_progress'))}
            </button>
        </div>
    `;
    card.querySelector('.quest-claim-btn').onclick = () => claimPassQuestReward(questDef.key, cycle);
    return card;
}

/** Cached per-card refs for the Pass quest lists (cards are built once, then updated in place). */
const passQuestCards = [];
let passQuestCardsBuilt = false;

function buildPassQuestCards() {
    passQuestCards.length = 0;
    const fill = (list, defs, cycle) => {
        if (!list) return;
        list.innerHTML = '';
        defs.forEach((q) => {
            const card = buildPassQuestCard(q, cycle);
            list.appendChild(card);
            passQuestCards.push({
                def: q, cycle, card,
                reward: card.querySelector('.quest-card-reward'),
                bar: card.querySelector('.quest-progress-inner'),
                label: card.querySelector('.quest-progress-label'),
                btn: card.querySelector('.quest-claim-btn'),
                rewardText: null, width: null, labelText: null, btnText: null, btnDisabled: null, complete: null, claimed: null
            });
        });
    };
    fill(dom.passQuestListDaily, PASS_DAILY_QUESTS, 'daily');
    fill(dom.passQuestListWeekly, PASS_WEEKLY_QUESTS, 'weekly');
    passQuestCardsBuilt = true;
}

function updatePassQuestCards() {
    for (const c of passQuestCards) {
        const questDef = c.def;
        const target = getPassQuestTarget(questDef);
        const progress = Math.min(questDef.track(gameState), target);
        const complete = isPassQuestComplete(questDef);
        const claimed = isPassQuestClaimed(questDef, c.cycle);
        const pct = target > 0 ? Math.min(100, (progress / target) * 100) : 0;

        if (c.complete !== complete) { c.complete = complete; c.card.classList.toggle('completed', complete); }
        if (c.claimed !== claimed) { c.claimed = claimed; c.card.classList.toggle('claimed', claimed); }

        const rewardText = t('pass_xp_reward', { amount: formatNumber(questDef.reward.amount) });
        if (c.rewardText !== rewardText) { c.rewardText = rewardText; c.reward.textContent = rewardText; }
        const width = pct + '%';
        if (c.width !== width) { c.width = width; c.bar.style.width = width; }
        const labelText = t('quest_progress_line', { progress: formatNumber(progress), target: formatNumber(target), desc: questDef.description(target) });
        if (c.labelText !== labelText) { c.labelText = labelText; c.label.textContent = labelText; }

        const disabled = !complete || claimed;
        if (c.btnDisabled !== disabled) { c.btnDisabled = disabled; c.btn.disabled = disabled; }
        const btnText = claimed ? t('quest_btn_claimed') : (complete ? t('quest_btn_claim') : t('quest_btn_progress'));
        if (c.btnText !== btnText) { c.btnText = btnText; c.btn.textContent = btnText; }
    }
}

/** Renders whichever Pass quest sub-tab (Daily/Weekly) is currently active. Cards are built once and updated in place. */
function renderPassQuestTab() {
    if (checkPassQuestResets()) saveGame();

    const isDaily = !dom.passQuestListWeekly || dom.passQuestListWeekly.style.display === 'none';
    renderPassQuestResetTimer(isDaily ? 'daily' : 'weekly');

    if (!passQuestCardsBuilt) buildPassQuestCards();
    updatePassQuestCards();
}

/** Switches between the Pass modal's own Daily/Weekly quest sub-tabs. */
function switchPassQuestTab(cycle) {
    const isDaily = cycle === 'daily';
    dom.passQuestTabBtnDaily.classList.toggle('active', isDaily);
    dom.passQuestTabBtnWeekly.classList.toggle('active', !isDaily);
    dom.passQuestListDaily.style.display = isDaily ? 'flex' : 'none';
    dom.passQuestListWeekly.style.display = isDaily ? 'none' : 'flex';
    dom.passQuestSectionTitle.textContent = t(isDaily ? 'pass_tasks_daily' : 'pass_tasks_weekly');
    renderPassQuestResetTimer(cycle);
}

/** Switches between the Quests modal's 2 top-level sub-tabs: Quests / Daily Rewards. */
function switchPassBodyTab(tab) {
    const isQuests = tab === 'quests';
    const isDaily = tab === 'daily';

    if (dom.passBodyTabBtnQuests) dom.passBodyTabBtnQuests.classList.toggle('active', isQuests);
    if (dom.passBodyTabBtnDaily) dom.passBodyTabBtnDaily.classList.toggle('active', isDaily);

    if (dom.passTabPanelQuests) dom.passTabPanelQuests.classList.toggle('active', isQuests);
    if (dom.passTabPanelDaily) dom.passTabPanelDaily.classList.toggle('active', isDaily);

    if (isQuests) {
        renderPassQuestTab();
        renderDailyQuests();
    } else if (isDaily) {
        renderDailyLoginTab();
    }
}

/** Counts unclaimed-but-ready rewards/quests, for the Pass badge. */
function countClaimablePassItems() {
    let count = 0;
    for (let level = 1; level <= gameState.pass.level; level++) {
        if (!isPassFreeClaimed(level)) count++;
        if (isPremiumPassUnlocked() && !isPassPremiumClaimed(level)) count++;
    }
    PASS_DAILY_QUESTS.forEach(q => { if (isPassQuestComplete(q) && !isPassQuestClaimed(q, 'daily')) count++; });
    PASS_WEEKLY_QUESTS.forEach(q => { if (isPassQuestComplete(q) && !isPassQuestClaimed(q, 'weekly')) count++; });
    return count;
}

/** Updates the Battle Pass / Quests nav dots, and, if either modal is open, its live progress bar/labels. */
/** Writes textContent / style only when the value actually changed (avoids pointless DOM writes every tick). */
function setTextIfChanged(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
}
function setDisplayIfChanged(el, value) {
    if (el && el.style.display !== value) el.style.display = value;
}
function setWidthIfChanged(el, value) {
    if (el && el.style.width !== value) el.style.width = value;
}

function updatePassUI() {
    const claimablePass = countClaimablePassItems();
    const claimableQuests = countClaimableQuests();
    setDisplayIfChanged(dom.navTabDotPass, claimablePass > 0 ? 'flex' : 'none');
    setDisplayIfChanged(dom.navTabDotQuests, claimableQuests > 0 ? 'flex' : 'none');

    const maxed = gameState.pass.level >= PASS_MAX_LEVEL;
    setTextIfChanged(dom.passLevelBadgeNum, String(gameState.pass.level));
    setDisplayIfChanged(dom.passMaxBadge, maxed ? 'inline-block' : 'none');
    setTextIfChanged(dom.passNextLevelLabel, maxed ? t('pass_max_reached') : t('pass_next_level', { level: gameState.pass.level + 1 }));
    const req = getPassXpForLevel(gameState.pass.level);
    setTextIfChanged(dom.passXpLabel, maxed
        ? t('xp_progress', { current: formatNumber(PASS_XP_PER_LEVEL), max: formatNumber(PASS_XP_PER_LEVEL) })
        : t('xp_progress', { current: formatNumber(gameState.pass.xp), max: formatNumber(req) }));
    setWidthIfChanged(dom.passProgressInner, (maxed ? 100 : Math.min(100, (gameState.pass.xp / req) * 100)) + '%');

    // Keep the Battle Pass reward track live if that modal is open.
    if (dom.passOverlay && dom.passOverlay.classList.contains('open')) {
        renderPassRewardsTrack();
    }

    // Keep the Quests modal live if it's open.
    if (dom.questsOverlay && dom.questsOverlay.classList.contains('open')) {
        if (dom.passTabPanelQuests && dom.passTabPanelQuests.classList.contains('active')) {
            renderPassQuestTab();
        }
    }
}

/** Opens the dedicated "Battle Pass" modal — Expedition Pass reward track ONLY. */
function openExpeditionPass() {
    if (checkPassQuestResets()) saveGame();
    dom.passOverlay.classList.add('open');
    renderPassRewardsTrack();
    updatePassUI();
    setActiveNavTab('pass');
}

/** Closes the "Battle Pass" modal. */
function closeExpeditionPass() {
    dom.passOverlay.classList.remove('open');
    setActiveNavTab('main');
}

/**
 * Opens the "Quests" modal (Daily/Weekly Quests + Daily Login calendar).
 * @param {string} [startTab='quests'] Which sub-tab to open on: 'quests' | 'daily'.
 */
function openQuestsModal(startTab) {
    if (checkPassQuestResets()) saveGame();
    if (checkDailyQuestReset()) saveGame();
    dom.questsOverlay.classList.add('open');
    switchPassBodyTab(startTab || 'quests');
    updatePassUI();
    setActiveNavTab('quests');
}

/** Closes the "Quests" modal. */
function closeQuestsModal() {
    dom.questsOverlay.classList.remove('open');
    setActiveNavTab('main');
}

/**
 * True from startup until the first offline calculation of this page load has finished (it waits for the
 * server-time check, normally a few hundred ms). While true, saveGame() keeps the PREVIOUS lastSaveTime, so an
 * early autosave / unload can never swallow (or reshape) the unpaid offline gap.
 */
let gcOfflineStampLocked = false;

/** Set when a save existed but loadGame() threw. While true the rolling backup is never overwritten (see saveGame). */
let gcLoadFailed = false;

/** Finite number within [min, max] or the fallback. Used to keep corrupted / hand-edited saves from injecting NaN or strings. */
function gcSafeNum(v, fallback, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    if (typeof min === 'number' && n < min) return min;
    if (typeof max === 'number' && n > max) return max;
    return n;
}

/**
 * Saves the current game state to localStorage.
 */
function saveGame() {
    try {
        if (typeof settlePausedTime === 'function') settlePausedTime();   // while paused: credit the elapsed pause to timed state first
        // Every persisted real-world stamp comes from the trusted clock (GCTime), never straight from the OS clock.
        const stamp = GCTime.beforeSave(gcOfflineStampLocked);
        if (!gcOfflineStampLocked) {
            gameState.lastSaved = stamp;
            gameState.lastSaveTime = stamp;                   // offline-progress timestamp
            gameState.lastOnlineTime = stamp;                 // legacy key, kept for compatibility
            GCStore.setItem('lastOnlineTime', String(stamp));
        }
        gameState.timeGuard = GCTime.exportState();           // redundant copy of the anti-cheat record (also in its own key)
        const saveJson = JSON.stringify(gameState);
        if (GCStore.setItem('goldClickerSave', saveJson)) {
            // Rolling backup of the last good save (at most once per minute, plain string copy = cheap).
            const nowM = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
            if (!gcLoadFailed && (!saveGame._lastBackup || nowM - saveGame._lastBackup > 60000)) {
                saveGame._lastBackup = nowM || 1;
                GCStore.setItem('goldClickerSave_backup', saveJson);
            }
        }
        // Redundant copy of the purchase/ownership state (shop ownership must never be lost).
        GCStore.setItem('goldClickerShop', JSON.stringify(gameState.shopState));
        GCStore.setItem('goldClickerQuests', JSON.stringify({
            dailyLogin: gameState.dailyLogin,
            questProgress: gameState.questProgress,
            completedQuests: gameState.completedQuests,
            dailyQuests: gameState.dailyQuests,
            achievementProgress: gameState.achievementProgress,
            completedAchievements: gameState.completedAchievements
        }));
        // Kept as its own top-level key per spec, so the reset timer can be
        // checked/read independently of the rest of the quest blob.
        if (gameState.lastQuestReset) {
            GCStore.setItem('lastQuestReset', String(gameState.lastQuestReset));
        }
        // Dwarven Expedition Pass: level, XP, claimed rewards, quest
        // progress, and reset timestamps, all in their own storage key.
        GCStore.setItem('goldClickerPass', JSON.stringify(gameState.pass));
    } catch (e) {
        console.warn('Could not save game:', e);
    }
}

/**
 * Loads a previously saved game state from localStorage, if it exists.
 */
function loadGame() {
    try {
        // Corruption-safe read: a missing/garbled/non-object save falls back to the rolling backup; the bad
        // original is quarantined (never silently overwritten) and the game starts fresh only if both fail.
        let saved = GCStore.getItem('goldClickerSave');
        let parsed = null;
        if (saved) {
            try { const o = JSON.parse(saved); if (o && typeof o === 'object' && !Array.isArray(o)) parsed = o; } catch (e) { parsed = null; }
            if (!parsed) {
                console.warn('Save data is corrupted; trying the backup copy.');
                GCStore.setItem('goldClickerSave_corrupt', saved);
                parsed = GCStore.getJSON('goldClickerSave_backup');
            }
        }
        if (parsed) {
            GCTime.restore(parsed); // anti-cheat: load guard record + conservative provisional clock BEFORE time-dependent loads
            gameState.coins = gcSafeNum(parsed.coins, 0, 0);
            gameState.coinsPerClick = gcSafeNum(parsed.coinsPerClick, 1, 1) || 1;
            gameState.level = Math.max(1, Math.floor(gcSafeNum(parsed.level, 1, 1)));
            gameState.xp = gcSafeNum(parsed.xp, 0, 0);
            gameState.xpToNextLevel = calculateXpRequirement(gameState.level + 1); // always from the live curve (old saves held old-curve values)
            gameState.soundEnabled = parsed.soundEnabled !== undefined ? parsed.soundEnabled : true;
            // Volume: older saves have none -> derive from the old mute flag (muted -> 0, else 100%).
            {
                const sv = Number(parsed.volume);
                gameState.volume = (parsed.volume !== undefined && parsed.volume !== null && Number.isFinite(sv))
                    ? clampVolume(sv)
                    : (gameState.soundEnabled ? 1 : 0);
                gameState.soundEnabled = gameState.volume > 0;
            }
            // Background music preference: older saves have none -> default ON.
            gameState.bgmEnabled = parsed.bgmEnabled === undefined || parsed.bgmEnabled === null ? true : !!parsed.bgmEnabled;

            // First-time tutorial flag. An explicit boolean is always respected (true = never auto-start again,
            // false = still owed). Saves that predate the tutorial have no flag: a player with any real progress is an
            // existing player and is marked completed (nothing else in their save is touched); an untouched save counts as new.
            if (typeof parsed.tutorialCompleted === 'boolean') {
                gameState.tutorialCompleted = parsed.tutorialCompleted;
            } else {
                const ap = parsed.achievementProgress || {};
                let ownsUpgrade = false;
                if (parsed.upgrades && typeof parsed.upgrades === 'object') {
                    for (const uk in parsed.upgrades) { if (parsed.upgrades[uk] && parsed.upgrades[uk].owned > 0) ownsUpgrade = true; }
                }
                gameState.tutorialCompleted = !!(
                    (parsed.coins || 0) > 0 || (parsed.totalCoinsEarned || 0) > 0 || (parsed.level || 1) > 1 ||
                    (parsed.xp || 0) > 0 || (parsed.gems || 0) > 0 || (ap.clicks || 0) > 0 || ownsUpgrade
                );
            }

            // Prestige-related fields (default to a fresh state if this is
            // an older save that predates the Prestige system).
            gameState.totalCoinsEarned = gcSafeNum(parsed.totalCoinsEarned, 0, 0);
            gameState.gems = gcSafeNum(parsed.gems, 0, 0);
            // prestigeGems = lifetime prestige-earned gems. Older saves had no such field: assume
            // the whole stored balance came from prestiging (keeps their Gems, drops the old +10%/Gem).
            gameState.prestigeGems = Number.isFinite(Number(parsed.prestigeGems))
                ? Math.max(0, Number(parsed.prestigeGems)) : gameState.gems;
            recalculatePrestigeMultiplier();

            // Dwarven Forge skills: object of skillKey -> level (0-5).
            // Backward-compatible with older saves that stored an array of
            // fully-unlocked skill keys (each becomes level 1 on migration).
            if (parsed.skillLevels && typeof parsed.skillLevels === 'object' && !Array.isArray(parsed.skillLevels)) {
                gameState.skillLevels = parsed.skillLevels;
            } else if (Array.isArray(parsed.unlockedSkills)) {
                gameState.skillLevels = {};
                parsed.unlockedSkills.forEach((key) => {
                    if (SKILL_TREE[key]) gameState.skillLevels[key] = 1;
                });
            } else {
                gameState.skillLevels = {};
            }

            // Dwarven Relics: object of relicKey -> level (0-MAX_RELIC_LEVEL).
            // Defaults to empty for saves that predate the Relic Excavation system.
            if (parsed.relics && typeof parsed.relics === 'object' && !Array.isArray(parsed.relics)) {
                gameState.relics = parsed.relics;
            } else {
                gameState.relics = {};
            }

            // Lifetime Prestige counter (used by the Expedition Pass's weekly quests)
            gameState.totalPrestiges = parsed.totalPrestiges || 0;

            // Boss Key Inventory: object of rarity -> count.
            // Defaults to zeroed keys for saves that predate this system.
            if (parsed.keys && typeof parsed.keys === 'object') {
                gameState.keys = {
                    common: parsed.keys.common || 0,
                    rare: parsed.keys.rare || 0,
                    legendary: parsed.keys.legendary || 0
                };
            } else {
                gameState.keys = { common: 0, rare: 0, legendary: 0 };
            }
            // Boss recovery cooldowns (bossId -> end timestamp in ms).
            gameState.bossCooldowns = (parsed.bossCooldowns && typeof parsed.bossCooldowns === 'object')
                ? parsed.bossCooldowns : {};

            // Offline progress + Helpers (both default safely for older saves).
            loadOfflineState(parsed);
            loadHelperState(parsed);

            // Shop state (older saves without it get safe defaults).
            loadShopState(parsed);

            // Adventures data (materials, crafted/equipped Runes...) is written by saveGame()
            // with the rest of gameState; restore it so Runes (and the VIP slot) persist.
            // adventures.js re-normalizes it with ensureAdventureState().
            if (parsed.adventures && typeof parsed.adventures === 'object' && !Array.isArray(parsed.adventures)) {
                gameState.adventures = parsed.adventures;
            }

            for (const key in parsed.upgrades) {
                if (gameState.upgrades[key]) {
                    gameState.upgrades[key].owned = parsed.upgrades[key].owned || 0;
                    gameState.upgrades[key].price = parsed.upgrades[key].price || gameState.upgrades[key].basePrice;
                }
            }
            recalculateDerivedStats();
            recalculatePrestigeMultiplier();

            // Determine the correct biome from the loaded level, rather than
            // trusting a possibly-stale saved value, so this is always correct.
            gameState.currentBiome = getBiomeForLevel(gameState.level).key;
            applyBiomeVisuals(false);

            // Store the last-saved timestamp so we can compute offline progress
            // once CPS has been recalculated from loaded upgrades.
            gameState.lastSaved = parsed.lastSaved || GCTime.now();
            gameState.lastSaveTime = sanitizeTimestamp(parsed.lastSaveTime)
                || sanitizeTimestamp(parsed.lastOnlineTime)
                || sanitizeTimestamp(parsed.lastSaved)
                || null;
        } else {
            // Fresh save: apply the default Surface Mine visuals
            applyBiomeVisuals(false);
        }
    } catch (e) {
        console.warn('Could not load save:', e);
        // A save that exists but could not be applied must never be silently replaced by a half-loaded state:
        // keep an untouched copy and stop the rolling backup from being overwritten during this session.
        gcLoadFailed = true;
        try {
            const raw = GCStore.getItem('goldClickerSave');
            if (raw) GCStore.setItem('goldClickerSave_loadfail', raw);
        } catch (e2) { /* ignore */ }
        applyBiomeVisuals(false);
    }

    GCTime.restore(null); // no-op if already restored (covers fresh installs / unreadable saves)
    loadQuestData();
    loadPassData();
}

/**
 * Loads Daily Login streak and Quest/Achievement progress from their own
 * localStorage entry, defaulting to a fresh state if none exists (or for
 * saves that predate this system).
 */
function loadQuestData() {
    try {
        const saved = GCStore.getItem('goldClickerQuests');
        if (saved) {
            const parsed = JSON.parse(saved);

            if (parsed.dailyLogin) {
                gameState.dailyLogin.streak = parsed.dailyLogin.streak || 0;
                gameState.dailyLogin.lastClaimDate = parsed.dailyLogin.lastClaimDate || null;
                // Only restore the buff if it hasn't already expired since the last save.
                gameState.dailyLogin.activeBuff = (parsed.dailyLogin.activeBuff && parsed.dailyLogin.activeBuff.expiresAt > GCTime.now())
                    ? parsed.dailyLogin.activeBuff
                    : null;
            }

            if (parsed.questProgress) {
                gameState.questProgress.clicks = parsed.questProgress.clicks || 0;
                gameState.questProgress.upgradesBought = parsed.questProgress.upgradesBought || 0;
                gameState.questProgress.coinsEarnedSession = parsed.questProgress.coinsEarnedSession || 0;
                gameState.questProgress.critClicks = parsed.questProgress.critClicks || 0;
                gameState.questProgress.levelsGainedToday = parsed.questProgress.levelsGainedToday || 0;
            }

            gameState.completedQuests = Array.isArray(parsed.completedQuests) ? parsed.completedQuests : [];
            gameState.dailyQuests = Array.isArray(parsed.dailyQuests) ? parsed.dailyQuests : [];

            if (parsed.achievementProgress) {
                gameState.achievementProgress.clicks = parsed.achievementProgress.clicks || 0;
                gameState.achievementProgress.upgradesBought = parsed.achievementProgress.upgradesBought || 0;
                gameState.achievementProgress.critClicks = parsed.achievementProgress.critClicks || 0;
            }
            gameState.completedAchievements = Array.isArray(parsed.completedAchievements) ? parsed.completedAchievements : [];
        }

        // lastQuestReset is stored as its own top-level localStorage key per spec
        const storedReset = GCStore.getItem('lastQuestReset');
        gameState.lastQuestReset = storedReset ? parseInt(storedReset, 10) : null;

        // Daily Quest instances are plain saved data (progress/target/reward),
        // never functions — functions don't survive JSON.stringify anyway, and
        // we deliberately don't attach any here. Tracking behavior always
        // comes from the live DAILY_QUEST_POOL templates via trackQuestProgress().
        // Drop any saved quest whose type no longer exists in the current pool
        // (e.g. removed/renamed in a game update) so stale data can't surface
        // a quest with no way to track its progress.
        if (gameState.dailyQuests.length > 0) {
            gameState.dailyQuests = gameState.dailyQuests.filter(q => !!getQuestTemplate(q));
        }

        // Generate quests immediately if none exist yet, or if 24h have passed
        checkDailyQuestReset();

        // A missed day should visibly reset the streak the moment we load, not just on next claim
        checkDailyStreakReset();
    } catch (e) {
        console.warn('Could not load quest data:', e);
    }
}

/**
 * Loads Dwarven Expedition Pass state (level, XP, claimed rewards, quest
 * progress, reset timestamps) from its own localStorage entry, defaulting
 * to a fresh Level 1 Pass if none exists (e.g. saves that predate this
 * system). Also rolls over any Daily/Weekly windows that elapsed while
 * the game was closed.
 */
function loadPassData() {
    try {
        const saved = GCStore.getItem('goldClickerPass');
        if (saved) {
            const parsed = JSON.parse(saved);
            gameState.pass.level = Math.min(PASS_MAX_LEVEL, Math.max(1, parsed.level || 1));
            gameState.pass.xp = parsed.xp || 0;
            gameState.pass.claimedFree = Array.isArray(parsed.claimedFree) ? parsed.claimedFree : [];
            gameState.pass.claimedPremium = Array.isArray(parsed.claimedPremium) ? parsed.claimedPremium : [];
            gameState.pass.premiumOwned = !!parsed.premiumOwned;

            if (parsed.dailyProgress) {
                gameState.pass.dailyProgress.clicks = parsed.dailyProgress.clicks || 0;
                gameState.pass.dailyProgress.upgradesBought = parsed.dailyProgress.upgradesBought || 0;
                gameState.pass.dailyProgress.passiveEarned = parsed.dailyProgress.passiveEarned || 0;
                gameState.pass.dailyProgress.critClicks = parsed.dailyProgress.critClicks || 0;
            }
            if (parsed.weeklyProgress) {
                gameState.pass.weeklyProgress.prestiges = parsed.weeklyProgress.prestiges || 0;
                gameState.pass.weeklyProgress.clicks = parsed.weeklyProgress.clicks || 0;
                gameState.pass.weeklyProgress.upgradesBought = parsed.weeklyProgress.upgradesBought || 0;
            }

            gameState.pass.completedDailyQuests = Array.isArray(parsed.completedDailyQuests) ? parsed.completedDailyQuests : [];
            gameState.pass.completedWeeklyQuests = Array.isArray(parsed.completedWeeklyQuests) ? parsed.completedWeeklyQuests : [];
            gameState.pass.lastDailyReset = parsed.lastDailyReset || null;
            gameState.pass.lastWeeklyReset = parsed.lastWeeklyReset || null;
        }

        // Roll over Daily/Weekly Pass quest windows immediately on load,
        // exactly like the existing Daily Quest system does.
        checkPassQuestResets();
    } catch (e) {
        console.warn('Could not load Expedition Pass data:', e);
    }
}

/**
 * =========================================
 * OFFLINE PROGRESS
 * =========================================
 * Flow (all runs exactly ONCE per page load, see applyOfflineProgress):
 *   1. Every save stamps gameState.lastSaveTime = GCTime.now().
 *   2. On load: timeOffline = (GCTime.now() - lastSaveTime) / 1000.
 *   3. If timeOffline > minSeconds, the gap is capped at the max offline time and
 *      earnedOfflineGold = cappedSeconds * incomePerSecond * offlineEfficiencyMultiplier.
 *   4. The result is stored as gameState.offline.pending and lastSaveTime is moved
 *      to "now" immediately, so the same absence can never be paid twice - even
 *      if the player reloads before pressing Claim (the pending reward is simply
 *      shown again, never recalculated).
 *   5. Gold is only added to gameState.coins when the player claims it.
 *
 * ANTI-TIME-CHEAT: the absence is NOT measured with the raw OS clock. GCTime.resolveOfflineGap() compares the
 * saved (trusted) stamp with verified server time when reachable; otherwise it applies rollback protection,
 * a per-calculation cap and a shared unverified-credit pool. The AFK tier limit below is still applied on top.
 *
 * All balance values live in OFFLINE_CONFIG. To add VIP / upgrade / relic bonuses
 * later, raise gameState.offline.extraMaxSeconds / extraEfficiency (both are saved)
 * or extend getMaxOfflineSeconds() / getOfflineEfficiencyMultiplier().
 */
const OFFLINE_CONFIG = {
    minSeconds: 60,               // absences at or below this are ignored (quick refreshes)
    maxSeconds: 2 * 60 * 60,      // base cap: 2 hours (the live cap comes from the AFK tier, see getMaxOfflineSeconds)
    efficiency: 0.8,              // offlineEfficiencyMultiplier: 80% of normal income
    maxEfficiency: 2,             // hard ceiling so stacked bonuses can't go wild
    includeHelperIncome: true,    // Dwarf Miner auto-click income also earns while offline
    claimXpFraction: 0.1          // XP trickle granted on claim (fraction of gold claimed)
};

/** Returns a positive finite ms timestamp, or null for anything invalid / absurd. */
function sanitizeTimestamp(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > 8.64e15) return null; // 8.64e15 = max valid JS Date
    return n;
}

/* ---------------------------------------------------------------
   AFK / Offline time limit tiers
   Single source of truth = gameState.shopState.afkLevel (0..4). The limit in hours
   (gameState.maxOfflineHours) is always DERIVED from it, so the limit can only ever
   match the highest upgrade the player actually owns.
     level 0 = 2h (default) | 1 = 4h (500 Gems) | 2 = 8h (1500 Gems)
     level 3 = 16h (4000 Gems) | 4 = 24h (8000 Gems)
   --------------------------------------------------------------- */
const AFK_LEVEL_HOURS = [2, 4, 8, 16, 24];
const AFK_GEM_UPGRADES = [
    { level: 1, id: 'afk4',  get name() { return t('afk_name', { hours: 4 }); }, icon: '⏳', hours: 4, cost: 500 },
    { level: 2, id: 'afk8',  get name() { return t('afk_name', { hours: 8 }); }, icon: '⌛', hours: 8, cost: 1500 }
];

function clampAfkLevel(v) {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(n, AFK_LEVEL_HOURS.length - 1);
}

/** Current AFK tier (0..4), read from the saved shop state. */
function getAfkLevel() {
    return clampAfkLevel(gameState.shopState && gameState.shopState.afkLevel);
}

/** Current AFK limit in hours, always derived from the owned tier. */
function getMaxOfflineHours() {
    return AFK_LEVEL_HOURS[getAfkLevel()];
}

/** Re-derives gameState.maxOfflineHours (persisted) from the owned tier. Call after any tier change / load. */
function syncAfkLimit() {
    if (gameState.shopState) gameState.shopState.afkLevel = getAfkLevel();
    gameState.maxOfflineHours = getMaxOfflineHours();
    return gameState.maxOfflineHours;
}

function formatAfkHours(hours) {
    const h = Math.round(Number(hours) * 100) / 100;
    return tp('afk_hours', h, { n: h });
}

/** Current offline cap in seconds (AFK tier limit + any saved bonus). */
function getMaxOfflineSeconds() {
    const extra = Number(gameState.offline && gameState.offline.extraMaxSeconds) || 0;
    return Math.max(0, getMaxOfflineHours() * 3600 + extra);
}

/** Current offlineEfficiencyMultiplier (base + any saved bonus), clamped to [0, maxEfficiency]. */
function getOfflineEfficiencyMultiplier() {
    const extra = Number(gameState.offline && gameState.offline.extraEfficiency) || 0;
    return Math.min(OFFLINE_CONFIG.maxEfficiency, Math.max(0, OFFLINE_CONFIG.efficiency + extra));
}

/** Restores gameState.offline from a parsed save, tolerating missing/corrupt data. */
function loadOfflineState(parsed) {
    const src = (parsed && parsed.offline && typeof parsed.offline === 'object') ? parsed.offline : {};
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    let pending = null;
    const p = src.pending;
    if (p && typeof p === 'object' && Number.isFinite(Number(p.gold)) && Number(p.gold) > 0) {
        pending = {
            gold: Number(p.gold),
            seconds: Math.max(0, num(p.seconds)),
            cappedSeconds: Math.max(0, num(p.cappedSeconds)),
            limitSeconds: Math.max(0, num(p.limitSeconds)),   // cap that was applied when the reward was created (0 = unknown)
            timeLimited: !!p.timeLimited,                      // reward was cut because the clock could not be verified
            createdAt: sanitizeTimestamp(p.createdAt) || GCTime.now()
        };
    }
    gameState.offline = {
        extraMaxSeconds: Math.max(0, num(src.extraMaxSeconds)),
        extraEfficiency: Math.max(0, num(src.extraEfficiency)),
        pending
    };
}

/**
 * Smooth offline cap: full credit up to half the limit, then an exponential approach that
 * never exceeds the limit:  t <= L/2 -> t ;  t > L/2 -> L - (L/2) * e^(-(t - L/2) / (L/2)).
 * Continuous at L/2 (value and slope), so there is no hard cliff at the AFK limit.
 */
function smoothOfflineSeconds(t, limit) {
    t = Math.max(0, Number(t) || 0);
    limit = Math.max(0, Number(limit) || 0);
    if (limit <= 0) return 0;
    const half = limit / 2;
    if (t <= half) return t;
    return limit - half * Math.exp(-(t - half) / half);
}

/**
 * Pure calculation: turns an absence (seconds) into a capped duration + gold.
 * Uses the live CPS * total multiplier (same income the player sees) plus,
 * optionally, helper auto-click income.
 */
function computeOfflineEarnings(timeOfflineSeconds) {
    const limitSeconds = getMaxOfflineSeconds();
    const cappedSeconds = smoothOfflineSeconds(timeOfflineSeconds, limitSeconds);
    let incomePerSecond = gameState.coinsPerSecond * getTotalMultiplier();
    if (OFFLINE_CONFIG.includeHelperIncome) incomePerSecond += getHelperGoldPerSecond();
    let gold = cappedSeconds * incomePerSecond * getOfflineEfficiencyMultiplier();
    if (!Number.isFinite(gold) || gold < 0) gold = 0;
    return { seconds: timeOfflineSeconds, cappedSeconds, limitSeconds, gold };
}

let offlineCalculatedThisSession = false;

/**
 * Reward/stamps that are in the future of verified real time can only come from a clock that was set forward.
 * Once the server confirmed the time, pull such "last reset" stamps back to now (never forward, so no rewards).
 */
function sanitizeFutureTimestamps() {
    if (!GCTime.isVerified()) return false;
    const now = GCTime.now();
    const limit = now + 2 * 60 * 1000;
    let changed = false;
    const fix = (obj, key) => {
        if (obj && Number.isFinite(obj[key]) && obj[key] > limit) { obj[key] = now; changed = true; }
    };
    fix(gameState, 'lastQuestReset');
    if (gameState.pass) { fix(gameState.pass, 'lastDailyReset'); fix(gameState.pass, 'lastWeeklyReset'); }
    if (changed) {
        if (gameState.lastQuestReset) GCStore.setItem('lastQuestReset', String(gameState.lastQuestReset));
        GCTime.noteAnomaly('future-reset-stamps-corrected', null);
    }
    return changed;
}

let timeSyncHookInstalled = false;

/**
 * Called once from initGame(), after loadGame(). Never double-counts:
 *  - guarded by a per-session flag,
 *  - the timestamp is advanced as soon as a reward is created,
 *  - an unclaimed reward is restored from the save instead of recalculated.
 *
 * The game itself is NOT blocked: the UI is already running. Only the offline reward waits (at most
 * GCTime's startup deadline, normally a few hundred ms) for the server-time check. saveGame() keeps the old
 * lastSaveTime until this finished (gcOfflineStampLocked).
 */
function applyOfflineProgress() {
    if (offlineCalculatedThisSession) return;
    offlineCalculatedThisSession = true;
    gcOfflineStampLocked = true;

    if (!timeSyncHookInstalled) {
        timeSyncHookInstalled = true;
        GCTime.onSync(() => { if (sanitizeFutureTimestamps()) saveGame(); });
    }

    // Captured NOW, before any save could touch it.
    const lastSave = sanitizeTimestamp(gameState.lastSaveTime);

    // An unclaimed reward from an earlier load: show it again right away, don't recalculate.
    if (gameState.offline.pending) showOfflineProgressModal(gameState.offline.pending);

    GCTime.settled().then(() => {
        try {
            finishOfflineProgress(lastSave);
        } catch (e) {
            console.warn('Offline progress failed (no reward granted):', e);
        } finally {
            gcOfflineStampLocked = false;   // from now on saves stamp trusted "now" -> this absence is paid exactly once
            saveGame();
        }
    });
}

/** The actual offline calculation, run once the time source has settled (verified server time or safe fallback). */
function finishOfflineProgress(lastSave) {
    // Single validation point: rollback, huge forward jumps, stale stamps, unverified mode ...
    const gap = GCTime.resolveOfflineGap(lastSave);
    const now = GCTime.now();
    sanitizeFutureTimestamps();

    if (gameState.offline.pending) return;   // already shown above
    if (!lastSave) return;                   // first-time player / old save without any timestamp

    const timeOffline = gap.seconds;
    if (!Number.isFinite(timeOffline) || timeOffline <= OFFLINE_CONFIG.minSeconds) return;

    const result = computeOfflineEarnings(timeOffline);
    if (result.gold > 0) {
        gameState.offline.pending = {
            gold: result.gold,
            seconds: result.seconds,
            cappedSeconds: result.cappedSeconds,
            limitSeconds: result.limitSeconds,
            timeLimited: !gap.verified && gap.rawSeconds > gap.seconds + 1,
            createdAt: now
        };
        showOfflineProgressModal(gameState.offline.pending);
    }
}

/** Formats seconds as "X hours Y minutes Z seconds" (with correct singular forms). */
function formatOfflineTimeLong(totalSeconds) {
    const total = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return [tp('time_hour', h, { n: h }), tp('time_minute', m, { n: m }), tp('time_second', s, { n: s })].join(' ');
}

/** Fills in and opens the Offline Progress modal for a pending reward. */
let lastOfflinePending = null;
function showOfflineProgressModal(pending) {
    if (!pending) return;
    lastOfflinePending = pending;
    if (!dom.offlineOverlay) {
        // Markup missing (older HTML): fall back to granting the base reward directly.
        claimOfflineReward(1);
        return;
    }
    // Actual time away vs. the (possibly capped) time that was used for the reward.
    const actualSeconds = pending.seconds || pending.cappedSeconds;
    const countedSeconds = pending.cappedSeconds || pending.seconds;
    const capped = pending.seconds > pending.cappedSeconds + 1;
    const limitSeconds = pending.limitSeconds || getMaxOfflineSeconds();
    dom.offlineDuration.textContent = formatOfflineTimeLong(actualSeconds);
    dom.offlineAmount.textContent = `+${formatNumber(pending.gold)} 🪙`;
    if (dom.offlineCounted) {
        dom.offlineCounted.style.display = capped ? '' : 'none';
        dom.offlineCounted.textContent = capped ? t('offline_counted', { time: formatOfflineTimeLong(countedSeconds) }) : '';
    }
    if (dom.offlineNote) {
        const eff = Math.round(getOfflineEfficiencyMultiplier() * 100);
        dom.offlineNote.textContent = capped
            ? t('offline_limit_note', { limit: formatAfkHours(limitSeconds / 3600), eff })
            : t('offline_eff_note', { eff });
        if (pending.timeLimited) {
            dom.offlineNote.textContent = t('offline_unverified') + dom.offlineNote.textContent;
        }
    }
    dom.offlineOverlay.classList.add('open');
}

/** Closes the Offline Progress modal. */
function closeOfflineProgressModal() {
    if (dom.offlineOverlay) dom.offlineOverlay.classList.remove('open');
}

/**
 * Grants the pending offline reward once. The pending object is cleared BEFORE any
 * gold is added, so double-clicks / re-entrancy can never pay it twice.
 * @param {number} multiplier - 1 for a normal claim
 */
function claimOfflineReward(multiplier) {
    const pending = gameState.offline.pending;
    if (!pending) { closeOfflineProgressModal(); return; }
    gameState.offline.pending = null;

    const gold = pending.gold * Math.max(1, Number(multiplier) || 1);
    addCoins(gold);
    gainExperience(gold * OFFLINE_CONFIG.claimXpFraction);

    closeOfflineProgressModal();
    updateUI();
    updateQuestUI();
    updatePassUI();
    saveGame();

    // Natural break: the player has just collected the offline reward and is about to resume playing.
    try { GCAds.commercialBreak('offline-claim'); } catch (e) { /* never break gameplay for an ad */ }
}

/** Binds the Claim button exactly once. */
function initOfflineModal() {
    if (dom.offlineClaimBtn && !dom.offlineClaimBtn.dataset.bound) {
        dom.offlineClaimBtn.dataset.bound = '1';
        dom.offlineClaimBtn.addEventListener('click', () => claimOfflineReward(1));
    }
}

/**
 * =========================================
 * HELPERS / AUTOMATION SYSTEM
 * =========================================
 * Data-driven: every helper is one entry in HELPER_DEFINITIONS and behaves
 * according to its effect.type, which maps to an entry in HELPER_BEHAVIORS.
 *
 * To add a NEW helper of an existing type: just add one object to
 * HELPER_DEFINITIONS. To add a NEW kind of automation: add one entry to
 * HELPER_BEHAVIORS (format / tick / status) and reference its type.
 *
 * Definition fields:
 *   id, name, icon, description
 *   level            starting level (0 = not owned) - live levels are in gameState.helpers.levels
 *   basePrice        price of level 1
 *   priceMultiplier  per-level growth: price = basePrice * priceMultiplier ^ currentLevel
 *   currency         'coins' | 'gems'
 *   maxLevel         null = unlimited
 *   resetOnPrestige  false = survives Prestige (default)
 *   effect           { type, unit, base, perLevel, curve: 'linear'|'exponential', growth, min, max, compute }
 *                    value(level) = base + perLevel * level          (linear)
 *                                 = base * growth ^ level            (exponential)
 *                                 = compute(level)                   (custom, overrides the above)
 *                    then clamped to [min, max].
 *
 * All helper logic runs inside gameLoop() via tickHelpers() - no per-helper intervals.
 */
const HELPER_CONFIG = {
    defaultPriceMultiplier: 1.15,   // price = basePrice * Math.pow(1.15, level) unless a helper overrides it
    hardMaxLevel: 10000,            // safety cap for corrupted/huge saved levels
    maxCatchUpSeconds: 60,          // auto-click income may catch up this much after a throttled/background tab
    maxBossHitsPerTick: 25,         // safety cap on programmatic boss hits per 1s tick
    autoClickEfficiency: 1,         // multiplier on gold from auto-clicks (1 = same as a manual click)
    autoClicksCountForQuests: false,// true = auto-clicks also count toward click quests/achievements
    // Boss fight overlay (bosses.js): overlay gets .open, result screen gets .show
    bossTargetSelector: '#boss-fight-target-btn',
    bossOverlaySelector: '#boss-fight-overlay',
    bossResultSelector: '#boss-fight-result-overlay',
    bossOverlayOpenClass: 'open',   // class bosses.js adds to the overlay while a fight runs
    bossResultShowClass: 'show',    // class bosses.js adds to the result screen once the fight is decided
    // Timed mine events (adventures.js): one shared banner button; a boss banner also has an HP bar
    eventTargetSelector: '#mine-event-target-btn',
    eventBossMarkerSelector: '#mine-event-hpbar-inner',
    maxVeinClicksPerTick: 20,       // safety cap on Dwarf Miner clicks into a Rich Gold Vein per tick
    // Collectibles the Resource Collector grabs (Golden Meteor / Glowing Crystal, Rift fragments)
    collectSelectors: ['.mini-event', '.rift-particle'],
    activeWindowMs: 1600            // a helper counts as "working" this long after its last action
};

const HELPER_DEFINITIONS = [
    {
        id: 'dwarfMiner',
        get name() { return t('helper_dwarfMiner_name'); },
        icon: '⛏️',
        get description() { return t('helper_dwarfMiner_desc'); },
        level: 0,
        basePrice: 1000,
        priceMultiplier: HELPER_CONFIG.defaultPriceMultiplier,
        currency: 'coins',
        maxLevel: null,
        resetOnPrestige: false,
        effect: { type: 'autoClicks', unit: 'clicks/s', base: 0, perLevel: 0.5, curve: 'linear' }
    },
    {
        id: 'autoBattler',
        get name() { return t('helper_autoBattler_name'); },
        icon: '🗡️',
        get description() { return t('helper_autoBattler_desc'); },
        level: 0,
        basePrice: 2500,
        priceMultiplier: HELPER_CONFIG.defaultPriceMultiplier,
        currency: 'coins',
        maxLevel: null,
        resetOnPrestige: false,
        effect: { type: 'bossHits', unit: 'hits/s', base: 0.25, perLevel: 0.25, curve: 'linear', max: 12 }
    },
    {
        id: 'resourceCollector',
        get name() { return t('helper_resourceCollector_name'); },
        icon: '🧲',
        get description() { return t('helper_resourceCollector_desc'); },
        level: 0,
        basePrice: 10,
        priceMultiplier: HELPER_CONFIG.defaultPriceMultiplier,
        currency: 'gems',
        maxLevel: 15,
        resetOnPrestige: false,
        effect: { type: 'collect', unit: 's reaction', base: 4, perLevel: -0.25, curve: 'linear', min: 0.5 }
    }
];

/** Runtime-only data (NOT saved): fractional carries, timers, activity flags. */
const helperRuntime = {};
function getHelperRuntime(id) {
    if (!helperRuntime[id]) helperRuntime[id] = { carry: 0, lastActionAt: -1e9, lastGold: 0, note: '' };
    return helperRuntime[id];
}

function getHelperDefinition(id) {
    return HELPER_DEFINITIONS.find((d) => d.id === id) || null;
}

/** Guarantees gameState.helpers is a well-formed object (safe to call anywhere, anytime). */
function ensureHelperState() {
    if (!gameState.helpers || typeof gameState.helpers !== 'object') gameState.helpers = {};
    if (!gameState.helpers.levels || typeof gameState.helpers.levels !== 'object' || Array.isArray(gameState.helpers.levels)) {
        gameState.helpers.levels = {};
    }
    if (!gameState.helpers.stats || typeof gameState.helpers.stats !== 'object' || Array.isArray(gameState.helpers.stats)) {
        gameState.helpers.stats = {};
    }
    return gameState.helpers;
}

function getHelperMaxLevel(def) {
    const m = Number(def.maxLevel);
    return (Number.isFinite(m) && m > 0) ? Math.min(m, HELPER_CONFIG.hardMaxLevel) : HELPER_CONFIG.hardMaxLevel;
}

function getHelperLevel(id) {
    const def = getHelperDefinition(id);
    if (!def) return 0;
    const raw = Math.floor(Number(ensureHelperState().levels[id]));
    if (!Number.isFinite(raw) || raw < 0) return 0;
    return Math.min(raw, getHelperMaxLevel(def));
}

function getHelperStats(id) {
    const st = ensureHelperState().stats;
    if (!st[id] || typeof st[id] !== 'object') st[id] = { actions: 0, gold: 0 };
    return st[id];
}

/** Restores helpers from a parsed save; corrupt / missing / unknown data falls back to level 0. */
function loadHelperState(parsed) {
    gameState.helpers = { levels: {}, stats: {} };
    const src = (parsed && parsed.helpers && typeof parsed.helpers === 'object') ? parsed.helpers : {};
    const levels = (src.levels && typeof src.levels === 'object') ? src.levels : {};
    const stats = (src.stats && typeof src.stats === 'object') ? src.stats : {};
    HELPER_DEFINITIONS.forEach((def) => {
        let lvl = Math.floor(Number(levels[def.id]));
        if (!Number.isFinite(lvl) || lvl < 0) lvl = Math.max(0, Math.floor(Number(def.level)) || 0);
        gameState.helpers.levels[def.id] = Math.min(lvl, getHelperMaxLevel(def));
        const s = stats[def.id] || {};
        gameState.helpers.stats[def.id] = {
            actions: Number.isFinite(Number(s.actions)) ? Math.max(0, Number(s.actions)) : 0,
            gold: Number.isFinite(Number(s.gold)) ? Math.max(0, Number(s.gold)) : 0
        };
    });
}

/** Called from performPrestige(): resets only helpers that opt in via resetOnPrestige. */
function resetHelpersForPrestige() {
    ensureHelperState();
    HELPER_DEFINITIONS.forEach((def) => {
        if (def.resetOnPrestige) {
            gameState.helpers.levels[def.id] = Math.max(0, Math.floor(Number(def.level)) || 0);
        }
    });
    refreshHelpersUI(true);
}

/** Effect value at a given level (see HELPER_DEFINITIONS doc for the curve options). */
function getHelperEffectValue(def, level) {
    const e = def.effect || {};
    let v;
    if (typeof e.compute === 'function') {
        v = Number(e.compute(level));
    } else if (e.curve === 'exponential') {
        v = (Number(e.base) || 0) * Math.pow(Number(e.growth) || 1, level);
    } else {
        v = (Number(e.base) || 0) + (Number(e.perLevel) || 0) * level;
    }
    if (!Number.isFinite(v)) v = 0;
    if (Number.isFinite(e.min)) v = Math.max(e.min, v);
    if (Number.isFinite(e.max)) v = Math.min(e.max, v);
    return v;
}

/** Price of the next single level: basePrice * priceMultiplier ^ currentLevel. */
const helperPriceCache = new WeakMap(); // def -> [price at level 0, 1, 2, ...] (grown lazily)
function getHelperPrice(def, level) {
    const mult = Number(def.priceMultiplier) > 0 ? Number(def.priceMultiplier) : HELPER_CONFIG.defaultPriceMultiplier;
    let entry = helperPriceCache.get(def);
    if (!entry || entry.mult !== mult || entry.base !== def.basePrice) {
        entry = { mult, base: def.basePrice, prices: [] };
        helperPriceCache.set(def, entry);
    }
    const p = entry.prices;
    if (level < 0 || level !== Math.floor(level) || level > HELPER_CONFIG.hardMaxLevel + 1) {
        return Math.ceil(def.basePrice * Math.pow(mult, level));
    }
    for (let i = p.length; i <= level; i++) p[i] = Math.ceil(def.basePrice * Math.pow(mult, i));
    return p[level];
}

function getHelperBalance(def) {
    return def.currency === 'gems' ? gameState.gems : gameState.coins;
}

/**
 * Resolves the active bulk-buy amount (x1/x10/x100/MAX) into
 * { count, totalCost } for a helper, respecting its max level.
 */
function resolveHelperPurchase(def) {
    const level = getHelperLevel(def.id);
    const room = getHelperMaxLevel(def) - level;
    if (room <= 0) return { count: 0, totalCost: 0, maxed: true };
    const balance = getHelperBalance(def);
    const wanted = gameState.buyAmount === 'MAX' ? room : Math.min(room, Math.max(1, Number(gameState.buyAmount) || 1));
    let count = 0;
    let totalCost = 0;
    for (let i = 0; i < wanted; i++) {
        const price = getHelperPrice(def, level + i);
        if (gameState.buyAmount === 'MAX' && totalCost + price > balance) break;
        totalCost += price;
        count++;
    }
    if (count === 0) {
        // Nothing affordable under MAX: show the price of one level so the card still reads sensibly.
        return { count: 0, totalCost: getHelperPrice(def, level), maxed: false };
    }
    return { count, totalCost, maxed: false };
}

/** Buys as many levels as the bulk-buy selection allows (and the player can afford). */
function buyHelper(id) {
    initAudio();
    const def = getHelperDefinition(id);
    if (!def) return;
    const { count, totalCost, maxed } = resolveHelperPurchase(def);
    if (maxed || count <= 0 || getHelperBalance(def) < totalCost) return;

    if (def.currency === 'gems') gameState.gems -= totalCost;
    else gameState.coins -= totalCost;

    ensureHelperState().levels[id] = getHelperLevel(id) + count;
    playUpgradeSound();
    updateUIForce();
    saveGame();
}

/** Current gold/second produced by helpers (auto-clicks), before offline efficiency. */
function getAutoClickValue() {
    const critMult = gameState.critMultiplier + getRelicCritMultiplierBonus();
    const critFactor = 1 + Math.min(1, Math.max(0, gameState.critChance)) * (critMult - 1); // expected crit value
    return getBaseClickAmount() * getTotalMultiplier() * critFactor * HELPER_CONFIG.autoClickEfficiency;
}

function getHelperGoldPerSecond() {
    let total = 0;
    HELPER_DEFINITIONS.forEach((def) => {
        if (def.effect.type !== 'autoClicks') return;
        const level = getHelperLevel(def.id);
        if (level > 0) total += getHelperEffectValue(def, level) * getAutoClickValue();
    });
    return Number.isFinite(total) ? total : 0;
}

/** Dispatches a real click (with on-screen coordinates) so game code that reads clientX/clientY behaves. */
function helperClick(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: Math.round(r.left + r.width / 2),
        clientY: Math.round(r.top + r.height / 2)
    }));
    return true;
}

/** Kind of timed mine event currently showing its banner button: 'boss', 'vein' or null. */
function getMineEventBannerKind() {
    if (!document.querySelector(HELPER_CONFIG.eventTargetSelector)) return null;
    return document.querySelector(HELPER_CONFIG.eventBossMarkerSelector) ? 'boss' : 'vein';
}

/** True while a boss fight is on screen and still being fought (bosses.js: overlay.open, result.show). */
function isBossFightActive() {
    const overlay = document.querySelector(HELPER_CONFIG.bossOverlaySelector);
    const target = document.querySelector(HELPER_CONFIG.bossTargetSelector);
    if (!overlay || !target || target.disabled) return false;
    if (!overlay.classList.contains(HELPER_CONFIG.bossOverlayOpenClass)) return false;
    const result = document.querySelector(HELPER_CONFIG.bossResultSelector);
    if (result && result.classList.contains(HELPER_CONFIG.bossResultShowClass)) return false; // fight already decided
    return true;
}

/** A boss fight overlay or a boss mine-event banner is up and hittable. */
function isAutoBattlerTargetAvailable() {
    return isBossFightActive() || getMineEventBannerKind() === 'boss';
}

const helperSeenAt = new WeakMap(); // collectible element -> performance.now() when first noticed

/**
 * Behavior registry. Each behavior provides:
 *   format(value, def)     text for the effect line
 *   tick(ctx)              per-tick automation; returns gold earned (number, may be 0)
 *   status(ctx)            { text, working } for the status pill
 */
const HELPER_BEHAVIORS = {
    autoClicks: {
        format: (v) => t('helper_fmt_autoClicks', { v: v.toFixed(v % 1 === 0 ? 0 : 1) }),
        tick: ({ def, level, value, dt, rt }) => {
            const seconds = Math.min(dt, HELPER_CONFIG.maxCatchUpSeconds);
            const clicks = value * seconds;
            if (clicks <= 0) return 0;
            const gold = clicks * getAutoClickValue();
            if (!(gold > 0) || !Number.isFinite(gold)) return 0;

            addCoins(gold);
            gainExperience(gold);
            gameState.pass.dailyProgress.passiveEarned += gold;

            rt.carry += clicks;
            const whole = Math.floor(rt.carry);
            rt.carry -= whole;
            if (whole > 0) {
                const stats = getHelperStats(def.id);
                stats.actions += whole;
                if (HELPER_CONFIG.autoClicksCountForQuests) {
                    gameState.questProgress.clicks += whole;
                    gameState.achievementProgress.clicks += whole;
                    gameState.pass.dailyProgress.clicks += whole;
                    gameState.pass.weeklyProgress.clicks += whole;
                }
            }
            getHelperStats(def.id).gold += gold;
            rt.lastGold = gold / Math.max(seconds, 0.001);
            rt.lastActionAt = GCTime.mono();

            // Auto-clicks also chip away at an active Rich Gold Vein event (same clicks, same rules).
            if (getMineEventBannerKind() === 'vein') {
                rt.veinCarry = (rt.veinCarry || 0) + clicks;
                let veinClicks = Math.min(Math.floor(rt.veinCarry), HELPER_CONFIG.maxVeinClicksPerTick);
                rt.veinCarry -= Math.floor(rt.veinCarry);
                while (veinClicks-- > 0 && getMineEventBannerKind() === 'vein') {
                    helperClick(document.querySelector(HELPER_CONFIG.eventTargetSelector));
                }
            } else {
                rt.veinCarry = 0;
            }
            return gold;
        },
        status: ({ rt }) => ({ text: t('helper_status_mining', { amount: formatNumber(rt.lastGold || 0) }), working: true })
    },

    bossHits: {
        format: (v) => t('helper_fmt_bossHits', { v: v.toFixed(v % 1 === 0 ? 0 : 2) }),
        tick: ({ def, value, dt, rt }) => {
            if (!isAutoBattlerTargetAvailable()) { rt.carry = 0; return 0; }
            rt.carry += value * Math.min(dt, 1.5);
            const hits = Math.min(Math.floor(rt.carry), HELPER_CONFIG.maxBossHitsPerTick);
            rt.carry -= Math.floor(rt.carry);
            if (hits <= 0) return 0;

            // Spread the hits across the second instead of one burst; each hit re-checks the fight.
            for (let i = 0; i < hits; i++) {
                setTimeout(() => {
                    // Re-check every hit: the fight/event may have just ended.
                    let target = null;
                    if (isBossFightActive()) target = document.querySelector(HELPER_CONFIG.bossTargetSelector);
                    else if (getMineEventBannerKind() === 'boss') target = document.querySelector(HELPER_CONFIG.eventTargetSelector);
                    if (target && helperClick(target)) { // reuses the boss code's own damage / sound logic
                        getHelperStats(def.id).actions += 1;
                        rt.lastActionAt = GCTime.mono();
                    }
                }, Math.floor((i * 950) / hits));
            }
            return 0;
        },
        status: () => (isAutoBattlerTargetAvailable()
            ? { text: t('helper_status_striking'), working: true }
            : { text: t('helper_status_waiting'), working: false })
    },

    collect: {
        format: (v) => t('helper_fmt_collect', { v: v.toFixed(2).replace(/\.?0+$/, '') }),
        tick: ({ def, value, rt }) => {
            const now = performance.now();
            let collected = 0;
            HELPER_CONFIG.collectSelectors.forEach((sel) => {
                document.querySelectorAll(sel).forEach((el) => {
                    if (!el.isConnected) return;
                    if (!helperSeenAt.has(el)) { helperSeenAt.set(el, now); return; }
                    if (now - helperSeenAt.get(el) >= value * 1000) {
                        helperSeenAt.set(el, Infinity); // never click the same element twice
                        helperClick(el);                 // goes through the element's own collect handler
                        collected++;
                    }
                });
            });
            if (collected > 0) {
                getHelperStats(def.id).actions += collected;
                rt.lastActionAt = GCTime.mono();
                rt.note = collected;
            }
            return 0;
        },
        status: ({ rt }) => ((GCTime.mono() - rt.lastActionAt) < 4000 && rt.note
            ? { text: t('helper_status_collected', { n: rt.note }), working: true }
            : { text: t('helper_status_watching'), working: true })
    }
};

let lastHelperTickAt = 0;

/**
 * Runs every helper once. Called from gameLoop() (the single 1s game tick).
 * @returns {number} total gold produced this tick
 */
function tickHelpers() {
    ensureHelperState();
    const now = GCTime.mono(); // tick delta = elapsed active time -> monotonic clock, immune to OS clock changes
    const dt = lastHelperTickAt ? Math.min(Math.max((now - lastHelperTickAt) / 1000, 0), HELPER_CONFIG.maxCatchUpSeconds) : 1;
    lastHelperTickAt = now;

    let gold = 0;
    HELPER_DEFINITIONS.forEach((def) => {
        const level = getHelperLevel(def.id);
        if (level <= 0) return;
        const behavior = HELPER_BEHAVIORS[def.effect.type];
        if (!behavior) return;
        try {
            gold += behavior.tick({
                def, level, dt,
                value: getHelperEffectValue(def, level),
                rt: getHelperRuntime(def.id)
            }) || 0;
        } catch (e) {
            console.warn(`Helper "${def.id}" tick failed:`, e);
        }
    });

    return gold;
}

/* ---------- Helpers UI ---------- */

let helpersUiBuilt = false;
let activeShopTab = 'upgrades';

/** Builds the Helpers panel + shop tab buttons once (listeners bound once). */
function initHelpers() {
    ensureHelperState();
    const tabBar = document.getElementById('shop-tab-bar');
    const panelUpgrades = document.getElementById('shop-tab-panel-upgrades');
    const panelHelpers = document.getElementById('shop-tab-panel-helpers');
    if (!tabBar || !panelHelpers) return; // older HTML without the Helpers markup

    if (!tabBar.dataset.bound) {
        tabBar.dataset.bound = '1';
        tabBar.querySelectorAll('.shop-tab-btn').forEach((btn) => {
            btn.addEventListener('click', () => switchShopTab(btn.dataset.stab));
        });
    }

    if (!helpersUiBuilt) {
        helpersUiBuilt = true;
        const list = document.getElementById('helper-list');
        list.innerHTML = '';
        HELPER_DEFINITIONS.forEach((def) => {
            const card = document.createElement('div');
            card.className = 'helper-card';
            card.dataset.helper = def.id;
            card.innerHTML = `
                <div class="frame-corner top-left"></div>
                <div class="frame-corner top-right"></div>
                <div class="frame-corner bottom-left"></div>
                <div class="frame-corner bottom-right"></div>
                <div class="helper-icon" data-role="icon">${def.icon}</div>
                <div class="helper-info">
                    <div class="helper-title-row">
                        <span class="helper-name">${def.name}</span>
                        <span class="helper-level" data-role="level">${t('level_short', { level: 0 })}</span>
                    </div>
                    <div class="helper-desc">${def.description}</div>
                    <div class="helper-effect" data-role="effect"></div>
                    <div class="helper-status" data-role="status"></div>
                </div>
                <button type="button" class="helper-buy-btn" data-role="buy">
                    <span class="helper-buy-label" data-role="buyLabel">${t('helper_hire')}</span>
                    <span class="helper-buy-price" data-role="buyPrice"></span>
                </button>`;
            card.querySelector('[data-role="buy"]').addEventListener('click', () => buyHelper(def.id));
            list.appendChild(card);
        });
    }

    switchShopTab(activeShopTab);
    refreshHelpersUI(true);
}

/** Switches between the Upgrades and Helpers tabs of the shop panel. */
function switchShopTab(tab) {
    activeShopTab = (tab === 'helpers' || tab === 'afk') ? tab : 'upgrades';
    document.querySelectorAll('#shop-tab-bar .shop-tab-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.stab === activeShopTab);
    });
    const up = document.getElementById('shop-tab-panel-upgrades');
    const hp = document.getElementById('shop-tab-panel-helpers');
    if (up) up.style.display = activeShopTab === 'upgrades' ? '' : 'none';
    if (hp) hp.style.display = activeShopTab === 'helpers' ? '' : 'none';
    const ap = document.getElementById('shop-tab-panel-afk');
    if (ap) ap.style.display = activeShopTab === 'afk' ? '' : 'none';
    // The bulk-buy bar only applies to Upgrades / Helpers, not to one-time AFK upgrades.
    const bulk = document.getElementById('buy-amount-bar');
    if (bulk) bulk.style.display = activeShopTab === 'afk' ? 'none' : '';
    refreshHelpersUI(true);
    refreshAfkUI(true);
}

/**
 * Updates helper cards (text/state only - the DOM is not rebuilt) plus the
 * summary strip on the main screen. Cheap enough to call every tick.
 * @param {boolean} [force] update the (hidden) panel too
 */
let helperStripHtml = null;
const helperCardRefs = {};
function getHelperCardRefs(def) {
    let r = helperCardRefs[def.id];
    if (r && r.card.isConnected) return r;
    const card = document.querySelector(`.helper-card[data-helper="${def.id}"]`);
    if (!card) return null;
    r = {
        card,
        level: card.querySelector('[data-role="level"]'),
        effect: card.querySelector('[data-role="effect"]'),
        status: card.querySelector('[data-role="status"]'),
        buy: card.querySelector('[data-role="buy"]'),
        buyLabel: card.querySelector('[data-role="buyLabel"]'),
        buyPrice: card.querySelector('[data-role="buyPrice"]')
    };
    helperCardRefs[def.id] = r;
    return r;
}

function refreshHelpersUI(force) {
    const now = GCTime.mono(); // elapsed-only comparisons (rt.lastActionAt) -> monotonic clock
    const panelVisible = activeShopTab === 'helpers';

    // --- Main-screen status strip (visible whenever at least one helper is owned) ---
    // The markup is only written when the generated HTML actually differs from what is on screen.
    const strip = document.getElementById('helper-status-strip');
    if (strip) {
        const chips = [];
        HELPER_DEFINITIONS.forEach((def) => {
            const level = getHelperLevel(def.id);
            if (level <= 0) return;
            const behavior = HELPER_BEHAVIORS[def.effect.type];
            const rt = getHelperRuntime(def.id);
            const status = behavior ? behavior.status({ def, level, rt }) : { text: '', working: false };
            const active = status.working && (now - rt.lastActionAt < HELPER_CONFIG.activeWindowMs || def.effect.type === 'collect');
            chips.push(`<span class="helper-chip${active ? ' working' : ''}" title="${def.name} - ${status.text}">` +
                `${def.icon} <b>${t('level_short', { level })}</b> ${behavior ? behavior.format(getHelperEffectValue(def, level), def) : ''}</span>`);
        });
        const gps = chips.length ? getHelperGoldPerSecond() : 0;
        const html = chips.length
            ? chips.join('') + (gps > 0 ? `<span class="helper-chip helper-chip-income">${t('helper_chip_income', { amount: formatNumber(gps) })}</span>` : '')
            : null;
        if (html !== helperStripHtml) {
            helperStripHtml = html;
            if (html !== null) {
                strip.style.display = '';
                strip.innerHTML = html;
            } else {
                strip.style.display = 'none';
                strip.innerHTML = '';
            }
        }
    }

    if (!panelVisible && !force) return;

    // --- Helper cards ---
    const summary = document.getElementById('helper-summary');
    let totalOwned = 0;
    HELPER_DEFINITIONS.forEach((def) => {
        const r = getHelperCardRefs(def);
        if (!r) return;
        const card = r.card;
        const level = getHelperLevel(def.id);
        const behavior = HELPER_BEHAVIORS[def.effect.type];
        const rt = getHelperRuntime(def.id);
        const maxLevel = getHelperMaxLevel(def);
        const purchase = resolveHelperPurchase(def);
        const canAfford = !purchase.maxed && purchase.count > 0 && getHelperBalance(def) >= purchase.totalCost;
        const currencyIcon = def.currency === 'gems' ? '💎' : '🪙';
        if (level > 0) totalOwned++;

        setTextIfChanged(r.level, level >= maxLevel && def.maxLevel ? t('helper_level_max', { level }) : t('level_short', { level }));

        const cur = getHelperEffectValue(def, level);
        const next = getHelperEffectValue(def, Math.min(level + 1, maxLevel));
        let effectText = level > 0 && behavior ? behavior.format(cur, def) : t('helper_not_hired');
        if (behavior && level < maxLevel) {
            effectText = level > 0 ? t('helper_effect_next', { cur: effectText, next: behavior.format(next, def) }) : t('helper_effect_first', { cur: effectText, next: behavior.format(next, def) });
        }
        setTextIfChanged(r.effect, effectText);

        const statusEl = r.status;
        if (level > 0 && behavior) {
            const status = behavior.status({ def, level, rt });
            setTextIfChanged(statusEl, status.text);
            statusEl.classList.toggle('working', !!status.working);
            const worked = now - rt.lastActionAt < HELPER_CONFIG.activeWindowMs;
            card.classList.toggle('helper-working', status.working && (worked || def.effect.type === 'collect'));
        } else {
            setTextIfChanged(statusEl, t('helper_idle'));
            statusEl.classList.remove('working');
            card.classList.remove('helper-working');
        }
        card.classList.toggle('helper-owned', level > 0);

        const btn = r.buy;
        const disabled = !canAfford;
        if (btn.disabled !== disabled) btn.disabled = disabled;
        btn.classList.toggle('disabled', disabled);
        if (purchase.maxed) {
            setTextIfChanged(r.buyLabel, t('helper_max_level'));
            setTextIfChanged(r.buyPrice, '');
        } else {
            const label = gameState.buyAmount === 'MAX'
                ? t(level > 0 ? 'helper_upgrade_max' : 'helper_hire_max', { count: purchase.count })
                : t(level > 0 ? 'helper_upgrade_n' : 'helper_hire_n', { count: purchase.count || gameState.buyAmount });
            setTextIfChanged(r.buyLabel, label);
            setTextIfChanged(r.buyPrice, `${formatNumber(purchase.totalCost)} ${currencyIcon}`);
        }
    });

    if (summary) {
        const gps = getHelperGoldPerSecond();
        const parts = [t('helper_summary_hired', { owned: totalOwned, total: HELPER_DEFINITIONS.length })];
        if (gps > 0) parts.push(t('helper_summary_gps', { amount: formatNumber(gps) }));
        setTextIfChanged(summary, parts.join('  •  '));
    }
}



/* =========================================
 * AFK UPGRADES (Gem Shop tab)
 * =========================================
 * Progression: 2h -> [500 Gems] 4h -> [1500 Gems] 8h -> [4000 Gems / ads] 16h -> [8000 Gems / ads] 24h.
 * State is the single number shopState.afkLevel. All validation lives in buyAfkGemUpgrade().
 */

/** 'owned' | 'locked' | 'available' for a gem AFK upgrade. */
function getAfkUpgradeState(up) {
    const lvl = getAfkLevel();
    if (lvl >= up.level) return 'owned';
    return lvl === up.level - 1 ? 'available' : 'locked';
}

/** Buys a gem AFK upgrade. All rules enforced here (not just via disabled buttons). */
function buyAfkGemUpgrade(level) {
    initAudio();
    const up = AFK_GEM_UPGRADES.find((u) => u.level === level);
    if (!up) return false;
    ensureShopState();
    if (getAfkUpgradeState(up) !== 'available') return false;        // owned (no re-buy) or prerequisite missing
    if (!(Number(gameState.gems) >= up.cost)) return false;          // can't afford

    gameState.gems -= up.cost;
    gameState.shopState.afkLevel = up.level;
    syncAfkLimit();

    playUpgradeSound();
    saveGame();
    updateUIForce();
    refreshAfkUI(true);
    if (typeof renderIapShop === 'function') renderIapShop();
    return true;
}

let afkUiBuilt = false;
const afkCardRefs = {};
let afkLastSig = '';

function buildAfkUI() {
    const list = document.getElementById('afk-list');
    if (!list || afkUiBuilt) return;
    afkUiBuilt = true;
    list.innerHTML = '';
    AFK_GEM_UPGRADES.forEach((up) => {
        const card = document.createElement('div');
        card.className = 'helper-card afk-card';
        card.dataset.afk = String(up.level);
        card.innerHTML = `
            <div class="frame-corner top-left"></div>
            <div class="frame-corner top-right"></div>
            <div class="frame-corner bottom-left"></div>
            <div class="frame-corner bottom-right"></div>
            <div class="helper-icon">${up.icon}</div>
            <div class="helper-info">
                <div class="helper-title-row">
                    <span class="helper-name">${up.name}</span>
                    <span class="helper-level" data-role="state"></span>
                </div>
                <div class="helper-desc">${t('afk_card_desc', { hours: up.hours })}</div>
                <div class="helper-effect" data-role="effect"></div>
            </div>
            <button type="button" class="helper-buy-btn" data-role="buy">
                <span class="helper-buy-label" data-role="buyLabel">${t('afk_btn_buy')}</span>
                <span class="helper-buy-price" data-role="buyPrice"></span>
            </button>`;
        card.querySelector('[data-role="buy"]').addEventListener('click', () => buyAfkGemUpgrade(up.level));
        list.appendChild(card);
        afkCardRefs[up.level] = {
            card,
            state: card.querySelector('[data-role="state"]'),
            effect: card.querySelector('[data-role="effect"]'),
            buy: card.querySelector('[data-role="buy"]'),
            buyLabel: card.querySelector('[data-role="buyLabel"]'),
            buyPrice: card.querySelector('[data-role="buyPrice"]')
        };
    });
}

/** Updates the AFK tab (current limit + card states). Cheap: skips work when nothing changed. */
function refreshAfkUI(force) {
    if (!afkUiBuilt) buildAfkUI();
    if (!afkUiBuilt) return;
    const panelVisible = activeShopTab === 'afk';
    if (!panelVisible && !force) return;

    const lvl = getAfkLevel();
    const gems = Math.floor(Number(gameState.gems) || 0);
    const sig = `${lvl}|${gems}`;
    if (!force && sig === afkLastSig) return;
    afkLastSig = sig;

    const cur = document.getElementById('afk-current');
    if (cur) setTextIfChanged(cur, t('afk_limit_label', { limit: formatAfkHours(getMaxOfflineHours()) }));

    AFK_GEM_UPGRADES.forEach((up) => {
        const r = afkCardRefs[up.level];
        if (!r) return;
        const state = getAfkUpgradeState(up);
        const prev = AFK_GEM_UPGRADES.find((u) => u.level === up.level - 1);
        const canAfford = gems >= up.cost;
        r.card.classList.toggle('afk-owned', state === 'owned');
        r.card.classList.toggle('afk-locked', state === 'locked');
        if (state === 'owned') {
            setTextIfChanged(r.state, t('afk_state_purchased'));
            setTextIfChanged(r.effect, t('afk_effect_owned', { limit: formatAfkHours(up.hours) }));
            setTextIfChanged(r.buyLabel, t('afk_btn_owned'));
            setTextIfChanged(r.buyPrice, '');
            r.buy.disabled = true;
        } else if (state === 'locked') {
            setTextIfChanged(r.state, t('afk_state_locked'));
            setTextIfChanged(r.effect, t('afk_effect_locked', { name: prev ? prev.name : t('afk_prev_upgrade') }));
            setTextIfChanged(r.buyLabel, t('afk_btn_locked'));
            setTextIfChanged(r.buyPrice, `${up.cost.toLocaleString('en-US')} 💎`);
            r.buy.disabled = true;
        } else {
            setTextIfChanged(r.state, t('afk_state_available'));
            setTextIfChanged(r.effect, t('afk_progress_gems', { from: formatAfkHours(getMaxOfflineHours()), to: formatAfkHours(up.hours) }));
            setTextIfChanged(r.buyLabel, canAfford ? t('afk_btn_buy') : t('afk_btn_no_gems'));
            setTextIfChanged(r.buyPrice, `${up.cost.toLocaleString('en-US')} 💎`);
            r.buy.disabled = !canAfford;
        }
        r.buy.classList.toggle('disabled', r.buy.disabled);
    });
}

function initAfkShop() {
    buildAfkUI();
    refreshAfkUI(true);
}

/**
 * =========================================
 * SHOP (Gems)
 * =========================================
 * There is NO real-money monetization and no advertising. Every premium item is obtained with in-game Gems (gemCost).
 *
 *   SHOP_PRODUCTS            data-driven catalog (add a product = add an entry)
 *   buyProductWithGems(id)   validates, spends Gems, grants the product
 *   applyProductGrant(...)   shared grant code path
 *
 * State lives in gameState.shopState and is saved with the normal save blob
 * (plus a small redundant 'goldClickerShop' key). Older saves load safely.
 *
 * Shop-related hooks in the rest of the game:
 *   getGoldMultiplier()        -> folded into getTotalMultiplier() (clicks + passive + offline)
 *   getFrenzyMultiplier()      -> passive income only (getPassiveIncomeMultiplier())
 *   getVIPDropMultiplier()     -> adventures.js getDropChanceMultiplier()
 *   getRuneSlotCount()         -> adventures.js ensureAdventureState() via syncRuneSlotsToVIP()
 */

const VIP_GOLD_MULTIPLIER = 2;            // x2 global gold
const VIP_DROP_CHANCE_MULTIPLIER = 1.5;   // +50% (multiplicative: 10% -> 15%)
const VIP_EXTRA_RUNE_SLOTS = 1;
const BASE_RUNE_SLOTS = 3;
const FRENZY_POTION_MULTIPLIER = 5;       // x5 passive income (CPS)
const FRENZY_POTION_DURATION_MS = 60 * 1000;

/**
 * Central product catalog.
 *   grant            applied by applyProductGrant() when bought with Gems
 *   gemCost          (optional) Gem price
 */
const SHOP_PRODUCTS = {
    vip: {
        id: 'vip',
        category: 'vip',
        get name() { return t('prod_vip_name'); },
        icon: '👑',
        get badge() { return t('prod_vip_badge'); },
        featured: true,
        oneTime: true,
        get ownedLabel() { return t('prod_vip_owned'); },
        get description() { return t('prod_vip_desc'); },
        get perks() { return [t('prod_vip_perk1'), t('prod_vip_perk2'), t('prod_vip_perk3'), t('prod_vip_perk4')]; },
        // vipDurationMs: null = permanent.
        grant: { vip: true, vipDurationMs: null },
        gemCost: 3000,
        isOwned: (s) => isVIPActive() && s.vipExpires == null
    },
    premiumExpeditionPass: {
        id: 'premiumExpeditionPass',
        category: 'pass',
        get name() { return t('prod_pass_name'); },
        icon: '👑',
        get badge() { return t('prod_pass_badge'); },
        featured: true,
        oneTime: true,
        get ownedLabel() { return t('prod_pass_owned'); },
        get description() { return t('prod_pass_desc'); },
        get perks() { return [t('prod_pass_perk1'), t('prod_pass_perk2'), t('prod_pass_perk3')]; },
        grant: { flags: { isPremiumPassUnlocked: true }, get headline() { return t('prod_pass_headline'); }, get lines() { return [t('prod_pass_line1')]; } },
        gemCost: 1500,
        isOwned: (s) => s.isPremiumPassUnlocked === true
    },
    afk16: {
        id: 'afk16',
        category: 'afk',
        get name() { return t('prod_afk16_name'); },
        icon: '🕓',
        oneTime: true,
        get ownedLabel() { return t('iap_owned'); },
        get description() { return t('prod_afk16_desc'); },
        get perks() { return [t('prod_afk16_perk1')]; },
        grant: { afkLevel: 3, get headline() { return t('prod_afk_headline'); }, get lines() { return [t('prod_afk16_perk1')]; } },
        gemCost: 4000,
        isUnlocked: (s) => clampAfkLevel(s.afkLevel) >= 2,   // requires the 8h upgrade first
        isOwned: (s) => clampAfkLevel(s.afkLevel) >= 3
    },
    afk24: {
        id: 'afk24',
        category: 'afk',
        get name() { return t('prod_afk24_name'); },
        icon: '🕛',
        get badge() { return t('prod_afk24_badge'); },
        oneTime: true,
        get ownedLabel() { return t('iap_owned'); },
        get description() { return t('prod_afk24_desc'); },
        get perks() { return [t('prod_afk24_perk1')]; },
        get lockedLabel() { return t('prod_afk24_lockedlabel'); },
        grant: { afkLevel: 4, get headline() { return t('prod_afk_headline'); }, get lines() { return [t('prod_afk24_perk1')]; } },
        gemCost: 8000,
        isUnlocked: (s) => clampAfkLevel(s.afkLevel) >= 3,
        isOwned: (s) => clampAfkLevel(s.afkLevel) >= 4
    }
};

/* ---------------------------------------------------------------
   Shop state (persisted inside gameState.shopState)
   --------------------------------------------------------------- */

function createDefaultShopState() {
    return {
        isVIP: false,
        vipExpires: null,            // timestamp (ms) for timed VIP, null = permanent
        starterPackPurchased: false,
        isPremiumPassUnlocked: false, // Premium Expedition Pass ownership
        afkLevel: 0,                 // AFK limit tier (0=2h,1=4h,2=8h,3=16h,4=24h)
        frenzyPotions: 0,            // unused potions in inventory
        frenzyExpiresAt: null,       // timestamp (ms) when the active Frenzy ends, or null
        vipRuneSlotRune: null,       // rune parked when VIP lapses, restored if VIP returns
        adCounters: { vip: 0, pass: 0, afk: 0 },   // rewarded-ad progress, three SEPARATE counters (see AD_GOALS)
        potionAdsUsed: 0,            // Frenz Potion rewarded ads used in the current daily window
        potionAdsStamp: 0            // value of gameState.pass.lastDailyReset the counter belongs to (existing daily reset)
    };
}

/** Rewarded-ad goals for the permanent unlocks. Each unlock has its own counter in shopState.adCounters. */
const AD_GOALS = { vip: 25, pass: 25, afk: 15 };
const AD_POTION_DAILY_LIMIT = 3;
const AD_GEMS_MIN = 5;
const AD_GEMS_MAX = 15;

/** Validates the ad counters (always an object with three integers in 0..goal). */
function sanitizeAdCounters(src) {
    const out = {};
    Object.keys(AD_GOALS).forEach((k) => {
        const n = Math.floor(Number(src && src[k]));
        out[k] = Number.isFinite(n) ? Math.min(AD_GOALS[k], Math.max(0, n)) : 0;
    });
    return out;
}

/** Makes sure gameState.shopState exists with valid types. Safe to call often. */
function ensureShopState() {
    if (!gameState.shopState || typeof gameState.shopState !== 'object') {
        gameState.shopState = createDefaultShopState();
    }
    const s = gameState.shopState;
    const d = createDefaultShopState();
    delete s.noAds;                  // obsolete No Ads flag from old saves
    delete s.processedTransactions;  // obsolete receipt log from the removed payment simulation
    delete s.rewardedGemAds;         // obsolete ad counters from old saves
    delete s.rewardedGemsTotal;
    delete s.adProgress;
    s.isVIP = s.isVIP === true;
    s.vipExpires = Number.isFinite(s.vipExpires) ? s.vipExpires : null;
    s.starterPackPurchased = s.starterPackPurchased === true;
    s.isPremiumPassUnlocked = s.isPremiumPassUnlocked === true;
    s.afkLevel = clampAfkLevel(s.afkLevel);
    s.frenzyPotions = Math.max(0, Math.floor(Number(s.frenzyPotions) || 0));
    s.frenzyExpiresAt = Number.isFinite(s.frenzyExpiresAt) && s.frenzyExpiresAt > 0 ? s.frenzyExpiresAt : null;
    s.vipRuneSlotRune = typeof s.vipRuneSlotRune === 'string' ? s.vipRuneSlotRune : null;
    s.adCounters = sanitizeAdCounters(s.adCounters);
    s.potionAdsUsed = Math.min(AD_POTION_DAILY_LIMIT, Math.max(0, Math.floor(Number(s.potionAdsUsed) || 0)));
    s.potionAdsStamp = Number.isFinite(s.potionAdsStamp) && s.potionAdsStamp > 0 ? s.potionAdsStamp : 0;
    return s;
}

/** Loads shop state from the parsed save (older saves simply get safe defaults). */
function loadShopState(parsed) {
    let src = parsed && parsed.shopState && typeof parsed.shopState === 'object' ? parsed.shopState : null;
    if (!src) {
        try {
            const backup = GCStore.getItem('goldClickerShop');
            if (backup) src = JSON.parse(backup);
        } catch (e) { src = null; }
    }
    const s = createDefaultShopState();
    if (src && typeof src === 'object') {
        s.isVIP = src.isVIP === true;
        s.vipExpires = Number.isFinite(src.vipExpires) ? src.vipExpires : null;
        s.starterPackPurchased = src.starterPackPurchased === true;
        s.isPremiumPassUnlocked = src.isPremiumPassUnlocked === true;
        s.afkLevel = clampAfkLevel(src.afkLevel);   // missing in old saves -> 0 (2 hours)
        s.frenzyPotions = Math.max(0, Math.floor(Number(src.frenzyPotions) || 0));
        s.frenzyExpiresAt = Number.isFinite(src.frenzyExpiresAt) && src.frenzyExpiresAt > 0 ? src.frenzyExpiresAt : null;
        s.vipRuneSlotRune = typeof src.vipRuneSlotRune === 'string' ? src.vipRuneSlotRune : null;
        s.adCounters = sanitizeAdCounters(src.adCounters);   // old saves: all three start at 0
        s.potionAdsUsed = Math.min(AD_POTION_DAILY_LIMIT, Math.max(0, Math.floor(Number(src.potionAdsUsed) || 0)));
        s.potionAdsStamp = Number.isFinite(src.potionAdsStamp) && src.potionAdsStamp > 0 ? src.potionAdsStamp : 0;
    }
    gameState.shopState = s;
    syncAfkLimit();
    checkVipExpiry();
}

/* ---------------------------------------------------------------
   VIP
   --------------------------------------------------------------- */

/** True while VIP is owned and (if timed) not yet expired. */
function isVIPActive() {
    const s = gameState.shopState;
    if (!s || !s.isVIP) return false;
    return s.vipExpires == null || s.vipExpires > GCTime.now();
}

/** Clears an expired timed VIP. Returns true if VIP just lapsed. */
function checkVipExpiry() {
    const s = gameState.shopState;
    if (!s || !s.isVIP || s.vipExpires == null) return false;
    if (s.vipExpires > GCTime.now()) return false;
    s.isVIP = false;
    s.vipExpires = null;
    syncRuneSlotsToVIP();
    return true;
}

/**
 * Central multiplier for ALL gold income (manual clicks, passive, offline,
 * helpers...). Folded into getTotalMultiplier(). Add future multipliers
 * (events, VIP tiers...) here.
 */
function getGoldMultiplier() {
    let mult = 1;
    if (isVIPActive()) mult *= VIP_GOLD_MULTIPLIER;
    return mult;
}

/** Material/relic drop-chance multiplier from VIP (multiplicative: 10% -> 15%). */
function getVIPDropMultiplier() {
    return isVIPActive() ? VIP_DROP_CHANCE_MULTIPLIER : 1;
}

/** Total Rune slots available right now (base + VIP bonus). */
function getRuneSlotCount() {
    return BASE_RUNE_SLOTS + (isVIPActive() ? VIP_EXTRA_RUNE_SLOTS : 0);
}

/**
 * Resizes gameState.adventures.equippedRunes to getRuneSlotCount().
 * When VIP lapses, the rune in the removed slot is NOT deleted - it stays in
 * craftedRunes (just unequipped) and is remembered so it returns to the extra
 * slot automatically if VIP is reactivated.
 */
function syncRuneSlotsToVIP() {
    const a = gameState.adventures;
    if (!a || !Array.isArray(a.equippedRunes)) return;
    const s = ensureShopState();
    const want = getRuneSlotCount();

    while (a.equippedRunes.length < want) a.equippedRunes.push(null);
    if (a.equippedRunes.length > want) {
        const removed = a.equippedRunes.splice(want);
        const parked = removed.find((k) => typeof k === 'string');
        if (parked) s.vipRuneSlotRune = parked;
    }

    if (want > BASE_RUNE_SLOTS && s.vipRuneSlotRune) {
        const key = s.vipRuneSlotRune;
        const slot = want - 1;
        if (a.craftedRunes && a.craftedRunes[key] && !a.equippedRunes.includes(key) && a.equippedRunes[slot] === null) {
            a.equippedRunes[slot] = key;
        }
        s.vipRuneSlotRune = null;
    }
}

/* ---------------------------------------------------------------
   Frenzy Potions (x5 passive income for 60s, timestamp based)
   --------------------------------------------------------------- */

function isFrenzyActive() {
    const s = gameState.shopState;
    return !!(s && s.frenzyExpiresAt && s.frenzyExpiresAt > GCTime.now());
}

function getFrenzyRemainingMs() {
    return isFrenzyActive() ? gameState.shopState.frenzyExpiresAt - GCTime.now() : 0;
}

/** x5 while a Frenzy Potion is active, else 1. Never touches base CPS. */
function getFrenzyMultiplier() {
    return isFrenzyActive() ? FRENZY_POTION_MULTIPLIER : 1;
}

/** Multiplier applied to PASSIVE income only: all normal multipliers x Frenzy (x VIP via getTotalMultiplier). */
function getPassiveIncomeMultiplier() {
    return getTotalMultiplier() * getFrenzyMultiplier();
}

/**
 * Starts / extends the Frenzy effect by one potion duration (60 s). The single place that touches frenzyExpiresAt.
 * Active already -> the timer is EXTENDED, never a second multiplier (x5 never becomes x25).
 */
function startFrenzyEffect() {
    const s = ensureShopState();
    const now = GCTime.now();
    const base = isFrenzyActive() ? s.frenzyExpiresAt : now;
    s.frenzyExpiresAt = base + FRENZY_POTION_DURATION_MS;
}

/** Drinks one potion from the inventory. Drinking while active extends the timer (the x5 never stacks to x25). */
function activateFrenzyPotion() {
    const s = ensureShopState();
    if (s.frenzyPotions <= 0) return false;
    s.frenzyPotions -= 1;
    startFrenzyEffect();
    saveGame();
    updateUI();
    refreshIapShopState();
    return true;
}

/** True when the player owns the Premium Expedition Pass (single source of truth). */
function isPremiumPassUnlocked() {
    return !!(gameState.shopState && gameState.shopState.isPremiumPassUnlocked === true);
}

/** Same text lookup as t(), but falls back to English when a key is missing in i18n.js. */
function st(key, fallback, params) {
    try {
        const v = t(key, params);
        if (typeof v === 'string' && v && v !== key) return v;
    } catch (e) { /* ignore */ }
    return fallback;
}

/* ---------------------------------------------------------------
   CENTRAL PAUSE SYSTEM  (the one and only pause mechanism)
   pauseGame(reason) / resumeGame(reason): the game is paused while AT LEAST ONE reason is active.
   Reasons are independent, so an ad ('ad') can never un-pause a manual pause ('manual') and vice versa.
   While paused: gameLoop() ticks are skipped, mini-events neither spawn nor expire, timestamp-based timers
   (VIP / Frenzy / buffs / boss cooldowns) are pushed forward by the paused time when the pause ends, helper
   catch-up is reset and GCTime does not count the pause as active play time.
   --------------------------------------------------------------- */
const gamePause = { reasons: new Set(), startedMono: 0 };

function isGamePaused() { return gamePause.reasons.size > 0; }

/** Pushes every absolute-timestamp timer forward by `elapsed` ms (only timers that were running when the pause began). */
function shiftTimedStateBy(elapsed) {
    if (!(elapsed > 0)) return;
    const was = GCTime.now() - elapsed;   // "now" at the moment the paused window started
    const bump = (o, k) => { if (o && Number.isFinite(o[k]) && o[k] > was) o[k] += elapsed; };
    const s = gameState.shopState;
    if (s) {
        bump(s, 'frenzyExpiresAt');
        if (s.isVIP && s.vipExpires != null) bump(s, 'vipExpires');
    }
    bump(gameState.eventBuff, 'expiresAt');
    if (gameState.dailyLogin) bump(gameState.dailyLogin.activeBuff, 'expiresAt');
    const cd = gameState.bossCooldowns;
    if (cd && typeof cd === 'object') Object.keys(cd).forEach((id) => bump(cd, id));
    // Modules not shipped in this file (adventures.js / bosses.js) can shift their own timestamps here.
    try { window.dispatchEvent(new CustomEvent('gc:pause-shift', { detail: { elapsedMs: elapsed } })); } catch (e) { /* ignore */ }
}

/** Credits the time paused so far to timed state and restarts the measurement window (safe to call repeatedly). */
function settlePausedTime() {
    if (!isGamePaused()) return;
    const t = GCTime.mono();
    const elapsed = Math.max(0, t - gamePause.startedMono);
    gamePause.startedMono = t;
    try { shiftTimedStateBy(elapsed); } catch (e) { console.warn('Pause time shift failed:', e); }
}

function pauseGame(reason) {
    reason = reason || 'manual';
    if (gamePause.reasons.has(reason)) return false;      // duplicate pause: ignored
    const first = !isGamePaused();
    gamePause.reasons.add(reason);
    if (first) {
        gamePause.startedMono = GCTime.mono();
        try { GCTime.pauseActiveTime(); } catch (e) { /* ignore */ }
        try { window.dispatchEvent(new CustomEvent('gc:pause', { detail: { reason } })); } catch (e) { /* ignore */ }
    }
    return true;
}

function resumeGame(reason) {
    reason = reason || 'manual';
    if (!gamePause.reasons.has(reason)) return false;     // duplicate / unmatched resume: ignored
    settlePausedTime();                                   // account the time while this reason was still active
    gamePause.reasons.delete(reason);
    if (!isGamePaused()) {
        try { GCTime.resumeActiveTime(); } catch (e) { /* ignore */ }
        lastHelperTickAt = 0;                             // helpers must not "catch up" the paused time
        try { window.dispatchEvent(new CustomEvent('gc:resume', { detail: { reason } })); } catch (e) { /* ignore */ }
    }
    return true;
}
window.pauseGame = pauseGame;
window.resumeGame = resumeGame;
window.isGamePaused = isGamePaused;

/* ---------------------------------------------------------------
   Strings for the rewarded-ad features (self-contained, so no other file has to change).
   adT(key, params) uses the game's own t() when a key has been added to i18n.js for the current language, otherwise this
   table, otherwise English. To move them into i18n.js later, copy the keys and delete this table.
   --------------------------------------------------------------- */
const AD_STRINGS = {
    en: {
        ad_free_title: '📺 Free Rewards', ad_watch: 'Watch Ad', ad_loading: 'Loading ad…', ad_playing: 'Ad playing…', ad_busy: 'Ad in progress',
        ad_unavailable: 'Ads unavailable', ad_cooldown: 'Wait {s}s', ad_limit: 'Limit reached', ad_progress: '{n} / {goal} Ads',
        ad_vip_title: 'Free VIP', ad_vip_desc: 'Watch {goal} ads to unlock permanent VIP.',
        ad_pass_title: 'Free Premium Pass', ad_pass_desc: 'Watch {goal} ads to unlock the Dwarven Expedition Premium Pass.',
        ad_afk_title: 'Free 16h AFK Limit', ad_afk_desc: 'Watch {goal} ads to raise the offline limit to 16 hours.',
        ad_gems_title: 'Free Gems', ad_gems_desc: 'Watch an ad to earn {min}–{max} Gems. Repeatable.', ad_gems_last: 'Last reward: +{n} Gems',
        ad_potion_title: 'Frenz Potion', ad_potion_desc: 'Watch an ad: ×{mult} income for {sec}s.', ad_potion_active: 'Active: {time} left',
        ad_toast_gems: '+{n} Gems earned!', ad_toast_progress: 'Ad counted: {n} / {goal}', ad_toast_unlocked: 'Unlocked: {name}!',
        ad_toast_potion: 'Frenz Potion active! ×{mult} for {sec}s', ad_toast_nofill: 'No ad available right now. No reward given.',
        ad_toast_error: 'The ad could not be completed. No reward given.', ad_toast_unavail: 'Ads are unavailable right now.',
        ad_toast_owned: 'Already unlocked.', ad_toast_limit: 'Daily limit reached. Try again later.', ad_toast_cooldown: 'Please wait {s}s before the next ad.',
        ad_shield: 'Advertisement…'
    },
    de: {
        ad_free_title: '📺 Gratis-Belohnungen', ad_watch: 'Werbung ansehen', ad_loading: 'Werbung lädt…', ad_playing: 'Werbung läuft…', ad_busy: 'Werbung läuft',
        ad_unavailable: 'Werbung nicht verfügbar', ad_cooldown: 'Warte {s}s', ad_limit: 'Limit erreicht', ad_progress: '{n} / {goal} Werbungen',
        ad_vip_title: 'Gratis-VIP', ad_vip_desc: 'Sieh {goal} Werbungen an, um dauerhaft VIP freizuschalten.',
        ad_pass_title: 'Gratis Premium-Pass', ad_pass_desc: 'Sieh {goal} Werbungen an, um den Premium-Pass der Zwergenexpedition freizuschalten.',
        ad_afk_title: 'Gratis 16h AFK-Limit', ad_afk_desc: 'Sieh {goal} Werbungen an, um das Offline-Limit auf 16 Stunden zu erhöhen.',
        ad_gems_title: 'Gratis-Edelsteine', ad_gems_desc: 'Sieh eine Werbung an und erhalte {min}–{max} Edelsteine. Wiederholbar.', ad_gems_last: 'Letzte Belohnung: +{n} Edelsteine',
        ad_potion_title: 'Frenz-Trank', ad_potion_desc: 'Sieh eine Werbung an: ×{mult} Einkommen für {sec}s.', ad_potion_active: 'Aktiv: noch {time}',
        ad_toast_gems: '+{n} Edelsteine erhalten!', ad_toast_progress: 'Werbung gezählt: {n} / {goal}', ad_toast_unlocked: 'Freigeschaltet: {name}!',
        ad_toast_potion: 'Frenz-Trank aktiv! ×{mult} für {sec}s', ad_toast_nofill: 'Gerade keine Werbung verfügbar. Keine Belohnung.',
        ad_toast_error: 'Die Werbung konnte nicht abgeschlossen werden. Keine Belohnung.', ad_toast_unavail: 'Werbung ist gerade nicht verfügbar.',
        ad_toast_owned: 'Bereits freigeschaltet.', ad_toast_limit: 'Tageslimit erreicht. Versuche es später erneut.', ad_toast_cooldown: 'Bitte warte {s}s bis zur nächsten Werbung.',
        ad_shield: 'Werbung…'
    },
    es: {
        ad_free_title: '📺 Recompensas gratis', ad_watch: 'Ver anuncio', ad_loading: 'Cargando anuncio…', ad_playing: 'Anuncio en curso…', ad_busy: 'Anuncio en curso',
        ad_unavailable: 'Anuncios no disponibles', ad_cooldown: 'Espera {s}s', ad_limit: 'Límite alcanzado', ad_progress: '{n} / {goal} anuncios',
        ad_vip_title: 'VIP gratis', ad_vip_desc: 'Mira {goal} anuncios para desbloquear VIP permanente.',
        ad_pass_title: 'Pase Premium gratis', ad_pass_desc: 'Mira {goal} anuncios para desbloquear el Pase Premium de la Expedición Enana.',
        ad_afk_title: 'Límite AFK de 16h gratis', ad_afk_desc: 'Mira {goal} anuncios para subir el límite sin conexión a 16 horas.',
        ad_gems_title: 'Gemas gratis', ad_gems_desc: 'Mira un anuncio y gana {min}–{max} gemas. Repetible.', ad_gems_last: 'Última recompensa: +{n} gemas',
        ad_potion_title: 'Poción Frenz', ad_potion_desc: 'Mira un anuncio: ingresos ×{mult} durante {sec}s.', ad_potion_active: 'Activa: quedan {time}',
        ad_toast_gems: '¡+{n} gemas obtenidas!', ad_toast_progress: 'Anuncio contado: {n} / {goal}', ad_toast_unlocked: '¡Desbloqueado: {name}!',
        ad_toast_potion: '¡Poción Frenz activa! ×{mult} durante {sec}s', ad_toast_nofill: 'No hay anuncios disponibles ahora. Sin recompensa.',
        ad_toast_error: 'No se pudo completar el anuncio. Sin recompensa.', ad_toast_unavail: 'Los anuncios no están disponibles ahora.',
        ad_toast_owned: 'Ya desbloqueado.', ad_toast_limit: 'Límite diario alcanzado. Inténtalo más tarde.', ad_toast_cooldown: 'Espera {s}s antes del siguiente anuncio.',
        ad_shield: 'Anuncio…'
    },
    fr: {
        ad_free_title: '📺 Récompenses gratuites', ad_watch: 'Voir la pub', ad_loading: 'Chargement de la pub…', ad_playing: 'Pub en cours…', ad_busy: 'Pub en cours',
        ad_unavailable: 'Pubs indisponibles', ad_cooldown: 'Attendez {s}s', ad_limit: 'Limite atteinte', ad_progress: '{n} / {goal} pubs',
        ad_vip_title: 'VIP gratuit', ad_vip_desc: 'Regardez {goal} pubs pour débloquer le VIP permanent.',
        ad_pass_title: 'Pass Premium gratuit', ad_pass_desc: 'Regardez {goal} pubs pour débloquer le Pass Premium de l’Expédition naine.',
        ad_afk_title: 'Limite AFK de 16h gratuite', ad_afk_desc: 'Regardez {goal} pubs pour porter la limite hors ligne à 16 heures.',
        ad_gems_title: 'Gemmes gratuites', ad_gems_desc: 'Regardez une pub pour gagner {min}–{max} gemmes. Répétable.', ad_gems_last: 'Dernière récompense : +{n} gemmes',
        ad_potion_title: 'Potion Frenz', ad_potion_desc: 'Regardez une pub : revenus ×{mult} pendant {sec}s.', ad_potion_active: 'Active : {time} restantes',
        ad_toast_gems: '+{n} gemmes gagnées !', ad_toast_progress: 'Pub comptée : {n} / {goal}', ad_toast_unlocked: 'Débloqué : {name} !',
        ad_toast_potion: 'Potion Frenz active ! ×{mult} pendant {sec}s', ad_toast_nofill: 'Aucune pub disponible pour le moment. Pas de récompense.',
        ad_toast_error: 'La pub n’a pas pu être terminée. Pas de récompense.', ad_toast_unavail: 'Les pubs sont indisponibles pour le moment.',
        ad_toast_owned: 'Déjà débloqué.', ad_toast_limit: 'Limite quotidienne atteinte. Réessayez plus tard.', ad_toast_cooldown: 'Attendez {s}s avant la prochaine pub.',
        ad_shield: 'Publicité…'
    },
    pt: {
        ad_free_title: '📺 Recompensas grátis', ad_watch: 'Ver anúncio', ad_loading: 'Carregando anúncio…', ad_playing: 'Anúncio em andamento…', ad_busy: 'Anúncio em andamento',
        ad_unavailable: 'Anúncios indisponíveis', ad_cooldown: 'Aguarde {s}s', ad_limit: 'Limite atingido', ad_progress: '{n} / {goal} anúncios',
        ad_vip_title: 'VIP grátis', ad_vip_desc: 'Assista a {goal} anúncios para desbloquear o VIP permanente.',
        ad_pass_title: 'Passe Premium grátis', ad_pass_desc: 'Assista a {goal} anúncios para desbloquear o Passe Premium da Expedição Anã.',
        ad_afk_title: 'Limite AFK de 16h grátis', ad_afk_desc: 'Assista a {goal} anúncios para aumentar o limite offline para 16 horas.',
        ad_gems_title: 'Gemas grátis', ad_gems_desc: 'Assista a um anúncio e ganhe {min}–{max} gemas. Repetível.', ad_gems_last: 'Última recompensa: +{n} gemas',
        ad_potion_title: 'Poção Frenz', ad_potion_desc: 'Assista a um anúncio: renda ×{mult} por {sec}s.', ad_potion_active: 'Ativa: restam {time}',
        ad_toast_gems: '+{n} gemas ganhas!', ad_toast_progress: 'Anúncio contado: {n} / {goal}', ad_toast_unlocked: 'Desbloqueado: {name}!',
        ad_toast_potion: 'Poção Frenz ativa! ×{mult} por {sec}s', ad_toast_nofill: 'Nenhum anúncio disponível agora. Sem recompensa.',
        ad_toast_error: 'Não foi possível concluir o anúncio. Sem recompensa.', ad_toast_unavail: 'Os anúncios não estão disponíveis agora.',
        ad_toast_owned: 'Já desbloqueado.', ad_toast_limit: 'Limite diário atingido. Tente novamente mais tarde.', ad_toast_cooldown: 'Aguarde {s}s antes do próximo anúncio.',
        ad_shield: 'Anúncio…'
    },
    ru: {
        ad_free_title: '📺 Бесплатные награды', ad_watch: 'Смотреть рекламу', ad_loading: 'Загрузка рекламы…', ad_playing: 'Идёт реклама…', ad_busy: 'Идёт реклама',
        ad_unavailable: 'Реклама недоступна', ad_cooldown: 'Подождите {s}с', ad_limit: 'Лимит исчерпан', ad_progress: '{n} / {goal} реклам',
        ad_vip_title: 'Бесплатный VIP', ad_vip_desc: 'Посмотрите {goal} реклам, чтобы навсегда открыть VIP.',
        ad_pass_title: 'Бесплатный Премиум-пропуск', ad_pass_desc: 'Посмотрите {goal} реклам, чтобы открыть Премиум-пропуск гномьей экспедиции.',
        ad_afk_title: 'Бесплатный AFK-лимит 16 ч', ad_afk_desc: 'Посмотрите {goal} реклам, чтобы поднять офлайн-лимит до 16 часов.',
        ad_gems_title: 'Бесплатные самоцветы', ad_gems_desc: 'Посмотрите рекламу и получите {min}–{max} самоцветов. Можно повторять.', ad_gems_last: 'Последняя награда: +{n} самоцветов',
        ad_potion_title: 'Зелье Френц', ad_potion_desc: 'Посмотрите рекламу: доход ×{mult} на {sec} с.', ad_potion_active: 'Действует: осталось {time}',
        ad_toast_gems: '+{n} самоцветов получено!', ad_toast_progress: 'Реклама засчитана: {n} / {goal}', ad_toast_unlocked: 'Открыто: {name}!',
        ad_toast_potion: 'Зелье Френц активно! ×{mult} на {sec} с', ad_toast_nofill: 'Сейчас нет доступной рекламы. Награда не выдана.',
        ad_toast_error: 'Рекламу не удалось завершить. Награда не выдана.', ad_toast_unavail: 'Реклама сейчас недоступна.',
        ad_toast_owned: 'Уже открыто.', ad_toast_limit: 'Дневной лимит исчерпан. Попробуйте позже.', ad_toast_cooldown: 'Подождите {s} с до следующей рекламы.',
        ad_shield: 'Реклама…'
    },
    tr: {
        ad_free_title: '📺 Ücretsiz Ödüller', ad_watch: 'Reklam İzle', ad_loading: 'Reklam yükleniyor…', ad_playing: 'Reklam oynuyor…', ad_busy: 'Reklam sürüyor',
        ad_unavailable: 'Reklam yok', ad_cooldown: '{s}sn bekle', ad_limit: 'Limite ulaşıldı', ad_progress: '{n} / {goal} Reklam',
        ad_vip_title: 'Ücretsiz VIP', ad_vip_desc: 'Kalıcı VIP için {goal} reklam izle.',
        ad_pass_title: 'Ücretsiz Premium Geçiş', ad_pass_desc: 'Cüce Keşif Premium Geçişi için {goal} reklam izle.',
        ad_afk_title: 'Ücretsiz 16sa AFK Limiti', ad_afk_desc: 'Çevrimdışı limiti 16 saate çıkarmak için {goal} reklam izle.',
        ad_gems_title: 'Ücretsiz Mücevher', ad_gems_desc: 'Bir reklam izle, {min}–{max} Mücevher kazan. Tekrarlanabilir.', ad_gems_last: 'Son ödül: +{n} Mücevher',
        ad_potion_title: 'Frenz İksiri', ad_potion_desc: 'Bir reklam izle: {sec}sn boyunca ×{mult} gelir.', ad_potion_active: 'Aktif: {time} kaldı',
        ad_toast_gems: '+{n} Mücevher kazandın!', ad_toast_progress: 'Reklam sayıldı: {n} / {goal}', ad_toast_unlocked: 'Açıldı: {name}!',
        ad_toast_potion: 'Frenz İksiri aktif! {sec}sn boyunca ×{mult}', ad_toast_nofill: 'Şu an reklam yok. Ödül verilmedi.',
        ad_toast_error: 'Reklam tamamlanamadı. Ödül verilmedi.', ad_toast_unavail: 'Reklamlar şu an kullanılamıyor.',
        ad_toast_owned: 'Zaten açık.', ad_toast_limit: 'Günlük limite ulaşıldı. Daha sonra tekrar dene.', ad_toast_cooldown: 'Sonraki reklam için {s}sn bekle.',
        ad_shield: 'Reklam…'
    },
    it: {
        ad_free_title: '📺 Ricompense gratuite', ad_watch: 'Guarda annuncio', ad_loading: 'Caricamento annuncio…', ad_playing: 'Annuncio in corso…', ad_busy: 'Annuncio in corso',
        ad_unavailable: 'Annunci non disponibili', ad_cooldown: 'Attendi {s}s', ad_limit: 'Limite raggiunto', ad_progress: '{n} / {goal} annunci',
        ad_vip_title: 'VIP gratis', ad_vip_desc: 'Guarda {goal} annunci per sbloccare il VIP permanente.',
        ad_pass_title: 'Pass Premium gratis', ad_pass_desc: 'Guarda {goal} annunci per sbloccare il Pass Premium della Spedizione Nanica.',
        ad_afk_title: 'Limite AFK di 16h gratis', ad_afk_desc: 'Guarda {goal} annunci per portare il limite offline a 16 ore.',
        ad_gems_title: 'Gemme gratis', ad_gems_desc: 'Guarda un annuncio e ottieni {min}–{max} gemme. Ripetibile.', ad_gems_last: 'Ultima ricompensa: +{n} gemme',
        ad_potion_title: 'Pozione Frenz', ad_potion_desc: 'Guarda un annuncio: guadagni ×{mult} per {sec}s.', ad_potion_active: 'Attiva: restano {time}',
        ad_toast_gems: '+{n} gemme ottenute!', ad_toast_progress: 'Annuncio conteggiato: {n} / {goal}', ad_toast_unlocked: 'Sbloccato: {name}!',
        ad_toast_potion: 'Pozione Frenz attiva! ×{mult} per {sec}s', ad_toast_nofill: 'Nessun annuncio disponibile ora. Nessuna ricompensa.',
        ad_toast_error: 'Impossibile completare l’annuncio. Nessuna ricompensa.', ad_toast_unavail: 'Gli annunci non sono disponibili ora.',
        ad_toast_owned: 'Già sbloccato.', ad_toast_limit: 'Limite giornaliero raggiunto. Riprova più tardi.', ad_toast_cooldown: 'Attendi {s}s prima del prossimo annuncio.',
        ad_shield: 'Pubblicità…'
    },
    pl: {
        ad_free_title: '📺 Darmowe nagrody', ad_watch: 'Obejrzyj reklamę', ad_loading: 'Ładowanie reklamy…', ad_playing: 'Trwa reklama…', ad_busy: 'Trwa reklama',
        ad_unavailable: 'Reklamy niedostępne', ad_cooldown: 'Poczekaj {s}s', ad_limit: 'Osiągnięto limit', ad_progress: '{n} / {goal} reklam',
        ad_vip_title: 'Darmowe VIP', ad_vip_desc: 'Obejrzyj {goal} reklam, aby odblokować stałe VIP.',
        ad_pass_title: 'Darmowa Przepustka Premium', ad_pass_desc: 'Obejrzyj {goal} reklam, aby odblokować Przepustkę Premium Krasnoludzkiej Wyprawy.',
        ad_afk_title: 'Darmowy limit AFK 16 h', ad_afk_desc: 'Obejrzyj {goal} reklam, aby zwiększyć limit offline do 16 godzin.',
        ad_gems_title: 'Darmowe klejnoty', ad_gems_desc: 'Obejrzyj reklamę i zdobądź {min}–{max} klejnotów. Można powtarzać.', ad_gems_last: 'Ostatnia nagroda: +{n} klejnotów',
        ad_potion_title: 'Eliksir Frenz', ad_potion_desc: 'Obejrzyj reklamę: dochód ×{mult} przez {sec}s.', ad_potion_active: 'Aktywny: zostało {time}',
        ad_toast_gems: '+{n} klejnotów zdobyte!', ad_toast_progress: 'Reklama zaliczona: {n} / {goal}', ad_toast_unlocked: 'Odblokowano: {name}!',
        ad_toast_potion: 'Eliksir Frenz aktywny! ×{mult} przez {sec}s', ad_toast_nofill: 'Brak dostępnej reklamy. Nagroda nie została przyznana.',
        ad_toast_error: 'Nie udało się ukończyć reklamy. Nagroda nie została przyznana.', ad_toast_unavail: 'Reklamy są teraz niedostępne.',
        ad_toast_owned: 'Już odblokowano.', ad_toast_limit: 'Osiągnięto dzienny limit. Spróbuj później.', ad_toast_cooldown: 'Poczekaj {s}s do następnej reklamy.',
        ad_shield: 'Reklama…'
    },
    ja: {
        ad_free_title: '📺 無料報酬', ad_watch: '広告を見る', ad_loading: '広告を読み込み中…', ad_playing: '広告再生中…', ad_busy: '広告再生中',
        ad_unavailable: '広告を利用できません', ad_cooldown: '{s}秒待機', ad_limit: '上限に達しました', ad_progress: '{n} / {goal} 回',
        ad_vip_title: '無料VIP', ad_vip_desc: '広告を{goal}回見ると、VIPが永久に解放されます。',
        ad_pass_title: '無料プレミアムパス', ad_pass_desc: '広告を{goal}回見ると、ドワーフ探検プレミアムパスが解放されます。',
        ad_afk_title: '無料16時間AFK上限', ad_afk_desc: '広告を{goal}回見ると、オフライン上限が16時間になります。',
        ad_gems_title: '無料ジェム', ad_gems_desc: '広告を見て{min}～{max}ジェムを獲得。何度でも可能。', ad_gems_last: '前回の報酬: +{n}ジェム',
        ad_potion_title: 'フレンツポーション', ad_potion_desc: '広告を見ると{sec}秒間 収入×{mult}。', ad_potion_active: '効果中: 残り{time}',
        ad_toast_gems: '+{n}ジェムを獲得！', ad_toast_progress: '広告をカウント: {n} / {goal}', ad_toast_unlocked: '解放: {name}！',
        ad_toast_potion: 'フレンツポーション発動！{sec}秒間 ×{mult}', ad_toast_nofill: '現在表示できる広告がありません。報酬はありません。',
        ad_toast_error: '広告を完了できませんでした。報酬はありません。', ad_toast_unavail: '現在、広告を利用できません。',
        ad_toast_owned: 'すでに解放済みです。', ad_toast_limit: '1日の上限に達しました。後でもう一度お試しください。', ad_toast_cooldown: '次の広告まで{s}秒お待ちください。',
        ad_shield: '広告…'
    },
    ko: {
        ad_free_title: '📺 무료 보상', ad_watch: '광고 보기', ad_loading: '광고 불러오는 중…', ad_playing: '광고 재생 중…', ad_busy: '광고 진행 중',
        ad_unavailable: '광고를 사용할 수 없음', ad_cooldown: '{s}초 대기', ad_limit: '한도 도달', ad_progress: '{n} / {goal}회',
        ad_vip_title: '무료 VIP', ad_vip_desc: '광고를 {goal}회 시청하면 VIP가 영구 해제됩니다.',
        ad_pass_title: '무료 프리미엄 패스', ad_pass_desc: '광고를 {goal}회 시청하면 드워프 원정 프리미엄 패스가 해제됩니다.',
        ad_afk_title: '무료 16시간 AFK 한도', ad_afk_desc: '광고를 {goal}회 시청하면 오프라인 한도가 16시간으로 늘어납니다.',
        ad_gems_title: '무료 보석', ad_gems_desc: '광고를 보고 보석 {min}~{max}개를 받으세요. 반복 가능.', ad_gems_last: '마지막 보상: 보석 +{n}',
        ad_potion_title: '프렌즈 물약', ad_potion_desc: '광고 시청 시 {sec}초 동안 수입 ×{mult}.', ad_potion_active: '활성: {time} 남음',
        ad_toast_gems: '보석 +{n} 획득!', ad_toast_progress: '광고 집계: {n} / {goal}', ad_toast_unlocked: '해제됨: {name}!',
        ad_toast_potion: '프렌즈 물약 활성화! {sec}초 동안 ×{mult}', ad_toast_nofill: '지금은 표시할 광고가 없습니다. 보상이 지급되지 않았습니다.',
        ad_toast_error: '광고를 완료하지 못했습니다. 보상이 지급되지 않았습니다.', ad_toast_unavail: '지금은 광고를 사용할 수 없습니다.',
        ad_toast_owned: '이미 해제되었습니다.', ad_toast_limit: '일일 한도에 도달했습니다. 나중에 다시 시도하세요.', ad_toast_cooldown: '다음 광고까지 {s}초 기다려 주세요.',
        ad_shield: '광고…'
    },
    zh: {
        ad_free_title: '📺 免费奖励', ad_watch: '观看广告', ad_loading: '广告加载中…', ad_playing: '广告播放中…', ad_busy: '广告进行中',
        ad_unavailable: '暂无广告', ad_cooldown: '请等待{s}秒', ad_limit: '已达上限', ad_progress: '{n} / {goal} 次广告',
        ad_vip_title: '免费VIP', ad_vip_desc: '观看{goal}次广告，永久解锁VIP。',
        ad_pass_title: '免费高级通行证', ad_pass_desc: '观看{goal}次广告，解锁矮人远征高级通行证。',
        ad_afk_title: '免费16小时挂机上限', ad_afk_desc: '观看{goal}次广告，将离线上限提升至16小时。',
        ad_gems_title: '免费宝石', ad_gems_desc: '观看一次广告，获得{min}–{max}颗宝石。可重复。', ad_gems_last: '上次奖励：+{n}颗宝石',
        ad_potion_title: '狂热药水', ad_potion_desc: '观看广告：{sec}秒内收入×{mult}。', ad_potion_active: '生效中：剩余{time}',
        ad_toast_gems: '获得 +{n} 颗宝石！', ad_toast_progress: '广告已计数：{n} / {goal}', ad_toast_unlocked: '已解锁：{name}！',
        ad_toast_potion: '狂热药水已生效！{sec}秒内×{mult}', ad_toast_nofill: '目前没有可用广告，未发放奖励。',
        ad_toast_error: '广告未能完成，未发放奖励。', ad_toast_unavail: '目前无法使用广告。',
        ad_toast_owned: '已解锁。', ad_toast_limit: '已达每日上限，请稍后再试。', ad_toast_cooldown: '请等待{s}秒后再观看下一个广告。',
        ad_shield: '广告…'
    }
};

/** Localized ad-feature text. Order: i18n.js (if the key exists there) -> this table for the current language -> English -> key. */
function adT(key, params) {
    let lang = 'en';
    try { lang = String(getLanguage() || 'en').toLowerCase(); } catch (e) { /* ignore */ }
    const base = lang.slice(0, 2);
    try {
        const tr = window.TRANSLATIONS && window.TRANSLATIONS[lang];
        if (tr && Object.prototype.hasOwnProperty.call(tr, key)) { const v = t(key, params); if (typeof v === 'string' && v && v !== key) return v; }
    } catch (e) { /* fall through to the local table */ }
    const table = AD_STRINGS[lang] || AD_STRINGS[base] || AD_STRINGS.en;
    let str = (table && table[key]) || AD_STRINGS.en[key] || key;
    if (params && typeof params === 'object') {
        str = str.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m));
    }
    return str;
}

/* =====================================================================================================================
   POKI SDK + ADVERTISEMENT SESSION MANAGER  (GCAds)

   Verified against the official Poki HTML5 SDK docs (https://sdk.poki.com/html5.html):
     PokiSDK.init()                          -> Promise (resolve = ready, reject = "something went wrong, load the game anyway")
     PokiSDK.gameLoadingFinished()           once loading is done
     PokiSDK.gameplayStart() / gameplayStop  while the player is / is not actually playing
     PokiSDK.commercialBreak(beforeAd?)      -> Promise. NOT every call shows an ad; beforeAd may never be called.
     PokiSDK.rewardedBreak(beforeAd | { size, onStart }) -> Promise<boolean>. true = the video was shown -> reward; false = never reward.
   There are NO "commercialingStart" / "commercialingEnd" events in the SDK. Those do not exist, so this wrapper builds the
   start/end of an ad session itself from the documented call -> promise lifecycle:
        begin session (pause 'ad' + mute + input lock)  ->  PokiSDK.xxxBreak()  ->  promise settles  ->  end session.

   Guarantees
     - one ad session at a time (a second request while one is running is refused, never queued);
     - rewards are only ever granted when rewardedBreak() resolved with exactly `true` while its session was still live;
     - the pause uses the EXISTING reason-based pauseGame('ad') / resumeGame('ad'), so a manual pause is never undone by an ad,
       timestamp timers (buffs / VIP / cooldowns) are shifted by the paused time and GCTime does not count it as play time;
     - audio is muted through the master bus only (adAudioMuted) - gameState.volume / soundEnabled are never touched, so the
       player's own settings come back exactly as they were;
     - a watchdog releases the lock if the SDK promise never settles; a late answer after that is ignored (no reward).
   ===================================================================================================================== */
const GCAds = (function () {
    'use strict';

    const WATCHDOG_MS = 3 * 60 * 1000;            // safety net only: an SDK promise that never settles must not lock the game forever
    const LOADING_WATCHDOG_MS = 45 * 1000;        // if the SDK has not even started an ad (onStart never fired) after this long, release the input lock
    const SHIELD_Z = 100000;                      // above every game layer, deliberately far below the SDK's own ad layers
    const COMMERCIAL_MIN_GAP_MS = 60 * 1000;      // our own floor between commercialBreak() calls (Poki decides whether an ad is shown)
    const REWARDED_MIN_INTERVAL_MS = 5 * 1000;    // minimum gap between two rewarded requests (accidental double taps)

    let sdkState = 'pending';        // 'pending' | 'ready' | 'failed' | 'missing'
    let session = null;              // { id, type: 'commercial' | 'rewarded', kind, phase: 'loading' | 'playing', timer, loadTimer, settle, domSnap }
    let seq = 0;
    let lastRewardedEndMono = -Infinity;
    let lastCommercialMono = -Infinity;
    let gameplayArmed = false;       // PokiSDK.gameplayStart() is only allowed after the first real player interaction
    let gameplayOn = false;
    let booted = false;

    function mono() { try { return GCTime.mono(); } catch (e) { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); } }
    function emit() { try { window.dispatchEvent(new CustomEvent('gc:ads-state')); } catch (e) { /* ignore */ } }
    function sdk() { return (typeof window.PokiSDK !== 'undefined' && window.PokiSDK) ? window.PokiSDK : null; }

    /* ---------------- gameplayStart / gameplayStop (Poki metrics) ---------------- */
    function syncGameplay() {
        if (sdkState !== 'ready') return;
        let want = false;
        try { want = gameplayArmed && !document.hidden && !isGamePaused(); } catch (e) { want = false; }
        if (want === gameplayOn) return;
        gameplayOn = want;
        try { if (want) sdk().gameplayStart(); else sdk().gameplayStop(); } catch (e) { /* never break the game for a metrics call */ }
    }

    /* ---------------- session lifecycle ---------------- */
    function removeShield() {
        try {
            // Remove EVERY element with our id (never leave a stray duplicate behind).
            document.querySelectorAll('#gc-ad-shield').forEach((el) => {
                el.style.pointerEvents = 'none';            // even if removal were somehow delayed, it can no longer eat input
                if (el.parentNode) el.parentNode.removeChild(el);
            });
        } catch (e) { /* ignore */ }
    }

    function setShield(on) {
        try {
            if (!on) { removeShield(); return null; }
            const old = document.getElementById('gc-ad-shield');
            if (old) return old;
            const el = document.createElement('div');
            el.id = 'gc-ad-shield';
            el.setAttribute('aria-hidden', 'true');
            // Application-owned input blocker, present ONLY while an ad session is active (clicks / taps cannot reach the game).
            // z-index is high enough to cover the game but is NOT near the 32-bit maximum, so SDK-created ad layers (which the SDK
            // stacks itself) are never underneath it and keep their own input handling.
            el.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:' + SHIELD_Z + ';background:rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;' +
                'color:#fff;font:600 16px/1.2 system-ui,sans-serif;touch-action:none;user-select:none;cursor:wait;pointer-events:auto;';
            el.textContent = adT('ad_shield');
            ['pointerdown', 'pointerup', 'click', 'touchstart', 'touchend', 'contextmenu', 'wheel'].forEach((ev) => {
                el.addEventListener(ev, (e) => { e.stopPropagation(); if (e.cancelable) e.preventDefault(); }, { passive: false });
            });
            (document.body || document.documentElement).appendChild(el);
            return el;
        } catch (e) { return null; }
    }

    /** Self-heal: a shield with no live session is a bug by definition - remove it. Cheap and idempotent. */
    function sweepOrphanShield() {
        if (session) return false;
        try {
            if (document.getElementById('gc-ad-shield')) { removeShield(); console.warn('[GCAds] removed an orphaned ad shield'); return true; }
        } catch (e) { /* ignore */ }
        return false;
    }

    /* Inline styles on <html>/<body> that would freeze the page. Snapshot before the SDK call; after the session, only a *blocking*
       value that appeared during the session (and was not there before) is reverted. Nothing SDK-internal is touched. */
    const GUARDED_PROPS = [['overflow', 'hidden'], ['overflowY', 'hidden'], ['pointerEvents', 'none'], ['touchAction', 'none']];
    function snapshotDom() {
        const snap = [];
        try {
            [document.documentElement, document.body].forEach((el) => {
                if (!el) return;
                const vals = {};
                GUARDED_PROPS.forEach(([prop]) => { vals[prop] = el.style[prop]; });
                snap.push({ el, vals });
            });
        } catch (e) { /* ignore */ }
        return snap;
    }
    function restoreDom(snap) {
        if (!snap) return;
        try {
            snap.forEach(({ el, vals }) => {
                GUARDED_PROPS.forEach(([prop, blocking]) => {
                    if (el.style[prop] === blocking && vals[prop] !== blocking) el.style[prop] = vals[prop];
                });
            });
        } catch (e) { /* ignore */ }
    }

    function setAdMute(on) {
        adAudioMuted = !!on;
        try { applyMasterVolume(); } catch (e) { /* ignore */ }
        try { bgmSync(); } catch (e) { /* ignore */ }
    }

    /** Starts a session (pause + mute + input lock). Returns null when another session is already running. */
    function begin(type, kind) {
        if (session) return null;
        const id = ++seq;
        session = { id, type, kind: kind || '', phase: 'loading', timer: null, loadTimer: null, settle: null, domSnap: snapshotDom() };
        try { pauseGame('ad'); } catch (e) { console.warn('pauseGame(ad) failed:', e); }
        setAdMute(true);
        setShield(true);
        emit();
        return session;
    }

    /** Ends the session identified by `s`. Idempotent: a stale / duplicate call changes nothing and returns false. */
    function end(s) {
        if (!s || !session || session.id !== s.id) return false;
        clearTimeout(session.timer);
        clearTimeout(session.loadTimer);
        const snap = session.domSnap;
        session = null;
        setShield(false);
        restoreDom(snap);
        setAdMute(false);                               // restores whatever the player's own volume / mute settings are
        try { resumeGame('ad'); } catch (e) { console.warn('resumeGame(ad) failed:', e); }   // removes ONLY the 'ad' reason
        try { bgmSync(); } catch (e) { /* ignore */ }
        emit();
        return true;
    }

    /** Builds the promise wrapper shared by both break types. `start(onStart)` must call the SDK and return its promise. */
    function run(type, kind, start) {
        return new Promise((resolve) => {
            const s = begin(type, kind);
            if (!s) { resolve({ status: 'busy' }); return; }
            let done = false;
            const settle = (status) => {
                if (done) return;                       // duplicate callbacks / late promise answers are ignored
                done = true;
                end(s);
                resolve({ status });
            };
            s.settle = settle;
            s.timer = setTimeout(() => { console.warn('[GCAds] ad session timed out; released without reward'); settle('error'); }, WATCHDOG_MS);
            s.loadTimer = setTimeout(() => {
                if (session && session.id === s.id && session.phase === 'loading') { console.warn('[GCAds] SDK never started the ad; input lock released without reward'); settle('error'); }
            }, LOADING_WATCHDOG_MS);
            const onStart = () => { if (!done && session && session.id === s.id) { session.phase = 'playing'; clearTimeout(session.loadTimer); emit(); } };
            try {
                Promise.resolve(start(onStart)).then(
                    (value) => settle(type === 'rewarded' ? (value === true ? 'rewarded' : 'not-rewarded') : 'done'),
                    () => settle('error')
                );
            } catch (e) {
                console.warn('[GCAds] SDK call threw:', e);
                settle('error');
            }
        });
    }

    /* ---------------- public API ---------------- */
    function isAvailable() {
        const p = sdk();
        return sdkState === 'ready' && !!p && typeof p.rewardedBreak === 'function';
    }
    function isBusy() { return !!session; }
    function getSession() { return session ? { type: session.type, kind: session.kind, phase: session.phase } : null; }
    function getState() { return sdkState; }
    function cooldownLeftMs() { return Math.max(0, REWARDED_MIN_INTERVAL_MS - (mono() - lastRewardedEndMono)); }

    /**
     * Requests a rewarded ad. Resolves (never rejects) with { status }:
     *   'rewarded'      the SDK confirmed the video was shown            -> caller may grant the reward (exactly once)
     *   'not-rewarded'  SDK resolved false (no fill / blocked / skipped)  -> never grant
     *   'error'         SDK threw / rejected / timed out                  -> never grant
     *   'unavailable' | 'busy' | 'cooldown'  nothing was requested
     */
    function requestRewarded(kind, size) {
        if (session) return Promise.resolve({ status: 'busy' });
        if (!isAvailable()) return Promise.resolve({ status: 'unavailable' });
        const wait = cooldownLeftMs();
        if (wait > 0) return Promise.resolve({ status: 'cooldown', waitMs: wait });
        return run('rewarded', kind, (onStart) => sdk().rewardedBreak({ size: size || 'small', onStart })).then((res) => {
            lastRewardedEndMono = mono();
            emit();
            return res;
        });
    }

    /** Natural-break video ad (Poki decides whether one is actually shown). Resolves true when the SDK call completed. */
    function commercialBreak(reason) {
        const p = sdk();
        if (session || sdkState !== 'ready' || !p || typeof p.commercialBreak !== 'function') return Promise.resolve(false);
        if (mono() - lastCommercialMono < COMMERCIAL_MIN_GAP_MS) return Promise.resolve(false);
        lastCommercialMono = mono();
        return run('commercial', reason || 'break', (onStart) => p.commercialBreak(onStart)).then((res) => res.status === 'done');
    }

    /** One-time start-up: SDK init (never fatal), gameLoadingFinished, lifecycle wiring. Safe to call twice. */
    function boot() {
        if (booted) return;
        booted = true;

        // Never let the keyboard reach the game while an ad is running (Poki requirement); also stop page-jump on Space / arrows.
        window.addEventListener('keydown', (e) => {
            if (session) { e.stopImmediatePropagation(); e.preventDefault(); return; }
            if (e.target === document.body && ['ArrowDown', 'ArrowUp', ' '].indexOf(e.key) !== -1) e.preventDefault();
        }, true);

        // Self-heal: if a shield ever outlives its session, the very next input / visibility change removes it (capture phase = runs before it can block).
        ['pointerdown', 'touchstart', 'mousedown', 'wheel'].forEach((ev) => window.addEventListener(ev, sweepOrphanShield, { capture: true, passive: true }));
        window.addEventListener('pageshow', sweepOrphanShield);
        window.addEventListener('focus', sweepOrphanShield);
        document.addEventListener('visibilitychange', sweepOrphanShield);
        window.addEventListener('gc:ads-state', sweepOrphanShield);

        // gameplayStart is only valid after the player really interacts with the game.
        const arm = () => {
            gameplayArmed = true;
            ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => window.removeEventListener(ev, arm, true));
            syncGameplay();
        };
        ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => window.addEventListener(ev, arm, { capture: true, passive: true }));
        window.addEventListener('gc:pause', syncGameplay);
        window.addEventListener('gc:resume', syncGameplay);
        document.addEventListener('visibilitychange', syncGameplay);

        const finish = () => {
            try { if (sdk() && typeof sdk().gameLoadingFinished === 'function') sdk().gameLoadingFinished(); } catch (e) { /* ignore */ }
            syncGameplay();
            emit();
        };
        const p = sdk();
        if (!p || typeof p.init !== 'function') { sdkState = 'missing'; finish(); return; }   // script blocked / not loaded: game runs without ads
        try {
            Promise.resolve(p.init()).then(
                () => { sdkState = 'ready'; },
                () => { sdkState = 'failed'; console.warn('[GCAds] PokiSDK.init() failed; the game continues without ads.'); }
            ).then(finish);
        } catch (e) {
            sdkState = 'failed';
            finish();
        }
    }

    return { boot, isAvailable, isBusy, getSession, getState, cooldownLeftMs, requestRewarded, commercialBreak };
})();
window.GCAds = GCAds;

/* =====================================================================================================================
   REWARDED ADS IN THE SHOP
     Permanent unlocks, three SEPARATE counters in shopState.adCounters (persisted with the save):
        vip  25 ads -> shopState.isVIP = true (permanent)          pass 25 ads -> shopState.isPremiumPassUnlocked = true
        afk  15 ads -> shopState.afkLevel = 3 (16 h offline cap)
     Repeatable: Free Gems (5..15, 20 s cooldown) and Frenz Potion (x5 CPS for 60 s, 3 per daily window).
   Every reward goes through grantRewardedAd(), which only ever runs from GCAds' 'rewarded' result (one call per ad).
   ===================================================================================================================== */
const AD_GEMS_COOLDOWN_MS = 20 * 1000;
let adGemsCooldownUntil = 0;        // monotonic ms (GCTime.mono) - in memory only, a reload simply clears the 20 s wait
let adLastGemsReward = 0;           // last Free Gems amount (display only)

/** Frenz Potion ads used in the current daily window. The window IS the existing Expedition Pass daily reset (no second clock). */
function getPotionAdsUsed() {
    const s = ensureShopState();
    const stamp = Number(gameState.pass && gameState.pass.lastDailyReset) || 0;
    if (s.potionAdsStamp !== stamp) { s.potionAdsStamp = stamp; s.potionAdsUsed = 0; }
    return s.potionAdsUsed;
}

/** { count, goal, owned } for a permanent ad unlock ('vip' | 'pass' | 'afk'). */
function getAdUnlockInfo(kind) {
    const s = ensureShopState();
    const goal = AD_GOALS[kind];
    const count = s.adCounters[kind] || 0;
    let owned = false;
    if (kind === 'vip') owned = isVIPActive() && s.vipExpires == null;
    else if (kind === 'pass') owned = s.isPremiumPassUnlocked === true;
    else if (kind === 'afk') owned = getAfkLevel() >= 3;
    return { count: owned ? Math.max(count, 0) : count, goal, owned };
}

/** Applies the permanent unlock for a finished counter. Reuses the shop's own grant code path. */
function unlockAdReward(kind) {
    if (kind === 'vip') { applyProductGrant(SHOP_PRODUCTS.vip); return SHOP_PRODUCTS.vip.name; }
    if (kind === 'pass') { applyProductGrant(SHOP_PRODUCTS.premiumExpeditionPass); return SHOP_PRODUCTS.premiumExpeditionPass.name; }
    // afk: set level 3 (never downgrades; level 4 stays a Gem purchase). syncAfkLimit() derives the 16 h cap.
    applyProductGrant(null, { afkLevel: 3 });
    return adT('ad_afk_title');
}

/** Counts one completed ad for a permanent unlock. Returns true when this ad completed the unlock. */
function countAdProgress(kind) {
    const s = ensureShopState();
    const info = getAdUnlockInfo(kind);
    if (info.owned) return false;                                    // never count (or re-grant) once owned
    s.adCounters[kind] = Math.min(info.goal, (s.adCounters[kind] || 0) + 1);
    if (s.adCounters[kind] < info.goal) {
        saveGame();
        showIapToast(adT('ad_toast_progress', { n: s.adCounters[kind], goal: info.goal }));
        refreshIapShopState();
        return false;
    }
    const name = unlockAdReward(kind);
    try { playUpgradeSound(); } catch (e) { /* ignore */ }
    showIapToast(adT('ad_toast_unlocked', { name }));
    finalizeShopChange(kind === 'vip' ? 'vip' : (kind === 'pass' ? 'premiumExpeditionPass' : undefined));
    return true;
}

/** Applies the reward of ONE successfully completed rewarded ad. Called exactly once per ad (see watchRewardedAd). */
function grantRewardedAd(kind) {
    const s = ensureShopState();
    if (kind === 'gems') {
        const amount = Math.floor(Math.random() * (AD_GEMS_MAX - AD_GEMS_MIN + 1)) + AD_GEMS_MIN;   // 5..15 inclusive
        gameState.gems += amount;
        recalculatePrestigeMultiplier();
        adLastGemsReward = amount;
        try { playUpgradeSound(); } catch (e) { /* ignore */ }
        saveGame();
        updateUIForce();
        refreshIapShopState();
        showIapToast(adT('ad_toast_gems', { n: amount }));
        return;
    }
    if (kind === 'potion') {
        if (getPotionAdsUsed() >= AD_POTION_DAILY_LIMIT) return;     // defense in depth: the limit is also enforced before the ad
        s.potionAdsUsed += 1;
        startFrenzyEffect();                                         // the existing Frenzy effect (x5 passive income, timestamp based)
        try { playUpgradeSound(); } catch (e) { /* ignore */ }
        saveGame();
        updateUI();
        updateShopHud();
        refreshIapShopState();
        showIapToast(adT('ad_toast_potion', { mult: FRENZY_POTION_MULTIPLIER, sec: FRENZY_POTION_DURATION_MS / 1000 }));
        return;
    }
    if (AD_GOALS[kind]) countAdProgress(kind);
}

/** Why a rewarded request cannot start right now ('' = it can). Checked before the ad AND the UI uses it for button states. */
function getAdBlockReason(kind) {
    if (AD_GOALS[kind] && getAdUnlockInfo(kind).owned) return 'owned';
    if (kind === 'potion' && getPotionAdsUsed() >= AD_POTION_DAILY_LIMIT) return 'limit';
    if (kind === 'gems' && GCTime.mono() < adGemsCooldownUntil) return 'cooldown';
    return '';
}

/** Click handler for every "Watch Ad" button. One ad at a time; failures never grant anything. */
function watchRewardedAd(kind) {
    if (!(kind in AD_GOALS) && kind !== 'gems' && kind !== 'potion') return;
    try { initAudio(); } catch (e) { /* ignore */ }
    if (GCAds.isBusy()) return;
    const block = getAdBlockReason(kind);
    if (block === 'owned') { showIapToast(adT('ad_toast_owned')); return; }
    if (block === 'limit') { showIapToast(adT('ad_toast_limit')); return; }
    if (block === 'cooldown') { showIapToast(adT('ad_toast_cooldown', { s: Math.ceil((adGemsCooldownUntil - GCTime.mono()) / 1000) })); return; }

    const size = kind === 'potion' ? 'medium' : 'small';
    GCAds.requestRewarded(kind, size).then((res) => {
        const status = res && res.status;
        if (status === 'rewarded') {
            if (kind === 'gems') adGemsCooldownUntil = GCTime.mono() + AD_GEMS_COOLDOWN_MS;
            try { grantRewardedAd(kind); } catch (e) { console.warn('Rewarded ad grant failed:', e); }
        } else if (status === 'not-rewarded') {
            if (kind === 'gems') adGemsCooldownUntil = GCTime.mono() + AD_GEMS_COOLDOWN_MS;
            showIapToast(adT('ad_toast_nofill'));
        } else if (status === 'error') {
            if (kind === 'gems') adGemsCooldownUntil = GCTime.mono() + AD_GEMS_COOLDOWN_MS;
            showIapToast(adT('ad_toast_error'));
        } else if (status === 'unavailable') {
            showIapToast(adT('ad_toast_unavail'));
        } else if (status === 'cooldown') {
            showIapToast(adT('ad_toast_cooldown', { s: Math.ceil((res.waitMs || 1000) / 1000) }));
        }
        try { updateAdCards(); } catch (e) { /* ignore */ }
    });
}

/* ---- Shop UI for the ad cards (built once per language, afterwards only text / state is updated: no flicker, taps are never lost) ---- */
const adUi = { built: false, refs: {} };
const AD_CARD_DEFS = [
    { kind: 'gems',   host: 'iap-free-grid', icon: '💎' },
    { kind: 'potion', host: 'iap-free-grid', icon: '🧪' },
    { kind: 'vip',    host: 'iap-vip-ad',    icon: '👑' },
    { kind: 'pass',   host: 'iap-pass-ad',   icon: '🏆' },
    { kind: 'afk',    host: 'iap-afk-ad',    icon: '⏳' }
];

function buildAdCards() {
    adUi.refs = {};
    adUi.built = true;
    const cleared = {};
    const freeTitle = document.getElementById('iap-free-title');
    if (freeTitle) freeTitle.textContent = adT('ad_free_title');
    AD_CARD_DEFS.forEach((def) => {
        const host = document.getElementById(def.host);
        if (!host) return;
        if (!cleared[def.host]) { host.innerHTML = ''; cleared[def.host] = true; }
        const goal = AD_GOALS[def.kind];
        let title, desc;
        if (def.kind === 'gems') { title = adT('ad_gems_title'); desc = adT('ad_gems_desc', { min: AD_GEMS_MIN, max: AD_GEMS_MAX }); }
        else if (def.kind === 'potion') { title = adT('ad_potion_title'); desc = adT('ad_potion_desc', { mult: FRENZY_POTION_MULTIPLIER, sec: FRENZY_POTION_DURATION_MS / 1000 }); }
        else { title = adT('ad_' + def.kind + '_title'); desc = adT('ad_' + def.kind + '_desc', { goal }); }
        const hasBar = def.kind !== 'gems';
        const card = document.createElement('div');
        card.className = 'iap-card iap-card-ad featured';
        card.dataset.adCard = def.kind;
        card.innerHTML = `${iapCorners()}
            <div class="iap-card-icon">${def.icon}</div>
            <div class="iap-card-name">${title}</div>
            <div class="iap-card-desc">${desc}</div>
            ${hasBar ? '<div class="iap-ad-count" data-role="count"></div><div class="iap-ad-progress"><span data-role="bar"></span></div>' : ''}
            <div class="iap-card-desc iap-ad-extra" data-role="extra"></div>
            <div class="iap-card-footer"><button type="button" class="iap-buy-btn iap-ad-btn" data-ad-action="${def.kind}"></button></div>`;
        host.appendChild(card);
        adUi.refs[def.kind] = {
            card,
            count: card.querySelector('[data-role="count"]'),
            bar: card.querySelector('[data-role="bar"]'),
            extra: card.querySelector('[data-role="extra"]'),
            btn: card.querySelector('.iap-ad-btn'),
            last: {}
        };
    });
}

function adSetText(el, cache, key, value) {
    if (!el || cache[key] === value) return;
    cache[key] = value;
    el.textContent = value;
}

/** Cheap, idempotent refresh of every ad card (counters, progress bars, button label / enabled state). */
function updateAdCards() {
    if (!adUi.built) buildAdCards();
    const sess = GCAds.getSession();
    const available = GCAds.isAvailable();
    const globalWait = GCAds.cooldownLeftMs();
    Object.keys(adUi.refs).forEach((kind) => {
        const r = adUi.refs[kind];
        if (!r || !r.card) return;
        let hidden = false, count = '', pct = 0, extra = '';
        if (AD_GOALS[kind]) {
            const info = getAdUnlockInfo(kind);
            hidden = info.owned;                                      // already unlocked (by ads OR Gems): the ad card disappears
            count = adT('ad_progress', { n: info.count, goal: info.goal });
            pct = Math.round((info.count / info.goal) * 100);
        } else if (kind === 'potion') {
            count = adT('ad_progress', { n: getPotionAdsUsed(), goal: AD_POTION_DAILY_LIMIT });
            pct = Math.round((getPotionAdsUsed() / AD_POTION_DAILY_LIMIT) * 100);
            if (isFrenzyActive()) extra = adT('ad_potion_active', { time: formatClock(getFrenzyRemainingMs()) });
        } else if (kind === 'gems') {
            if (adLastGemsReward > 0) extra = adT('ad_gems_last', { n: adLastGemsReward });
        }

        // Button state
        const block = getAdBlockReason(kind);
        let label, disabled;
        if (sess) {
            disabled = true;
            label = sess.kind === kind ? adT(sess.phase === 'playing' ? 'ad_playing' : 'ad_loading') : adT('ad_busy');
        } else if (!available) {
            disabled = true;
            label = adT(GCAds.getState() === 'pending' ? 'ad_loading' : 'ad_unavailable');
        } else if (block === 'limit') {
            disabled = true; label = adT('ad_limit');
        } else if (block === 'cooldown') {
            disabled = true; label = adT('ad_cooldown', { s: Math.ceil((adGemsCooldownUntil - GCTime.mono()) / 1000) });
        } else if (globalWait > 0) {
            disabled = true; label = adT('ad_cooldown', { s: Math.ceil(globalWait / 1000) });
        } else {
            disabled = false; label = '📺 ' + adT('ad_watch');
        }

        if (r.last.hidden !== hidden) { r.last.hidden = hidden; r.card.style.display = hidden ? 'none' : ''; }
        adSetText(r.count, r.last, 'count', count);
        if (r.bar && r.last.pct !== pct) { r.last.pct = pct; r.bar.style.width = pct + '%'; }
        adSetText(r.extra, r.last, 'extra', extra);
        if (r.extra) r.extra.style.display = extra ? '' : 'none';
        adSetText(r.btn, r.last, 'label', label);
        if (r.last.disabled !== disabled) { r.last.disabled = disabled; r.btn.disabled = disabled; r.btn.classList.toggle('disabled', disabled); }
    });
}

/* ---------------------------------------------------------------
   Shop helpers
   --------------------------------------------------------------- */

const shopUi = { busy: false };   // one shop action at a time

/** True while any shop action is running (blocks double-claims). */
function isShopBusy() {
    return !!shopUi.busy;
}

function isProductOwned(product) {
    return !!(product && product.isOwned && product.isOwned(ensureShopState()));
}

/** True when a product has a prerequisite (isUnlocked) that is not met yet. */
function isProductLocked(product) {
    return !!(product && product.isUnlocked && !product.isUnlocked(ensureShopState()));
}

/** 'owned' | 'locked' | 'available' - drives card rendering and validation. */
function getProductState(product) {
    if (isProductOwned(product)) return 'owned';
    return isProductLocked(product) ? 'locked' : 'available';
}

/**
 * Applies a grant and returns text lines describing it.
 * Data-driven so every product uses the same code path.
 */
function applyProductGrant(product, grantOverride) {
    const g = grantOverride || product.grant || {};
    const s = ensureShopState();
    const lines = [];

    if (g.headline) lines.push(g.headline);

    if (g.vip) {
        const now = GCTime.now();
        const alreadyPermanent = isVIPActive() && s.vipExpires == null;
        if (!alreadyPermanent) {                       // never downgrade permanent VIP to a timed one
            const base = isVIPActive() && s.vipExpires ? s.vipExpires : now;
            s.isVIP = true;
            if (g.vipDurationMs) {
                let next = base + g.vipDurationMs;
                if (g.vipMaxMs) next = Math.min(next, now + g.vipMaxMs);
                s.vipExpires = next;
            } else {
                s.vipExpires = null; // permanent
            }
        }
        syncRuneSlotsToVIP();
        lines.push(t('iap_grant_vip'), t('iap_grant_gold', { mult: VIP_GOLD_MULTIPLIER }),
            t('iap_grant_drop', { percent: Math.round((VIP_DROP_CHANCE_MULTIPLIER - 1) * 100) }), t('iap_grant_rune', { n: VIP_EXTRA_RUNE_SLOTS }));
    }
    if (g.gems) {
        gameState.gems += g.gems;
        recalculatePrestigeMultiplier();
        lines.push(t('iap_gems_plus', { amount: g.gems.toLocaleString('en-US') }));
    }
    if (g.keys) {
        let total = 0;
        for (const rarity in g.keys) {
            gameState.keys[rarity] = (gameState.keys[rarity] || 0) + g.keys[rarity];
            total += g.keys[rarity];
        }
        lines.push(t('iap_grant_keys', { n: total }));
    }
    if (g.frenzyPotions) {
        s.frenzyPotions += g.frenzyPotions;
        lines.push(t('iap_grant_potions', { n: g.frenzyPotions }));
    }
    if (g.flags) Object.assign(s, g.flags);
    if (g.afkLevel) {
        // Never downgrade: the limit always matches the highest tier owned.
        s.afkLevel = Math.max(clampAfkLevel(s.afkLevel), clampAfkLevel(g.afkLevel));
        syncAfkLimit();
    }
    if (g.lines) g.lines.forEach((l) => lines.push(l));
    return lines;
}

/** Saves and refreshes every UI that depends on shop state. */
function finalizeShopChange(flashId) {
    saveGame();
    updateUIForce();
    if (typeof refreshAfkUI === 'function') refreshAfkUI(true);
    // Premium Pass unlock: refresh the Premium track immediately (no reload).
    if (typeof renderPassRewardsTrack === 'function') renderPassRewardsTrack();
    if (typeof updatePassUI === 'function') updatePassUI();
    updateShopHud();
    renderIapShop(flashId);
}

/** Buys a product with Gems. Every rule is enforced here, not only via disabled buttons. */
function buyProductWithGems(productId) {
    const product = SHOP_PRODUCTS[productId];
    if (!product || !(product.gemCost > 0) || isShopBusy()) return false;
    initAudio();
    const s = ensureShopState();
    if (product.oneTime && isProductOwned(product)) {
        showIapToast(st('iap_already_owned', 'Already owned.'));
        return false;
    }
    if (isProductLocked(product)) {
        showIapToast(product.lockedLabel || st('iap_locked', 'Locked'));
        return false;
    }
    if (!(Number(gameState.gems) >= product.gemCost)) {
        showIapToast(st('iap_not_enough_gems', 'Not enough Gems.'));
        return false;
    }
    gameState.gems -= product.gemCost;
    applyProductGrant(product);
    playUpgradeSound();
    showIapToast(st('iap_claimed', 'Unlocked: {name}', { name: product.name }).replace('{name}', product.name));
    finalizeShopChange(product.id);
    return true;
}

/* ---------------------------------------------------------------
   Shop UI
   --------------------------------------------------------------- */

function iapEl(id) { return document.getElementById(id); }

/** Gem-price button. */
function iapGemBtnHTML(attr, value, cost, prefix) {
    const busy = isShopBusy();
    return `<button type="button" class="iap-buy-btn iap-cost-btn" ${attr}="${value}" ${busy ? 'disabled' : ''}>${prefix ? prefix + ' · ' : ''}💎 ${cost.toLocaleString('en-US')}</button>`;
}

function buildIapCardHTML(product) {
    const owned = isProductOwned(product);
    const locked = !owned && isProductLocked(product);
    const perks = product.perks
        ? `<ul class="iap-card-perks">${product.perks.map((p) => `<li>${p}</li>`).join('')}</ul>`
        : '';
    const desc = `<div class="iap-card-desc">${product.description || ''}</div>`;
    const badge = product.badge ? `<span class="iap-badge">${product.badge}</span>` : '';
    const corners = product.featured ? iapCorners() : '';
    let footer;
    if (owned) {
        footer = `<button type="button" class="iap-buy-btn owned" disabled>${product.ownedLabel || t('iap_owned')}</button>`;
    } else if (locked) {
        footer = `<button type="button" class="iap-buy-btn locked" disabled>🔒 ${product.lockedLabel || t('iap_locked')}</button>`;
    } else {
        footer = product.gemCost ? iapGemBtnHTML('data-buy-gems', product.id, product.gemCost, '') : '';
    }
    return `
        <div class="iap-card iap-card-${product.id}${product.featured ? ' featured' : ''}${owned ? ' is-owned' : ''}${locked ? ' is-locked' : ''}" data-product="${product.id}">
            ${corners}
            ${badge}
            <div class="iap-card-icon">${product.icon}</div>
            <div class="iap-card-name">${product.name}</div>
            ${desc}
            ${perks}
            <div class="iap-card-footer">${footer}</div>
        </div>`;
}

/** Signature per grid: a grid is only rebuilt when something visible changed. */
const iapGridBuilt = {};

function renderIapProducts() {
    const s = ensureShopState();
    const busy = isShopBusy();
    const gems = Math.floor(Number(gameState.gems) || 0);
    const fill = (id, category) => {
        const el = iapEl(id);
        if (!el) return;
        const products = Object.values(SHOP_PRODUCTS).filter((p) => p.category === category);
        const sig = products.map((p) => [getProductState(p),
            p.gemCost ? (gems >= p.gemCost ? 1 : 0) : '-', busy ? 1 : 0].join(':')).join('|');
        if (iapGridBuilt[id] === sig && el.children.length === products.length) return;
        iapGridBuilt[id] = sig;
        el.innerHTML = products.map(buildIapCardHTML).join('');
    };
    fill('iap-vip-grid', 'vip');
    fill('iap-pass-grid', 'pass');
}

/** Rebuilds changed product cards and the AFK card; `flashId` highlights a card. */
function renderIapShop(flashId) {
    renderIapProducts();
    renderIapAfk();
    refreshIapShopState();

    if (flashId) {
        const card = document.querySelector(`#iap-overlay .iap-card[data-product="${flashId}"]`);
        if (card) {
            card.classList.add('iap-flash');
            setTimeout(() => card.classList.remove('iap-flash'), 1400);
        }
    }
}


/* ---- AFK / Offline Progress card (one card, next upgrade only, paid with Gems) ---- */
let iapAfkSig = '';

function iapCorners() {
    return '<div class="frame-corner top-left"></div><div class="frame-corner top-right"></div><div class="frame-corner bottom-left"></div><div class="frame-corner bottom-right"></div>';
}

function renderIapAfk() {
    const el = iapEl('iap-afk-card');
    if (!el) return;
    ensureShopState();
    const lvl = getAfkLevel();
    const max = AFK_LEVEL_HOURS.length - 1;
    const gems = Math.floor(Number(gameState.gems) || 0);
    const gemUp = AFK_GEM_UPGRADES.find((u) => u.level === lvl + 1);
    const prodId = lvl + 1 === 3 ? 'afk16' : (lvl + 1 === 4 ? 'afk24' : null);
    const prod = prodId ? SHOP_PRODUCTS[prodId] : null;
    const busy = isShopBusy();
    const sig = [lvl, gemUp ? (gems >= gemUp.cost ? 1 : 0) : (prod ? (gems >= prod.gemCost ? 1 : 0) : 'x'), busy ? 1 : 0].join('|');
    if (sig === iapAfkSig && el.firstElementChild) return;
    iapAfkSig = sig;

    const curTxt = st('iap_afk_current', 'Current Limit: {limit}', { limit: formatAfkHours(getMaxOfflineHours()) }).replace('{limit}', formatAfkHours(getMaxOfflineHours()));
    let nextHtml, btn;
    if (lvl >= max) {
        nextHtml = '';
        btn = `<button type="button" class="iap-buy-btn owned" disabled>${st('iap_afk_max', 'MAX')}</button>`;
    } else {
        const nextHours = AFK_LEVEL_HOURS[lvl + 1];
        const nextTxt = st('iap_afk_next', 'Next Upgrade: {limit}', { limit: formatAfkHours(nextHours) }).replace('{limit}', formatAfkHours(nextHours));
        nextHtml = `<div class="iap-card-desc">${nextTxt}</div>`;
        const upgrade = st('iap_afk_upgrade', 'Upgrade');
        if (gemUp) {
            btn = iapGemBtnHTML('data-afk-gem', gemUp.level, gemUp.cost, upgrade);
        } else if (prod) {
            btn = iapGemBtnHTML('data-buy-gems', prod.id, prod.gemCost, upgrade);
        } else {
            btn = '';
        }
    }
    el.innerHTML = `
        <div class="iap-card iap-card-afk featured">
            ${iapCorners()}
            <div class="iap-card-icon">⏳</div>
            <div class="iap-card-name">${st('iap_afk_title', 'AFK / OFFLINE PROGRESS')}</div>
            <div class="iap-card-desc">${curTxt}</div>
            ${nextHtml}
            <div class="iap-card-footer">${btn}</div>
        </div>`;
}

function formatClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Cached references for the live parts of the Shop wallet / "My Items" area. */
const iapLive = { gemEl: null, vipEl: null, gemText: null, vipText: null, vipActive: null, items: null };

function getIapItemsRefs(itemsEl) {
    if (iapLive.items && itemsEl.contains(iapLive.items.card)) return iapLive.items;
    itemsEl.innerHTML = `
            <div class="iap-item-card">
                <div class="iap-card-icon small">🧪</div>
                <div class="iap-item-info">
                    <div class="iap-item-name">${t('iap_potion_name')} <span class="iap-item-count"></span></div>
                    <div class="iap-item-desc"></div>
                </div>
                <button type="button" class="iap-use-btn" data-use-potion></button>
            </div>`;
    const card = itemsEl.firstElementChild;
    iapLive.items = {
        card,
        count: card.querySelector('.iap-item-count'),
        desc: card.querySelector('.iap-item-desc'),
        btn: card.querySelector('.iap-use-btn'),
        active: null, countText: null, descHtml: null, disabled: null, btnText: null
    };
    return iapLive.items;
}

/** Lightweight refresh: gem count, VIP banner, potion inventory (targeted updates only). */
function refreshIapShopState() {
    const s = ensureShopState();
    if (!iapLive.gemEl) iapLive.gemEl = iapEl('iap-gem-count');
    if (!iapLive.vipEl) iapLive.vipEl = iapEl('iap-vip-status');

    const gemEl = iapLive.gemEl;
    if (gemEl) {
        const txt = t('gems_count', { amount: Math.floor(gameState.gems).toLocaleString('en-US') });
        if (iapLive.gemText !== txt) { iapLive.gemText = txt; gemEl.textContent = txt; }
    }

    const vipEl = iapLive.vipEl;
    if (vipEl) {
        let txt, active;
        if (isVIPActive()) {
            const left = s.vipExpires ? t('iap_vip_days_left', { days: Math.max(1, Math.ceil((s.vipExpires - GCTime.now()) / 86400000)) }) : t('iap_vip_permanent');
            txt = t('iap_vip_active', { left });
            active = true;
        } else {
            txt = t('iap_vip_inactive');
            active = false;
        }
        if (iapLive.vipText !== txt) { iapLive.vipText = txt; vipEl.textContent = txt; }
        if (iapLive.vipActive !== active) { iapLive.vipActive = active; vipEl.classList.toggle('active', active); }
    }

    renderIapProducts();
    renderIapAfk();
    try { updateAdCards(); } catch (e) { console.warn('Ad cards update failed:', e); }
    const afkEl = iapEl('iap-afk-current');
    if (afkEl) {
        const txt = t('afk_limit_current', { limit: formatAfkHours(getMaxOfflineHours()) });
        if (afkEl.textContent !== txt) afkEl.textContent = txt;
    }

    const itemsEl = iapEl('iap-items');
    if (itemsEl) {
        const r = getIapItemsRefs(itemsEl);
        const active = isFrenzyActive();
        if (r.active !== active) { r.active = active; r.card.classList.toggle('active', active); }
        const countText = `x${s.frenzyPotions}`;
        if (r.countText !== countText) { r.countText = countText; r.count.textContent = countText; }
        const descHtml = t('iap_potion_desc', { mult: FRENZY_POTION_MULTIPLIER, seconds: FRENZY_POTION_DURATION_MS / 1000 }) + (active ? t('iap_potion_left', { time: formatClock(getFrenzyRemainingMs()) }) : '');
        if (r.descHtml !== descHtml) { r.descHtml = descHtml; r.desc.innerHTML = descHtml; }
        const disabled = !(s.frenzyPotions > 0);
        if (r.disabled !== disabled) { r.disabled = disabled; r.btn.disabled = disabled; }
        const btnText = active ? t('iap_plus60') : t('iap_use');
        if (r.btnText !== btnText) { r.btnText = btnText; r.btn.textContent = btnText; }
    }
}

/* ---- HUD badges (VIP / Frenzy / potion button) in the stats panel ---- */

let iapHudSignature = '';

function updateShopHud() {
    const hud = iapEl('iap-hud');
    if (!hud) return;
    const s = ensureShopState();
    const vip = isVIPActive();
    const frenzy = isFrenzyActive();
    const sig = [vip, s.vipExpires ? Math.ceil((s.vipExpires - GCTime.now()) / 86400000) : 'p',
        frenzy ? Math.ceil(getFrenzyRemainingMs() / 1000) : 0, s.frenzyPotions].join('|');
    if (sig === iapHudSignature) return;
    iapHudSignature = sig;

    const parts = [];
    if (vip) {
        const left = s.vipExpires ? t('iap_vip_days_short', { days: Math.max(1, Math.ceil((s.vipExpires - GCTime.now()) / 86400000)) }) : '';
        parts.push(`<span class="iap-hud-badge vip" title="${t('iap_hud_vip_title', { mult: VIP_GOLD_MULTIPLIER })}">${t('iap_hud_vip', { left, mult: VIP_GOLD_MULTIPLIER })}</span>`);
    }
    if (frenzy) {
        parts.push(`<span class="iap-hud-badge frenzy">${t('iap_hud_frenzy', { mult: FRENZY_POTION_MULTIPLIER, time: formatClock(getFrenzyRemainingMs()) })}</span>`);
    }
    if (s.frenzyPotions > 0) {
        parts.push(`<button type="button" class="iap-hud-use" data-use-potion>${t('iap_hud_potion', { action: frenzy ? t('iap_plus60') : t('iap_hud_use_potion'), count: s.frenzyPotions })}</button>`);
    }
    hud.innerHTML = parts.join('');
    hud.style.display = parts.length ? 'flex' : 'none';
}

/** Called once per game tick: VIP expiry, Frenzy expiry, HUD timers. */
function tickShop() {
    const s = gameState.shopState;
    if (!s) return;
    let changed = false;
    if (checkVipExpiry()) changed = true;
    if (s.frenzyExpiresAt && s.frenzyExpiresAt <= GCTime.now()) {
        s.frenzyExpiresAt = null;
        changed = true;
    }
    if (changed) {
        saveGame();
        renderIapShop();
    } else if (iapEl('iap-overlay') && iapEl('iap-overlay').classList.contains('open')) {
        refreshIapShopState();
    }
    updateShopHud();
}

let iapToastTimer = null;
function showIapToast(message) {
    const el = iapEl('iap-toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(iapToastTimer);
    iapToastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

/* ---- Open / close / wiring ---- */

function openShop() {
    const overlay = iapEl('iap-overlay');
    if (!overlay) return;
    renderIapShop();
    overlay.classList.add('open');
    setActiveNavTab('shop');
}

function closeShop() {
    const overlay = iapEl('iap-overlay');
    if (overlay) overlay.classList.remove('open');
    setActiveNavTab('main');
}

function initShop() {
    ensureShopState();
    const overlay = iapEl('iap-overlay');

    if (dom.navTabShop) {
        dom.navTabShop.addEventListener('click', () => {
            closeAllNavModals();
            openShop();
        });
    }
    if (overlay) {
        const closeBtn = iapEl('iap-close');
        if (closeBtn) closeBtn.addEventListener('click', closeShop);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { closeShop(); return; }
            const buyGems = e.target.closest('[data-buy-gems]');
            if (buyGems) { buyProductWithGems(buyGems.getAttribute('data-buy-gems')); return; }
            const afk = e.target.closest('[data-afk-gem]');
            if (afk) {
                const ok = buyAfkGemUpgrade(Number(afk.getAttribute('data-afk-gem')));
                if (!ok) showIapToast(st('iap_not_enough_gems', 'Not enough Gems.'));
                return;
            }
            const adBtn = e.target.closest('[data-ad-action]');
            if (adBtn) { if (!adBtn.disabled) watchRewardedAd(adBtn.getAttribute('data-ad-action')); return; }
            if (e.target.closest('[data-use-potion]')) activateFrenzyPotion();
        });
    }

    // Ad state changes (SDK ready, ad started / finished) refresh the shop even while the game loop is paused.
    window.addEventListener('gc:ads-state', () => {
        try { if (overlay && overlay.classList.contains('open')) refreshIapShopState(); else updateAdCards(); } catch (e) { /* ignore */ }
    });

    const hud = iapEl('iap-hud');
    if (hud) hud.addEventListener('click', (e) => { if (e.target.closest('[data-use-potion]')) activateFrenzyPotion(); });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (overlay && overlay.classList.contains('open')) closeShop();
    });

    syncRuneSlotsToVIP();
    renderIapShop();
    updateShopHud();
}


/**
 * Re-renders every piece of localized, dynamically generated UI after a language switch.
 * Registered with i18n.onChange(). Touches presentation only - never gameplay state.
 */
function refreshLocalizedUI() {
    const safe = (fn) => { try { fn(); } catch (e) { console.error('Localization refresh failed:', e); } };
    gameState.language = getLanguage();

    // Invalidate every cache/signature that would otherwise keep the old language on screen.
    shopCardCache.keySig = null;
    keyInventorySig = null;
    lastBuffUiSig = null;
    iapHudSignature = '';
    helperStripHtml = null;
    afkLastSig = '';
    passTrackBuilt = false;
    passQuestCardsBuilt = false;
    helpersUiBuilt = false;
    afkUiBuilt = false;
    iapAfkSig = '';
    for (const k in iapGridBuilt) delete iapGridBuilt[k];
    iapLive.items = null; iapLive.gemText = null; iapLive.vipText = null;
    adUi.built = false;

    safe(() => { updateVolumeUI(); });
    safe(() => applyBiomeVisuals(false));
    safe(() => {
        if (lastDepthBiome && dom.depthModalOverlay.classList.contains('open')) {
            dom.depthModalName.textContent = lastDepthBiome.name;
            dom.depthModalMult.textContent = t('zone_multiplier', { mult: formatNumber(lastDepthBiome.zoneMultiplier) });
            dom.depthModalText.textContent = lastDepthBiome.announcement || '';
        }
    });
    safe(() => initHelpers());
    safe(() => refreshAfkUI(true));
    safe(() => renderIapShop());
    safe(() => updateShopHud());
    safe(() => renderSkillTree());
    safe(() => renderRelicExcavation());
    safe(() => renderDailyLoginTab());
    safe(() => renderDailyQuests());
    safe(() => renderAchievements());
    safe(() => {
        const weeklyShown = dom.passQuestListWeekly && dom.passQuestListWeekly.style.display !== 'none';
        switchPassQuestTab(weeklyShown ? 'weekly' : 'daily');
        renderPassQuestResetTimer(weeklyShown ? 'weekly' : 'daily');
        renderPassQuestTab();
    });
    safe(() => updateKeyAltarControls());
    safe(() => updateKeyInventoryUI());
    safe(() => updateActiveBuffUI());
    safe(() => {
        if (dom.offlineOverlay && dom.offlineOverlay.classList.contains('open') && lastOfflinePending) {
            showOfflineProgressModal(lastOfflinePending);
        }
    });
    safe(() => updateUI(true));
    safe(() => updatePassUI());
}

/**
 * =========================================
 * FIRST-TIME TUTORIAL (TutorialManager)
 * =========================================
 * A guided tour for brand-new players, integrated into the existing game (the whole UI is built from JS, so
 * index.html needs no changes).
 *
 * Persistence: the ONLY source of truth is gameState.tutorialCompleted, saved through the normal saveGame() /
 * GCStore path inside the main 'goldClickerSave' blob. No second save system or extra localStorage key exists.
 *   - brand-new player / unreadable save / explicit `false`  -> the tutorial starts
 *   - `true`                                                  -> never starts automatically
 *   - old save without the field                              -> migrated in loadGame() (any progress => completed)
 * Refresh mid-tutorial: nothing partial is stored, so the tutorial simply restarts from step 1 (it can never get stuck).
 *
 * Rendering: one top-level `.tutorial-overlay` appended to <body>. The dark mask is a giant box-shadow on the
 * spotlight element, so the real target stays exactly where it is (no z-index / stacking-context tricks and no style
 * changes to the target). Four transparent blockers + an optional shield stop accidental clicks outside the hole;
 * on interactive steps the hole itself is click-through.
 *
 * Extending: add an object to TUTORIAL_STEPS (+ its i18n keys in every language). Fields:
 *   id, titleKey, textKey | text(state) -> {key, params}, target (CSS selector | null), interactive,
 *   dock ('top' | 'bottom' | 'auto'), optional (step is skipped when its target is hidden/missing),
 *   before(state) (safe UI prep only), note(state) -> i18n key | '', watchMining (auto-advance after one real mining click).
 */
const TutorialManager = (function () {
    'use strict';

    const AUTO_ADVANCE_MS = 1100;   // pause after the first mining click before moving on
    const HOLE_PAD = 8;             // px of breathing room around the highlighted element
    const PANEL_GAP = 12;           // px between the dialogue panel and the viewport edge / hole

    const tr = (key, params) => (typeof t === 'function' ? t(key, params) : String(key));

    function activateUpgradesTab() {
        // Only switches the visible Shop sub-tab (no purchase, no state change).
        const btn = document.querySelector('.shop-tab-btn[data-stab="upgrades"]');
        if (btn && !btn.classList.contains('active')) btn.click();
    }

    function canAffordAnyUpgrade() {
        try {
            const ups = gameState.upgrades;
            for (const k in ups) {
                if (ups[k] && Number.isFinite(ups[k].price) && gameState.coins >= ups[k].price) return true;
            }
        } catch (e) { /* ignore */ }
        return false;
    }

    const TUTORIAL_STEPS = [
        {
            id: 'welcome', titleKey: 'tutorial_s1_title', textKey: 'tutorial_s1_text',
            target: '#stats-panel', dock: 'bottom', optional: false
        },
        {
            id: 'mine', titleKey: 'tutorial_s2_title', textKey: 'tutorial_s2_text',
            target: '#click-button-frame', interactive: true, dock: 'auto', optional: false, watchMining: true,
            note: (s) => (s.mined ? 'tutorial_s2_done' : 'tutorial_s2_hint')
        },
        {
            id: 'shop', titleKey: 'tutorial_s3_title', textKey: 'tutorial_s3_text',
            target: '.shop-panel', interactive: true, dock: 'bottom', optional: true,
            before: activateUpgradesTab,
            note: () => (canAffordAnyUpgrade() ? 'tutorial_s3_afford' : 'tutorial_s3_poor')
        },
        {
            id: 'nav', titleKey: 'tutorial_s4_title', textKey: 'tutorial_s4_text',
            target: '#bottom-nav', dock: 'top', optional: true
        },
        {
            id: 'boss', titleKey: 'tutorial_s5_title', textKey: 'tutorial_s5_text',
            target: '#boss-fab', dock: 'top', optional: true
        },
        {
            id: 'forge', titleKey: 'tutorial_s6_title',
            text: () => {
                let unlocked = false, level = 80, coins = '';
                try {
                    unlocked = isPrestigeUnlocked();
                    level = getRequiredPrestigeLevel();
                    coins = formatNumber(getRequiredPrestigeTotalCoins());
                } catch (e) { /* fall back to the locked wording */ }
                return {
                    key: unlocked ? 'tutorial_s6_text_unlocked' : 'tutorial_s6_text_locked',
                    params: { level: level, coins: coins }
                };
            },
            target: '#nav-tab-prestige', dock: 'top', optional: true
        },
        {
            id: 'finish', titleKey: 'tutorial_s7_title', textKey: 'tutorial_s7_text',
            target: null, dock: 'bottom', optional: false
        }
    ];

    // ---- runtime state (reset by every start / teardown) ----
    let initialized = false;
    const S = {
        active: false, steps: [], idx: 0, mined: false, confirming: false,
        root: null, els: null, targetEl: null, resolvedTarget: false,
        raf: 0, autoTimer: 0, animTimer: 0, ro: null, prevFocus: null, cleanups: []
    };

    // ---------- helpers ----------
    function isUsable(el) {
        if (!el || !el.isConnected) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden';
    }

    function isFixedPositioned(el) {
        for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
            if (getComputedStyle(n).position === 'fixed') return true;
        }
        return false;
    }

    function viewportSize() {
        return { w: document.documentElement.clientWidth || window.innerWidth, h: window.innerHeight };
    }

    /** Real safe-area insets (notches), measured through a hidden probe that uses env(). */
    function safeInsets() {
        const probe = S.els && S.els.probe;
        if (!probe) return { top: 0, bottom: 0 };
        const cs = getComputedStyle(probe);
        return { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 };
    }

    function resolveTarget(step) {
        if (!step.target) return null;
        const el = document.querySelector(step.target);
        return isUsable(el) ? el : null;
    }

    /** Closes any open nav modal so the main view (and the nav bar) is what the player sees. Pure UI, no state change. */
    function showMainView() {
        try {
            if (typeof closeAllNavModals === 'function') closeAllNavModals();
            if (typeof setActiveNavTab === 'function') setActiveNavTab('main');
        } catch (e) { /* ignore */ }
    }

    // ---------- DOM ----------
    function buildDom() {
        const root = document.createElement('div');
        root.className = 'tutorial-overlay';
        root.setAttribute('data-tutorial-root', '1');
        root.innerHTML =
            '<div class="tutorial-safe-probe" aria-hidden="true"></div>' +
            '<div class="tutorial-blocker" data-side="top"></div>' +
            '<div class="tutorial-blocker" data-side="bottom"></div>' +
            '<div class="tutorial-blocker" data-side="left"></div>' +
            '<div class="tutorial-blocker" data-side="right"></div>' +
            '<div class="tutorial-shield"></div>' +
            '<div class="tutorial-spotlight is-empty" aria-hidden="true"></div>' +
            '<section class="tutorial-panel dock-bottom" role="dialog" aria-modal="true" aria-labelledby="tutorial-title" aria-describedby="tutorial-text" tabindex="-1">' +
                '<div class="tutorial-head">' +
                    '<div class="tutorial-guide" aria-hidden="true"><span class="tutorial-guide-face">🧔</span><span class="tutorial-guide-tool">⛏️</span></div>' +
                    '<div class="tutorial-head-text">' +
                        '<div class="tutorial-guide-name"></div>' +
                        '<div class="tutorial-step-counter" aria-live="polite"></div>' +
                    '</div>' +
                '</div>' +
                '<div class="tutorial-progress" role="progressbar" aria-valuemin="1"></div>' +
                '<div class="tutorial-scroll">' +
                    '<h2 class="tutorial-title" id="tutorial-title"></h2>' +
                    '<p class="tutorial-text" id="tutorial-text"></p>' +
                    '<p class="tutorial-note" role="status"></p>' +
                '</div>' +
                '<div class="tutorial-actions">' +
                    '<button type="button" class="tutorial-btn tutorial-btn-skip" data-act="skip"></button>' +
                    '<span class="tutorial-actions-spacer"></span>' +
                    '<button type="button" class="tutorial-btn tutorial-btn-back" data-act="back"></button>' +
                    '<button type="button" class="tutorial-btn tutorial-btn-next" data-act="next"></button>' +
                '</div>' +
                '<div class="tutorial-confirm" hidden role="alertdialog" aria-labelledby="tutorial-confirm-title" aria-describedby="tutorial-confirm-text">' +
                    '<div class="tutorial-confirm-title" id="tutorial-confirm-title"></div>' +
                    '<p class="tutorial-confirm-text" id="tutorial-confirm-text"></p>' +
                    '<div class="tutorial-confirm-actions">' +
                        '<button type="button" class="tutorial-btn tutorial-btn-back" data-act="confirm-no"></button>' +
                        '<button type="button" class="tutorial-btn tutorial-btn-next" data-act="confirm-yes"></button>' +
                    '</div>' +
                '</div>' +
            '</section>';
        document.body.appendChild(root);

        const q = (sel) => root.querySelector(sel);
        S.root = root;
        S.els = {
            probe: q('.tutorial-safe-probe'),
            blockers: {
                top: q('[data-side="top"]'), bottom: q('[data-side="bottom"]'),
                left: q('[data-side="left"]'), right: q('[data-side="right"]')
            },
            shield: q('.tutorial-shield'), spot: q('.tutorial-spotlight'), panel: q('.tutorial-panel'),
            guideName: q('.tutorial-guide-name'), counter: q('.tutorial-step-counter'), progress: q('.tutorial-progress'),
            title: q('.tutorial-title'), text: q('.tutorial-text'), note: q('.tutorial-note'),
            actions: q('.tutorial-actions'),
            skip: q('[data-act="skip"]'), back: q('[data-act="back"]'), next: q('[data-act="next"]'),
            confirm: q('.tutorial-confirm'), confirmTitle: q('.tutorial-confirm-title'), confirmText: q('.tutorial-confirm-text'),
            confirmNo: q('[data-act="confirm-no"]'), confirmYes: q('[data-act="confirm-yes"]')
        };

        // One delegated click handler for every tutorial button.
        root.addEventListener('click', (e) => {
            const b = e.target.closest('[data-act]');
            if (!b) return;
            const act = b.getAttribute('data-act');
            if (act === 'next') next();
            else if (act === 'back') back();
            else if (act === 'skip') askSkip();
            else if (act === 'confirm-yes') complete();
            else if (act === 'confirm-no') cancelSkip();
        });
        // Block wheel scrolling over the mask (the hole itself stays scrollable on interactive steps).
        root.addEventListener('wheel', (e) => {
            if (!e.target.closest('.tutorial-scroll')) e.preventDefault();
        }, { passive: false });
    }

    function buildProgress() {
        const bar = S.els.progress;
        bar.textContent = '';
        for (let i = 0; i < S.steps.length; i++) {
            const seg = document.createElement('i');
            seg.className = 'tutorial-progress-seg';
            bar.appendChild(seg);
        }
        bar.setAttribute('aria-valuemax', String(S.steps.length));
    }

    // ---------- rendering ----------
    function renderText() {
        if (!S.active || !S.els) return;
        const step = S.steps[S.idx];
        const total = S.steps.length;
        const els = S.els;

        els.panel.setAttribute('aria-label', tr('tutorial_dialog_aria'));
        els.guideName.textContent = tr('tutorial_guide_name');
        const counter = tr('tutorial_step_counter', { current: S.idx + 1, total: total });
        els.counter.textContent = counter;
        els.progress.setAttribute('aria-label', tr('tutorial_progress_aria'));
        els.progress.setAttribute('aria-valuenow', String(S.idx + 1));
        els.progress.setAttribute('aria-valuetext', counter);
        const segs = els.progress.children;
        for (let i = 0; i < segs.length; i++) {
            segs[i].classList.toggle('done', i < S.idx);
            segs[i].classList.toggle('current', i === S.idx);
        }

        els.title.textContent = tr(step.titleKey);
        let textKey = step.textKey, params;
        if (typeof step.text === 'function') { const r = step.text(S); textKey = r.key; params = r.params; }
        els.text.textContent = tr(textKey, params);

        let noteKey = '';
        if (!S.resolvedTarget && step.target) noteKey = 'tutorial_target_missing';
        else if (typeof step.note === 'function') noteKey = step.note(S) || '';
        els.note.textContent = noteKey ? tr(noteKey) : '';
        els.note.hidden = !noteKey;
        els.note.classList.toggle('is-success', noteKey === 'tutorial_s2_done');

        const last = S.idx === total - 1;
        els.next.textContent = tr(last ? 'tutorial_btn_finish' : 'tutorial_btn_next');
        els.back.textContent = tr('tutorial_btn_back');
        els.back.hidden = S.idx === 0;
        els.skip.textContent = tr('tutorial_btn_skip');
        els.skip.hidden = last;
        els.confirmTitle.textContent = tr('tutorial_skip_confirm_title');
        els.confirmText.textContent = tr('tutorial_skip_confirm_text');
        els.confirmNo.textContent = tr('tutorial_skip_confirm_no');
        els.confirmYes.textContent = tr('tutorial_skip_confirm_yes');
    }

    function setRect(el, x, y, w, h) {
        const s = el.style;
        s.left = Math.round(x) + 'px';
        s.top = Math.round(y) + 'px';
        s.width = Math.max(0, Math.round(w)) + 'px';
        s.height = Math.max(0, Math.round(h)) + 'px';
    }

    /** Positions panel, hole, ring and blockers for the current step. `allowScroll` lets it bring the target into view once. */
    function layout(allowScroll) {
        if (!S.active || !S.els) return;
        const step = S.steps[S.idx];
        const els = S.els;
        const vp = viewportSize();
        const target = S.targetEl && S.targetEl.isConnected ? S.targetEl : null;
        let rect = target ? target.getBoundingClientRect() : null;

        // Dock the panel (top / bottom) first, so the free region left for the target is known.
        let dock = step.dock || 'auto';
        if (dock === 'auto') dock = rect && (rect.top + rect.height / 2) > vp.h * 0.5 ? 'top' : 'bottom';
        els.panel.classList.toggle('dock-top', dock === 'top');
        els.panel.classList.toggle('dock-bottom', dock !== 'top');
        const insets = safeInsets();
        const panelH = els.panel.offsetHeight;
        const freeRegion = (d) => ({
            top: d === 'top' ? insets.top + PANEL_GAP + panelH + PANEL_GAP : insets.top + PANEL_GAP,
            bottom: d === 'top' ? vp.h - PANEL_GAP : vp.h - insets.bottom - PANEL_GAP - panelH - PANEL_GAP
        });
        let free = freeRegion(dock);
        // A fixed target (nav bar, floating button) cannot be scrolled away from the panel: if the panel would cover it, switch sides.
        if (target && rect && isFixedPositioned(target) && (rect.bottom < free.top || rect.top > free.bottom)) {
            dock = dock === 'top' ? 'bottom' : 'top';
            free = freeRegion(dock);
            els.panel.classList.toggle('dock-top', dock === 'top');
            els.panel.classList.toggle('dock-bottom', dock !== 'top');
        }
        const freeTop = free.top, freeBottom = free.bottom;
        const freeH = Math.max(40, freeBottom - freeTop);

        // Scroll only when needed (and never for position:fixed targets such as the nav bar).
        if (target && allowScroll && !isFixedPositioned(target)) {
            const fits = rect.height + HOLE_PAD * 2 <= freeH;
            const needs = rect.top - HOLE_PAD < freeTop - 1 ||
                (fits ? rect.bottom + HOLE_PAD > freeBottom + 1 : rect.top > freeTop + freeH * 0.4);
            if (needs) {
                const desiredTop = fits ? freeTop + (freeH - rect.height) / 2 : freeTop + HOLE_PAD;
                try { window.scrollBy({ top: rect.top - desiredTop, left: 0, behavior: 'instant' }); }
                catch (e) { window.scrollBy(0, rect.top - desiredTop); }
                rect = target.getBoundingClientRect();
            }
        }

        let hx, hy, hw, hh, hasHole = false;
        if (target && rect) {
            // Clip to the free region so a tall element (e.g. the Shop) never hides behind the dialogue panel.
            const x1 = Math.max(0, rect.left - HOLE_PAD), x2 = Math.min(vp.w, rect.right + HOLE_PAD);
            const y1 = Math.max(freeTop - HOLE_PAD, rect.top - HOLE_PAD), y2 = Math.min(freeBottom + HOLE_PAD, rect.bottom + HOLE_PAD);
            hx = x1; hy = y1; hw = x2 - x1; hh = y2 - y1;
            hasHole = hw > 4 && hh > 4;
        }
        if (!hasHole) { hx = vp.w / 2; hy = vp.h * 0.35; hw = 0; hh = 0; }

        const b = els.blockers;
        setRect(b.top, 0, 0, vp.w, hy);
        setRect(b.bottom, 0, hy + hh, vp.w, vp.h - (hy + hh));
        setRect(b.left, 0, hy, hx, hh);
        setRect(b.right, hx + hw, hy, vp.w - (hx + hw), hh);
        setRect(els.shield, hx, hy, hw, hh);
        els.shield.style.display = (hasHole && !step.interactive) ? 'block' : 'none';
        setRect(els.spot, hx, hy, hw, hh);
        els.spot.classList.toggle('is-empty', !hasHole);
    }

    let scrollOnNextLayout = false;
    /** Coalesces layout work into one rAF. `withScroll` (resize / rotation) may also bring the target back into view. */
    function schedule(withScroll) {
        if (!S.active) return;
        if (withScroll === true) scrollOnNextLayout = true;
        if (S.raf) return;
        S.raf = requestAnimationFrame(() => {
            S.raf = 0;
            const sc = scrollOnNextLayout; scrollOnNextLayout = false;
            layout(sc);
        });
    }

    function showStep(idx) {
        if (!S.active) return;
        clearTimeout(S.autoTimer);
        S.confirming = false;
        S.els.confirm.hidden = true;
        S.els.actions.hidden = false;
        S.idx = Math.max(0, Math.min(S.steps.length - 1, idx));
        const step = S.steps[S.idx];

        showMainView();
        try { if (typeof step.before === 'function') step.before(S); } catch (e) { console.warn('Tutorial step prep failed:', e); }

        S.targetEl = resolveTarget(step);
        S.resolvedTarget = !step.target || !!S.targetEl;   // a vanished target never freezes the tour: the step just loses its spotlight
        if (S.ro) {
            S.ro.disconnect();
            if (S.targetEl) S.ro.observe(S.targetEl);
            S.ro.observe(S.els.panel);
        }

        // Step-change motion: the panel content fades in and the ring glides to its new place.
        S.els.panel.classList.remove('is-swapping');
        void S.els.panel.offsetWidth;
        S.els.panel.classList.add('is-swapping');
        S.root.classList.add('is-animating');
        clearTimeout(S.animTimer);
        S.animTimer = setTimeout(() => { if (S.root) S.root.classList.remove('is-animating'); }, 380);

        if (S.els.progress.children.length !== S.steps.length) buildProgress();
        renderText();

        // Wait one frame so the UI (e.g. a switched Shop sub-tab) has painted before measuring.
        requestAnimationFrame(() => {
            if (!S.active) return;
            layout(true);
            requestAnimationFrame(() => layout(false));
            if (S.els.next && !S.els.next.hidden) S.els.next.focus({ preventScroll: true });
        });
    }

    // ---------- navigation ----------
    function next() {
        if (!S.active) return;
        if (S.idx >= S.steps.length - 1) { complete(); return; }
        showStep(S.idx + 1);
    }

    function back() {
        if (!S.active || S.idx === 0) return;
        showStep(S.idx - 1);
    }

    function askSkip() {
        if (!S.active) return;
        S.confirming = true;
        S.els.actions.hidden = true;
        S.els.confirm.hidden = false;
        schedule();
        S.els.confirmNo.focus({ preventScroll: true });
    }

    function cancelSkip() {
        if (!S.active) return;
        S.confirming = false;
        S.els.confirm.hidden = true;
        S.els.actions.hidden = false;
        schedule();
        S.els.next.focus({ preventScroll: true });
    }

    // ---------- persistence ----------
    function persistCompleted() {
        gameState.tutorialCompleted = true;
        try { saveGame(); } catch (e) { console.warn('Tutorial save failed:', e); }
        // Verify the flag really reached storage (GCStore never throws, it just reports failure); retry once.
        try {
            const stored = (window.GCStore && GCStore.getJSON) ? GCStore.getJSON('goldClickerSave') : null;
            if (!stored || stored.tutorialCompleted !== true) saveGame();
        } catch (e) { /* the pagehide / visibilitychange flush installed by initGame is the final safety net */ }
    }

    /** Finish or skip: persist first (so closing the tab right now is safe), then remove every trace of the tutorial. */
    function complete() {
        if (!S.active) return;
        persistCompleted();
        teardown();
        try { if (typeof updateUI === 'function') updateUI(true); } catch (e) { /* ignore */ }
    }

    // ---------- listeners ----------
    function onKey(e) {
        if (!S.active) return;
        if (e.key === 'Escape') {
            e.preventDefault(); e.stopPropagation();
            if (S.confirming) cancelSkip(); else askSkip();
            return;
        }
        if (e.key === 'Tab') {
            // Keep keyboard focus inside the dialogue (the mask already makes the rest unreachable by pointer).
            const focusables = Array.prototype.filter.call(
                S.els.panel.querySelectorAll('button'), (el) => !el.hidden && !el.closest('[hidden]'));
            if (!focusables.length) return;
            const first = focusables[0], last = focusables[focusables.length - 1];
            if (!S.els.panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
            else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            return;
        }
        if (!S.confirming && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
            e.preventDefault();
            if (e.key === 'ArrowRight') next(); else back();
        }
    }

    function onMineClick() {
        // Pure observer: the game's own handler performs the mining; the tutorial never mines on the player's behalf.
        if (!S.active) return;
        const step = S.steps[S.idx];
        if (!step || !step.watchMining || S.mined) return;
        S.mined = true;
        renderText();
        schedule();
        clearTimeout(S.autoTimer);
        S.autoTimer = setTimeout(() => {
            if (S.active && S.steps[S.idx] === step && !S.confirming) next();
        }, AUTO_ADVANCE_MS);
    }

    function addListener(target, type, fn, opts) {
        target.addEventListener(type, fn, opts);
        S.cleanups.push(() => target.removeEventListener(type, fn, opts));
    }

    function bindGlobal() {
        addListener(document, 'keydown', onKey, true);
        addListener(window, 'resize', () => schedule(true));
        addListener(window, 'orientationchange', () => { setTimeout(() => schedule(true), 250); });
        addListener(window, 'scroll', () => schedule(false), { passive: true });
        if (window.visualViewport) {
            addListener(window.visualViewport, 'resize', () => schedule(true));
            addListener(window.visualViewport, 'scroll', () => schedule(false));
        }
        const mineBtn = document.getElementById('click-button');
        if (mineBtn) addListener(mineBtn, 'click', onMineClick);
        if (typeof ResizeObserver === 'function') S.ro = new ResizeObserver(() => schedule(false));
    }

    // ---------- lifecycle ----------
    function start() {
        if (S.active || !document.body) return false;            // never two tutorial instances
        showMainView();
        S.steps = TUTORIAL_STEPS.filter((s) => !s.optional || !!resolveTarget(s));   // locked/hidden optional features drop out
        if (!S.steps.length) return false;
        S.idx = 0; S.mined = false; S.confirming = false;
        S.prevFocus = document.activeElement;
        S.active = true;
        buildDom();
        bindGlobal();
        showStep(0);
        return true;
    }

    function teardown() {
        S.active = false;
        clearTimeout(S.autoTimer);
        clearTimeout(S.animTimer);
        if (S.raf) cancelAnimationFrame(S.raf);
        S.raf = 0;
        if (S.ro) { S.ro.disconnect(); S.ro = null; }
        S.cleanups.splice(0).forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
        if (S.root && S.root.parentNode) S.root.parentNode.removeChild(S.root);
        S.root = null; S.els = null; S.targetEl = null; S.confirming = false;
        try { if (S.prevFocus && S.prevFocus.isConnected && S.prevFocus.focus) S.prevFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
        S.prevFocus = null;
    }

    function blockingOverlayOpen() {
        return !!document.querySelector('.modal-overlay.open, .offline-modal-overlay.open, .depth-modal-overlay.open');
    }

    /** Called once from initGame(). Starts the tutorial only for players who have not completed it. */
    function init() {
        if (initialized) return;                    // repeated initialization attempts are harmless
        initialized = true;
        if (window.i18n && typeof window.i18n.onChange === 'function') {
            window.i18n.onChange(() => { if (S.active) { renderText(); schedule(); } });
        }
        if (gameState.tutorialCompleted === true) return;

        // Wait (bounded: at most ~20 s, only before the tour starts) for start-up pop-ups such as the offline-earnings modal.
        let tries = 0;
        const attempt = () => {
            if (S.active || gameState.tutorialCompleted === true) return;
            if (blockingOverlayOpen() && tries++ < 40) { setTimeout(attempt, 500); return; }
            try { start(); } catch (e) { console.warn('Tutorial could not start:', e); teardown(); }
        };
        setTimeout(attempt, 450);
    }

    return {
        init: init,
        start: start,
        restart: start,   // support / debug helper: replays the tour; completing it saves `true` again
        skip: function () { if (S.active) complete(); },
        isActive: function () { return S.active; },
        steps: TUTORIAL_STEPS
    };
})();
window.TutorialManager = TutorialManager;


/**
 * Initializes the game: loads save data, binds events, starts loops.
 */
function initGame() {
    loadGame();

    // === NEW (supports Adaptive Biome Particles): re-apply the current
    // biome's visuals on startup so a returning player's particle field
    // (and depth indicator) correctly reflect their saved biome instead
    // of only updating on the next level-up.
    applyBiomeVisuals(false);

    // Reflect loaded volume on the Settings slider / icon / percentage
    gameState.volume = clampVolume(gameState.volume);
    gameState.soundEnabled = gameState.volume > 0;
    updateVolumeUI();
    initBgm();   // background music: Settings toggle + pause/visibility hooks (audio itself starts after a user gesture)

    // Build the Helpers tab once, bind the offline modal once, then compute
    // offline progress exactly once for this page load.
    initHelpers();
    initAfkShop();
    initOfflineModal();
    applyOfflineProgress();

    // Bind manual click button
    dom.clickButton.addEventListener('click', handleManualClick);

    // Legacy sound toggle button (now hidden; kept so existing logic stays intact).
    // It maps onto the volume system: muted -> 0, unmuted -> 100%.
    dom.soundToggle.addEventListener('click', () => {
        initAudio();
        setMasterVolume(gameState.volume > 0 ? 0 : 1, true);
    });

    // Settings > Volume slider: live update while dragging, save on every change.
    if (dom.volumeSlider) {
        dom.volumeSlider.addEventListener('input', () => {
            initAudio();
            setMasterVolume(dom.volumeSlider.value, false);
        });
        dom.volumeSlider.addEventListener('change', () => {
            setMasterVolume(dom.volumeSlider.value, true);
        });
    }

    // Bind prestige button
    dom.prestigeButton.addEventListener('click', handlePrestigeClick);

    // Bind Bulk Buy multiplier toggle buttons
    if (dom.buyAmountButtons) {
        dom.buyAmountButtons.forEach((btn) => {
            btn.addEventListener('click', () => {
                const amount = btn.dataset.amount === 'MAX' ? 'MAX' : parseInt(btn.dataset.amount, 10);
                setBuyAmount(amount);
            });
        });
    }
    // Reflect the loaded/default buy amount as the active toggle on first render
    if (dom.buyAmountButtons) {
        dom.buyAmountButtons.forEach((btn) => {
            const btnAmount = btn.dataset.amount === 'MAX' ? 'MAX' : parseInt(btn.dataset.amount, 10);
            btn.classList.toggle('active', btnAmount === gameState.buyAmount);
        });
    }

    // Bind Dwarven Forge (skill tree) modal controls
    dom.skillTreeClose.addEventListener('click', closeSkillTree);
    dom.skillTreeOverlay.addEventListener('click', (e) => {
        if (e.target === dom.skillTreeOverlay) closeSkillTree(); // click outside the modal window
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dom.skillTreeOverlay.classList.contains('open')) closeSkillTree();
        if (e.key === 'Escape' && dom.depthModalOverlay.classList.contains('open')) closeDepthDiscoveredModal();
    });

    // Bind Dwarven Forge sub-tabs (Skill Tree vs. Relic Excavation)
    if (dom.forgeTabBtnSkills) dom.forgeTabBtnSkills.addEventListener('click', () => switchForgeTab('skills'));
    if (dom.forgeTabBtnRelics) dom.forgeTabBtnRelics.addEventListener('click', () => switchForgeTab('relics'));
    if (dom.relicDigBtn) dom.relicDigBtn.addEventListener('click', handleDigRelic);

    // Bind "New Depth Discovered!" modal controls
    dom.depthModalClose.addEventListener('click', closeDepthDiscoveredModal);
    dom.depthModalOverlay.addEventListener('click', (e) => {
        if (e.target === dom.depthModalOverlay) closeDepthDiscoveredModal();
    });

    // Bind Achievements modal controls
    dom.achievementsClose.addEventListener('click', closeAchievements);
    dom.achievementsOverlay.addEventListener('click', (e) => {
        if (e.target === dom.achievementsOverlay) closeAchievements();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dom.achievementsOverlay.classList.contains('open')) closeAchievements();
    });

    // Bind "Battle Pass" modal controls (Expedition Pass reward track ONLY)
    dom.passClose.addEventListener('click', closeExpeditionPass);
    dom.passOverlay.addEventListener('click', (e) => {
        if (e.target === dom.passOverlay) closeExpeditionPass();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dom.passOverlay.classList.contains('open')) closeExpeditionPass();
    });

    // Bind "Quests" modal controls (Daily/Weekly Quests + Daily Login Rewards)
    dom.questsClose.addEventListener('click', closeQuestsModal);
    dom.questsOverlay.addEventListener('click', (e) => {
        if (e.target === dom.questsOverlay) closeQuestsModal();
    });
    dom.passBodyTabBtnQuests.addEventListener('click', () => switchPassBodyTab('quests'));
    if (dom.passBodyTabBtnDaily) {
        dom.passBodyTabBtnDaily.addEventListener('click', () => switchPassBodyTab('daily'));
    }
    dom.passQuestTabBtnDaily.addEventListener('click', () => switchPassQuestTab('daily'));
    dom.passQuestTabBtnWeekly.addEventListener('click', () => switchPassQuestTab('weekly'));
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dom.questsOverlay.classList.contains('open')) closeQuestsModal();
    });

    // Bind the Key Altar (chest opening) and Bosses & Key Chests modal shell
    initKeyAltar();

    // Bind the fixed 3D Bottom Navigation Bar
    initBottomNav();

    // Shop: nav tab, modals, HUD badges, rune-slot sync
    initShop();

    // Localization: re-render dynamic UI whenever the language changes (i18n.js)
    gameState.language = getLanguage();
    if (window.i18n) window.i18n.onChange(refreshLocalizedUI);

    // Initial UI render (synchronous so the very first paint is already complete)
    updateUI(true);
    updateQuestBookBadge();
    updatePassUI();

    // Guard against double initialization (e.g. initGame called twice): only ever
    // one game loop, one auto-save timer and one unload listener.
    if (!window.__goldClickerLoopsStarted) {
        window.__goldClickerLoopsStarted = true;

        // Start the passive income loop (runs every 1000ms)
        // Arrow wrapper: resolves window.gameLoop at call time, so the wrapper that
        // adventures.js installs later (material drops, event timers) actually runs.
        setInterval(() => {
            if (isGamePaused()) return;
            try { gameLoop(); } catch (e) { console.warn('gameLoop error:', e); }
        }, 1000);

        // Auto-save every 10 seconds
        setInterval(() => { try { saveGame(); } catch (e) { /* ignore */ } }, 10000);

        // Final save on every way the page can end. pagehide + visibilitychange are the reliable ones
        // (mobile / bfcache / tab close); beforeunload is only an extra net. flushSave() is synchronous,
        // coalesced (several events in one instant = one save) and can never throw.
        let lastFlushAt = 0;
        const flushSave = () => {
            const t = Date.now();
            if (flushSave.busy || (lastFlushAt && Math.abs(t - lastFlushAt) < 300)) return;
            flushSave.busy = true;
            try { saveGame(); lastFlushAt = t; } catch (e) { /* saveGame already guards itself */ } finally { flushSave.busy = false; }
        };
        window.addEventListener('pagehide', flushSave);
        window.addEventListener('beforeunload', flushSave);
        document.addEventListener('freeze', flushSave);   // Page Lifecycle API (Chromium): tab is about to be frozen / discarded
        document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
    }

    // Kick off the Random Mini-Event (Golden Meteor / Glowing Crystal) spawn timer
    scheduleNextMiniEvent();

    // First-time tutorial: starts only for players whose gameState.tutorialCompleted is not true (safe to call twice).
    try { TutorialManager.init(); } catch (e) { console.warn('Tutorial init failed:', e); }

    // Poki SDK: init (never fatal), gameLoadingFinished, gameplay events. Guarded internally against double init.
    try { GCAds.boot(); } catch (e) { console.warn('Poki SDK boot failed (game continues without ads):', e); }
}

// Start everything once the DOM is ready.
initGame();


/* ==========================================================================
 * Coin glyph compatibility (🪙 U+1FA99, Unicode 13)
 * Older Windows emoji fonts lack this glyph, so desktop shows an empty box.
 * If (and only if) the browser cannot draw it in colour, every 🪙 in the page
 * is wrapped in a span that paints the same coin artwork as an image.
 * The span keeps the original character as text, so textContent is unchanged
 * and game code that compares/sets text keeps working. Nothing happens on
 * platforms that already render the emoji (Android, iOS, macOS, Win 11).
 * ========================================================================== */
(function gcCoinGlyphFallback() {
    'use strict';
    var COIN = '\uD83E\uDE99';
    var CLS = 'gc-coin-glyph';

    function glyphRendersInColour() {
        try {
            var c = document.createElement('canvas');
            c.width = 48; c.height = 48;
            var ctx = c.getContext('2d', { willReadFrequently: true });
            if (!ctx) return true;
            ctx.textBaseline = 'top';
            ctx.font = '32px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
            ctx.fillStyle = '#000';
            ctx.fillText(COIN, 4, 4);
            var d = ctx.getImageData(0, 0, 48, 48).data;
            for (var i = 0; i < d.length; i += 4) {
                if (d[i + 3] > 40 && (Math.abs(d[i] - d[i + 1]) > 24 || Math.abs(d[i + 1] - d[i + 2]) > 24)) return true;
            }
            return false;
        } catch (e) { return true; }
    }

    var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, OPTION: 1, TITLE: 1, NOSCRIPT: 1 };

    function wrapTextNode(node) {
        var p = node.parentNode;
        if (!p || SKIP[p.nodeName]) return;
        if (p.classList && p.classList.contains(CLS)) return;
        var parts = node.nodeValue.split(COIN);
        if (parts.length < 2) return;
        var frag = document.createDocumentFragment();
        for (var i = 0; i < parts.length; i++) {
            if (parts[i]) frag.appendChild(document.createTextNode(parts[i]));
            if (i < parts.length - 1) {
                var s = document.createElement('span');
                s.className = CLS;
                s.textContent = COIN;
                frag.appendChild(s);
            }
        }
        p.replaceChild(frag, node);
    }

    function scan(root) {
        if (!root) return;
        if (root.nodeType === 3) { if (root.nodeValue.indexOf(COIN) !== -1) wrapTextNode(root); return; }
        if (root.nodeType !== 1 || SKIP[root.nodeName]) return;
        var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
        var hits = [], n;
        while ((n = w.nextNode())) { if (n.nodeValue.indexOf(COIN) !== -1) hits.push(n); }
        for (var i = 0; i < hits.length; i++) wrapTextNode(hits[i]);
    }

    function start() {
        if (glyphRendersInColour()) return;
        document.documentElement.style.setProperty('--gc-coin-img', 'url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAA2MUlEQVR42u29d5Rcx33n+6mqGzpPz/RkTMAgJ5JglihxSYq2JVHBtiTQq9Uev31+CrbXaW1rj32en0HIfkc+a9m7tmzZCqvnKNmAgpVISRRFQWKOIEgipwEwGAwm9fT0dLj3VtX7494JiARIStSxfc9pkmd4u6vq96v6xe/vV4LX8Nm6FfmO3g+q6z/4SS2EMPN/X7Wqu+NLf/vm0qnTtf6RserV2Yy7fll3bqhQ8FpXDBZX5wp+zmqLEPH71oJQgmqlWT0yXD5YqQTTI6erR+dq4d5lXbndvd2ZE+/6P741eejQ6fH5May18ulPfUh97dSn9LZtmNeKBuK1Gtdu3yLlz+3Q1sZ/ePe711z9sXvetOHkaOVW11E3rBoqbi4NFj2sBWNB25jSoYn/fcFfFeDK+N9KgBQgBJPD5eDQ0fKuMNJP9fUUfvDb93x3zxe/eGD3/FfMP29R4u4dBrD/mhkgrN0qhNi2dLetunfHlndc+7qe26oTjetXrWnrI5MGIpgLMKHRWCviWQohBSCSfS/Omfo8U6y1xiZ/sIAQVrpSkfUAB2p1Dh2YOplrTz397GOjO+/asuNrwKHFn9kqhdhmf1TM+FEwQDz44G3qzju/H5mYMvKd71x94x/+zht/o3+o9VYPuyzTXQQdQC2MdKhBIJRUEiUFUi0S2Ca8s/OnYH76NmaIkMmIcpFBRoM2VhttsFjlKsi4DsqjdrpMgBg5cXT6B7/3Rw/9r69+9eCTgJFS8MAD/8G5446d+ofNCPHDlvH33GOFEEID/j985q5bVq8q/c61Ny6707UofAWNyJow0tZaKR1HCteLRUezjmk2MUETUysTVGaIKhVM0MA0K4SVGSx+sogmbqEF6ReQXgqnUMArtCAzRaTnI30f/DQYiw0DTBQZIYSRrqNIOYKmJhToZ58ceeDgock/+s/vv/cRoGmtVffcI+wPU0f80BiwffsWdffdOzTAVz//7p/qWt7ygZs2tr+HnA/VJlis0QYpANcTOC62XqU5cYZw8iTB+CkaE2XC6TF0A6QHygWkQHlOstEdwGBNTB8dRGAsOgQTgEqB29pFqr2I19GLW+rDb+9EpHMQhRAG1liQSoJAzM/tiRcnvjB2bObT73zvF7997lp+7Blg7bzExq4bal/zpe0//XvtHZn3dgx2OlQqkdFWSSVFrChjQjZGT1A/to/mmTGaE6OElQC3oPBbXFQqhfA8pFJIxyKkQHoOVke4pSGE4xOM7UMoBxNEWGMxkcBojQ0CdKNBcyYkrGjcgoff3oPf2UV6+TpSPf3xpHUE1mK0sVIJTaHgjA+fiSbGa59/191f+cN9RycOLF3Xjy0DrN2ihIh3yva/+5lf+Q+v7/vdrlWtvdQja+qBFlI4wnHjUaOAuSN7mdnzPNHMBLpRx0k7pNrzuPkUQkmUI0CAwMYqwBpsFMVU0AHZ9W9FeGmqu76McFywBuG4CCERAiwCLOjIYrUhnG3QmJglqkeoVBqnpZ2WDVeRXbEeHA8s2CjEGhvJtKdIO2Ls0PSp7z968qN3//y//MW5a/yxYsCDD2517rhjW7T1w7f03vWO1X9w4w09vyCkgKaOTKSVdByB62HqM9QO7mFy11PY+gzKE3htBVJtGaQrkwnFJqc9yxaxCDeNky2ggwCkIr36doRyaRx+GNOYQfoZ9NwMNqwtLk0k+jj+BxYwoaExVSOYqqADi0i3UNp8A5nVG5DpFoj1hJWO0vjKscby5FOjn733awf/n21//Mip+bX+uDBAWLtFCrFDf+ZPf/Kn3nDH4F+s27xsNTN1a6xFYgV+GoIGc4dfZOaFp2mMjpHqTOMVs6SK/rz1eAl7Q4DQNGsFvIEbKGxYD2EQf7Dg+qBcakcOUD/0JF5mBqy6uAEjFq3ZRrlJUJ6jcaZOqqeLlk3Xk125EbxUbAggrBQCWtJi366Rgw8/OPwr7//N+7+dnIRX7DuIV058ixDCPnTf+96/fnPnn7Z1ZPJUmgYlJEhwHZqjhyk/9SjV4WFSJZ9MZxE358Q7Ul+mgSEFwfQc4wdmKGy4ia7XvR6V8hLlGzDx9FPM7n6I1pVFvNZs7LxdzgKUBCxhNaJ2pkxjsklucJDiDa/H71kJYQQY0NZQ8OXUeG12764zv/nGt/7jZ6y1ImGkfS0YIB0lTaSN+MG3/tNHb3jD8t9OSSNNQxspUTgOGM3MrkcoP/ME0g3I9nXi5lyEBBvZK56BVIpmZY7qWEDnm95Nqn8QtKY5McPY/V8g19rEb8thoisQ0fPTcATWQFgNmTt5BhN6FK+7iZbNt4BUEEUYg5YpJRtGmqcePvaxW9/8ud91lLSRNjLm0pU/6uUyznGkjbRR939xy5/e/vY1v+U0Q2ECbaUUCtcjmp3kzLe2Uz20l1RHgZZVvbjZNDYK4qmKK2e/BZSytKy9itTAJmZe3EPtxDHyq1aRytSgOY4VzpVtyPl5JOTz8nlS7UVMpKkeOkhj5DCpZYPITB5htTShsa6wcmBDxxvfeHVX8W//6cX7HUcaY6z4UZ2AebGj7t3+nj9565b1v0alGbv9WIHn0Th+mLHv3oc0NXJD7bgpiyouR6VbaZ7aDcKCFVd8cq0FgcHt2UT5eIOZ5x5CSCis3UzLUBfR+AvzL105GZI5+b1Xo+vT6PIxwoagenQCIzN0vemtpAZWQhAAIjZKC764b8feP7/r7i/8lrVWvxxxJK9wCy4Q/5tf3PKxt757/a+ZuSBKFi3wPGaff5LT3/oSjhdRXNuG44Nu1FG5DpzudYCNTT0dLoYWLpdMwoJUnHn0SWb3PUb35m66r+2hfmI3E088GR9ocYXi2BqsDrFRCFic7nWoXEdsFvvEa/AiTn/rS8w+/yR4XrxWazFzQfTWd6//tW9+ccvHhBAqMSTED+sEiETpmAe+cve22+9a9/uy2QwItIuSAs+j8uyjTD3+XVKdefKDPTgtvQgpMdrgda9HZloJTj6HDaoI1yMqn0HPnbmi2drIEFRDvBYfKRen3yzXcbMewpFXtAdVthOn2IkNA4SXw+u7BlObJji9F6kk1hiimVPMDo/SODNL281vonDt6+OToI3FU6Hxfe979+77yJ0/vX2rtVYKIS47mHfZOmD79i1q06a7zfa/efuH7nrr6j+WWhsTaoUUQvgpZp55lPLTD5IfKJLtaaF2eorZqSyF9Tfjda9AECtl1dKD097HzNFpqof24OflYhDtcnggBW7GTbghFpbppN3zI6SXPk6ApTI8g0kPkd94LSrXBTpEKB+nYzm4Jc48ewAze4JcbwvKk1T27UMIh1TfENZoYSMjpTV2cLB4+6Z1rac3Xfu+p7Zv36J27Njz6jFg69at8ld+5RPm0x+/8/Z3vm3dP6RzvkMYIZQUwvWYefZRyk89SG6giF/MYiON8hSzx44ytW+EbG8vTiaNNQZrYfS7O5l66gHyy1K4Ke/i8f2Lig2RiI4GmDg8wcvQgUJILAHjT+8imI3IDgzEsRQlaUxMMfyVr2MqByn0FsBanLSP8hWVvQkTlg0isAJtEJ4j+nryP7FyKPfwz//C149u3bpV7ty5075iHbB161YJsHFjx8o7b1v52ZbOXMo0I4sQAteluvcZyk9+NyF+ZiEwJh1F54ZO8sUZzFwZUmlEOoPQIcpM0bWxRLo1FztgV/roAOF4pAZvJjX0OoTyQDdfRujEkm7N0bWxhDJTCB0i0hlIpTFzZfLFGTo3dCIdlagLg1/MkBsoUn7yu1T3PgOuC0II04xsS2cudedtKz+7cWPHyqW0eyU6YEHuv/DI//n5jTf3/Ucz24yENY7wPOonhpl4YAeZnmy8840566etDvE7+vDX38XkQw9QHz1Oz5vfgwhOMrfne3G48nJEpRDxKTEapItbGsTr3oDMtcch/0Rmh+OHwESx3T7/nctRLLpBdsPtWK+P0W99gXTPAKU33klz7700x08ilHvWPIWUNMtz1EbnaL9zC+n+QWwQYIWMZN53Xnz85D9tuuX/e+/l6AN16R2yXQmxyXzl73/mvde/rm+rK9A2ipT0fKFnxjj9na/gtzikO/MX9GiFFBjZzuiju2kc24VuVCnvPYjKFFFiDqsjxCXlf5Jk0SEgcFp68Ve8Hq97A8LPLRjxwk3jtCxDFbogbGAas1gTJeHqSxPfWoP0MtSrGUYf+DamNk5wZoTKiUn8fAaiygXtYSebwkSGysGD5AYGkJkWbBQKASbXkrr65qs6D6y75r3PW7tdbdu2w17xCbAWCdj/671re37vnp/4wdCK4pCuNq1USloMp+/9AqY6RnF1exyhvODGFZSPThE2Ne1r2lG+YuZEhdqZKqXVbTgZD3vRkEHsHdkoQOW78LrW4nasBOmAUNiwTjh+GAC3YyXCTYPVYC3h+EHCsf1EldMIx4uZeJHTIKQgqgVMHpwi05mjpb+AbmomDkzg+oriUNtFxaRwHMqHJpHZTrrveg8CidHaqJwvjh4pH/3De75z6//+/P7RhBTmChlghRDC/uD+9/3VG39izS/qqYpRjpS4HjNPPULlxR9QXNOVHC57UddVBzq2UKzBGJCORDfjTJ90L2QyJm6pjhB+Fq9rA07HSmSqJRYvQhJOHiU8/SLRzKnYAmrpxe3eiFsaisWU42HrZcLJYYLR5zHNKkI5icqz5w1nwtg1V77CRAYp47RmVA9Rnro4lYRACMH0/tMUNt5Kyw23QBigI2NUW0E+9J0Df33rT/7jL83T8kI/4VyEbkJJaT/wXzbeuHljxwfM7JxRSkqUR3NshPLzD1MYbEWI+AhfSoI4aWdBN4jEjpdu4v/bC8n5CJSL27Uar2cDMtOW8CREz00QjDxPVD6FDWsIPwNANH0SXZ0imjiMt+xqVKaESOXxeq/Cae0jHNtHcOZALMrO1Q+WeCMQz23hf1mTzN1e2jVHkOtvpfz8w6T6B/E7lqFsIM3snNm8seMDH/gvGz+rpHwyyVrby9IBG7dvUdt3vKi+8Hc/87ddg8WVIjSx1YNm/KGdOG6DTHsWG5mXVuP2pc5cLOdtFCCkwin0kFpxC173eoSXASymMUvz5C6ax59Az44jhMBpHSA9eDNuaSj2ZBsV9Nwk0fQxbNRAplri5IybxmnpxWnpwQY1TLOK1WGiWF9ibvayTCmctIcOLfUzs+RXrIj1Eliv6KtNq0sr/9dfPf25jdu3iAv5Bur8xMptzjveca/+s4/e+Y7/cOvAb7iuUibUQri+qB1+jvrBJ8j3F+Od8YqD2Yk9HwU4hR78/uvxl9+I9HKgXGxQJRzbT+Poo0TTx8FEOIVO/L7rSA3egEy1IFMF3PYhpJeFqI6pz6ArZ4jKJ+Ld7ecQXhrppnE7ViL9fKyo6+XYAJDyFa4BrLF4OZfGyHGcbB63ox8ThQgpre+qnq5SZvf7f+nrex988Dbnb/922FyK58La7VKIu/3Dz31gx4qru+8y0w0tlVBGG0a/8TkyLU3cXOrSR/NyY5s6QqQKeN0bcDtWIbxsIuchnDhKeHoPUWU09iu8HF7vRtzSCkSqkFhGdnEZysU2KoSTRwhOvYgJqrGMLfTgdm/AbR+KX5cONpgjHD9EcHoPplFJ9MMr201CCsJqg9qMT8/b/hNSSYy2Wram1JHdp+9dec2nt1i7vSnE3WclcdS5u39o6GP6k3/xlpvXry39XiHruzqMhExnxOyeZ9GTB0mVsi8//TAvYK0BqXC71pFacQtO60Cc09UhenacxrFHCEf3YOrTCC+N17mW1NAtOG3LE6crXEgxLhDOaISTQhW6cYp9gMA0ZzG1afTMKXT1DNLLI10f4fqofFc8rvLQ1YlYeSNe/omwID2HaLaCFSn8ZYPoIBBSSGpzwbK169ofuOHmjw6fewrOUsK33/49A8LZtKb0rmVrurJ6uho5nuOY2QrVI3tIF1yEVFitr/ycJol0KV1Uaz9+32ZkuhhjTYzG1GYIRl8gnDyKDWoI5eG2DeH2bsQp9MQE1+GSc2svYDzF5rDMFEkNvR6ntJzw1ItE5ZNEE0fRlTHc0hBezyZkugWZbsHv24xbWk7z5C50eQSjw5jJ9srBcUIq/IJL9cgecivW4aR8oetBtGxNV3bTcOVdwGMJjc/XAVu3Iu+4Y5v5m796W8/VG0sfLxb9rA0iKdNpMXdwD8Ho86Q7i0scLnt5x1YIsBqrEzm//Gb8vusQSR7XNOfl/MOxuDFR7HD1X4s/eBMyXVhEwiVYz5f8JDkBmW7BLa1A+lnQIaZejhX11LFYUfo5hJtGOD5uaRUy0xor6vp0csDU5W9/4nFV2ieYGkf6rXg9fdggEFIJTBANbb66+3PX3vi+ytatyJ07Y+6KRWW+VQqxzXzpH37m7T/7vqu+RrmhUVIZbZh69NuIxjFSbQVMqEEqhHKxUfPSu8QS7/pMEb/nKpzScoSbATQYSzhxiOD0XnR1HKEchPRwOtfgtQ8iUy3YsJGcnpeTO7ILPopwU5jGDMHEMNGZA1gTYHWEynXgda/HbV8VMxeFDWtEk0cJxvaha1MIoV4iyioQjh/nN4xGuorGVAWbWk7b638qBn1poymm1Jf/8fl3vOs//8vX52l9lgia/4Prq/cabazFCuU4hBOnaZ45SnGwgNEWaw1Oug2nYw3BqediCIiQF3DILEJ5+L0bcTrXINOtYELQAdHsGYKRXejZM1ijF2It1kTomRHq08PYxOkSr1zVx3gh6cQKOBFTQrno6gSNI48Qjh/CW7YZJ9+JcDzcno04rf2EY/sJxvZjTXDOBkg2hTUIN43Xew3R+AGi6gRGS1KtecrDRwmnp/C7u9G6KYQ21vXVe4GvLwUon6UDPvzhtfnbbhm4Sza0sEIIIk3j9DBemiRrZLC6ifBzeL1XEZ5+AR024l0iZRJ7EWBCVKEHf+gWVKYY/3jUjO19E2EbFZzWftzS8oR5ZkmCKpq3o19dxN78plgaH0rGtkZjGxVstg0hPIgChJfFG7ge1b6S5tFH0JVRkPMbJQRjsFbj+LHDpyunsNPHwfhYR+KloXF6GL+9AymEFA3NbbcM3PXhD6/N//Ef7589iwHzXlpQTb8lm1FF4rQj1hgaI4dIt2ZQLb04ysEEAU7bchDgdqxBuGlkKo2pV9HVKZACazQq3xkT3+jFEbAI5eJ2r+O1K024BIuWztUasMSBw3wnUflkrJyNxcl3ItM5TKOOU+yPPf625diwgfQ8rI7wzSnqI4cobLgu9mGtJZtRxaCafguwY34UCbBj+xYJ8Pa71t4pHQXGWKTE1MoQzWAiqAzPINuuIXPVXfHODWt4vZvIbHobxh2icrzMYtXK/ALMhd0NE8Xi6MfqE100ZxyvQyT2hKVyvIxxh8hsehte7yYIa7il5WSuugvZdk2cZYuIaVcrx6atMVY6irfftfbOpTSXAFu2bLcAb7ix92ZSLhhrEZLGqWN4OQfHk4RTxznx1R1UDx9JEASA1Uw9t5uRe7+MCKeRrkwcNLuQwLjwx/6Yfi483/kTYk0cQBThNCP3fpmp53YnEdgYKFE9fIQTX91BOHUcx5N4OYfGqWOxqDPWknJjGi+hubMVpJTSFAr+yiA0nel5Raoc6mOjeK7ACkFxdRfVk9NE06Owdg0EDZAuem6Gln6HTHcrNtJL8rsSkckmyioxR8UlBLS9gF1/MevjQu9ziTHsUqvocsdY+r5c+H1rDdm+NoQzjZ6biUG9JgTPJ5oeJdsakuvrwhqLcgX1sVGyG50FGGUQms5CwV8ppTy8FaSz0W4RVuzgN375xuu0tiVCg0EIGdYhmsEm0VgbafKDXWRveB2zL77A9P7DdN54HR03Xs3s0wcX/QNrka7L3IkTzE0/GqMUiNHJF3PgpKPOS8xbCzaBjZ/v8EiEo86JphIj4oy5oB8olXMesW2Chr4wZFEhlIoDjtUTeJ67kBew2pBuz5G//moao6c48+QztK5dSfHG1zEnTmCadZAynl40A2E9oalBa1v6jV++8bqP/NFDhzfaLcKZ/lSrBPSmde1dvid9jEYqRTQziXItUi6amMJJM/b9h5h58WlcFXLivmHaN6zF93NEjWoc3LIW4bo0Twwz9uC+GI0cQaYk8NtKnJO1BCOojU8RzekFHlgDrgfpnhZQ/llWklCKsFKmNtaM/aTEBzIa8j0+Kls4K04170DXxyYWIxhJvZ+fBb+zdJ6Oko6ifmaMZjmOXndtSOMPtWMDnag3jZPKMf3MU0zs2Y+jZxk9tZ/amevJF9LQrMWhCSlRriWaKeO0lMBofE/6m9a1dwF0fG+DcD54hy8/BLz9LcvX+qUCzNUiPNcJKxWktKASoipF9cRpKif20766lVRriurpWSaefpLS2g68vMJqFmS/k8tQHFgQj3Tc9hYyy9dgm43FeIsxkMow+8IzTDz8HVQmlYSfmxTWX0PbTbexKMPiLSscl3BqjDPfu5ewGgfSrDFI36f3p96NUyzFu3qhRsxAKsfE9+9ldt9uVNrHWosNQko33UZh/eazcxrWIlyP+rH9jD/yXUwU4OaW5LuTiprG1CyT+4/QsrxArruXxnSDyRceR/S3kOlIgpVKIo0lnK3glDoFQRSlOwrOO+8aWgNw+7Ip5bD6XRo+LoPIdKdjUJNFSGxYAQIgsX2txcsquq/pRCiBDjSZjhypYgYTRWfVzFltSRX9GHouJDaYw88pRKYFkUqdLW6MJpWP6NhUjNOKWKwOcYsgU6m4tiuxQrAGHA+nNk6h30OI9iUAgCZOxkPkCgh7jqgLA/IdkpTTFqcobezX+AWDyOUXoOrz88FN42YsbSsyoPILa2JJXbJ0LV2bu5GuRAcaL+/RfU0nuhktSWEKsAG2WZl3Vq10JFLKNkCyus06rntnBGTGx+udLcssxlohEXEYQJuY/gnnVdpJdviiLBQKlHIuEZGwSM+jfGA/zrRFEC5Cx5VCGIseO4Kb9hYsKOm4NE6PEPEU1sthw3CRu66PmR5G6Sa46QXxJJVi4rln8TsmF0MY1iA8H1uvYqfHcHw3USkW6TjMHTtAGOXRRizoDiHAKh8zcRAlDEK450MoLSjfWaDBAk1kQiN7rhkbe9IxbS3DJyr9QMp1/6A27xZqqUS0mJCUmKAWIwtEapGj9jIyXueZ0RbludSPHqH23D5ar7oWi0QIS9QIqRzYTcfqHKSzCwrXWouQhpH77ycztIlUWw5rLEJKpvcP47mTdF/VRdgIF5wc4bpUnnsGxF7y6zZhowihFM2pMvWT++ja0I4VsSM1b/2Y5hzHv/F1ihuvxUk5iWVtmXzhAK3LNMXBIlFTX9hQugxaxM6sxgRJuCZ5QUoRxQExcLQ2rF3b0qMj24M1MRrCgnQdjHzl3qoQcY1WoTdN6brXkVl906LmjCKyuRkkc2dn2CyolEP3jSspXPdm5Dx6Tkjyvc/RPP4YUagXRYcAExna17SRGnoj/sB6iAJQLnpmgsquGaTPIvGTjeHlfZbdupmWa98c00MIMJZcu0s0tQ8d2StCO14UAZkYMjFtDVrbnrVrW3oOHJg5Jq0FIVzPYr2zsv1KvqqOvnAkXltpUTEaA1LgFQsXtcP91gLSU7EoNHFI2s2nUb66wA60qJSLW2yFKC5XxRik5+Ll5ytmxHnESbflY0Njfk4CvJY0UolXp0RbEP/WkrEt1hPC9axNPIy49DKBTQgBQR1BgHAU9tUqyrQ2dtTO/dslSpSsNueVGs17rRcTd+f6GtbacxB750RF9Pm9J+x8X4pXvmSEkkhp4hO5wARh58tdX91t/mqC4f+1PPacrgovCc61FtxUgjQz/PvzyjkgHDcp87cXZkCz2Tz7qM8DYf/9eZV4cI6YMzameRwxE1SOzGLCJd4jNuaYEP9OvFfDDJRLdr8QmDCkcmQWhLiIDrAW6WYQ0v13MfQKd76QLtLNXFSpy8QEUroZqbO+6Pos9Oq5Uu/r36isvzCFVUzLJRtZNyNlQSFEjAWIILDGBIvxC4v0snH+9IJxd3WWZ/dvnvBCXhjCYuMctPSyZ5lC1pgggkAQo8WZgRFbq5zEBChHGaxGpIugPBarqhOHIWritg3EoNilUcd/o/LdRiFuaQi3bSCG6SzQI4HZKy+mpdUxbU2ArVVOzsCII0EmFdaqMT3jEkRJ/lIjUwWk4y+JAyW5USFRhV6c1v5YRBnzb1NP2HlvXuG09qMKvYsIj4Qe1lqk4yNThaS8SkIQ0ZiecQFlscjwc+s9oNFq5k4QRcRJgJh7Kt8ZJ1mEQHppQCBTLahsGyrXiUoXYzHnpRGXgakU89j8+Y+Uly5REmIRz598XmoccaH3L3VKFxDSS+b0kmPIhB6g0sWYFtm2uIiEhFZCIIRE5TsXpYiUliii1cydABrh59Z7zn2jgQDM1JFqWc8GqGJaLFhC2U6k2kN9zsPtvYGWDasgiBaOWPaqd4LvUDlwnPDk46TSVYy5SJsYIQhnJlAtAyTtD9FBgA4aFyaQEJhGFV2fQ/nzeQJDVKtd3M02hnBmAi9TQhgDwhDVGnE4+2Jj1CqYRj3mgYlNRN24yJwQSKlp1DO4fTdTWDMAzQRA5njkNr8LPIeZPYcITz1FOhshs52LelRYoWcDpo5Uy4C5bzQQTnpqmYZDfGd3eW/PvlP031xwkgyMUPl2hJPGBlOMfPtLBFOvp3TdjUgnVs5WwMRjTzH+2MN0rPYgm8NqfXaCY4kyaozsozZtkK6HEIJgdg5f1i4MSLYWEzSZeOox/GIb1hpMECEaY7i+ewHjID61c0d2MTc2h1ACayGanSHt6gsCeoWwBLPTVJ94BK8QFxrqZhMVnsb1vfNiSNYakA6mPsHJe79Mx9QbaL9uMyLBopooYvKJRxl/6lE61uQQLa2ofDsLSQhrnVP7TvGd3eW9AOmpZdr5xJ64mPjolB6bHj7Z7L95jT8PTJJeBlJtpIsNute7lF98mLZN10A6Pn52bo7K8zvpXp/Db8lgQnM+8YXARgFuaSWZZZsIZpsLxEt19+B6K6kffQTbrC6EbcEg3TT+8tfjaf+sxLmbX0M0vpdg9MXFcEmiDP1l15BpG6Q520iQgxbV34+yAzSOPh4j2uZdH6sRmRK5wZsJa4vJfKEETnYdwfHHiWZGEI6/MF8hBCY0ZEo5up0a08/vpLRpIyKbjX+yVmP2xYfpXl/CyzuQaotpmMwRDNPDJ5tHp/QYwCf27LTOjh1YIeArz87t+qW3B1NEQQ/Ct1gjEAqvtILa1HG8vEPPG25AtRWp7D2ICSKKm9bSd+v1BFPHMJG9KCRESInXuRLVNkC6GHBWz2Er8GZHaRx/GiHTST+IEKdjNU77EE7c0XDBhUe6CKGJpobj1jdyHgjg43WvQWTbybRpzsofRl2oyWOEk0djggJWa7yOVTht/TilJXM3BpSPbUyhq2cuCJcxkcXN+/TduhaZzVB+YR/ScyisX03PG25AV05gwohUaUWimDUIaYmaIpoIpr7y7NwuIWDHDqwDGGO2SiG2HUKbUX1qvEf1D0AUx+tlvgPp5zDBHF62xNgDD1J+4XGEsNTHbqJtdTc2OrSQaz1PwQkB1iMKDbJejdtFLgl5WOlidKKME4UshERrgWnUz3Y3rAXlYIN6vJMThSuwWOkRNUIcVUtQbkvGQGHt/BixjhJSEUXgNGtnQ1msBSfAhAHM9x4618qTxKW56W5GH3iQ2X1PYK2gfupmWpeXCKeOIf0cMt+RJHkAJdAnxrHajI5XmofmEdIOwI67twmAnc9PP9i9fuK63sE+YREIoxF+Dqe4jHBiH6cefoywMkvnhnaUA2N7nqJ2sp3ude75J0AIbNSIiy+iiJP3fgNtfZRrF9YjpCSsBfjpOTrXFIjqFQQC6Qkmn3mc+vd3o/wllYoJQEJGM7Qsc/Hy6RgwrARhuczos/+McD2WVoQKJWnO1Gjpjij2ZuIxhEA4MPrdb6Htw4ilyZcEfuhSpjiYQaVSsT90TjBNeS4nH3wMU5+g+6oOdAQTex+nPpKntFzhFJfFxeRGYxEIZcXYgQl2Pl/euZTmDsCLO+LhnzlUf+GukQn0TFmobGtcye6mUG0DRFNHSOVrtC3vTDI80H1VB/XpOazJndenx0YhXvdGVL4DjEV21QhqwQVaPgv8go/fmsbVJk7XSkF7d0B9un52kfQ8MMJ3yZQyZ+GCUgZUTxUd6PNEobWCTCmDl3VxTdLQRwq6Oho0Ko3zRIw14GV90m0ZdHWc4PTepI5s6TuCfGmOdGsHQgmkB11Xd1KbrCGkh2qLy59s2EA4LtHkhKicHOeRPbMPAdy9g8X6gG1Jw66+ns6vlSfmyuU9p4ulN3bCXAQ6wG1ZRpjvIccJLCLOGCUTyXbk46zSOUrX77kKf/nN4LhxY8MBmRRBXODRJhZ5S8SGoyTppfL/rDSWjd8/BxnnLb9EUXVk4nEWsP3g9gqyzkVsfm1BG9woRAhFc/T5RMwuAgfm1z5PDyEFuQ4Pme/BbVkW98O2gO8y+fxxyuOz070b1n6HZ59YMMnOqg/4o3/ZP9md7bi/vePF9+TX9eK1FEXcyCiN2zZIo3wq3ulLYTRLa4WFwIZNvM41+IM3xMoniC0YG7x01PasJ7x0VvBCZrptXuH7lzMnIfEHb8BGDYIzB5LAmj177UuMBGsVbtsguD42qCM8j3Bi0k4dfJFH9lbv//j2w5ULZsTsViRY4ab8v9fjI6J86KDGTQouogC3YyWq0BETdSkHxJL/0BFOaQXe4M2LdvN8Qw1x6c/iSsRlfeeH/f78d+ZRc97gzTilFXGb4yVNYc+WSxpV6Ih7WszngB1F+eB+HY2dFIGr/gFrElrHz+IJ2BbTrLddPv/8iaC87plnCm3r1lsnkxPoCJSD13cd9X33X9jTtRqZypNZ96a4karV/ypSwPNrkH6azLo3MffsFzDN6gW6fFmQMY2QTlwD7Sh0pWbHnzsk952m3F2Knl9C67MZIGIEuxRieOTj/5FPD52e+vDsydNh6/rVLhowGqfQjds+FB9FOR8pXbRogkqNyn1fxKj0lTfP+7EPvgmkrpPK1HDT8hzxKLEmwOtcg1PoXlJzrJg9eVLr8XFnbI5P/+r/XjVi7dNyaeeUs3TAjrsRQLh7mB3tWef9HXsPFluGBqxUiZ0mwFu2eaFZxqIZErPQBE3OPHfq4rL7yjtVvjZb/hI3pPRd3w5pn7Pt1iiu5F+2Ofm+TZB3DVPbv18dnBTTTw+zA54Od9x9dnH8WQzYsmP+FLDnjqu9h4LxxjumXjig22/YpGhGC2LG799M48gj5x1BJ+PQOpS7gFc8jyFPuln92Aqn+a5cDufVQVuQjsDJXLgxrN+/GZnKJ63wAd9h6rk9tjlWkxr34b95lD3WIjmnb5BzrhrZejsKmHv4qPepVYPqTrn/dLqwYpn1WlpjXWA0budaopnThOMHEE6KBNKIdCXtq4sXMTkMKteBmZuMbfsft0ROUpgosyV0dfzCnRytRUdm8YQLiY0auB1rcDvXLiJJHIdgatLO7h+TE3OitvNQ9Elg7p7bcbZBdEEraEEX7yTauvU25y+/Xf5maNRz1ANx5smDFhstqR60+AM3oXKdibaXC7skCjRRM0o+migw6NAS1QNU+0a0yMXvBIaoaYga0ZL3f8SfRhTPITBEgUaLHKp9I1E9iOccmHgN8+8H+uyypShA5TrxB25a7IGRdAY48+QhSz0QoVXP/eW3Z7+5dettzradnFcJeMGs+86dw1YITCXk+RtWZH8hmp4Vji9EellnXAmZBL+cfA/R9HDcsTBJ4J9lytkQGwagG6h8J37/tWA00cQhhDVgIoTrIi7DJPyhfKSAsAEmwkYN/GXX4JaWo2dGMLVJrNZIGceNFk1T5jtPIbwsmbU/iUwvCTl4LpO79jHx3LCdC5X52H1jW/aemDvxve8NX37HrDhvjBBi7Il3bs5/9i3Xtn/gyHefMH4xI7NDg7FzZSJkpoXUyjdSP/DgfMRvSScqA5llpEsd6HoVp9gXV6GXlmPq00g/gw0DgrFDcSzmtZA6kcXr2YhwPUwzLjUVjofXexVRphWVztGcHIf66SU3NCVSQLqkVr4RmWlZED3C85g7dpxD337ILO/rlw+8MPfpHT8Ye2K+7PrCsJSXMID/8XtTHzl4OhgWzTnx3BfvM2auDkotKFWn2E9q8MbkCM43rYjj6hP7pqjVu0lf83bczjVxrtnLkb76najSBsb3TRE1ovNzCD+SfLogakSM75tClTaQvvqdcaMoo3E715C+5u3U6t1M7JtaEqwTC+tMDd4YF2nP1xcrha7OsfuL3zAimBMHTjeP/f1jEx8532G7DBE07yts375FffQvn66sG2g92erNvieYmCas1um4erWwhjgThI1zx8pFz4wu4PiFEIiowpknnsFWy2QGlscxHM+jfvgFhr/4eRzGyXYVXhujSIByFfXR44w/uYt0WwGn1AmRBmEZ/+69nHnoflp6DG42tRilEwJ/8Aa87g3xzrdJ2F3Bka/+wJ7Zc8gI31O7T5hf+/N7xx/evh21acfF7xa4ZD+WHTv2YLcj3/B/j79426rmqsEOsXl2qhqllaMyfZ0xoeeZUOhBuqk4iaGDOIZSyOBnLMJtJbt2EzRqiEyOxthpqA7TurL95bTluXSA5wq/n+0oxDcyda7A7+6Fxhwil6d+ZB+54hyZzqQ9m4kQrk9q8Ca87o0J8W2czcIw/uguTu/ar1Ne3dl3KviHD/3d3D12O2rT3Ze+2OElG+Js24DYejviE5/3n1vbHb25rzPf2ZzCChuI7GBvHDWMI1GoQhcqWyKcGYEoiHMbuQwtV7+BxvgsJ771LajP0bJ2NZ6aJpwtx40+XqbZqLLtyFQhKYJ7WVchYMKA/GA/mZXXMv30M4w+8hip1hKF5d2YuZE48WI0eGkyq+/AaV8Ri51EJAnPYeKJ5zmz66T1lFbPHZ3Z//9+0//gr344mrljHNh56e310qvfib39dsSX79VT+QzPrOnJ/1xHqc2vnKpY5UiR7utIsEHz8aAW3EIvpjYVN8ZzMlRONRn93gP4boW5Y/upnglxfYEwM1feIiwRcdYEeMs2o/I9sT8i3QUP9ErEkEATmSJju44zt+8hXFVnYtcewMFVNWwwh5PvIrPq9hhiYsK4UbiIw8xTuw5z5uljNuV74uREpfqlZ2a3fG+/3n377Yidl3ED32Vtv507sVu2oP7pWxzfvLI4MtSV/lklrZ05PoE0VZHp645D0cYiMHEWrbUfgSaYOMXMvgMU+zO0rmgj1ZamcuQY6Brp1lTco+8yaSakQDgOmBj0mh68EelnCCcOL7lDzF62SLMWHM9h9uQEjdMn6NzUSb63gKMiZg8fwi84pPo2kBq6Jb7eykYLVS9IwcSTuxh94qh1FDY0Vnx/X+0Df3Lv7Ne3bEF94hOXd6fMFV7gEN+G+plfXLntrdcWf3+uaYJ6reEWV3eKvp+4CSmduD5LsoCVDM8cpHniaTCNOM+fXO5jtbnC3W+x2iG1/CbcYntcnJ1uiSs6G7NIZQnKUzSOPIqQ0ZUtzZiEqCqurpQWZAq//3rcztUL0V5M7OUaE3HyO09QPnjGpjOpMOtL775nyx95/18f3nqlt7FekeC0yU1oQqD++v1DH3vbjaVfr9ab0dixQ6ptdb9Y9zM/iVtsgXBJTwDlYpuzNE88RzhxOG7Q6nqLW/Byua8EleMVquOW7je9hfyKlcyb1tZCffQEJx94gGyuRsvylsWs3RUocxvGbfHd9pX4/dcg/PxC4/C4csglLM+w71/uZ+rgCdu1fJXOpX3nG09O/tkvfubob1uLThJulz34FWnAbcC2bQhrsTf+dPk763ozxQ3LUq+frc1w5ugotVMjFPu6hdvWmphzsa8gnBRO28ACSMnUppOKxHNaT77E46Y8mjM1ygf207JiJaqlBaQgqlQZ/sqXcMwULYNtl+nYibMDcFjc9hX4y2+MnTPpJu0xE6xSyqd+apQXd3zdntpzjEwhTUdbSd33bOXPf/HTR37bWrQQsO0KbbqXa8cJRwkbaav++v0Df3LzsvKvT5arVijP9K1YqzquH6R10xrAjZFyC/eMeNgowMxNEJx6IW6+Pe/ISHU2XuiCp0Biw4DQlihe/1aiuRrWRvhtnUw/eR+yOYxKZy/eVnPp788HzqSD09KL17sJmW2P875RkLBGIJQCQqZfOMD408OcPLJfWx3IUjEnHh8p/tkvfub4bzlK6EjblxVsf7n3iGFs3Bz2a0/PfHtjT5QaKJpbvLSPclvt3MiUbExNk27L4hQS1Jg2CKsRUiFTedzSclS+O0EZR9goiMXTAjPk+d0SE8JlBtZRn1Uc/5fPM/nMk/htbWS7skkTwKVKXSxe9CwAHcV9o4VEpnKoYj/+4M34yzYhU/n4ezqMf8NRCE8RTE5x6qHdTL5wiigU2kZlHBPw2NHof/zXvyv/dxXfUfSyiyVehasMYwPoM+/jl1f15T82MLA6XQuMITLSy0tKG1fSsrYf1VqAuca8JmHhcgbpYJuzRFPHiCpjmPpMEggLQbmLgC0hYri3lFTGHSb2nqTQoRCuQ2WkRmlDH4UugYmihfYFcZjcJBfzuMhMCZluwSl0xV14/Xxi0yfdhOfDDbk0eqrCzP5hJl88QjBrwJEm40l5/PjB+qGTs7/9/n/kE0mMB16jqwwXnu1bUHfvQG/72fa33byx/eNXD+SGyjWNiaxFa+GVUuSXt9J9/VWQSsX3My7EjuK7wVAe6AjTKGNqZUx9Gl2dwjZn0fUyVgcIpdCBYerAFH7RpzjYAlZQGanSmJ6jdVUryos7+wrlodJFhJ9H5dqQ6db4hu1UMb7HWAeLqcN5OLvjQBBw6omnqBybxkxbrMJKR4piRrH7ePXo4y9O/OrWL098Y37Nr1bO+RU/D27FuWMb0X97W9+y16/LfOSagewvKAkaFc1MjqvZqWGR6+1i5a230rZxMAY6SQnaJNXyJulmruIKTauTji1hcvFbEPeCbtQwjSrKV3GIwMYWrw5MDAdMZZB+HqG8hfpc4aaSl+LmqjHSQcamZ9KmwEaamQP7OPi9JykPj5Fv67al7n4tbeRoA88dn/vso/tqv/8/v3FyZH6tr2bS/1VlAsCf/vzyX79hZfa/r+jO9E5XyoycOBjJCKfY0Utr3yCljcvI9rfj5TKQToEGG4ZxHDxxuhbSlwuttJITI+z5V2dKkqusxBJlaxasHGtsEjeTCNeNtV+9QVCtMXdikokXTlCbGGP81FFCg+4bWK7a2jo5Mlo99dTh2v/4zb879mfnrvHHjgHzmb15W7i33Vvz6Q+t+d0U5fe2iVP+xKyNCm29Kl/oFDoIcTOWwkAXmZ42Uh0t+KUSZDOxHxHq2JqxS1phLp3yRS9bsIuOW9IsUCgFroqvnJqr05ycoDE+Q210isrxMcKaRHmKZqNqJ08f0a0p40zS1Yy8rs+//692f/TUBAeW+EA/vlean5Xg34LakcjIP3hX9if6883/Ntga3dXRtQwn042xxhoNNtRAINKlLIEKrZNJifbBQXLLSrjtrUnNml3sYmgXCbwUmLC0kHChG6JMqmYmpqiOTDFx/BhBuUpKZqlPVgHPClchFUghhNKzjJw4yNFJce+xsvyf276qv3PuWn5YuKMfyrMV5D12i0juYM/+9k/yhps2LP+da1a23oZFeo4g0JbI2Aij5JlT+0RjZk7k2nK0D6zEz7UgU5ZMRw4nncLL+TiZPMYY3FwG6cfwEN0MiKo1pJREtVmCapOo3qA2XkXXLbrRYOLEIcpjZby0omdos0Fq40jheEoQxHcbm93DMzsff/7IH33sfh4G5qzdou4RO+y2l3lX8GvOgPkxtt6G+shOkiuct8q3XP3nt3zozZ3/tb/duxUrlvWVXEKjODFyJKhMT0nXcWSpc0i4bkpYa+IgXLKzRWLXN+sVypPDaG3It/bYQku3MDpaOBlxm5rFwoKJM0dtvV432WzGDq3Y4LpSc3IyBGFHTkwEP/jkd8/85Tefnn4EMAL4/dtwtu1E/7CRTD/KXJTYuhWx7ewQ7cqP/8LAXTevKtw5VbWbu1KnBk1tGiN90m0rUE5aG2vEAmokJqaQQtGoTTM1fgytLYVSjy0Wl4lIhwgh5kX/QhJRCavmpo9gGrPgpJiQq4bb0ux6/FDlgV/97PF7gcMLp3Yrcts2LD8iCNlrBc4R27cgf+4L6HmRfuP61o0fuSu67sDJ6uvSqfQNG1YNbe5vT3lYGze/snFLa20MFkWjVmZ6/BhaGwqlXttS7BXGhLhKImXcAmAeDT8yFQZ7Dx/bVa1Wn1rZ7Tz20e/knnl47/SL8yrjn9+DSvD6P3Lc3muNjpKf/OD16oOffLte2lP/6hVdnX/4cx1tJ8erg1Nz5mrfEWt6WpyBTEr19Jf8wULWK8xVpyknDMiXem1bW6+YqTYrJyabw7WGHh2diY43I3ugLSt393Xkhn/vn49O7T6yeHmxtVvlpz70dfWhTz2t+SHK+Jd6/n+eLM2BnKBt+AAAAABJRU5ErkJggg==")');
        document.documentElement.classList.add('gc-coin-fallback');
        scan(document.body);
        new MutationObserver(function (muts) {
            for (var i = 0; i < muts.length; i++) {
                var m = muts[i];
                if (m.type === 'characterData') scan(m.target);
                else for (var j = 0; j < m.addedNodes.length; j++) scan(m.addedNodes[j]);
            }
        }).observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
