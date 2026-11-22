// Run with dbus-run-session -- gjs -m tests/applications.js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {applyPinnedIconSettings, collectApplications, resolvePins, sameTrayMenus, trayMenus} from '../applications.js';
import {DesktopUnits, lookupDesktopApp, lookupUnitApp} from '../desktopUnits.js';
import {canClose, closeApplication} from '../processActions.js';
import {wineTrayPrograms} from '../wineApps.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

let windows = [];
function desktopApp(id, flatpakId = null, executable = id.replace(/\.desktop$/, '')) {
    return {
        get_id: () => id,
        get_name: () => id,
        get_app_info: () => ({get_id: () => id, get_executable: () => executable,
            get_string: () => flatpakId, list_actions: () => []}),
        get_windows: () => windows,
    };
}

const telegram = desktopApp('org.telegram.desktop.desktop', 'org.telegram.desktop');
const happ = desktopApp('Happ.desktop');
const appSystem = {
    lookup_app: id => [happ, telegram].find(app => app.get_id() === id) ?? null,
    lookup_startup_wmclass: id => id === 'TelegramDesktop' ? telegram : null,
    lookup_desktop_wmclass: () => null,
    get_installed: () => [happ, telegram].map(app => app.get_app_info()),
    get_running: () => windows.length ? [happ] : [],
};
const sources = {
    appSystem, tracker: {get_app_from_pid: () => null}, pins: [], unknownName: '?',
    tray: {indicators: new Map(), legacy: new Map()}, units: {names: [], background: new Map()}, monitorApps: [],
};

const unit = 'app-flatpak-org.telegram.desktop-4059249839.scope';
const indicator = {
    id: 'TelegramDesktop', isReady: true, hasNameOwner: true, owner: ':1.80', menuPath: '/MenuBar',
};
const telegramSources = {
    ...sources, units: {...sources.units, names: [unit]},
    monitorApps: [{app_id: new GLib.Variant('s', 'org.telegram.desktop')}],
    tray: {indicators: new Map([[indicator, {indicator, owner: indicator.owner, pid: null, process: null}]]),
        legacy: new Map()},
};
assert(lookupUnitApp(appSystem, unit) === telegram, 'Flatpak unit resolves the double suffix');
assert(lookupUnitApp(appSystem, 'app-Happ.scope') === happ &&
    !lookupUnitApp(appSystem, 'app-HappX.scope'), 'Scope without instance keeps the whole app ID');
assert(lookupDesktopApp(appSystem, 'Happ.desktop') === happ, 'Full desktop filename still resolves');
const entries = collectApplications(telegramSources);
const [entry] = entries.values();
assert(entries.size === 1 && entry.app === telegram, 'Portal, systemd and tray share the Telegram row');
assert(entry.key === 'desktop:org.telegram.desktop.desktop', 'Canonical desktop filename');
assert(entry.portalId === entry.flatpakId && entry.units[0] === unit, 'Keeps both quit targets');
assert(canClose(entry) && trayMenus(entry)[0].path === '/MenuBar', 'Menu and quit available together');
const pins = resolvePins(entries, ['sni:TelegramDesktop', 'desktop:org.telegram.desktop', 'sni:offline']);
assert(pins.join() === [entry.key, 'sni:offline'].join(), 'Merge old pins and retain offline pins');

const iconPath = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent()
    .resolve_relative_path('icons/tray-pin-symbolic.svg').get_path();
const otherTrayApp = {key: 'xembed:other', name: 'Other', aliases: [], inBackground: true};
const unpinned = {key: 'xembed:unpinned', name: 'Unpinned', aliases: [], inBackground: true};
const iconEntries = new Map([...entries, [otherTrayApp.key, otherTrayApp], [unpinned.key, unpinned]]);
const iconPins = [...pins, otherTrayApp.key];
const savedIcons = {'sni:TelegramDesktop': ['Telegram', iconPath, true]};
const availableIcons = applyPinnedIconSettings(iconEntries, iconPins, savedIcons, false);
assert(availableIcons.length === 2 && availableIcons[0][0] === 'sni:TelegramDesktop' && entry.iconPath === iconPath &&
    entry.monochromeIcon && !otherTrayApp.monochromeIcon, 'Apply the replacement and monochrome mode to the selected app');
const missingIcon = {...savedIcons, [entry.key]: ['Telegram', `${iconPath}.missing`, false]};
applyPinnedIconSettings(iconEntries, iconPins, missingIcon, true);
assert(!entry.iconPath && entry.monochromeIcon && otherTrayApp.monochromeIcon && !unpinned.monochromeIcon,
    'Use the default icon if the file is missing and apply global monochrome to all pinned apps');

const happUnit = 'app-gnome-Happ-21452.scope';
const desktopUnits = new DesktopUnits(appSystem, new Gio.Cancellable(), () => {});
const happSources = {...sources, units: desktopUnits};
const key = 'desktop:Happ.desktop';
const poll = (startedAt = GLib.get_monotonic_time()) => desktopUnits._updateRunning([happUnit], startedAt);
const listed = () => collectApplications(happSources).get(key).inBackground;
const process = Gio.Subprocess.new(['cat'], Gio.SubprocessFlags.STDIN_PIPE);
const pid = Number(process.get_identifier());
const readFile = GLib.file_get_contents;
const readLink = GLib.file_read_link;
const prefix = '/games/Test Bottle';
const windowsPath = 'C:\\Program Files\\Epic Games\\EpicGamesLauncher.exe';
const epicPath = `${prefix}/drive_c/Program Files/Epic Games/EpicGamesLauncher.exe`;
const sandboxPid = 21452;
// The child is real. Its desktop cgroup is simulated so the test also runs outside systemd.
GLib.file_get_contents = path => {
    const encoder = new TextEncoder();
    if (path === `/proc/${pid}/cgroup`)
        return [true, encoder.encode(`0::/app.slice/${happUnit}\n`)];
    if (path === `/proc/${pid}/status`)
        return [true, encoder.encode(`NSpid:\t${pid}\t${sandboxPid}\n`)];
    if (path === `/proc/${pid}/cmdline`)
        return [true, encoder.encode(`${windowsPath}\0`)];
    if (path === `/proc/${pid}/environ`)
        return [true, encoder.encode(`WINEPREFIX=${prefix}\0`)];
    return readFile(path);
};
GLib.file_read_link = path => {
    if (path === `/proc/${pid}/exe`)
        return '/usr/bin/wine64-preloader';
    if (path === `/proc/${pid}/ns/pid`)
        return 'pid:[1234]';
    return readLink(path);
};
let fallback;
try {
    for (const reportedPid of [sandboxPid, pid]) {
        assert(wineTrayPrograms(reportedPid, 'steam_proton')?.[0]?.program === epicPath,
            'Resolve both sandbox and host PIDs to the exact Windows executable');
    }
    poll();
    assert(!listed(), 'A new launch scope alone never creates a background row');
    const window = {minimized: false, is_skip_taskbar: () => false, get_pid: () => pid};
    windows = [window, window];
    desktopUnits.trackWindows();
    assert(!listed(), 'An ordinary open window stays out');
    assert(collectApplications({...happSources, pins: [key]}).get(key).inBackground, 'Pinned app with a window');
    windows = [window];
    window.minimized = true;
    desktopUnits.trackWindows();
    const beforeClose = GLib.get_monotonic_time();
    poll();
    assert(!listed(), 'A remaining minimized window still counts as an open window');
    windows = [];
    desktopUnits.trackWindows();
    poll(beforeClose);
    assert(!listed(), 'A poll started before the last window closed cannot confirm survival');
    const closedAt = desktopUnits._closed.get(happ.get_id()).closedAt;
    poll(closedAt);
    assert(!listed(), 'A process still shutting down does not immediately appear');
    const afterClose = closedAt + GLib.USEC_PER_SEC;
    poll(afterClose);
    const background = collectApplications(happSources).get(key);
    fallback = trayMenus(background);
    assert(background.inBackground && fallback[0].type === 'desktop' && fallback[0].canQuit,
        'A surviving window process in its own live scope has desktop actions');
    const beforeReopen = GLib.get_monotonic_time();
    windows = [window];
    desktopUnits.trackWindows();
    assert(!listed(), 'Reopening a window clears the windowless fallback immediately');
    windows = [];
    desktopUnits.trackWindows();
    poll(beforeReopen);
    assert(!listed(), 'A second close cannot reuse a poll from the first close');
    process.get_stdin_pipe().close(null);
    await process.wait_check_async(null);
    poll(desktopUnits._closed.get(happ.get_id()).closedAt + GLib.USEC_PER_SEC);
    assert(!listed(), 'An exited window process stays out even if its scope still has helpers');
} finally {
    GLib.file_get_contents = readFile;
    GLib.file_read_link = readLink;
    process.get_stdin_pipe().close(null);
    desktopUnits.destroy();
}

const generic = {...indicator, id: 'status_icon_1', title: '', status: 'Active'};
const trayRecord = {indicator: generic, owner: null, pid: null, process: null, executable: ''};
const launch = {...sources, units: {...sources.units, names: [happUnit]}, pins: [key],
    tray: {indicators: new Map([[generic, trayRecord]]), legacy: new Map()}};
const visible = input => [...collectApplications(input).values()].filter(row => row.inBackground);
assert(visible(launch).length === 1 && !visible(launch)[0].indicators.length,
    'A tray icon waiting for its owner PID does not create a provisional row');
Object.assign(trayRecord, {owner: generic.owner, executable: 'hApP'});
const [resolved, extra] = visible(launch);
assert(!extra && resolved.app === happ && resolved.indicators[0].indicator === generic &&
    resolvePins(new Map([[key, resolved]]), ['sni:status_icon_1'])[0] === key,
    'A generic indicator joins its desktop row before the first tracked window, retaining its menu and pin');
const shared = desktopApp('another.desktop', null, 'Happ');
const ambiguous = {...appSystem, get_installed: () => [...appSystem.get_installed(), shared.get_app_info()]};
const standalone = visible({...launch, appSystem: ambiguous, pins: []});
assert(standalone.length === 1 && !standalone[0].app, 'A shared executable cannot identify a desktop app');
trayRecord.executable = '';
assert(visible({...launch, pins: []})[0]?.key === 'sni:status_icon_1', 'A tray-only app survives failed PID lookup');
generic.status = 'Passive';
assert(!visible({...launch, pins: []}).length, 'A passive indicator and launch scope alone stay out');
const legacyIcon = {pid: 0, wm_class: 'Happ'};
const menus = trayMenus({...resolved, indicators: [], legacy: [{icon: legacyIcon}]});
assert(menus.length === 1 && menus[0].type === 'xembed' && !sameTrayMenus(fallback, menus),
    'A real tray menu replaces the fallback');

const launcherInfo = (id, name, command) => ({
    get_id: () => id,
    get_name: () => name,
    get_commandline: () => command,
});
const epic = desktopApp('Epic Games Launcher.desktop');
const wineIcon = {pid: 827, wm_class: 'steam_proton'};
const wineIdentity = {pid: wineIcon.pid, started: '1'};
const other = launcherInfo('other.desktop', 'Other', 'wine /other/Game.exe');
const wineSources = (installed, wine) => ({...sources,
    appSystem: {...appSystem, lookup_app: id => id === epic.get_id() ? epic : appSystem.lookup_app(id),
        get_installed: () => [...installed, other]},
    tracker: {get_app_from_pid: () => happ},
    tray: {...sources.tray, legacy: new Map([[wineIcon, {process: wineIdentity, wine}]])},
});
const wineProgram = {command: windowsPath, prefix, ids: [], program: epicPath};
const cases = [
    ['PortProton', `flatpak run ru.linux_gaming.PortProton ${GLib.shell_quote(epicPath)}`, wineProgram],
    ['Wine', `env WINEPREFIX=${GLib.shell_quote(prefix)} wine ${GLib.shell_quote(windowsPath)}`, wineProgram],
    ['Custom runner', `my-runner --launch ${GLib.shell_quote(epicPath)}`, wineProgram],
    ['Steam', 'steam steam://rungameid/1234567890123456789', {...wineProgram, ids: ['1234567890123456789']}],
    ['Steam -applaunch', 'flatpak run com.valvesoftware.Steam -applaunch 42', {...wineProgram, ids: ['42']}],
    ['Lutris', 'flatpak run net.lutris.Lutris lutris:rungameid/42', {...wineProgram, lutrisName: 'Epic'}],
    ['Bottles', "flatpak run --command=bottles-cli com.usebottles.bottles run -p 'Epic Games Launcher' -b 'Test Bottle'",
        wineProgram],
];
for (const [runner, command, wine] of cases) {
    const entries = collectApplications(wineSources([launcherInfo(epic.get_id(), 'Epic', command)], [wine]));
    const [wineEntry] = entries.values();
    assert(wineEntry.app === epic && trayMenus(wineEntry)[0].icon === wineIcon && !canClose(wineEntry) &&
        resolvePins(entries, ['xembed:steam_proton'])[0] === wineEntry.key,
        `${runner} uses the launcher without treating an ambiguous PID or Wine Explorer as a quit target`);
}
const epicLauncher = launcherInfo(epic.get_id(), 'Epic', `wine ${GLib.shell_quote(epicPath)}`);
const directWine = {...wineSources([epicLauncher], [{...wineProgram, pid: wineIcon.pid}]),
    tracker: {get_app_from_pid: () => epic}};
assert(canClose(visible(directWine)[0]), 'An independently verified Wine host process keeps its quit action');
const duplicate = launcherInfo('duplicate.desktop', 'Duplicate', `wine ${GLib.shell_quote(epicPath)}`);
for (const input of [wineSources([epicLauncher, duplicate], [wineProgram]),
    wineSources([epicLauncher], [wineProgram, {...wineProgram, program: '/other/Game.exe'}]),
    wineSources([epicLauncher], [])]) {
    assert(!visible(input)[0]?.app, 'Ambiguous Wine metadata leaves the tray entry independent');
}

const nativeSources = {...sources, tray: {...sources.tray,
    legacy: new Map([[{pid: 0, wm_class: 'TelegramDesktop'}, {process: null, wine: null}]])}};
assert(visible(nativeSources)[0]?.app === telegram, 'Native XEmbed icons still match their desktop class');

const name = 'org.example.TrayTest';
const nativeInfo = {
    list_actions: () => ['quit'],
    launch_action() { throw new Error('A desktop quit action can launch the app'); },
};
const nativeEntry = {...entry, units: [], portalId: null, flatpakId: null,
    app: {get_id: () => `${name}.desktop`, get_app_info: () => nativeInfo}};
assert(canClose(nativeEntry), 'A desktop app with a D-Bus ID and quit action can quit');
for (const flatpakId of [null, name]) {
    let stoppedUnits;
    await closeApplication({...nativeEntry, flatpakId, units: [unit]}, {
        stop(targets) { stoppedUnits = targets; return true; },
    }, new Gio.Cancellable());
    assert(stoppedUnits?.[0] === unit, 'Without a live bus owner, quit falls back to stopping the unit');
}

const trayOnly = {...nativeEntry, app: null, indicators: [],
    legacy: [{process: {pid: 101, started: '1'}}, {process: {pid: 101, started: '1'}}]};
assert(canClose(trayOnly), 'Two tray registrations from the same process can quit');
const ambiguousTray = {...trayOnly, legacy: [...trayOnly.legacy, {process: {pid: 102, started: '2'}}]};
assert(!canClose(ambiguousTray), 'A shared tray row cannot quit two processes');
await closeApplication(ambiguousTray, null, new Gio.Cancellable())
    .then(() => { throw new Error('An ambiguous tray row was allowed to quit'); }, error => {
        assert(error.message === 'No unique tray process could be identified',
            'Rejects an ambiguous row before looking up or signaling its processes');
    });

const bus = Gio.DBus.session;
const path = '/org/example/TrayTest';
let quit = false;
const actions = Gio.DBusExportedObject.wrapJSObject(
    '<node><interface name="org.gtk.Actions"><method name="Describe"><arg type="s" direction="in"/>' +
    '<arg type="(bgav)" direction="out"/></method></interface></node>',
    {Describe: action => [action === 'quit', '', []]});
const app = Gio.DBusExportedObject.wrapJSObject(
    '<node><interface name="org.freedesktop.Application"><method name="ActivateAction">' +
    '<arg type="s" direction="in"/><arg type="av" direction="in"/>' +
    '<arg type="a{sv}" direction="in"/></method></interface></node>',
    {ActivateAction(action) { quit = action === 'quit'; }});
const systemd = Gio.DBusExportedObject.wrapJSObject(
    '<node><interface name="org.freedesktop.systemd1.Manager"><method name="StopUnit">' +
    '<arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="o" direction="out"/>' +
    '</method></interface></node>', {
        StopUnitAsync([target], invocation) {
            if (target === unit)
                invocation.return_value(new GLib.Variant('(o)', ['/job/1']));
            else
                invocation.return_dbus_error('org.freedesktop.systemd1.NoSuchUnit', target);
        },
    });
actions.export(bus, path);
app.export(bus, path);
systemd.export(bus, '/org/freedesktop/systemd1');
let nameId;
try {
    await new Promise((resolve, reject) => {
        nameId = bus.own_name(name, Gio.BusNameOwnerFlags.NONE, resolve, reject);
    });
    await closeApplication({...entry, flatpakId: name}, {
        stop() { throw new Error('Force stop ran before the application quit action'); },
    }, new Gio.Cancellable());
    assert(quit, 'Quit invokes the D-Bus action on the Flatpak application');
    quit = false;
    await closeApplication(nativeEntry, null, new Gio.Cancellable());
    assert(quit, 'Quit invokes the D-Bus action on the native application');
    const targets = [unit, 'app-test-missing.scope'];
    const manager = {_owner: name, _cancellable: new Gio.Cancellable(), names: targets, refresh() {}};
    assert(!await DesktopUnits.prototype.stop.call(manager, targets), 'A partial stop allows other quit methods');
} finally {
    bus.unown_name(nameId);
    systemd.unexport();
    app.unexport();
    actions.unexport();
}
print('Application rows, pins, menus and D-Bus quit passed');
