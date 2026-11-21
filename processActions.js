/* SPDX-License-Identifier: GPL-2.0-or-later */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {getProcessId, getUniqueBusName} from './vendor/dbusUtils.js';

Gio._promisify(Gio.Subprocess.prototype, 'wait_check_async');

const credentials = new Gio.Credentials();
const currentUid = credentials.get_unix_user();
const shellPid = credentials.get_unix_pid();
const decoder = new TextDecoder();

export function callSession(name, path, iface, method, parameters, resultType, cancellable) {
    return Gio.DBus.session.call(name, path, iface, method, parameters,
        resultType ? new GLib.VariantType(resultType) : null,
        Gio.DBusCallFlags.NO_AUTO_START, 3000, cancellable);
}

export function processIdentity(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === shellPid)
        return null;

    try {
        const directory = Gio.File.new_for_path(`/proc/${pid}`);
        const info = directory.query_info('unix::uid', Gio.FileQueryInfoFlags.NONE, null);
        if (info.get_attribute_uint32('unix::uid') !== currentUid)
            return null;

        const [, bytes] = GLib.file_get_contents(`/proc/${pid}/stat`);
        const stat = decoder.decode(bytes);
        // The process name may contain spaces and parentheses. Start time is field 22.
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        if (!fields[19] || fields[0] === 'Z')
            return null;

        return {pid, started: fields[19]};
    } catch {
        return null;
    }
}

export function processAppUnits(pid) {
    try {
        const [, bytes] = GLib.file_get_contents(`/proc/${pid}/cgroup`);
        return decoder.decode(bytes).split(/[\/\n]/)
            .filter(unit => /^app-.+\.(scope|service)$/.test(unit));
    } catch {
        return [];
    }
}

export function processExecutable(pid) {
    try {
        const executable = GLib.file_read_link(`/proc/${pid}/exe`);
        return GLib.path_get_basename(executable);
    } catch {
        return '';
    }
}

async function waitCommand(argv, cancellable) {
    const process = Gio.Subprocess.new(argv,
        Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
    await process.wait_check_async(cancellable);
}

async function terminateTargets(targets, cancellable) {
    const program = GLib.find_program_in_path('kill');
    if (!program)
        return false;

    const pids = new Set();
    for (const {pid, started} of targets) {
        if (processIdentity(pid)?.started === started)
            pids.add(String(pid));
    }
    if (pids.size === 0 || cancellable.is_cancelled())
        return false;

    await waitCommand([program, '-TERM', '--', ...pids], cancellable);
    return true;
}

async function requestAppQuit(appId, cancellable) {
    if (!appId || !Gio.dbus_is_name(appId))
        return false;
    const path = `/${appId.replaceAll('.', '/').replaceAll('-', '_')}`;
    if (!GLib.Variant.is_object_path(path))
        return false;

    try {
        const owner = await getUniqueBusName(Gio.DBus.session, appId, cancellable);
        const result = await callSession(owner, path, 'org.gtk.Actions',
            'Describe', new GLib.Variant('(s)', ['quit']), '((bgav))', cancellable);
        const [[enabled, signature]] = result.deep_unpack();
        if (!enabled || signature !== '')
            return false;

        await callSession(owner, path, 'org.freedesktop.Application', 'ActivateAction',
            new GLib.Variant('(sava{sv})', ['quit', [], {}]), '()', cancellable);
        return true;
    } catch {
        return false;
    }
}

function desktopQuitId(app) {
    if (!app?.get_app_info()?.list_actions().includes('quit'))
        return null;

    const id = app.get_id().replace(/\.desktop$/, '');
    return Gio.Application.id_is_valid(id) ? id : null;
}

function hasSingleTrayProcess(entry) {
    const pids = new Set();
    for (const {process} of [...entry.indicators, ...entry.legacy]) {
        if (process)
            pids.add(process.pid);
    }
    return pids.size === 1;
}

export function canClose(entry) {
    return entry.units.length > 0 || !!entry.portalId || !!entry.flatpakId ||
        hasSingleTrayProcess(entry) || !!desktopQuitId(entry.app);
}

export async function closeApplication(entry, units, cancellable) {
    const flatpakId = entry.flatpakId ?? entry.portalId;
    // A desktop action can spawn another instance, even when the action is named quit.
    const quitId = flatpakId ?? desktopQuitId(entry.app);
    if (quitId && await requestAppQuit(quitId, cancellable))
        return;
    if (cancellable.is_cancelled())
        return;

    if (entry.units.length && await units.stop(entry.units))
        return;

    const flatpak = GLib.find_program_in_path('flatpak');
    if (flatpakId && flatpak && !cancellable.is_cancelled()) {
        try {
            await waitCommand([flatpak, 'kill', '--', flatpakId], cancellable);
            return;
        } catch (error) {
            if (cancellable.is_cancelled())
                throw error;
        }
    }

    if (!hasSingleTrayProcess(entry))
        throw new Error('No unique tray process could be identified');

    const targets = entry.legacy.flatMap(item => item.process ? [item.process] : []);
    await Promise.all(entry.indicators.map(async item => {
        const {indicator, process, owner} = item;
        if (!process || !owner || indicator.owner !== owner)
            return;
        try {
            if (await getProcessId(owner, cancellable) === process.pid &&
                indicator.owner === owner)
                targets.push(process);
        } catch (error) {
            if (!error.matches?.(Gio.DBusError, Gio.DBusError.NAME_HAS_NO_OWNER) &&
                !cancellable.is_cancelled())
                console.debug(`Background Apps Tray: ${error.message}`);
        }
    }));

    if (await terminateTargets(targets, cancellable))
        return;

    throw new Error('No live application process could be identified');
}
