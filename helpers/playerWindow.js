// Keep window selection independent of Shell so ambiguous/missing metadata can
// be checked without starting a compositor.
const normalize = value => String(value || '').trim().toLowerCase();
const desktopId = value => normalize(value).replace(/\.desktop$/, '');

function titleMatches(windowTitle, trackTitle) {
    const title = normalize(windowTitle);
    const track = normalize(trackTitle);
    if (!track) return false;
    return title === track || [' - ', ' – ', ' — ', ' | ', ' · ']
        .some(separator => title.startsWith(track + separator));
}

/** Return an existing window only when the available evidence singles it out. */
export function findPlayerWindow(state, windows) {
    const entry = desktopId(state.desktopEntry);
    const candidates = windows.filter(window => {
        const ids = [window.appId, window.wmClass, window.wmClassInstance]
            .map(desktopId);
        if (entry && ids.includes(entry)) return true;
        // Work around an upstream mpv-mpris/Flatpak integration issue: the
        // plugin hardcodes DesktopEntry="mpv", but Flatpak exports
        // io.mpv.Mpv.desktop. Keep this alias until the package reports its
        // installed desktop entry correctly (IDs are normalized above).
        // https://github.com/flathub/io.mpv.Mpv/issues/850
        if (entry === 'mpv' && ids.includes('io.mpv.mpv')) return true;
        return false;
    });
    const matching = candidates.filter(window => titleMatches(window.title, state.title));
    if (matching.length === 1) return matching[0];
    if (candidates.length === 1) return candidates[0];
    return null;
}
