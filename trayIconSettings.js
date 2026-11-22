/* SPDX-License-Identifier: GPL-2.0-or-later */
export const APP_ICONS_KEY = 'tray-app-icons';
export const APP_ICONS_TYPE = 'a{s(ssb)}';
export const MONOCHROME_KEY = 'monochrome-icons';

export const TRAY_APPS_PATH = '/org/gnome/Shell/Extensions/BackgroundAppsTray';
export const TRAY_APPS_TYPE = 'a(ss)';
export const TRAY_APPS_XML = `<node>
  <interface name="org.gnome.Shell.Extensions.BackgroundAppsTray">
    <property name="Applications" type="${TRAY_APPS_TYPE}" access="read"/>
  </interface>
</node>`;
