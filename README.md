<div align="center">

<img src="icons/hicolor/scalable/apps/improved-media-controls.svg" alt="Improved Media Controls" width="128" height="128" />

# Improved Media Controls

Enhances GNOME's own media controls instead of replacing them: a now-playing
indicator in the top bar that raises the player when clicked, and a **seek bar
plus shuffle and loop** added to the native media notifications in the date
menu _and_ on the lock screen, with support for multiple players.

This started as a simple fork of [Medialine](https://extensions.gnome.org/extension/10076/medialine/) for some personal adjustments, which is why it has the same icon right now, but quickly turned into it's own thing later. I'll keep the icon until I get a better one.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GNOME Shell](https://img.shields.io/badge/GNOME%20Shell-46%E2%80%9350-4A86CF?logo=gnome&logoColor=white)](https://www.gnome.org/)

</div>

## What it does

**Top bar** - a compact now-playing label (title / artist / album, configurable).
Long text **marquee-scrolls** within a max width instead of being cut off with
"…". Click it to **raise the player app** (click/scroll actions are configurable).

**Notifications** - rather than inserting a separate widget, it augments the
_native_ MPRIS media message that GNOME already shows. So it keeps the native
look, app name + icon, and lock-screen support (GNOME 49+), and adds on top:

- a draggable **seek bar** with elapsed / total time,
- **shuffle** and **loop** (None → Track → Playlist) toggles.

Clicking a media message or using _Raise player_ in the top bar first looks for
an existing player window. This supports Flatpak mpv even when its MPRIS desktop
entry is `mpv` rather than `io.mpv.Mpv`. If no window can be identified, it falls
back to the player's Raise method (if supported), then its running desktop app.
No new app is launched.

**Chrome/Chromium limitation:** clicking media controls activates the browser
app and may surface a regular browser window instead of the playing PWA.
Chromium's Linux MPRIS service does not expose the playing tab/PWA's identity
and does not implement Raise. PWA window titles can contain only the app name,
so media-title matching cannot reliably identify the playing window. Precise
activation requires additional browser integration or upstream Chromium support.

Because these are the real notifications, multiple players each get their own
native message, and the "No notifications" placeholder behaves correctly.

## Install

```sh
make install
```

Wayland can't reload the shell live, so **log out and back in**, then enable it:

```sh
gnome-extensions enable improved-media-controls@m-obeid.github.com
```

(or use the Extensions app). Preferences:

```sh
gnome-extensions prefs improved-media-controls@m-obeid.github.com
```

## Preferences

- **General** - show in the top bar, enhance notifications (either or both).
- **Display** - icon source (album art / app icon / playback status) & size,
  label fields, separator, and max label width (longer text marquee-scrolls).
- **Panel** - top-bar section and position index.
- **Mouse** - click and scroll actions (left-click defaults to _Raise player_).
