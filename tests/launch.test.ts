import { describe, expect, test } from 'bun:test';
import { chooseFallbackNativeCandidate, isHelperLaunchTarget, isPathInside, launchTargetToCommand, samePath } from '../src/butler/launch';
import type { Cave, LaunchTarget } from '../src/butler/messages';

function cave (installFolder: string): Cave
{
    return {
        id: 'cave-1',
        game: { id: 42 },
        installInfo: { installFolder, installedSize: 1 }
    };
}

function target (
    strategy: LaunchTarget['strategy']['strategy'],
    fullTargetPath: string,
    overrides: Partial<LaunchTarget> = {}
): LaunchTarget
{
    return {
        action: { name: 'Play', path: 'game', args: ['--fullscreen'] },
        host: {},
        strategy: { strategy, fullTargetPath },
        ...overrides
    };
}

describe('Butler launch paths', () =>
{
    test('matches Windows paths case-insensitively and rejects sibling escapes', () =>
    {
        expect(samePath('C:\\Games\\Title', 'c:\\games\\title', 'win32')).toBeTrue();
        expect(isPathInside('C:\\Games\\Title', 'C:\\Games\\Title\\game.exe', 'win32')).toBeTrue();
        expect(isPathInside('C:\\Games\\Title', 'C:\\Games\\Title-Evil\\game.exe', 'win32')).toBeFalse();
    });

    test('rejects POSIX paths outside the cave', () =>
    {
        expect(isPathInside('/games/title', '/games/title/bin/game', 'linux')).toBeTrue();
        expect(isPathInside('/games/title', '/games/other/game', 'linux')).toBeFalse();
    });
});

describe('Butler launch target mapping', () =>
{
    test('maps a Windows executable and its arguments without a shell', () =>
    {
        const command = launchTargetToCommand(
            target('native', 'C:\\Games\\Title\\game.exe', {
                strategy: { strategy: 'native', fullTargetPath: 'C:\\Games\\Title\\game.exe', candidate: { flavor: 'windows' } }
            }),
            cave('C:\\Games\\Title'),
            0,
            'win32'
        );
        expect(command).toMatchObject({
            command: ['C:\\Games\\Title\\game.exe', '--fullscreen'],
            startDir: 'C:\\Games\\Title',
            shell: false,
            valid: true
        });
    });

    test('maps a Linux executable directly', () =>
    {
        const command = launchTargetToCommand(target('native', '/games/title/game'), cave('/games/title'), 1, 'linux');
        expect(command?.command).toEqual(['/games/title/game', '--fullscreen']);
        expect(command?.startDir).toBe('/games/title');
    });

    test('opens macOS app bundles and forwards manifest arguments', () =>
    {
        const command = launchTargetToCommand(
            target('native', '/Applications/Games/Title/Title.app', {
                strategy: { strategy: 'native', fullTargetPath: '/Applications/Games/Title/Title.app', candidate: { flavor: 'app-macos' } }
            }),
            cave('/Applications/Games/Title'),
            2,
            'darwin'
        );
        expect(command?.command).toEqual(['open', '-W', '/Applications/Games/Title/Title.app', '--args', '--fullscreen']);
    });

    test('honors Butler wrapper ordering, environment and relative target cwd', () =>
    {
        const command = launchTargetToCommand(
            target('native', '/games/title/bin/game.exe', {
                host: {
                    wrapper: {
                        wrapperBinary: 'wine',
                        beforeTarget: ['--before'],
                        betweenTargetAndArgs: ['--between'],
                        afterArgs: ['--after'],
                        env: { WINEPREFIX: '/prefix' },
                        needRelativeTarget: true
                    }
                }
            }),
            cave('/games/title'),
            3,
            'linux'
        );
        expect(command).toMatchObject({
            command: ['wine', '--before', 'game.exe', '--between', '--fullscreen', '--after'],
            env: { WINEPREFIX: '/prefix' },
            startDir: '/games/title/bin'
        });
    });

    test('uses safe platform openers for shell, HTML, and HTTP targets', () =>
    {
        expect(launchTargetToCommand(target('shell', '/games/title/readme.txt'), cave('/games/title'), 0, 'linux')?.command)
            .toEqual(['xdg-open', '/games/title/readme.txt']);
        expect(launchTargetToCommand(target('html', '/games/title/index.html'), cave('/games/title'), 0, 'darwin')?.command)
            .toEqual(['open', '/games/title/index.html']);
        expect(launchTargetToCommand(target('url', 'https://example.itch.io/game'), cave('/games/title'), 0, 'win32')?.command)
            .toEqual(['explorer.exe', 'https://example.itch.io/game']);
    });

    test('rejects escaped local targets and unsafe URL schemes', () =>
    {
        expect(launchTargetToCommand(target('native', '/games/other/game'), cave('/games/title'), 0, 'linux')).toBeUndefined();
        expect(launchTargetToCommand(target('url', 'file:///etc/passwd'), cave('/games/title'), 0, 'linux')).toBeUndefined();
    });

    test('rejects Unity crash handlers and prefers the actual game executable', () =>
    {
        const crashHandler = target('native', 'C:\\Games\\druids-haven\\UnityCrashHandler64.exe');
        expect(isHelperLaunchTarget(crashHandler)).toBeTrue();
        expect(chooseFallbackNativeCandidate([
            { name: 'UnityCrashHandler64.exe', isFile: true, isDirectory: false },
            { name: "Druid's Haven.exe", isFile: true, isDirectory: false },
            { name: 'setup.exe', isFile: true, isDirectory: false }
        ], cave('C:\\Games\\druids-haven'), 'win32')?.name).toBe("Druid's Haven.exe");
    });

    test('does not invent a launch target when a cave contains only helpers', () =>
    {
        expect(chooseFallbackNativeCandidate([
            { name: 'UnityCrashHandler64.exe', isFile: true, isDirectory: false }
        ], cave('C:\\Games\\druids-haven'), 'win32')).toBeUndefined();
    });
});
