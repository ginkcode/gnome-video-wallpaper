import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export function monitorIndexForConnector(connector) {
    const manager = global.backend.get_monitor_manager();
    const index = manager.get_monitor_for_connector(connector);
    if (index < 0 || index >= Main.layoutManager.monitors.length)
        return -1;
    return index;
}
