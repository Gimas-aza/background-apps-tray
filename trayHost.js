/* SPDX-License-Identifier: GPL-2.0-or-later */
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {SNIStatus} from './vendor/appIndicator.js';
import {getProcessId} from './vendor/dbusUtils.js';
import {StatusNotifierWatcher, WATCHER_BUS_NAME} from './vendor/statusNotifierWatcher.js';
import {processExecutable, processIdentity} from './processActions.js';

export class TrayHost {
    constructor(extension, cancellable, onChanged) {
        this.indicators = new Map();
        this.legacy = new Map();
        this.conflict = false;
        this._extension = extension;
        this._cancellable = cancellable;
        this._onChanged = onChanged;
        this._watcher = null;
        this._tray = null;
        this._destroyed = false;

        this._watch = Gio.DBus.session.watch_name(WATCHER_BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            (_bus, _name, owner) => this._ownerAppeared(owner),
            () => this._startHosting());
    }

    _startHosting() {
        if (this._destroyed || this._watcher)
            return;

        this.conflict = false;
        this._watcher = new StatusNotifierWatcher(this._extension,
            indicator => this._addIndicator(indicator));

        if (Shell.TrayManager) {
            try {
                this._tray = new Shell.TrayManager();
                this._tray.connect('tray-icon-added', (_manager, icon) => {
                    icon.opacity = 0;
                    Main.uiGroup.add_child(icon);
                    this.legacy.set(icon, processIdentity(icon.pid));
                    this._onChanged();
                });
                this._tray.connect('tray-icon-removed', (_manager, icon) => {
                    if (this.legacy.delete(icon)) {
                        icon.destroy();
                        this._onChanged();
                    }
                });
                this._tray.manage_screen(Main.panel);
            } catch (error) {
                console.warn(`Background Apps Tray: ${error.message}`);
            }
        }
        this._onChanged();
    }

    _ownerAppeared(owner) {
        if (owner === Gio.DBus.session.get_unique_name() && this._watcher)
            return;

        this.conflict = true;
        this._stopHosting();
        this._onChanged();
    }

    _addIndicator(indicator) {
        if (this._destroyed)
            return;

        const record = {indicator, requestedOwner: null, owner: null, pid: null, process: null, executable: ''};
        this.indicators.set(indicator, record);
        const refreshOwner = () => this._refreshOwner(record);
        for (const signal of ['ready', 'name-owner-changed', 'reset'])
            indicator.connect(signal, refreshOwner);
        for (const signal of ['accessible-name', 'actions', 'menu'])
            indicator.connect(signal, () => this._onChanged());
        indicator.connect('status', () => {
            if (indicator.status === SNIStatus.PASSIVE)
                indicator.checkAlive().catch(logError);
            this._onChanged();
        });
        indicator.connect('destroy', () => {
            this.indicators.delete(indicator);
            this._onChanged();
        });
        refreshOwner();
    }

    async _refreshOwner(record) {
        const {indicator} = record;
        const owner = indicator.owner;
        this._onChanged();
        if (record.requestedOwner === owner)
            return;

        record.requestedOwner = owner;
        record.owner = null;
        if (!owner)
            return;

        let pid = null;
        try {
            pid = await getProcessId(owner, this._cancellable);
        } catch (error) {
            if (this.indicators.has(indicator) && !this._cancellable.is_cancelled())
                console.debug(`Background Apps Tray: ${error.message}`);
        }
        if (!this.indicators.has(indicator) || indicator.owner !== owner || this._cancellable.is_cancelled())
            return;

        record.owner = owner;
        record.pid = pid;
        record.executable = pid ? processExecutable(pid) : '';
        // The bus can report the Flatpak proxy instead of the actual app.
        record.process = pid && record.executable !== 'xdg-dbus-proxy' ? processIdentity(pid) : null;
        this._onChanged();
    }

    _stopHosting() {
        for (const icon of this.legacy.keys())
            icon.destroy();
        this.legacy.clear();
        this._tray?.unmanage_screen();
        this._tray = null;
        this._watcher?.destroy();
        this._watcher = null;
        this.indicators.clear();
    }

    destroy() {
        this._destroyed = true;
        Gio.DBus.session.unwatch_name(this._watch);
        this._stopHosting();
    }
}
