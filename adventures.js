/* =============================================================
   ADVENTURES & CRAFTING MODULE
   =============================================================
   Adds: Material drops & inventory, a Crafting system (potions +
   permanent upgrades), a modular Boss/Rich-Vein/Rift mine-event
   system, and a 3-slot Rune system with passive abilities.

   Design goals (per spec):
   - 100% additive. Does not redeclare or overwrite anything in
     script.js. Reuses gameState, dom, addCoins, getTotalMultiplier,
     formatNumber, saveGame, etc. as globals (script.js has no
     modules, so this works as long as this file loads AFTER it).
   - All new persistent data lives under gameState.adventures, and
     is folded into the existing save/load calls via hooks below,
     so old saves keep working and new saves aren't corrupted.
   - Materials, recipes, bosses, and runes are all defined as data
     tables so more can be added later with no structural changes.
   ============================================================= */

(function () {
    'use strict';

    // -------------------------------------------------------
    // Wait until script.js's gameState/dom exist. Since this
    // file is loaded after script.js and script.js runs
    // initGame() synchronously at parse time (no DOMContentLoaded
    // gate), gameState/dom/addCoins etc. are already defined by
    // the time this IIFE executes.
    // -------------------------------------------------------
    if (typeof gameState === 'undefined' || typeof dom === 'undefined') {
        console.warn('Adventures module: core game not found, aborting init.');
        return;
    }

    /* =========================================================
       DATA TABLES
       ========================================================= */

    // ---- Materials: drop chance is per biome key. Add more
    // materials by adding an entry here; add drop chances for a
    // biome by adding that biome's key to `dropRates`. ----
    const MATERIALS = {
        ironOre: {
            get name() { return t('mat_ironOre'); },
            icon: '🔩',
            dropRates: { surface: 0.14, slateiron: 0.22, grotto: 0.10, mithril: 0.08, magma: 0.06, voidrift: 0.04, celestial: 0.03 }
        },
        glowingSpores: {
            get name() { return t('mat_glowingSpores'); },
            icon: '🍄',
            dropRates: { surface: 0.04, slateiron: 0.08, grotto: 0.24, mithril: 0.10, magma: 0.05, voidrift: 0.04, celestial: 0.03 }
        },
        mithrilShards: {
            get name() { return t('mat_mithrilShards'); },
            icon: '💠',
            dropRates: { surface: 0.01, slateiron: 0.03, grotto: 0.06, mithril: 0.20, magma: 0.10, voidrift: 0.07, celestial: 0.05 }
        },
        abyssCrystals: {
            get name() { return t('mat_abyssCrystals'); },
            icon: '🔮',
            dropRates: { surface: 0, slateiron: 0.01, grotto: 0.02, mithril: 0.05, magma: 0.12, voidrift: 0.18, celestial: 0.14 }
        }
    };

    // ---- Crafting recipes. type: 'potion' (temporary) or
    // 'permanent'. effect functions receive gameState and apply
    // their bonus; potions register a timed entry in
    // gameState.adventures.activePotions instead of mutating
    // permanent stats directly. Add more recipes by appending. ----
    const RECIPES = {
        berserkerPotion: {
            get name() { return t('recipe_berserkerPotion_name'); },
            icon: '🧪',
            type: 'potion',
            get description() { return t('recipe_berserkerPotion_desc'); },
            cost: { ironOre: 5, glowingSpores: 3 },
            durationMs: 3 * 60 * 1000,
            clickMult: 5 // +400% = 5x total
        },
        wardingElixir: {
            get name() { return t('recipe_wardingElixir_name'); },
            icon: '🛡️',
            type: 'potion',
            get description() { return t('recipe_wardingElixir_desc'); },
            cost: { ironOre: 4, mithrilShards: 2 },
            durationMs: 3 * 60 * 1000,
            cpsMult: 2.5
        },
        dwarvenPickaxe: {
            get name() { return t('recipe_dwarvenPickaxe_name'); },
            icon: '⛏️',
            type: 'permanent',
            get description() { return t('recipe_dwarvenPickaxe_desc'); },
            cost: { ironOre: 20, mithrilShards: 5 },
            critChanceBonus: 0.15,
            maxOwned: 1
        },
        abyssalCharm: {
            get name() { return t('recipe_abyssalCharm_name'); },
            icon: '🖤',
            type: 'permanent',
            get description() { return t('recipe_abyssalCharm_desc'); },
            cost: { abyssCrystals: 8, mithrilShards: 10 },
            dropChanceBonus: 0.25,
            maxOwned: 1
        }
    };

    // ---- Runes: up to 3 equipped at once. `passive` runes apply
    // continuously; runes with onClick fire from the click hook.
    // Add more by appending here — the UI and save system are
    // fully data-driven. ----
    const RUNES = {
        thunderRune: {
            get name() { return t('rune_thunderRune_name'); },
            icon: '⚡',
            get description() { return t('rune_thunderRune_desc'); },
            cost: { ironOre: 10, glowingSpores: 5 },
            onEveryNClicks: 10,
            lightningMult: 20
        },
        greedRune: {
            get name() { return t('rune_greedRune_name'); },
            icon: '🍀',
            get description() { return t('rune_greedRune_desc'); },
            cost: { glowingSpores: 8, mithrilShards: 3 },
            dropChanceMult: 2
        },
        emberRune: {
            get name() { return t('rune_emberRune_name'); },
            icon: '🔥',
            get description() { return t('rune_emberRune_desc'); },
            cost: { ironOre: 12, abyssCrystals: 2 },
            cpsMult: 1.1
        }
    };

    // ---- Bosses: modular list, add more by appending. Each has
    // its own type (visual/flavor only), HP, timer, and loot. ----
    const BOSSES = {
        stoneGolem: {
            get name() { return t('mineboss_stoneGolem'); },
            icon: '🗿',
            type: 'stone',
            hp: 150,
            timeMs: 20000,
            loot: { gold: 2500, gems: 2, materials: { ironOre: 6 } }
        },
        lavaDragon: {
            get name() { return t('mineboss_lavaDragon'); },
            icon: '🐲',
            type: 'lava',
            hp: 260,
            timeMs: 22000,
            loot: { gold: 5000, gems: 4, materials: { abyssCrystals: 3, mithrilShards: 4 } }
        },
        shadowWraith: {
            get name() { return t('mineboss_shadowWraith'); },
            icon: '👤',
            type: 'shadow',
            hp: 200,
            timeMs: 18000,
            loot: { gold: 3500, gems: 3, materials: { glowingSpores: 8 } }
        }
    };

    // Minimum time between accepted manual event clicks (~12 CPS).
    // Applies to Bosses, Rich Gold Veins and Rift particles. Change this
    // single value to rebalance (e.g. 100 = ~10 CPS).
    const EVENT_CLICK_INTERVAL = 80;
    // Shared (global) timestamp so switching between targets can't bypass the limit.
    // Not persisted: resets naturally on page reload.
    let lastEventClickTime = -Infinity;

    // Layer 1: reject synthetic (script-generated) events.
    // Layer 2: soft throttle - clicks that come too fast are silently ignored.
    function canProcessEventClick(event) {
        if (!event || event.isTrusted !== true) return false;
        const now = performance.now();
        if (!Number.isFinite(now) || !Number.isFinite(lastEventClickTime)) {
            // Invalid/initial timestamp: accept this click and re-seed.
            lastEventClickTime = now;
            return true;
        }
        const elapsed = now - lastEventClickTime;
        if (elapsed >= 0 && elapsed < EVENT_CLICK_INTERVAL) return false;
        lastEventClickTime = now;
        return true;
    }

    const EVENT_CONFIG = {
        minDelayMs: 5 * 60 * 1000,
        maxDelayMs: 8 * 60 * 1000,
        richVein: {
            requiredClicks: 18,
            timeMs: 15000,
            goldMult: 80,   // reward = coinsPerClick-equivalent * this, scaled below
            gemsMin: 1,
            gemsMax: 3
        },
        rift: {
            particleCount: 12,
            timeMs: 16000,
            rewardGoldMult: 40,
            rewardGemsMin: 1,
            rewardGemsMax: 2
        }
    };

    /* =========================================================
       STATE INITIALIZATION & SAVE INTEGRATION
       ========================================================= */

    /** Ensures gameState.adventures exists with safe defaults, filling in
     * any properties missing from an older save without clobbering
     * anything already present. Safe to call repeatedly. */
    function ensureAdventureState() {
        if (!gameState.adventures || typeof gameState.adventures !== 'object') {
            gameState.adventures = {};
        }
        const a = gameState.adventures;
        if (!a.materials || typeof a.materials !== 'object') a.materials = {};
        for (const key in MATERIALS) {
            if (typeof a.materials[key] !== 'number') a.materials[key] = 0;
        }
        if (!a.ownedPermanent || typeof a.ownedPermanent !== 'object') a.ownedPermanent = {};
        if (!Array.isArray(a.activePotions)) a.activePotions = [];
        if (!a.craftedRunes || typeof a.craftedRunes !== 'object') a.craftedRunes = {};
        if (!Array.isArray(a.equippedRunes)) a.equippedRunes = [null, null, null];
        if (typeof a.clickCounter !== 'number') a.clickCounter = 0;
        if (!a.bossProgress || typeof a.bossProgress !== 'object') a.bossProgress = {};
        // Shop: base slots + VIP bonus slot (equipped runes are never deleted, see shop code).
        if (typeof syncRuneSlotsToVIP === 'function') syncRuneSlotsToVIP();
        return a;
    }
    ensureAdventureState();

    // Hook into saveGame/loadGame without touching script.js. We wrap
    // the existing global functions so the new data rides along with
    // the existing save blob (gameState is already JSON.stringify'd
    // wholesale in saveGame, so gameState.adventures is saved for
    // free — this wrapper exists mainly to guarantee defaults are
    // (re)applied right after every load, including the very first
    // load that already ran before this file executed).
    if (typeof loadGame === 'function') {
        const originalLoadGame = loadGame;
        window.loadGame = function () {
            originalLoadGame();
            ensureAdventureState();
            markAdvDirty('inventory', 'crafting', 'runes', 'buffs');
        };
    }
    // Re-run defaults now too, in case initGame() already called the
    // original loadGame before this file's wrapper was installed.
    ensureAdventureState();

    /* =========================================================
       MATERIAL DROPS
       ========================================================= */

    function getDropChanceMultiplier() {
        let mult = 1;
        const a = gameState.adventures;
        if (a.ownedPermanent.abyssalCharm) mult *= 1 + RECIPES.abyssalCharm.dropChanceBonus;
        // Shop: VIP gives +50% (multiplicative: 10% -> 15%)
        if (typeof getVIPDropMultiplier === 'function') mult *= getVIPDropMultiplier();
        a.equippedRunes.forEach((key) => {
            if (key && RUNES[key] && RUNES[key].dropChanceMult) mult *= RUNES[key].dropChanceMult;
        });
        return mult;
    }

    /** Rolls for a material drop based on the current biome. Called on
     * every manual click and, at a reduced rate, on passive ticks. */
    function rollMaterialDrop(chanceScale) {
        const a = ensureAdventureState();
        const biome = gameState.currentBiome || 'surface';
        const scale = chanceScale || 1;
        const dropMult = getDropChanceMultiplier();

        for (const key in MATERIALS) {
            const baseChance = MATERIALS[key].dropRates[biome] || 0;
            if (baseChance <= 0) continue;
            const chance = baseChance * scale * dropMult;
            if (Math.random() < chance) {
                a.materials[key] = (a.materials[key] || 0) + 1;
                showMaterialToast(key);
                markAdvDirty('inventory', 'crafting', 'runes');
            }
        }
    }

    function showMaterialToast(materialKey) {
        const mat = MATERIALS[materialKey];
        if (!mat) return;
        const el = document.createElement('div');
        el.className = 'mine-event-burst';
        el.textContent = t('mat_toast', { icon: mat.icon, name: mat.name });
        const btn = document.getElementById('click-button');
        const rect = btn ? btn.getBoundingClientRect() : { left: window.innerWidth / 2, top: window.innerHeight / 2 };
        el.style.left = (rect.left + rect.width / 2 - 60 + (Math.random() * 60 - 30)) + 'px';
        el.style.top = (rect.top - 10) + 'px';
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 900);
    }

    /* =========================================================
       POTION / BUFF EFFECTS
       ========================================================= */

    /** Returns the combined click multiplier from active potions + runes. */
    function getAdventureClickMultiplier() {
        let mult = 1;
        const now = Date.now();
        (gameState.adventures.activePotions || []).forEach((p) => {
            if (p.expiresAt > now && p.clickMult) mult *= p.clickMult;
        });
        return mult;
    }

    /** Returns the combined CPS multiplier from active potions + runes. */
    function getAdventureCpsMultiplier() {
        let mult = 1;
        const now = Date.now();
        (gameState.adventures.activePotions || []).forEach((p) => {
            if (p.expiresAt > now && p.cpsMult) mult *= p.cpsMult;
        });
        gameState.adventures.equippedRunes.forEach((key) => {
            if (key && RUNES[key] && RUNES[key].cpsMult) mult *= RUNES[key].cpsMult;
        });
        return mult;
    }

    /** Returns permanent crit chance bonus from crafted permanent items. */
    function getAdventureCritBonus() {
        return gameState.adventures.ownedPermanent.dwarvenPickaxe ? RECIPES.dwarvenPickaxe.critChanceBonus : 0;
    }

    function cleanupExpiredPotions() {
        const now = Date.now();
        const a = gameState.adventures;
        const before = a.activePotions.length;
        a.activePotions = a.activePotions.filter((p) => p.expiresAt > now);
        if (a.activePotions.length !== before) markAdvDirty('buffs');
    }

    /* =========================================================
       WRAPPING CORE GAME FUNCTIONS (non-destructive hooks)
       ========================================================= */

    // Wrap getTotalMultiplier so potions/runes apply to both click and
    // passive income without editing script.js's own multiplier chain.
    if (typeof getTotalMultiplier === 'function') {
        const originalGetTotalMultiplier = getTotalMultiplier;
        window.getTotalMultiplier = function () {
            return originalGetTotalMultiplier() * getAdventureCpsMultiplier();
        };
    }

    if (typeof getBaseClickAmount === 'function') {
        // Click power potions are layered on top separately (applied in
        // the click hook below) since click power potions should not
        // also multiply passive CPS. We leave getBaseClickAmount alone
        // and instead wrap handleManualClick.
    }

    if (typeof handleManualClick === 'function') {
        const originalHandleManualClick = handleManualClick;
        window.handleManualClick = function (event) {
            // Temporarily boost coinsPerClick-derived earnings by applying
            // the potion click multiplier via a one-shot coin correction:
            // we let the original run (which uses getTotalMultiplier,
            // already patched above with CPS-relevant multipliers only),
            // then top up the difference for click-specific multipliers.
            const coinsBefore = gameState.coins;
            originalHandleManualClick(event);
            const clickMult = getAdventureClickMultiplier();
            if (clickMult > 1) {
                const earnedByOriginal = gameState.coins - coinsBefore;
                if (earnedByOriginal > 0) {
                    const bonus = earnedByOriginal * (clickMult - 1);
                    addCoins(bonus);
                    gainExperience(bonus);
                }
            }

            // Material drop roll on manual click
            rollMaterialDrop(1);

            // Rune: Thunder Rune every-Nth-click lightning strike.
            // === CHANGED: charge counter is now incremented once per
            // click (the old code had a stray no-op forEach loop before
            // this that did nothing useful) and immediately followed by
            // a UI refresh of the on-button charge badge below. ===
            const a = gameState.adventures;
            a.clickCounter += 1;
            a.equippedRunes.forEach((key) => {
                const rune = key && RUNES[key];
                if (rune && rune.onEveryNClicks && a.clickCounter % rune.onEveryNClicks === 0) {
                    triggerLightningStrike(event, rune);
                }
            });

            // === NEW: keep the Thunder Rune charge badge on the main
            // click button in sync with every click, so the player
            // always sees "[x/10]" ticking up and the flash at 10/10.
            updateThunderRuneChargeDisplay();

            // Rich Gold Vein / Rift click routing
            handleActiveEventClick(event);

            updateUI();
        };
    }

    function triggerLightningStrike(event, rune) {
        const base = getBaseClickAmount() * getTotalMultiplier();
        const strike = base * rune.lightningMult;
        addCoins(strike);
        gainExperience(strike);
        const el = document.createElement('div');
        el.className = 'mine-event-burst';
        el.textContent = `⚡ +${formatNumber(strike)}`;
        el.style.left = (event ? event.clientX : window.innerWidth / 2) + 'px';
        el.style.top = (event ? event.clientY - 40 : window.innerHeight / 2) + 'px';
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 900);

        // === NEW: flash effect on the main click button/frame when the
        // Thunder Rune's charge hits its threshold (the "10th click").
        flashThunderRuneCharge();
    }

    /* =========================================================
       THUNDER RUNE — CHARGE COUNTER UI (NEW)
       =========================================================
       Adds a small "[x/10]" badge to the main click button frame that
       tracks progress toward the Thunder Rune's next lightning strike,
       plus a brief flash animation when the charge threshold is hit.
       Purely additive: injects its own <style> block and a single badge
       element rather than requiring any HTML/CSS file changes, and does
       nothing at all if the Thunder Rune is not currently equipped.
       ========================================================= */

    let thunderChargeBadgeEl = null;

    /** Lazily injects the CSS for the charge badge + flash animation. */
    function ensureThunderRuneStyles() {
        if (document.getElementById('adv-thunder-charge-style')) return;
        const style = document.createElement('style');
        style.id = 'adv-thunder-charge-style';
        style.textContent = `
            .adv-thunder-charge-badge {
                position: absolute;
                top: 6px;
                right: 6px;
                background: rgba(20, 14, 0, 0.75);
                border: 1px solid rgba(255, 221, 87, 0.65);
                color: #ffe066;
                font-weight: 900;
                font-size: 0.78em;
                padding: 3px 8px;
                border-radius: 999px;
                box-shadow: 0 0 8px rgba(255, 221, 87, 0.35);
                pointer-events: none;
                z-index: 5;
                transition: transform 0.12s ease, background 0.12s ease;
            }
            .adv-thunder-charge-badge.charge-ready {
                background: rgba(255, 221, 87, 0.9);
                color: #2a1e00;
            }
            .adv-thunder-charge-badge.charge-flash {
                animation: advThunderChargeFlash 0.45s ease;
            }
            @keyframes advThunderChargeFlash {
                0% { transform: scale(1); filter: brightness(1); }
                30% { transform: scale(1.35); filter: brightness(2.4); }
                100% { transform: scale(1); filter: brightness(1); }
            }
            .click-button-frame.thunder-strike-flash {
                animation: advThunderFrameFlash 0.45s ease;
            }
            @keyframes advThunderFrameFlash {
                0% { box-shadow: 0 0 0 rgba(255, 221, 87, 0); }
                30% { box-shadow: 0 0 45px 10px rgba(255, 221, 87, 0.85); }
                100% { box-shadow: 0 0 0 rgba(255, 221, 87, 0); }
            }
        `;
        document.head.appendChild(style);
    }

    /** Creates (once) and returns the charge badge element, appended to
     * the click button frame so it visually sits on the clicker. */
    function ensureThunderChargeBadge() {
        if (thunderChargeBadgeEl && document.body.contains(thunderChargeBadgeEl)) {
            return thunderChargeBadgeEl;
        }
        const frame = document.getElementById('click-button-frame');
        if (!frame) return null;
        // Frame needs relative/absolute positioning context for the badge;
        // most click-button-frame implementations already establish this,
        // but set it defensively without touching existing inline styles
        // the user may rely on.
        if (getComputedStyle(frame).position === 'static') {
            frame.style.position = 'relative';
        }
        const badge = document.createElement('div');
        badge.className = 'adv-thunder-charge-badge';
        badge.id = 'adv-thunder-charge-badge';
        frame.appendChild(badge);
        thunderChargeBadgeEl = badge;
        return badge;
    }

    /** Refreshes the "[x/10]" badge text/visibility based on whether the
     * Thunder Rune is currently equipped and the live click counter. */
    function updateThunderRuneChargeDisplay() {
        const a = gameState.adventures;
        if (!a || !Array.isArray(a.equippedRunes)) return;

        const equippedThunder = a.equippedRunes.includes('thunderRune');
        const badge = document.getElementById('adv-thunder-charge-badge') || (equippedThunder ? ensureThunderChargeBadge() : null);
        if (!badge) return;

        if (!equippedThunder) {
            badge.style.display = 'none';
            return;
        }

        ensureThunderRuneStyles();
        const n = RUNES.thunderRune.onEveryNClicks;
        const progress = ((a.clickCounter - 1) % n) + 1; // 1..n, since strike already fired at exact multiples
        const displayCount = (a.clickCounter % n === 0) ? n : progress;

        badge.style.display = '';
        badge.textContent = `⚡ ${displayCount}/${n}`;
        badge.classList.toggle('charge-ready', displayCount === n);
    }

    /** Plays the "10th click" flash: pulses the charge badge and casts a
     * brief glow around the whole click-button-frame for extra juiciness. */
    function flashThunderRuneCharge() {
        ensureThunderRuneStyles();
        const badge = document.getElementById('adv-thunder-charge-badge');
        if (badge) {
            badge.classList.remove('charge-flash');
            void badge.offsetWidth;
            badge.classList.add('charge-flash');
        }
        const frame = document.getElementById('click-button-frame');
        if (frame) {
            frame.classList.remove('thunder-strike-flash');
            void frame.offsetWidth;
            frame.classList.add('thunder-strike-flash');
        }
    }

    // Wrap gameLoop to: roll a reduced-chance passive material drop,
    // clean up expired potions, and tick any active mine event timer.
    if (typeof gameLoop === 'function') {
        const originalGameLoop = gameLoop;
        window.gameLoop = function () {
            originalGameLoop();
            if (gameState.coinsPerSecond > 0) {
                rollMaterialDrop(0.15); // passive ticks drop less often than clicks
            }
            cleanupExpiredPotions();
            tickActiveMineEvent();
        };
    }

    /* =========================================================
       BOSS / RICH VEIN / RIFT MINE EVENTS
       ========================================================= */

    let activeMineEvent = null; // { kind, ...state }
    let mineEventTimerId = null;
    let advMiniEventTimeoutId = null;

    function scheduleNextAdvEvent() {
        if (advMiniEventTimeoutId) clearTimeout(advMiniEventTimeoutId);
        const delay = EVENT_CONFIG.minDelayMs + Math.random() * (EVENT_CONFIG.maxDelayMs - EVENT_CONFIG.minDelayMs);
        advMiniEventTimeoutId = setTimeout(() => {
            spawnRandomMineEvent();
            scheduleNextAdvEvent();
        }, delay);
    }

    function spawnRandomMineEvent() {
        if (activeMineEvent) return; // one at a time
        if (typeof isGamePaused === 'function' && isGamePaused()) return; // never spawn while paused (next schedule retries)
        const roll = Math.random();
        if (roll < 0.45) {
            spawnRichVeinEvent();
        } else if (roll < 0.8) {
            spawnBossEvent();
        } else {
            spawnRiftEvent();
        }
    }

    function removeEventBanner() {
        const el = document.getElementById('mine-event-banner');
        if (el) el.remove();
        document.querySelectorAll('.rift-particle').forEach((p) => p.remove());
    }

    function endMineEvent() {
        if (mineEventTimerId) clearInterval(mineEventTimerId);
        mineEventTimerId = null;
        activeMineEvent = null;
        removeEventBanner();
    }

    // ---- Rich Gold Vein ----
    function spawnRichVeinEvent() {
        activeMineEvent = {
            kind: 'richVein',
            clicksNeeded: EVENT_CONFIG.richVein.requiredClicks,
            clicksDone: 0,
            expiresAt: Date.now() + EVENT_CONFIG.richVein.timeMs
        };
        renderRichVeinBanner();
    }

    function renderRichVeinBanner() {
        removeEventBanner();
        const banner = document.createElement('div');
        banner.className = 'mine-event-banner';
        banner.id = 'mine-event-banner';
        banner.innerHTML = `
            <div class="mine-event-title">${t('event_vein_title')}</div>
            <div class="mine-event-timer" id="mine-event-timer-label"></div>
            <button class="mine-event-target" id="mine-event-target-btn">
                <span class="mine-event-icon-big">⛏️💰</span>
                ${t('event_vein_btn', { progress: '<span id="mine-event-progress">0</span>', needed: activeMineEvent.clicksNeeded })}
            </button>
        `;
        document.body.appendChild(banner);
        document.getElementById('mine-event-target-btn').addEventListener('click', (e) => {
            handleActiveEventClick(e);
        });
    }

    function handleActiveEventClick(event) {
        if (!activeMineEvent) return;
        // Only respond if the click originated from the event's own
        // target button, OR (for rift) from a rift particle — those
        // wire their own listeners. This guard lets the manual mine
        // click handler safely call this every time without double
        // counting clicks on the main MINE GOLD button.
        const target = event && event.target;
        const isEventTarget = target && (target.closest('#mine-event-target-btn') || target.classList.contains('rift-particle'));
        if (!isEventTarget) return;

        // Click protection (only reached for real event-target clicks, so
        // normal MINE button clicks never consume the throttle).
        if (!canProcessEventClick(event)) return;

        if (activeMineEvent.kind === 'richVein') {
            activeMineEvent.clicksDone += 1;
            const progressEl = document.getElementById('mine-event-progress');
            if (progressEl) progressEl.textContent = String(activeMineEvent.clicksDone);
            if (activeMineEvent.clicksDone >= activeMineEvent.clicksNeeded) {
                completeRichVein();
            }
        } else if (activeMineEvent.kind === 'boss') {
            const dmg = getBaseClickAmount() * getTotalMultiplier() || 1;
            activeMineEvent.hpCurrent -= dmg;
            updateBossHpBar();
            spawnEventHitText(event, dmg);
            if (activeMineEvent.hpCurrent <= 0) {
                completeBoss();
            }
        } else if (activeMineEvent.kind === 'rift' && target.classList.contains('rift-particle')) {
            target.remove();
            activeMineEvent.hit += 1;
            if (activeMineEvent.hit >= activeMineEvent.total) {
                completeRift();
            }
        }
    }

    function spawnEventHitText(event, amount) {
        const el = document.createElement('div');
        el.className = 'mine-event-burst';
        el.textContent = '-' + formatNumber(amount);
        el.style.color = '#ff6b5e';
        el.style.left = (event ? event.clientX : window.innerWidth / 2) + 'px';
        el.style.top = (event ? event.clientY - 20 : window.innerHeight / 2) + 'px';
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 900);
    }

    function completeRichVein() {
        const cfg = EVENT_CONFIG.richVein;
        const gold = Math.max(100, getBaseClickAmount() * getTotalMultiplier() * cfg.goldMult);
        const gems = cfg.gemsMin + Math.floor(Math.random() * (cfg.gemsMax - cfg.gemsMin + 1));
        addCoins(gold);
        gameState.gems += gems;
        rollMaterialDrop(4); // guaranteed-ish bonus material chance
        flashRewardBanner(t('event_vein_done', { gold: formatNumber(gold), gems }));
        endMineEvent();
        updateUI();
        saveGame();
    }

    // ---- Boss ----
    /**
     * REBALANCED event-boss HP: scales with the player's biome depth and gem bonus instead of a
     * fixed number. HP = 272 * seconds * 2.2^biomeIndex * sqrt(gemMultiplier), i.e. ~62% of max
     * click DPS (7 clicks/s) over the time limit, consistent with the Boss Arena formula.
     */
    function getEventBossHp(boss) {
        const level = Math.max(1, gameState.level || 1);
        let idx = 0;
        if (typeof BIOMES !== 'undefined' && BIOMES.length) {
            for (let i = 0; i < BIOMES.length; i++) if (level >= BIOMES[i].requiredLevel) idx = i;
            if (idx < BIOMES.length - 1) {
                const lo = BIOMES[idx].requiredLevel, hi = BIOMES[idx + 1].requiredLevel;
                idx += Math.min(1, Math.max(0, (level - lo) / Math.max(1, hi - lo)));
            } else {
                idx += (level - BIOMES[idx].requiredLevel) / 150;
            }
        }
        const gemMult = Math.max(1, Number(gameState.prestigeMultiplier) || 1);
        const seconds = (boss.timeMs || 20000) / 1000;
        return Math.max(boss.hp || 1, Math.round(272 * seconds * Math.pow(2.2, idx) * Math.sqrt(gemMult)));
    }

    /** Gold payout scales with income: the listed loot.gold is the floor, and equals ~loot.gold/250 seconds of income. */
    function getEventBossGold(boss) {
        const rate = typeof getEffectiveIncomeRate === 'function' ? getEffectiveIncomeRate() : 0;
        return Math.max(boss.loot.gold, rate * (boss.loot.gold / 250));
    }

    function spawnBossEvent() {
        const keys = Object.keys(BOSSES);
        const bossKey = keys[Math.floor(Math.random() * keys.length)];
        const boss = BOSSES[bossKey];
        const hpMax = getEventBossHp(boss);
        activeMineEvent = {
            kind: 'boss',
            bossKey,
            hpMax: hpMax,
            hpCurrent: hpMax,
            expiresAt: Date.now() + boss.timeMs
        };
        renderBossBanner(boss);
    }

    function renderBossBanner(boss) {
        removeEventBanner();
        const banner = document.createElement('div');
        banner.className = 'mine-event-banner';
        banner.id = 'mine-event-banner';
        banner.innerHTML = `
            <div class="mine-event-title">${boss.icon} ${boss.name}</div>
            <div class="mine-event-timer" id="mine-event-timer-label"></div>
            <div class="mine-event-hpbar-outer">
                <div class="mine-event-hpbar-inner" id="mine-event-hpbar-inner" style="width:100%"></div>
            </div>
            <button class="mine-event-target boss-${boss.type}" id="mine-event-target-btn">
                <span class="mine-event-icon-big">${boss.icon}</span>
                ${t('event_attack')}
            </button>
        `;
        document.body.appendChild(banner);
        document.getElementById('mine-event-target-btn').addEventListener('click', (e) => {
            handleActiveEventClick(e);
        });
    }

    function updateBossHpBar() {
        const bar = document.getElementById('mine-event-hpbar-inner');
        if (!bar || !activeMineEvent) return;
        const pct = Math.max(0, (activeMineEvent.hpCurrent / activeMineEvent.hpMax) * 100);
        bar.style.width = pct + '%';
    }

    function completeBoss() {
        const boss = BOSSES[activeMineEvent.bossKey];
        const bossGold = getEventBossGold(boss);
        addCoins(bossGold);
        gameState.gems += boss.loot.gems;
        const a = ensureAdventureState();
        for (const matKey in boss.loot.materials || {}) {
            a.materials[matKey] = (a.materials[matKey] || 0) + boss.loot.materials[matKey];
        }
        markAdvDirty('inventory', 'crafting', 'runes');
        flashRewardBanner(t('event_boss_done', { name: boss.name, gold: formatNumber(bossGold), gems: boss.loot.gems }));
        endMineEvent();
        updateUI();
        saveGame();
    }

    // ---- Rift ----
    function spawnRiftEvent() {
        const cfg = EVENT_CONFIG.rift;
        activeMineEvent = {
            kind: 'rift',
            total: cfg.particleCount,
            hit: 0,
            expiresAt: Date.now() + cfg.timeMs
        };
        renderRiftBanner();
        spawnRiftParticles(cfg.particleCount, cfg.timeMs);
    }

    function renderRiftBanner() {
        removeEventBanner();
        const banner = document.createElement('div');
        banner.className = 'mine-event-banner';
        banner.id = 'mine-event-banner';
        banner.innerHTML = `
            <div class="mine-event-title">${t('event_rift_title')}</div>
            <div class="mine-event-timer" id="mine-event-timer-label"></div>
            <div style="font-size:0.8em;color:var(--text-muted);">${t('event_rift_hint', { progress: '<span id="rift-progress">0</span>', total: activeMineEvent.total })}</div>
        `;
        document.body.appendChild(banner);
    }

    function spawnRiftParticles(count, lifetimeMs) {
        for (let i = 0; i < count; i++) {
            setTimeout(() => {
                if (!activeMineEvent || activeMineEvent.kind !== 'rift') return;
                const p = document.createElement('div');
                p.className = 'rift-particle';
                const margin = 50;
                p.style.left = (margin + Math.random() * (window.innerWidth - margin * 2)) + 'px';
                p.style.top = (margin + Math.random() * (window.innerHeight - margin * 2 - 100)) + 'px';
                document.body.appendChild(p);
                // Lifetime only counts down while the game runs (paused time does not use it up).
                let lifeLeft = lifetimeMs - i * 200 > 500 ? lifetimeMs - i * 200 : 500;
                let despawn = null;
                const lifeTick = () => {
                    if (!p.isConnected) return;
                    if (!(typeof isGamePaused === 'function' && isGamePaused())) lifeLeft -= 250;
                    if (lifeLeft <= 0) { p.remove(); return; }
                    despawn = setTimeout(lifeTick, 250);
                };
                despawn = setTimeout(lifeTick, 250);
                p.addEventListener('click', (e) => {
                    clearTimeout(despawn);
                    handleActiveEventClick(e);
                });
            }, i * 300);
        }
    }

    function completeRift() {
        const cfg = EVENT_CONFIG.rift;
        const gold = Math.max(80, getBaseClickAmount() * getTotalMultiplier() * cfg.rewardGoldMult);
        const gems = cfg.rewardGemsMin + Math.floor(Math.random() * (cfg.rewardGemsMax - cfg.rewardGemsMin + 1));
        addCoins(gold);
        gameState.gems += gems;
        rollMaterialDrop(3);
        flashRewardBanner(t('event_rift_done', { gold: formatNumber(gold), gems }));
        endMineEvent();
        updateUI();
        saveGame();
    }

    function flashRewardBanner(text) {
        removeEventBanner();
        const el = document.createElement('div');
        el.className = 'mine-event-burst';
        el.style.position = 'fixed';
        el.style.left = '50%';
        el.style.top = '18px';
        el.style.transform = 'translateX(-50%)';
        el.style.fontSize = '1.1em';
        el.textContent = text;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 1400);
    }

    function tickActiveMineEvent() {
        if (!activeMineEvent) return;
        const remaining = activeMineEvent.expiresAt - Date.now();
        const label = document.getElementById('mine-event-timer-label');
        if (label) label.textContent = t('event_time_left', { secs: Math.max(0, Math.ceil(remaining / 1000)) });
        const riftProgress = document.getElementById('rift-progress');
        if (riftProgress) riftProgress.textContent = String(activeMineEvent.hit);
        if (remaining <= 0) {
            endMineEvent();
        }
    }

    /* =========================================================
       UI: CACHED / INCREMENTAL RENDERING
       =========================================================
       Two phases per section:
         initXxxUI()   - builds the static DOM once (innerHTML is
                         fine here), caches element references.
         updateXxxUI() - only touches existing nodes, and only when
                         a value differs from the cached one.
       Game code never renders directly; it calls markAdvDirty() and
       a single requestAnimationFrame flush updates only the section
       that is currently visible. Hidden sections stay dirty and are
       brought up to date when their tab is opened.
       ========================================================= */

    let advOverlayOpenTab = 'crafting';

    const advUI = {
        dirty: { inventory: true, crafting: true, runes: true, buffs: true },
        flushQueued: false,
        inventory: { ready: false, grid: null, cards: {} },
        crafting: { ready: false, grid: null, cards: {}, buffsEl: null, buffChips: [] },
        runes: {
            ready: false, slotCountEl: null, slotsEl: null, grid: null,
            slotCount: -1, slots: [], slotKeys: [], cards: {}
        }
    };

    function isAdvOverlayOpen() {
        return !!(dom_adv.overlay && dom_adv.overlay.classList.contains('open'));
    }

    function openAdvOverlay() {
        if (dom_adv.overlay) dom_adv.overlay.classList.add('open');
        if (typeof setActiveNavTab === 'function') setActiveNavTab('adventures');
        switchAdvTab(advOverlayOpenTab);
    }

    function closeAdvOverlay() {
        if (dom_adv.overlay) dom_adv.overlay.classList.remove('open');
        if (typeof setActiveNavTab === 'function') setActiveNavTab('main');
    }

    function switchAdvTab(tab) {
        advOverlayOpenTab = tab;
        const panels = advPanelCache();
        for (const k in panels.panels) panels.panels[k].classList.toggle('active', k === tab);
        for (const k in panels.buttons) panels.buttons[k].classList.toggle('active', k === tab);
        // Opening a tab always reconciles it once (diff-guarded, so cheap).
        advUI.dirty[tab] = true;
        if (tab === 'crafting') advUI.dirty.buffs = true;
        flushAdvUI();
    }

    // Tab panels/buttons are cached on first use.
    let advPanelRefs = null;
    function advPanelCache() {
        if (advPanelRefs) return advPanelRefs;
        advPanelRefs = { panels: {}, buttons: {} };
        ['crafting', 'runes', 'inventory'].forEach((t) => {
            advPanelRefs.panels[t] = document.getElementById('adv-tab-panel-' + t);
            advPanelRefs.buttons[t] = document.getElementById('adv-tab-btn-' + t);
        });
        // Drop missing ones so toggle loops never hit null.
        for (const k of Object.keys(advPanelRefs.panels)) if (!advPanelRefs.panels[k]) delete advPanelRefs.panels[k];
        for (const k of Object.keys(advPanelRefs.buttons)) if (!advPanelRefs.buttons[k]) delete advPanelRefs.buttons[k];
        return advPanelRefs;
    }

    /** Marks sections as needing a refresh. Cheap: no DOM work here. */
    function markAdvDirty() {
        for (let i = 0; i < arguments.length; i++) advUI.dirty[arguments[i]] = true;
        if (advUI.flushQueued || !isAdvOverlayOpen()) return;
        advUI.flushQueued = true;
        requestAnimationFrame(() => {
            advUI.flushQueued = false;
            flushAdvUI(false);
        });
    }

    /** Updates the visible tab's dirty sections. Initializes DOM on first open. */
    function flushAdvUI() {
        if (!isAdvOverlayOpen()) return;
        const d = advUI.dirty;
        if (advOverlayOpenTab === 'inventory') {
            if (d.inventory) { d.inventory = false; updateInventoryUI(); }
        } else if (advOverlayOpenTab === 'crafting') {
            if (d.crafting) { d.crafting = false; updateCraftingUI(); }
            if (d.buffs) { d.buffs = false; updateActiveBuffChips(); }
        } else if (advOverlayOpenTab === 'runes') {
            if (d.runes) { d.runes = false; updateRunesUI(); }
        }
    }

    // Backwards-compatible names (other code paths may still call these).
    function renderInventoryTab() { markAdvDirty('inventory'); }
    function renderCraftingTab() { markAdvDirty('crafting', 'buffs'); }
    function renderRunesTab() { markAdvDirty('runes'); }
    function renderActiveBuffChips() { markAdvDirty('buffs'); }

    // Shared cost-chip helper: cached text + class, written only on change.
    function createCostChips(container, cost) {
        const chips = [];
        for (const matKey in cost) {
            const el = document.createElement('span');
            el.className = 'adv-recipe-cost-chip';
            container.appendChild(el);
            chips.push({ el, matKey, need: cost[matKey], lastHave: -1, lastShort: null });
        }
        return chips;
    }

    function updateCostChips(chips, materials) {
        for (let i = 0; i < chips.length; i++) {
            const c = chips[i];
            const have = materials[c.matKey] || 0;
            if (have !== c.lastHave) {
                c.lastHave = have;
                c.el.textContent = MATERIALS[c.matKey].icon + ' ' + have + '/' + c.need;
            }
            const short = have < c.need;
            if (short !== c.lastShort) {
                c.lastShort = short;
                c.el.classList.toggle('insufficient', short);
            }
        }
    }

    function setDisabled(btn, rec, value) {
        if (rec.disabled !== value) { rec.disabled = value; btn.disabled = value; }
    }

    function setText(el, rec, prop, value) {
        if (rec[prop] !== value) { rec[prop] = value; el.textContent = value; }
    }

    /* =========================================================
       UI: INVENTORY TAB
       ========================================================= */

    function initInventoryUI() {
        const grid = document.getElementById('adv-material-grid');
        if (!grid) return false;
        const ui = advUI.inventory;
        ui.grid = grid;
        ui.cards = {};
        grid.innerHTML = Object.keys(MATERIALS).map((key) => {
            const mat = MATERIALS[key];
            return `
                <div class="adv-material-card" data-mat="${key}">
                    <div class="adv-material-icon">${mat.icon}</div>
                    <div class="adv-material-name">${mat.name}</div>
                    <div class="adv-material-count"></div>
                </div>
            `;
        }).join('');
        const cardEls = grid.children;
        let i = 0;
        for (const key in MATERIALS) {
            const card = cardEls[i++];
            ui.cards[key] = { countEl: card.lastElementChild, last: null };
        }
        ui.ready = true;
        return true;
    }

    function updateInventoryUI() {
        const ui = advUI.inventory;
        if (!ui.ready && !initInventoryUI()) return;
        const a = gameState.adventures;
        for (const key in ui.cards) {
            const rec = ui.cards[key];
            const count = a.materials[key] || 0;
            if (count !== rec.last) {
                rec.last = count;
                rec.countEl.textContent = formatNumber(count);
            }
        }
    }

    /* =========================================================
       UI: CRAFTING TAB
       ========================================================= */

    function hasEnoughMaterials(cost) {
        const a = ensureAdventureState();
        for (const key in cost) {
            if ((a.materials[key] || 0) < cost[key]) return false;
        }
        return true;
    }

    function spendMaterials(cost) {
        const a = ensureAdventureState();
        for (const key in cost) a.materials[key] -= cost[key];
    }

    function initCraftingUI() {
        const grid = document.getElementById('adv-recipe-grid');
        if (!grid) return false;
        const ui = advUI.crafting;
        ui.grid = grid;
        ui.cards = {};

        grid.innerHTML = Object.keys(RECIPES).map((key) => {
            const r = RECIPES[key];
            return `
                <div class="adv-recipe-card" data-recipe-card="${key}">
                    <div class="adv-recipe-top">
                        <span class="adv-recipe-name">${r.icon} ${r.name}</span>
                        <span class="adv-recipe-tag ${r.type === 'potion' ? 'tag-potion' : 'tag-permanent'}">${t('recipe_tag_' + r.type)}</span>
                    </div>
                    <div class="adv-recipe-desc">${r.description}</div>
                    <div class="adv-recipe-costs"></div>
                    <button class="adv-craft-btn" data-recipe="${key}"></button>
                </div>
            `;
        }).join('');

        const cardEls = grid.children;
        let i = 0;
        for (const key in RECIPES) {
            const card = cardEls[i++];
            const costsEl = card.querySelector('.adv-recipe-costs');
            ui.cards[key] = {
                card,
                btn: card.querySelector('.adv-craft-btn'),
                chips: createCostChips(costsEl, RECIPES[key].cost),
                ownedEl: null,
                label: null,
                disabled: null,
                owned: null
            };
        }

        // One delegated listener for all craft buttons (added exactly once).
        grid.addEventListener('click', (e) => {
            const btn = e.target.closest('.adv-craft-btn');
            if (btn && grid.contains(btn)) craftRecipe(btn.getAttribute('data-recipe'));
        });

        ui.ready = true;
        return true;
    }

    function updateCraftingUI() {
        const ui = advUI.crafting;
        if (!ui.ready && !initCraftingUI()) return;
        const a = gameState.adventures;
        for (const key in ui.cards) {
            const r = RECIPES[key];
            const rec = ui.cards[key];
            const alreadyOwned = !!(r.type === 'permanent' && r.maxOwned && a.ownedPermanent[key]);

            updateCostChips(rec.chips, a.materials);

            const label = alreadyOwned ? t('recipe_btn_owned') : (r.type === 'potion' ? t('recipe_btn_brew') : t('recipe_btn_craft'));
            setText(rec.btn, rec, 'label', label);
            setDisabled(rec.btn, rec, alreadyOwned || !hasEnoughMaterials(r.cost));

            if (alreadyOwned !== rec.owned) {
                rec.owned = alreadyOwned;
                if (alreadyOwned) {
                    if (!rec.ownedEl) {
                        rec.ownedEl = document.createElement('div');
                        rec.ownedEl.className = 'adv-recipe-owned';
                        rec.ownedEl.textContent = t('recipe_owned_active');
                    }
                    rec.card.appendChild(rec.ownedEl);
                } else if (rec.ownedEl && rec.ownedEl.parentNode) {
                    rec.ownedEl.parentNode.removeChild(rec.ownedEl);
                }
            }
        }
    }

    function craftRecipe(key) {
        const r = RECIPES[key];
        if (!r) return;
        const a = ensureAdventureState();
        if (!hasEnoughMaterials(r.cost)) return;
        if (r.type === 'permanent' && r.maxOwned && a.ownedPermanent[key]) return;

        spendMaterials(r.cost);

        if (r.type === 'potion') {
            a.activePotions.push({
                key,
                clickMult: r.clickMult || undefined,
                cpsMult: r.cpsMult || undefined,
                expiresAt: Date.now() + r.durationMs
            });
        } else {
            a.ownedPermanent[key] = true;
        }

        markAdvDirty('crafting', 'buffs', 'inventory', 'runes');
        flushAdvUI(); // immediate feedback for a direct user action
        saveGame();
    }

    /** Active potion countdown chips: reuses span nodes, writes text only when it changes. */
    function updateActiveBuffChips() {
        const ui = advUI.crafting;
        if (!ui.buffsEl) {
            let container = document.getElementById('adv-active-buffs');
            const panel = document.getElementById('adv-tab-panel-crafting');
            if (!container && panel) {
                container = document.createElement('div');
                container.id = 'adv-active-buffs';
                container.className = 'adv-active-buffs';
                panel.insertBefore(container, panel.firstChild.nextSibling);
            }
            if (!container) return;
            ui.buffsEl = container;
        }
        const now = Date.now();
        const potions = gameState.adventures.activePotions || [];
        const chips = ui.buffChips;
        let n = 0;
        for (let i = 0; i < potions.length; i++) {
            const p = potions[i];
            if (p.expiresAt <= now) continue;
            let chip = chips[n];
            if (!chip) {
                const el = document.createElement('span');
                el.className = 'adv-active-buff-chip';
                ui.buffsEl.appendChild(el);
                chip = chips[n] = { el, text: null };
            }
            const r = RECIPES[p.key];
            const secsLeft = Math.max(0, Math.ceil((p.expiresAt - now) / 1000));
            const text = t('recipe_buff_chip', { icon: r ? r.icon : '🧪', name: r ? r.name : p.key, secs: secsLeft });
            if (text !== chip.text) {
                chip.text = text;
                chip.el.textContent = text;
            }
            n++;
        }
        while (chips.length > n) {
            const chip = chips.pop();
            if (chip.el.parentNode) chip.el.parentNode.removeChild(chip.el);
        }
    }

    /* =========================================================
       UI: RUNES TAB
       ========================================================= */

    function initRunesUI() {
        const ui = advUI.runes;
        const grid = document.getElementById('adv-rune-grid');
        const slotsEl = document.getElementById('adv-rune-slots');
        ui.slotCountEl = document.getElementById('adv-runes-hint');
        ui.slotsEl = slotsEl;
        ui.grid = grid;
        ui.cards = {};

        if (grid) {
            grid.innerHTML = Object.keys(RUNES).map((key) => {
                const rune = RUNES[key];
                return `
                    <div class="adv-rune-card" data-rune-card="${key}">
                        <div class="adv-rune-card-name">${rune.icon} ${rune.name}</div>
                        <div class="adv-rune-card-desc">${rune.description}</div>
                        <div class="adv-recipe-costs"></div>
                        <button class="adv-rune-card-btn"></button>
                    </div>
                `;
            }).join('');

            const cardEls = grid.children;
            let i = 0;
            for (const key in RUNES) {
                const card = cardEls[i++];
                const costsEl = card.querySelector('.adv-recipe-costs');
                ui.cards[key] = {
                    card,
                    costsEl,
                    btn: card.querySelector('.adv-rune-card-btn'),
                    chips: createCostChips(costsEl, RUNES[key].cost),
                    state: null,      // 'craft' | 'equipped' | 'equip'
                    label: null,
                    disabled: null,
                    costsHidden: null,
                    runeKey: key
                };
                card.setAttribute('data-rune-card', key);
            }

            // Delegated once; action depends on the card's current cached state.
            grid.addEventListener('click', (e) => {
                const btn = e.target.closest('.adv-rune-card-btn');
                if (!btn || !grid.contains(btn) || btn.disabled) return;
                const cardEl = btn.closest('[data-rune-card]');
                if (!cardEl) return;
                const key = cardEl.getAttribute('data-rune-card');
                const rec = ui.cards[key];
                if (!rec) return;
                if (rec.state === 'craft') craftRune(key);
                else if (rec.state === 'equip') equipRune(key);
            });
        }

        if (slotsEl) {
            // Delegated unequip handler (added exactly once).
            slotsEl.addEventListener('click', (e) => {
                const el = e.target.closest('.adv-rune-slot.filled');
                if (!el || !slotsEl.contains(el)) return;
                const a = ensureAdventureState();
                const idx = Number(el.getAttribute('data-slot'));
                a.equippedRunes[idx] = null;
                markAdvDirty('runes', 'crafting');
                flushAdvUI();
                updateThunderRuneChargeDisplay();
                saveGame();
            });
        }

        ui.ready = true;
    }

    function rebuildRuneSlotElements(count) {
        const ui = advUI.runes;
        ui.slotCount = count;
        ui.slots = [];
        ui.slotKeys = [];
        if (!ui.slotsEl) return;
        let html = '';
        for (let i = 0; i < count; i++) {
            html += `<div class="adv-rune-slot" data-slot="${i}">${t('rune_slot_empty', { n: i + 1 })}</div>`;
            ui.slotKeys.push(null);
        }
        ui.slotsEl.innerHTML = html; // only when the slot COUNT changes (e.g. VIP)
        for (let i = 0; i < count; i++) ui.slots.push(ui.slotsEl.children[i]);
    }

    function updateRunesUI() {
        const ui = advUI.runes;
        if (!ui.ready) initRunesUI();
        const a = gameState.adventures;
        const equipped = a.equippedRunes;

        // Slot count label + slot elements (rebuilt only if count changed)
        const runesHint = t('adv_runes_hint', { slots: equipped.length });
        if (ui.slotCountEl && ui.slotCountEl.textContent !== runesHint) {
            ui.slotCountEl.textContent = runesHint;
        }
        if (ui.slotsEl && ui.slotCount !== equipped.length) rebuildRuneSlotElements(equipped.length);

        // Each slot: touch only if its rune changed
        for (let i = 0; i < ui.slots.length; i++) {
            const runeKey = equipped[i] || null;
            if (ui.slotKeys[i] === runeKey) continue;
            ui.slotKeys[i] = runeKey;
            const el = ui.slots[i];
            const rune = runeKey && RUNES[runeKey];
            if (rune) {
                el.className = 'adv-rune-slot filled';
                el.title = t('rune_slot_unequip');
                el.innerHTML = `<span class="adv-rune-slot-icon">${rune.icon}</span><span>${rune.name}</span>`;
            } else {
                el.className = 'adv-rune-slot';
                el.removeAttribute('title');
                el.innerHTML = t('rune_slot_empty', { n: i + 1 });
            }
        }

        // Rune cards
        let slotsFull = true;
        for (let i = 0; i < equipped.length; i++) if (equipped[i] === null) { slotsFull = false; break; }

        for (const key in ui.cards) {
            const rune = RUNES[key];
            const rec = ui.cards[key];
            const owned = !!a.craftedRunes[key];
            const isEquipped = equipped.indexOf(key) !== -1;

            // Cost row only while not owned (original removed it when owned)
            if (rec.costsHidden !== owned) {
                rec.costsHidden = owned;
                rec.costsEl.style.display = owned ? 'none' : '';
            }
            if (!owned) updateCostChips(rec.chips, a.materials);

            let state, label, disabled;
            if (!owned) {
                state = 'craft'; label = t('rune_btn_craft'); disabled = !hasEnoughMaterials(rune.cost);
            } else if (isEquipped) {
                state = 'equipped'; label = t('rune_btn_equipped'); disabled = true;
            } else {
                state = 'equip'; label = slotsFull ? t('rune_btn_full') : t('rune_btn_equip'); disabled = slotsFull;
            }
            if (state !== rec.state) {
                rec.state = state;
                rec.btn.classList.toggle('equip', state === 'equip');
            }
            setText(rec.btn, rec, 'label', label);
            setDisabled(rec.btn, rec, disabled);
        }
    }

    function craftRune(key) {
        const rune = RUNES[key];
        if (!rune) return;
        const a = ensureAdventureState();
        if (a.craftedRunes[key]) return;
        if (!hasEnoughMaterials(rune.cost)) return;
        spendMaterials(rune.cost);
        a.craftedRunes[key] = true;
        markAdvDirty('runes', 'inventory', 'crafting');
        flushAdvUI();
        saveGame();
    }

    function equipRune(key) {
        const a = ensureAdventureState();
        if (!a.craftedRunes[key] || a.equippedRunes.includes(key)) return;
        const emptyIdx = a.equippedRunes.indexOf(null);
        if (emptyIdx === -1) return;
        a.equippedRunes[emptyIdx] = key;
        markAdvDirty('runes');
        flushAdvUI();
        updateThunderRuneChargeDisplay(); // show badge immediately if Thunder Rune was just equipped
        saveGame();
    }

    /* =========================================================
       DOM REFS & WIRING
       ========================================================= */

    const dom_adv = {
        overlay: document.getElementById('adv-overlay'),
        closeBtn: document.getElementById('adv-close'),
        navTab: document.getElementById('nav-tab-adventures'),
        tabBtnCrafting: document.getElementById('adv-tab-btn-crafting'),
        tabBtnRunes: document.getElementById('adv-tab-btn-runes'),
        tabBtnInventory: document.getElementById('adv-tab-btn-inventory')
    };

    if (dom_adv.navTab) {
        dom_adv.navTab.addEventListener('click', () => {
            if (typeof closeAllNavModals === 'function') closeAllNavModals();
            openAdvOverlay();
        });
    }
    if (dom_adv.closeBtn) {
        dom_adv.closeBtn.addEventListener('click', closeAdvOverlay);
    }
    if (dom_adv.overlay) {
        dom_adv.overlay.addEventListener('click', (e) => {
            if (e.target === dom_adv.overlay) closeAdvOverlay();
        });
    }
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dom_adv.overlay && dom_adv.overlay.classList.contains('open')) closeAdvOverlay();
    });
    if (dom_adv.tabBtnCrafting) dom_adv.tabBtnCrafting.addEventListener('click', () => switchAdvTab('crafting'));
    if (dom_adv.tabBtnRunes) dom_adv.tabBtnRunes.addEventListener('click', () => switchAdvTab('runes'));
    if (dom_adv.tabBtnInventory) dom_adv.tabBtnInventory.addEventListener('click', () => switchAdvTab('inventory'));

    // Also fold adventures state closing into closeAllNavModals by wrapping it,
    // so picking another bottom-nav tab closes this modal too.
    if (typeof closeAllNavModals === 'function') {
        const originalCloseAllNavModals = closeAllNavModals;
        window.closeAllNavModals = function () {
            originalCloseAllNavModals();
            if (dom_adv.overlay && dom_adv.overlay.classList.contains('open')) {
                dom_adv.overlay.classList.remove('open');
            }
        };
    }

    /* =========================================================
       KICK OFF EVENT SCHEDULING
       ========================================================= */

    scheduleNextAdvEvent();

    // Pause integration (script_2.js): these timers are Date.now()-based, so push them forward by the paused time.
    window.addEventListener('gc:pause-shift', (e) => {
        const ms = e && e.detail && e.detail.elapsedMs;
        if (!Number.isFinite(ms) || ms <= 0) return;
        const was = Date.now() - ms;
        if (activeMineEvent && Number.isFinite(activeMineEvent.expiresAt) && activeMineEvent.expiresAt > was) activeMineEvent.expiresAt += ms;
        const a = gameState.adventures;
        if (a && Array.isArray(a.activePotions)) {
            a.activePotions.forEach((p) => { if (p && Number.isFinite(p.expiresAt) && p.expiresAt > was) p.expiresAt += ms; });
        }
    });

    // Periodic UI refresh for potion countdown chips while the crafting
    // tab is open (cheap: just text updates on existing DOM nodes).
    setInterval(() => {
        if (advOverlayOpenTab === 'crafting' && isAdvOverlayOpen()) {
            updateActiveBuffChips();
        }
    }, 1000);

    // NEW: reflect the Thunder Rune charge badge's initial state on load
    // (e.g. a save where the rune was already equipped from a previous
    // session should show the badge immediately, not just after the
    // next click).
    updateThunderRuneChargeDisplay();

    /* =========================================================
       LOCALIZATION: refresh cached text after a language switch
       ========================================================= */
    function relocalizeAdventuresUI() {
        try {
            const inv = advUI.inventory;
            if (inv.ready && inv.grid) {
                for (const key in MATERIALS) {
                    const nameEl = inv.grid.querySelector('[data-mat="' + key + '"] .adv-material-name');
                    if (nameEl) nameEl.textContent = MATERIALS[key].name;
                }
            }
            const cr = advUI.crafting;
            if (cr.ready) {
                for (const key in cr.cards) {
                    const rec = cr.cards[key], r = RECIPES[key];
                    const nameEl = rec.card.querySelector('.adv-recipe-name');
                    if (nameEl) nameEl.textContent = r.icon + ' ' + r.name;
                    const tagEl = rec.card.querySelector('.adv-recipe-tag');
                    if (tagEl) tagEl.textContent = t('recipe_tag_' + r.type);
                    const descEl = rec.card.querySelector('.adv-recipe-desc');
                    if (descEl) descEl.textContent = r.description;
                    if (rec.ownedEl) rec.ownedEl.textContent = t('recipe_owned_active');
                    rec.label = null;
                }
                cr.buffChips.forEach((c) => { c.text = null; });
            }
            const ru = advUI.runes;
            if (ru.ready) {
                for (const key in ru.cards) {
                    const rec = ru.cards[key], rune = RUNES[key];
                    const nameEl = rec.card.querySelector('.adv-rune-card-name');
                    if (nameEl) nameEl.textContent = rune.icon + ' ' + rune.name;
                    const descEl = rec.card.querySelector('.adv-rune-card-desc');
                    if (descEl) descEl.textContent = rune.description;
                    rec.label = null;
                }
                ru.slotKeys = ru.slotKeys.map(() => undefined); // force every slot to repaint
                if (ru.slotCountEl) ru.slotCountEl.textContent = '';
            }
            advUI.dirty = { inventory: true, crafting: true, runes: true, buffs: true };
            flushAdvUI();
        } catch (e) {
            console.error('Adventures localization refresh failed:', e);
        }
    }
    if (window.i18n) window.i18n.onChange(relocalizeAdventuresUI);

})();
