/* =============================================================
   BOSSES & KEY CHESTS MODULE
   =============================================================
   Adds a floating "⚔️ BOSSES" button (above the bottom nav) that
   opens a modal with two tabs:
     - Boss Fights: fight one of 3 bosses for FREE (no key needed,
       only a short recovery cooldown) within a time limit, dealing
       damage per click, for scaling loot. Bosses DROP the keys.
     - 🧰 Key Altar: spend boss-dropped Keys to open chests that give
       coins / XP / gems / relics (never keys -- see script_2.js).

   100% additive, same pattern as adventures.js:
   - Reuses gameState, dom, addCoins, getTotalMultiplier,
     getBaseClickAmount, formatNumber, saveGame, playTone, etc.
     as globals (loads after script.js and adventures.js).
   - Keys live in the shared gameState.keys (same store the Key Altar
     uses). Any legacy gameState.adventures.keys are migrated into it.
     Boss cooldowns persist in gameState.bossCooldowns.
   - Reuses gameState.adventures.materials for Iron Ore / Glowing
     Spores / Mithril Shards / Abyss Crystals, and
     gameState.adventures.craftedRunes for rune rewards, so it
     stays in sync with the existing Adventures & Crafting module.
   ============================================================= */

(function () {
    'use strict';

    if (typeof gameState === 'undefined' || typeof dom === 'undefined') {
        console.warn('Bosses module: core game not found, aborting init.');
        return;
    }

    /* =========================================================
       DATA TABLES
       ========================================================= */

    // (Removed: the old 50-Gem chest that rolled for Keys. Keys now come
    // only from bosses; chests are opened by script_2.js's Key Altar.)

    // === REBALANCED: BOSS COOLDOWN ===
    // Recovery time before the same boss can be fought again. Entry is
    // otherwise free -- rarity keys are NEVER required to start a fight.
    //
    // This used to inherit BOSS_ENTRY_COOLDOWN_MS from script_2.js, which
    // is only 30 seconds. That let a player re-fight (and re-loot) every
    // boss 120 times per hour. script_2.js is intentionally left untouched
    // (bosses.js loads last, and startBossCooldown() already accepts a
    // custom duration), so the real cooldowns now live on each boss as
    // `cooldownMs` below. This constant is only the DEFAULT used for a
    // boss that has no cooldownMs of its own, set to the Easy tier's 5 min
    // rather than the old 30s so nothing can silently fall back to spam.
    const BOSS_COOLDOWN_MS = 5 * 60 * 1000;

    // After a DEFEAT (timer ran out) the boss only "recovers" for this
    // fraction of its normal cooldown. A full 5-10 minute lockout for a
    // loss would feel punishing now that cooldowns are long, but the
    // player must still wait a while so a loss can't be spam-retried.
    const BOSS_DEFEAT_COOLDOWN_FRACTION = 0.5;

    const KEY_TYPES = {
        common: { get name() { return tp('key_name_common', 1); }, icon: '🗝️', rarityClass: 'common' },
        rare: { get name() { return tp('key_name_rare', 1); }, icon: '🔑', rarityClass: 'rare' },
        legendary: { get name() { return tp('key_name_legendary', 1); }, icon: '🏆🔑', rarityClass: 'legendary' }
    };

    // Bosses: key-drop tier, time limit, HP formula, and
    // scaling rewards (function of CPS where relevant). materials keys
    // reuse the Adventures module's material IDs so rewards land in the
    // same inventory; runeKey reuses the Adventures module's RUNES ids
    // so a defeated boss can grant one.
    //
    // === REBALANCED: BOSS ECONOMY (HP, COOLDOWN, REWARDS) ===
    //
    // WHY THIS WAS REBALANCED
    // The previous numbers made bosses the best thing in the game:
    //   - 30s cooldown  -> each boss re-lootable ~120x per hour.
    //   - HP was tiny: a player with only pickaxes dealt 9x-100x a
    //     Stone Golem's HP inside one fight, winning in ~1-3 s.
    //   - Rewards were huge: coins = CPS * 15/60/300, and because the
    //     reward is proportional to CPS the income share of a boss is
    //     simply  coinsCpsMult / cooldownSeconds  (independent of how
    //     rich you are). Farming all three was worth roughly +1250% of
    //     normal idle income. Shadow Wraith gems (30-45, each gem =
    //     +10% PERMANENT multiplier) beat an entire early prestige on
    //     every single kill, and a 50% rune chance was routine.
    //
    // HOW HP IS NOW DERIVED
    //   HP = baseHp * hpLevelGrowth^(level-1) * zoneMultiplier^hpZoneWeight
    // (same formula and same field names as before -- only the numbers
    //  changed.) Player click damage is (1 + pickaxes) * levelMult *
    // zoneMultiplier, i.e. it scales with the zone at power 1.0, then
    // grows ~quadratically with level inside a biome. So:
    //   - hpZoneWeight = 1.0 for every boss: HP jumps by the same x10
    //     per biome that the player's own damage does. (The old 0.6-0.7
    //     made bosses ~2.5x EASIER at every new biome, which is why they
    //     got more trivial the deeper you went.)
    //   - hpLevelGrowth 1.02 / 1.018 / 1.016: a gentle per-level factor.
    //     Fitted so the win-margin stays in a stable band from the first
    //     winnable level through Level ~160 (pickaxe count only grows
    //     ~logarithmically because prices grow 1.15^n).
    //   - baseHp 2500 / 12000 / 30000 (Easy : Hard : Legendary is about
    //     1 : 4.8 : 12) anchors WHEN each boss becomes beatable for a
    //     typical player who has put ~10% of their coins into pickaxes
    //     (5 clicks/s):
    //        Stone Golem   -> around Level 8-10, no prep needed
    //        Mine Dragon   -> around Level 20-25 (a Berserker Potion
    //                         makes it winnable earlier)
    //        Shadow Wraith -> a wall: needs Berserker Potion + Thunder
    //                         Rune / crit luck, comfortable from ~L35+
    //   Because these are tuned around the game's own prep tools
    //   (Berserker Potion = x5 click power, Thunder Rune ~ x2.9 average),
    //   preparing for a boss is now part of the fight.
    //
    // HOW REWARDS ARE NOW DERIVED
    //   - cooldownMs: Easy 5 min / Hard 7.5 min / Legendary 10 min.
    //   - coinsCpsMult is chosen from a TARGET INCOME SHARE:
    //         coinsCpsMult = targetShare * cooldownSeconds
    //     Golem 6% (18), Dragon 10% (45), Wraith 15% (90). Farming ALL
    //     THREE non-stop, winning every fight, is only about +31% of idle
    //     income (was +1250%), so idling, upgrading and prestiging stay
    //     the main engine and bosses are a bonus.
    //   - xpCpsMult is tiny (2 / 5 / 10). XP is the most dangerous
    //     reward because it skips levels and therefore biomes. Measured
    //     against the real XP curve, one kill is now roughly 0.4% / 1.1%
    //     / 2.2% of ONE level for a player who levels every ~5 minutes
    //     (and far less for slower players), instead of 1.3% / 5.3% /
    //     26.7%. A boss can never skip a level on its own.
    //   - gems are 0-1 / 1 / 1-2. A perfect hour of farming every boss
    //     is ~23 gems total (was ~4500/h from the Wraith alone) -- less
    //     than one early prestige, in line with events/adventures.
    //   - materials are trimmed to a few units: a rune costs roughly
    //     10-15 materials to craft, so a boss is a supplement, not the
    //     primary source.
    //   - runeChance 3% / 2% / 1% (per kill). Runes are one-time unlocks
    //     (craftedRunes[key] = true), so a drop of a rune you already
    //     own is wasted. That makes rarity the whole point: expected
    //     ~1 rune per 33 / 50 / 100 kills, i.e. roughly a day or more of
    //     perfect farming, never a routine drop. The Shadow Wraith
    //     (legendary tier) is the rarest at 1%; it used to be 50%.
    // === REBALANCED: BOSS HP ===
    //   BossHP = BaseHP * 2.2^BiomeIndex * 1.5^BossTier * sqrt(GemMultiplier)
    // BiomeIndex is fractional (0 at Surface entry, 1 at the 2nd biome entry, interpolated by
    // level inside a biome) so HP grows smoothly and tracks player click damage, which was
    // measured at ~55-96 x 2.2^BiomeIndex per click. BASE_HP 5000 with the 20/30/42 s limits
    // means a boss needs ~60-70% of max click DPS (7 clicks/s) through biomes 2-4 (a bit less in deeper biomes and with many Gems).
    // sqrt(GemMultiplier): Gems raise player damage linearly, bosses follow at half speed so
    // Gems still feel powerful without trivialising fights.
    const BOSS_BASE_HP = 5000;
    const BOSS_BIOME_HP_GROWTH = 2.2;
    const BOSS_TIER_HP_GROWTH = 1.5;
    const BOSS_MAX_CLICKS_PER_SECOND = 7; // reference human click rate used for balancing

    const BOSSES = {
        stoneGolem: {
            get name() { return t('boss_stoneGolem'); },
            icon: '🗿',
            type: 'stone',
            keyTier: 'easy',      // key drop tier (see BOSS_KEY_DROP_TABLES in script_2.js)
            timeMs: 20000,       // REBALANCED: time limit tuned so the boss needs ~65% of max click DPS
            cooldownMs: 5 * 60 * 1000,   // 5 minutes
            baseHp: BOSS_BASE_HP, // BossHP = BaseHP * 2.2^BiomeIndex * 1.5^BossTier (see getBossMaxHp)
            bossTier: 0,
            coinsCpsMult: 18, // Coins = CPS * coinsCpsMult  (~6% of idle income if farmed non-stop)
            xpCpsMult: 2,     // XP = CPS * xpCpsMult (granted through the normal XP path)
            gemsMin: 0,
            gemsMax: 1,
            materials: { ironOre: 3, glowingSpores: 1 },
            runeKey: 'thunderRune',
            runeChance: 0.03
        },
        mineDragon: {
            get name() { return t('boss_mineDragon'); },
            icon: '🐲',
            type: 'lava',
            keyTier: 'hard',
            timeMs: 30000,
            cooldownMs: 7.5 * 60 * 1000, // 7.5 minutes
            baseHp: BOSS_BASE_HP,
            bossTier: 1,
            coinsCpsMult: 45, // ~10% of idle income if farmed non-stop
            xpCpsMult: 5,
            gemsMin: 1,
            gemsMax: 1,
            materials: { mithrilShards: 2, abyssCrystals: 1 },
            runeKey: 'emberRune',
            runeChance: 0.02
        },
        shadowWraith: {
            get name() { return t('boss_shadowWraith'); },
            icon: '👤',
            type: 'shadow',
            keyTier: 'legendary',
            timeMs: 42000,
            cooldownMs: 10 * 60 * 1000,  // 10 minutes
            baseHp: BOSS_BASE_HP,
            bossTier: 2,
            coinsCpsMult: 90, // ~15% of idle income if farmed non-stop
            xpCpsMult: 10,
            gemsMin: 1,
            gemsMax: 2,
            materials: { abyssCrystals: 2, mithrilShards: 2 },
            runeKey: 'greedRune',
            runeChance: 0.01
        }
    };

    /* =========================================================
       STATE INITIALIZATION & SAVE INTEGRATION
       ========================================================= */

    /** Ensures gameState.adventures.keys exists with safe defaults.
     * Also ensures gameState.adventures itself exists, in case this
     * file somehow loads before adventures.js (defensive only). */
    function ensureBossState() {
        if (!gameState.adventures || typeof gameState.adventures !== 'object') {
            gameState.adventures = {};
        }
        const a = gameState.adventures;
        // Single shared key store: gameState.keys (used by the Key Altar).
        if (!gameState.keys || typeof gameState.keys !== 'object') gameState.keys = {};
        ['common', 'rare', 'legendary'].forEach((r) => {
            if (typeof gameState.keys[r] !== 'number') gameState.keys[r] = 0;
        });
        // One-time migration of keys held in the legacy adventures.keys store.
        if (a.keys && typeof a.keys === 'object') {
            ['common', 'rare', 'legendary'].forEach((r) => {
                if (typeof a.keys[r] === 'number' && a.keys[r] > 0) {
                    gameState.keys[r] += a.keys[r];
                    a.keys[r] = 0;
                }
            });
        }
        // Persistent per-boss recovery cooldown end timestamps (ms since epoch).
        if (!gameState.bossCooldowns || typeof gameState.bossCooldowns !== 'object') gameState.bossCooldowns = {};
        // Defensive fallbacks for material/rune buckets this module reads,
        // in case adventures.js is unavailable for some reason.
        if (!a.materials || typeof a.materials !== 'object') a.materials = {};
        if (!a.craftedRunes || typeof a.craftedRunes !== 'object') a.craftedRunes = {};
        return a;
    }
    ensureBossState();

    // Fold defaults into load, same pattern as adventures.js.
    // (Also re-syncs the shared cooldown map used by script_2.js helpers.)
    if (typeof loadGame === 'function') {
        const originalLoadGame = loadGame;
        window.loadGame = function () {
            originalLoadGame();
            ensureBossState();
        };
    }
    ensureBossState();

    /* =========================================================
       HELPERS: CLICK POWER / CPS / MATERIAL NAMES
       ========================================================= */

    /** Free-entry check. Only a recovery cooldown gates a fight -- never keys. */
    function getBossCooldownRemainingMs(bossKey) {
        ensureBossState();
        if (typeof canEnterBossFight === 'function') return canEnterBossFight(bossKey).remainingMs;
        return Math.max(0, (gameState.bossCooldowns[bossKey] || 0) - Date.now());
    }

    /** Cooldown length for one boss: its own cooldownMs, else the module default. */
    function getBossCooldownDurationMs(bossKey) {
        const boss = BOSSES[bossKey];
        return (boss && typeof boss.cooldownMs === 'number' && boss.cooldownMs > 0) ? boss.cooldownMs : BOSS_COOLDOWN_MS;
    }

    /**
     * Starts the recovery timer for a boss. Same signature as before; the
     * optional second argument lets the defeat path apply a shortened
     * cooldown (a loss is not punished as hard as a win is rewarded).
     * @param {string} bossKey
     * @param {boolean} [wasDefeat=false] true when the player LOST the fight
     */
    function startBossRecovery(bossKey, wasDefeat) {
        ensureBossState();
        let duration = getBossCooldownDurationMs(bossKey);
        if (wasDefeat) duration = Math.round(duration * BOSS_DEFEAT_COOLDOWN_FRACTION);
        if (typeof startBossCooldown === 'function') startBossCooldown(bossKey, duration);
        else gameState.bossCooldowns[bossKey] = Date.now() + duration;
    }

    /** "45s" under a minute, otherwise "m:ss" (e.g. "7:30"), for the long 5-10 min cooldowns. */
    function formatCooldown(ms) {
        const totalSecs = Math.max(1, Math.ceil(ms / 1000));
        if (totalSecs < 60) return t('boss_time_secs', { n: totalSecs });
        const mins = Math.floor(totalSecs / 60);
        const secs = totalSecs % 60;
        return `${mins}:${String(secs).padStart(2, '0')}`;
    }

    /** Human label for a cooldown length, e.g. 300000 -> "5 min", 450000 -> "7.5 min". */
    function formatCooldownLabel(ms) {
        const mins = ms / 60000;
        return t('boss_cooldown_min', { n: Number.isInteger(mins) ? mins : mins.toFixed(1) });
    }

    function getEffectiveClickPower() {
        if (typeof getBaseClickAmount === 'function' && typeof getTotalMultiplier === 'function') {
            return Math.max(1, getBaseClickAmount() * getTotalMultiplier());
        }
        return 1;
    }

    function getEffectiveCps() {
        const base = gameState.coinsPerSecond || 0;
        const mult = typeof getTotalMultiplier === 'function' ? getTotalMultiplier() : 1;
        return Math.max(1, base * mult);
    }

    /**
     * === NEW: Progression-based Boss HP ===
     * Computes a boss's max HP from the player's Level and current
     * Biome depth, NOT from ClickPower. This is what makes boss fights
     * feel like they get easier as the player's damage output grows
     * relative to a boss's (comparatively slow-growing) durability.
     *
     * Formula (rebalanced): HP = baseHp * 2.2^biomeIndex * 1.5^bossTier * sqrt(gemMultiplier)
     *   - baseHp: the boss's innate toughness at Level 1 / Surface biome.
     *   - hpLevelGrowth ^ (level - 1): smooth compounding growth per level.
     *   - zoneMultiplier ^ hpZoneWeight: a dampened boost from biome depth
     *     (zoneMultiplier itself jumps 10x per biome; raising it to a
     *     fractional exponent keeps HP scaling meaningful without
     *     letting it explode as hard as raw zoneMultiplier would).
     * @param {Object} boss - a BOSSES[] entry
     * @returns {number} rounded, minimum-1 max HP
     */
    /** Fractional biome index: 0 at the first biome, +1 per biome entry level reached, interpolated by level. */
    function getBossBiomeIndex() {
        const level = Math.max(1, gameState.level || 1);
        const biomes = (typeof BIOMES !== 'undefined' && BIOMES.length) ? BIOMES : null;
        if (!biomes) return 0;
        let idx = 0;
        for (let i = 0; i < biomes.length; i++) {
            if (level >= biomes[i].requiredLevel) idx = i;
        }
        if (idx < biomes.length - 1) {
            const lo = biomes[idx].requiredLevel, hi = biomes[idx + 1].requiredLevel;
            return idx + Math.min(1, Math.max(0, (level - lo) / Math.max(1, hi - lo)));
        }
        // Past the deepest biome: keep growing slowly (about +1 index per 150 levels).
        return idx + (level - biomes[idx].requiredLevel) / 150;
    }

    function getBossMaxHp(boss) {
        const idx = getBossBiomeIndex();
        const tier = Math.max(0, Number(boss.bossTier) || 0);
        const gemMult = Math.max(1, Number(gameState.prestigeMultiplier) || 1);
        const hp = (boss.baseHp || BOSS_BASE_HP)
            * Math.pow(BOSS_BIOME_HP_GROWTH, idx)
            * Math.pow(BOSS_TIER_HP_GROWTH, tier)
            * Math.sqrt(gemMult);
        return Math.max(1, Math.round(hp));
    }

    function materialLabel(matKey) {
        const names = {
            ironOre: { icon: '🔩' },
            glowingSpores: { icon: '🍄' },
            mithrilShards: { icon: '💠' },
            abyssCrystals: { icon: '🔮' }
        };
        const m = names[matKey];
        return m ? { name: t('mat_' + matKey), icon: m.icon } : { name: matKey, icon: '📦' };
    }

    function runeLabel(runeKey) {
        const names = {
            thunderRune: { icon: '⚡' },
            emberRune: { icon: '🔥' },
            greedRune: { icon: '🍀' }
        };
        const r = names[runeKey];
        return r ? { name: t('rune_' + runeKey + '_name'), icon: r.icon } : { name: runeKey, icon: '📜' };
    }

    /* =========================================================
       AUDIO — SFX via existing Web Audio helper (playTone), with
       distinct cues per event. Falls back silently if unavailable.
       ========================================================= */

    function safePlayTone(opts) {
        if (typeof playTone === 'function') playTone(opts);
    }

    function playChestOpenSound() {
        // Low rumbling sweep for the lid creaking open.
        safePlayTone({ freq: 140, endFreq: 90, duration: 0.35, type: 'sawtooth', volume: 0.18 });
        setTimeout(() => safePlayTone({ freq: 220, endFreq: 260, duration: 0.15, type: 'square', volume: 0.12 }), 180);
    }

    function playChestEmptySound() {
        // Dull thud + descending fizzle for a bust roll.
        safePlayTone({ freq: 160, endFreq: 60, duration: 0.4, type: 'sine', volume: 0.15 });
    }

    function playKeyFanfareSound(rarity) {
        // Chime scaled by rarity: more notes / brighter timbre for rarer keys.
        if (rarity === 'common') {
            safePlayTone({ freq: 600, endFreq: 800, duration: 0.15, type: 'triangle', volume: 0.18 });
        } else if (rarity === 'rare') {
            safePlayTone({ freq: 700, endFreq: 950, duration: 0.15, type: 'triangle', volume: 0.2 });
            setTimeout(() => safePlayTone({ freq: 1050, endFreq: 1300, duration: 0.15, type: 'sine', volume: 0.18 }), 100);
        } else if (rarity === 'legendary') {
            const notes = [660, 880, 1108.73, 1318.51];
            notes.forEach((freq, i) => {
                setTimeout(() => safePlayTone({ freq, endFreq: freq * 1.1, duration: 0.2, type: 'sine', volume: 0.22 }), i * 90);
            });
        }
    }

    function playBossHitSound() {
        safePlayTone({ freq: 180, endFreq: 90, duration: 0.09, type: 'square', volume: 0.16 });
    }

    function playBossVictorySound() {
        const notes = [523.25, 659.25, 783.99, 1046.5, 1318.51];
        notes.forEach((freq, i) => {
            setTimeout(() => safePlayTone({ freq, endFreq: freq * 1.02, duration: 0.25, type: 'triangle', volume: 0.2 }), i * 100);
        });
    }

    function playBossDefeatSound() {
        safePlayTone({ freq: 300, endFreq: 80, duration: 0.6, type: 'sawtooth', volume: 0.2 });
    }

    /* =========================================================
       KEY ALTAR (CHEST)
       ========================================================= */

    // Chest opening is handled by script_2.js (openKeyChest). This module
    // only keeps the inventory display and button state in sync.
    function updateKeyAltarButtonState() {
        if (typeof updateKeyAltarControls === 'function') updateKeyAltarControls();
    }

    function renderKeyInventory() {
        const grid = document.getElementById('key-inventory-grid');
        if (!grid) return;
        const a = ensureBossState();
        grid.innerHTML = Object.keys(KEY_TYPES).map((key) => {
            const info = KEY_TYPES[key];
            const count = gameState.keys[key] || 0;
            return `
                <div class="key-card key-card-${info.rarityClass}">
                    <div class="key-card-icon">${info.icon}</div>
                    <div class="key-card-name">${info.name}</div>
                    <div class="key-card-count">${formatNumber(count)}</div>
                </div>
            `;
        }).join('');
    }

    /* =========================================================
       BOSS FIGHTS TAB (entry list)
       ========================================================= */

    /** Short text listing the keys a boss can drop (from the shared drop tables). */
    function describeBossKeyDrops(boss) {
        const tables = (typeof BOSS_KEY_DROP_TABLES !== 'undefined') ? BOSS_KEY_DROP_TABLES : null;
        const table = tables && tables[boss.keyTier];
        if (!table) return t('boss_drops_keys');
        const parts = [];
        ['common', 'rare', 'legendary'].forEach((r) => {
            const g = (table.guaranteed && table.guaranteed[r]) || 0;
            const c = table.chances && table.chances[r];
            if (g > 0) parts.push(t('boss_key_guaranteed', { n: g, icon: KEY_TYPES[r].icon, name: tp('key_name_' + r, g) }));
            else if (c) parts.push(t('boss_key_chance', { percent: Math.round(c * 100), icon: KEY_TYPES[r].icon, name: tp('key_name_' + r, 1) }));
        });
        return parts.length ? parts.join(' &middot; ') : t('boss_drops_keys');
    }

    function renderBossFightsTab() {
        const grid = document.getElementById('boss-card-grid');
        if (!grid) return;
        const a = ensureBossState();

        grid.innerHTML = Object.keys(BOSSES).map((key) => {
            const boss = BOSSES[key];
            const cooldownMs = getBossCooldownRemainingMs(key);
            const ready = cooldownMs <= 0 && !currentFight;
            const dropInfo = describeBossKeyDrops(boss);
            // Gems can now be 0 on the low end (e.g. 0-1), and rune chances are
            // small, so format both without rounding them to a misleading value.
            const gemText = boss.gemsMin === boss.gemsMax
                ? `${boss.gemsMax} 💎`
                : `${boss.gemsMin}-${boss.gemsMax} 💎`;
            const runePct = boss.runeChance * 100;
            const runeText = t('boss_reward_rune', { percent: Number.isInteger(runePct) ? runePct : runePct.toFixed(1), icon: runeLabel(boss.runeKey).icon, name: runeLabel(boss.runeKey).name });
            const rewardParts = [
                t('boss_reward_cps', { mult: boss.coinsCpsMult }),
                gemText,
                ...Object.keys(boss.materials).map((m) => t('boss_reward_mat', { n: boss.materials[m], icon: materialLabel(m).icon, name: materialLabel(m).name })),
                runeText,
                dropInfo
            ];
            return `
                <div class="boss-card boss-card-${boss.type}">
                    <div class="boss-card-icon">${boss.icon}</div>
                    <div class="boss-card-body">
                        <div class="boss-card-name">${boss.name}</div>
                        <div class="boss-card-meta">${t('boss_card_meta', { secs: Math.round(boss.timeMs / 1000), cooldown: formatCooldownLabel(getBossCooldownDurationMs(key)) }).replace(/ · /g, ' &middot; ')}</div>
                        <div class="boss-card-rewards">${rewardParts.join(' &middot; ')}</div>
                    </div>
                    <div class="boss-card-actions">
                        <button class="boss-fight-btn" data-boss="${key}" ${ready ? '' : 'disabled'}>${cooldownMs > 0 ? t('boss_recovering', { time: formatCooldown(cooldownMs) }) : t('boss_fight_btn')}</button>
                        <div class="boss-card-keycost">${t('boss_drops_keys_short')}</div>
                    </div>
                </div>
            `;
        }).join('');

        grid.querySelectorAll('.boss-fight-btn').forEach((btn) => {
            btn.addEventListener('click', () => startBossFight(btn.getAttribute('data-boss')));
        });
    }

    /* =========================================================
       BOSS FIGHT ENCOUNTER (full-screen)
       ========================================================= */

    let currentFight = null; // { bossKey, hpMax, hpCurrent, startedAt, durationMs, rafId }

    /* =========================================================
       PERFORMANCE: per-frame batching of boss-fight DOM work.
       Fight STATE (HP, damage, win/lose) is always updated instantly
       on every hit; only the painting (HP bar / label, hit flashes,
       target jump, floating damage numbers) is coalesced into one
       pass per animation frame so 25 auto-hits/s can't thrash layout.
       ========================================================= */
    const bossElCache = {};
    function bossEl(id) {
        let e = bossElCache[id];
        if (!e || !e.isConnected) { e = document.getElementById(id); bossElCache[id] = e; }
        return e;
    }

    // Arena / target geometry is measured once per fight (and again after a resize) instead of on every hit.
    let bossArenaMetrics = null;
    window.addEventListener('resize', () => { bossArenaMetrics = null; });
    function measureBossArena() {
        const arena = bossEl('boss-fight-arena');
        const target = bossEl('boss-fight-target-btn');
        if (!arena || !target) return null;
        const margin = 8;
        const hpLabel = bossEl('boss-fight-hp-label');
        bossArenaMetrics = {
            aw: arena.clientWidth,
            ah: arena.clientHeight,
            tw: target.offsetWidth,
            th: target.offsetHeight,
            margin,
            topLimit: hpLabel ? (hpLabel.offsetTop + hpLabel.offsetHeight + margin) : margin
        };
        return bossArenaMetrics;
    }

    let bossHitTextPool = null;
    let bossPendingTexts = [];

    /** Paints everything queued by hits since the last frame. Safe to call any time. */
    function flushBossFrame() {
        const f = currentFight;
        if (!f) { bossPendingTexts.length = 0; return; }
        if (f.hpDirty) {
            f.hpDirty = false;
            updateFightHpBar(f.hitFlash);
        }
        if (f.hitFlash) {
            f.hitFlash = false;
            GCFrame.restartClass(bossEl('boss-fight-target-btn'), 'target-hit');
        }
        if (f.moveQueued) {
            f.moveQueued = false;
            moveBossTargetRandomly();
        }
        if (bossPendingTexts.length) {
            if (!bossHitTextPool) bossHitTextPool = GCFrame.createPool({ max: 40, lifeMs: 900 });
            for (let i = 0; i < bossPendingTexts.length; i++) bossHitTextPool.show(bossPendingTexts[i]);
            bossPendingTexts.length = 0;
        }
    }

    function startBossFight(bossKey) {
        const boss = BOSSES[bossKey];
        if (!boss || currentFight) return;
        ensureBossState();

        // Free entry: only the recovery cooldown can block a fight.
        // Rarity keys are NEVER required (or spent) to fight a boss.
        if (getBossCooldownRemainingMs(bossKey) > 0) return;

        // === CHANGED: HP now comes from progression (Level/Biome), not ClickPower ===
        const hpMax = getBossMaxHp(boss);

        // === CHANGED: Precision timer setup ===
        // Store the fight's start time via performance.now() (a
        // monotonic, high-resolution clock unaffected by system clock
        // changes) plus the fixed duration, rather than relying on
        // setInterval's own internal tick counting. Every tick recomputes
        // "remaining" from actual elapsed time instead of assuming each
        // interval firing represents a fixed 100ms slice — this is what
        // prevents drift when the tab is backgrounded/throttled, since a
        // throttled timer might fire late or skip ticks, but the
        // elapsed-time math is always correct whenever it *does* fire.
        currentFight = {
            bossKey,
            hpMax,
            hpCurrent: hpMax,
            startedAt: performance.now(),
            durationMs: boss.timeMs,
            rafId: null,
            resolved: false
        };

        const overlay = document.getElementById('boss-fight-overlay');
        const nameEl = document.getElementById('boss-fight-name');
        const iconEl = document.getElementById('boss-fight-target-icon');
        const targetBtn = document.getElementById('boss-fight-target-btn');
        const resultOverlay = document.getElementById('boss-fight-result-overlay');

        if (nameEl) nameEl.textContent = `${boss.icon} ${boss.name}`;
        if (iconEl) iconEl.textContent = boss.icon;
        if (targetBtn) {
            targetBtn.className = `boss-fight-target type-${boss.type}`;
        }
        if (resultOverlay) resultOverlay.classList.remove('show');
        updateFightHpBar();
        updateFightTimerLabel();

        if (overlay) overlay.classList.add('open');
        resetBossTargetPosition();

        // === CHANGED: drive the timer with requestAnimationFrame + elapsed
        // time instead of setInterval. Each frame we recompute "remaining"
        // directly from performance.now() minus startedAt, so even if the
        // browser throttles rAF/timers while the tab is backgrounded, the
        // very next frame that *does* run will show the mathematically
        // correct remaining time rather than one that drifted from missed
        // ticks. This also naturally self-corrects if a frame takes longer
        // than expected (e.g. GC pause) — no accumulated error over time.
        currentFight.rafId = requestAnimationFrame(tickBossFight);
    }

    function tickBossFight() {
        if (!currentFight || currentFight.resolved) return;
        // Paused (e.g. rewarded ad): keep the frame loop alive but do not count the pause against the fight.
        // startedAt is pushed forward by the paused time via the 'gc:pause-shift' event below.
        if (typeof isGamePaused === 'function' && isGamePaused()) {
            currentFight.rafId = requestAnimationFrame(tickBossFight);
            return;
        }
        flushBossFrame(); // paint all hits that landed since the last frame
        const elapsed = performance.now() - currentFight.startedAt;
        const remaining = currentFight.durationMs - elapsed;
        updateFightTimerLabel(remaining);

        if (remaining <= 0) {
            resolveBossFight(false);
            return;
        }
        currentFight.rafId = requestAnimationFrame(tickBossFight);
    }

    function updateFightTimerLabel(remainingOverride) {
        const el = bossEl('boss-fight-timer');
        if (!el || !currentFight) return;
        const remaining = remainingOverride !== undefined
            ? remainingOverride
            : (currentFight.durationMs - (performance.now() - currentFight.startedAt));
        const secs = Math.max(0, Math.ceil(remaining / 1000));
        const txt = t('boss_time_secs', { n: secs });
        if (el.textContent !== txt) el.textContent = txt; // the label only changes once per second
        el.classList.toggle('time-critical', secs <= 5);
    }

    function updateFightHpBar(hit) {
        const bar = bossEl('boss-fight-hpbar-inner');
        const label = bossEl('boss-fight-hp-label');
        if (!currentFight) return;
        const pct = Math.max(0, (currentFight.hpCurrent / currentFight.hpMax) * 100);
        if (bar) {
            const w = pct + '%';
            if (bar.style.width !== w) bar.style.width = w;
            if (hit) GCFrame.restartClass(bar, 'hp-hit');
        }
        if (label) {
            const txt = t('boss_fight_hp', { current: formatNumber(Math.max(0, currentFight.hpCurrent)), max: formatNumber(currentFight.hpMax) });
            if (label.textContent !== txt) label.textContent = txt;
        }
    }

    /** Moves the clickable target to a random position inside the arena. */
    function moveBossTargetRandomly() {
        const target = bossEl('boss-fight-target-btn');
        if (!target) return;
        const m = bossArenaMetrics || measureBossArena();
        if (!m) return;
        const maxX = Math.max(m.margin, m.aw - m.tw - m.margin);
        const maxY = Math.max(m.topLimit, m.ah - m.th - m.margin);
        const x = m.margin + Math.random() * (maxX - m.margin);
        const y = m.topLimit + Math.random() * (maxY - m.topLimit);
        target.style.left = Math.round(x) + 'px';
        target.style.top = Math.round(y) + 'px';
    }

    /** Centers the target in the play area (used when a fight starts). */
    function resetBossTargetPosition() {
        const target = bossEl('boss-fight-target-btn');
        if (!target) return;
        const m = measureBossArena(); // fresh measurement at the start of every fight
        if (!m) return;
        const x = (m.aw - m.tw) / 2;
        const y = m.topLimit + Math.max(0, (m.ah - m.topLimit - m.th) / 2);
        target.style.left = Math.round(x) + 'px';
        target.style.top = Math.round(y) + 'px';
    }

    function handleBossFightClick(event) {
        if (!currentFight || currentFight.resolved) return;
        const dmg = getEffectiveClickPower();
        currentFight.hpCurrent -= dmg;
        playBossHitSound();

        // State is final right now; the DOM catches up once per frame (flushBossFrame).
        currentFight.hpDirty = true;
        currentFight.hitFlash = true;
        spawnFightHitText(event, dmg);

        if (currentFight.hpCurrent <= 0) {
            flushBossFrame();
            resolveBossFight(true);
        } else {
            currentFight.moveQueued = true;
        }
    }

    function spawnFightHitText(event, amount) {
        const x = event && event.clientX ? event.clientX : window.innerWidth / 2;
        const y = event && event.clientY ? event.clientY - 20 : window.innerHeight / 2;
        bossPendingTexts.push({
            className: 'mine-event-burst',
            text: '-' + formatNumber(amount),
            color: '#ff6b5e',
            left: x + 'px',
            top: y + 'px'
        });
        if (bossPendingTexts.length > 60) bossPendingTexts.splice(0, bossPendingTexts.length - 60); // never let a burst grow unbounded
    }

    function resolveBossFight(victory) {
        if (!currentFight || currentFight.resolved) return;
        flushBossFrame(); // make sure the last hits are painted before the result screen
        currentFight.resolved = true;
        // Stop the rAF-based timer loop.
        if (currentFight.rafId) cancelAnimationFrame(currentFight.rafId);

        const bossKey = currentFight.bossKey;
        const boss = BOSSES[bossKey];

        if (victory) {
            // Grants everything, refreshes the UI and opens the reward modal.
            handleBossVictory(bossKey);
        } else {
            playBossDefeatSound();
            showBossResultScreen({
                victory: false,
                title: t('boss_escaped', { name: boss.name }),
                loot: [],
                message: t('boss_time_ran_out'),
                buttonLabel: t('boss_close')
            });
            startBossRecovery(bossKey, true);
            renderBossFightsTab();
            saveGame();

            // Defeat: show the result briefly, then close the overlay automatically.
            const defeatedFight = currentFight;
            setTimeout(() => {
                if (currentFight === defeatedFight) closeBossFightOverlay();
            }, 2500);
        }
    }

    /* =========================================================
       REWARD / LOOT SYSTEM
       ========================================================= */

    /** Escapes text destined for innerHTML. */
    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    /**
     * Rolls every reward for a boss WITHOUT touching game state, so the
     * numbers are fully decided up front (and can be inspected/tested).
     * Everything scales off the boss config in BOSSES:
     *   - coins:  CPS * coinsCpsMult
     *   - xp:     CPS * xpCpsMult
     *   - gems:   random in [gemsMin, gemsMax]
     *   - materials: fixed amounts from boss.materials
     *   - keys:   guaranteed + chance drops from BOSS_KEY_DROP_TABLES[boss.keyTier]
     *   - rune:   boss.runeChance
     * @returns {{coins:number, xp:number, gems:number, materials:Object, keys:{rarity:string,amount:number}[], rune:(string|null)}}
     */
    function calculateBossRewards(boss) {
        const cps = getEffectiveCps();
        const coins = Math.max(1, Math.round(cps * boss.coinsCpsMult));
        const xp = Math.max(1, Math.round(cps * (boss.xpCpsMult || 0)));
        const gems = boss.gemsMin + Math.floor(Math.random() * (boss.gemsMax - boss.gemsMin + 1));
        const materials = Object.assign({}, boss.materials);
        const rune = Math.random() < boss.runeChance ? boss.runeKey : null;
        return { coins, xp, gems, materials, rune };
    }

    /** Rolls key drops from the shared drop tables (script_2.js) or a safe fallback. */
    function rollBossKeys(boss) {
        const tables = (typeof BOSS_KEY_DROP_TABLES !== 'undefined') ? BOSS_KEY_DROP_TABLES : null;
        const table = tables && tables[boss.keyTier];
        if (!table) return [{ rarity: 'common', amount: 1 }];

        const totals = { common: 0, rare: 0, legendary: 0 };
        for (const r in table.guaranteed) totals[r] += table.guaranteed[r] || 0;
        for (const r in table.chances) if (Math.random() < table.chances[r]) totals[r] += 1;

        const out = [];
        for (const r in totals) if (totals[r] > 0) out.push({ rarity: r, amount: totals[r] });
        // Every victory drops at least one key.
        if (!out.length) out.push({ rarity: 'common', amount: 1 });
        return out;
    }

    /**
     * Builds the visual loot list (icon tiles) shown in the reward modal.
     * Each entry: { icon, label, amount, rarity }.
     */
    function buildLootDisplayList(rewards, keyRewards) {
        const loot = [
            { icon: '🪙', label: t('boss_loot_coins'), amount: '+' + formatNumber(rewards.coins), rarity: 'currency' },
            { icon: '⭐', label: t('boss_loot_xp'), amount: '+' + formatNumber(rewards.xp), rarity: 'currency' },
            { icon: '💎', label: t('boss_loot_gems'), amount: '+' + formatNumber(rewards.gems), rarity: 'currency' }
        ];
        for (const matKey in rewards.materials) {
            const mat = materialLabel(matKey);
            loot.push({ icon: mat.icon, label: mat.name, amount: '+' + formatNumber(rewards.materials[matKey]), rarity: 'material' });
        }
        keyRewards.forEach((kr) => {
            const info = KEY_TYPES[kr.rarity];
            loot.push({ icon: info.icon, label: tp('key_name_' + kr.rarity, kr.amount), amount: '+' + kr.amount, rarity: 'key-' + info.rarityClass });
        });
        if (rewards.rune) {
            const rune = runeLabel(rewards.rune);
            loot.push({ icon: rune.icon, label: rune.name, amount: 'NEW!', rarity: 'rune' });
        }
        return loot;
    }

    /* ---------- Reward modal: layout fix + guaranteed Claim button ---------- */

    const BOSS_RESULT_STYLE_ID = 'boss-result-layout-style';

    /** Injects the (scoped) layout rules once. Colours/fonts are inherited from the existing modal. */
    function injectBossResultStyles() {
        if (document.getElementById(BOSS_RESULT_STYLE_ID)) return;
        const st = document.createElement('style');
        st.id = BOSS_RESULT_STYLE_ID;
        st.textContent = `
        #boss-fight-result-overlay .boss-result-card {
            display: flex !important;
            flex-direction: column !important;
            max-height: 80vh !important;
            max-height: 80dvh !important;
            width: min(92vw, 460px);
            box-sizing: border-box;
            overflow: hidden !important;
        }
        #boss-fight-result-overlay .boss-result-card > #boss-fight-result-title {
            flex: 0 0 auto;
        }
        #boss-fight-result-overlay .boss-result-card > #boss-fight-result-loot {
            flex: 1 1 auto !important;
            min-height: 0 !important;
            height: auto !important;
            max-height: none !important;
            overflow-y: auto !important;
            overflow-x: hidden;
            -webkit-overflow-scrolling: touch;
            overscroll-behavior: contain;
        }
        #boss-fight-result-overlay .boss-loot-grid {
            display: grid !important;
            grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
            gap: 8px !important;
            align-items: stretch;
        }
        #boss-fight-result-overlay .boss-loot-item {
            display: flex !important;
            flex-direction: row !important;
            align-items: center !important;
            gap: 6px !important;
            min-width: 0;
            width: auto !important;
            height: auto !important;
            margin: 0 !important;
            padding: 6px 8px !important;
            text-align: left;
        }
        #boss-fight-result-overlay .boss-loot-icon {
            flex: 0 0 auto;
            margin: 0 !important;
            font-size: 1.4rem !important;
            line-height: 1;
        }
        #boss-fight-result-overlay .boss-loot-amount {
            flex: 0 0 auto;
            margin: 0 !important;
            font-weight: bold;
            white-space: nowrap;
        }
        #boss-fight-result-overlay .boss-loot-label {
            flex: 1 1 auto;
            min-width: 0;
            margin: 0 !important;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        #boss-fight-result-overlay .boss-result-card > #boss-fight-result-close {
            flex: 0 0 auto;
            order: 99;
            width: 100%;
            margin-top: 10px !important;
            padding: 12px 16px;
            cursor: pointer;
            position: relative;
        }
        #boss-fight-result-overlay .boss-result-card > #boss-fight-result-close:disabled {
            cursor: default;
            opacity: 0.6;
        }
        @media (max-width: 380px) {
            #boss-fight-result-overlay .boss-loot-grid { grid-template-columns: 1fr !important; }
        }`;
        document.head.appendChild(st);
    }

    /**
     * Makes sure the result modal has: overlay > card > [title, loot, Claim button].
     * Reuses the existing elements (and their classes) when they are in the page,
     * and only creates what is missing. Idempotent - safe to call every time.
     *
     * Every append goes through safeAppend(), which refuses to append a node to
     * itself or into one of its own descendants, and the card is ALWAYS a
     * dedicated element that is distinct from title / loot / button (the old
     * code could pick the title itself as the "card" and then append the title
     * into itself -> HierarchyRequestError).
     */
    function ensureBossResultModal() {
        injectBossResultStyles();

        // Appends child into parent only when that is a valid, non-circular operation.
        function safeAppend(parent, child, before) {
            if (!parent || !child || parent === child || child.contains(parent)) return false;
            if (before && before.parentNode === parent) parent.insertBefore(child, before);
            else if (child.parentNode !== parent || parent.lastElementChild !== child) parent.appendChild(child);
            return true;
        }

        let overlay = document.getElementById('boss-fight-result-overlay');
        let title = document.getElementById('boss-fight-result-title');
        let loot = document.getElementById('boss-fight-result-loot');
        let btn = document.getElementById('boss-fight-result-close');

        if (!overlay) {
            const host = document.getElementById('boss-fight-overlay') || document.body;
            overlay = document.createElement('div');
            overlay.id = 'boss-fight-result-overlay';
            overlay.className = 'boss-fight-result-overlay';
            safeAppend(host, overlay);
        }

        // The overlay must never live inside one of its own parts.
        [title, loot, btn].forEach((el) => {
            if (el && (el === overlay || el.contains(overlay))) {
                el.removeAttribute('id');
            }
        });
        if (title && (title === overlay || title.contains(overlay))) title = null;
        if (loot && (loot === overlay || loot.contains(overlay))) loot = null;
        if (btn && (btn === overlay || btn.contains(overlay))) btn = null;

        // Find a card: a direct child of the overlay that is NOT one of the parts.
        const isPart = (el) => el === title || el === loot || el === btn;
        let card = Array.from(overlay.children).find((el) =>
            !isPart(el) && (el.classList.contains('boss-result-card') || el.classList.contains('boss-fight-result-card'))
        ) || null;

        // Otherwise, a direct child that already wraps the existing parts.
        if (!card) {
            card = Array.from(overlay.children).find((el) =>
                !isPart(el) && ((title && el.contains(title)) || (loot && el.contains(loot)) || (btn && el.contains(btn)))
            ) || null;
        }

        // Otherwise create a brand-new, empty card as a direct child of the overlay.
        if (!card) {
            card = document.createElement('div');
            card.className = 'boss-fight-result-card';
            safeAppend(overlay, card, overlay.firstElementChild);
        }
        card.classList.add('boss-result-card');

        if (!title) {
            title = document.createElement('div');
            title.id = 'boss-fight-result-title';
            title.className = 'boss-fight-result-title';
        }
        if (!loot) {
            loot = document.createElement('div');
            loot.id = 'boss-fight-result-loot';
            loot.className = 'boss-fight-result-loot';
        }
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'boss-fight-result-close';
            btn.type = 'button';
            // Reuse the game's existing green "claim" button look.
            btn.className = 'boss-fight-result-close quest-claim-btn';
        }

        // Put every part directly inside the card, in order: title, loot, button.
        [title, loot, btn].forEach((el) => {
            if (el.parentNode !== card) safeAppend(card, el);
        });
        if (title.nextElementSibling !== loot && loot.parentNode === card) card.insertBefore(loot, title.nextSibling);
        if (loot.nextElementSibling !== btn && btn.parentNode === card) card.insertBefore(btn, loot.nextSibling);

        // Any stray leftover children of the overlay (not the card) are left alone,
        // but the card itself must be inside the overlay.
        if (card.parentNode !== overlay) safeAppend(overlay, card);

        // Bind the claim handler exactly once per button element.
        if (!btn.dataset.claimBound) {
            btn.dataset.claimBound = '1';
            btn.addEventListener('click', claimBossRewards);
        }
        return { overlay, card, title, loot, btn };
    }

    /**
     * "Claim Rewards" / "Close" handler.
     * Rewards are ALREADY applied to gameState in handleBossVictory (that is the
     * existing architecture), so claiming only finalises: it must NOT grant
     * anything again. A guard flag makes repeated clicks harmless.
     */
    let bossResultClaimed = false;
    function claimBossRewards() {
        if (bossResultClaimed) return;
        bossResultClaimed = true;
        const btn = document.getElementById('boss-fight-result-close');
        if (btn) btn.disabled = true;
        try {
            closeBossFightOverlay();           // removes the modal, resets arena, refreshes UI
            if (typeof updateKeyInventoryUI === 'function') updateKeyInventoryUI();
            renderKeyInventory();
            renderInventoryTabSafe();
            if (typeof updateUI === 'function') updateUI();
            saveGame();
        } finally {
            const b = document.getElementById('boss-fight-result-close');
            if (b) b.disabled = false;
        }
    }

    /**
     * Fills in and shows the result/reward modal inside the fight overlay.
     * Works for both victory (loot tiles) and defeat (message only).
     */
    function showBossResultScreen({ victory, title, loot, message, buttonLabel }) {
        const modal = ensureBossResultModal();
        const resultOverlay = modal.overlay;
        const resultTitle = modal.title;
        const resultLoot = modal.loot;
        const resultClose = modal.btn;
        bossResultClaimed = false; // new modal instance -> claim is available again

        if (resultTitle) {
            resultTitle.className = 'boss-fight-result-title ' + (victory ? 'victory' : 'defeat');
            resultTitle.textContent = title;
        }
        if (resultLoot) {
            let html = '';
            if (loot && loot.length) {
                html += '<div class="boss-loot-grid">' + loot.map((item, i) => `
                    <div class="boss-loot-item loot-${escapeHtml(item.rarity)}" style="animation-delay:${(i * 0.08).toFixed(2)}s">
                        <div class="boss-loot-icon">${item.icon}</div>
                        <div class="boss-loot-amount">${escapeHtml(item.amount)}</div>
                        <div class="boss-loot-label">${escapeHtml(item.label)}</div>
                    </div>`).join('') + '</div>';
            }
            if (message) html += `<div class="boss-loot-message">${escapeHtml(message)}</div>`;
            resultLoot.innerHTML = html;
        }
        if (resultClose) {
            resultClose.textContent = buttonLabel || t('boss_claim_rewards');
            resultClose.disabled = false;
        }
        if (resultLoot) resultLoot.scrollTop = 0;
        if (resultOverlay) resultOverlay.classList.add('show');
    }

    /**
     * Victory handler. Callable by boss id alone:  handleBossVictory('stoneGolem')
     *
     *  1. Calculates rewards from the boss config (coins, XP, gems, materials,
     *     rune chance, and key drops by tier).
     *  2. Adds everything to gameState (e.g. gameState.keys.common += 1).
     *  3. Calls updateKeyInventoryUI() and refreshes the main resource UI.
     *  4. Shows the reward modal with icon tiles for every item and key.
     *  5. Starts the boss recovery cooldown and saves.
     *
     * The modal's "Claim Reward" button (see wiring below) clears the
     * arena state and closes the battle overlay.
     * @param {string} bossId - a key of BOSSES (e.g. 'stoneGolem')
     * @returns {Object|null} the rewards that were granted, or null if the id is unknown
     */
    function handleBossVictory(bossId) {
        const boss = BOSSES[bossId];
        if (!boss) {
            console.warn('handleBossVictory: unknown boss id', bossId);
            return null;
        }

        // Guard against double-granting if this gets called twice for one fight.
        if (currentFight && currentFight.bossKey === bossId) {
            if (currentFight.rewardsGranted) return currentFight.rewards;
            currentFight.resolved = true;
            if (currentFight.rafId) cancelAnimationFrame(currentFight.rafId);
        }

        playBossVictorySound();
        const a = ensureBossState();

        // 1) Calculate
        const rewards = calculateBossRewards(boss);
        const keyRewards = rollBossKeys(boss);

        // 2) Apply to gameState
        if (typeof addCoins === 'function') addCoins(rewards.coins);
        else gameState.coins = (gameState.coins || 0) + rewards.coins;

        // XP goes through the shared reward path so level-ups, biome
        // progression and Pass XP all fire exactly as for other rewards.
        if (typeof gainExperience === 'function') {
            gainExperience(rewards.xp / Math.max(gameState.xpMultiplier || 1, 0.0001));
        } else {
            gameState.xp = (gameState.xp || 0) + rewards.xp;
        }

        gameState.gems = (gameState.gems || 0) + rewards.gems;
        if (typeof recalculatePrestigeMultiplier === 'function') recalculatePrestigeMultiplier();

        for (const matKey in rewards.materials) {
            a.materials[matKey] = (a.materials[matKey] || 0) + rewards.materials[matKey];
        }

        keyRewards.forEach((kr) => {
            gameState.keys[kr.rarity] = (gameState.keys[kr.rarity] || 0) + kr.amount;
        });

        if (rewards.rune) a.craftedRunes[rewards.rune] = true;

        // 3) Refresh UI: key inventory + main resource display
        if (typeof updateKeyInventoryUI === 'function') updateKeyInventoryUI();
        if (typeof updateKeyAltarControls === 'function') updateKeyAltarControls();
        renderKeyInventory();
        if (typeof updateUI === 'function') updateUI();
        renderInventoryTabSafe();

        // 4) Reward modal
        showBossResultScreen({
            victory: true,
            title: t('boss_defeated', { name: boss.name }),
            loot: buildLootDisplayList(rewards, keyRewards),
            message: '',
            buttonLabel: t('boss_claim_rewards')
        });

        // 5) Cooldown + persist
        startBossRecovery(bossId);
        renderBossFightsTab();
        saveGame();

        if (currentFight && currentFight.bossKey === bossId) {
            currentFight.rewardsGranted = true;
            currentFight.rewards = rewards;
        }
        return Object.assign({}, rewards, { keys: keyRewards });
    }

    /**
     * Clears ALL battle-arena state and closes the battle overlay:
     * cancels the timer loop, drops the current fight, hides the result
     * modal, and resets the HP bar, timer, and target so the next fight
     * starts from a clean slate.
     */
    function closeBossFightOverlay() {
        if (currentFight && currentFight.rafId) cancelAnimationFrame(currentFight.rafId);
        currentFight = null;

        const overlay = document.getElementById('boss-fight-overlay');
        if (overlay) overlay.classList.remove('open');

        const resultOverlay = document.getElementById('boss-fight-result-overlay');
        const resultLoot = document.getElementById('boss-fight-result-loot');
        const bar = document.getElementById('boss-fight-hpbar-inner');
        const hpLabel = document.getElementById('boss-fight-hp-label');
        const timer = document.getElementById('boss-fight-timer');
        const targetBtn = document.getElementById('boss-fight-target-btn');

        if (resultOverlay) resultOverlay.classList.remove('show');
        if (resultLoot) resultLoot.innerHTML = '';
        if (bar) { bar.style.width = '100%'; bar.classList.remove('hp-hit'); }
        if (hpLabel) hpLabel.textContent = t('boss_fight_hp', { current: 0, max: 0 });
        if (timer) { timer.textContent = ''; timer.classList.remove('time-critical'); }
        if (targetBtn) targetBtn.classList.remove('target-hit');

        // Refresh the boss list (cooldowns) and the resource displays.
        renderBossFightsTab();
        if (typeof updateUI === 'function') updateUI();
    }

    // Safe wrapper: if the Adventures module's inventory tab happens to be
    // open, refresh it too so material counts stay in sync live.
    function renderInventoryTabSafe() {
        if (typeof renderInventoryTab === 'function') {
            try { renderInventoryTab(); } catch (e) { /* ignore if not applicable */ }
        }
    }

    /* =========================================================
       MODAL TAB SWITCHING
       ========================================================= */

    let bossOverlayOpenTab = 'fights';

    function openBossOverlay() {
        const overlay = document.getElementById('boss-overlay');
        if (overlay) overlay.classList.add('open');
        switchBossTab(bossOverlayOpenTab);
    }

    function closeBossOverlay() {
        const overlay = document.getElementById('boss-overlay');
        if (overlay) overlay.classList.remove('open');
    }

    function switchBossTab(tab) {
        bossOverlayOpenTab = tab;
        document.querySelectorAll('.boss-tab-panel').forEach((p) => p.classList.remove('active'));
        document.querySelectorAll('.boss-tab-button').forEach((b) => b.classList.remove('active'));
        const panel = document.getElementById('boss-tab-panel-' + tab);
        if (panel) panel.classList.add('active');
        const btn = document.getElementById('boss-tab-btn-' + tab);
        if (btn) btn.classList.add('active');

        if (tab === 'fights') renderBossFightsTab();
        else if (tab === 'altar') {
            renderKeyInventory();
            updateKeyAltarButtonState();
        }
    }

    /* =========================================================
       DOM WIRING
       ========================================================= */

    const fabBtn = document.getElementById('boss-fab');
    const overlayEl = document.getElementById('boss-overlay');
    const closeBtn = document.getElementById('boss-close');
    const tabBtnFights = document.getElementById('boss-tab-btn-fights');
    const tabBtnAltar = document.getElementById('boss-tab-btn-altar');
    const fightTargetBtn = document.getElementById('boss-fight-target-btn');
    const fightResultCloseBtn = document.getElementById('boss-fight-result-close');

    if (fabBtn) {
        fabBtn.addEventListener('click', () => {
            if (typeof initAudio === 'function') initAudio();
            openBossOverlay();
        });
    }
    if (closeBtn) closeBtn.addEventListener('click', closeBossOverlay);
    if (overlayEl) {
        overlayEl.addEventListener('click', (e) => {
            if (e.target === overlayEl) closeBossOverlay();
        });
    }
    if (tabBtnFights) tabBtnFights.addEventListener('click', () => switchBossTab('fights'));
    if (tabBtnAltar) tabBtnAltar.addEventListener('click', () => switchBossTab('altar'));
    if (fightTargetBtn) fightTargetBtn.addEventListener('click', handleBossFightClick);

    // Public API: allow other scripts / the console to start a fight by boss id.
    window.startBossFight = startBossFight;
    window.handleBossVictory = handleBossVictory;
    ensureBossResultModal(); // builds/normalises the reward modal and binds the Claim button once

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const fightOverlay = document.getElementById('boss-fight-overlay');
        if (fightOverlay && fightOverlay.classList.contains('open')) {
            // Don't let Escape skip an active fight's timer; only close a
            // finished (result shown) fight.
            const resultOverlay = document.getElementById('boss-fight-result-overlay');
            if (resultOverlay && resultOverlay.classList.contains('show')) claimBossRewards();
            return;
        }
        if (overlayEl && overlayEl.classList.contains('open')) closeBossOverlay();
    });

    // Close this modal too when another bottom-nav tab is opened, matching
    // the Adventures module's pattern.
    if (typeof closeAllNavModals === 'function') {
        const originalCloseAllNavModals = closeAllNavModals;
        window.closeAllNavModals = function () {
            originalCloseAllNavModals();
            closeBossOverlay();
        };
    }

    /* =========================================================
       PERIODIC REFRESH (keep cooldown timers / button state live)
       ========================================================= */

    // Localization: re-render the boss UI after a language switch.
    if (window.i18n) {
        window.i18n.onChange(() => {
            try {
                renderKeyInventory();
                if (!currentFight) renderBossFightsTab();
                if (typeof updateKeyAltarControls === 'function') updateKeyAltarControls();
                if (currentFight) {
                    const boss = BOSSES[currentFight.bossKey];
                    const nameEl = document.getElementById('boss-fight-name');
                    if (nameEl && boss) nameEl.textContent = `${boss.icon} ${boss.name}`;
                    updateFightHpBar(false);
                    updateFightTimerLabel();
                }
            } catch (e) { console.error('Bosses localization refresh failed:', e); }
        });
    }

    // Pause integration (script_2.js): the fight timer is performance.now()-based, so shift its start by the paused time.
    window.addEventListener('gc:pause-shift', (e) => {
        const ms = e && e.detail && e.detail.elapsedMs;
        if (currentFight && !currentFight.resolved && Number.isFinite(ms) && ms > 0) currentFight.startedAt += ms;
    });

    setInterval(() => {
        if (overlayEl && overlayEl.classList.contains('open')) {
            if (bossOverlayOpenTab === 'altar') updateKeyAltarButtonState();
            else if (bossOverlayOpenTab === 'fights' && !currentFight) renderBossFightsTab();
        }
    }, 500);

})();
