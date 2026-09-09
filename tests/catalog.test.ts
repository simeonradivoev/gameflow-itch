import { expect, test } from 'bun:test';
import ItchPlugin from '../src';
import { ItchClient } from '../src/client';
import { encodeGameId } from '../src/parser';
import pkg from '../package.json';
import type { ItchGame } from '../src/types';

const native: ItchGame = {
    id: encodeGameId('https://example.itch.io/native'),
    pageUrl: 'https://example.itch.io/native',
    itchId: '42', name: 'Native game', web: false,
    screenshots: [], genres: [], tags: [], authors: []
};
const web: ItchGame = {
    ...native, id: encodeGameId('https://example.itch.io/browser'),
    pageUrl: 'https://example.itch.io/browser', name: 'Browser game', web: true
};

test('public collection and search include download-only games alongside web games', async () =>
{
    const client = new ItchClient();
    (client as unknown as { getHtml: (url: string) => Promise<string> }).getHtml = async () =>
        [native, web].map(game => `<div class="game_cell">
            <div class="game_title"><a class="game_link" href="${game.pageUrl}">${game.name}</a></div>
            ${game.web ? '<span class="web_flag"></span>' : ''}
        </div>`).join('');
    for (const games of [await client.collection('https://itch.io/c/example'), await client.search('game')])
        expect(games.map(game => game.web)).toEqual([false, true]);
});

test('store, details, and downloads retain native-only titles without a Web label or web install', async () =>
{
    const plugin = new ItchPlugin();
    const state = plugin as unknown as {
        client: { collection: () => Promise<ItchGame[]>; game: (url: string) => Promise<ItchGame> };
        getButler: () => Promise<{ getUploads: () => Promise<{ uploads: unknown[] }> }>;
    };
    state.client.collection = async () => [native, web];
    state.client.game = async url => url === native.pageUrl ? native : web;
    state.getButler = async () => ({
        getUploads: async () => ({ uploads: [{ id: 7, filename: 'native.zip', type: 'default', size: 100, platforms: { windows: true } }] })
    });
    const handlers: Record<string, (...args: any[]) => any> = {};
    const hooks = new Proxy({}, {
        get: (_target, name) => ({
            tapPromise: (_name: unknown, handler: (...args: any[]) => any) => { handlers[String(name)] = handler; }
        })
    });
    await plugin.load({
        hooks: { games: hooks },
        config: { get: (key: string) => key === 'collectionLimit' ? 30 : 'https://itch.io/collection-example' },
        app: { config: { get: () => 'unused' } }
    } as never);
    const games: any[] = [];
    await handlers.fetchGames!({ query: { source: 'store' }, games });
    expect(games.map(game => game.name)).toEqual([native.name, web.name]);
    expect(games[0].platform_slug).toBeNull();
    expect(games[1].platform_slug).toBe('web');
    expect((await handlers.fetchGame!({ source: pkg.name, id: native.id })).name).toBe(native.name);
    const matches = await handlers.downloadsLookup!(new Map(), { page: 1, rows: 20 });
    expect(matches.get(pkg.name).items.map((game: any) => game.id)).toEqual([native.id, web.id]);
    const downloads = await handlers.fetchDownloads!({ source: pkg.name, id: native.id });
    expect(downloads.map((download: any) => download.id)).toEqual(['7']);
    expect(downloads[0].system_slug).toBe('win');
});

test('native itch launch runs before UMU and an empty native result permits fallback', async () =>
{
    const plugin = new ItchPlugin();
    const state = plugin as unknown as {
        client: { game: () => Promise<ItchGame> };
        getButler: () => Promise<{ launchCommands: () => Promise<unknown[]> }>;
    };
    state.client.game = async () => native;
    let commands: unknown[] = [{ id: 'native', command: ['/games/Diffusion.sh'], valid: true }];
    state.getButler = async () => ({ launchCommands: async () => commands });
    const handlers: Record<string, (...args: any[]) => any> = {};
    const options: Record<string, any> = {};
    const hooks = new Proxy({}, {
        get: (_target, name) => ({ tapPromise: (opts: unknown, handler: (...args: any[]) => any) => {
            handlers[String(name)] = handler;
            options[String(name)] = opts;
        } })
    });
    await plugin.load({ hooks: { games: hooks }, config: { get: () => '' },
        app: { config: { get: () => 'unused' } } } as never);
    expect(options.buildLaunchCommands.before).toContain('com.simeonradivoev.gameflow.umu');
    expect(options.buildLaunchCommands.stage).toBeLessThan(-100);
    const launch = { source: pkg.name, sourceId: native.id, gamePath: '/games/Diffusion', systemSlug: 'win' };
    expect(await handlers.buildLaunchCommands!(launch)).toEqual(commands);
    commands = [];
    expect(await handlers.buildLaunchCommands!(launch)).toBeUndefined();
    expect(await handlers.buildLaunchCommands!({ ...launch, source: 'other' })).toBeUndefined();
});
