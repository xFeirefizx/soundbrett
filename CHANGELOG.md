# Changelog

Notable user-facing changes per release. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/).

## [1.1.0] — 2026-07-16

### Added
- **Playback position sync** — players who join late or reload drop into a
  running track at the correct position instead of starting at 0; paused
  tracks resume exactly where they were paused, even across reloads.
- **Progress display** — each row under "Active Playback" shows a live
  elapsed / total time ("1:23 / 3:45").
- **Playing indicator on tiles** — a sound's library tile is highlighted while
  it plays (icon shows the paused state too).
- **Gear icon highlight** — the gear on a tile turns gold while the sound has
  custom settings, and grays out once everything is back at the defaults.
- **Reset options** — a button in the module settings resets ALL per-sound
  settings (with confirmation); a new button inside each tile's gear panel
  resets just that one sound (the favorite star stays).
- **Refresh button** — the sound folder is now scanned once and cached; use
  the toolbar refresh button to pick up new or removed files. Settings of
  files that no longer exist are cleaned up automatically.
- **Track counter** — the collapsed "Active Playback" header shows how many
  tracks are running.

### Changed
- **Perceptual volume sliders** — both volume sliders now follow Foundry's
  loudness curve (like the core playlist sliders), giving much finer control
  at the quiet end.
- **Calmer UI** — playback actions no longer rebuild the sound library:
  open gear panels, the search filter and scroll positions all stay put while
  you play, pause and stop sounds.
- The window now uses Foundry's ApplicationV2 framework and inherits the
  native window chrome (and the active system's, e.g. WFRP4e).

### Fixed
- Players no longer miss sounds when the GM pauses a track immediately after
  starting it.
- Preloaded (instantly starting) sounds no longer end up silent at the
  players.
- Finished one-shot sounds no longer restart at the players when the GM
  starts another sound, and no longer linger in "Active Playback" after a
  reload.
- The WFRP4e system's window styling no longer leaks into the neutral and
  arcane themes (ornate frame, leather header).
- Tooltips of the playback controls are now localized.
- The slide-in animation respects the OS "reduced motion" preference.

## [1.0.0] — 2026-06-03

Initial release: folder-based sound library with categories, synchronized
playback for all players (play, pause/resume, stop, loop, volume), shared
state across reloads, per-sound settings (favorites, volume, loop, custom
names, tags), search, selective routing ("who hears this?"), player-side
preloading, hotbar drag & drop, and switchable themes (neutral, arcane,
WFRP) with English and German localization.
