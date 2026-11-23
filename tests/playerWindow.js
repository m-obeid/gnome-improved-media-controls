// Run with: gjs -m tests/playerWindow.js
import { findPlayerWindow } from '../helpers/playerWindow.js';

function expect(state, windows, expected, label) {
    const actual = findPlayerWindow(state, windows);
    if (actual !== expected) throw new Error(label);
    print(`PASS: ${label}`);
}

const mpv = { desktopEntry: 'mpv', title: 'Video title' };
const flatpak = { appId: 'io.mpv.Mpv.desktop', wmClass: 'mpv', title: 'Video title - mpv' };
expect(mpv, [flatpak], flatpak, 'Flatpak mpv desktop entry mismatch');
const wayland = { appId: 'io.mpv.Mpv.desktop', wmClass: 'io.mpv.Mpv' };
expect(mpv, [wayland], wayland, 'Flatpak mpv application ID');
const otherMpv = { wmClass: 'mpv', title: 'Other video - mpv' };
expect(mpv, [otherMpv, flatpak], flatpak, 'Select playing mpv among multiple instances');
expect({ ...mpv, title: '' }, [otherMpv, flatpak], null, 'Do not guess between mpv instances');
expect({ ...mpv, title: '' }, [flatpak], flatpak, 'Single mpv window without metadata');

const player = { desktopEntry: 'player', title: 'Track title' };
const first = { appId: 'player.desktop', title: 'TRACK TITLE — Player' };
const second = { appId: 'player.desktop', title: 'Other track' };
const unrelated = { appId: 'editor.desktop', title: 'Track title' };
expect(player, [first, second, unrelated], first, 'Match title and suffix within the reported app');
expect(player, [first, { ...second, title: 'Track title' }], null, 'Duplicate matching titles are ambiguous');
expect(player, [second, { ...first, title: 'Track title extended' }], null, 'Partial word prefix is not a match');
expect(player, [unrelated], null, 'Matching title in another app is ignored');
expect({ title: 'Track title' }, [first], null, 'Missing app identity cannot match by title alone');
expect(player, [second], second, 'Single app window does not require a title match');
const vlc = { appId: 'vlc.desktop' };
expect({ desktopEntry: 'vlc.desktop', title: '' }, [vlc], vlc, 'Desktop suffix is normalized');
