import St from "gi://St";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Clutter from "gi://Clutter";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Slider } from "resource:///org/gnome/shell/ui/slider.js";

import { guard } from "./util.js";
import { MediaGrouping } from "./mediaGroup.js";

const POLL_INTERVAL_MS = 1000;

// When a track turns up unseekable (no length yet, or CanSeek still false) we
// re-read the player's properties instead of waiting for it to announce them.
// Bounded, so a genuinely lengthless stream (internet radio) settles into an
// inert bar rather than polling the bus forever.
const SEEK_RETRY_MS = 1000;
const SEEK_RETRY_MAX = 8;

function formatTime(microseconds) {
  if (!microseconds || microseconds < 0) return "0:00";
  const totalSeconds = Math.floor(microseconds / 1_000_000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const minuteText = hours
    ? minutes.toString().padStart(2, "0")
    : minutes.toString();
  const time = `${minuteText}:${seconds.toString().padStart(2, "0")}`;
  return hours ? `${hours}:${time}` : time;
}

const LOOP_ORDER = ["None", "Track", "Playlist"];

/**
 * Enhances GNOME's native MPRIS media notifications in place, both in the
 * date-menu message list and on the lock screen rather than replacing them.
 * Adds shuffle + loop buttons and a draggable seek bar, driven by our
 * MprisManager (which exposes the MPRIS properties the native message doesn't).
 *
 * Following the technique used by the media-progress extension: switch the
 * target between `messageView` (user mode) and the lock-screen
 * `screenShield._dialog._notificationsBox` (unlock-dialog mode) on session
 * changes, and decorate each native MediaMessage found there.
 */
export class MediaEnhancer {
  constructor(mprisManager, preferences) {
    this._manager = mprisManager;
    this._preferences = preferences;
    this._enhanced = new Map(); // MediaMessage -> { busName, controls..., signals }
    this._source = null; // current Mpris.MprisSource being watched
    this._sessionId = 0;
    this._pollId = 0;
    this._scanId = 0;
    this._lockRetryId = 0;
    this._childAddedId = 0;
    this._lockBox = null;
    this._grouping = null;

    this._coverDir = null;

    this._sessionId = Main.sessionMode.connect("updated", () =>
      this._onSessionModeChanged(),
    );
    // When our MprisManager first learns about a player it may be slightly
    // behind the shell's own MprisSource, so a native message can appear
    // before getPlayer() can resolve it. Re-scan on manager changes so such
    // a message gets decorated promptly instead of waiting for the next
    // unrelated event (which is what made the seek bar take ~a second).
    this._manager.connectObject(
      "players-changed",
      () => this._scheduleScan(),
      this,
    );
    this._onSessionModeChanged();
  }

  // --- target selection (date menu vs lock screen) ---------------------

  _onSessionModeChanged() {
    try {
      this._detach();
      const mode = Main.sessionMode.currentMode;
      const parent = Main.sessionMode.parentMode;
      if (mode === "user" || parent === "user") this._attachUser();
      else if (mode === "unlock-dialog") this._attachLockScreen();
    } catch (e) {
      logError(e, "ImprovedMediaControls: session mode handling failed");
    }
  }

  _attachUser() {
    const messageView =
      Main.panel.statusArea.dateMenu?._messageList?._messageView;
    if (!messageView || !messageView._mediaSource) return;
    this._source = messageView._mediaSource;
    // Fold every player into one stacked group, the way the shell already
    // stacks notifications, instead of one full-height card per player.
    this._grouping = new MediaGrouping(messageView);
    this._grouping.connectObject(
      "messages-changed",
      () => this._scheduleScan(),
      this,
    );
    this._messagesProvider = () => this._grouping.messages;
    this._wireSource();
  }

  _attachLockScreen(retries = 12) {
    // The unlock dialog (and its notifications box) is built lazily after the
    // session switches to 'unlock-dialog', so retry until it appears.
    const notifBox = Main.screenShield?._dialog?._notificationsBox;
    if (!notifBox || !notifBox._mediaSource) {
      if (retries > 0 && Main.sessionMode.currentMode === "unlock-dialog") {
        this._lockRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
          this._lockRetryId = 0;
          guard(
            () => this._attachLockScreen(retries - 1),
            "lock attach failed",
          );
          return GLib.SOURCE_REMOVE;
        });
      }
      return;
    }
    this._source = notifBox._mediaSource;
    // Lock-screen messages live as children of _notificationBox; they are
    // added slightly late, so also rescan when children appear.
    const box = notifBox._notificationBox;
    this._lockBox = box;
    this._messagesProvider = () =>
      box
        ? box
            .get_children()
            .map((c) => c._delegate ?? c)
            .filter((m) => m && m._player)
        : [];
    if (box) {
      this._childAddedId = box.connect("child-added", () =>
        this._scheduleScan(),
      );
    }
    this._wireSource();
  }

  _wireSource() {
    this._source.connectObject(
      "player-added",
      () => this._scheduleScan(),
      "player-removed",
      () => this._scheduleScan(),
      this,
    );
    guard(() => this._scan(), "initial scan failed");
  }

  // --- (un)decorating ---------------------------------------------------

  _scheduleScan() {
    if (this._scanId) return;
    this._scanId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
      this._scanId = 0;
      guard(() => this._scan(), "scan failed");
      return GLib.SOURCE_REMOVE;
    });
  }

  _scan() {
    if (!this._messagesProvider) return;
    // Re-entrancy guard: our own actor manipulations can emit signals that
    // loop back here; without this a synchronous re-entry would recurse until
    // the stack overflows (an UNCATCHABLE exception that aborts the shell).
    if (this._scanning) return;
    this._scanning = true;
    try {
      this._scanLocked();
    } finally {
      this._scanning = false;
    }
  }

  _scanLocked() {
    const messages = this._messagesProvider();

    // Drop tracking for messages that disappeared.
    for (const message of [...this._enhanced.keys()]) {
      if (!messages.includes(message))
        guard(() => this._undecorate(message), "undecorate failed");
    }

    // Decorate each new message in isolation: a structural surprise in one
    // must never take down the scan (and with it the shell).
    for (const message of messages) {
      if (message && message._player && !this._enhanced.has(message))
        guard(() => this._decorate(message), "decorate failed");
    }

    guard(() => this._refresh(), "refresh failed");
    this._syncPolling();
  }

  /** Re-render every tracked message. */
  _refresh() {
    // Same re-entrancy guard rationale as _scan(): a callback fired by our
    // own updates must not recurse back into a running refresh.
    if (this._refreshing) return;
    this._refreshing = true;
    try {
      this._refreshLocked();
    } finally {
      this._refreshing = false;
    }
  }

  _refreshLocked() {
    // Every player renders full-size; GNOME stacks the messages itself.
    for (const message of this._enhanced.keys())
      guard(() => this._update(message), "update failed");
  }

  _decorate(message) {
    const busName = message._player?._busName;
    if (!busName) return;

    const player = this._manager.getPlayer(busName);
    if (!player) return; // our manager hasn't seen it yet; a later scan will catch it

    // Native layout sanity: bail (a no-op) rather than throw if the message
    // structure isn't what we expect (e.g. a future shell, or mid-teardown).
    const body = message.get_child();
    if (!message._mediaControls || !body) return;

    const mediaControls = message._mediaControls;
    const hbox = mediaControls.get_parent(); // the .message-box row
    const entry = { busName, player, message, signals: [] };

    // Cover: the native St.Icon doesn't clip album art to a radius, so hide it
    // and draw our own rounded background-image bin in its place.
    const nativeIcon = message._icon;
    if (nativeIcon && hbox) {
      entry.nativeIcon = nativeIcon;
      entry.nativeIconWasVisible = nativeIcon.visible;
      const iconIndex = hbox.get_children().indexOf(nativeIcon);
      nativeIcon.visible = false;
      // The native `set icon` setter re-shows the icon on every metadata
      // update (e.g. track skip), so keep forcing it hidden.
      const visId = nativeIcon.connect("notify::visible", () => {
        if (nativeIcon.visible) nativeIcon.visible = false;
      });
      entry.signals.push([nativeIcon, visId]);
      entry.cover = new St.Bin({
        style_class: "mci-cover",
        y_align: Clutter.ActorAlign.CENTER,
      });
      hbox.insert_child_at_index(entry.cover, iconIndex >= 0 ? iconIndex : 0);
    }

    // Vertically center the title/artist next to the (taller) cover.
    const contentBox = hbox
      ?.get_children()
      .find((c) => (c.style_class || "").includes("message-content"));
    if (contentBox) {
      entry.contentBox = contentBox;
      entry.contentOrigYAlign = contentBox.y_align;
      entry.contentOrigYExpand = contentBox.y_expand;
      contentBox.y_align = Clutter.ActorAlign.CENTER;
      contentBox.y_expand = true;
    }

    // Capture the native transport buttons so we can rearrange and restore.
    const playPause = message._playPauseButton;
    const prevBtn = message._prevButton;
    const nextBtn = message._nextButton;

    entry.mediaControls = mediaControls;
    entry.mcOrigChildren = mediaControls.get_children();
    entry.mcWasVisible = mediaControls.visible;

    // Right column: the transport row on top, the combined "0:10 / 2:00" time
    // below it,putting the time on the artist's line, right-aligned, off the
    // seek bar's sides (which felt cramped). The transport row always holds
    // play/pause, and takes prev/next back whenever the extra controls are
    // collapsed (see _applyExpansion). Play/pause is kept the same size as the
    // other transport buttons.
    entry.rightCol = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      style_class: "mci-right-col",
      x_align: Clutter.ActorAlign.END,
      y_align: Clutter.ActorAlign.CENTER,
    });
    entry.transportRow = new St.BoxLayout({
      style_class: "mci-transport-row",
      x_align: Clutter.ActorAlign.END,
      y_align: Clutter.ActorAlign.CENTER,
    });
    entry.rightCol.add_child(entry.transportRow);
    if (playPause) {
      entry.playPause = playPause;
      entry.ppOrigXAlign = playPause.x_align;
      entry.ppOrigYAlign = playPause.y_align;
      playPause.get_parent()?.remove_child(playPause);
      playPause.add_style_class_name("mci-playpause");
      playPause.x_align = Clutter.ActorAlign.END;
      playPause.y_align = Clutter.ActorAlign.CENTER;
      entry.transportRow.add_child(playPause);
    }
    entry.timeLabel = new St.Label({
      style_class: "mci-time-combined",
      text: "0:00 / 0:00",
      x_align: Clutter.ActorAlign.END,
      y_align: Clutter.ActorAlign.CENTER,
    });
    entry.rightCol.add_child(entry.timeLabel);
    if (hbox) hbox.add_child(entry.rightCol);

    // The seek/controls row: prev · --slider-- · next · loop · shuffle.
    entry.shuffleBtn = this._makeControlButton(
      "media-playlist-shuffle-symbolic",
      () => this._toggleShuffle(player),
    );
    entry.loopBtn = this._makeControlButton(
      "media-playlist-repeat-symbolic",
      () => this._cycleLoop(player),
    );

    entry.slider = this._makeSeekSlider(player, entry);

    entry.prevBtn = prevBtn;
    entry.nextBtn = nextBtn;
    prevBtn?.get_parent()?.remove_child(prevBtn);
    nextBtn?.get_parent()?.remove_child(nextBtn);
    mediaControls.visible = false; // now empty

    const bar = new St.BoxLayout({ style_class: "mci-bar", x_expand: true });
    bar.add_child(entry.slider);
    bar.add_child(entry.loopBtn);
    bar.add_child(entry.shuffleBtn);
    entry.bar = bar;
    entry.bottom = bar;
    // Park the extra controls in the message's own action area: that is what
    // the native expand chevron shows and hides (and animates), so we get the
    // collapse toggle without inventing a second button for it.
    message.setActionArea(bar);

    // 'unexpanded' fires *before* the message flips its own `expanded` flag
    // (it does that in the animation's onComplete), so pass the target state
    // rather than reading it back.
    entry.signals.push([
      message,
      message.connect("expanded", () =>
        guard(() => this._applyExpansion(message, true), "expand failed"),
      ),
    ]);
    entry.signals.push([
      message,
      message.connect("unexpanded", () =>
        guard(() => this._applyExpansion(message, false), "unexpand failed"),
      ),
    ]);
    // The poll below only refreshes *mapped* messages, once a second. Without
    // this the first frame after the date menu opens shows the position from
    // whenever it was last closed, frozen until the next tick catches up.
    entry.signals.push([
      message,
      message.connect("notify::mapped", () =>
        guard(() => {
          if (!message.mapped) return;
          entry._posSeeded = null;
          this._update(message);
        }, "map refresh failed"),
      ),
    ]);

    // Re-render this player's controls on any property/track change.
    entry.signals.push([
      player,
      player.connect("changed", () =>
        guard(() => this._update(message), "update (changed) failed"),
      ),
    ]);
    // `true` => the native message itself is being destroyed by the shell, so
    // everything inside it (incl. the reparented controls) dies with it.
    entry.destroyId = message.connect("destroy", () =>
      guard(
        () => this._undecorate(message, true),
        "undecorate (destroy) failed",
      ),
    );

    this._enhanced.set(message, entry);
    this._applyExpansion(message, true);
    message.expand(false);
    this._refresh();
  }

  /**
   * Move prev/next between the seek bar (extra controls shown) and the
   * transport row next to play/pause (extra controls hidden), and show the
   * elapsed/total time only while the seek bar it belongs to is visible.
   */
  _applyExpansion(message, expanded) {
    const entry = this._enhanced.get(message);
    if (!entry) return; // teardown already started
    entry.controlsExpanded = expanded;

    const { prevBtn, nextBtn, bar, transportRow, timeLabel } = entry;
    prevBtn?.get_parent()?.remove_child(prevBtn);
    nextBtn?.get_parent()?.remove_child(nextBtn);

    if (expanded) {
      // prev · --slider-- · next · loop · shuffle
      if (prevBtn) bar.insert_child_at_index(prevBtn, 0);
      if (nextBtn) bar.insert_child_at_index(nextBtn, prevBtn ? 2 : 1);
    } else {
      // prev · play · next, back up on the title row
      if (prevBtn) transportRow.insert_child_at_index(prevBtn, 0);
      if (nextBtn) transportRow.add_child(nextBtn);
    }

    if (timeLabel) timeLabel.visible = expanded;
  }

  _undecorate(message, fromDestroy = false) {
    const entry = this._enhanced.get(message);
    if (!entry) return;
    // Delete from the map BEFORE destroying actors: every async/timer guard
    // relies on `_enhanced.get(message)` returning null once teardown starts.
    this._enhanced.delete(message);

    // Drop the pending cover retry and the temp art file (safe regardless of
    // whether the message itself is being torn down).
    if (entry._coverRetryId) {
      GLib.source_remove(entry._coverRetryId);
      entry._coverRetryId = 0;
    }
    this._cancelSeekRetry(entry);
    this._removeCoverTmp(entry);

    // The player outlives the message, so always drop its signal.
    for (const [obj, id] of entry.signals) {
      try {
        obj.disconnect(id);
      } catch (_) {}
    }

    if (fromDestroy) {
      // The message and every actor we injected/reparented into it are being
      // torn down by Clutter; touching them now risks assertions. Just stop.
      return;
    }

    if (entry.destroyId) {
      try {
        message.disconnect(entry.destroyId);
      } catch (_) {}
    }

    // Message stays alive (our disable / session switch / player went idle):
    // undo our buttons and rebuild the native transport row.
    entry.shuffleBtn?.destroy();
    entry.loopBtn?.destroy();

    // Give the action area back and undo the expansion we forced on the
    // message, so the chevron stops offering to open an area we no longer own.
    try {
      message.setActionArea(null);
      message.expanded = false;
      message._header.expandButton.rotation_angle_z = 0;
    } catch (_) {}

    // Reset play/pause styling (it gets re-added to mc below).
    if (entry.playPause) {
      entry.playPause.remove_style_class_name("mci-playpause");
      entry.playPause.x_align = entry.ppOrigXAlign;
      entry.playPause.y_align = entry.ppOrigYAlign;
    }

    // Rebuild the native control row from its original children (this also
    // pulls prev/next out of our bar and play/pause out of the title row).
    const mc = entry.mediaControls;
    if (mc && entry.mcOrigChildren) {
      for (const btn of entry.mcOrigChildren) {
        try {
          btn.get_parent()?.remove_child(btn);
          mc.add_child(btn);
        } catch (_) {}
      }
      mc.visible = entry.mcWasVisible;
    }

    // Restore the native cover and content alignment.
    entry.cover?.destroy();
    if (entry.nativeIcon) entry.nativeIcon.visible = entry.nativeIconWasVisible;
    if (entry.contentBox) {
      entry.contentBox.y_align = entry.contentOrigYAlign;
      entry.contentBox.y_expand = entry.contentOrigYExpand;
    }

    // The right column held play/pause (already pulled back to mc above) and
    // the time label; drop what's left.
    entry.rightCol?.destroy();
    entry.bottom?.destroy();
  }

  // --- widgets ----------------------------------------------------------

  _makeControlButton(iconName, onClick) {
    const btn = new St.Button({
      style_class: "message-media-control mci-extra-control",
      can_focus: true,
      child: new St.Icon({ icon_name: iconName }),
    });
    btn.connect("clicked", onClick);
    return btn;
  }

  _makeSeekSlider(player, entry) {
    const slider = new Slider(0);
    slider.x_expand = true;
    slider.y_align = Clutter.ActorAlign.CENTER;
    slider.add_style_class_name("mci-seek-slider");
    slider._mciDragging = false;
    slider.connect("drag-begin", () => {
      slider._mciDragging = true;
    });
    slider.connect("drag-end", () => {
      slider._mciDragging = false;
      // The player won't report the new position for a moment (and GSConnect-
      // style sources not for many seconds); drop the anchor so we resync to
      // whatever it reports next instead of extrapolating from before the drag.
      entry._posAnchor = null;
      const state = player.getState();
      if (state && state.length)
        player.setPosition(Math.floor(slider.value * state.length));
    });
    return slider;
  }

  // --- control verbs ----------------------------------------------------

  _toggleShuffle(player) {
    const s = player.getState();
    if (!s || s.shuffle === null || !s.canControl) return;
    player.setShuffle(!s.shuffle);
  }

  _cycleLoop(player) {
    const s = player.getState();
    if (!s || s.loopStatus === null || !s.canControl) return;
    const idx = LOOP_ORDER.indexOf(s.loopStatus);
    player.setLoopStatus(
      LOOP_ORDER[(idx >= 0 ? idx + 1 : 1) % LOOP_ORDER.length],
    );
  }

  // --- updates ----------------------------------------------------------

  _updateCover(entry) {
    if (!entry.cover) return;
    const s = entry.player.getState();
    const artUrl = s?.artUrl || "";
    const trackId = s?.trackId || "";
    // Refresh when the art URL changes OR the track changes. Some players -
    // browsers especially - reuse a single art file path and rewrite its
    // contents on every track, so the URL alone never signals staleness.
    if (artUrl === entry._coverUrl && trackId === entry._coverTrackId) return;
    entry._coverUrl = artUrl;
    entry._coverTrackId = trackId;

    if (artUrl.startsWith("file://")) {
      if (this._applyFileCover(entry, artUrl)) return;
      // The path was announced but the file isn't readable yet (the player
      // often writes the art a beat after publishing the metadata). Show the
      // fallback for now and retry shortly to pick up the real art.
      this._scheduleCoverRetry(entry);
    }

    this._applyFallbackCover(entry);
  }

  _applyFileCover(entry, artUrl) {
    let path;
    try {
      path = GLib.uri_unescape_string(artUrl.substring("file://".length), null);
    } catch (_) {
      return false;
    }
    if (!path) return false;

    let bytes;
    try {
      const [ok, data] = Gio.File.new_for_path(path).load_contents(null);
      if (!ok || !data || !data.length) return false;
      bytes = data;
    } catch (_) {
      return false;
    }

    // Copy the art to a fresh, unique path. St's texture cache keys on the
    // file URI with no awareness of content/mtime, so reusing a path would
    // hand us the previous track's cached texture. A new path forces a fresh
    // decode of the bytes we just read.
    const dir = this._coverTmpDir();
    if (!dir) return false;
    const seq = (entry._coverSeq = (entry._coverSeq || 0) + 1);
    const ext = (
      path.match(/\.(png|jpe?g|webp|gif|bmp)$/i)?.[1] || "img"
    ).toLowerCase();
    const safeBus = entry.busName.replace(/[^a-zA-Z0-9]/g, "_");
    const outPath = `${dir}/${safeBus}-${seq}.${ext}`;
    try {
      if (!GLib.file_set_contents(outPath, bytes)) return false;
    } catch (_) {
      return false;
    }

    this._removeCoverTmp(entry);
    entry._coverTmpPath = outPath;
    const safe = outPath.replace(/"/g, '\\"');
    entry.cover.set_child(null);
    entry.cover.style = `background-image: url("${safe}");`;
    return true;
  }

  _applyFallbackCover(entry) {
    this._removeCoverTmp(entry);
    entry.cover.style = "";
    if (!entry.coverFallback) {
      entry.coverFallback = new St.Icon({
        icon_name: "audio-x-generic-symbolic",
        icon_size: 28,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });
    }
    if (entry.cover.get_child() !== entry.coverFallback)
      entry.cover.set_child(entry.coverFallback);
  }

  _scheduleCoverRetry(entry) {
    if (entry._coverRetryId) return;
    entry._coverRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
      entry._coverRetryId = 0;
      guard(() => {
        if (this._enhanced.get(entry.message) !== entry) return;
        // Force re-evaluation; the file may have been written by now.
        entry._coverUrl = null;
        entry._coverTrackId = null;
        this._updateCover(entry);
      }, "cover retry failed");
      return GLib.SOURCE_REMOVE;
    });
  }

  _scheduleSeekRetry(entry) {
    if (entry._seekRetryId) return;
    if ((entry._seekRetries || 0) >= SEEK_RETRY_MAX) return;
    entry._seekRetryId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      SEEK_RETRY_MS,
      () => {
        entry._seekRetryId = 0;
        guard(() => {
          if (this._enhanced.get(entry.message) !== entry) return;
          entry._seekRetries = (entry._seekRetries || 0) + 1;
          // If this turns anything up, 'changed' fires and _update re-runs;
          // on success it cancels the re-arm queued below.
          entry.player.refreshProperties();
          this._scheduleSeekRetry(entry);
        }, "seek retry failed");
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _cancelSeekRetry(entry) {
    if (entry._seekRetryId) {
      GLib.source_remove(entry._seekRetryId);
      entry._seekRetryId = 0;
    }
    entry._seekRetries = 0;
  }

  _coverTmpDir() {
    if (this._coverDir) return this._coverDir;
    const dir = `${GLib.get_tmp_dir()}/improved-media-controls-covers`;
    try {
      if (GLib.mkdir_with_parents(dir, 0o700) !== 0) return null;
      this._coverDir = dir;
    } catch (_) {
      return null;
    }
    return this._coverDir;
  }

  _removeCoverTmp(entry) {
    if (!entry._coverTmpPath) return;
    try {
      Gio.File.new_for_path(entry._coverTmpPath).delete(null);
    } catch (_) {}
    entry._coverTmpPath = null;
  }

  _update(message) {
    const entry = this._enhanced.get(message);
    if (!entry) return;
    const s = entry.player.getState();
    if (!s) return;

    this._updateCover(entry);

    const shuffleAvail = s.shuffle !== null && s.canControl;
    entry.shuffleBtn.visible = shuffleAvail;
    this._setActive(entry.shuffleBtn, shuffleAvail && s.shuffle);

    const loopAvail = s.loopStatus !== null && s.canControl;
    entry.loopBtn.visible = loopAvail;
    entry.loopBtn.child.icon_name =
      s.loopStatus === "Track"
        ? "media-playlist-repeat-song-symbolic"
        : "media-playlist-repeat-symbolic";
    this._setActive(entry.loopBtn, loopAvail && s.loopStatus !== "None");

    // Some players (Firefox/Zen) briefly report length 0 - e.g. right after a
    // SetPosition - which would make the bar flap. Cache the last known length
    // for the current track and use that.
    if (s.trackId !== entry._trackId) {
      entry._trackId = s.trackId;
      entry._length = 0;
      entry._posAnchor = null;
      // New track: give it a fresh retry budget for the length lookup below.
      this._cancelSeekRetry(entry);
    }
    if (s.length > 0) entry._length = s.length;
    const len = entry._length;

    // Keep the seek bar present even when the length is unknown - e.g. for a
    // moment right after a track skip, or for live/unseekable streams. Hiding
    // it made the bar collapse and flap on every skip. Instead show an inert,
    // dimmed bar that holds its place.
    const hasLength = len > 0;
    // No track id required: Seek() moves the playhead without one, and
    // MprisPlayer.setPosition falls back to it. Players that genuinely can't
    // seek (GSConnect's phone players hardcode CanSeek false) get a dimmed,
    // read-only bar - it still shows progress, it just stops advertising a
    // drag it would silently ignore.
    const seekable = !!s.canSeek && hasLength;
    entry.slider.reactive = seekable;
    entry.slider.opacity = seekable ? 255 : 120;

    // A player that announces a new track before it knows the duration leaves
    // the bar inert, and GDBusProxy won't refresh its cache until the player
    // emits PropertiesChanged again - which it may never do on its own. That
    // is why the bar used to stay dead until you clicked play/shuffle/loop:
    // the click was what finally made the player re-announce. Ask for the
    // properties ourselves instead.
    if (seekable) this._cancelSeekRetry(entry);
    else this._scheduleSeekRetry(entry);
    if (!hasLength) {
      entry.slider.value = 0;
      if (entry.timeLabel) entry.timeLabel.text = "--:--";
    }

    // Read the position now if it's playing (the poll keeps it advancing) or
    // if we haven't shown one for this track yet (so a player that's paused
    // when you open the menu still shows where it's at). Don't otherwise
    // re-read while paused - some players (Zen) report a climbing Position
    // even when paused, which made the time tick up.
    if (s.status === "Playing" || entry._posSeeded !== entry._trackId) {
      entry._posSeeded = entry._trackId;
      this._updatePosition(message);
    }
    this._syncPolling();
  }

  /**
   * The position the player last reported, plus however long ago it said so.
   *
   * Not every source refreshes Position on demand: GSConnect only learns it
   * when the phone pushes a state packet, which is every 10-20s, so reading
   * the raw value leaves the bar sitting still and then lurching forward.
   * Anchor on each *new* reported value and run the clock forward from it
   * while playing; the next genuine report re-anchors and absorbs any drift.
   */
  _interpolatePosition(entry, reported) {
    // Monotonic time is in microseconds, the same unit MPRIS positions use.
    const now = GLib.get_monotonic_time();
    const anchor = entry._posAnchor;
    if (!anchor || anchor.reported !== reported) {
      entry._posAnchor = { reported, at: now };
      return reported;
    }
    // Only a playing track advances on its own.
    if (entry.player.status !== "Playing") return reported;
    return reported + (now - anchor.at);
  }

  _updatePosition(message) {
    const entry = this._enhanced.get(message);
    if (!entry || entry.slider._mciDragging) return;
    const len = entry._length || 0;
    if (!len) return;
    entry.player.getPositionAsync((reported) =>
      guard(() => {
        // Re-read from the map: the message may have been undecorated (and its
        // slider/label destroyed) while this async DBus call was in flight.
        const e = this._enhanced.get(message);
        if (!e || e.slider._mciDragging) return;
        const pos = Math.max(
          0,
          Math.min(len, this._interpolatePosition(e, reported)),
        );
        e.slider.value = pos / len;
        if (e.timeLabel)
          e.timeLabel.text = `${formatTime(pos)} / ${formatTime(len)}`;
      }, "position update failed"),
    );
  }

  _setActive(btn, active) {
    if (active) btn.add_style_class_name("mci-active");
    else btn.remove_style_class_name("mci-active");
  }

  // --- position polling -------------------------------------------------

  _syncPolling() {
    const wantPoll = this._enhanced.size > 0;
    if (wantPoll && !this._pollId) {
      this._pollId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        POLL_INTERVAL_MS,
        () => {
          guard(() => {
            for (const [message, entry] of this._enhanced) {
              // Only advance while actually playing: some players (Zen)
              // keep reporting a climbing Position while paused, which made
              // the time tick up when it shouldn't.
              if (message.mapped && entry.player.status === "Playing")
                this._updatePosition(message);
            }
          }, "poll failed");
          return GLib.SOURCE_CONTINUE;
        },
      );
    } else if (!wantPoll && this._pollId) {
      GLib.source_remove(this._pollId);
      this._pollId = 0;
    }
  }

  // --- teardown ---------------------------------------------------------

  _detach() {
    if (this._scanId) {
      GLib.source_remove(this._scanId);
      this._scanId = 0;
    }
    if (this._lockRetryId) {
      GLib.source_remove(this._lockRetryId);
      this._lockRetryId = 0;
    }
    for (const message of [...this._enhanced.keys()])
      guard(() => this._undecorate(message), "undecorate (detach) failed");
    if (this._grouping) {
      // Undo the stacking last: it hands every player back to the shell's
      // own flat list, which destroys the messages we just restored.
      this._grouping.disconnectObject(this);
      guard(() => this._grouping.destroy(), "grouping teardown failed");
      this._grouping = null;
    }
    if (this._source) {
      this._source.disconnectObject(this);
      this._source = null;
    }
    if (this._childAddedId && this._lockBox) {
      try {
        this._lockBox.disconnect(this._childAddedId);
      } catch (_) {}
    }
    this._childAddedId = 0;
    this._lockBox = null;
    this._messagesProvider = null;
    this._syncPolling();
  }

  destroy() {
    if (this._sessionId) {
      Main.sessionMode.disconnect(this._sessionId);
      this._sessionId = 0;
    }
    this._manager.disconnectObject(this);
    this._detach();
    if (this._pollId) {
      GLib.source_remove(this._pollId);
      this._pollId = 0;
    }
    // _detach() undecorated every entry, removing its temp art file; now drop
    // the (empty) cover directory itself.
    if (this._coverDir) {
      try {
        Gio.File.new_for_path(this._coverDir).delete(null);
      } catch (_) {}
      this._coverDir = null;
    }
  }
}
