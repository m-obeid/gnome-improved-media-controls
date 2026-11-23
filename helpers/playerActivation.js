import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { findPlayerWindow } from './playerWindow.js';

export function activatePlayerWindow(state) {
    if (Main.sessionMode.isLocked) return false;
    const tracker = Shell.WindowTracker.get_default();
    const windows = global.get_window_actors().map(actor => {
        const window = actor.meta_window;
        return {
            window,
            appId: tracker.get_window_app(window)?.get_id(),
            wmClass: window.get_wm_class(),
            wmClassInstance: window.get_wm_class_instance(),
            title: window.get_title(),
        };
    });
    const match = findPlayerWindow(state, windows);
    if (!match) return false;
    Main.activateWindow(match.window);
    return true;
}

export function activatePlayerApp(desktopEntry) {
    if (Main.sessionMode.isLocked || !desktopEntry) return false;
    const id = desktopEntry.endsWith('.desktop')
        ? desktopEntry : `${desktopEntry}.desktop`;
    const app = Shell.AppSystem.get_default().lookup_app(id);
    // Clicking media should never launch a second, empty player.
    if (!app?.get_windows().length) return false;
    app.activate();
    return true;
}
