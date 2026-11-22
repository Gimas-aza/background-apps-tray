/* SPDX-License-Identifier: GPL-2.0-or-later */
import Adw from 'gi://Adw';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {APP_ICONS_KEY, APP_ICONS_TYPE, MONOCHROME_KEY, TRAY_APPS_PATH, TRAY_APPS_XML} from './trayIconSettings.js';

const TrayAppsProxy = Gio.DBusProxy.makeProxyWrapper(TRAY_APPS_XML);

function saveAppIcon(settings, key, name, changes) {
    const icons = settings.get_value(APP_ICONS_KEY).deep_unpack();
    const [, oldPath = '', oldMonochrome = false] = icons[key] ?? [];
    const {path = oldPath, monochrome = oldMonochrome} = changes;
    if (path === oldPath && monochrome === oldMonochrome)
        return;

    if (path || monochrome)
        icons[key] = [name, path, monochrome];
    else
        delete icons[key];
    settings.set_value(APP_ICONS_KEY, new GLib.Variant(APP_ICONS_TYPE, icons));
}

export default class BackgroundAppsTrayPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const t = this.gettext.bind(this);
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: t('Tray Icons'), icon_name: 'image-x-generic-symbolic'});
        const appearance = new Adw.PreferencesGroup();
        const allLabel = t('Make all pinned icons monochrome');
        const all = new Gtk.CheckButton({valign: Gtk.Align.CENTER});
        const allRow = new Adw.ActionRow({title: allLabel, activatable_widget: all});
        all.update_property([Gtk.AccessibleProperty.LABEL], [allLabel]);
        allRow.add_suffix(all);
        appearance.add(allRow);
        page.add(appearance);
        settings.bind(MONOCHROME_KEY, all, 'active', Gio.SettingsBindFlags.DEFAULT);

        const apps = new Adw.PreferencesGroup({title: t('Pinned Applications')});
        page.add(apps);
        window.add(page);

        const rows = new Map();
        let currentApps = [];
        const sync = () => {
            const icons = settings.get_value(APP_ICONS_KEY).deep_unpack();
            const available = new Map(Object.entries(icons).map(([key, [name]]) => [key, name]));
            for (const [key, name] of currentApps)
                available.set(key, name);
            apps.description = available.size ? '' : t('Pin an application to the top bar to customize its icon.');

            for (const [key, {row}] of rows) {
                if (!available.has(key)) {
                    apps.remove(row);
                    rows.delete(key);
                }
            }

            for (const [key, name] of [...available].sort((a, b) => a[1].localeCompare(b[1]))) {
                if (!rows.has(key)) {
                    const controls = this._createAppRow(window, settings, key);
                    rows.set(key, controls);
                    apps.add(controls.row);
                }
                const {row, monochrome, reset} = rows.get(key);
                const [, path = '', selected = false] = icons[key] ?? [];
                row.title = name;
                row.subtitle = path ? GLib.path_get_basename(path) : '';
                monochrome.active = selected;
                reset.sensitive = !!path;
            }
        };

        const settingsId = settings.connect(`changed::${APP_ICONS_KEY}`, sync);
        const cancellable = new Gio.Cancellable();
        let proxyId = 0;
        const proxy = new TrayAppsProxy(Gio.DBus.session, 'org.gnome.Shell', TRAY_APPS_PATH, (object, error) => {
            if (error)
                return;
            const syncCurrentApps = () => {
                currentApps = object.Applications ?? [];
                sync();
            };
            proxyId = object.connect('g-properties-changed', syncCurrentApps);
            syncCurrentApps();
        }, cancellable);
        window.connect('close-request', () => {
            cancellable.cancel();
            if (proxyId)
                proxy.disconnect(proxyId);
            settings.disconnect(settingsId);
            return false;
        });
        sync();
    }

    _createAppRow(window, settings, key) {
        const t = this.gettext.bind(this);
        const row = new Adw.ActionRow({use_markup: false, title_lines: 1, subtitle_lines: 1});
        const save = changes => saveAppIcon(settings, key, row.title, changes);
        const monochrome = new Gtk.CheckButton({label: t('Monochrome'), valign: Gtk.Align.CENTER});
        monochrome.connect('toggled', () => save({monochrome: monochrome.active}));
        const choose = new Gtk.Button({label: t('Choose Icon…'), valign: Gtk.Align.CENTER});
        choose.connect('clicked', () => this._chooseIcon(window, path => save({path})));
        const resetLabel = t('Restore Default Icon');
        const reset = new Gtk.Button({icon_name: 'edit-undo-symbolic', tooltip_text: resetLabel,
            valign: Gtk.Align.CENTER});
        reset.update_property([Gtk.AccessibleProperty.LABEL], [resetLabel]);
        reset.connect('clicked', () => save({path: ''}));
        for (const control of [monochrome, choose, reset])
            row.add_suffix(control);
        return {row, monochrome, reset};
    }

    _chooseIcon(window, onChosen) {
        const t = this.gettext.bind(this);
        const dialog = new Gtk.FileChooserNative({title: t('Choose Icon…'), transient_for: window,
            modal: true, action: Gtk.FileChooserAction.OPEN});
        const filter = new Gtk.FileFilter({name: t('Images')});
        filter.add_pixbuf_formats();
        dialog.add_filter(filter);
        dialog.connect('response', (chooser, response) => {
            const path = response === Gtk.ResponseType.ACCEPT ? chooser.get_file()?.get_path() : null;
            chooser.destroy();
            if (response !== Gtk.ResponseType.ACCEPT)
                return;

            try {
                if (!path || !GLib.file_test(path, GLib.FileTest.IS_REGULAR))
                    throw new Error('Expected a local file');
                GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 32, 32, true);
            } catch {
                window.add_toast(new Adw.Toast({title: t('Could not open the image file')}));
                return;
            }
            onChosen(path);
        });
        dialog.show();
    }
}
