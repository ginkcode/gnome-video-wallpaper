import Gio from 'gi://Gio';

const script = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('run-t07-nested.py').get_path();
const process = Gio.Subprocess.new(['python3', '-I', script, ...ARGV], Gio.SubprocessFlags.NONE);
process.wait(null);
if (!process.get_successful())
    throw new Error('isolated nested verification failed; see runner output');
