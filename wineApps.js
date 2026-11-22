/* SPDX-License-Identifier: GPL-2.0-or-later */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {processExecutable, processIdentity} from './processActions.js';

const decoder = new TextDecoder();
const wineLoader = /^wine(?:64)?(?:-preloader)?$/;
const sharedClass = /^(steam_proton|wine(?:64)?|explorer(?:\.exe)?)$/i;

function readProcess(pid, file) {
    const [, bytes] = GLib.file_get_contents(`/proc/${pid}/${file}`);
    return decoder.decode(bytes);
}

function programName(path) {
    return GLib.path_get_basename(path.replaceAll('\\', '/'));
}

function programPath(path, prefix) {
    if (!/\.exe$/i.test(path))
        return null;
    if (GLib.path_is_absolute(path))
        return GLib.canonicalize_filename(path, null);

    const windows = /^([a-z]):\/(.*)$/i.exec(path.replaceAll('\\', '/'));
    if (!windows)
        return null;
    const [, letter, relative] = windows;
    const drive = letter.toLowerCase();
    const devices = `${prefix}/dosdevices`;
    try {
        const root = GLib.file_read_link(`${devices}/${drive}:`);
        return GLib.canonicalize_filename(`${root}/${relative}`, devices);
    } catch {
        return drive === 'c' ? GLib.canonicalize_filename(`${prefix}/drive_c/${relative}`, null) : null;
    }
}

function wineProgram(pid) {
    try {
        const [command] = readProcess(pid, 'cmdline').split('\0');
        const env = new Map(readProcess(pid, 'environ').split('\0').flatMap(arg => {
            const separator = arg.indexOf('=');
            return separator > 0 ? [[arg.slice(0, separator), arg.slice(separator + 1)]] : [];
        }));
        const home = env.get('HOME') || GLib.get_home_dir();
        const prefix = GLib.canonicalize_filename(env.get('WINEPREFIX') || `${home}/.wine`, null);
        const systemProgram = /^[a-z]:[\\/]windows[\\/]/i.test(command);
        const ids = ['SteamGameId', 'SteamAppId', 'STEAM_COMPAT_APP_ID'].map(key => env.get(key))
            .filter(id => /^[1-9]\d{0,19}$/.test(id));
        return {
            pid, prefix, namespace: GLib.file_read_link(`/proc/${pid}/ns/pid`),
            command, program: systemProgram ? null : programPath(command, prefix),
            ids, lutrisName: env.has('LUTRIS_GAME_UUID') ? env.get('GAME_NAME') : null,
            desktopFile: env.get('GIO_LAUNCHED_DESKTOP_FILE'),
        };
    } catch {
        return null;
    }
}

// An empty list keeps unresolved Wine metadata separate from an ordinary XEmbed PID.
export function wineTrayPrograms(pid, wmClass, identity) {
    if (!Number.isSafeInteger(pid) || pid <= 1)
        return null;

    const hostWine = wineLoader.test(processExecutable(pid));
    const generic = sharedClass.test(wmClass ?? '');
    if (identity && !hostWine && !generic && !/\.exe$/i.test(wmClass ?? ''))
        return null;

    const pids = [];
    const owners = [];
    try {
        const processes = Gio.File.new_for_path('/proc').enumerate_children('standard::name',
            Gio.FileQueryInfoFlags.NONE, null);
        try {
            for (let info; (info = processes.next_file(null));) {
                const hostPid = Number(info.get_name());
                if (!Number.isSafeInteger(hostPid) || hostPid <= 1 ||
                    !wineLoader.test(processExecutable(hostPid)) || !processIdentity(hostPid))
                    continue;

                pids.push(hostPid);
                try {
                    // An XEmbed client can publish its PID from inside a sandbox.
                    const line = /^NSpid:[ \t]*([\d\t ]+)$/m.exec(readProcess(hostPid, 'status'));
                    const localPid = line?.[1].trim().split(/\s+/).at(-1);
                    if (hostPid === pid || localPid === String(pid))
                        owners.push(hostPid);
                } catch {
                    // The process can exit while /proc is being scanned.
                }
            }
        } finally {
            processes.close(null);
        }
    } catch {
        return hostWine || generic ? [] : null;
    }

    if (owners.length !== 1)
        return owners.length || generic || hostWine ? [] : null;

    const owner = wineProgram(owners[0]);
    if (!owner)
        return [];
    if (programName(owner.command).toLowerCase() !== 'explorer.exe')
        return [owner];

    // Wine Explorer can host icons for several programs in the same prefix.
    const peers = pids.filter(other => other !== owners[0]).map(wineProgram).filter(other =>
        other?.program && other.prefix === owner.prefix && other.namespace === owner.namespace);
    return peers.length ? peers : [{...owner, lutrisName: null, desktopFile: null}];
}

function optionValue(args, short, long) {
    const index = args.findIndex(arg => arg === short || arg === long || arg.startsWith(`${long}=`));
    if (index < 0)
        return null;
    return args[index].startsWith(`${long}=`) ? args[index].slice(long.length + 1) : args[index + 1];
}

function bottleProgramName(name) {
    return name?.toLowerCase().replace(/\.exe$/i, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

function matchesProgram(info, args, wine) {
    const prefix = args.find(arg => arg.startsWith('WINEPREFIX='))?.slice('WINEPREFIX='.length);
    if (prefix && GLib.canonicalize_filename(prefix, null) !== wine.prefix)
        return false;
    if (wine.program && args.some(arg => programPath(arg, wine.prefix) === wine.program))
        return true;

    const steamUriId = args.map(arg => /^steam:\/\/(?:rungameid|run)\/(\d+)(?:\/.*)?$/i.exec(arg)?.[1])
        .find(Boolean);
    const steamCommand = args.some(arg => programName(arg) === 'steam' || arg === 'com.valvesoftware.Steam');
    const steamId = steamUriId ?? (steamCommand ? optionValue(args, '-applaunch', '--applaunch') : null);
    if (wine.ids.includes(steamId))
        return true;

    if (wine.lutrisName && wine.lutrisName.trim() === info.get_name()?.trim() &&
        args.some(arg => /^lutris:(?:\/\/)?rungame(?:id)?\//i.test(arg)))
        return true;

    if (!args.some(arg => programName(arg) === 'bottles-cli' || arg === '--command=bottles-cli'))
        return false;
    const bottle = optionValue(args, '-b', '--bottle');
    const program = bottleProgramName(optionValue(args, '-p', '--program'));
    return !!program && bottle === GLib.path_get_basename(wine.prefix) &&
        (program === bottleProgramName(programName(wine.command)) ||
            (!!wine.desktopFile && info.get_filename?.() === wine.desktopFile));
}

export function wineDesktopApp(appSystem, icon, programs) {
    const wmClass = icon.wm_class;
    if (wmClass && !sharedClass.test(wmClass)) {
        const app = appSystem.lookup_startup_wmclass(wmClass) ?? appSystem.lookup_desktop_wmclass(wmClass);
        if (app)
            return app;
    }
    if (!programs.length)
        return null;

    const matches = appSystem.get_installed().filter(info => {
        try {
            const [, args] = GLib.shell_parse_argv(info.get_commandline());
            return programs.some(wine => matchesProgram(info, args, wine));
        } catch {
            return false;
        }
    });
    return matches.length === 1 ? appSystem.lookup_app(matches[0].get_id()) : null;
}
