const Lang = imports.lang;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;

const GLib = imports.gi.GLib;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;

const Config = imports.misc.config;
const Util = imports.misc.util;

const ByteArray = imports.byteArray;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Utils = Me.imports.utils;

const ws_manager = Utils.ws_manager;
const display = Utils.display;

const IgnoreList = {
    DISABLED: 0,
    WHITELIST: 1,
    BLACKLIST: 2,
};

var WindowState = {
    DEFAULT: 'default',
    HIDE_TITLEBAR: 'hide_titlebar',
    UNDECORATED: 'undecorated',
    UNKNOWN: 'unknown'
};

let workspaces = [];

var Decoration = class {

    constructor(settings) {
        this._changeWorkspaceID = 0;
        this._windowEnteredID = 0;
        this._settings = settings;

        this._enable();

        this._changeMonitorsID = Meta.MonitorManager.get().connect(
            'monitors-changed',
            Lang.bind(this, function () {
                Utils.log_debug("Monitors changed, reloading");
                this._disable();
                this._enable();
            })
        );

        this._focusWindowID = global.display.connect(
            'notify::focus-window',
            Lang.bind(this, function () {
                Utils.log_debug("Focus changed, toggling titlebar");
                this._toggleTitlebar();
            })
        );

        this._sizeChangeID = global.window_manager.connect(
            'size-change',
            Lang.bind(this, function () {
                Utils.log_debug("Size changed, toggling titlebar");
                this._toggleTitlebar();
            })
        );

        this._onlyMainMonitorID = this._settings.connect(
            'changed::only-main-monitor',
            Lang.bind(this, function () {
                this._disable();
                this._enable();
            })
        );

        this._ignoreListID = this._settings.connect(
            'changed::ignore-list',
            Lang.bind(this, function () {
                this._disable();
                this._enable();
            })
        );

        this._ignoreListTypeID = this._settings.connect(
            'changed::ignore-list-type',
            Lang.bind(this, function () {
                this._disable();
                this._enable();
            })
        );
    }

    _enable() {
        Utils.log_debug("Enabling extension");
        // Connect events
        this._changeWorkspaceID = ws_manager.connect('notify::n-workspaces', Lang.bind(this, this._onChangeNWorkspaces));
        this._windowEnteredID = display.connect('window-entered-monitor', Lang.bind(this, this._windowEnteredMonitor));


        // CSS style for Wayland decorations
        this._userStylesPath = GLib.get_user_config_dir() + '/gtk-3.0/gtk.css';
        Mainloop.idle_add(Lang.bind(this, this._addUserStyles));

        /**
         * Go through already-maximised windows & undecorate.
         * This needs a delay as the window list is not yet loaded
         * when the extension is loaded.
         * Also, connect up the 'window-added' event.
         * Note that we do not connect this before the onMaximise loop
         * because when one restarts the gnome-shell, window-added gets
         * fired for every currently-existing window, and then
         * these windows will have onMaximise called twice on them.
         */
        Mainloop.idle_add(Lang.bind(this, function () {
            this._forEachWindow(Lang.bind(this, function (win) {
                this._onWindowAdded(null, win);
            }));

            this._onChangeNWorkspaces();
            return false;
        }));

        this._isEnabled = true;
    }

    _disable() {
        if (this._changeWorkspaceID) {
            ws_manager.disconnect(this._changeWorkspaceID);
            this._changeWorkspaceID = 0;
        }

        if (this._windowEnteredID) {
            display.disconnect(this._windowEnteredID);
            this._windowEnteredID = 0;
        }

        if (this._focusWindowID) {
            global.display.disconnect(this._focusWindowID);
            this._focusWindowID = 0;
        }

        if (this._sizeChangeID) {
            global.window_manager.disconnect(this._sizeChangeID);
            this._sizeChangeID = 0;
        }

        this._cleanWorkspaces();

        this._forEachWindow(Lang.bind(this, function (win) {
            let state = this._getOriginalState(win);
            if (state == WindowState.DEFAULT) {
                this._setHideTitlebar(win, false);
            }

            delete win._noTitleBarOriginalState;
        }));

        // Remove CSS Styles
        this._removeUserStyles();

        this._isEnabled = false;
    }

    destroy() {
        this._disable();
        Meta.MonitorManager.get().disconnect(this._changeMonitorsID);
        this._settings.disconnect(this._onlyMainMonitorID);
        this._settings.disconnect(this._ignoreListID);
        this._settings.disconnect(this._ignoreListTypeID);
        this._onlyMainMonitorID = null;
        this._ignoreListID = null;
        this._ignoreListTypeID = null;
    }

    /**
     * Guesses the X ID of a window.
     *
     * It is often in the window's title, being `"0x%x %10s".format(XID, window.title)`.
     * (See `mutter/src/core/window-props.c`).
     *
     * If we couldn't find it there, we use `win`'s actor, `win.get_compositor_private()`.
     * The actor's `x-window` property is the X ID of the window *actor*'s frame
     * (as opposed to the window itself).
     *
     * However, the child window of the window actor is the window itself, so by
     * using `xwininfo -children -id [actor's XID]` we can attempt to deduce the
     * window's X ID.
     *
     * It is not always foolproof, but works good enough for now.
     *
     * @param {Meta.Window} win - the window to guess the XID of. You wil get better
     * success if the window's actor (`win.get_compositor_private()`) exists.
     */
    _guessWindowXID(win) {
        // We cache the result so we don't need to redetect.
        if (win._noTitleBarWindowID) {
            Utils.log_debug(`Window info: title='${win.get_title()}', type='${win.get_window_type()}', ` +
                `xid=${win._noTitleBarWindowID}'`);
            return win._noTitleBarWindowID;
        }

        /**
         * If window title has non-utf8 characters, get_description() complains
         * "Failed to convert UTF-8 string to JS string: Invalid byte sequence in conversion input",
         * event though get_title() works.
         */
        try {
            let m = win.get_description().match(/0x[0-9a-f]+/);
            if (m && m[0]) {
                Utils.log_debug(`Window info: title='${win.get_title()}', type='${win.get_window_type()}', ` +
                    `xid=${m[0]}'`);
                return win._noTitleBarWindowID = m[0];
            }
        } catch (err) {
        }

        // use xwininfo, take first child.
        let act = win.get_compositor_private();
        let xwindow = act && act['x-window'];
        if (xwindow) {
            let xwininfo = GLib.spawn_command_line_sync('xwininfo -children -id 0x%x'.format(xwindow));
            if (xwininfo[0]) {
                let str = ByteArray.toString(xwininfo[1]);

                /**
                 * The X ID of the window is the one preceding the target window's title.
                 * This is to handle cases where the window has no frame and so
                 * act['x-window'] is actually the X ID we want, not the child.
                 */
                let regexp = new RegExp('(0x[0-9a-f]+) +"%s"'.format(win.title));
                let m = str.match(regexp);
                if (m && m[1]) {
                    Utils.log_debug(`Window info: title='${win.get_title()}', type='${win.get_window_type()}', ` +
                        `xid=${m[1]}'`);
                    return win._noTitleBarWindowID = m[1];
                }

                // Otherwise, just grab the child and hope for the best
                m = str.split(/child(?:ren)?:/)[1].match(/0x[0-9a-f]+/);
                if (m && m[0]) {
                    Utils.log_debug(`Window info: title='${win.get_title()}', type='${win.get_window_type()}', ` +
                        `xid=${m[0]}'`);
                    return win._noTitleBarWindowID = m[0];
                }
            }
        }

        // Try enumerating all available windows and match the title. Note that this
        // may be necessary if the title contains special characters and `x-window`
        // is not available.
        let result = GLib.spawn_command_line_sync('xprop -root _NET_CLIENT_LIST');
        if (result[0]) {
            let str = ByteArray.toString(result[1]);

            // Get the list of window IDs.
            if (str.match(/0x[0-9a-f]+/g) == null)
                return null;
            let windowList = str.match(/0x[0-9a-f]+/g);

            // For each window ID, check if the title matches the desired title.
            for (var i = 0; i < windowList.length; ++i) {
                let cmd = 'xprop -id "' + windowList[i] + '" _NET_WM_NAME _NO_TITLE_BAR_ORIGINAL_STATE';
                let result = GLib.spawn_command_line_sync(cmd);

                if (result[0]) {
                    let output = ByteArray.toString(result[1]);
                    let isManaged = output.indexOf("_NO_TITLE_BAR_ORIGINAL_STATE(CARDINAL)") > -1;
                    if (isManaged) {
                        continue;
                    }

                    let title = output.match(/_NET_WM_NAME(\(\w+\))? = "(([^\\"]|\\"|\\\\)*)"/);

                    // Is this our guy?
                    if (title && title[2] == win.title) {
                        Utils.log_debug(`Window info: title='${win.get_title()}', type='${win.get_window_type()}', ` +
                            `xid=${windowList[i]}'`);
                        return windowList[i];
                    }
                }
            }
        }

        // debugging for when people find bugs..
        Utils.log_debug(`Unable to determine xid for window title='${win.get_title()}', type='${win.get_window_type()}'`);
        return null;
    }

    _toggleTitlebar() {
        let win = global.display.focus_window;

        if (!win) {
            Utils.log_debug("Tried to toggle titlebar, but couldn't find focus window");
            return;
        }

        if (win.get_maximized())
            this._setHideTitlebar(win, true);
        else
            this._setHideTitlebar(win, false);
    }

    /**
     * Get the value of _GTK_HIDE_TITLEBAR_WHEN_MAXIMIZED before
     * no-title-bar did its magic.
     *
     * @param {Meta.Window} win - the window to check the property
     */
    _getOriginalState(win) {
        if (win._noTitleBarOriginalState !== undefined) {
            return win._noTitleBarOriginalState;
        }

        if (!win.decorated) {
            return win._noTitleBarOriginalState = WindowState.UNDECORATED;
        }

        let id = this._guessWindowXID(win);
        let cmd = 'xprop -id ' + id;

        let xprops = GLib.spawn_command_line_sync(cmd);
        if (!xprops[0]) {
            return win._noTitleBarOriginalState = WindowState.UNKNOWN;
        }

        let str = ByteArray.toString(xprops[1]);
        let m = str.match(/^_NO_TITLE_BAR_ORIGINAL_STATE\(CARDINAL\) = ([0-9]+)$/m);
        if (m) {
            let state = !!parseInt(m[1]);
            return win._noTitleBarOriginalState = state
                ? WindowState.HIDE_TITLEBAR
                : WindowState.DEFAULT;
        }

        m = str.match(/^_GTK_HIDE_TITLEBAR_WHEN_MAXIMIZED(\(CARDINAL\))? = ([0-9]+)$/m);
        if (m) {
            let state = !!parseInt(m[2]);
            cmd = ['xprop', '-id', id,
                '-f', '_NO_TITLE_BAR_ORIGINAL_STATE', '32c',
                '-set', '_NO_TITLE_BAR_ORIGINAL_STATE',
                (state ? '0x1' : '0x0')];
            Util.spawn(cmd);
            return win._noTitleBarOriginalState = state
                ? WindowState.HIDE_TITLEBAR
                : WindowState.DEFAULT;
        }

        // GTK uses the _GTK_HIDE_TITLEBAR_WHEN_MAXIMIZED atom to indicate that the
        // title bar should be hidden when maximized. If we can't find this atom, the
        // window uses the default behavior
        return win._noTitleBarOriginalState = WindowState.DEFAULT;
    }

    /**
     * Tells the window manager to hide the titlebar on maximised windows.
     *
     * Does this by setting the _GTK_HIDE_TITLEBAR_WHEN_MAXIMIZED hint - means
     * I can do it once and forget about it, rather than tracking maximize/unmaximize
     * events.
     *
     * **Caveat**: doesn't work with Ubuntu's Ambiance and Radiance window themes -
     * my guess is they don't respect or implement this property.
     *
     * I don't know how to read the inital value, so I'm not sure how to resore it.
     *
     * @param {Meta.Window} win - window to set the HIDE_TITLEBAR_WHEN_MAXIMIZED property of.
     * @param {boolean} hide - whether to hide the titlebar or not.
     */
    _setHideTitlebar(win, hide) {
        // Check if the window is a black/white-list
        if (Utils.isWindowIgnored(this._settings, win) && hide) {
            Utils.log_debug(`Window '${win.get_title()}' ignored due to black/whitelist`);
            return;
        }

        // Make sure we save the state before altering it.
        this._getOriginalState(win);

        this._toggleDecorations(win, hide);
    }

    _updateWindowAsync(win, cmd) {
        // Run xprop
        GLib.spawn_async(
            null,
            cmd,
            null,
            GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
            null
        );
    }

    _getHintValue(win, hint) {
        let winId = this._guessWindowXID(win);
        if (!winId) return;

        let result = GLib.spawn_command_line_sync(`xprop -id ${winId} ${hint}`);
        let string = ByteArray.toString(result[1]);
        if (!string.match(/=/)) return;

        string = string.split('=')[1].trim().split(',').map(function (part) {
            part = part.trim();
            return part.match(/\dx/) ? part : `0x${part}`
        });

        return string;
    }

    _setHintValue(win, hint, value) {
        let winId = this._guessWindowXID(win);
        if (!winId) return;

        Util.spawn(['xprop', '-id', winId, '-f', hint, '32c', '-set', hint, value]);
    }

    _getMotifHints(win) {
        if (!win._noTitleBarOriginalState) {
            let state = this._getHintValue(win, '_NO_TITLE_BAR_ORIGINAL_STATE');
            if (!state) {
                state = this._getHintValue(win, '_MOTIF_WM_HINTS');
                state = state || ['0x2', '0x0', '0x1', '0x0', '0x0'];

                this._setHintValue(win, '_NO_TITLE_BAR_ORIGINAL_STATE', state.join(', '));
            }
            win._noTitleBarOriginalState = state;
        }

        return win._noTitleBarOriginalState;
    }

    _handleWindow(win) {
        let state = this._getMotifHints(win);
        return !win.is_client_decorated() && (state[2] != '0x2' && state[2] != '0x0');
    }

    _toggleDecorations(win, hide) {
        let winId = this._guessWindowXID(win);

        if (!this._handleWindow(win)) {
            Utils.log_debug(`Window stays unhandled: '${win.get_title()}'`);
            return;
        }

        GLib.idle_add(0, Lang.bind(this, function () {
            let cmd = this._toggleDecorationsMotif(winId, hide);
            Utils.log_debug(`Running toggle decorations for window '${win.get_title()}': '${cmd}'`);
            this._updateWindowAsync(win, cmd);
        }));
    }

    _toggleDecorationsMotif(winId, hide) {
        Utils.log_debug(`Toggeling decorations for window '${winId}', hide=${hide}`);
        let prop = '_MOTIF_WM_HINTS';
        let flag = '0x2, 0x0, %s, 0x0, 0x0';
        let value = flag.format(hide ? '0x2' : '0x1');

        return ['xprop', '-id', winId, '-f', prop, '32c', '-set', prop, value];
    }

    /**** Callbacks ****/
    /**
     * Callback when a window is added in any of the workspaces.
     * This includes a window switching to another workspace.
     *
     * If it is a window we already know about, we do nothing.
     *
     * Otherwise, we activate the hide title on maximize feature.
     *
     * @param {Meta.Window} win - the window that was added.
     *
     * @see undecorate
     */
    _onWindowAdded(ws, win, retry) {
        if (win.window_type === Meta.WindowType.DESKTOP ||
            win.window_type === Meta.WindowType.MODAL_DIALOG) {
            return false;
        }

        // If the window is simply switching workspaces, it will trigger a
        // window-added signal. We don't want to reprocess it then because we already
        // have.
        if (win._noTitleBarOriginalState !== undefined) {
            return false;
        }

        /**
         * Newly-created windows are added to the workspace before
         * the compositor knows about them: get_compositor_private() is null.
         * Additionally things like .get_maximized() aren't properly done yet.
         * (see workspace.js _doAddWindow)
         */
        if (!win.get_compositor_private()) {
            retry = (retry !== undefined) ? retry : 0;
            if (retry > 3) {
                return false;
            }

            Mainloop.idle_add(Lang.bind(function () {
                this._onWindowAdded(ws, win, retry + 1);
                return false;
            }));
            return false;
        }

        retry = 3;
        Mainloop.idle_add(Lang.bind(this, function () {
            // Need to check if the extension is still enabled, as this is added
            // with "idle" delay
            if (!this._isEnabled) {
                return false;
            }

            let id = this._guessWindowXID(win);
            if (!id) {
                if (--retry) {
                    return true;
                }

                return false;
            }

            let hide = win.get_maximized();
            if (this._settings.get_boolean('only-main-monitor'))
                hide = win.is_on_primary_monitor();
            this._setHideTitlebar(win, hide);
            return false;
        }));

        return false;
    }

    /**
     * Callback whenever the number of workspaces changes.
     *
     * We ensure that we are listening to the 'window-added' signal on each of
     * the workspaces.
     *
     * @see _onWindowAdded
     */
    _onChangeNWorkspaces() {
        this._cleanWorkspaces();

        let i = ws_manager.n_workspaces;
        while (i--) {
            let ws = ws_manager.get_workspace_by_index(i);
            workspaces.push(ws);
            // we need to add a Mainloop.idle_add, or else in _onWindowAdded the
            // window's maximized state is not correct yet.
            ws._noTitleBarWindowAddedId = ws.connect('window-added', Lang.bind(this, function (ws, win) {
                Mainloop.idle_add(Lang.bind(this, function () {
                    return this._onWindowAdded(ws, win);
                }));
            }));
        }

        return false;
    }

    /* CSS styles, for Wayland decorations
     */

    _updateUserStyles() {
        let styleContent = '';

        if (GLib.file_test(this._userStylesPath, GLib.FileTest.EXISTS)) {
            let fileContent = GLib.file_get_contents(this._userStylesPath);

            if (fileContent[0] == true) {
                styleContent = ByteArray.toString(fileContent[1]);
                styleContent = styleContent.replace(/@import.*no-title-bar@jonaspoehler\.de.*css['"]\);\n/g, '');
            }
        }

        return styleContent;
    }

    _addUserStyles() {
        let styleContent = this._updateUserStyles();
        let styleFilePath = Me.path + '/stylesheet.css';
        let styleImport = "@import url('" + styleFilePath + "');\n";

        styleFilePath = Me.path + '/stylesheet-tiled.css';
        styleImport += "@import url('" + styleFilePath + "');\n";

        GLib.file_set_contents(this._userStylesPath, styleImport + styleContent);
    }

    _removeUserStyles() {
        let styleContent = this._updateUserStyles();
        GLib.file_set_contents(this._userStylesPath, styleContent);
    }


    /**
     * Utilities
     */
    _cleanWorkspaces() {
        // disconnect window-added from workspaces
        workspaces.forEach(function (ws) {
            ws.disconnect(ws._noTitleBarWindowAddedId);
            delete ws._noTitleBarWindowAddedId;
        });

        workspaces = [];
    }

    _forEachWindow(callback) {
        global.get_window_actors()
            .map(function (w) {
                return w.meta_window;
            })
            .filter(function (w) {
                return w.window_type !== Meta.WindowType.DESKTOP;
            })
            .forEach(callback);
    }

    _windowEnteredMonitor(metaScreen, monitorIndex, metaWin) {
        let hide = metaWin.get_maximized();
        if (this._settings.get_boolean('only-main-monitor'))
            hide = monitorIndex == Main.layoutManager.primaryIndex;
        this._setHideTitlebar(metaWin, hide);
    }

}
