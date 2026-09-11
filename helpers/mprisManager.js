import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const DBusInterface = `<node>
    <interface name="org.freedesktop.DBus">
        <method name="ListNames">
            <arg type="as" direction="out"/>
        </method>
        <signal name="NameOwnerChanged">
            <arg type="s" name="name"/>
            <arg type="s" name="old_owner"/>
            <arg type="s" name="new_owner"/>
        </signal>
    </interface>
</node>`;

const MprisPlayerInterface = `<node>
    <interface name="org.mpris.MediaPlayer2.Player">
        <method name="PlayPause"/>
        <method name="Play"/>
        <method name="Pause"/>
        <method name="Next"/>
        <method name="Previous"/>
        <method name="SetPosition">
            <arg type="o" name="TrackId" direction="in"/>
            <arg type="x" name="Position" direction="in"/>
        </method>
        <property name="PlaybackStatus" type="s" access="read"/>
        <property name="Position" type="x" access="read"/>
        <property name="Metadata" type="a{sv}" access="read"/>
        <property name="CanGoNext" type="b" access="read"/>
        <property name="CanGoPrevious" type="b" access="read"/>
        <property name="CanControl" type="b" access="read"/>
        <property name="CanSeek" type="b" access="read"/>
        <property name="Shuffle" type="b" access="readwrite"/>
        <property name="LoopStatus" type="s" access="readwrite"/>
        <signal name="Seeked">
            <arg type="x" name="Position"/>
        </signal>
    </interface>
</node>`;

const MprisRootInterface = `<node>
    <interface name="org.mpris.MediaPlayer2">
        <method name="Raise"/>
        <property name="DesktopEntry" type="s" access="read"/>
        <property name="Identity" type="s" access="read"/>
        <property name="CanRaise" type="b" access="read"/>
    </interface>
</node>`;

const DBusProxy = Gio.DBusProxy.makeProxyWrapper(DBusInterface);
const MprisPlayerProxy = Gio.DBusProxy.makeProxyWrapper(MprisPlayerInterface);
const MprisRootProxy = Gio.DBusProxy.makeProxyWrapper(MprisRootInterface);

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';

/**
 * Wraps a single MPRIS player bus name. Exposes a flat state snapshot and the
 * control verbs for that one player, and emits 'changed' whenever any of its
 * properties update.
 */
export const MprisPlayer = GObject.registerClass({
    GTypeName: 'ImprovedMediaControlsMprisPlayer',
    Signals: {
        'changed': {},
    },
}, class MprisPlayer extends GObject.Object {
    _init(busName) {
        super._init();
        this.busName = busName;
        this._proxy = null;
        this._rootProxy = null;

        this._proxy = new MprisPlayerProxy(
            Gio.DBus.session,
            busName,
            '/org/mpris/MediaPlayer2',
            null,
            null,
            Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES
        );

        this._proxy.connectObject('g-properties-changed',
            () => this.emit('changed'), this);

        try {
            this._rootProxy = new MprisRootProxy(
                Gio.DBus.session,
                busName,
                '/org/mpris/MediaPlayer2',
                null,
                null,
                Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES
            );
        } catch (_) { }
    }

    get status() {
        return this._proxy?.PlaybackStatus || 'Stopped';
    }

    /** A player worth showing a card for: it exists and isn't fully stopped. */
    get isActive() {
        const s = this.status;
        return s === 'Playing' || s === 'Paused';
    }

    getState() {
        if (!this._proxy) return null;
        const metadata = this._unpackMetadata(this._proxy.Metadata);
        const reportedLength = Number(metadata['mpris:length']);
        // Chromium represents an unbounded live stream with INT64_MAX. That
        // value cannot be represented safely by JavaScript and is not a real
        // duration, so expose it to the UI as an unknown length instead.
        const length = Number.isSafeInteger(reportedLength) && reportedLength > 0
            ? reportedLength
            : 0;
        let desktopEntry = '';
        let identity = '';
        if (this._rootProxy) {
            try {
                desktopEntry = String(this._rootProxy.DesktopEntry || '');
                identity = String(this._rootProxy.Identity || '');
            } catch (_) { }
        }
        return {
            title: metadata['xesam:title'] || '',
            artist: Array.isArray(metadata['xesam:artist'])
                ? metadata['xesam:artist'][0] || ''
                : metadata['xesam:artist'] || '',
            album: metadata['xesam:album'] || '',
            artUrl: metadata['mpris:artUrl'] || '',
            length,
            trackId: metadata['mpris:trackid'] || '',
            status: this._proxy.PlaybackStatus || 'Stopped',
            canGoNext: this._proxy.CanGoNext !== false,
            canGoPrevious: this._proxy.CanGoPrevious !== false,
            canControl: this._proxy.CanControl !== false,
            canSeek: this._proxy.CanSeek !== false,
            shuffle: this._proxy.Shuffle != null ? Boolean(this._proxy.Shuffle) : null,
            loopStatus: this._proxy.LoopStatus != null ? String(this._proxy.LoopStatus) : null,
            busName: this.busName,
            desktopEntry,
            identity,
        };
    }

    playPause() { this._invoke('PlayPauseRemote'); }
    next() { this._invoke('NextRemote'); }
    previous() { this._invoke('PreviousRemote'); }

    raise() {
        if (!this._rootProxy) return;
        try {
            this._rootProxy.RaiseRemote();
        } catch (e) {
            logError(e, 'ImprovedMediaControls: Raise failed');
        }
    }

    setShuffle(value) {
        this._setProperty('Shuffle', new GLib.Variant('b', value),
            'ImprovedMediaControls: setShuffle failed');
    }

    setLoopStatus(value) {
        this._setProperty('LoopStatus', new GLib.Variant('s', value),
            'ImprovedMediaControls: setLoopStatus failed');
    }

    setPosition(positionMicros) {
        const state = this.getState();
        if (!state || !state.canSeek) return;
        const clamped = Math.max(0, Math.floor(positionMicros));

        // SetPosition takes an object path, and passing anything else is a
        // GLib assertion failure rather than a catchable error, so check the
        // id really is one before building the variant.
        const trackId = String(state.trackId || '');
        if (GLib.Variant.is_object_path(trackId)) {
            this._callPlayer('SetPosition',
                new GLib.Variant('(ox)', [trackId, clamped]),
                'ImprovedMediaControls: setPosition failed');
            return;
        }

        // No usable track id. MPRIS calls `mpris:trackid` mandatory but plenty
        // of players omit it, and Seek() is the spec's id-less way to move the
        // playhead, it just takes an offset from where we are now.
        this.getPositionAsync((pos) => {
            this._callPlayer('Seek',
                new GLib.Variant('(x)', [clamped - pos]),
                'ImprovedMediaControls: seek failed');
        });
    }

    _callPlayer(method, params, errorLabel) {
        Gio.DBus.session.call(
            this.busName,
            '/org/mpris/MediaPlayer2',
            'org.mpris.MediaPlayer2.Player',
            method,
            params,
            null,
            Gio.DBusCallFlags.NONE,
            500,
            null,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (e) {
                    logError(e, errorLabel);
                }
            }
        );
    }

    /**
     * Re-read the Player properties straight off the bus and push them into
     * the proxy's cache.
     *
     * GDBusProxy only refreshes on PropertiesChanged, so a player that
     * publishes new metadata *before* it knows the track length (browsers and
     * streaming players routinely do) and then never re-announces it leaves us
     * with a cached `mpris:length` of 0 for the whole track. Asking for the
     * properties ourselves recovers the real value instead of waiting for the
     * player to volunteer it.
     */
    refreshProperties() {
        if (!this._proxy || !this.busName) return;
        Gio.DBus.session.call(
            this.busName,
            '/org/mpris/MediaPlayer2',
            'org.freedesktop.DBus.Properties',
            'GetAll',
            new GLib.Variant('(s)', ['org.mpris.MediaPlayer2.Player']),
            new GLib.VariantType('(a{sv})'),
            Gio.DBusCallFlags.NONE,
            1000,
            null,
            (conn, res) => {
                let dict;
                try {
                    dict = conn.call_finish(res).get_child_value(0);
                } catch (_) {
                    return; // player vanished or doesn't answer; nothing to do
                }
                // The proxy may have been torn down while the call was in flight.
                if (!this._proxy) return;

                let changed = false;
                for (let i = 0; i < dict.n_children(); i++) {
                    const entry = dict.get_child_value(i);
                    const name = entry.get_child_value(0).get_string()[0];
                    const value = entry.get_child_value(1).get_variant();
                    const cached = this._proxy.get_cached_property(name);
                    if (cached && cached.equal(value)) continue;
                    this._proxy.set_cached_property(name, value);
                    changed = true;
                }
                // Only wake the UI when we actually learned something new -
                // otherwise a poll would re-render on every tick.
                if (changed) this.emit('changed');
            }
        );
    }

    getPositionAsync(callback) {
        if (!this.busName) {
            callback(0);
            return;
        }
        Gio.DBus.session.call(
            this.busName,
            '/org/mpris/MediaPlayer2',
            'org.freedesktop.DBus.Properties',
            'Get',
            new GLib.Variant('(ss)', [
                'org.mpris.MediaPlayer2.Player',
                'Position',
            ]),
            null,
            Gio.DBusCallFlags.NONE,
            500,
            null,
            (conn, res) => {
                try {
                    const result = conn.call_finish(res);
                    const [variant] = result.deepUnpack();
                    callback(Number(variant.unpack()) || 0);
                } catch (_) {
                    callback(0);
                }
            }
        );
    }

    _setProperty(propName, valueVariant, errorLabel) {
        Gio.DBus.session.call(
            this.busName,
            '/org/mpris/MediaPlayer2',
            'org.freedesktop.DBus.Properties',
            'Set',
            new GLib.Variant('(ssv)', [
                'org.mpris.MediaPlayer2.Player', propName, valueVariant,
            ]),
            null,
            Gio.DBusCallFlags.NONE,
            500,
            null,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (e) {
                    logError(e, errorLabel);
                }
            }
        );
    }

    _invoke(method) {
        if (!this._proxy) return;
        try {
            this._proxy[method]();
        } catch (e) {
            logError(e, `ImprovedMediaControls: ${method} failed`);
        }
    }

    _unpackMetadata(metadata) {
        if (!metadata) return {};
        try {
            if (typeof metadata.recursiveUnpack === 'function')
                return metadata.recursiveUnpack();

            const unwrap = (v) => {
                if (!v || typeof v !== 'object') return v;
                if (typeof v.recursiveUnpack === 'function') return v.recursiveUnpack();
                if (typeof v.deep_unpack === 'function') return v.deep_unpack();
                return v;
            };

            const dict = typeof metadata.deep_unpack === 'function'
                ? metadata.deep_unpack()
                : metadata;

            const out = {};
            for (const k in dict) out[k] = unwrap(dict[k]);
            return out;
        } catch (_) {
            return {};
        }
    }

    destroy() {
        if (this._proxy) {
            this._proxy.disconnectObject(this);
            this._proxy = null;
        }
        this._rootProxy = null;
    }
});

/**
 * Registry of every MPRIS player on the session bus. Keeps insertion order,
 * tracks add/remove via NameOwnerChanged, and re-emits a single
 * 'players-changed' whenever the set or state of players changes (driving both
 * the panel label and the card stacks). Individual cards listen to their own
 * MprisPlayer's 'changed' for content updates.
 */
export const MprisManager = GObject.registerClass({
    GTypeName: 'ImprovedMediaControlsMprisManager',
    Signals: {
        'players-changed': {},
        'player-added': { param_types: [GObject.TYPE_STRING] },
        'player-removed': { param_types: [GObject.TYPE_STRING] },
    },
}, class MprisManager extends GObject.Object {
    _init() {
        super._init();
        this._players = new Map();
        this._nameOwnerChangedId = null;
        this._dbusProxy = null;

        try {
            this._dbusProxy = new DBusProxy(
                Gio.DBus.session,
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                null,
                null,
                Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES
            );

            this._nameOwnerChangedId = this._dbusProxy.connectSignal(
                'NameOwnerChanged',
                (_proxy, _sender, [name, oldOwner, newOwner]) => {
                    if (!name.startsWith(MPRIS_PREFIX)) return;

                    if (newOwner === '')
                        this._removePlayer(name);
                    else if (oldOwner === '')
                        this._addPlayer(name);
                }
            );

            const [names] = this._dbusProxy.ListNamesSync();
            for (const name of names) {
                if (name.startsWith(MPRIS_PREFIX))
                    this._addPlayer(name);
            }
        } catch (e) {
            logError(e, 'ImprovedMediaControls: Failed to initialize MPRIS manager');
        }
    }

    _addPlayer(busName) {
        if (this._players.has(busName)) return;
        try {
            const player = new MprisPlayer(busName);
            player.connectObject('changed', () => this.emit('players-changed'), this);
            this._players.set(busName, player);
            this.emit('player-added', busName);
            this.emit('players-changed');
        } catch (e) {
            logError(e, `ImprovedMediaControls: Failed to create player for ${busName}`);
        }
    }

    _removePlayer(busName) {
        const player = this._players.get(busName);
        if (!player) return;
        player.disconnectObject(this);
        player.destroy();
        this._players.delete(busName);
        this.emit('player-removed', busName);
        this.emit('players-changed');
    }

    /** All players, insertion-ordered. */
    get players() {
        return [...this._players.values()];
    }

    /** Players worth showing a card for (playing or paused), insertion-ordered. */
    get activePlayers() {
        return [...this._players.values()].filter(p => p.isActive);
    }

    getPlayer(busName) {
        return this._players.get(busName) || null;
    }

    /** Best player for the panel label: prefer Playing, then Paused. */
    getBestPlayer() {
        let paused = null;
        for (const player of this._players.values()) {
            if (player.status === 'Playing') return player;
            if (player.status === 'Paused' && !paused) paused = player;
        }
        return paused;
    }

    /** Flat state of the best player, or null. (Panel label uses this.) */
    get currentMedia() {
        const best = this.getBestPlayer();
        return best ? best.getState() : null;
    }

    destroy() {
        for (const player of this._players.values()) {
            player.disconnectObject(this);
            player.destroy();
        }
        this._players.clear();

        if (this._dbusProxy && this._nameOwnerChangedId)
            this._dbusProxy.disconnectSignal(this._nameOwnerChangedId);

        this._nameOwnerChangedId = null;
        this._dbusProxy = null;
    }
});
