import { expect, test } from 'bun:test';
import ItchPlugin from '../src';
import pkg from '../package.json';
import type { ItchListing } from '../src/types';

test('unfiltered download pages exhaust the itch collection without repeating it', async () =>
{
    const plugin = new ItchPlugin();
    const listings = Array.from({ length: 13 }, (_, index) => ({
        id: String(index),
        pageUrl: `https://example.itch.io/game-${index}`,
        name: `Game ${index}`,
        web: true
    } satisfies ItchListing));
    const state = plugin as unknown as { client: { collection: () => Promise<ItchListing[]>; }; };
    state.client.collection = async () => [...listings, listings[0]!, listings[1]!];
    type Lookup = (matches: Map<string, { count: number; items: unknown[]; }>,
        query: { page: number; rows: number; }) => Promise<Map<string, { count: number; items: unknown[]; }>>;
    let lookup: Lookup | undefined;
    const hooks = new Proxy({}, {
        get: (_target, name) => ({
            tapPromise: (_name: unknown, handler: Lookup) =>
            {
                if (name === 'downloadsLookup') lookup = handler;
            }
        })
    });
    await plugin.load({
        hooks: { games: hooks },
        config: { get: () => 'https://itch.io/collection-without-numeric-id' },
        app: { config: { get: () => 'unused' } }
    } as never);
    expect(lookup).toBeDefined();
    const pages: unknown[][] = [];
    for (let page = 1; page <= 5; page++)
    {
        const other = { count: 1, items: [{ id: 'other-source' }] };
        const result = await lookup!(new Map([['other', other]]), { page, rows: 5 });
        expect(result.get('other')).toBe(other);
        const own = result.get(pkg.name)!;
        expect(own.count).toBe(13);
        pages.push(own.items);
    }
    expect(pages.map(page => page.length)).toEqual([5, 5, 3, 0, 0]);
    expect(new Set(pages.flat().map(item => JSON.stringify(item))).size).toBe(13);
});
