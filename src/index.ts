import type { PluginLoadingContextType, PluginType } from '@simeonradivoev/gameflow-sdk';
import type { DownloadInfo, DownloadLookupDetails, DownloadLookupEntry, FrontEndGameTypeDetailed, GameLookup } from '@simeonradivoev/gameflow-sdk/shared';
import z from 'zod';
import pkg from '../package.json';
import { ItchClient } from './client';
import { decodeGameId } from './parser';
import type { ItchGame, ItchListing } from './types';

const DEFAULT_COLLECTION = 'https://itch.io/c/8025379/gameflow-store';
const WEB_PLATFORM_LOGO = 'https://static.itch.io/images/itchio-textless-white.svg';

const SettingsSchema = z.object({
    collectionUrl: z.url().default(DEFAULT_COLLECTION).describe('Public itch.io collection shown alongside games in the Gameflow store').meta({ title: 'Collection URL' }),
    collectionLimit: z.number().int().min(1).max(100).default(30).describe('Maximum number of curated itch.io games available in the store').meta({ title: 'Collection Limit' })
});
type Settings = z.infer<typeof SettingsSchema>;

function toDetailedGame (game: ItchGame): FrontEndGameTypeDetailed
{
    const updatedAt = game.updatedAt ?? new Date();
    return {
        id: { source: pkg.name, id: game.id },
        source: pkg.name,
        source_id: game.id,
        path_fs: null,
        path_covers: game.coverUrl ? [game.coverUrl] : [],
        last_played: null,
        updated_at: updatedAt,
        slug: new URL(game.pageUrl).pathname.split('/').filter(Boolean).at(-1) ?? game.id,
        name: game.name,
        platform_id: null,
        platform_slug: 'web',
        platform_display_name: 'Web',
        path_platform_cover: WEB_PLATFORM_LOGO,
        paths_screenshots: game.screenshots,
        igdb_id: null,
        ra_id: null,
        summary: game.summary ?? null,
        fs_size_bytes: null,
        missing: false,
        local: false,
        metadata: {
            first_release_date: null,
            genres: game.genres,
            companies: game.authors,
            game_modes: [],
            age_ratings: [],
            player_count: null,
            average_rating: null
        }
    };
}

function toDownloadEntry (game: ItchListing): DownloadLookupEntry
{
    return {
        source: pkg.name,
        id: game.id,
        cover_url: game.coverUrl,
        name: game.name,
        summary: game.summary,
        size: null,
        date: null,
        rating: null,
        view_count: null,
        download_count: null,
        comment_count: null
    };
}

function toGameLookup (game: ItchGame): GameLookup
{
    return {
        source: pkg.name,
        id: game.id,
        coverUrl: game.coverUrl,
        slug: new URL(game.pageUrl).pathname.split('/').filter(Boolean).at(-1),
        screenshotUrls: game.screenshots,
        name: game.name,
        summary: game.summary,
        genres: game.genres,
        companies: game.authors,
        game_modes: [],
        age_ratings: [],
        player_count: undefined,
        first_release_date: undefined,
        average_rating: undefined,
        keywords: game.tags,
        igdb_id: undefined,
        platforms: [{ id: 0, name: 'Web', displayName: 'Web', slug: 'web' }]
    };
}

export default class ItchPlugin implements PluginType<Settings>
{
    settingsSchema = SettingsSchema;
    private client = new ItchClient();

    async load (ctx: PluginLoadingContextType<Settings>)
    {
        const getGame = (id: string) => this.client.game(decodeGameId(id));

        ctx.hooks.games.fetchGames.tapPromise(pkg.name, async ({ query, games }) =>
        {
            if (query.source !== 'store' || query.collection_source || query.collection_id) return;

            const search = query.search?.trim().toLocaleLowerCase();
            const collection = (await this.client.collection(ctx.config.get('collectionUrl')))
                .slice(0, ctx.config.get('collectionLimit'))
                .filter(game => !search
                    || game.name.toLocaleLowerCase().includes(search)
                    || game.author?.toLocaleLowerCase().includes(search)
                    || game.genre?.toLocaleLowerCase().includes(search));
            const offset = query.offset ?? 0;
            const limit = query.limit ?? 50;
            const listings = collection.slice(offset, offset + limit);
            const settled = await Promise.allSettled(listings.map(game => this.client.game(game.pageUrl)));
            const itchGames = settled.filter((result): result is PromiseFulfilledResult<ItchGame> => result.status === 'fulfilled' && result.value.web)
                .map(result => toDetailedGame(result.value));

            if (query.genres?.length)
            {
                games.push(...itchGames.filter(game => query.genres!.every(genre => game.metadata.genres.includes(genre))));
                return;
            }

            games.push(...itchGames);
        });

        ctx.hooks.games.fetchGame.tapPromise(pkg.name, async ({ source, id }) =>
        {
            if (source !== pkg.name) return;
            const game = await getGame(id);
            if (game.web) return toDetailedGame(game);
        });

        ctx.hooks.games.fetchDownloads.tapPromise(pkg.name, async ({ source, id }) =>
        {
            if (source !== pkg.name) return;
            const game = await getGame(id);
            if (!game.web || !game.embedUrl || !game.coverUrl) return;
            return [{
                id: game.id,
                name: game.name,
                summary: game.summary,
                source_id: game.id,
                system_slug: 'web',
                slug: new URL(game.pageUrl).pathname.split('/').filter(Boolean).at(-1),
                coverUrl: game.coverUrl,
                screenshotUrls: game.screenshots,
                files: [],
                platform: { source: pkg.name, id: 'web', slug: 'web', name: 'Web' },
                metadata: {
                    genres: game.genres,
                    companies: game.authors,
                    game_modes: [],
                    age_ratings: []
                }
            } satisfies DownloadInfo];
        });

        ctx.hooks.games.buildLaunchCommands.tapPromise({ name: pkg.name, before: 'com.simeonradivoev.gameflow.es' }, async ({ source, sourceId }) =>
        {
            if (source !== pkg.name || !sourceId) return;
            const game = await getGame(sourceId);
            if (!game.embedUrl) return;
            return [{
                id: 'itch-web',
                label: 'Play in Gameflow',
                command: game.embedUrl,
                valid: true,
                launchType: 'web',
                emulator: 'ITCH-WEB',
                emulatorSource: 'embedded',
                metadata: { webUrl: game.embedUrl }
            }];
        });

        ctx.hooks.games.platformLookup.tapPromise(pkg.name, async ({ slug }) =>
        {
            if (slug === 'web') return { slug: 'web', name: 'Web', family_name: 'Browser', url_logo: WEB_PLATFORM_LOGO };
        });

        ctx.hooks.games.downloadsLookupFilters.tapPromise(pkg.name, async ({ filters }) =>
        {
            filters.source.push(pkg.name);
            filters.orderBy.push('relevance');
        });

        ctx.hooks.games.downloadsLookup.tapPromise(pkg.name, async (matches, { search, source, page, rows }) =>
        {
            if (source && source !== pkg.name)
            {
                matches.set(pkg.name, { count: 0, items: [] });
                return matches;
            }

            const listings = search
                ? await this.client.search(search, page ?? 1)
                : await this.client.collection(ctx.config.get('collectionUrl'));
            const limit = rows ?? 20;
            const items = listings.slice(0, limit).map(toDownloadEntry);
            matches.set(pkg.name, { count: items.length, items });
            return matches;
        });

        ctx.hooks.games.downloadLookup.tapPromise(pkg.name, async ({ source, id }) =>
        {
            if (source !== pkg.name) return;
            const game = await getGame(id);
            return {
                source: pkg.name,
                id: game.id,
                cover_url: game.coverUrl,
                name: game.name,
                summary: game.summary,
                date: game.updatedAt,
                files: [],
                game_id: { source: pkg.name, id: game.id }
            } satisfies DownloadLookupDetails;
        });

        ctx.hooks.games.gameLookup.tapPromise(pkg.name, async (matches, { source, id, search }) =>
        {
            if (source && source !== pkg.name) return matches;
            if (id)
            {
                const game = await getGame(id);
                matches.set(pkg.name, [toGameLookup(game)]);
            }
            else if (search)
            {
                const listings = await this.client.search(search);
                const settled = await Promise.allSettled(listings.slice(0, 10).map(game => this.client.game(game.pageUrl)));
                matches.set(pkg.name, settled.filter((result): result is PromiseFulfilledResult<ItchGame> => result.status === 'fulfilled')
                    .map(result => toGameLookup(result.value)));
            }
            return matches;
        });
    }

    async cleanup ()
    {
        this.client.clear();
    }
}
