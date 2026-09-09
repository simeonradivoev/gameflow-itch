import type { CommandEntry } from '@simeonradivoev/gameflow-sdk/shared';
import path from 'node:path';
import type { Cave, LaunchTarget } from './messages';

function pathTools (platform: NodeJS.Platform)
{
    return platform === 'win32' ? path.win32 : path.posix;
}

export function samePath (left: string, right: string, platform: NodeJS.Platform = process.platform)
{
    const tools = pathTools(platform);
    const normalize = (value: string) => tools.normalize(tools.resolve(value));
    return platform === 'win32'
        ? normalize(left).toLocaleLowerCase() === normalize(right).toLocaleLowerCase()
        : normalize(left) === normalize(right);
}

export function isPathInside (root: string, candidate: string, platform: NodeJS.Platform = process.platform)
{
    const tools = pathTools(platform);
    const relative = tools.relative(tools.resolve(root), tools.resolve(candidate));
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${tools.sep}`) && !tools.isAbsolute(relative));
}

function openCommand (target: string, platform: NodeJS.Platform): string[]
{
    if (platform === 'win32') return ['explorer.exe', target];
    if (platform === 'darwin') return ['open', target];
    return ['xdg-open', target];
}


const helperNamePattern = /^(?:unitycrashhandler(?:32|64)?|crashpad_handler|crashhandler|bugreport|unins\d*|uninstall|updater|setup|installer|vcredist(?:_x(?:64|86))?|dxsetup)(?:\.exe)?$/i;

/** Windows binaries in a mixed upload must not preempt a native Linux entry point. */
export function isLinuxLaunchTarget(target: LaunchTarget)
{
    const flavor = target.strategy.candidate?.flavor ?? '';
    return !/windows|macos/i.test(flavor)
        && !/\.(exe|com|bat|cmd|app)$/i.test(target.strategy.fullTargetPath);
}

export function isHelperLaunchTarget (target: LaunchTarget)
{
    if (target.strategy.strategy !== 'native') return false;
    return helperNamePattern.test(path.basename(target.strategy.fullTargetPath));
}

function comparableName (value: string)
{
    return value.toLocaleLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '');
}

export interface NativeCandidate
{
    name: string;
    isFile: boolean;
    isDirectory: boolean;
    executable?: boolean;
}

export function chooseFallbackNativeCandidate (
    entries: NativeCandidate[],
    cave: Cave,
    platform: NodeJS.Platform = process.platform
)
{
    const folderName = pathTools(platform).basename(cave.installInfo.installFolder);
    const expected = [cave.game?.title, folderName].filter((value): value is string => Boolean(value)).map(comparableName);
    return entries
        .filter(entry =>
        {
            if (helperNamePattern.test(entry.name)) return false;
            if (platform === 'win32') return entry.isFile && /\.exe$/i.test(entry.name);
            if (platform === 'darwin') return entry.isDirectory && /\.app$/i.test(entry.name);
            return entry.isFile && Boolean(entry.executable) && !/\.(exe|com|bat|cmd)$/i.test(entry.name);
        })
        .map(entry =>
        {
            const name = comparableName(entry.name);
            const exactIndex = expected.indexOf(name);
            const partial = expected.some(candidate => candidate.length >= 4 && (name.includes(candidate) || candidate.includes(name)));
            return { entry, score: exactIndex === 0 ? 300 : exactIndex > 0 ? 200 : partial ? 100 : 10 };
        })
        .sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name))[0]?.entry;
}

export function launchTargetToCommand (
    target: LaunchTarget,
    cave: Cave,
    index: number,
    platform: NodeJS.Platform = process.platform
): CommandEntry | undefined
{
    const installFolder = cave.installInfo.installFolder;
    const fullTargetPath = target.strategy.fullTargetPath;
    const strategy = target.strategy.strategy;
    if (!strategy || !fullTargetPath) return;

    if (strategy === 'url')
    {
        let parsed: URL;
        try { parsed = new URL(fullTargetPath); } catch { return; }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
        return {
            id: `itch-${index}`,
            label: target.action.name || 'Open',
            command: openCommand(parsed.href, platform),
            valid: true,
            shell: false,
            emulator: 'ITCH-NATIVE',
            emulatorSource: 'custom',
            metadata: {}
        };
    }

    // Butler resolves manifest paths before returning them. Never execute or
    // open a local target that escaped the cave through a manifest path.
    if (!isPathInside(installFolder, fullTargetPath, platform)) return;

    if (strategy === 'html' || strategy === 'shell')
    {
        return {
            id: `itch-${index}`,
            label: target.action.name || 'Open',
            command: openCommand(fullTargetPath, platform),
            startDir: installFolder,
            valid: true,
            shell: false,
            emulator: 'ITCH-NATIVE',
            emulatorSource: 'custom',
            metadata: {}
        };
    }

    if (strategy !== 'native') return;
    const args = target.action.args ?? [];
    const wrapper = target.host.wrapper;
    let command: string[];
    // An AppImage may be nested below Butler's install root; sibling game data
    // must resolve as it does when the AppImage is opened from its own folder.
    let startDir = platform === 'linux' && /\.appimage$/i.test(fullTargetPath)
        ? path.posix.dirname(fullTargetPath) : installFolder;
    let env: Record<string, string> | undefined;

    if (wrapper)
    {
        const tools = pathTools(platform);
        const wrappedTarget = wrapper.needRelativeTarget ? tools.basename(fullTargetPath) : fullTargetPath;
        if (wrapper.needRelativeTarget) startDir = tools.dirname(fullTargetPath);
        command = [
            wrapper.wrapperBinary,
            ...wrapper.beforeTarget,
            wrappedTarget,
            ...wrapper.betweenTargetAndArgs,
            ...args,
            ...wrapper.afterArgs
        ];
        env = wrapper.env;
    } else if (platform === 'darwin' && target.strategy.candidate?.flavor === 'app-macos')
    {
        command = ['open', '-W', fullTargetPath, ...(args.length ? ['--args', ...args] : [])];
    } else if (target.strategy.candidate?.flavor === 'jar')
    {
        command = ['java', '-jar', fullTargetPath, ...args];
    } else if (target.strategy.candidate?.flavor === 'love')
    {
        command = ['love', fullTargetPath, ...args];
    } else if (platform === 'win32' && target.strategy.candidate?.flavor === 'windows-script')
    {
        command = ['cmd.exe', '/d', '/s', '/c', fullTargetPath, ...args];
    } else
    {
        command = [fullTargetPath, ...args];
    }

    return {
        id: `itch-${index}`,
        label: target.action.name || pathTools(platform).basename(fullTargetPath),
        command,
        env,
        startDir,
        valid: true,
        shell: false,
        emulator: 'ITCH-NATIVE',
        emulatorSource: 'custom',
        metadata: { emulatorBin: command[0], emulatorDir: startDir }
    };
}
