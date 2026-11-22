/* SPDX-License-Identifier: GPL-2.0-or-later */
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {IconActor} from './vendor/appIndicator.js';
import {Client as DBusMenuClient} from './vendor/dbusMenu.js';
import {sameTrayMenus, trayMenus} from './applications.js';
import {canClose, processAppUnits} from './processActions.js';

const MENU_ICON = 'view-list-symbolic';
const CLOSE_ICON = 'window-close-symbolic';
const icons = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('icons');
const LIST_CONTROL_ICON = new Gio.FileIcon({file: icons.get_child('tray-list-symbolic.svg')});
const PIN_CONTROL_ICON = new Gio.FileIcon({file: icons.get_child('tray-pin-symbolic.svg')});

function label(text, styleClass) {
    const actor = new St.Label({text, style_class: styleClass,
        x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return actor;
}

function iconButton(icon, name, activate, secondary = false) {
    const button = new St.Button({
        style_class: 'icon-button background-apps-tray-control',
        child: new St.Icon({
            gicon: typeof icon === 'string' ? new Gio.ThemedIcon({name: icon}) : icon,
            icon_size: 16,
        }),
        can_focus: true,
        track_hover: true,
        accessible_name: name,
        button_mask: St.ButtonMask.ONE | (secondary ? St.ButtonMask.THREE : 0),
    });
    button.connect('clicked', () => activate(Clutter.get_current_event()));

    let timeout = 0;
    let hint = null;
    const clearHint = () => {
        if (timeout) {
            GLib.source_remove(timeout);
            timeout = 0;
        }
        hint?.destroy();
        hint = null;
    };
    button.connect('notify::mapped', clearHint);
    button.connect('destroy', clearHint);
    button.connect('notify::hover', () => {
        clearHint();
        if (!button.hover)
            return;
        timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 450, () => {
            timeout = 0;
            const monitor = Main.layoutManager.findMonitorForActor(button);
            if (!button.mapped || !monitor)
                return GLib.SOURCE_REMOVE;

            hint = new St.Label({style_class: 'dash-label', text: button.accessible_name});
            Main.uiGroup.add_child(hint);
            const [, width] = hint.get_preferred_width(-1);
            const [, height] = hint.get_preferred_height(width);
            const [x, y] = button.get_transformed_position();
            const [buttonWidth] = button.get_transformed_size();
            const center = x + (buttonWidth - width) / 2;
            const tooltipX = Math.max(monitor.x, Math.min(center, monitor.x + monitor.width - width));
            hint.set_position(Math.round(tooltipX), Math.round(y - height - 5));
            return GLib.SOURCE_REMOVE;
        });
    });
    button.connect('clicked', clearHint);
    return button;
}

function setButtonEnabled(button, enabled) {
    button.reactive = enabled;
    button.can_focus = enabled;
    if (enabled)
        button.remove_style_pseudo_class('insensitive');
    else
        button.add_style_pseudo_class('insensitive');
}

function createAppIcon(entry, size, gicon = null) {
    const indicator = entry.indicators[0]?.indicator;
    if (!gicon && indicator)
        return new IconActor(indicator, size);

    gicon ??= entry.app?.get_icon();
    const legacy = entry.legacy[0]?.icon;
    if (!gicon && legacy) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        legacy.set_size(16 * scale, 16 * scale);
        return new Clutter.Clone({source: legacy, width: size * scale, height: size * scale,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
    }
    gicon ??= new Gio.ThemedIcon({name: 'application-x-executable-symbolic'});
    return new St.Icon({gicon, icon_size: size, y_align: Clutter.ActorAlign.CENTER});
}

function createPanelIcon(entry) {
    const gicon = entry.iconPath ? new Gio.FileIcon({file: Gio.File.new_for_path(entry.iconPath)}) : null;
    const icon = createAppIcon(entry, 16, gicon);
    if (icon instanceof St.Widget)
        icon.add_style_class_name('system-status-icon');
    return icon;
}

function setIconMonochrome(icon, enabled) {
    const effect = icon.get_effect('background-apps-tray-monochrome');
    if (effect)
        effect.enabled = enabled;
    else if (enabled)
        icon.add_effect_with_name('background-apps-tray-monochrome', new Clutter.DesaturateEffect({factor: 1}));
}

function isKeyboardEvent(event) {
    return event?.type() === Clutter.EventType.KEY_PRESS ||
        event?.type() === Clutter.EventType.KEY_RELEASE;
}

const ApplicationRow = GObject.registerClass({
    GTypeName: 'BackgroundAppsTrayRow',
}, class ApplicationRow extends PopupMenu.PopupBaseMenuItem {
    _init(entry, pinned, busy, actions, t) {
        super._init({activate: false, can_focus: false});
        this.add_style_class_name('background-apps-tray-row');
        this.add_style_class_name('background-app-item');
        this.remove_style_class_name('popup-inactive-menu-item');
        this._t = t;
        this._icon = new St.Bin({y_align: Clutter.ActorAlign.CENTER});
        const content = new St.BoxLayout({style_class: 'background-apps-tray-app',
            x_expand: true});
        content.add_child(this._icon);

        // A vertical layout works with both the old and the new St.BoxLayout API.
        const texts = new St.Widget({
            layout_manager: new Clutter.BoxLayout({orientation: Clutter.Orientation.VERTICAL}),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._name = label(entry.name, 'background-apps-tray-name');
        this._message = label('', 'background-apps-tray-message');
        texts.add_child(this._name);
        texts.add_child(this._message);
        content.add_child(texts);
        this._openButton = new St.Button({
            child: content, style_class: 'background-apps-tray-open', x_expand: true,
            x_align: Clutter.ActorAlign.FILL, track_hover: true,
        });
        this._openButton.connect('clicked', () => {
            const {app} = this._entry;
            if (app) {
                Main.overview.hide();
                Main.panel.closeQuickSettings();
                app.activate();
            }
        });
        this.add_child(this._openButton);

        this.menuButton = iconButton(LIST_CONTROL_ICON, t('Tray menu'),
            event => actions.menu(this._entry, event, this.menuButton), true);
        this._pinButton = iconButton(PIN_CONTROL_ICON, t('Pin to Top Bar'),
            () => actions.pin(this._entry.key));
        this._closeButton = iconButton(CLOSE_ICON, t('Quit application'),
            () => actions.close(this._entry.key));

        for (const button of [this.menuButton, this._pinButton, this._closeButton])
            this.add_child(button);
        this.update(entry, pinned, busy);
    }

    update(entry, pinned, busy) {
        const previous = this._entry;
        this._entry = entry;
        this._name.text = entry.name;
        this._openButton.accessible_name = entry.name;
        this._openButton.can_focus = !!entry.app;
        this._openButton.reactive = !!entry.app;
        this._message.text = entry.message;
        this._message.visible = !!entry.message;

        const appIcon = entry.app?.get_icon();
        if (!previous || previous.app !== entry.app || (!appIcon &&
            previous.indicators[0]?.indicator !== entry.indicators[0]?.indicator)) {
            this._icon.child?.destroy();
            this._icon.set_child(createAppIcon(entry, 20, appIcon));
        }

        const menus = trayMenus(entry);
        let menuLabel = this._t('Tray menu');
        if (menus[0]?.type === 'desktop')
            menuLabel = this._t('Application menu');
        this.menuButton.accessible_name = menuLabel;
        setButtonEnabled(this.menuButton, menus.length > 0);
        this._pinButton.checked = pinned;
        this._pinButton.accessible_name = pinned
            ? this._t('Unpin from Top Bar') : this._t('Pin to Top Bar');
        this._closeButton.accessible_name = busy
            ? this._t('Quitting application…') : this._t('Quit application');
        setButtonEnabled(this._closeButton, canClose(entry) && !busy);
    }
});

class ScrollSection extends PopupMenu.PopupMenuSection {
    constructor() {
        super();
        this.actor = new St.ScrollView({style_class: 'background-apps-tray-scroll',
            overlay_scrollbars: false, x_expand: true});
        this.actor._delegate = this;
        this.actor.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        if (this.actor.set_child)
            this.actor.set_child(this.box);
        else
            this.actor.add_actor(this.box);
    }
}

function closeRoot(menu) {
    menu._openedSubMenu?.close();
    menu.close();
}

let legacyMenuCleanup = null;

export function clearLegacyMenu() {
    legacyMenuCleanup?.();
}

function watchLegacyMenu(icon, session, close, dismiss, sendingInput) {
    const visibleBefore = new Set(global.get_window_actors().filter(actor => actor.mapped));
    const menuTypes = [Meta.WindowType.POPUP_MENU, Meta.WindowType.DROPDOWN_MENU,
        Meta.WindowType.MENU, Meta.WindowType.OVERRIDE_OTHER];
    const pid = icon.pid;
    const wmClass = icon.wm_class?.toLowerCase();
    const units = processAppUnits(pid);
    const popups = () => global.get_window_actors().filter(actor => {
        if (!actor.mapped || visibleBefore.has(actor))
            return false;
        const window = actor.meta_window;
        if (window.get_client_type() !== Meta.WindowClientType.X11 ||
            !menuTypes.includes(window.get_window_type()))
            return false;

        const owner = window.get_pid();
        // Wine can host the tray icon and menu in different processes.
        return (pid > 0 && owner === pid) ||
            (wmClass && window.get_wm_class()?.toLowerCase() === wmClass) ||
            (units.length > 0 && processAppUnits(owner).some(unit => units.includes(unit)));
    });

    let filterId = 0;
    const deadline = GLib.get_monotonic_time() + 2 * GLib.USEC_PER_SEC;
    // Observe mapped actors because X11 clients can reuse an existing menu window.
    let waitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
        const [popup] = popups();
        if (!popup && GLib.get_monotonic_time() < deadline)
            return GLib.SOURCE_CONTINUE;

        waitId = 0;
        if (!popup) {
            close();
            return GLib.SOURCE_REMOVE;
        }

        popup.connectObject('notify::mapped', () => {
            if (!popup.mapped)
                close();
        }, 'destroy', close, session);
        let outsideButton = 0;
        filterId = Clutter.Event.add_filter(null, event => {
            if (sendingInput())
                return Clutter.EVENT_PROPAGATE;

            const type = event.type();
            if (type === Clutter.EventType.BUTTON_PRESS) {
                const [x, y] = event.get_coords();
                const inside = popups().some(actor => {
                    const rect = actor.meta_window.get_frame_rect();
                    return x >= rect.x && y >= rect.y &&
                        x < rect.x + rect.width && y < rect.y + rect.height;
                });
                if (!inside) {
                    outsideButton = event.get_button();
                    return Clutter.EVENT_STOP;
                }
            } else if (type === Clutter.EventType.BUTTON_RELEASE && outsideButton &&
                event.get_button() === outsideButton) {
                outsideButton = 0;
                dismiss(popup);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        return GLib.SOURCE_REMOVE;
    });
    session.connect('destroy', () => {
        if (waitId)
            GLib.source_remove(waitId);
        if (filterId)
            Clutter.Event.remove_filter(filterId);
    });
}

function openLegacyMenu(icon, event, x, y, close, reportError) {
    const originalButton = event?.type() === Clutter.EventType.BUTTON_RELEASE
        ? event.get_button() : Clutter.BUTTON_PRIMARY;
    const button = originalButton === Clutter.BUTTON_PRIMARY ? Clutter.BUTTON_SECONDARY : originalButton;
    const click = originalButton === Clutter.BUTTON_PRIMARY ? null : event.copy();
    const time = event?.get_time() ?? global.get_current_time();
    const state = event?.get_state() ?? 0;
    clearLegacyMenu();
    close?.();

    const size = 16 * St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const left = Math.round(x - size / 2);
    const top = Math.round(y - size / 2);
    icon.set_size(size, size);
    icon.set_position(left, top);
    icon.allocate(Clutter.ActorBox.new(left, top, left + size, top + size));

    const session = new Clutter.Actor();
    let activateId = 0;
    let retryId = 0;
    let cancelInput = null;
    const cleanup = () => {
        if (legacyMenuCleanup !== cleanup)
            return;
        legacyMenuCleanup = null;
        cancelInput?.();
        if (activateId)
            GLib.source_remove(activateId);
        if (retryId)
            GLib.source_remove(retryId);
        session.destroy();
    };
    legacyMenuCleanup = cleanup;
    icon.connectObject('destroy', cleanup, session);

    const send = (code, forward, onError) => {
        cancelInput = sendLegacyInput(code, input => {
            cancelInput = null;
            forward(input);
        }, error => {
            cancelInput = null;
            onError(error);
        });
    };
    const dismiss = popup => {
        if (cancelInput || retryId)
            return;

        const retry = () => {
            retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                retryId = 0;
                // Some tray clients only dismiss the menu on a second click.
                if (popup.mapped) {
                    send(button, input => icon.click(input),
                        error => console.warn(`Background Apps Tray: ${error.message}`));
                }
                return GLib.SOURCE_REMOVE;
            });
        };
        send(Clutter.KEY_Escape, input => {
            icon.click(input);
            retry();
        }, retry);
    };
    const open = input => {
        watchLegacyMenu(icon, session, cleanup, dismiss, () => !!cancelInput);
        icon.click(input);
    };
    // Shell.TrayIcon updates the X11 socket geometry in a default-priority idle.
    activateId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
        activateId = 0;
        if (click) {
            open(click);
        } else if (Clutter.Event.new) {
            const input = Clutter.Event.new(Clutter.EventType.BUTTON_RELEASE);
            input.set_button(button);
            input.set_time(time);
            input.set_state(state);
            open(input);
        } else {
            send(button, open, error => {
                cleanup();
                reportError(error);
            });
        }
        return GLib.SOURCE_REMOVE;
    });
}

function sendLegacyInput(code, forward, reportError) {
    // Capture the generated event so it can only be delivered to the tray icon.
    const keyboard = code === Clutter.KEY_Escape;
    const wayland = Meta.is_wayland_compositor();
    const backend = global.stage.context?.get_backend() ?? Clutter.get_default_backend();
    const device = backend.get_default_seat().create_virtual_device(keyboard
        ? Clutter.InputDeviceType.KEYBOARD_DEVICE : Clutter.InputDeviceType.POINTER_DEVICE);
    const grab = global.stage.grab(global.stage);
    const requiredGrab = keyboard ? Clutter.GrabState.KEYBOARD : Clutter.GrabState.POINTER;
    if (!(grab.get_seat_state() & requiredGrab)) {
        grab.dismiss();
        reportError(new Error('Could not grab input for the XEmbed menu'));
        return;
    }

    const press = keyboard ? Clutter.EventType.KEY_PRESS : Clutter.EventType.BUTTON_PRESS;
    const release = keyboard ? Clutter.EventType.KEY_RELEASE : Clutter.EventType.BUTTON_RELEASE;
    const time = GLib.get_monotonic_time();
    let timeoutId;
    const finish = () => {
        if (timeoutId)
            GLib.source_remove(timeoutId);
        Clutter.Event.remove_filter(filterId);
        grab.dismiss();
    };
    const filterId = Clutter.Event.add_filter(null, event => {
        const type = event.type();
        if (type !== press && type !== release)
            return Clutter.EVENT_PROPAGATE;

        const isRelease = type === release;
        const fromDevice = wayland
            ? event.get_time_us() === time + Number(isRelease)
            : event.get_source_device()?.get_device_name() === 'Virtual core XTEST pointer';
        if (!fromDevice || (keyboard ? event.get_key_symbol() : event.get_button()) !== code)
            return Clutter.EVENT_PROPAGATE;

        if (isRelease) {
            finish();
            forward?.(event);
        }
        return Clutter.EVENT_STOP;
    });
    timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        timeoutId = 0;
        finish();
        reportError?.(new Error('No input event for the XEmbed menu'));
        return GLib.SOURCE_REMOVE;
    });
    if (keyboard) {
        device.notify_keyval(time, code, Clutter.KeyState.PRESSED);
        device.notify_keyval(time + 1, code, Clutter.KeyState.RELEASED);
    } else {
        device.notify_button(time, code, Clutter.ButtonState.PRESSED);
        device.notify_button(time + 1, code, Clutter.ButtonState.RELEASED);
    }
    // Drain the queued events even if their target goes away.
    return () => {
        forward = null;
        reportError = null;
    };
}

function openExternal(source, event, button, close, reportError) {
    const [x, y] = button.get_transformed_position();
    const [width, height] = button.get_transformed_size();
    if (source.type === 'xembed') {
        openLegacyMenu(source.icon, event, x + width / 2, y + height, close, reportError);
        return;
    }

    close?.();
    source.indicator.contextMenu(Math.round(x + width / 2), Math.round(y + height)).catch(reportError);
}

function addDBusMenu(parent, source, isOpen, t) {
    const section = new PopupMenu.PopupMenuSection();
    const status = new PopupMenu.PopupMenuItem(t('Loading menu…'), {reactive: false});
    section.addMenuItem(status);
    parent.addMenuItem(section);
    const client = new DBusMenuClient(source.owner, source.path, source.indicator);
    section.actor.connect('destroy', () => client.destroy());

    let attached = false;
    const attach = () => {
        if (!client.isReady || attached)
            return;
        attached = true;
        client.attachToMenu(section);
        if (isOpen())
            section.open();
    };
    client.connect('ready-changed', attach);
    attach();
}

function isExternalMenu(source) {
    return source.type === 'xembed' || source.type === 'context';
}

function populateTrayMenu(section, menus, close, isOpen, t, actions) {
    for (const source of menus) {
        const name = source.indicator?.title || source.indicator?.id ||
            source.icon?.title || t('Tray menu');
        if (source.type === 'desktop') {
            section.addAction(t('Open application'), () => {
                close();
                source.app.activate();
            });
            const info = source.app.get_app_info();
            const desktopActions = info.list_actions();
            for (const action of desktopActions) {
                if (action === 'quit')
                    continue;
                section.addAction(info.get_action_name(action), event => {
                    close();
                    source.app.launch_action(action, event?.get_time() ?? global.get_current_time(), -1);
                });
            }
            if (source.canQuit) {
                section.addAction(t('Quit application'), () => {
                    close();
                    actions.close(source.key);
                });
            }
        } else if (source.type === 'dbusmenu') {
            if (menus.length > 1)
                section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(name));
            addDBusMenu(section, source, isOpen, t);
        } else {
            const item = new PopupMenu.PopupImageMenuItem(
                menus.length > 1 ? name : t('Open Tray Menu'), MENU_ICON);
            item.connect('activate', (_item, event) => {
                openExternal(source, event, item, close, actions.reportError);
            });
            section.addMenuItem(item);
        }
    }
}

export class BackgroundMenu {
    constructor(toggle, actions, t) {
        this._toggle = toggle;
        this._actions = actions;
        this._t = t;
        this._section = toggle._appsSection;
        this._list = new ScrollSection();
        this._rows = new Map();
        this._details = null;
        this._settingsAction = toggle.menu._settingsActions['gnome-applications-panel.desktop'];
        const items = toggle.menu._getMenuItems();
        const separator = items[items.indexOf(this._settingsAction) - 1];
        this._settingsSeparator = separator instanceof PopupMenu.PopupSeparatorMenuItem
            ? separator : null;
        this._section.removeAll();
        this._section.addMenuItem(this._list);
        this._openId = toggle.menu.connect('open-state-changed', (_menu, open) => {
            if (!open)
                this._showList();
        });
    }

    update(entries, pins, busy, conflict) {
        const listed = [...entries.values()].filter(entry => entry.inBackground)
            .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
        const wanted = new Set(listed.map(entry => entry.key));
        for (const [key, row] of this._rows) {
            if (!wanted.has(key)) {
                row.destroy();
                this._rows.delete(key);
            }
        }

        const isPinned = new Set(pins);
        listed.forEach((entry, index) => {
            let row = this._rows.get(entry.key);
            if (!row) {
                row = new ApplicationRow(entry, isPinned.has(entry.key), busy.has(entry.key), {
                    ...this._actions,
                    menu: (app, event, button) => this._openTrayMenu(app, event, button),
                }, this._t);
                this._list.addMenuItem(row);
                this._rows.set(entry.key, row);
            } else {
                row.update(entry, isPinned.has(entry.key), busy.has(entry.key));
            }
            this._list.box.set_child_at_index(row, index);
        });

        if (this._details) {
            const entry = entries.get(this._details.key);
            if (!entry?.inBackground || !sameTrayMenus(this._details.menus, trayMenus(entry)))
                this._showList();
        }

        if (conflict && !this._conflictItem) {
            this._conflictItem = new PopupMenu.PopupMenuItem(
                this._t('Disable the other AppIndicator extension to show tray apps here.'),
                {reactive: false});
            this._conflictItem.label.clutter_text.line_wrap = true;
            this._list.addMenuItem(this._conflictItem);
        } else if (!conflict && this._conflictItem) {
            this._conflictItem.destroy();
            this._conflictItem = null;
        }

        this._toggle._listTitle.visible = listed.length > 0 && !this._details;
        return listed.length;
    }

    _openTrayMenu(entry, event, sourceButton) {
        const menus = trayMenus(entry);
        if (menus.length === 0)
            return;
        if (menus.length === 1 && isExternalMenu(menus[0])) {
            openExternal(menus[0], event, sourceButton,
                () => Main.panel.closeQuickSettings(), this._actions.reportError);
            return;
        }

        this._showList();
        const detail = new PopupMenu.PopupMenuSection();
        const top = new PopupMenu.PopupBaseMenuItem({
            reactive: false, activate: false, can_focus: false, hover: false,
        });
        top.add_style_class_name('background-apps-tray-detail-header');
        top.remove_style_class_name('popup-inactive-menu-item');
        const back = iconButton('go-previous-symbolic', this._t('Back to Background Apps'),
            event => this._showList(isKeyboardEvent(event) ? sourceButton : null));
        top.add_child(back);
        top.add_child(label(entry.name, 'background-apps-tray-name'));
        detail.addMenuItem(top);

        const commands = new ScrollSection();
        detail.addMenuItem(commands);
        this._section.addMenuItem(detail);
        this._details = {
            section: detail, key: entry.key, menus,
            settingsWereVisible: !!this._settingsAction?.visible,
            separatorWasVisible: !!this._settingsSeparator?.visible,
        };
        this._settingsAction?.hide();
        this._settingsSeparator?.hide();
        this._list.actor.hide();
        this._toggle._listTitle.hide();

        populateTrayMenu(commands, menus, () => Main.panel.closeQuickSettings(),
            () => this._toggle.menu.isOpen, this._t, this._actions);
        if (isKeyboardEvent(event))
            back.grab_key_focus();
    }

    _showList(focus) {
        if (!this._details)
            return;

        this._toggle.menu._openedSubMenu?.close();
        const detail = this._details;
        this._details = null;
        detail.section.destroy();
        if (detail.settingsWereVisible && Main.sessionMode.allowSettings)
            this._settingsAction.show();
        if (detail.separatorWasVisible)
            this._settingsSeparator.show();
        this._list.actor.show();
        this._toggle._listTitle.visible = this._rows.size > 0;
        if (focus?.mapped)
            focus.grab_key_focus();
    }

    destroy() {
        this._toggle.menu.disconnect(this._openId);
        this._showList();
        this._list.destroy();
        this._rows.clear();
    }
}

export class PanelPins {
    constructor(t, actions) {
        this._t = t;
        this._actions = actions;
        this._buttons = new Map();
        this._serial = 0;
    }

    update(entries, pins) {
        const visible = new Set(pins.filter(key => entries.has(key)));
        for (const [key, current] of this._buttons) {
            const entry = entries.get(key);
            if (!visible.has(key) || !sameTrayMenus(current.menus, trayMenus(entry)) ||
                current.app !== entry.app || current.primary !==
                    (entry.indicators[0]?.indicator ?? entry.legacy[0]?.icon)) {
                current.remove();
                this._buttons.delete(key);
            }
        }
        for (const key of visible) {
            const entry = entries.get(key);
            if (!this._buttons.has(key))
                this._buttons.set(key, this._add(entry));
            const current = this._buttons.get(key);
            if (current.iconPath !== entry.iconPath) {
                const icon = createPanelIcon(entry);
                current.button.replace_child(current.icon, icon);
                current.icon.destroy();
                current.icon = icon;
                current.iconPath = entry.iconPath;
            }
            setIconMonochrome(current.icon, entry.monochromeIcon);
            current.button.accessible_name = entry.name;
        }
    }

    _add(entry) {
        const menus = trayMenus(entry);
        const hasPopup = menus.length > 1 || menus.some(menu => !isExternalMenu(menu));
        const button = new PanelMenu.Button(0.5, entry.name, !hasPopup);
        const icon = createPanelIcon(entry);
        button.add_child(icon);

        if (hasPopup) {
            const section = new PopupMenu.PopupMenuSection();
            button.menu.addMenuItem(section);
            let populated = false;
            const placeholder = new PopupMenu.PopupMenuItem(
                this._t('Loading menu…'), {reactive: false});
            section.addMenuItem(placeholder);
            button.menu.connect('open-state-changed', (menu, open) => {
                if (!open || populated)
                    return;
                populated = true;
                placeholder.destroy();
                populateTrayMenu(section, menus, () => closeRoot(menu),
                    () => menu.isOpen, this._t, this._actions);
            });
        } else {
            const activate = event => {
                if (menus[0]?.type === 'xembed') {
                    openExternal(menus[0], event, button, null, this._actions.reportError);
                } else if (menus.length && (event.type() !== Clutter.EventType.BUTTON_RELEASE ||
                    event.get_button() === Clutter.BUTTON_SECONDARY || !entry.app)) {
                    openExternal(menus[0], event, button, null, this._actions.reportError);
                } else if (entry.app) {
                    entry.app.activate();
                } else {
                    const indicator = entry.indicators[0]?.indicator;
                    const [x, y] = event.get_coords();
                    indicator?.open(Math.trunc(x), Math.trunc(y), event.get_time()).catch(this._actions.reportError);
                }
                return Clutter.EVENT_STOP;
            };
            button.connect('button-release-event', (_actor, event) => activate(event));
            button.connect('key-press-event', (_actor, event) => {
                if ([Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_space].includes(event.get_key_symbol()))
                    return activate(event);
                return Clutter.EVENT_PROPAGATE;
            });
        }

        Main.panel.addToStatusArea(`background-apps-tray-${++this._serial}`, button, 0, 'right');
        const remove = () => button.destroy();
        const primary = entry.indicators[0]?.indicator ?? entry.legacy[0]?.icon;
        return {button, icon, iconPath: entry.iconPath, app: entry.app, primary, menus, remove};
    }

    destroy() {
        for (const pin of this._buttons.values())
            pin.remove();
        this._buttons.clear();
    }
}
