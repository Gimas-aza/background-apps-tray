/* SPDX-License-Identifier: GPL-2.0-or-later */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {callSession} from './processActions.js';

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
    constructor(cancellable, onChanged) {
        this.names = [];
        this._cancellable = cancellable;
        this._onChanged = onChanged;
        this._owner = null;
        this._requestOwner = null;
        this._timer = 0;
        this._watch = Gio.DBus.session.watch_name(BUS_NAME, Gio.BusNameWatcherFlags.NONE,
            (_bus, _name, owner) => this._connect(owner),
            () => this._disconnect());
    }

    refresh() {
        const owner = this._owner;
        if (!owner || this._requestOwner === owner)
            return;

        this._requestOwner = owner;
        callSession(owner, PATH, MANAGER, 'ListUnitsByPatterns',
            new GLib.Variant('(asas)', [['active', 'reloading'], ['app-*.service', 'app-*.scope']]),
            '(a(ssssssouso))', this._cancellable).then(result => {
            if (this._owner !== owner)
                return;
            const [units] = result.deep_unpack();
            const names = units.map(unit => unit[0]).sort();
            if (names.join('\n') !== this.names.join('\n')) {
                this.names = names;
                this._onChanged();
            }
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
            this._onChanged();
        }
    }

    destroy() {
        Gio.DBus.session.unwatch_name(this._watch);
        this._disconnect();
    }
}
