console.log("Soundbrett | Module loaded");

if (!globalThis.soundbrett) {
    globalThis.soundbrett = {
        activeSounds: {},
        remoteSounds: {}
    };
}

// Deterministic id derived from the file path. GM and player side both use this,
// and it is also the key for activeState and soundSettings — so a tile, its active
// track and its persisted config all share one id.
function soundIdFromPath(path) {
    return btoa(encodeURIComponent(path)).replace(/=/g, "");
}

// Escapes user text before it goes into an innerHTML / dialog content string.
function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Tiny anti-click fade (ms): a short volume ramp on play/stop removes the
// click/pop caused by an abrupt waveform discontinuity. It is imperceptibly
// short, so it is safe even for very short sounds — unlike a long aesthetic
// fade, which we deliberately skip. Passed to Sound#play/#stop ({ fade }).
const MICRO_FADE_MS = 10;

// --- Per-sound persistent settings -----------------------------------------
// The world-scope setting 'soundSettings' holds the durable per-sound defaults
// (favorite, volume, loop), keyed by sound id. Decoupled from 'activeState':
// activeState = what is currently playing, soundSettings = the defaults a sound
// starts with. Only values that deviate from DEFAULT_SOUND_CONFIG are stored.

// 'name' is the optional custom display name; "" means "use the file name".
// 'tags' is a list of free-form labels for cross-cutting grouping; [] is the
// default. Both ride the same lean-pruning (default value -> pruned).
// 'routing' is the optional per-sound routing override (see normalizeRouting);
// null means "inherit the board-wide default" (getBoardRouting), pruned as default.
const DEFAULT_SOUND_CONFIG = { favorite: false, volume: 0.8, loop: false, name: "", tags: [], routing: null };

// A value equals its default (so it can be pruned)? Empty/absent arrays count
// as default; everything else is a plain === comparison.
function isDefaultConfigValue(key, value) {
    const def = DEFAULT_SOUND_CONFIG[key];
    if (Array.isArray(def)) return !Array.isArray(value) || value.length === 0;
    return value === def;
}

// Trim, drop empties and case-insensitively dedupe a tag list (first casing wins).
function normalizeTags(tags) {
    if (!Array.isArray(tags)) return [];
    const seen = new Set();
    return tags.map(t => String(t).trim()).filter(t => {
        if (!t) return false;
        const k = t.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

// --- Selective routing ------------------------------------------------------
// A routing target = which OTHER clients (players) hear a sound. The triggering
// GM always plays locally, so the GM is never filtered.
// Serializable shape, stored in activeState, the play socket payload AND the
// per-sound override (soundSettings.routing):
//   { mode: "all" }                       -> everyone hears it (default)
//   { mode: "custom", users: [id, …] }    -> only these players; [] -> only GM
// Anything unrecognized (incl. null/legacy) collapses to "all" (back-compat).
function normalizeRouting(r) {
    if (!r || typeof r !== "object") return { mode: "all" };
    if (r.mode === "custom") {
        const users = Array.isArray(r.users) ? [...new Set(r.users.map(String))] : [];
        return { mode: "custom", users };
    }
    return { mode: "all" };
}

// Player-side: should THIS user hear a sound with these recipients? Missing/
// legacy or "all" -> yes; "custom" -> only when this user's id is listed.
function isRecipient(recipients) {
    const r = recipients;
    if (!r || r === "all" || r.mode === "all") return true;
    if (r.mode === "custom") return Array.isArray(r.users) && r.users.includes(game.user.id);
    return true;
}

// The board-wide default target (client-scope, per GM) for newly started sounds.
function getBoardRouting() {
    return normalizeRouting(game.settings.get('soundbrett', 'routingDefault'));
}

// Effective target for a sound: its own override if set, else the board default.
function resolveRouting(cfg) {
    return cfg.routing ? normalizeRouting(cfg.routing) : getBoardRouting();
}

// Localized label for a routing target ("Everyone" / "Only GM" / "N players").
function routingLabel(recipients) {
    const r = normalizeRouting(recipients);
    if (r.mode === "all") return game.i18n.localize("SOUNDBRETT.RoutingAll");
    if (r.users.length === 0) return game.i18n.localize("SOUNDBRETT.RoutingOnlyGM");
    return game.i18n.format("SOUNDBRETT.RoutingPlayersCount", { count: r.users.length });
}

// Comma-joined display names of a custom target's users (for the tooltip/title so
// the GM can see WHICH players are selected). Empty for "all" / only-GM.
function routingPlayerNames(recipients) {
    const r = normalizeRouting(recipients);
    if (r.mode !== "custom") return "";
    return r.users.map(id => game.users.get(id)?.name).filter(Boolean).join(", ");
}

// Stored config merged over the defaults (always returns a full config). The
// tags array and routing object are cloned so callers can't mutate the shared
// default; routing stays null (= inherit) unless an override is stored.
function getSoundConfig(id) {
    const all = game.settings.get('soundbrett', 'soundSettings') ?? {};
    const cfg = { ...DEFAULT_SOUND_CONFIG, ...(all[id] ?? {}) };
    cfg.tags = Array.isArray(cfg.tags) ? [...cfg.tags] : [];
    cfg.routing = cfg.routing ? normalizeRouting(cfg.routing) : null;
    return cfg;
}

// Merges a partial config for one sound. GM only (writes a world-scope setting).
// Keys equal to the default are pruned, empty entries removed, to keep it lean.
async function setSoundConfig(id, partial) {
    if (!game.user?.isGM) return;
    const all = foundry.utils.deepClone(game.settings.get('soundbrett', 'soundSettings') ?? {});
    const merged = { ...DEFAULT_SOUND_CONFIG, ...(all[id] ?? {}), ...partial };
    merged.tags = normalizeTags(merged.tags);
    // null stays null (= inherit board default, pruned); an object is normalized.
    merged.routing = merged.routing ? normalizeRouting(merged.routing) : null;
    const lean = {};
    for (const key of Object.keys(DEFAULT_SOUND_CONFIG)) {
        if (!isDefaultConfigValue(key, merged[key])) lean[key] = merged[key];
    }
    if (Object.keys(lean).length === 0) delete all[id];
    else all[id] = lean;
    await game.settings.set('soundbrett', 'soundSettings', all);
}

// --- Audio state persistence ----------------------------------------------
// The world-scope setting 'activeState' is the shared single source of truth.
// It holds serializable data only (never a live Sound instance!).

// GM view (activeSounds with live instances) -> serializable object.
function serializeActiveSounds() {
    const activeSounds = globalThis.soundbrett.activeSounds;
    const out = {};
    for (const id of Object.keys(activeSounds)) {
        const s = activeSounds[id];
        out[id] = {
            id,
            name: s.name,
            path: s.path,
            // The INTENDED volume tracked on the entry — NOT soundInstance.volume.
            // The live gain is transient during the micro-fade (ramps 0 -> target
            // over MICRO_FADE_MS); persisting it right after play (still ~0) would
            // make reconcilePlayerState set players to 0 and silence them.
            volume: s.volume ?? 0.8,
            isLooping: s.isLooping,
            isPaused: s.isPaused,
            // Who hears this track — the reconcile net reads it to filter players.
            recipients: normalizeRouting(s.recipients)
        };
    }
    return out;
}

// Only the GM may write the world-scope setting.
async function persistActiveState() {
    if (!game.user?.isGM) return;
    await game.settings.set('soundbrett', 'activeState', serializeActiveSounds());
}

// Restores the audio state after a reload. Runs on EVERY client (including
// players that join later). Never writes back and never emits sockets.
async function restoreActiveState() {
    const state = game.settings.get('soundbrett', 'activeState') ?? {};
    const ids = Object.keys(state);
    if (ids.length === 0) return;

    // Browsers block audio until the first user interaction. Foundry provides an
    // unlock promise for this; we await it defensively (API may differ).
    try {
        if (game.audio?.unlock?.then) await game.audio.unlock;
    } catch (e) { /* unlock unavailable — play() falls back to the unlock itself */ }

    if (game.user.isGM) {
        const activeSounds = globalThis.soundbrett.activeSounds;
        for (const id of ids) {
            const t = state[id];
            const soundInstance = await game.audio.play(t.path, {
                volume: t.volume ?? 0.8,
                loop: t.isLooping ?? false,
                fade: MICRO_FADE_MS,
                spatialize: false
            });
            // Keep logically paused tracks silent locally (board shows them paused).
            // pause() throws when not PLAYING -> only call it then.
            if (t.isPaused && soundInstance.playing && typeof soundInstance.pause === "function") {
                soundInstance.pause();
            }
            activeSounds[id] = {
                id, name: t.name, path: t.path,
                volume: t.volume ?? 0.8,
                soundInstance, isLooping: !!t.isLooping, isPaused: !!t.isPaused,
                // GM hears every track locally regardless; recipients is kept so a
                // re-persist (and players' reconcile) preserves the original target.
                recipients: normalizeRouting(t.recipients)
            };
            // Self-clean: drop a restored one-shot from the state once it ends.
            soundInstance.addEventListener("end", () => onSoundEnded(id, soundInstance));
        }
        if (ui.soundbrettApp) ui.soundbrettApp.render();
    } else {
        await reconcilePlayerState();
    }
}

// Reconciles a player's LOCAL playback with the shared truth (world-scope
// 'activeState'). Runs on 'ready' AND on every change of 'activeState'
// (updateSetting hook) — so no transient socket signal can be lost that was
// sent during a reload.
async function reconcilePlayerState() {
    if (game.user?.isGM) return; // the GM manages its own instances directly
    const state = game.settings.get('soundbrett', 'activeState') ?? {};
    const remoteSounds = globalThis.soundbrett.remoteSounds;

    try {
        if (game.audio?.unlock?.then) await game.audio.unlock;
    } catch (e) { /* see restoreActiveState */ }

    // 1. Stop local sounds that no longer exist in the shared state.
    for (const id of Object.keys(remoteSounds)) {
        if (!state[id]) {
            try { (await remoteSounds[id]).stop({ fade: MICRO_FADE_MS }); } catch (e) {}
            delete remoteSounds[id];
        }
    }

    // 2. Align every track in the state with its target state.
    for (const id of Object.keys(state)) {
        const t = state[id];

        // Routing net: not a recipient -> make sure it is silent here, then skip.
        // Covers routing changes and players who join after a targeted play.
        if (!isRecipient(t.recipients)) {
            if (remoteSounds[id]) {
                try { (await remoteSounds[id]).stop({ fade: MICRO_FADE_MS }); } catch (e) {}
                delete remoteSounds[id];
            }
            continue;
        }

        if (!remoteSounds[id]) {
            if (t.isPaused) continue; // paused tracks stay silent
            remoteSounds[id] = game.audio.play(t.path, {
                volume: t.volume ?? 0.8,
                loop: !!t.isLooping,
                fade: MICRO_FADE_MS,
                spatialize: false
            }).then(s => {
                // If the GM paused while loading, catch up on the real start
                // (otherwise the loop would keep running despite the pause).
                const cur = (game.settings.get('soundbrett', 'activeState') ?? {})[id];
                if (s && cur && cur.isPaused && s.playing) s.pause();
                return s;
            });
            continue;
        }

        const s = await remoteSounds[id];
        if (!s) continue;
        const PAUSED = s.constructor?.STATES?.PAUSED;
        if (t.isPaused && s.playing) s.pause();
        // Resume only a genuinely PAUSED instance — never re-trigger a sound that
        // already finished. Foundry's Sound#play allows play() from STOPPED, so the
        // previous `!s.playing` check restarted finished one-shots on EVERY reconcile
        // (e.g. whenever the GM started another sound) — and only on players, since
        // the GM doesn't reconcile. A lost play signal is handled above (the sound is
        // missing from remoteSounds -> the !remoteSounds branch re-creates it).
        else if (!t.isPaused && s._state === PAUSED && typeof s.play === "function") s.play();
        // Set after play()/pause(), because play() resets volume/loop.
        s.loop = !!t.isLooping;
        s.volume = t.volume ?? 0.8;
    }
}

// --- Shared playback actions ------------------------------------------------
// Reusable play/stop/toggle so the UI tiles AND hotbar macros run identical
// logic. GM-only — players react passively via sockets / activeState reconcile.
// Each action emits the socket signal BEFORE the local game.audio.play, so
// players don't wait on the GM-side load.

// Stops the local GM instance and drops it from activeSounds (no socket, no
// persist — callers decide). Shared by the tile click, the Stop button and stopSound.
function stopLocalSound(id) {
    const activeSounds = globalThis.soundbrett.activeSounds;
    const track = activeSounds[id];
    if (track) {
        if (track.soundInstance && typeof track.soundInstance.stop === "function") {
            track.soundInstance.stop({ fade: MICRO_FADE_MS });
        }
        delete activeSounds[id];
    }
}

// Re-renders the open board if there is one (after a state change).
function refreshBoard() {
    if (ui.soundbrettApp?.rendered) ui.soundbrettApp.render();
}

// Natural end of a sound. Foundry's "end" event fires only on real completion —
// never on stop/pause (it clears the node's onended before those). For a one-shot
// (non-looping) we drop it from the active state so it neither lingers in "Active
// Playback" nor is reconsidered by players' reconcile. The instance check guards
// against a stale listener left over from an earlier play of the same id. GM-only
// (the listener is only attached to GM-side instances).
function onSoundEnded(id, instance) {
    const track = globalThis.soundbrett.activeSounds[id];
    if (!track || track.soundInstance !== instance || track.isLooping) return;
    delete globalThis.soundbrett.activeSounds[id];
    persistActiveState();
    refreshBoard();
}

// Starts a sound with its persisted per-sound defaults. {id, path, name}:
// id matches _prepareContext/soundSettings, path is the encoded file path (as stored on
// the tile and in hotbar macros), name is the display name.
async function playSound({ id, path, name } = {}) {
    if (!game.user?.isGM || !id || !path) return;
    const activeSounds = globalThis.soundbrett.activeSounds;
    const cfg = getSoundConfig(id);
    // Effective target: per-sound override if set, else the GM's board default.
    const recipients = resolveRouting(cfg);

    if (activeSounds[id]) stopLocalSound(id);

    const cleanPath = decodeURIComponent(path);

    // Emit FIRST — players should not wait for the GM-side load. Recipients ride
    // along so non-recipients can ignore the signal immediately.
    game.socket.emit('module.soundbrett', {
        action: "play", id, path: cleanPath, volume: cfg.volume, loop: cfg.loop, recipients
    });

    let soundInstance;
    try {
        soundInstance = await game.audio.play(cleanPath, {
            volume: cfg.volume, loop: cfg.loop, fade: MICRO_FADE_MS, spatialize: false
        });
    } catch (err) {
        console.warn(`Soundbrett | Could not play ${cleanPath}:`, err);
        ui.notifications?.warn(game.i18n.format("SOUNDBRETT.SoundMissing", { name: name ?? cleanPath }));
        return;
    }

    activeSounds[id] = {
        id, name: name ?? cleanPath, path: cleanPath,
        // Intended volume kept separate from the live (mid-fade) gain — see
        // serializeActiveSounds. Updated in sync by the volume slider handler.
        volume: cfg.volume,
        soundInstance, isLooping: cfg.loop, isPaused: false, recipients
    };

    // Self-clean: when a one-shot reaches its natural end, drop it from the state.
    soundInstance.addEventListener("end", () => onSoundEnded(id, soundInstance));

    persistActiveState();
    refreshBoard();
}

// Stops a sound locally and tells the players, then persists the shared state.
function stopSound(id) {
    if (!game.user?.isGM || !id) return;
    game.socket.emit('module.soundbrett', { action: "stop", id });
    stopLocalSound(id);
    persistActiveState();
    refreshBoard();
}

// Hotbar-friendly: play if idle, stop if already playing.
function toggleSound(args = {}) {
    if (!args.id) return;
    if (globalThis.soundbrett.activeSounds[args.id]) stopSound(args.id);
    else playSound(args);
}

// Stops every active sound at once: one stop socket per id, then a single
// persist + board refresh (cheaper than looping stopSound).
function stopAllSounds() {
    if (!game.user?.isGM) return;
    const ids = Object.keys(globalThis.soundbrett.activeSounds);
    if (ids.length === 0) return;
    for (const id of ids) {
        game.socket.emit('module.soundbrett', { action: "stop", id });
        stopLocalSound(id);
    }
    persistActiveState();
    refreshBoard();
}

// Warms the AudioBuffer cache (game.audio.buffers) that play() consults FIRST in
// its load path. We force the BUFFER path (forceBuffer:true) instead of Foundry's
// AudioHelper.preloadSound: many MP3s report duration === Infinity at
// loadedmetadata, so Foundry's default load then picks the STREAMING element path
// and caches NO buffer — a later play() re-fetches and the preload buys nothing
// (the observed symptom: preload did one media/206 request, play re-loaded via
// fetch). forceBuffer always fetches + decodes and caches the buffer under `src`,
// so game.audio.play(src) hits getBuffer(src) and starts instantly (no re-download).
// This decodes the whole file into memory — intended for the preload use case
// (larger/longer sounds that should start instantly and in sync). Emits no socket.
async function preloadBuffer(path) {
    const SoundCls = foundry.audio?.Sound;
    if (!SoundCls) return game.audio.constructor.preloadSound(path); // older cores
    const sound = new SoundCls(path, { forceBuffer: true });
    await sound.load();
    return sound;
}

// Preloads a sound at the players (and locally on the GM) so a later start is
// instant and in sync — without each client's individual download delay.
// Caching is harmless and the routing target may still change before play, so
// the preload is broadcast to ALL players, not just the current recipients.
// Returns true on a successful local load, false otherwise (UI shows feedback).
async function preloadSound({ path, name } = {}) {
    if (!game.user?.isGM || !path) return false;
    const cleanPath = decodeURIComponent(path);
    // Tell the players first — they have the longest way to go.
    game.socket.emit('module.soundbrett', { action: "preload", path: cleanPath });
    try {
        await preloadBuffer(cleanPath);
        return true;
    } catch (err) {
        console.warn(`Soundbrett | Could not preload ${cleanPath}:`, err);
        ui.notifications?.warn(game.i18n.format("SOUNDBRETT.PreloadMissing", { name: name ?? cleanPath }));
        return false;
    }
}

// --- Hotbar drag & drop -----------------------------------------------------
// Dropping a sound tile onto Foundry's macro hotbar creates a script macro that
// calls back into our public API (game.modules.get('soundbrett').api.toggle).
// The tile's dragstart (see _onRender) puts a {type:'soundbrett-sound'}
// payload into the DataTransfer; Foundry parses it into `data` for this hook.
Hooks.on("hotbarDrop", (bar, data, slot) => {
    if (data?.type !== "soundbrett-sound") return;
    const { id, path, name } = data;
    if (!id || !path) return;

    const command =
        `// Soundbrett: play/stop this sound (created via drag & drop)\n` +
        `game.modules.get("soundbrett")?.api?.toggle(${JSON.stringify({ id, path, name })});`;

    (async () => {
        let macro = game.macros.find(m => m.name === name && m.command === command);
        if (!macro) {
            macro = await Macro.create({
                name: name || "Soundbrett",
                type: "script",
                img: "icons/svg/sound.svg",
                command
            });
        }
        await game.user.assignHotbarMacro(macro, slot);
    })();

    return false; // suppress Foundry's default hotbar-drop handling
});

Hooks.once('ready', () => {
    console.log("Soundbrett | Sockets ready.");

    // Public API for hotbar macros (and any external callers). GM-only effect;
    // each function guards on game.user.isGM internally.
    const mod = game.modules.get("soundbrett");
    if (mod) mod.api = { play: playSound, stop: stopSound, stopAll: stopAllSounds, toggle: toggleSound, preload: preloadSound };

    game.socket.on('module.soundbrett', async (payload) => {
        if (game.user.isGM) return;

        console.log("Soundbrett | Socket signal received:", payload);

        const remoteSounds = globalThis.soundbrett.remoteSounds;

        if (payload.action === "play") {
            // Routing: not a recipient -> drop any lingering instance and ignore.
            if (!isRecipient(payload.recipients)) {
                if (remoteSounds[payload.id]) {
                    try { (await remoteSounds[payload.id]).stop({ fade: MICRO_FADE_MS }); } catch(e) {}
                    delete remoteSounds[payload.id];
                }
                return;
            }
            // Await and stop the previous sound (if any)
            if (remoteSounds[payload.id]) {
                try { (await remoteSounds[payload.id]).stop({ fade: MICRO_FADE_MS }); } catch(e) {}
                delete remoteSounds[payload.id];
            }
            // Store the promise IMMEDIATELY so subsequent signals (stop/pause)
            // can await it instead of running into nothing
            remoteSounds[payload.id] = game.audio.play(payload.path, {
                volume: payload.volume ?? 0.8,
                loop: payload.loop ?? false,
                fade: MICRO_FADE_MS,
                spatialize: false
            });

        } else if (payload.action === "stop") {
            const entry = remoteSounds[payload.id];
            if (entry) {
                try { (await entry).stop({ fade: MICRO_FADE_MS }); } catch(e) {}
                delete remoteSounds[payload.id];
            }

        } else if (payload.action === "pause") {
            const entry = remoteSounds[payload.id];
            if (entry) {
                const s = await entry;
                if (s && s.playing && typeof s.pause === "function") s.pause();
            }

        } else if (payload.action === "resume") {
            const entry = remoteSounds[payload.id];
            if (entry) {
                const s = await entry;
                if (s && !s.playing && typeof s.play === "function") {
                    // play() resets volume/loop -> save and restore them
                    const vol = s.volume, loop = s.loop;
                    s.play();
                    s.volume = vol;
                    s.loop = loop;
                }
            }

        } else if (payload.action === "volume") {
            const entry = remoteSounds[payload.id];
            if (entry) {
                const s = await entry;
                if (s) s.volume = payload.volume;
            }

        } else if (payload.action === "loop") {
            const entry = remoteSounds[payload.id];
            if (entry) {
                const s = await entry;
                if (s) s.loop = payload.loop;
            }

        } else if (payload.action === "preload") {
            // Warm the buffer cache so a later "play" starts without a download
            // delay. Fire-and-forget; no recipient filter (the target may change).
            // preloadBuffer forces the buffer path so play() actually hits the
            // cache (see its comment) and emits no further socket.
            try { await preloadBuffer(payload.path); } catch (e) {}
        }
    });

    // After a reload / on join, restore the running audio state.
    restoreActiveState();

    // Safety net against lost socket signals: when the shared 'activeState'
    // changes, every player reconciles its local playback with it.
    Hooks.on('updateSetting', (setting) => {
        if (!setting?.key?.endsWith('activeState')) return;
        if (!game.user.isGM) reconcilePlayerState();
    });
});

// Returns the effective theme. Falls back to 'neutral' when 'wfrp' is selected
// but the wfrp4e system is not active — otherwise the wfrp4e graphics/fonts
// referenced in the CSS would point to nothing.
function getActiveTheme() {
    let theme = game.settings.get('soundbrett', 'theme') || 'neutral';
    if (theme === 'wfrp' && game.system?.id !== 'wfrp4e') theme = 'neutral';
    return theme;
}

Hooks.once('init', () => {
    game.settings.register('soundbrett', 'soundDirectory', {
        name: game.i18n.localize("SOUNDBRETT.SettingsDirName"),
        hint: game.i18n.localize("SOUNDBRETT.SettingsDirHint"),
        scope: "world",
        config: true,
        type: String,
        default: "sounds"
    });

    // Per-user UI state: which category folders are collapsed.
    // config:false -> not shown in the settings menu, purely internal.
    game.settings.register('soundbrett', 'folderState', {
        scope: "client",
        config: false,
        type: Object,
        default: {}
    });

    // Board-wide default routing target (per GM, client-scope) for newly started
    // sounds. config:false — set via the in-board selector, not the settings menu.
    game.settings.register('soundbrett', 'routingDefault', {
        scope: "client",
        config: false,
        type: Object,
        default: { mode: "all" }
    });

    // Shared audio state (single source of truth across all GMs).
    game.settings.register('soundbrett', 'activeState', {
        scope: "world",
        config: false,
        type: Object,
        default: {}
    });

    // Durable per-sound defaults (favorite, volume, loop), keyed by sound id.
    // World-scope so all GMs share one library config. No onChange: favorite/preset
    // changes update the UI in place (see _onRender), never a full re-render.
    game.settings.register('soundbrett', 'soundSettings', {
        scope: "world",
        config: false,
        type: Object,
        default: {}
    });

    // Visual theme (world-scope, purely cosmetic — never changes behaviour).
    // Only offer WFRP when the wfrp4e system is active, otherwise the referenced
    // graphic assets/fonts are missing.
    const themeChoices = { neutral: game.i18n.localize("SOUNDBRETT.ThemeNeutral") };
    if (game.system?.id === "wfrp4e") {
        themeChoices.wfrp = game.i18n.localize("SOUNDBRETT.ThemeWfrp");
    }
    themeChoices.arcane = game.i18n.localize("SOUNDBRETT.ThemeArcane");

    game.settings.register('soundbrett', 'theme', {
        name: game.i18n.localize("SOUNDBRETT.SettingsThemeName"),
        hint: game.i18n.localize("SOUNDBRETT.SettingsThemeHint"),
        scope: "world",
        config: true,
        type: String,
        choices: themeChoices,
        default: "neutral",
        // Re-render an open window immediately -> theme switches live.
        onChange: () => { if (ui.soundbrettApp?.rendered) ui.soundbrettApp.render(); }
    });
});

Hooks.on('renderPlaylistDirectory', (app, html, data) => {
    if (!game.user.isGM) return;
    const rootElement = html.jquery ? html[0] : html;
    if (rootElement.querySelector('.soundboard-btn')) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'soundboard-btn';
    button.style.margin = '4px';
    // The theme class sets the --sb-* variables on the button itself (it lives
    // outside the app container) so that .soundboard-btn can resolve them.
    button.classList.add('soundbrett-theme-' + getActiveTheme());
    button.innerHTML = `<i class="fas fa-music"></i> ${game.i18n.localize("SOUNDBRETT.OpenButton")}`;

    button.addEventListener('click', (ev) => {
        ev.preventDefault();
        if (!ui.soundbrettApp) {
            ui.soundbrettApp = new SoundbrettApp();
        }
        ui.soundbrettApp.render(true);
    });

    const target = rootElement.querySelector('.header-actions') || rootElement.querySelector('.directory-header');
    if (target) target.appendChild(button);
});

// Unified routing picker (one dialog for the whole "who hears this?" choice):
// radio modes Everyone / Only GM / Specific players (+ "Default (board)" when
// allowInherit) over a checkbox list of non-GM users. Toggling a player implies
// "Specific players". Returns { v } where v is the chosen value — null (inherit),
// { mode:"all" }, or { mode:"custom", users:[…] } ([] = only GM) — or undefined
// when cancelled, so a null (inherit) result stays distinct from a dismiss.
// GM-only UI helper: a radio (Everyone / Only GM / Specific players, + Default
// when allowInherit) over a checkbox list of the non-GM users.
async function promptRouting({ current = null, allowInherit = false } = {}) {
    const players = game.users.filter(u => !u.isGM);
    const cur = current ? normalizeRouting(current) : null;
    let mode;
    if (current == null) mode = allowInherit ? "inherit" : "all";
    else if (cur.mode === "all") mode = "all";
    else mode = cur.users.length ? "custom" : "onlygm";
    const selected = new Set(cur && cur.mode === "custom" ? cur.users : []);

    const opt = (val, label, on) =>
        `<label style="display:flex;align-items:center;gap:6px;padding:3px 0;cursor:pointer;">`
        + `<input type="radio" name="rtmode" value="${val}" ${on ? "checked" : ""}> <span>${escapeHtml(label)}</span></label>`;
    let modes = "";
    if (allowInherit) modes += opt("inherit", game.i18n.localize("SOUNDBRETT.RoutingInherit"), mode === "inherit");
    modes += opt("all", game.i18n.localize("SOUNDBRETT.RoutingAll"), mode === "all");
    modes += opt("onlygm", game.i18n.localize("SOUNDBRETT.RoutingOnlyGM"), mode === "onlygm");
    modes += opt("custom", game.i18n.localize("SOUNDBRETT.RoutingSelectPlayers"), mode === "custom");

    const offline = game.i18n.localize("SOUNDBRETT.RoutingOffline");
    const rows = players.map(u =>
        `<label style="display:flex;align-items:center;gap:6px;padding:2px 0 2px 18px;cursor:pointer;">`
        + `<input type="checkbox" name="u" value="${escapeHtml(u.id)}" ${selected.has(u.id) ? "checked" : ""}>`
        + `<span>${escapeHtml(u.name)}${u.active ? "" : ` <em style="opacity:0.6;">${escapeHtml(offline)}</em>`}</span></label>`).join("");
    const playersBlock = players.length
        ? `<div style="margin-top:4px;border-top:1px solid var(--color-border-light-2,#999);padding-top:4px;">${rows}</div>`
        : `<p style="opacity:0.7;">${escapeHtml(game.i18n.localize("SOUNDBRETT.RoutingNoPlayers"))}</p>`;

    let res;
    try {
        res = await foundry.applications.api.DialogV2.prompt({
            window: { title: game.i18n.localize("SOUNDBRETT.RoutingDialogTitle") },
            content: `<div>${modes}${playersBlock}</div>`,
            render: (event, dialog) => {
                const root = dialog.element;
                const custom = root.querySelector('input[name="rtmode"][value="custom"]');
                root.querySelectorAll('input[name="u"]').forEach(cb =>
                    cb.addEventListener("change", () => { if (custom) custom.checked = true; }));
            },
            ok: {
                label: game.i18n.localize("SOUNDBRETT.RenameSave"),
                callback: (event, button) => {
                    const form = button.form;
                    const m = form.querySelector('input[name="rtmode"]:checked')?.value ?? "all";
                    if (m === "inherit") return { v: null };
                    if (m === "all") return { v: { mode: "all" } };
                    if (m === "onlygm") return { v: { mode: "custom", users: [] } };
                    const users = Array.from(form.querySelectorAll('input[name="u"]:checked')).map(el => el.value);
                    return { v: { mode: "custom", users } };
                }
            },
            rejectClose: false
        });
    } catch (e) { return undefined; } // dialog dismissed (rejectClose path)
    return (res && typeof res === "object" && "v" in res) ? res : undefined;
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// ApplicationV2 (HandlebarsApplicationMixin). The window inherits Foundry's
// themed chrome — and the active system's, e.g. wfrp4e. _prepareContext builds
// the render context; _onRender wires the DOM handlers with this.element as the
// native window root. NOTE: DEFAULT_OPTIONS is a static literal evaluated at load
// time, so window.title is an i18n KEY (AppV2 localizes it automatically) — not
// game.i18n.localize(...), which isn't ready yet.
class SoundbrettApp extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "soundbrett-app",
        classes: ["soundbrett-app"],
        tag: "div",
        window: { title: "SOUNDBRETT.AppTitle", icon: "fas fa-music", resizable: true },
        position: { width: 480, height: 600 }
    };

    static PARTS = {
        main: { template: "modules/soundbrett/template.html" }
    };

    async _prepareContext(options) {
        // Players have no file-system permission — return empty data
        if (!game.user.isGM) {
            return { categories: [], hasSounds: false, activeTracks: [], hasActiveTracks: false, theme: getActiveTheme() };
        }

        const mainDirPath = game.settings.get('soundbrett', 'soundDirectory');
        const categories = {};
        const picker = foundry.applications?.apps?.FilePicker?.implementation || FilePicker;
        // Localized label/sentinel for the root directory (shown as a category
        // when the root holds sounds directly; also used to detect the root below).
        const rootLabel = game.i18n.localize("SOUNDBRETT.RootFolder");

        const scanFolder = async (path, categoryName) => {
            try {
                const result = await picker.browse("data", path);
                const currentSounds = result.files
                    .filter(f => f.match(/\.(mp3|wav|ogg|webm|m4a|opus)$/i))
                    .map(f => {
                        const id = soundIdFromPath(f);
                        const cfg = getSoundConfig(id);
                        // File name (no extension) is the fallback; a custom name
                        // from soundSettings overrides it as the display name.
                        const fileName = decodeURIComponent(f.split('/').pop().split('.').shift());
                        return {
                            displayName: cfg.name?.trim() || fileName,
                            fileName,
                            path: f,
                            id,
                            isFavorite: cfg.favorite,
                            volume: cfg.volume,
                            isLooping: cfg.loop,
                            tags: cfg.tags,
                            // JSON list of the original tags; the search filter reads
                            // it to match by tag and to show the matching tag chips.
                            tagsJson: JSON.stringify(cfg.tags),
                            // Per-sound routing override label + tooltip for the gear
                            // panel's clickable target text ("Default (board)" when null).
                            routingLabel: cfg.routing
                                ? routingLabel(cfg.routing)
                                : game.i18n.localize("SOUNDBRETT.RoutingInherit"),
                            routingTitle: cfg.routing ? routingPlayerNames(cfg.routing) : ""
                        };
                    });

                if (currentSounds.length > 0) {
                    if (!categories[categoryName]) categories[categoryName] = [];
                    categories[categoryName] = categories[categoryName].concat(currentSounds);
                }

                for (let subDir of result.dirs) {
                    const subFolderName = decodeURIComponent(subDir.split('/').filter(Boolean).pop());
                    const nextCategoryName = categoryName === rootLabel
                        ? subFolderName
                        : `${categoryName} / ${subFolderName}`;
                    await scanFolder(subDir, nextCategoryName);
                }
            } catch (err) {
                console.warn(`Soundbrett | Error scanning ${path}:`, err);
            }
        };

        await scanFolder(mainDirPath, rootLabel);

        const activeSounds = globalThis.soundbrett.activeSounds;
        const playingList = Object.keys(activeSounds).map(id => {
            const s = activeSounds[id];
            const recipients = normalizeRouting(s.recipients);
            return {
                id: id,
                name: s.name,
                volume: s.volume ?? 0.8,
                isLooping: s.isLooping,
                isPaused: s.isPaused,
                // Visual feedback when a track is routed to only some players (or
                // only the GM): the active row shows a target badge with this label.
                isCustomTarget: recipients.mode === "custom",
                recipientsLabel: routingLabel(recipients),
                recipientsTitle: routingPlayerNames(recipients) || routingLabel(recipients)
            };
        });

        // Build the category list and pass the remembered collapsed state
        // (per user, client-scope) along as an isCollapsed flag.
        const folderState = game.settings.get('soundbrett', 'folderState') ?? {};
        const categoryList = Object.keys(categories).map(name => ({
            name,
            sounds: categories[name],
            isCollapsed: folderState[name] === true
        }));

        // Synthetic "Favorites" group: every favorited sound, alphabetically,
        // shown like a normal (collapsible) folder at the very top. The tiles are
        // the same sounds — toggling a star here un-favorites and re-renders.
        const favoriteSounds = Object.values(categories)
            .flat()
            .filter(s => s.isFavorite)
            .sort((a, b) => a.displayName.localeCompare(b.displayName));
        if (favoriteSounds.length > 0) {
            const favLabel = game.i18n.localize("SOUNDBRETT.Favorites");
            categoryList.unshift({
                name: favLabel,
                sounds: favoriteSounds,
                isCollapsed: folderState[favLabel] === true,
                isFavorites: true
            });
        }

        // Board-wide default routing target (this GM) for the top-of-board chip.
        const boardRouting = getBoardRouting();

        return {
            categories: categoryList,
            hasSounds: categoryList.length > 0,
            activeTracks: playingList,
            hasActiveTracks: playingList.length > 0,
            boardRoutingLabel: routingLabel(boardRouting),
            boardRoutingTitle: routingPlayerNames(boardRouting),
            theme: getActiveTheme()
        };
    }

    _onRender(context, options) {
        super._onRender(context, options);

        // Put the theme class on the app root element (the whole window) so the
        // .window-content resolves the --sb-* variables too, and no light section
        // background of the system shows through on scroll. In AppV2 this.element
        // is the native window root (no jQuery).
        const appRoot = this.element;
        if (appRoot) {
            appRoot.classList.remove('soundbrett-theme-neutral', 'soundbrett-theme-arcane', 'soundbrett-theme-wfrp');
            appRoot.classList.add('soundbrett-theme-' + getActiveTheme());
        }

        // WFRP-only window title icon: swap the default music note for a flute
        // (the piper's instrument — there is no real "Pied Piper" glyph in FA).
        // Toggle just the glyph class so AppV2's own window-icon/fa-fw classes stay.
        const titleIcon = appRoot?.querySelector('.window-header .window-icon');
        if (titleIcon) {
            const wfrp = getActiveTheme() === 'wfrp';
            titleIcon.classList.toggle('fa-flute', wfrp);
            titleIcon.classList.toggle('fa-music', !wfrp);
        }

        // Players need no listeners — the app should not be open for them at all
        if (!game.user.isGM) return;

        const rootElement = this.element;
        const activeSounds = globalThis.soundbrett.activeSounds;

        // Calm reveal: animate the "Active Playback" panel only when it FIRST
        // appears (empty -> non-empty), not on every re-render (pause/volume keep
        // re-rendering the whole board, which would otherwise re-trigger the slide).
        const activeContainer = rootElement.querySelector('.sb-active-container');
        const hasActiveNow = !!activeContainer && activeContainer.style.display !== 'none';
        if (hasActiveNow && !this._hadActive) activeContainer.classList.add('sb-active-enter');
        this._hadActive = hasActiveNow;

        // Active panel collapse: hide just the track list (keep the sticky header)
        // so a long list can't fill the sticky area and bury the library on scroll.
        // State lives on the instance so it survives the frequent re-renders.
        const activeList = activeContainer?.querySelector('.sb-active-list');
        const activeCollapseBtn = activeContainer?.querySelector('.sb-active-collapse');
        const applyActiveCollapsed = () => {
            if (!activeList || !activeCollapseBtn) return;
            const collapsed = !!this._activeCollapsed;
            activeList.style.display = collapsed ? 'none' : '';
            activeCollapseBtn.className = collapsed
                ? 'sb-active-collapse fas fa-chevron-right'
                : 'sb-active-collapse fas fa-chevron-down';
        };
        activeCollapseBtn?.addEventListener('click', () => {
            this._activeCollapsed = !this._activeCollapsed;
            applyActiveCollapsed();
        });
        applyActiveCollapsed();

        // Volume fires very often while dragging -> debounce persistence.
        const debouncedPersist = foundry.utils.debounce(() => persistActiveState(), 300);
        // Same for writing the durable per-sound volume default.
        const debouncedPersistConfig = foundry.utils.debounce((id, volume) => setSoundConfig(id, { volume }), 300);

        rootElement.querySelectorAll('.sb-folder-header').forEach(header => {
            header.addEventListener('click', async (ev) => {
                const content = ev.currentTarget.nextElementSibling;
                const icon = ev.currentTarget.querySelector('.toggle-icon');
                // Visible (display !== "none") -> will be collapsed now
                const willCollapse = content.style.display !== "none";
                content.style.display = willCollapse ? "none" : "grid";
                icon.className = willCollapse
                    ? "fas fa-chevron-right toggle-icon"
                    : "fas fa-chevron-down toggle-icon";

                // Remember the state per user so it survives re-renders and reloads
                const categoryName = ev.currentTarget.dataset.category;
                const folderState = foundry.utils.deepClone(game.settings.get('soundbrett', 'folderState') ?? {});
                folderState[categoryName] = willCollapse;
                await game.settings.set('soundbrett', 'folderState', folderState);
            });
        });

        // Expand/collapse ALL folders (incl. Favorites) at once. Same in-place DOM
        // toggle as the single header above, but writes folderState only once.
        const setAllFolders = async (collapsed) => {
            const folderState = foundry.utils.deepClone(game.settings.get('soundbrett', 'folderState') ?? {});
            rootElement.querySelectorAll('.sb-folder-header').forEach(header => {
                header.nextElementSibling.style.display = collapsed ? "none" : "grid";
                header.querySelector('.toggle-icon').className = collapsed
                    ? "fas fa-chevron-right toggle-icon"
                    : "fas fa-chevron-down toggle-icon";
                folderState[header.dataset.category] = collapsed;
            });
            await game.settings.set('soundbrett', 'folderState', folderState);
        };
        // Single toggle: collapse all if anything is open, otherwise expand all.
        // The icon reflects the action it will perform next.
        const toggleAllBtn = rootElement.querySelector('.sb-toggle-all');
        const anyFolderOpen = () =>
            [...rootElement.querySelectorAll('.sb-grid')].some(g => g.style.display !== 'none');
        const refreshToggleAllIcon = () => {
            const icon = toggleAllBtn?.querySelector('i');
            // State-based chevron: expanded folders -> down arrow, all collapsed
            // -> up arrow (per user preference; the arrow shows the current state).
            if (icon) icon.className = anyFolderOpen()
                ? 'fas fa-angle-double-down' // something open (expanded)
                : 'fas fa-angle-double-up';  // all collapsed
        };
        toggleAllBtn?.addEventListener('click', async () => {
            await setAllFolders(anyFolderOpen()); // collapse if any open, else expand
            refreshToggleAllIcon();
        });
        refreshToggleAllIcon();

        // Stop every active sound at once.
        rootElement.querySelector('.sb-stop-all')?.addEventListener('click', () => stopAllSounds());

        // Preload ALL favorites at once: warm every tile in the Favorites group's
        // grid (reuses the per-sound preloadSound). Sits in the Favorites header, so
        // it stops propagation to avoid toggling the folder. Shows a spinner while
        // the GM's own loads run, then a check (all ok) or warning (any failed).
        rootElement.querySelector('.sb-preload-favs')?.addEventListener('click', async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const icon = ev.currentTarget;
            if (icon.classList.contains('fa-spinner')) return; // already running
            const wrapper = icon.closest('.sb-category-wrapper');
            const nodes = Array.from(wrapper?.querySelectorAll('.sb-sound-node') ?? []);
            if (!nodes.length) return;
            const restore = icon.className;
            icon.className = 'sb-preload-favs fas fa-spinner fa-spin';
            const results = await Promise.all(nodes.map(n =>
                preloadSound({ path: n.dataset.path, name: n.dataset.name })));
            icon.className = results.every(Boolean)
                ? 'sb-preload-favs fas fa-check'
                : 'sb-preload-favs fas fa-triangle-exclamation';
            setTimeout(() => { icon.className = restore; }, 1500);
        });

        // --- Board-wide routing default --------------------------------------
        // One clickable text shows who newly started sounds go to (this GM's
        // choice, client-scope). A click opens the unified routing picker. Does NOT
        // affect already running tracks and does NOT re-render; only the label +
        // tooltip update in place.
        const routingTextBtn = rootElement.querySelector('.sb-routing-text');
        const routingLabelEl = rootElement.querySelector('.sb-routing-label');
        const refreshBoardRouting = () => {
            const r = getBoardRouting();
            if (routingLabelEl) routingLabelEl.textContent = routingLabel(r);
            if (routingTextBtn) routingTextBtn.title =
                routingPlayerNames(r) || game.i18n.localize("SOUNDBRETT.RoutingTargetHint");
        };
        routingTextBtn?.addEventListener('click', async () => {
            const result = await promptRouting({ current: getBoardRouting(), allowInherit: false });
            if (!result) return; // cancelled -> keep previous
            await game.settings.set('soundbrett', 'routingDefault', result.v ?? { mode: 'all' });
            refreshBoardRouting();
        });

        // --- Search / filter -------------------------------------------------
        // Pure in-place DOM filter (no render, no folderState write): tiles whose
        // name doesn't match are hidden; folders with at least one match show and
        // auto-expand, folders with none hide entirely. Clearing restores the
        // remembered collapsed state. The query is kept on the app instance so it
        // survives a re-render triggered by play/stop/favorite while searching.
        const searchInput = rootElement.querySelector('.sb-search-input');
        const noResults = rootElement.querySelector('.sb-no-results');

        // Reads a tile's tag list (stored as JSON on the sound node).
        const tileTags = (node) => {
            try { return JSON.parse(node?.dataset.tags || '[]'); } catch (e) { return []; }
        };
        // Shows the given tags as read-only chips under a tile (or clears them).
        const setMatchChips = (tile, hitTags) => {
            const box = tile.querySelector('.sb-tile-match-tags');
            if (!box) return;
            if (!hitTags.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
            box.innerHTML = hitTags.map(t => `<span class="sb-tag-chip sb-tag-chip-static">#${escapeHtml(t)}</span>`).join('');
            box.style.display = 'flex';
        };

        const applyFilter = (raw) => {
            const q = (raw ?? '').trim().toLowerCase();
            this._filterQuery = q;
            const wrappers = rootElement.querySelectorAll('.sb-category-wrapper');

            if (!q) {
                // Restore each folder to its remembered open/closed state.
                const folderState = game.settings.get('soundbrett', 'folderState') ?? {};
                wrappers.forEach(wrapper => {
                    wrapper.style.display = '';
                    const header = wrapper.querySelector('.sb-folder-header');
                    const collapsed = folderState[header.dataset.category] === true;
                    wrapper.querySelector('.sb-grid').style.display = collapsed ? 'none' : 'grid';
                    header.querySelector('.toggle-icon').className = collapsed
                        ? 'fas fa-chevron-right toggle-icon'
                        : 'fas fa-chevron-down toggle-icon';
                    wrapper.querySelectorAll('.sb-sound-tile').forEach(t => {
                        t.style.display = '';
                        setMatchChips(t, []); // hide match chips when not searching
                    });
                });
                if (noResults) noResults.style.display = 'none';
                return;
            }

            // Whitespace-split the query into terms; a tile matches if ANY term
            // matches (OR across terms). So "green blue" keeps both a "blue"-tagged
            // and a "green"-tagged sound — each term finds its own sounds, the union
            // stays visible. Tags may contain spaces, so a tile's tags are NOT
            // split — only the query is.
            const terms = q.split(/\s+/).filter(Boolean);
            let anyVisible = false;
            wrappers.forEach(wrapper => {
                let matches = 0;
                wrapper.querySelectorAll('.sb-sound-tile').forEach(tile => {
                    const node = tile.querySelector('.sb-sound-node');
                    // Match the display name, the original file name (so a renamed
                    // sound stays findable by its old name) and the tags. When a tag
                    // is what matched (any term), show it as a chip under the tile.
                    const name = (node?.dataset.name ?? '').toLowerCase();
                    const file = (node?.dataset.filename ?? '').toLowerCase();
                    const tagHits = tileTags(node).filter(t => {
                        const tl = t.toLowerCase();
                        return terms.some(term => tl.includes(term));
                    });
                    const textHit = terms.some(term => name.includes(term) || file.includes(term));
                    const hit = textHit || tagHits.length > 0;
                    tile.style.display = hit ? '' : 'none';
                    setMatchChips(tile, hit ? tagHits : []);
                    if (hit) matches++;
                });
                if (matches > 0) {
                    wrapper.style.display = '';
                    wrapper.querySelector('.sb-grid').style.display = 'grid'; // auto-expand
                    wrapper.querySelector('.toggle-icon').className = 'fas fa-chevron-down toggle-icon';
                    anyVisible = true;
                } else {
                    wrapper.style.display = 'none';
                }
            });
            if (noResults) noResults.style.display = anyVisible ? 'none' : 'block';
        };

        if (searchInput) {
            searchInput.addEventListener('input', (ev) => applyFilter(ev.currentTarget.value));
            searchInput.addEventListener('keydown', (ev) => {
                if (ev.key === 'Escape') { searchInput.value = ''; applyFilter(''); }
            });
            // Re-apply a query that survived a re-render (play/fav rebuild the DOM).
            if (this._filterQuery) {
                searchInput.value = this._filterQuery;
                applyFilter(this._filterQuery);
            }
        }

        rootElement.querySelectorAll('.sb-sound-node').forEach(button => {
            // Click (re)starts the sound with its persisted per-sound defaults.
            button.addEventListener('click', (ev) => {
                ev.preventDefault();
                const node = ev.currentTarget;
                playSound({ id: node.dataset.id, path: node.dataset.path, name: node.dataset.name });
            });

            // Drag onto the macro hotbar -> see the hotbarDrop hook. The payload
            // mirrors what playSound/toggleSound expect (id, encoded path, name).
            button.addEventListener('dragstart', (ev) => {
                const node = ev.currentTarget;
                ev.dataTransfer.setData("text/plain", JSON.stringify({
                    type: "soundbrett-sound",
                    id: node.dataset.id,
                    path: node.dataset.path,
                    name: node.dataset.name
                }));
                ev.dataTransfer.effectAllowed = "copy";
            });
        });

        // Favorite toggle: flip the icon immediately for feedback, persist, then
        // re-render so the synthetic "Favorites" group gains/loses this sound.
        rootElement.querySelectorAll('.sb-fav-toggle').forEach(btn => {
            btn.addEventListener('click', async (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const id = ev.currentTarget.dataset.id;
                const isFavorite = !ev.currentTarget.classList.contains('active');
                ev.currentTarget.classList.toggle('active', isFavorite);
                await setSoundConfig(id, { favorite: isFavorite });
                this.render();
            });
        });

        // Rename: open a small dialog to set a custom display name. Empty input
        // (or the file name itself) clears the override, reverting to the file name.
        // Persisting changes structure (Favorites order, search index) -> re-render.
        rootElement.querySelectorAll('.sb-rename').forEach(btn => {
            btn.addEventListener('click', async (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const node = ev.currentTarget.closest('.sb-sound-tile').querySelector('.sb-sound-node');
                const id = node.dataset.id;
                const fileName = node.dataset.filename;
                const current = node.dataset.name; // effective display name (custom or file name)

                let result;
                try {
                    result = await foundry.applications.api.DialogV2.prompt({
                        window: { title: game.i18n.localize("SOUNDBRETT.RenameTitle") },
                        content: `<p>${escapeHtml(game.i18n.localize("SOUNDBRETT.RenameHint"))}</p>`
                            + `<input type="text" name="sbname" value="${escapeHtml(current)}" placeholder="${escapeHtml(fileName)}" style="width:100%;" autofocus>`,
                        ok: {
                            label: game.i18n.localize("SOUNDBRETT.RenameSave"),
                            callback: (event, button) => button.form.elements.sbname.value
                        },
                        rejectClose: false
                    });
                } catch (e) { return; } // dialog dismissed
                if (result === null || result === undefined) return;

                const clean = result.trim();
                await setSoundConfig(id, { name: clean === fileName ? "" : clean });
                this.render();
            });
        });

        // Gear: toggle the per-tile settings panel (loop + rename + preload +
        // volume + routing + tags). The open state is tracked per sound id on the
        // instance so it SURVIVES a re-render — playing/stopping a sound (or a
        // one-shot ending) rebuilds the DOM via render(), which would otherwise
        // snap an open panel shut.
        this._openGears ??= new Set();
        rootElement.querySelectorAll('.sb-tile-gear').forEach(btn => {
            btn.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const tile = ev.currentTarget.closest('.sb-sound-tile');
                const id = tile?.dataset.id;
                const panel = tile?.querySelector('.sb-tile-settings');
                if (!panel || !id) return;
                const open = panel.style.display === "none";
                panel.style.display = open ? "flex" : "none";
                if (open) this._openGears.add(id); else this._openGears.delete(id);
            });
        });
        // Re-open panels that were open before a re-render (all tiles sharing the
        // id — e.g. a sound shown in both its folder and the Favorites group).
        this._openGears.forEach(id => {
            rootElement.querySelectorAll(`.sb-sound-tile[data-id="${id}"] .sb-tile-settings`)
                .forEach(panel => { panel.style.display = "flex"; });
        });

        // Loop pre-set: persist the default for the NEXT start (does not touch a
        // currently playing instance — that is what the Active Playback loop is for).
        rootElement.querySelectorAll('.sb-preset-loop').forEach(btn => {
            btn.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const id = ev.currentTarget.dataset.id;
                const loop = !ev.currentTarget.classList.contains('active');
                ev.currentTarget.classList.toggle('active', loop);
                setSoundConfig(id, { loop });
            });
        });

        // Preload: warm the buffer at all players (and locally) so the next start
        // is instant and in sync. The button shows a spinner while the GM's own
        // load runs and a check/warning afterwards (a proxy — players differ).
        rootElement.querySelectorAll('.sb-preset-preload').forEach(btn => {
            btn.addEventListener('click', async (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const b = ev.currentTarget;
                if (b.disabled) return;
                const node = b.closest('.sb-sound-tile')?.querySelector('.sb-sound-node');
                if (!node) return;
                const icon = b.querySelector('i');
                const restore = icon.className;
                icon.className = 'fas fa-spinner fa-spin';
                b.disabled = true;
                const ok = await preloadSound({ path: node.dataset.path, name: node.dataset.name });
                icon.className = ok ? 'fas fa-check' : 'fas fa-triangle-exclamation';
                setTimeout(() => { icon.className = restore; b.disabled = false; }, 1500);
            });
        });

        // Per-sound routing override: one clickable text opens the unified picker
        // (incl. "Default (board)" = inherit). Persists into soundSettings.routing
        // (null = inherit). Updates label + tooltip IN PLACE, no re-render.
        rootElement.querySelectorAll('.sb-route-row').forEach(row => {
            const id = row.dataset.id;
            const btn = row.querySelector('.sb-route-text');
            const labelEl = row.querySelector('.sb-route-label');
            if (!btn || !id) return;
            const refresh = () => {
                const cfg = getSoundConfig(id);
                if (labelEl) labelEl.textContent = cfg.routing
                    ? routingLabel(cfg.routing)
                    : game.i18n.localize("SOUNDBRETT.RoutingInherit");
                btn.title = (cfg.routing ? routingPlayerNames(cfg.routing) : "")
                    || game.i18n.localize("SOUNDBRETT.RoutingTargetHint");
            };
            btn.addEventListener('click', async (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const result = await promptRouting({ current: getSoundConfig(id).routing, allowInherit: true });
                if (!result) return; // cancelled -> keep previous
                await setSoundConfig(id, { routing: result.v });
                refresh();
            });
        });

        // Volume pre-set slider: persist the per-sound default (debounced).
        rootElement.querySelectorAll('.sb-preset-volume').forEach(slider => {
            slider.addEventListener('input', (ev) => {
                const id = ev.currentTarget.dataset.id;
                const volume = parseFloat(ev.currentTarget.value);
                debouncedPersistConfig(id, volume);
            });
        });

        // Tags: edit per sound inside the gear panel. Add via Enter, remove via the
        // chip's ×. Both update the chips IN PLACE, persist, and keep the node's
        // data-tags in sync so the search filter sees changes without a render.
        rootElement.querySelectorAll('.sb-tags-row').forEach(row => {
            const id = row.dataset.id;
            const addInput = row.querySelector('.sb-tag-add');
            const node = row.closest('.sb-sound-tile')?.querySelector('.sb-sound-node');
            const syncTags = (tags) => { if (node) node.dataset.tags = JSON.stringify(tags); };

            addInput?.addEventListener('keydown', async (ev) => {
                ev.stopPropagation();
                if (ev.key !== "Enter") return;
                ev.preventDefault();
                // Comma-separated input adds each part as its own tag (so
                // "blau, grün, rot" -> three tags). Split on commas only — tags may
                // contain spaces, so whitespace must not split.
                const parts = ev.currentTarget.value.split(',').map(s => s.trim()).filter(Boolean);
                ev.currentTarget.value = "";
                if (!parts.length) return;
                const tags = getSoundConfig(id).tags;
                let added = false;
                for (const part of parts) {
                    // Dedupe against existing AND already-added-in-this-batch tags
                    // (the running push makes the check see earlier parts too).
                    if (tags.some(t => t.toLowerCase() === part.toLowerCase())) continue;
                    tags.push(part);
                    added = true;
                    const chip = document.createElement('span');
                    chip.className = 'sb-tag-chip';
                    chip.dataset.tag = part;
                    chip.innerHTML = `#${escapeHtml(part)} <i class="sb-tag-remove fas fa-times" title="${escapeHtml(game.i18n.localize("SOUNDBRETT.RemoveTag"))}"></i>`;
                    row.insertBefore(chip, addInput);
                }
                if (!added) return;
                await setSoundConfig(id, { tags });
                syncTags(tags);
            });

            // Delegated so dynamically added chips work without re-wiring.
            row.addEventListener('click', async (ev) => {
                const remove = ev.target.closest('.sb-tag-remove');
                if (!remove) return;
                ev.preventDefault();
                ev.stopPropagation();
                const chip = remove.closest('.sb-tag-chip');
                const tag = chip.dataset.tag;
                const tags = getSoundConfig(id).tags.filter(t => t.toLowerCase() !== tag.toLowerCase());
                await setSoundConfig(id, { tags });
                chip.remove();
                syncTags(tags);
            });
        });

        rootElement.querySelectorAll('.track-stop').forEach(btn => {
            btn.addEventListener('click', (ev) => {
                stopSound(ev.currentTarget.dataset.id);
            });
        });

        rootElement.querySelectorAll('.track-pause').forEach(btn => {
            btn.addEventListener('click', (ev) => {
                const id = ev.currentTarget.dataset.id;
                const track = activeSounds[id];
                if (!track || !track.soundInstance) return;

                const s = track.soundInstance;
                if (track.isPaused) {
                    // play() resets volume/loop -> save first, restore afterwards
                    const vol = s.volume;
                    if (!s.playing && typeof s.play === "function") s.play();
                    s.volume = vol;
                    s.loop = track.isLooping;
                    track.isPaused = false;
                    game.socket.emit('module.soundbrett', { action: "resume", id });
                } else {
                    // Sound#pause throws when not PLAYING -> only pause then.
                    if (s.playing && typeof s.pause === "function") s.pause();
                    track.isPaused = true;
                    game.socket.emit('module.soundbrett', { action: "pause", id });
                }
                persistActiveState();
                this.render();
            });
        });

        rootElement.querySelectorAll('.track-loop').forEach(btn => {
            btn.addEventListener('click', (ev) => {
                const id = ev.currentTarget.dataset.id;
                const track = activeSounds[id];
                if (!track || !track.soundInstance) return;

                track.isLooping = !track.isLooping;
                track.soundInstance.loop = track.isLooping;
                game.socket.emit('module.soundbrett', { action: "loop", id, loop: track.isLooping });
                // Feed the change back into the durable per-sound default.
                setSoundConfig(id, { loop: track.isLooping });
                persistActiveState();
                this.render();
            });
        });

        rootElement.querySelectorAll('.track-volume-slider').forEach(slider => {
            slider.addEventListener('input', (ev) => {
                const id = ev.currentTarget.dataset.id;
                const volume = parseFloat(ev.currentTarget.value);
                const track = activeSounds[id];
                if (track && track.soundInstance) {
                    track.soundInstance.volume = volume;
                    track.volume = volume; // keep the intended volume in sync (persisted)
                    game.socket.emit('module.soundbrett', { action: "volume", id, volume });
                    debouncedPersist();
                    // Feed the change back into the durable per-sound default.
                    debouncedPersistConfig(id, volume);
                }
            });
        });
    }
}
