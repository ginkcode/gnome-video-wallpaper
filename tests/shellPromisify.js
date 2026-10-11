import Gio from 'gi://Gio';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
