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

// True when a sound has any stored gear-panel setting — a lean soundSettings
// entry with a key other than 'favorite' (the star shows that one itself).
// Drives the gear icon tint on the tile (same gold as the favorite star).
function hasCustomSoundConfig(id) {
    const lean = (game.settings.get('soundbrett', 'soundSettings') ?? {})[id];
    return !!lean && Object.keys(lean).some(k => k !== "favorite");
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
    // Mirror gear tint + panel presets in place: most gear-panel edits (loop
    // preset, volume, tags, routing) persist WITHOUT a render, and the
    // active-row loop/volume feedback writes back here too. Renders set the
    // same state from the hasCustom context flag.
    if (ui.soundbrettApp?.rendered) ui.soundbrettApp.syncGearState(id);
}

// Clears the whole world-scope 'soundSettings' store — every sound falls back
// to DEFAULT_SOUND_CONFIG (no favorites, default volume/loop, file names as
// display names, no tags, board routing). Triggered from the settings-menu
// reset dialog. activeState is deliberately untouched: running tracks keep
// playing exactly as they were started. A full re-render of an open board
// refreshes names, favorites group and preset panels in one go.
async function resetSoundSettings() {
    if (!game.user?.isGM) return;
    await game.settings.set('soundbrett', 'soundSettings', {});
    ui.notifications?.info(game.i18n.localize("SOUNDBRETT.ResetDone"));
    if (ui.soundbrettApp?.rendered) ui.soundbrettApp.render(true);
}

// Prunes orphaned entries from the two per-sound/per-folder stores; called
// after a COMPLETE library scan (callers must skip partial scans — a folder
// that failed to browse would make its files look deleted). Both stores
// otherwise collect leftovers when files move or folders are renamed.
// soundSettings: the sound id is reversible (btoa(encodeURIComponent(path))),
// so an entry is dropped only when its decoded path lies UNDER the scanned
// directory but the file is gone — settings belonging to a different sound
// directory are kept, switching soundDirectory back and forth never loses
// configs. folderState is keyed by the LOCALIZED category name; valid keys are
// the current categories plus the Favorites group (whose collapsed state
// should survive phases without favorites). Writes are fire-and-forget — no
// consumer caches either store, and nothing reacts to their updateSetting.
function pruneStores(dirPath, files) {
    if (!game.user?.isGM) return;
    const norm = s => { try { return decodeURIComponent(s); } catch (e) { return s; } };

    const validIds = new Set();
    for (const paths of Object.values(files)) {
        for (const f of paths) validIds.add(soundIdFromPath(f));
    }
    const dirPrefix = norm(dirPath).replace(/\/+$/, "") + "/";
    const all = game.settings.get('soundbrett', 'soundSettings') ?? {};
    const kept = {};
    let dropped = 0;
    for (const [id, cfg] of Object.entries(all)) {
        let keep = true;
        if (!validIds.has(id)) {
            let path = null;
            try { path = decodeURIComponent(atob(id)); } catch (e) { /* foreign key — keep it */ }
            if (path !== null && norm(path).startsWith(dirPrefix)) keep = false;
        }
        if (keep) kept[id] = cfg;
        else dropped++;
    }
    if (dropped > 0) {
        console.log(`Soundbrett | Pruned ${dropped} orphaned sound setting entr${dropped === 1 ? "y" : "ies"}.`);
        game.settings.set('soundbrett', 'soundSettings', kept);
    }

    const favLabel = game.i18n.localize("SOUNDBRETT.Favorites");
    const validFolders = new Set([...Object.keys(files), favLabel]);
    const folderState = game.settings.get('soundbrett', 'folderState') ?? {};
    const stale = Object.keys(folderState).filter(k => !validFolders.has(k));
    if (stale.length > 0) {
        const cleaned = { ...folderState };
        for (const k of stale) delete cleaned[k];
        game.settings.set('soundbrett', 'folderState', cleaned);
    }
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
            // Position sync: virtual start timestamp (epoch ms). Elapsed wall-
            // clock time since it equals the intended playback position (resume
            // shifts it by the pause duration — see the pause/resume handler).
            startedAt: s.startedAt ?? null,
            // Who hears this track — the reconcile net reads it to filter players.
            recipients: normalizeRouting(s.recipients)
        };
        // Where a paused track stands (seconds) — restore/reconcile resume there.
        if (s.isPaused) out[id].pausedPosition = s.pausedPosition ?? 0;
    }
    return out;
}

// Only the GM may write the world-scope setting.
async function persistActiveState() {
    if (!game.user?.isGM) return;
    await game.settings.set('soundbrett', 'activeState', serializeActiveSounds());
}

// --- Progress display (GM-side) ---------------------------------------------
// The active rows show elapsed time / duration, updated by a timer tick that
// touches only textContent (never a render). All of it rides on the position
// sync that already exists for reconcile/restore (startedAt/pausedPosition).

// Seconds -> "m:ss" (or "h:mm:ss" from an hour up).
function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const s = sec % 60;
    const m = Math.floor(sec / 60) % 60;
    const h = Math.floor(sec / 3600);
    const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

// Current playback position (seconds) of a GM-side activeSounds entry. Paused
// tracks sit at their stored pausedPosition. Playing tracks prefer the
// instance clock (exact, offset-aware); while the instance is still STARTING
// (currentTime not finite yet) the virtual-start math fills in. Loops wrap
// into the cycle so the display matches what is audible.
function trackPosition(track) {
    if (track.isPaused) return Math.max(0, track.pausedPosition ?? 0);
    const s = track.soundInstance;
    let pos = (s && Number.isFinite(s.currentTime)) ? s.currentTime
        : track.startedAt ? (Date.now() - track.startedAt) / 1000 : 0;
    const dur = s?.duration;
    if (track.isLooping && Number.isFinite(dur) && dur > 0) pos = pos % dur;
    return Math.max(0, pos);
}

// "1:23 / 3:45" — duration part only when known (streaming MP3s can report a
// non-finite duration; then the label degrades to just the elapsed time).
function trackTimeLabel(track) {
    const dur = track.soundInstance?.duration;
    const hasDur = Number.isFinite(dur) && dur > 0;
    return formatTime(trackPosition(track)) + (hasDur ? ` / ${formatTime(dur)}` : "");
}

// Pauses a Sound without tripping Foundry's state guard. Sound#pause throws
// unless the state is exactly PLAYING — but Sound#playing is ALSO true while
// STARTING (play requested, actual start still pending; game.audio.play does
// not await Sound#play, so a freshly created sound sits in that window). A
// pause landing in the window (GM pauses right after starting; reconcile races
// a fresh play) must WAIT for the real start and pause then — skipping would
// leave the sound audibly running against the shared state. The wait is
// bounded: if the start never happens (load failure), give up after a timeout
// and let the reconcile net re-align later. The final state check also dedupes
// concurrent callers (socket pause + reconcile hitting the same sound): the
// second one sees PAUSED and does nothing. Never rejects.
async function safePause(s) {
    if (!s || typeof s.pause !== "function") return;
    const STATES = s.constructor?.STATES;
    if (!STATES) return;
    if (s._state === STATES.STARTING) {
        await Promise.race([
            new Promise(res => s.addEventListener("play", res, { once: true })),
            new Promise(res => setTimeout(res, 3000))
        ]);
        // The "play" event fires just BEFORE Sound#play flips the state to
        // PLAYING (one microtask later) — yield once so the check below sees it.
        await Promise.resolve();
    }
    if (s._state === STATES.PLAYING) s.pause();
}

// Creates and starts a Sound for a track from the shared state, at the
// position it SHOULD be at right now (position sync). 'startedAt' is the
// virtual start timestamp from activeState; the elapsed wall-clock time since
// it is mapped into the sound: loops wrap into the cycle (modulo duration),
// a non-looping track whose time already ran out resolves to null (finished
// while everyone was away — never replayed). Paused tracks start at their
// stored pausedPosition (callers pause the instance right after, which makes
// a later resume continue there). Falls back to offset 0 when the duration
// is unknown — streaming MP3s can report a non-finite duration — which is
// exactly the pre-position-sync behavior. Shared by the GM restore and the
// players' reconcile so both compute positions identically.
async function playFromState(t) {
    const sound = new foundry.audio.Sound(t.path);
    await sound.load();
    const dur = sound.duration;
    const hasDur = Number.isFinite(dur) && dur > 0;
    let offset = 0;
    if (t.isPaused) {
        offset = Math.max(0, t.pausedPosition ?? 0);
        // A loop's clock keeps counting past the duration — wrap into the cycle.
        if (hasDur && t.isLooping) offset = offset % dur;
    } else if (t.startedAt) {
        const elapsed = Math.max(0, (Date.now() - t.startedAt) / 1000);
        if (hasDur) {
            if (t.isLooping) offset = elapsed % dur;
            else if (elapsed >= dur) return null; // one-shot finished while away
            else offset = elapsed;
        }
    }
    await sound.play({
        volume: t.volume ?? 0.8,
        loop: !!t.isLooping,
        fade: MICRO_FADE_MS,
        offset
    });
    return sound;
}

// Restores the audio state after a reload. Runs on EVERY client (including
// players that join later). Never writes back and never emits sockets (one
// narrow, documented exception: the GM restore prunes one-shots that FINISHED
// during the downtime — see below).
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
        let droppedFinished = false;
        for (const id of ids) {
            const t = state[id];
            let soundInstance;
            try {
                soundInstance = await playFromState(t);
            } catch (err) {
                // Missing/unreadable file: keep going so one bad entry doesn't
                // abort the whole restore. The entry stays in the state (it may
                // be a transient storage hiccup); any later persist prunes it.
                console.warn(`Soundbrett | Could not restore ${t.path}:`, err);
                continue;
            }
            // null = a non-looping track ran out while everyone was away.
            if (!soundInstance) { droppedFinished = true; continue; }
            // Keep logically paused tracks silent locally (board shows them paused).
            // safePause guards Foundry's PLAYING-only state check. It records the
            // current position (the restored pausedPosition), so resume continues there.
            if (t.isPaused) await safePause(soundInstance);
            activeSounds[id] = {
                id, name: t.name, path: t.path,
                volume: t.volume ?? 0.8,
                soundInstance, isLooping: !!t.isLooping, isPaused: !!t.isPaused,
                // Carry the virtual start over UNCHANGED: the sound resumed at
                // elapsed-so-far, so position math stays continuous across reloads.
                startedAt: t.startedAt ?? Date.now(),
                pausedPosition: t.pausedPosition,
                // GM hears every track locally regardless; recipients is kept so a
                // re-persist (and players' reconcile) preserves the original target.
                recipients: normalizeRouting(t.recipients)
            };
            // Self-clean: drop a restored one-shot from the state once it ends.
            soundInstance.addEventListener("end", () => onSoundEnded(id, soundInstance));
        }
        // Narrow, deliberate exception to "restore never writes back": REMOVE
        // one-shots that finished during the downtime from the shared state.
        // Pure idempotent cleanup (the same effect onSoundEnded would have had
        // live); without it they linger as ghosts in "Active Playback" and in
        // every player's reconcile. Removal can't loop or re-trigger anything.
        if (droppedFinished) await persistActiveState();
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
            // Start at the position the track SHOULD be at (position sync):
            // late joiners drop into a long loop mid-cycle instead of at 0. A
            // one-shot whose time already ran out resolves to null — kept in
            // the map so it isn't re-created on every reconcile; the GM's next
            // persist removes the state entry (and step 1 then drops it here).
            remoteSounds[id] = playFromState(t).then(s => {
                // If the GM paused while loading, catch up on the real start
                // (otherwise the loop would keep running despite the pause).
                const cur = (game.settings.get('soundbrett', 'activeState') ?? {})[id];
                if (s && cur && cur.isPaused) safePause(s);
                return s;
            }).catch(err => {
                console.warn(`Soundbrett | Could not reconcile ${t.path}:`, err);
                return null; // downstream handlers all guard on a null sound
            });
            continue;
        }

        const s = await remoteSounds[id];
        if (!s) continue;
        const PAUSED = s.constructor?.STATES?.PAUSED;
        // Fire-and-forget: safePause may wait for a STARTING sound to actually
        // begin — the loop must not stall on it (loop/volume below are fine to
        // set first, pause preserves them).
        if (t.isPaused) safePause(s);
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

// Refreshes the open board after a PLAYBACK state change: re-renders only the
// small "active" template part (the library part — open gear panels, search
// filter, scroll position — keeps its DOM) and syncs the tiles' playing
// indicator in place, since that lives in the un-rendered library part.
function refreshBoard() {
    const app = ui.soundbrettApp;
    if (!app?.rendered) return;
    app.render({ parts: ["active"] });
    app.syncTileIndicators();
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
        soundInstance, isLooping: cfg.loop, isPaused: false, recipients,
        // Virtual start for position sync (see playFromState/serializeActiveSounds).
        startedAt: Date.now()
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
    const sound = new foundry.audio.Sound(path, { forceBuffer: true });
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
                // safePause: the sound may still be STARTING (game.audio.play
                // does not await Sound#play) when a fast GM pause arrives.
                if (s) await safePause(s);
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
        // Exact match — endsWith would also fire on another module's
        // "othermodule.activeState" and trigger needless reconciles.
        if (setting?.key !== 'soundbrett.activeState') return;
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

// Confirmation dialog behind the settings-menu button "Reset sound settings".
// registerMenu needs an ApplicationV2 class it can construct and render(true);
// DialogV2 fits — the confirm/cancel logic lives in its buttons (labels and
// window.title are i18n keys, DialogV2 localizes them itself). The content is
// built at construction time, which is fine: the menu opens long after i18n
// is ready, and the settings count is current for each open.
class ResetSoundSettingsDialog extends foundry.applications.api.DialogV2 {
    constructor(options = {}) {
        const count = Object.keys(game.settings.get('soundbrett', 'soundSettings') ?? {}).length;
        super(foundry.utils.mergeObject({
            window: { title: "SOUNDBRETT.ResetDialogTitle", icon: "fas fa-rotate-left" },
            content: `<p>${escapeHtml(game.i18n.format("SOUNDBRETT.ResetDialogContent", { count }))}</p>`,
            buttons: [
                {
                    action: "reset",
                    label: "SOUNDBRETT.ResetConfirm",
                    icon: "fas fa-rotate-left",
                    callback: () => resetSoundSettings()
                },
                { action: "cancel", label: "SOUNDBRETT.ResetCancel", icon: "fas fa-times", default: true }
            ]
        }, options));
    }
}

Hooks.once('init', () => {
    // Settings name/hint/choices are passed as BARE i18n keys: 'init' fires
    // before 'i18nInit', so module translations aren't guaranteed here — the
    // settings UI localizes the keys itself when it renders (same reasoning as
    // the i18n key in DEFAULT_OPTIONS.window.title).
    game.settings.register('soundbrett', 'soundDirectory', {
        name: "SOUNDBRETT.SettingsDirName",
        hint: "SOUNDBRETT.SettingsDirHint",
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

    // Settings-menu button: reset ALL per-sound settings in one go (favorites,
    // volumes, loop presets, custom names, tags, routing overrides). The
    // DialogV2 subclass carries the confirmation; restricted -> GM-only entry.
    game.settings.registerMenu('soundbrett', 'resetSoundSettings', {
        name: "SOUNDBRETT.ResetMenuName",
        label: "SOUNDBRETT.ResetMenuLabel",
        hint: "SOUNDBRETT.ResetMenuHint",
        icon: "fas fa-rotate-left",
        type: ResetSoundSettingsDialog,
        restricted: true
    });

    // Visual theme (world-scope, purely cosmetic — never changes behaviour).
    // Only offer WFRP when the wfrp4e system is active, otherwise the referenced
    // graphic assets/fonts are missing.
    const themeChoices = { neutral: "SOUNDBRETT.ThemeNeutral" };
    if (game.system?.id === "wfrp4e") {
        themeChoices.wfrp = "SOUNDBRETT.ThemeWfrp";
    }
    themeChoices.arcane = "SOUNDBRETT.ThemeArcane";

    game.settings.register('soundbrett', 'theme', {
        name: "SOUNDBRETT.SettingsThemeName",
        hint: "SOUNDBRETT.SettingsThemeHint",
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
        position: { width: 480, height: 600 },
        // Click handling via AppV2's event delegation: every clickable control
        // carries a data-action in the templates; AppV2 listens once on the app
        // root and calls the handler with `this` bound to the instance and the
        // innermost [data-action] element as `target` (so nested actions — e.g.
        // preloadFavorites inside the toggleFolder header — don't double-fire).
        // The handlers are static private methods further down; referencing them
        // here works because static METHODS exist before static FIELD
        // initializers (like this literal) run. Non-click events (input,
        // keydown, dragstart) can't be actions — see _onFirstRender.
        actions: {
            collapseActive: SoundbrettApp.#onCollapseActive,
            stopAll: SoundbrettApp.#onStopAll,
            trackPause: SoundbrettApp.#onTrackPause,
            trackLoop: SoundbrettApp.#onTrackLoop,
            trackStop: SoundbrettApp.#onTrackStop,
            toggleFolder: SoundbrettApp.#onToggleFolder,
            toggleAllFolders: SoundbrettApp.#onToggleAllFolders,
            refreshLibrary: SoundbrettApp.#onRefreshLibrary,
            preloadFavorites: SoundbrettApp.#onPreloadFavorites,
            routeBoard: SoundbrettApp.#onRouteBoard,
            playTile: SoundbrettApp.#onPlayTile,
            toggleFavorite: SoundbrettApp.#onToggleFavorite,
            toggleGear: SoundbrettApp.#onToggleGear,
            presetLoop: SoundbrettApp.#onPresetLoop,
            renameSound: SoundbrettApp.#onRenameSound,
            resetSound: SoundbrettApp.#onResetSound,
            preloadTile: SoundbrettApp.#onPreloadTile,
            routeSound: SoundbrettApp.#onRouteSound,
            removeTag: SoundbrettApp.#onRemoveTag
        }
    };

    // Two template parts: playback (play/stop/pause/one-shot end) re-renders
    // ONLY "active" (see refreshBoard) — the library DOM with its open gear
    // panels, search filter and scroll position is never rebuilt by playback.
    // "library" re-renders only on structural changes (favorite, rename,
    // refresh). scrollable: the mixin saves/restores those elements' scroll
    // positions across re-renders of their own part.
    static PARTS = {
        active: { template: "modules/soundbrett/templates/active.html", scrollable: [".sb-active-list"] },
        library: { template: "modules/soundbrett/templates/library.html", scrollable: [".sb-scroll"] }
    };

    async _prepareContext(options) {
        // Players have no file-system permission — return empty data
        if (!game.user.isGM) {
            return { categories: [], hasSounds: false, activeTracks: [], hasActiveTracks: false, theme: getActiveTheme() };
        }

        const mainDirPath = game.settings.get('soundbrett', 'soundDirectory');
        // Localized label/sentinel for the root directory (shown as a category
        // when the root holds sounds directly; also used to detect the root below).
        const rootLabel = game.i18n.localize("SOUNDBRETT.RootFolder");

        // Scan cache: the recursive FilePicker.browse walk (one request per
        // folder — real HTTP roundtrips on remote storage) runs only on the
        // first render and after an invalidation, NOT on every play/stop/
        // favorite re-render. Invalidated by the toolbar refresh button
        // (.sb-refresh) and automatically when soundDirectory changes (the dir
        // key below). Only the FILE paths are cached — per-sound config is read
        // fresh each render further down, so favorite/rename/tag changes always
        // show current values. New/removed files appear after a refresh.
        let uncachedFiles = null; // holds an empty scan's result (never cached)
        if (!this._libraryCache || this._libraryCache.dir !== mainDirPath) {
            const picker = foundry.applications?.apps?.FilePicker?.implementation || FilePicker;
            const files = {}; // category name -> [file paths]
            let scanFailed = false; // any folder that failed to browse -> scan is partial

            const scanFolder = async (path, categoryName) => {
                try {
                    const result = await picker.browse("data", path);
                    const audioFiles = result.files.filter(f => f.match(/\.(mp3|wav|ogg|webm|m4a|opus)$/i));
                    if (audioFiles.length > 0) {
                        files[categoryName] = (files[categoryName] ?? []).concat(audioFiles);
                    }
                    for (let subDir of result.dirs) {
                        const subFolderName = decodeURIComponent(subDir.split('/').filter(Boolean).pop());
                        const nextCategoryName = categoryName === rootLabel
                            ? subFolderName
                            : `${categoryName} / ${subFolderName}`;
                        await scanFolder(subDir, nextCategoryName);
                    }
                } catch (err) {
                    scanFailed = true;
                    console.warn(`Soundbrett | Error scanning ${path}:`, err);
                }
            };

            await scanFolder(mainDirPath, rootLabel);
            // Don't cache an EMPTY scan: with no sounds the toolbar (and its
            // refresh button) isn't rendered, so an empty result would be stuck
            // until reopen. Rescanning an empty dir is cheap anyway.
            if (Object.keys(files).length > 0) {
                this._libraryCache = { dir: mainDirPath, files };
                // Clean out store entries whose file/folder no longer exists —
                // only on a COMPLETE scan (a failed browse would make its files
                // look deleted and prune their settings by mistake).
                if (!scanFailed) pruneStores(mainDirPath, files);
            }
            else { this._libraryCache = null; uncachedFiles = files; }
        }
        const libraryFiles = this._libraryCache?.files ?? uncachedFiles ?? {};

        // Build the render-ready sound entries from the cached paths, merging in
        // the CURRENT per-sound config (never cached).
        const activeSoundsNow = globalThis.soundbrett.activeSounds;
        const categories = {};
        for (const [categoryName, paths] of Object.entries(libraryFiles)) {
            categories[categoryName] = paths.map(f => {
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
                    // Gear tint: the sound has stored gear-panel settings
                    // (anything but the favorite flag, which the star shows).
                    hasCustom: hasCustomSoundConfig(id),
                    // Slider POSITION, not the gain: the sliders run on Foundry's
                    // perceptual curve (AudioHelper.volumeToInput/inputToVolume,
                    // like the core playlist sliders) — linear sliders feel too
                    // coarse at the quiet end. Stored/emitted values stay real gain.
                    volumeInput: foundry.audio.AudioHelper.volumeToInput(cfg.volume),
                    isLooping: cfg.loop,
                    tags: cfg.tags,
                    // JSON list of the original tags; the search filter reads
                    // it to match by tag and to show the matching tag chips.
                    tagsJson: JSON.stringify(cfg.tags),
                    // Playing indicator: the tile shows a glyph + accent border
                    // while its sound is in activeSounds. Render-time state is
                    // enough — every play/stop/pause/end re-renders the board.
                    isActive: !!activeSoundsNow[id],
                    isActivePaused: !!activeSoundsNow[id]?.isPaused,
                    // Per-sound routing override label + tooltip for the gear
                    // panel's clickable target text ("Default (board)" when null).
                    routingLabel: cfg.routing
                        ? routingLabel(cfg.routing)
                        : game.i18n.localize("SOUNDBRETT.RoutingInherit"),
                    routingTitle: cfg.routing ? routingPlayerNames(cfg.routing) : ""
                };
            });
        }

        const playingList = Object.keys(activeSoundsNow).map(id => {
            const s = activeSoundsNow[id];
            const recipients = normalizeRouting(s.recipients);
            return {
                id: id,
                name: s.name,
                // Slider position on the perceptual curve — see the tile entries.
                volumeInput: foundry.audio.AudioHelper.volumeToInput(s.volume ?? 0.8),
                isLooping: s.isLooping,
                isPaused: s.isPaused,
                // Initial progress label ("1:23 / 3:45"); the timer tick keeps
                // it current in place afterwards (see _tickProgress).
                timeLabel: trackTimeLabel(s),
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

    /* ----------------------------------------------------------------------
       One-time wiring (per open). Clicks are handled by the actions delegation
       (DEFAULT_OPTIONS.actions); input/keydown/dragstart cannot be actions, so
       they are delegated manually on the app root. The root element is rebuilt
       on every OPEN (close/reopen counts as a first render again), but persists
       across re-renders — so this wiring never needs re-attaching.
       ---------------------------------------------------------------------- */
    _onFirstRender(context, options) {
        super._onFirstRender(context, options);

        // Instance state that must survive re-renders AND reopens (hence ??=).
        this._openGears ??= new Set();    // gear panels currently open (by sound id)
        this._filterQuery ??= "";         // current search query
        this._activeCollapsed ??= false;  // "Active Playback" collapsed to its header
        this._hadActive ??= false;        // for the one-time slide-in animation
        this._pendingVolumeEmits ??= {};  // trailing-throttle state per sound id
        // Volume fires very often while dragging -> debounce persistence; same
        // for writing the durable per-sound volume default.
        this._debouncedPersist ??= foundry.utils.debounce(() => persistActiveState(), 300);
        this._debouncedPersistConfig ??= foundry.utils.debounce((id, volume) => setSoundConfig(id, { volume }), 300);

        // Players need no listeners — the app should not be open for them at all.
        if (!game.user.isGM) return;
        const root = this.element;

        // Progress tick for the active rows: updates the time labels in place
        // (textContent only, never a render). Runs while the window is open;
        // _onClose clears it, so ??= re-creates it on the next open.
        this._progressTimer ??= setInterval(() => this._tickProgress(), 500);

        root.addEventListener('input', (ev) => {
            const t = ev.target;
            if (t.classList.contains('sb-search-input')) return this._applyFilter(t.value);
            if (t.classList.contains('sb-preset-volume')) {
                // Slider value is a position on the perceptual curve -> map to gain.
                this._debouncedPersistConfig(t.dataset.id, foundry.audio.AudioHelper.inputToVolume(t.value));
                return;
            }
            if (t.classList.contains('track-volume-slider')) {
                const id = t.dataset.id;
                // Perceptual curve: slider position -> real gain. Everything
                // downstream (instance gain, activeState, socket, per-sound
                // default) keeps working in gain.
                const volume = foundry.audio.AudioHelper.inputToVolume(t.value);
                const track = globalThis.soundbrett.activeSounds[id];
                if (!track || !track.soundInstance) return;
                track.soundInstance.volume = volume;
                track.volume = volume; // keep the intended volume in sync (persisted)
                this._throttledVolumeEmit(id, volume);
                this._debouncedPersist();
                // Feed the change back into the durable per-sound default.
                this._debouncedPersistConfig(id, volume);
            }
        });

        root.addEventListener('keydown', (ev) => {
            const t = ev.target;
            if (!(t instanceof HTMLElement)) return;
            if (t.classList.contains('sb-search-input')) {
                if (ev.key === 'Escape') { t.value = ''; this._applyFilter(''); }
                return;
            }
            if (t.classList.contains('sb-tag-add')) this._onTagAddKeydown(ev, t);
        });

        // Drag onto the macro hotbar -> see the hotbarDrop hook. The payload
        // mirrors what playSound/toggleSound expect (id, encoded path, name).
        root.addEventListener('dragstart', (ev) => {
            const node = ev.target instanceof HTMLElement ? ev.target.closest('.sb-sound-node') : null;
            if (!node) return;
            ev.dataTransfer.setData("text/plain", JSON.stringify({
                type: "soundbrett-sound",
                id: node.dataset.id,
                path: node.dataset.path,
                name: node.dataset.name
            }));
            ev.dataTransfer.effectAllowed = "copy";
        });
    }

    /* ----------------------------------------------------------------------
       Per-render state re-application, scoped to the parts that actually
       re-rendered (options.parts). No listener wiring happens here anymore —
       clicks are actions, everything else is delegated in _onFirstRender.
       ---------------------------------------------------------------------- */
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

        if (!game.user.isGM) return;
        const parts = options.parts ?? [];

        if (parts.includes("active")) {
            // Calm reveal: animate the "Active Playback" panel only when it FIRST
            // appears (empty -> non-empty), not on every re-render (pause/volume
            // keep re-rendering this part, which would re-trigger the slide).
            const activeContainer = appRoot.querySelector('.sb-active-container');
            const hasActiveNow = !!activeContainer && activeContainer.style.display !== 'none';
            if (hasActiveNow && !this._hadActive) activeContainer.classList.add('sb-active-enter');
            this._hadActive = hasActiveNow;
            this._applyActiveCollapsed();
        }

        if (parts.includes("library")) {
            this._refreshToggleAllIcon();
            // Re-open gear panels that were open before the re-render (all tiles
            // sharing the id — e.g. a sound in both its folder and Favorites).
            this._openGears.forEach(id => {
                appRoot.querySelectorAll(`.sb-sound-tile[data-id="${id}"] .sb-tile-settings`)
                    .forEach(panel => { panel.style.display = "flex"; });
            });
            // Re-apply a search query that survived the re-render.
            const searchInput = appRoot.querySelector('.sb-search-input');
            if (searchInput && this._filterQuery) {
                searchInput.value = this._filterQuery;
                this._applyFilter(this._filterQuery);
            }
        }
    }

    // Stop the progress tick with the window; the paired ??= in _onFirstRender
    // starts a fresh one on the next open.
    _onClose(options) {
        super._onClose(options);
        if (this._progressTimer) {
            clearInterval(this._progressTimer);
            this._progressTimer = null;
        }
    }

    /* ----------------------------------------------------------------------
       In-place DOM helpers (no render)
       ---------------------------------------------------------------------- */

    // Progress tick: refresh each active row's time label from the live track
    // state. Cheap by design — paused rows compute to the same string and are
    // skipped by the textContent comparison.
    _tickProgress() {
        if (!this.rendered) return;
        const activeSounds = globalThis.soundbrett.activeSounds;
        this.element?.querySelectorAll('.sb-active-row').forEach(row => {
            const track = activeSounds[row.dataset.id];
            const label = row.querySelector('.sb-track-time');
            if (!track || !label) return;
            const text = trackTimeLabel(track);
            if (label.textContent !== text) label.textContent = text;
        });
    }

    // Mirrors a sound's stored config onto its tile(s) in place — called by
    // setSoundConfig after every write, covering duplicate tiles of the same
    // sound (folder + Favorites group). Two things are kept in sync: (1) the
    // gear icon tint (favorite-star gold while gear-panel settings deviate
    // from the defaults, dropped again once the last one returns to default);
    // (2) the gear panel's preset controls (loop button, volume slider) — the
    // Active Playback write-back persists loop/volume via setSoundConfig
    // WITHOUT a library render, so an open panel would otherwise keep showing
    // stale presets. Idempotent for the panel's own handlers (they set the
    // same state before persisting).
    syncGearState(id) {
        if (!game.user?.isGM) return;
        const custom = hasCustomSoundConfig(id);
        const cfg = getSoundConfig(id);
        this.element?.querySelectorAll(`.sb-sound-tile[data-id="${id}"]`).forEach(tile => {
            tile.querySelector('.sb-tile-gear')?.classList.toggle('active', custom);
            tile.querySelector('.sb-preset-loop')?.classList.toggle('active', cfg.loop);
            const slider = tile.querySelector('.sb-preset-volume');
            if (slider) slider.value = foundry.audio.AudioHelper.volumeToInput(cfg.volume);
        });
    }

    // Syncs the tiles' playing indicator (accent border + glyph) with
    // activeSounds. Needed because play/stop/pause re-render ONLY the "active"
    // part (see refreshBoard) — the library part, where the tiles live, keeps
    // its DOM and must be updated in place.
    syncTileIndicators() {
        if (!game.user?.isGM) return;
        const activeSounds = globalThis.soundbrett.activeSounds;
        this.element?.querySelectorAll('.sb-sound-node').forEach(node => {
            const track = activeSounds[node.dataset.id];
            node.classList.toggle('sb-node-active', !!track);
            let icon = node.querySelector('.sb-playing-icon');
            if (!track) { icon?.remove(); return; }
            if (!icon) {
                icon = document.createElement('i');
                node.prepend(icon);
            }
            icon.className = `sb-playing-icon fas ${track.isPaused ? 'fa-pause' : 'fa-volume-high'}`;
        });
    }

    // Active panel collapse: hide just the track list (keep the header row) so a
    // long list can't fill the fixed zone and bury the library. State lives on
    // the instance (_activeCollapsed) so it survives the frequent re-renders.
    _applyActiveCollapsed() {
        const container = this.element?.querySelector('.sb-active-container');
        const list = container?.querySelector('.sb-active-list');
        const chevron = container?.querySelector('.sb-active-collapse');
        if (!list || !chevron) return;
        const collapsed = !!this._activeCollapsed;
        list.style.display = collapsed ? 'none' : '';
        // The track count in the header (.sb-active-count) shows only while
        // collapsed — the class gates its CSS display.
        container.classList.toggle('sb-collapsed', collapsed);
        chevron.classList.toggle('fa-chevron-right', collapsed);
        chevron.classList.toggle('fa-chevron-down', !collapsed);
    }

    // The volume SOCKET emit is throttled (trailing): at most one packet per id
    // per 100ms, always ending on the final value — players track the drag
    // near-live without dozens of broadcasts per second. (A debounce would go
    // silent for the whole drag; a throttle keeps updating.)
    _throttledVolumeEmit(id, volume) {
        const p = this._pendingVolumeEmits[id] ??= { timer: null, volume };
        p.volume = volume;
        if (p.timer) return;
        p.timer = setTimeout(() => {
            p.timer = null;
            game.socket.emit('module.soundbrett', { action: "volume", id, volume: p.volume });
        }, 100);
    }

    _anyFolderOpen() {
        return [...this.element.querySelectorAll('.sb-grid')].some(g => g.style.display !== 'none');
    }

    // State-based chevron: expanded folders -> down arrow, all collapsed -> up
    // arrow (per user preference; the arrow shows the current state).
    _refreshToggleAllIcon() {
        const icon = this.element?.querySelector('.sb-toggle-all i');
        if (icon) icon.className = this._anyFolderOpen()
            ? 'fas fa-angle-double-down' // something open (expanded)
            : 'fas fa-angle-double-up';  // all collapsed
    }

    // Expand/collapse ALL folders (incl. Favorites) at once. Same in-place DOM
    // toggle as a single header, but writes folderState only once.
    async _setAllFolders(collapsed) {
        const folderState = foundry.utils.deepClone(game.settings.get('soundbrett', 'folderState') ?? {});
        this.element.querySelectorAll('.sb-folder-header').forEach(header => {
            header.nextElementSibling.style.display = collapsed ? "none" : "grid";
            header.querySelector('.toggle-icon').className = collapsed
                ? "fas fa-chevron-right toggle-icon"
                : "fas fa-chevron-down toggle-icon";
            folderState[header.dataset.category] = collapsed;
        });
        await game.settings.set('soundbrett', 'folderState', folderState);
    }

    // Reads a tile's tag list (stored as JSON on the sound node).
    _tileTags(node) {
        try { return JSON.parse(node?.dataset.tags || '[]'); } catch (e) { return []; }
    }

    // Shows the given tags as read-only chips under a tile (or clears them).
    _setMatchChips(tile, hitTags) {
        const box = tile.querySelector('.sb-tile-match-tags');
        if (!box) return;
        if (!hitTags.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
        box.innerHTML = hitTags.map(t => `<span class="sb-tag-chip sb-tag-chip-static">#${escapeHtml(t)}</span>`).join('');
        box.style.display = 'flex';
    }

    // Search / filter: pure in-place DOM filter (no render, no folderState
    // write): tiles whose name doesn't match are hidden; folders with at least
    // one match show and auto-expand, folders with none hide entirely. Clearing
    // restores the remembered collapsed state. The query is kept on the app
    // instance so it survives a library re-render (favorite/rename) while
    // searching.
    _applyFilter(raw) {
        const rootElement = this.element;
        const q = (raw ?? '').trim().toLowerCase();
        this._filterQuery = q;
        const wrappers = rootElement.querySelectorAll('.sb-category-wrapper');
        const noResults = rootElement.querySelector('.sb-no-results');

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
                    this._setMatchChips(t, []); // hide match chips when not searching
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
                const tagHits = this._tileTags(node).filter(t => {
                    const tl = t.toLowerCase();
                    return terms.some(term => tl.includes(term));
                });
                const textHit = terms.some(term => name.includes(term) || file.includes(term));
                const hit = textHit || tagHits.length > 0;
                tile.style.display = hit ? '' : 'none';
                this._setMatchChips(tile, hit ? tagHits : []);
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
    }

    // Keeps a node's data-tags (JSON list) in sync after inline tag edits, so
    // the search filter sees changes without a render.
    _syncTileTags(row, tags) {
        const node = row.closest('.sb-sound-tile')?.querySelector('.sb-sound-node');
        if (node) node.dataset.tags = JSON.stringify(tags);
    }

    // Tag input inside the gear panel: Enter adds. Comma-separated input adds
    // each part as its own tag (so "blau, grün, rot" -> three tags). Split on
    // commas only — tags may contain spaces, so whitespace must not split.
    // Chips are added IN PLACE (their × carries data-action="removeTag").
    async _onTagAddKeydown(ev, input) {
        ev.stopPropagation();
        if (ev.key !== "Enter") return;
        ev.preventDefault();
        const row = input.closest('.sb-tags-row');
        const id = row?.dataset.id;
        if (!id) return;
        const parts = input.value.split(',').map(s => s.trim()).filter(Boolean);
        input.value = "";
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
            chip.innerHTML = `#${escapeHtml(part)} <i class="sb-tag-remove fas fa-times" data-action="removeTag" title="${escapeHtml(game.i18n.localize("SOUNDBRETT.RemoveTag"))}"></i>`;
            row.insertBefore(chip, input);
        }
        if (!added) return;
        await setSoundConfig(id, { tags });
        this._syncTileTags(row, tags);
    }

    /* ----------------------------------------------------------------------
       Action handlers (DEFAULT_OPTIONS.actions). Static per AppV2 convention,
       but invoked with `this` bound to the app instance; `target` is the
       [data-action] element (the innermost one — nested actions don't bubble
       into each other, e.g. preloadFavorites inside the folder header).
       ---------------------------------------------------------------------- */

    static #onCollapseActive() {
        this._activeCollapsed = !this._activeCollapsed;
        this._applyActiveCollapsed();
    }

    static #onStopAll() {
        stopAllSounds();
    }

    static #onTrackPause(event, target) {
        const id = target.dataset.id;
        const track = globalThis.soundbrett.activeSounds[id];
        if (!track || !track.soundInstance) return;

        const s = track.soundInstance;
        if (track.isPaused) {
            // play() resets volume/loop -> save first, restore afterwards
            const vol = s.volume;
            if (!s.playing && typeof s.play === "function") s.play();
            s.volume = vol;
            s.loop = track.isLooping;
            track.isPaused = false;
            // Shift the virtual start by the pause duration so elapsed
            // wall-clock time equals the playback position again
            // (position sync, see playFromState).
            track.startedAt = Date.now() - (track.pausedPosition ?? 0) * 1000;
            delete track.pausedPosition;
            game.socket.emit('module.soundbrett', { action: "resume", id });
        } else {
            // Remember WHERE we pause (persisted; restore/reconcile resume
            // there). Read the instance clock while it is still playing,
            // fall back to the virtual-start math.
            const pos = Number.isFinite(s.currentTime)
                ? s.currentTime
                : track.startedAt ? (Date.now() - track.startedAt) / 1000 : 0;
            track.pausedPosition = Math.max(0, pos);
            // safePause: a click within the STARTING window (right after
            // play) must defer the pause, not crash or skip it.
            safePause(s);
            track.isPaused = true;
            game.socket.emit('module.soundbrett', { action: "pause", id });
        }
        persistActiveState();
        refreshBoard(); // re-renders the active part + syncs the tile glyph
    }

    static #onTrackLoop(event, target) {
        const id = target.dataset.id;
        const track = globalThis.soundbrett.activeSounds[id];
        if (!track || !track.soundInstance) return;
        track.isLooping = !track.isLooping;
        track.soundInstance.loop = track.isLooping;
        game.socket.emit('module.soundbrett', { action: "loop", id, loop: track.isLooping });
        // Feed the change back into the durable per-sound default.
        setSoundConfig(id, { loop: track.isLooping });
        persistActiveState();
        refreshBoard();
    }

    static #onTrackStop(event, target) {
        stopSound(target.dataset.id);
    }

    static #onToggleFolder(event, target) {
        const content = target.nextElementSibling;
        const icon = target.querySelector('.toggle-icon');
        // Visible (display !== "none") -> will be collapsed now
        const willCollapse = content.style.display !== "none";
        content.style.display = willCollapse ? "none" : "grid";
        icon.className = willCollapse
            ? "fas fa-chevron-right toggle-icon"
            : "fas fa-chevron-down toggle-icon";

        // Remember the state per user so it survives re-renders and reloads
        const folderState = foundry.utils.deepClone(game.settings.get('soundbrett', 'folderState') ?? {});
        folderState[target.dataset.category] = willCollapse;
        game.settings.set('soundbrett', 'folderState', folderState);
        this._refreshToggleAllIcon();
    }

    static async #onToggleAllFolders() {
        // Collapse all if anything is open, otherwise expand all.
        await this._setAllFolders(this._anyFolderOpen());
        this._refreshToggleAllIcon();
    }

    // Rescan the sound folder on demand: the folder scan is cached (see
    // _prepareContext), so new/removed files only show up after this.
    static #onRefreshLibrary() {
        this._libraryCache = null;
        this.render({ parts: ["library"] });
    }

    // Preload ALL favorites at once: warm every tile in the Favorites group's
    // grid (reuses the per-sound preloadSound). Shows a spinner while the GM's
    // own loads run, then a check (all ok) or warning (any failed).
    static async #onPreloadFavorites(event, target) {
        event.preventDefault();
        const icon = target;
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
    }

    // Board-wide routing default: a click on the toolbar chip opens the unified
    // routing picker. Does NOT affect already running tracks and does NOT
    // re-render; only the label + tooltip update in place.
    static async #onRouteBoard() {
        const result = await promptRouting({ current: getBoardRouting(), allowInherit: false });
        if (!result) return; // cancelled -> keep previous
        await game.settings.set('soundbrett', 'routingDefault', result.v ?? { mode: 'all' });
        const r = getBoardRouting();
        const label = this.element?.querySelector('.sb-routing-label');
        const btn = this.element?.querySelector('.sb-routing-text');
        if (label) label.textContent = routingLabel(r);
        if (btn) btn.title = routingPlayerNames(r) || game.i18n.localize("SOUNDBRETT.RoutingTargetHint");
    }

    // Click (re)starts the sound with its persisted per-sound defaults.
    static #onPlayTile(event, target) {
        event.preventDefault();
        playSound({ id: target.dataset.id, path: target.dataset.path, name: target.dataset.name });
    }

    // Favorite toggle: flip the icon immediately for feedback, persist, then
    // re-render the library so the synthetic "Favorites" group gains/loses
    // this sound (the active part is unaffected by favorites).
    static async #onToggleFavorite(event, target) {
        event.preventDefault();
        const id = target.dataset.id;
        const isFavorite = !target.classList.contains('active');
        target.classList.toggle('active', isFavorite);
        await setSoundConfig(id, { favorite: isFavorite });
        this.render({ parts: ["library"] });
    }

    // Gear: toggle the per-tile settings panel (loop + rename + preload +
    // volume + routing + tags). The open state is tracked per sound id on the
    // instance so it SURVIVES a library re-render.
    static #onToggleGear(event, target) {
        event.preventDefault();
        const tile = target.closest('.sb-sound-tile');
        const id = tile?.dataset.id;
        const panel = tile?.querySelector('.sb-tile-settings');
        if (!panel || !id) return;
        const open = panel.style.display === "none";
        panel.style.display = open ? "flex" : "none";
        if (open) this._openGears.add(id); else this._openGears.delete(id);
    }

    // Loop pre-set: persist the default for the NEXT start (does not touch a
    // currently playing instance — that is what the Active Playback loop is for).
    static #onPresetLoop(event, target) {
        event.preventDefault();
        const loop = !target.classList.contains('active');
        target.classList.toggle('active', loop);
        setSoundConfig(target.dataset.id, { loop });
    }

    // Rename: open a small dialog to set a custom display name. Empty input
    // (or the file name itself) clears the override, reverting to the file name.
    // Persisting changes structure (Favorites order, search index) -> re-render
    // the library part.
    static async #onRenameSound(event, target) {
        event.preventDefault();
        const node = target.closest('.sb-sound-tile')?.querySelector('.sb-sound-node');
        if (!node) return;
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
        this.render({ parts: ["library"] });
    }

    // Per-sound reset (the rotate-left button in the gear panel): clears THIS
    // sound's gear-panel settings — volume, loop, custom name, tags, routing —
    // back to the defaults, without touching any other sound. The favorite
    // flag deliberately stays: it belongs to the star, not the gear (matching
    // the gear-tint logic). Confirmation first, since name and tags hang on
    // it. setSoundConfig's lean-pruning then drops the store entry entirely
    // (or down to the favorite flag) — the gear goes gray again. Name/tags may
    // change structure (Favorites order, search index) -> library re-render.
    static async #onResetSound(event, target) {
        event.preventDefault();
        const id = target.dataset.id;
        const node = target.closest('.sb-sound-tile')?.querySelector('.sb-sound-node');
        if (!id || !node) return;
        let ok;
        try {
            ok = await foundry.applications.api.DialogV2.confirm({
                window: { title: game.i18n.localize("SOUNDBRETT.ResetSoundTitle") },
                content: `<p>${escapeHtml(game.i18n.format("SOUNDBRETT.ResetSoundContent", { name: node.dataset.name }))}</p>`,
                rejectClose: false
            });
        } catch (e) { return; } // dialog dismissed
        if (!ok) return;
        await setSoundConfig(id, {
            volume: DEFAULT_SOUND_CONFIG.volume,
            loop: DEFAULT_SOUND_CONFIG.loop,
            name: "", tags: [], routing: null
        });
        this.render({ parts: ["library"] });
    }

    // Preload: warm the buffer at all players (and locally) so the next start
    // is instant and in sync. The button shows a spinner while the GM's own
    // load runs and a check/warning afterwards (a proxy — players differ).
    static async #onPreloadTile(event, target) {
        event.preventDefault();
        if (target.disabled) return;
        const node = target.closest('.sb-sound-tile')?.querySelector('.sb-sound-node');
        if (!node) return;
        const icon = target.querySelector('i');
        const restore = icon.className;
        icon.className = 'fas fa-spinner fa-spin';
        target.disabled = true;
        const ok = await preloadSound({ path: node.dataset.path, name: node.dataset.name });
        icon.className = ok ? 'fas fa-check' : 'fas fa-triangle-exclamation';
        setTimeout(() => { icon.className = restore; target.disabled = false; }, 1500);
    }

    // Per-sound routing override: the clickable text opens the unified picker
    // (incl. "Default (board)" = inherit). Persists into soundSettings.routing
    // (null = inherit). Updates label + tooltip IN PLACE, no re-render.
    static async #onRouteSound(event, target) {
        event.preventDefault();
        const row = target.closest('.sb-route-row');
        const id = row?.dataset.id;
        if (!id) return;
        const result = await promptRouting({ current: getSoundConfig(id).routing, allowInherit: true });
        if (!result) return; // cancelled -> keep previous
        await setSoundConfig(id, { routing: result.v });
        const cfg = getSoundConfig(id);
        const label = row.querySelector('.sb-route-label');
        if (label) label.textContent = cfg.routing
            ? routingLabel(cfg.routing)
            : game.i18n.localize("SOUNDBRETT.RoutingInherit");
        target.title = (cfg.routing ? routingPlayerNames(cfg.routing) : "")
            || game.i18n.localize("SOUNDBRETT.RoutingTargetHint");
    }

    // Remove a tag chip (the × inside it; also on chips added in place).
    static async #onRemoveTag(event, target) {
        event.preventDefault();
        const chip = target.closest('.sb-tag-chip');
        const row = target.closest('.sb-tags-row');
        const id = row?.dataset.id;
        if (!chip || !id) return;
        const tag = chip.dataset.tag;
        const tags = getSoundConfig(id).tags.filter(t => t.toLowerCase() !== tag.toLowerCase());
        await setSoundConfig(id, { tags });
        chip.remove();
        this._syncTileTags(row, tags);
    }

}
