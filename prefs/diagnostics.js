const PACKAGES = {mpv: 'mpv', ffmpeg: 'ffmpeg', ffprobe: 'ffmpeg'};
const MANAGERS = [
    [['debian', 'ubuntu'], 'sudo apt install'],
    [['fedora', 'rhel', 'centos'], 'sudo dnf install'],
    [['arch'], 'sudo pacman -S'],
    [['opensuse', 'suse'], 'sudo zypper install'],
];

export function osFamilies(osRelease) {
    const fields = {};
    for (const line of (osRelease ?? '').split('\n')) {
        const match = /^(ID|ID_LIKE)=(.*)$/.exec(line.trim());
        if (match)
            fields[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
    return [fields.ID, ...(fields.ID_LIKE ?? '').split(/\s+/)].filter(Boolean);
}

export function installCommands(osRelease, missing) {
    const packages = [...new Set(missing.map(name => PACKAGES[name]).filter(Boolean))];
    if (packages.length === 0)
        return [];
    const families = osFamilies(osRelease);
    const known = MANAGERS.find(([ids]) => ids.some(id => families.includes(id)));
    const managers = known ? [known] : MANAGERS.slice(0, 2);
    return managers.map(([, command]) => `${command} ${packages.join(' ')}`);
}

export function clearReport({removedBytes, preservedActiveBytes, preservedWallpaperBytes}, formatSize) {
    const kept = [];
    if (preservedActiveBytes > 0)
        kept.push(`${formatSize(preservedActiveBytes)} in use by playing wallpapers`);
    if (preservedWallpaperBytes > 0)
        kept.push(`${formatSize(preservedWallpaperBytes)} of applied wallpaper images`);
    const freed = `Freed ${formatSize(removedBytes)}.`;
    return kept.length > 0 ? `${freed} Kept ${kept.join(' and ')}.` : freed;
}
