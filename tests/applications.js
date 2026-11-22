// Run with dbus-run-session -- gjs -m tests/applications.js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {collectApplications, resolvePins, sameTrayMenus, trayMenus} from '../applications.js';
import {DesktopUnits, lookupDesktopApp, lookupUnitApp} from '../desktopUnits.js';
import {canClose, closeApplication} from '../processActions.js';

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

const happUnit = 'app-gnome-Happ-21452.scope';
const desktopUnits = new DesktopUnits(appSystem, new Gio.Cancellable(), () => {});
const happSources = {...sources, units: desktopUnits};
const key = 'desktop:Happ.desktop';
const poll = (startedAt = GLib.get_monotonic_time()) => desktopUnits._updateRunning([happUnit], startedAt);
const listed = () => collectApplications(happSources).get(key).inBackground;
const process = Gio.Subprocess.new(['cat'], Gio.SubprocessFlags.STDIN_PIPE);
const pid = Number(process.get_identifier());
const readFile = GLib.file_get_contents;
// The child is real. Its desktop cgroup is simulated so the test also runs outside systemd.
GLib.file_get_contents = path => path === `/proc/${pid}/cgroup`
    ? [true, new TextEncoder().encode(`0::/app.slice/${happUnit}\n`)] : readFile(path);
let fallback;
try {
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
