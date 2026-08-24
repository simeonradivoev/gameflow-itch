import { parseGamePage, parseListings } from './parser';
import type { ItchGame, ItchListing } from './types';

const CACHE_TTL = 5 * 60 * 1000;

export class ItchClient
{
    private cache = new Map<string, { expires: number, value: unknown; }>();

    clear ()
    {
        this.cache.clear();
    }

    private async getHtml (url: string)
    {
        const response = await fetch(url, {
            headers: {
                Accept: 'text/html,application/xhtml+xml',
                'User-Agent': 'Gameflow itch.io plugin/0.1'
            },
            signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) throw new Error(`itch.io request failed: ${response.status} ${response.statusText}`);
        return response.text();
    }

    private async cached<T> (key: string, loadValue: () => Promise<T>): Promise<T>
    {
        const cached = this.cache.get(key);
        if (cached && cached.expires > Date.now()) return cached.value as T;
        const value = await loadValue();
        this.cache.set(key, { expires: Date.now() + CACHE_TTL, value });
        return value;
    }

    collection (collectionUrl: string): Promise<ItchListing[]>
    {
        const url = new URL(collectionUrl);
        if (url.protocol !== 'https:' || url.hostname !== 'itch.io') throw new Error('Collection must be a public itch.io URL');
        return this.cached(`collection:${url.href}`, async () => parseListings(await this.getHtml(url.href)).filter(game => game.web));
    }

    search (query: string, page = 1): Promise<ItchListing[]>
    {
        const url = new URL('https://itch.io/search');
        url.searchParams.set('q', query);
        url.searchParams.set('type', 'games');
        if (page > 1) url.searchParams.set('page', String(page));
        return this.cached(`search:${url.href}`, async () => parseListings(await this.getHtml(url.href)).filter(game => game.web));
    }

    game (pageUrl: string): Promise<ItchGame>
    {
        const url = new URL(pageUrl);
        if (url.protocol !== 'https:' || !url.hostname.endsWith('.itch.io')) throw new Error('Game must be hosted on itch.io');
        return this.cached(`game:${url.href}`, async () => parseGamePage(url.href, await this.getHtml(url.href)));
    }
}
