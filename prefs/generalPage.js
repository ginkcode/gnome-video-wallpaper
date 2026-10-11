import Adw from 'gi://Adw';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {bindChoice, bindScaled} from './bindings.js';

const FIT_MODES = [['fill', 'Fill'], ['fit', 'Fit'], ['stretch', 'Stretch']];
const PLAYLIST_ORDERS = [['sequential', 'In order'], ['random', 'Shuffle']];
const VIDEO_OUTPUTS = [['auto', 'Automatic'], ['gpu-next', 'GPU (gpu-next)'], ['dmabuf-wayland', 'DMA-BUF (dmabuf-wayland)']];

function choiceRow(title, subtitle, choices) {
    return new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(choices.map(([, label]) => label))});
}

export const GeneralPage = GObject.registerClass(
class GeneralPage extends Adw.PreferencesPage {
    _init({settings}) {
        super._init({title: 'General', icon_name: 'preferences-system-symbolic'});
        this._settings = settings;
        this._unbinds = [];
        this._bound = [];

        const startup = new Adw.PreferencesGroup({title: 'Startup'});
        startup.add(this._seconds('startup-delay-ms', 'Startup delay',
            'Wait this long after login before starting videos', 60));
        startup.add(this._seconds('stagger-ms', 'Delay between displays',
            'Start each display’s video this long after the previous one', 10));
        this.add(startup);

        const pause = new Adw.PreferencesGroup({title: 'Pause'});
        pause.add(this._switch('pause-on-maximized', 'When a window covers the display',
            'Maximized or fullscreen windows'));
        pause.add(this._switch('pause-on-overview', 'In the Overview'));
        pause.add(this._switch('pause-on-battery', 'On battery power'));
        this.add(pause);

        const playlist = new Adw.PreferencesGroup({title: 'Playlists',
            description: 'Displays with more than one video change to the next one on a timer.'});
        const interval = Adw.SpinRow.new_with_range(1, 1440, 1);
        interval.set({title: 'Change video every', subtitle: 'Minutes'});
        this._bind('playlist-interval-minutes', interval, 'value');
        playlist.add(interval);
        const order = choiceRow('Order', 'Which video plays next', PLAYLIST_ORDERS);
        this._unbinds.push(bindChoice(settings, 'playlist-order', order, PLAYLIST_ORDERS.map(([nick]) => nick)));
        playlist.add(order);
        this.add(playlist);

        const panel = new Adw.PreferencesGroup({title: 'Top Bar'});
        panel.add(this._switch('show-panel-indicator', 'Show menu', 'Play/Pause and Preferences in the top bar'));
        this.add(panel);

        const playback = new Adw.PreferencesGroup({title: 'Playback'});
        const fit = choiceRow('Default fit mode', 'Used by displays without their own fit mode', FIT_MODES);
        this._unbinds.push(bindChoice(settings, 'default-fit-mode', fit, FIT_MODES.map(([nick]) => nick)));
        playback.add(fit);
        playback.add(this._switch('optimize-videos', 'Optimize videos',
            'Prepare display-sized copies in the background for lower playback cost'));
        const advanced = new Adw.ExpanderRow({title: 'Advanced'});
        const output = choiceRow('Video output', 'Change only if playback misbehaves', VIDEO_OUTPUTS);
        this._unbinds.push(bindChoice(settings, 'video-output', output, VIDEO_OUTPUTS.map(([nick]) => nick)));
        advanced.add_row(output);
        const retries = Adw.SpinRow.new_with_range(0, 10, 1);
        retries.set({title: 'Restart attempts', subtitle: 'Before giving up and keeping the still image'});
        this._bind('max-retries', retries, 'value');
        advanced.add_row(retries);
        playback.add(advanced);
        this.add(playback);

        const troubleshooting = new Adw.PreferencesGroup({title: 'Troubleshooting'});
        troubleshooting.add(this._switch('debug-logging', 'Debug logging', 'Write detailed logs to the journal'));
        this.add(troubleshooting);
    }

    close() {
        for (const unbind of this._unbinds)
            unbind();
        this._unbinds = [];
        for (const [widget, property] of this._bound)
            Gio.Settings.unbind(widget, property);
        this._bound = [];
    }

    _bind(key, widget, property) {
        this._settings.bind(key, widget, property, Gio.SettingsBindFlags.DEFAULT);
        this._bound.push([widget, property]);
    }

    _switch(key, title, subtitle = '') {
        const row = new Adw.SwitchRow({title, subtitle});
        this._bind(key, row, 'active');
        return row;
    }

    _seconds(key, title, subtitle, maxSeconds) {
        const row = new Adw.SpinRow({title, subtitle, digits: 1,
            adjustment: new Gtk.Adjustment({lower: 0, upper: maxSeconds, step_increment: 0.1, page_increment: 1})});
        row.add_suffix(new Gtk.Label({label: 's', css_classes: ['dim-label']}));
        this._unbinds.push(bindScaled(this._settings, key, row, 'value', 1000));
        return row;
    }
});
