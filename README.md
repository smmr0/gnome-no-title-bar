# No Title Bar

An extension for GNOME Shell that merges the activity bar and the title bar of maximized windows.

## Install From Source

```
make install
gnome-extensions enable no-title-bar@jonaspoehler.de
```

Restart GNOME Shell by pressing <kbd>Alt</kbd>+<kbd>F2</kbd> and entering <kbd>r</kbd>.
**Note**: GNOME Shell under Wayland doesn't support restarting, so you might need to login again instead.

## Dependencies

This extension depends on Xorg's `xprop` and `xwininfo` utilities. If not already
present on your system, these can be installed using:

- Debian/Ubuntu: `apt install x11-utils`
- Fedora/RHEL: `dnf install xorg-x11-utils`
- Arch: `pacman -S xorg-xprop`

## Credits

This is based on the no-title-bar extension by franglais125 (https://github.com/franglais125/no-title-bar), which itself 
is a fork of the Pixel-Saver extension, by @deadalnix: https://github.com/deadalnix/pixel-saver
