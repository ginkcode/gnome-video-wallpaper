import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

export class FailureNotifier {
    constructor({openPreferences}) {
        this._openPreferences = openPreferences;
        this._source = null;
    }

    notify(title, body) {
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'Gink Video Wallpaper',
                iconName: 'video-display-symbolic'});
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
        const notification = new MessageTray.Notification({source: this._source, title, body});
        notification.addAction('Open Preferences', () => this._openPreferences());
        this._source.addNotification(notification);
    }

    destroy() {
        this._source?.destroy();
        this._source = null;
    }
}
