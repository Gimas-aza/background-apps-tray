/* SPDX-License-Identifier: GPL-2.0-or-later */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {collectApplications, resolvePins} from './applications.js';
import {DesktopUnits} from './desktopUnits.js';
import {BackgroundMenu, clearLegacyMenu, PanelPins} from './menuView.js';
import {canClose, closeApplication} from './processActions.js';
import {TrayHost} from './trayHost.js';
import * as Interfaces from './vendor/interfaces.js';
import {Logger} from './vendor/logger.js';
import {SettingsManager} from './vendor/settingsManager.js';

const PIN_KEY = 'pinned-apps';

class BackgroundAppsController {
    constructor(extension, toggle) {
        this._extension = extension;
        this._toggle = toggle;
        this._settings = extension.getSettings();
        this._cancellable = new Gio.Cancellable();
        this._appSystem = Shell.AppSystem.get_default();
        this._tracker = Shell.WindowTracker.get_default();
        this._refreshId = 0;
        this._connections = [];
        this._entries = new Map();
        this._busy = new Set();
        this._count = 0;
    }

    start() {
        const extension = this._extension;
        const toggle = this._toggle;
        const t = extension.gettext.bind(extension);

        const actions = {
            pin: key => this._togglePin(key),
            close: key => this._close(key),
            reportError: error => this._reportMenuError(error),
        };
        this._menu = new BackgroundMenu(toggle, actions, t);
        this._panelPins = new PanelPins(t, actions);
        this._units = new DesktopUnits(this._cancellable, () => this._queueRefresh());
        this._tray = new TrayHost(extension, this._cancellable, () => this._queueRefresh());

        this._originalSync = toggle._sync;
        this._originalVisibility = toggle._syncVisibility;
        this._onSync = () => this._queueRefresh();
        this._onVisibility = () => this._syncVisibility();
        toggle._sync = this._onSync;
        toggle._syncVisibility = this._onVisibility;

        this._connect(this._settings, `changed::${PIN_KEY}`, () => this._queueRefresh());
        this._connect(this._appSystem, 'app-state-changed', () => this._queueRefresh());
        this._connect(this._appSystem, 'installed-changed', () => this._queueRefresh());
        this._connect(this._tracker, 'tracked-windows-changed', () => this._queueRefresh());
        this._connect(global.window_manager, 'minimize', () => this._queueRefresh());
        this._connect(toggle, 'destroy', () => this._cancellable.cancel());
        this._connect(toggle.menu, 'open-state-changed', (_menu, open) => {
            if (open) {
                this._units.refresh();
                this._queueRefresh();
            }
        });
        this._sync();
    }

    _connect(object, signal, callback) {
        this._connections.push([object, object.connect(signal, callback)]);
    }

    _queueRefresh() {
        if (this._cancellable.is_cancelled() || this._refreshId)
            return;

        this._refreshId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._refreshId = 0;
            if (!this._cancellable.is_cancelled())
                this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        const savedPins = this._settings.get_strv(PIN_KEY);
        const monitorApps = this._toggle._proxy?.BackgroundApps;
        this._entries = collectApplications({
            appSystem: this._appSystem, tracker: this._tracker, monitorApps,
            tray: this._tray, units: this._units, pins: savedPins,
            unknownName: this._extension.gettext('Application'), previousEntries: this._entries,
        });
        const pins = resolvePins(this._entries, savedPins);
        if (pins.length !== savedPins.length || pins.some((pin, i) => pin !== savedPins[i]))
            this._settings.set_strv(PIN_KEY, pins);
        this._count = this._menu.update(this._entries, pins, this._busy, this._tray.conflict);
        this._panelPins.update(this._entries, pins);

        this._toggle.title = this._count
            ? this._extension.ngettext('%d Background App', '%d Background Apps', this._count)
                .replace('%d', String(this._count))
            : this._extension.gettext('No Background Apps');
        this._syncVisibility();
    }

    _syncVisibility() {
        this._toggle.visible = !Main.sessionMode.isLocked &&
            (this._toggle.menu.isOpen || this._count > 0 || this._tray.conflict);
    }

    _togglePin(key) {
        if (!this._entries.has(key))
            return;

        const pins = this._settings.get_strv(PIN_KEY);
        const next = pins.includes(key) ? pins.filter(pin => pin !== key) : [...pins, key];
        this._settings.set_strv(PIN_KEY, next);
    }

    async _close(key) {
        const entry = this._entries.get(key);
        if (!entry || this._busy.has(key) || !canClose(entry))
            return;

        this._busy.add(key);
        this._queueRefresh();
        try {
            await closeApplication(entry, this._units, this._cancellable);
        } catch (error) {
            if (!this._cancellable.is_cancelled() && this._entries.has(key)) {
                Main.notify(this._extension.gettext('Could not quit application'), entry.name);
                console.warn(`Background Apps Tray: ${error.message}`);
            }
        } finally {
            this._busy.delete(key);
            this._queueRefresh();
        }
    }

    _reportMenuError(error) {
        if (!this._cancellable.is_cancelled()) {
            Main.notify(this._extension.gettext('Could not open the tray menu'));
            console.warn(`Background Apps Tray: ${error.message}`);
        }
    }

    destroy() {
        this._cancellable.cancel();
        clearLegacyMenu();
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        for (const [object, id] of this._connections)
            object.disconnect(id);

        this._menu?.destroy();
        this._panelPins?.destroy();
        this._tray?.destroy();
        this._units?.destroy();

        const toggle = this._toggle;
        if (toggle._syncVisibility === this._onVisibility)
            toggle._syncVisibility = this._originalVisibility;
        if (toggle._sync === this._onSync)
            toggle._sync = this._originalSync;
        toggle._sync();
    }
}

export default class BackgroundAppsTrayExtension extends Extension {
    enable() {
        // The panel creates its Quick Settings indicators after lazy imports.
        if (this._tryAttach())
            return;

        this._attachTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            try {
                if (!this._tryAttach())
                    return GLib.SOURCE_CONTINUE;
            } catch (error) {
                logError(error, 'Background Apps Tray');
            }
            this._attachTimeout = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _tryAttach() {
        const toggle = Main.panel.statusArea.quickSettings?._backgroundApps?.quickSettingsItems[0];
        if (!toggle)
            return false;
        if (!toggle._appsSection || !toggle._listTitle ||
            typeof toggle._sync !== 'function' || typeof toggle._syncVisibility !== 'function')
            throw new Error('The native Background Apps menu has an unsupported structure');

        try {
            this.initTranslations();
            Logger.init(this);
            Interfaces.initialize(this);
            SettingsManager.initialize(this);
            this._controller = new BackgroundAppsController(this, toggle);
            this._controller.start();
        } catch (error) {
            this._detach();
            throw error;
        }
        return true;
    }

    _detach() {
        this._controller?.destroy();
        this._controller = null;
        if (SettingsManager.getDefault())
            SettingsManager.destroy();
        Interfaces.destroy();
    }

    disable() {
        if (this._attachTimeout) {
            GLib.source_remove(this._attachTimeout);
            this._attachTimeout = 0;
        }
        this._detach();
    }
}
