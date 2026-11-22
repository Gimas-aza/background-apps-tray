/* SPDX-License-Identifier: GPL-2.0-or-later */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {callSession, processAppUnits, processIdentity} from './processActions.js';

const BUS_NAME = 'org.freedesktop.systemd1';
const MANAGER = 'org.freedesktop.systemd1.Manager';
const PATH = '/org/freedesktop/systemd1';

function unescapeUnitName(name) {
    return name.replace(/\\x([\da-f]{2})/gi,
        (_, byte) => String.fromCharCode(Number.parseInt(byte, 16)));
}

export function lookupDesktopApp(appSystem, id) {
    if (!id)
        return null;

    // A Flatpak ID can itself end in ".desktop".
    for (const name of new Set([id, id.toLowerCase()])) {
        const app = appSystem.lookup_app(`${name}.desktop`) ??
            (name.endsWith('.desktop') && appSystem.lookup_app(name));
        if (app)
            return app;
    }
    return null;
}

export function lookupUnitApp(appSystem, unit) {
    const scope = unit.endsWith('.scope');
    const stem = unit.slice('app-'.length, unit.lastIndexOf('.'));
    const instance = scope ? stem.lastIndexOf('-') : stem.indexOf('@');
    const id = instance < 0 ? stem : stem.slice(0, instance);
    if (!id)
        return null;

    const candidates = [id];
    const launcherEnd = id.indexOf('-');
    if (launcherEnd >= 0)
        candidates.push(id.slice(launcherEnd + 1));

    for (const candidate of candidates) {
        const app = lookupDesktopApp(appSystem, unescapeUnitName(candidate));
        if (app)
            return app;
    }
    return null;
}

export class DesktopUnits {
    constructor(appSystem, cancellable, onChanged) {
        this.names = [];
        this.background = new Map();
        this._appSystem = appSystem;
        this._open = new Map();
        this._closed = new Map();
        this._cancellable = cancellable;
        this._onChanged = onChanged;
        this._owner = null;
        this._requestOwner = null;
        this._timer = 0;
        this._watch = Gio.DBus.session.watch_name(BUS_NAME, Gio.BusNameWatcherFlags.NONE,
            (_bus, _name, owner) => this._connect(owner),
            () => this._disconnect());
    }

    trackWindows() {
        const now = GLib.get_monotonic_time();
        const open = new Map();
        for (const app of this._appSystem.get_running()) {
            if (!app.get_app_info())
                continue;
            const pids = new Set(app.get_windows().filter(window => !window.is_skip_taskbar())
                .map(window => window.get_pid()));
            if (!pids.size)
                continue;

            const id = app.get_id();
            const previous = this._open.get(id);
            open.set(id, new Map([...pids].map(pid => [pid, previous?.get(pid) ?? processIdentity(pid)])));
            this._closed.delete(id);
        }
        for (const [id, processes] of this._open) {
            if (!open.has(id))
                this._closed.set(id, {processes, closedAt: now});
        }
        this._open = open;
        for (const [unit, id] of this.background) {
            if (open.has(id))
                this.background.delete(unit);
        }
    }

    _updateRunning(names, pollStartedAt) {
        const background = new Map();
        for (const [id, {processes, closedAt}] of this._closed) {
            // A process can still be shutting down just after its last window closes.
            if (pollStartedAt - closedAt < GLib.USEC_PER_SEC)
                continue;
            for (const [pid, process] of processes) {
                if (!process || processIdentity(pid)?.started !== process.started) {
                    processes.delete(pid);
                    continue;
                }
                if ([...this._open.values()].some(windows => windows.has(pid)))
                    continue;
                for (const unit of processAppUnits(pid)) {
                    if (names.includes(unit) && lookupUnitApp(this._appSystem, unit)?.get_id() === id)
                        background.set(unit, id);
                }
            }
            if (!processes.size)
                this._closed.delete(id);
        }
        const changed = names.join('\n') !== this.names.join('\n') ||
            background.size !== this.background.size ||
            [...background].some(([unit, id]) => this.background.get(unit) !== id);
        this.names = names;
        this.background = background;
        if (changed)
            this._onChanged();
    }

    refresh() {
        const owner = this._owner;
        if (!owner || this._requestOwner === owner)
            return;

        this._requestOwner = owner;
        const pollStartedAt = GLib.get_monotonic_time();
        callSession(owner, PATH, MANAGER, 'ListUnitsByPatterns',
            new GLib.Variant('(asas)', [['active', 'reloading'], ['app-*.service', 'app-*.scope']]),
            '(a(ssssssouso))', this._cancellable).then(result => {
            if (this._owner !== owner)
                return;
            const [units] = result.deep_unpack();
            const names = units.filter(unit => unit[4] === 'running' || unit[3] === 'reloading')
                .map(unit => unit[0]).sort();
            this._updateRunning(names, pollStartedAt);
        }).catch(error => {
            if (this._owner === owner &&
                error.matches?.(Gio.DBusError, Gio.DBusError.UNKNOWN_METHOD))
                this._disconnect();
        }).finally(() => {
            if (this._requestOwner === owner)
                this._requestOwner = null;
        });
    }

    async stop(units) {
        const owner = this._owner;
        const results = await Promise.allSettled(units
            .filter(unit => owner && this.names.includes(unit))
            .map(unit => callSession(owner, PATH, MANAGER, 'StopUnit',
                new GLib.Variant('(ss)', [unit, 'replace']), '(o)', this._cancellable)));

        if (results.some(result => result.status === 'fulfilled'))
            this.refresh();
        return results.length > 0 && results.every(result => result.status === 'fulfilled');
    }

    _connect(owner) {
        this._disconnect();
        this._owner = owner;
        this.refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 4, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _disconnect() {
        this._owner = null;
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
        if (this.names.length) {
            this.names = [];
            this.background.clear();
            this._onChanged();
        }
    }

    destroy() {
        Gio.DBus.session.unwatch_name(this._watch);
        this._disconnect();
    }
}
