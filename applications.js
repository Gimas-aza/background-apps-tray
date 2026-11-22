/* SPDX-License-Identifier: GPL-2.0-or-later */
import GLib from 'gi://GLib';

import {lookupDesktopApp, lookupUnitApp} from './desktopUnits.js';
import {canClose, processAppUnits, processExecutable} from './processActions.js';

function cleanText(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function variantValue(value) {
    return value?.deep_unpack?.() ?? value;
}

function trackedAppForPid(tracker, pid) {
    const tracked = pid ? tracker.get_app_from_pid(pid) : null;
    return tracked?.get_app_info() ? tracked : null;
}

function unitAppForPid(appSystem, pid) {
    if (!pid)
        return null;

    for (const unit of processAppUnits(pid)) {
        const app = lookupUnitApp(appSystem, unit);
        if (app)
            return app;
    }
    return null;
}

function appForExecutable(appSystem, entries, executable) {
    if (!executable || !entries.size)
        return null;

    const name = executable.toLowerCase();
    const matches = appSystem.get_installed().filter(info => {
        const command = info.get_executable();
        return command && GLib.path_get_basename(command).toLowerCase() === name;
    });
    // Shared runtimes can have their own scope. Require a single launcher and independent app evidence.
    return matches.length === 1 ? entries.get(`desktop:${matches[0].get_id()}`)?.app : null;
}

function legacyMatchesProcess(icon, app, processApp) {
    if (app && app.get_id() === processApp?.get_id())
        return true;

    const executable = processExecutable(icon.pid);
    if (!executable)
        return false;

    const desktopExecutable = app?.get_app_info()?.get_executable();
    return executable.toLowerCase() === icon.wm_class?.toLowerCase() ||
        (desktopExecutable && executable === GLib.path_get_basename(desktopExecutable));
}

export function collectApplications({
    appSystem, tracker, monitorApps, tray, units, pins, unknownName,
}) {
    const entries = new Map();
    const pinKeys = new Set(pins);
    const ensureEntry = (key, name, app) => {
        if (!entries.has(key)) {
            entries.set(key, {
                key, name: cleanText(app?.get_name() || name) || unknownName, app,
                message: '', portalId: null, inBackground: false,
                flatpakId: app?.get_app_info()?.get_string?.('X-Flatpak') || null,
                units: [], indicators: [], legacy: [], aliases: [],
            });
        }
        return entries.get(key);
    };

    for (const info of monitorApps ?? []) {
        const id = variantValue(info.app_id);
        if (typeof id !== 'string' || !id)
            continue;
        const app = lookupDesktopApp(appSystem, id);
        const filename = `${id}.desktop`;
        const entry = ensureEntry(`desktop:${app?.get_id() ?? filename}`, id, app);
        entry.aliases.push(`desktop:${id.endsWith('.desktop') ? id : filename}`);
        entry.portalId = id;
        entry.inBackground = true;
        entry.message ||= cleanText(variantValue(info.message));
    }

    for (const unit of units.names) {
        const app = lookupUnitApp(appSystem, unit);
        if (!app)
            continue;
        const key = `desktop:${app.get_id()}`;
        const entry = ensureEntry(key, null, app);
        entry.units.push(unit);
        entry.inBackground ||= pinKeys.has(key) || units.background.get(unit) === app.get_id();
    }

    for (const app of appSystem.get_running()) {
        if (!app.get_app_info())
            continue;

        const key = `desktop:${app.get_id()}`;
        if (pinKeys.has(key))
            ensureEntry(key, null, app).inBackground = true;
    }

    for (const record of tray.indicators.values()) {
        const {indicator, owner, pid, process, executable} = record;
        if (!indicator.isReady || !indicator.hasNameOwner || owner !== indicator.owner ||
            indicator.status === 'Passive')
            continue;

        const app = trackedAppForPid(tracker, pid) ??
            lookupDesktopApp(appSystem, indicator.id) ??
            lookupDesktopApp(appSystem, indicator.busName) ??
            appSystem.lookup_startup_wmclass(indicator.id) ??
            appForExecutable(appSystem, entries, executable) ??
            unitAppForPid(appSystem, pid);
        const alias = `sni:${indicator.id}`;
        const key = app ? `desktop:${app.get_id()}` : alias;
        const entry = ensureEntry(key, indicator.title || indicator.id, app);
        entry.aliases.push(alias);
        entry.indicators.push({
            indicator, process, owner, path: indicator.menuPath,
            contextMenu: indicator.supportsContextMenu !== false,
        });
        entry.inBackground = true;
    }

    for (const [icon, identity] of tray.legacy) {
        const processApp = trackedAppForPid(tracker, icon.pid) ?? unitAppForPid(appSystem, icon.pid);
        const app = (icon.wm_class && (
            appSystem.lookup_startup_wmclass(icon.wm_class) ??
            appSystem.lookup_desktop_wmclass(icon.wm_class))) || processApp;
        const alias = `xembed:${icon.wm_class || icon.title || 'tray-icon'}`;
        const key = app ? `desktop:${app.get_id()}` : alias;
        const entry = ensureEntry(key, icon.title || icon.wm_class, app);
        entry.aliases.push(alias);
        const process = legacyMatchesProcess(icon, app, processApp)
            ? identity : null;
        entry.legacy.push({icon, process});
        entry.inBackground = true;
    }

    return entries;
}

export function resolvePins(entries, pins) {
    return [...new Set(pins.map(pin => {
        if (entries.has(pin))
            return pin;
        const matches = [...entries.values()].filter(entry => entry.aliases.includes(pin));
        return matches.length === 1 ? matches[0].key : pin;
    }))];
}

export function trayMenus(entry) {
    const menus = entry.indicators.flatMap(record => {
        if (record.path)
            return [{type: 'dbusmenu', ...record}];
        if (record.contextMenu)
            return [{type: 'context', ...record}];
        return [];
    });
    menus.push(...entry.legacy.map(record => ({type: 'xembed', ...record})));
    if (!menus.length && entry.app)
        menus.push({type: 'desktop', app: entry.app, key: entry.key, canQuit: canClose(entry)});
    return menus;
}

export function sameTrayMenus(first, second) {
    return first.length === second.length && first.every((menu, index) => {
        const other = second[index];
        return menu.type === other.type && menu.indicator === other.indicator &&
            menu.path === other.path && menu.owner === other.owner && menu.icon === other.icon &&
            menu.app === other.app && menu.canQuit === other.canQuit;
    });
}
