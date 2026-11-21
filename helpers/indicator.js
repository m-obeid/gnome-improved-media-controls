import GObject from "gi://GObject";
import St from "gi://St";
import Gio from "gi://Gio";
import Clutter from "gi://Clutter";
import Gvc from "gi://Gvc";

import { gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

import {
  ICON_TYPE_ART,
  ICON_TYPE_STATUS,
  CLICK_NOTHING,
  CLICK_RAISE_PLAYER,
  CLICK_PLAY_PAUSE,
  CLICK_OPEN_SETTINGS,
  CLICK_NEXT_TRACK,
  CLICK_PREV_TRACK,
  CLICK_VOLUME_UP,
  CLICK_VOLUME_DOWN,
} from "./constants.js";
import { ScrollingLabel } from "./scrollingLabel.js";
import { ArtworkLoader } from "./artwork.js";

const SCROLL_NOTCH = 1.0;

export const Indicator = GObject.registerClass(
  {
    GTypeName: "ImprovedMediaControlsIndicator",
  },
  class Indicator extends PanelMenu.Button {
    _init(preferences, extension, mprisManager) {
      // menuAlignment 0, and we never populate the menu - this is a plain
      // click-to-raise button, no dropdown.
      super._init(0.5, _("Improved Media Controls"), true);

      this._preferences = preferences;
      this._extension = extension;
      this._mprisManager = mprisManager;
      this._currentArtUrl = null;
      this._artworkLoader = new ArtworkLoader();
      this._artCancellable = null;
      this._artIcon = null;
      this._scrollAccum = 0;
      this._mixer = null;
      this._pendingVolumeDelta = 0;

      this._buildUI();
      this._setupClickHandling();

      this._mprisManager.connectObject(
        "players-changed",
        () => this._onPlayersChanged(),
        this,
      );
      this._preferences.connectObject(
        "changed",
        () => this._onPlayersChanged(),
        this,
      );
      // Re-evaluate visibility on lock/unlock.
      this._sessionId = Main.sessionMode.connect("updated", () =>
        this._onPlayersChanged(),
      );

      this._onPlayersChanged();
    }

    _buildUI() {
      this._box = new St.BoxLayout({
        x_expand: false,
        y_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
      });

      this._iconActor = new St.Icon({
        icon_name: "audio-x-generic-symbolic",
        icon_size: this._preferences.iconSize,
        y_align: Clutter.ActorAlign.CENTER,
        style: `margin-right: ${this._preferences.iconSpacing}px; border-radius: 4px;`,
      });

      this._label = new ScrollingLabel(this._preferences.maxTextWidth);
      // Size to content and center, so the text lines up with the icon instead
      // of being pinned to the top of an expanded scroll view.
      this._label.y_expand = false;
      this._label.y_align = Clutter.ActorAlign.CENTER;

      this._box.add_child(this._iconActor);
      this._box.add_child(this._label);
      this.add_child(this._box);
    }

    _onPlayersChanged() {
      // On the lock screen the notification carries the controls; the top-bar
      // button serves no purpose there.
      if (Main.sessionMode.isLocked) {
        this._cancelArtwork();
        this.hide();
        return;
      }

      const media = this._mprisManager.currentMedia;

      if (!media || media.status === "Stopped") {
        this._cancelArtwork();
        this.hide();
        return;
      }

      this.show();

      const prefs = this._preferences;
      const parts = [];
      if (prefs.showTitle && media.title) parts.push(media.title);
      if (prefs.showArtist && media.artist) parts.push(media.artist);
      if (prefs.showAlbum && media.album) parts.push(media.album);

      this._label.setMaxWidth(prefs.maxTextWidth);
      this._label.setText(parts.join(prefs.separator));

      this._iconActor.style = `margin-right: ${prefs.iconSpacing}px; border-radius: 4px;`;
      this._updateIcon(media, prefs);
    }

    // A symbolic glyph only fills ~75% of its icon box, so a symbolic icon at the
    // same size looks shorter than raster album art. Boost it to match the text.
    _symbolicSize(prefs) {
      return Math.round(prefs.iconSize * 1.35);
    }

    // --- click / scroll --------------------------------------------------

    _setupClickHandling() {
      // Intercept in the capture phase so the (empty) menu never toggles and
      // only the configured action fires.
      this.connectObject(
        "captured-event",
        (_actor, event) => {
          const type = event.type();
          if (type === Clutter.EventType.BUTTON_PRESS)
            return this._handleButtonPress(event);
          if (type === Clutter.EventType.SCROLL)
            return this._handleScroll(event);
          return Clutter.EVENT_PROPAGATE;
        },
        this,
      );
    }

    _handleButtonPress(event) {
      const button = event.get_button();
      let action;
      if (button === Clutter.BUTTON_PRIMARY)
        action = this._preferences.leftClickAction;
      else if (button === Clutter.BUTTON_MIDDLE)
        action = this._preferences.middleClickAction;
      else if (button === Clutter.BUTTON_SECONDARY)
        action = this._preferences.rightClickAction;
      else return Clutter.EVENT_PROPAGATE;

      return this._dispatchAction(action);
    }

    _handleScroll(event) {
      let action;
      switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
          action = this._preferences.scrollUpAction;
          break;
        case Clutter.ScrollDirection.DOWN:
          action = this._preferences.scrollDownAction;
          break;
        case Clutter.ScrollDirection.SMOOTH: {
          const [, dy] = event.get_scroll_delta();
          this._scrollAccum += dy;
          if (Math.abs(this._scrollAccum) < SCROLL_NOTCH)
            return Clutter.EVENT_STOP;
          action =
            this._scrollAccum < 0
              ? this._preferences.scrollUpAction
              : this._preferences.scrollDownAction;
          this._scrollAccum = 0;
          break;
        }
        default:
          return Clutter.EVENT_PROPAGATE;
      }

      return this._dispatchAction(action);
    }

    _dispatchAction(action) {
      if (action !== CLICK_NOTHING) this._executeClickAction(action);
      return Clutter.EVENT_STOP;
    }

    _executeClickAction(action) {
      const best = this._mprisManager.getBestPlayer();
      switch (action) {
        case CLICK_RAISE_PLAYER:
          best?.raise();
          break;
        case CLICK_PLAY_PAUSE:
          best?.playPause();
          break;
        case CLICK_OPEN_SETTINGS:
          this._extension.openPreferences();
          break;
        case CLICK_NEXT_TRACK:
          best?.next();
          break;
        case CLICK_PREV_TRACK:
          best?.previous();
          break;
        case CLICK_VOLUME_UP:
          this._adjustVolume(5);
          break;
        case CLICK_VOLUME_DOWN:
          this._adjustVolume(-5);
          break;
      }
    }

    // --- volume ----------------------------------------------------------

    _adjustVolume(deltaPct) {
      this._ensureMixer();
      if (this._mixer.get_state() === Gvc.MixerControlState.READY)
        this._applyVolumeDelta(deltaPct);
      else this._pendingVolumeDelta += deltaPct;
    }

    _ensureMixer() {
      if (this._mixer) return;
      this._mixer = new Gvc.MixerControl({ name: "Improved Media Controls" });
      this._mixer.connectObject(
        "state-changed",
        () => {
          if (this._mixer.get_state() !== Gvc.MixerControlState.READY) return;
          if (this._pendingVolumeDelta) {
            const delta = this._pendingVolumeDelta;
            this._pendingVolumeDelta = 0;
            this._applyVolumeDelta(delta);
          }
        },
        this,
      );
      this._mixer.open();
    }

    _applyVolumeDelta(deltaPct) {
      const sink = this._mixer.get_default_sink();
      if (!sink) return;
      const maxNorm = this._mixer.get_vol_max_norm();
      const step = maxNorm * (deltaPct / 100);
      sink.volume = Math.max(0, Math.min(maxNorm, sink.volume + step));
      sink.push_volume();

      const level = sink.volume / maxNorm;
      const name =
        level === 0
          ? "audio-volume-muted-symbolic"
          : level < 0.34
            ? "audio-volume-low-symbolic"
            : level < 0.67
              ? "audio-volume-medium-symbolic"
              : "audio-volume-high-symbolic";
      Main.osdWindowManager.showAll(
        new Gio.ThemedIcon({ name }),
        null,
        level,
        1.0,
      );
    }

    // --- panel icon ------------------------------------------------------

    _updateIcon(media, prefs) {
      if (prefs.iconType === ICON_TYPE_STATUS) {
        this._cancelArtwork();
        this._iconActor.gicon = null;
        this._setDesaturate(false);
        this._iconActor.icon_size = this._symbolicSize(prefs);
        this._iconActor.icon_name =
          media.status === "Playing"
            ? "media-playback-start-symbolic"
            : "media-playback-pause-symbolic";
        return;
      }

      if (
        prefs.iconType === ICON_TYPE_ART &&
        media.artUrl
      ) {
        const artKey = `${media.busName}\n${media.trackId}\n${media.artUrl}`;
        if (artKey !== this._currentArtUrl) {
          this._cancelArtwork();
          this._currentArtUrl = artKey;
          this._setAppIcon(media);
          if (/^https?:\/\//i.test(media.artUrl)) {
            const cancellable = new Gio.Cancellable();
            this._artCancellable = cancellable;
            this._artworkLoader.load(media.artUrl, cancellable, (bytes) => {
              if (this._artCancellable !== cancellable || !bytes) return;
              this._artIcon = new Gio.BytesIcon({ bytes });
              this._showArtwork(this._preferences);
            });
          } else if (media.artUrl.startsWith("file://")) {
            try {
              const file = Gio.File.new_for_uri(media.artUrl);
              this._artIcon = new Gio.FileIcon({ file });
            } catch (_) {}
          }
        }
        if (this._artIcon) this._showArtwork(prefs);
        return;
      }

      this._cancelArtwork();
      this._setAppIcon(media);
    }

    _showArtwork(prefs) {
      this._setDesaturate(false);
      this._iconActor.icon_size = prefs.iconSize;
      this._iconActor.gicon = this._artIcon;
    }

    _cancelArtwork() {
      this._artCancellable?.cancel();
      this._artCancellable = null;
      this._currentArtUrl = null;
      this._artIcon = null;
    }

    // Desaturate (grayscale) a full-colour app icon so it blends with the
    // monochrome panel, like GNOME's own themed-icon treatment.
    _setDesaturate(on) {
      const has = !!this._iconActor.get_effect("mci-desaturate");
      if (on && !has) {
        this._iconActor.add_effect_with_name(
          "mci-desaturate",
          new Clutter.DesaturateEffect({ factor: 1.0 }),
        );
      } else if (!on && has) {
        this._iconActor.remove_effect_by_name("mci-desaturate");
      }
    }

    _setAppIcon(media) {
      const prefs = this._preferences;
      this._iconActor.icon_name = null;
      this._iconActor.gicon = null;

      // Prefer a symbolic variant so the app icon matches the monochrome panel.
      const symbolic = this._lookupAppSymbolicGicon(media);
      if (symbolic) {
        this._setDesaturate(false);
        this._iconActor.icon_size = this._symbolicSize(prefs);
        this._iconActor.gicon = symbolic;
        return;
      }
      const gicon = this._lookupAppGicon(media);
      if (gicon) {
        // Full-colour app icon (no symbolic variant): fill the box, desaturate.
        this._setDesaturate(true);
        this._iconActor.icon_size = prefs.iconSize;
        this._iconActor.gicon = gicon;
        return;
      }
      this._setDesaturate(false);
      this._iconActor.icon_size = this._symbolicSize(prefs);
      this._iconActor.icon_name = "audio-x-generic-symbolic";
    }

    _appIdCandidates(media) {
      const candidates = [];
      const push = (v) => {
        if (v) candidates.push(v);
      };
      push(media.desktopEntry);
      if (media.identity) {
        push(media.identity);
        push(media.identity.toLowerCase().replace(/\s+/g, "-"));
        push(media.identity.toLowerCase().replace(/\s+/g, ""));
      }
      if (media.busName) {
        const tail = media.busName.replace("org.mpris.MediaPlayer2.", "");
        push(tail);
        push(tail.split(".")[0]);
      }
      return candidates;
    }

    _lookupAppSymbolicGicon(media) {
      // Only the authoritative DesktopEntry - heuristic ids (bus name / identity)
      // can mismatch, e.g. a Firefox fork (Zen) whose bus name is
      // org.mpris.MediaPlayer2.firefox.* would wrongly resolve to firefox-symbolic.
      const base = media.desktopEntry;
      if (!base) return null;
      let theme;
      try {
        theme = new St.IconTheme();
      } catch (_) {
        return null;
      }
      const name = `${base.replace(/\.desktop$/, "")}-symbolic`;
      return theme.has_icon(name) ? new Gio.ThemedIcon({ name }) : null;
    }

    _lookupAppGicon(media) {
      const ids = this._appIdCandidates(media).map((c) =>
        c.endsWith(".desktop") ? c : `${c}.desktop`,
      );

      for (const id of ids) {
        const info = Gio.DesktopAppInfo.new(id);
        if (info) {
          const icon = info.get_icon();
          if (icon) return icon;
        }
      }

      const lcSet = new Set(ids.map((id) => id.toLowerCase()));
      for (const info of Gio.AppInfo.get_all()) {
        const aid = info.get_id();
        if (aid && lcSet.has(aid.toLowerCase())) {
          const icon = info.get_icon();
          if (icon) return icon;
        }
      }
      return null;
    }

    destroy() {
      this._cancelArtwork();
      this._artworkLoader.destroy();
      if (this._mixer) {
        this._mixer.disconnectObject(this);
        this._mixer.close();
        this._mixer = null;
      }
      if (this._sessionId) {
        Main.sessionMode.disconnect(this._sessionId);
        this._sessionId = 0;
      }
      this._mprisManager.disconnectObject(this);
      this._preferences.disconnectObject(this);
      this.disconnectObject(this);
      super.destroy();
    }
  },
);
