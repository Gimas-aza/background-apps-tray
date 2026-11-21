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
function desktopApp(id, flatpakId = null) {
    return {
        get_id: () => id,
        get_name: () => id,
        get_app_info: () => ({get_string: () => flatpakId, list_actions: () => []}),
        get_windows: () => windows,
    };
}

const telegram = desktopApp('org.telegram.desktop.desktop', 'org.telegram.desktop');
const happ = desktopApp('Happ.desktop');
const appSystem = {
    lookup_app: id => [happ, telegram].find(app => app.get_id() === id) ?? null,
    lookup_startup_wmclass: id => id === 'TelegramDesktop' ? telegram : null,
    get_running: () => [],
};
const sources = {
    appSystem, tracker: {get_app_from_pid: () => null}, pins: [], unknownName: '?',
    tray: {indicators: new Map(), legacy: new Map()}, units: {names: []}, monitorApps: [],
};

const unit = 'app-flatpak-org.telegram.desktop-4059249839.scope';
const indicator = {
    id: 'TelegramDesktop', isReady: true, hasNameOwner: true, owner: ':1.80', menuPath: '/MenuBar',
};
const telegramSources = {
    ...sources, units: {names: [unit]},
    monitorApps: [{app_id: new GLib.Variant('s', 'org.telegram.desktop')}],
    tray: {indicators: new Map([[indicator, {indicator, pid: null, process: null}]]), legacy: new Map()},
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
const happSources = {...sources, units: {names: [happUnit]}};
const key = 'desktop:Happ.desktop';
const background = collectApplications(happSources);
const fallback = trayMenus(background.get(key));
assert(background.get(key).inBackground && fallback[0].type === 'desktop' && fallback[0].canQuit,
    'Happ without an exported menu still has application actions');
windows = [{minimized: false, is_skip_taskbar: () => false}];
const foreground = collectApplications({...happSources, previousEntries: background});
assert(foreground.get(key).inBackground, 'Opening a window keeps the same running app listed');
assert(!collectApplications(happSources).get(key).inBackground, 'Ordinary foreground apps stay out');
assert(collectApplications({...happSources, pins: [key]}).get(key).inBackground, 'Pinned app with a window');
const restarted = collectApplications({...happSources, units: {names: ['app-gnome-Happ-42.scope']},
    previousEntries: foreground});
assert(!restarted.get(key).inBackground, 'A new foreground instance does not inherit the old row');
windows[0].minimized = true;
assert(collectApplications(happSources).get(key).inBackground, 'Minimized window counts as background');
const legacyIcon = {pid: 0, wm_class: 'Happ'};
const menus = trayMenus({...background.get(key), legacy: [{icon: legacyIcon}]});
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
