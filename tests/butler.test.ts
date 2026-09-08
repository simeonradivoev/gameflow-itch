import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import pkg from '../package.json';
import fs from 'node:fs/promises';
import { spyOn } from 'bun:test';
import { butlerPlatform } from '../src/butler/binary';
import { authenticateButler, ButlerPluginError, ButlerService, butlerDaemonArgs, forgetButlerProfiles, isButlerLoginRequired, loginButlerWithAPIKey, relativeInstallPath } from '../src/butler/service';

describe('Butler platform support', () =>
{
    test.each([
        ['win32', 'x64', 'windows-amd64'],
        ['win32', 'arm64', 'windows-arm64'],
        ['linux', 'x64', 'linux-amd64'],
        ['linux', 'arm64', 'linux-arm64'],
        ['darwin', 'x64', 'darwin-amd64'],
        ['darwin', 'arm64', 'darwin-arm64']
    ])('maps %s/%s to %s', (platform, architecture, expected) =>
    {
        expect(butlerPlatform(platform, architecture)).toBe(expected);
    });

    test('rejects unsupported targets', () =>
    {
        expect(() => butlerPlatform('freebsd', 'x64')).toThrow('not available');
        expect(() => butlerPlatform('linux', 'ia32')).toThrow('not available');
    });
});

describe('Butler daemon startup', () =>
{
    test('passes value-bearing flags as single arguments', () =>
    {
        const args = butlerDaemonArgs(path.join('state', 'itch'), 1234);
        expect(args).toEqual([
            `--dbpath=${path.join('state', 'itch', 'butler.db')}`,
            '--address=https://itch.io',
            `--user-agent=${pkg.name}/${pkg.version}`,
            '--destiny-pid=1234'
        ]);
        expect(args.every(argument => argument.includes('='))).toBeTrue();
    });

    test('serializes plugin errors with an actionable message', () =>
    {
        expect(JSON.parse(JSON.stringify(new ButlerPluginError('Visible failure')))).toEqual({
            name: 'ButlerPluginError',
            message: 'Visible failure'
        });
    });

    test('recognizes Butler no-profile failures as login requirements', () =>
    {
        expect(isButlerLoginRequired(new Error('No profiles found'))).toBeTrue();
        expect(isButlerLoginRequired(new Error('network unavailable'))).toBeFalse();
    });
});

describe('Butler authentication', () =>
{
    test('uses the most recently connected saved profile', async () =>
    {
        const calls: string[] = [];
        const client = {
            async call (request: { __method: string; }, params: { profileId?: number; })
            {
                calls.push(`${request.__method}:${params.profileId ?? ''}`);
                if (request.__method === 'Profile.List') return { profiles: [
                    { id: 1, lastConnected: '2025-01-01T00:00:00Z' },
                    { id: 2, lastConnected: '2026-01-01T00:00:00Z' }
                ] };
                return { profile: { id: params.profileId, lastConnected: '2026-01-01T00:00:00Z' } };
            }
        };

        expect((await authenticateButler(client as never))?.id).toBe(2);
        expect(calls).toEqual(['Profile.List:', 'Profile.UseSavedLogin:2']);
    });

    test('allows anonymous access when there is no saved login or API key', async () =>
    {
        const client = { call: async () => ({ profiles: [] }) };
        expect(await authenticateButler(client as never)).toBeUndefined();
    });

    test('trims a transient API key before passing it to Butler', async () =>
    {
        let suppliedKey: string | undefined;
        const client = {
            async call (_request: unknown, params: { apiKey: string; })
            {
                suppliedKey = params.apiKey;
                return { profile: { id: 4, lastConnected: '2026-01-01T00:00:00Z' } };
            }
        };

        expect((await loginButlerWithAPIKey(client as never, '  transient-key  ')).id).toBe(4);
        expect(suppliedKey).toBe('transient-key');
    });

    test('never includes a rejected transient key in the error', async () =>
    {
        const client = { call: async () => { throw new Error('unauthorized'); } };
        await expect(loginButlerWithAPIKey(client as never, 'do-not-leak')).rejects.toThrow('rejected the API key');
        await expect(loginButlerWithAPIKey(client as never, 'do-not-leak')).rejects.not.toThrow('do-not-leak');
    });

    test('forgets every Butler profile managed by this plugin on logout', async () =>
    {
        const forgotten: number[] = [];
        const client = {
            async call (request: { __method: string; }, params: { profileId?: number; })
            {
                if (request.__method === 'Profile.List') return { profiles: [
                    { id: 5, lastConnected: '2025-01-01T00:00:00Z' },
                    { id: 6, lastConnected: '2026-01-01T00:00:00Z' }
                ] };
                forgotten.push(params.profileId!);
                return {};
            }
        };

        expect(await forgetButlerProfiles(client as never)).toBe(2);
        expect(forgotten.toSorted()).toEqual([5, 6]);
    });

    test('attempts every profile and reports only a safe failure count', async () =>
    {
        const forgotten: number[] = [];
        const client = {
            async call (request: { __method: string; }, params: { profileId?: number; })
            {
                if (request.__method === 'Profile.List') return { profiles: [
                    { id: 5, lastConnected: '2025-01-01T00:00:00Z' },
                    { id: 6, lastConnected: '2026-01-01T00:00:00Z' }
                ] };
                forgotten.push(params.profileId!);
                if (params.profileId === 5) throw new Error('sensitive transport detail');
                return {};
            }
        };

        await expect(forgetButlerProfiles(client as never)).rejects.toThrow('failed to forget 1 of 2 profiles');
        expect(forgotten.toSorted()).toEqual([5, 6]);
    });
    test('clears the cached profile even when logout only partially succeeds', async () =>
    {
        const service = new ButlerService('unused');
        const state = service as unknown as { client?: unknown; activeProfile?: unknown; };
        state.client = {
            async call (request: { __method: string; }, params: { profileId?: number; })
            {
                if (request.__method === 'Profile.List') return { profiles: [
                    { id: 5, lastConnected: '2025-01-01T00:00:00Z' },
                    { id: 6, lastConnected: '2026-01-01T00:00:00Z' }
                ] };
                if (params.profileId === 5) throw new Error('failed');
                return {};
            }
        };
        state.activeProfile = { id: 5 };

        await expect(service.logout()).rejects.toThrow('failed to forget 1 of 2 profiles');
        expect(state.activeProfile).toBeUndefined();
    });
});

describe('Butler install paths', () =>
{
    test('returns a path relative to the Gameflow download directory', () =>
    {
        expect(relativeInstallPath('/games', '/games/roms/itch/title')).toBe(path.join('roms', 'itch', 'title'));
    });

    test('rejects paths outside the Gameflow download directory', () =>
    {
        expect(() => relativeInstallPath('/games', '/other/title')).toThrow('outside');
        expect(() => relativeInstallPath('/games', '/games')).toThrow('outside');
    });
});

describe('Butler discovery', () =>
{
    test('coalesces upload requests and excludes the separate WebGL archive', async () =>
    {
        let uploadCalls = 0;
        let logHandlers = 0;
        const service = new ButlerService('unused');
        const state = service as unknown as { client?: unknown; };
        state.client = {
            async call (request: { __method: string; }, _params: unknown, setup?: (conversation: {
                onNotification: (notification: unknown, handler: (value: unknown) => void) => void;
            }) => void)
            {
                setup?.({ onNotification: () => { logHandlers++; } });
                if (request.__method === 'Profile.List') return { profiles: [] };
                if (request.__method === 'Fetch.Game') return { game: { id: 42, title: 'Example' } };
                if (request.__method === 'Fetch.GameUploads')
                {
                    uploadCalls++;
                    return { uploads: [
                        { id: 7, filename: 'windows.zip', displayName: '', size: 10, type: 'default', platforms: { windows: 'all' } },
                        { id: 8, filename: 'webgl.zip', displayName: '', size: 20, type: 'html', platforms: {} }
                    ] };
                }
                throw new Error(`Unexpected request ${request.__method}`);
            }
        };

        const [first, second] = await Promise.all([service.getUploads(42), service.getUploads(42)]);
        expect(first.uploads.map(upload => upload.id)).toEqual([7]);
        expect(second).toBe(first);
        expect(uploadCalls).toBe(1);
        expect(logHandlers).toBe(2);
    });

    test('fetches a logged-in collection through Butler and caches it', async () =>
    {
        let collectionCalls = 0;
        const service = new ButlerService('unused');
        const state = service as unknown as { client?: unknown; activeProfile?: unknown; };
        state.activeProfile = { id: 3 };
        state.client = {
            async call (request: { __method: string; })
            {
                if (request.__method !== 'Fetch.Collection.Games') throw new Error('Unexpected request');
                collectionCalls++;
                return { items: [{ collectionId: 9, gameId: 42, position: 0, game: { id: 42, title: 'Example' } }] };
            }
        };

        expect((await service.collectionGames(9, 10))?.map(game => game.id)).toEqual([42]);
        expect((await service.collectionGames(9, 10))?.map(game => game.id)).toEqual([42]);
        expect(collectionCalls).toBe(1);
    });
});

describe('Butler installation lifecycle', () =>
{
    test('reinstalls an upload already tracked by Butler', async () =>
    {
        const downloadPath = path.resolve('test-downloads');
        const installFolder = path.join(downloadPath, 'roms', 'itch', 'example');
        let queued: Record<string, unknown> | undefined;
        const service = new ButlerService(downloadPath);
        const state = service as unknown as { client?: unknown; activeProfile?: unknown; };
        state.activeProfile = { id: 3 };
        state.client = {
            async call (request: { __method: string; }, params: Record<string, unknown>, setup?: (conversation: {
                onNotification: (notification: unknown, handler: (value: { progress: number; }) => void) => void;
            }) => void)
            {
                if (request.__method === 'Fetch.Game') return { game: { id: 42, title: 'Example' } };
                if (request.__method === 'Fetch.GameUploads') return { uploads: [
                    { id: 7, filename: 'windows.zip', displayName: '', size: 10, type: 'default', platforms: { windows: 'all' } }
                ] };
                if (request.__method === 'Fetch.Caves') return { items: [{
                    id: 'cave-1',
                    game: { id: 42 },
                    upload: { id: 7 },
                    installInfo: { installFolder, installedSize: 10 }
                }] };
                if (request.__method === 'Install.Queue')
                {
                    // Persistent downloads remain pending after a direct perform.
                    if (params.queueDownload) throw new Error('Already have downloads in progress');
                    queued = params;
                    return { id: 'queue-1', caveId: 'cave-1', stagingFolder: 'staging' };
                }
                if (request.__method === 'Install.Perform')
                {
                    setup?.({ onNotification: (_notification, handler) => handler({ progress: 1 }) });
                    return { caveId: 'cave-1' };
                }
                if (request.__method === 'Fetch.Cave') return { cave: {
                    id: 'cave-1',
                    game: { id: 42 },
                    upload: { id: 7 },
                    installInfo: { installFolder, installedSize: 10 }
                } };
                throw new Error(`Unexpected request ${request.__method}`);
            }
        };

        await service.install(42, 7, undefined, () => {});
        expect(queued).toMatchObject({
            caveId: 'cave-1',
            reason: 'reinstall',
            installLocationId: undefined,
            queueDownload: false
        });
    });

    test('keeps Butler records when removal of a locked executable fails', async () =>
    {
        const downloadPath = path.resolve('test-downloads');
        const installFolder = path.join(downloadPath, 'roms', 'itch', 'locked-game');
        const calls: string[] = [];
        const service = new ButlerService(downloadPath);
        const state = service as unknown as { client?: unknown; activeProfile?: unknown; };
        state.activeProfile = { id: 3 };
        state.client = {
            async call (request: { __method: string; })
            {
                calls.push(request.__method);
                if (request.__method === 'Fetch.Caves') return { items: [{
                    id: 'locked-cave', game: { id: 42 }, installInfo: { installFolder, installedSize: 1 }
                }] };
                throw new Error('Uninstall must not forget a locked game');
            }
        };
        const remove = spyOn(fs, 'rm').mockRejectedValue(Object.assign(new Error('Locked'), { code: 'EBUSY' }));
        try
        {
            await expect(service.uninstall(42, installFolder)).rejects.toThrow('Close the game');
            expect(calls).toEqual(['Fetch.Caves']);
            expect(remove).toHaveBeenCalledWith(installFolder, {
                recursive: true, force: true, maxRetries: 5, retryDelay: 200
            });
        } finally
        {
            remove.mockRestore();
        }
    });

    test('hard-uninstalls every Butler cave sharing the deleted Gameflow path', async () =>
    {
        const downloadPath = path.resolve('test-downloads');
        const installFolder = path.join(downloadPath, 'roms', 'itch', 'example');
        const removed: string[] = [];
        const service = new ButlerService(downloadPath);
        const state = service as unknown as { client?: unknown; activeProfile?: unknown; };
        state.activeProfile = { id: 3 };
        state.client = {
            async call (request: { __method: string; }, params: { caveId?: string; })
            {
                if (request.__method === 'Fetch.Caves') return { items: [
                    { id: 'web-cave', game: { id: 42 }, installInfo: { installFolder, installedSize: 1 } },
                    { id: 'native-cave', game: { id: 42 }, installInfo: { installFolder, installedSize: 2 } },
                    { id: 'other-path', game: { id: 42 }, installInfo: { installFolder: path.join(downloadPath, 'other'), installedSize: 3 } },
                    { id: 'other-game', game: { id: 99 }, installInfo: { installFolder, installedSize: 4 } }
                ] };
                if (request.__method === 'Uninstall.Perform')
                {
                    removed.push(params.caveId!);
                    expect(params).toMatchObject({ hard: true });
                    return {};
                }
                throw new Error(`Unexpected request ${request.__method}`);
            }
        };

        expect(await service.uninstall(42, path.relative(downloadPath, installFolder))).toBe(2);
        expect(removed).toEqual(['web-cave', 'native-cave']);
    });
});
