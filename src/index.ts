import type { PluginLoadingContextType, PluginType } from '@simeonradivoev/gameflow-sdk';
import type { DownloadInfo, DownloadLookupDetails, DownloadLookupEntry, FrontEndGameTypeDetailed, GameLookup } from '@simeonradivoev/gameflow-sdk/shared';
import z from 'zod';
import pkg from '../package.json';
import { ItchClient } from './client';
import { butlerError, ButlerPluginError, ButlerService, type ButlerUploadSet } from './butler/service';
import type { Profile, Upload } from './butler/messages';
import { decodeGameId, encodeGameId } from './parser';
import type { ItchGame, ItchListing } from './types';

const DEFAULT_COLLECTION = 'https://itch.io/c/8025379/gameflow-store';
const WEB_PLATFORM_LOGO = 'https://static.itch.io/images/itchio-textless-white.svg';
const API_KEYS_URL = 'https://itch.io/user/settings/api-keys';
const WEB_DOWNLOAD_ID = 'web';

type PluginAction = {
    id: string;
    title?: string;
    description?: string;
    action: string;
    status?: string;
    fields?: Array<{
        id: string;
        label?: string;
        description?: string;
        placeholder?: string;
        type: 'text' | 'password';
        required: boolean;
        maxLength: number;
    }>;
};

function profileName (profile: Profile)
{
    return profile.user?.displayName?.trim() || profile.user?.username?.trim() || `profile ${profile.id}`;
}

export function itchAccountActions (profile?: Profile, statusError?: string): PluginAction[]
{
    const help: PluginAction = {
        id: 'itch-api-key-help',
        title: 'itch.io API key',
        description: 'Create or manage the API key used for this one-time connection.',
        action: 'Open itch.io'
    };
    if (profile)
    {
        return [{
            id: 'itch-disconnect',
            title: 'itch.io account',
            description: `Remove every itch.io login saved in Gameflow's private Butler database.`,
            action: 'Disconnect',
            status: `Connected as ${profileName(profile)}`
        }, help];
    }
    return [{
        id: 'itch-connect',
        title: 'itch.io account',
        description: 'Paste an itch.io API key. Gameflow sends it directly to the local Butler daemon and does not save or log it.',
        action: 'Connect',
        status: statusError ?? 'Not connected',
        fields: [{
            id: 'apiKey',
            label: 'API key',
            description: 'The key is used only for this request. Butler saves the resulting login session.',
            placeholder: 'itch.io API key',
            type: 'password',
            required: true,
            maxLength: 4096
        }]
    }, help];
}

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
        platform_slug: game.web ? 'web' : null,
        platform_display_name: game.web ? 'Web' : 'Download',
        path_platform_cover: game.web ? WEB_PLATFORM_LOGO : null,
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
        platforms: game.web ? [{ id: 0, name: 'Web', displayName: 'Web', slug: 'web' }] : []
    };
}

export function uploadSystemSlug (upload: Upload, platform: NodeJS.Platform = process.platform)
{
    if (platform === 'linux' && upload.platforms.linux) return 'linux';
    if (platform === 'darwin' && upload.platforms.osx) return 'macos';
    if (platform === 'win32' && upload.platforms.windows) return 'win';
    if (upload.platforms.windows) return 'win';
    if (upload.platforms.linux) return 'linux';
    if (upload.platforms.osx) return 'macos';
    return platform === 'win32' ? 'win' : platform === 'darwin' ? 'macos' : 'linux';
}

export function toButlerDownloadInfo (game: ItchGame, upload: Upload): DownloadInfo
{
    const systemSlug = uploadSystemSlug(upload);
    return {
        id: String(upload.id),
        name: game.name,
        summary: game.summary,
        source_id: game.id,
        system_slug: systemSlug,
        slug: new URL(game.pageUrl).pathname.split('/').filter(Boolean).at(-1),
        coverUrl: game.coverUrl ?? '',
        screenshotUrls: game.screenshots,
        files: [],
        platform: { source: pkg.name, id: systemSlug, slug: systemSlug, name: systemSlug },
        metadata: {
            genres: game.genres,
            companies: game.authors,
            game_modes: [],
            age_ratings: [],
            itchUpload: { id: upload.id, name: upload.displayName || upload.filename, filename: upload.filename, size: upload.size }
        }
    };
}

export function toWebDownloadInfo (game: ItchGame): DownloadInfo
{
    return {
        id: WEB_DOWNLOAD_ID,
        name: game.name,
        summary: game.summary,
        source_id: game.id,
        system_slug: 'web',
        slug: new URL(game.pageUrl).pathname.split('/').filter(Boolean).at(-1),
        coverUrl: game.coverUrl ?? '',
        screenshotUrls: game.screenshots,
        files: [],
        platform: { source: pkg.name, id: 'web', slug: 'web', name: 'Web' },
        metadata: {
            genres: game.genres,
            companies: game.authors,
            game_modes: [],
            age_ratings: [],
            itchUpload: { id: WEB_DOWNLOAD_ID, name: 'Web version' }
        }
    };
}

export function toDownloadLookupFile (game: ItchGame, upload: Upload)
{
    return {
        id: String(upload.id),
        format: upload.displayName || upload.filename || 'itch.io upload',
        mtime: null,
        size: Number.isFinite(upload.size) ? upload.size : null,
        download_url: game.pageUrl
    };
}

export function webDownloadLookupFile (game: ItchGame)
{
    return {
        id: WEB_DOWNLOAD_ID,
        format: 'HTML5 — play in Gameflow',
        mtime: game.updatedAt ?? null,
        size: null,
        download_url: game.pageUrl
    };
}

export default class ItchPlugin implements PluginType<Settings>
{
    settingsSchema = SettingsSchema;
    private client = new ItchClient();
    private butler?: ButlerService;
    private butlerDownloadPath?: string;
    private butlerTransition: Promise<void> = Promise.resolve();
    private getDownloadPath?: () => string;

    private async getButler (downloadPath: string)
    {
        let service: ButlerService | undefined;
        const transition = this.butlerTransition.then(async () =>
        {
            if (this.butler && this.butlerDownloadPath === downloadPath)
            {
                service = this.butler;
                return;
            }

            const previous = this.butler;
            this.butler = undefined;
            this.butlerDownloadPath = undefined;
            if (previous) await previous.cleanup();

            service = new ButlerService(downloadPath);
            this.butler = service;
            this.butlerDownloadPath = downloadPath;
        });
        this.butlerTransition = transition.catch(() => {});
        await transition;
        return service!;
    }

    async load (ctx: PluginLoadingContextType<Settings>)
    {
        this.getDownloadPath = () => ctx.app.config.get('downloadPath');
        const getGame = (id: string) => this.client.game(decodeGameId(id));
        const getCollection = async () =>
        {
            const collectionUrl = ctx.config.get('collectionUrl');
            let collectionId: number | undefined;
            try
            {
                const match = new URL(collectionUrl).pathname.match(/^\/c\/(\d+)(?:\/|$)/);
                const parsed = Number(match?.[1]);
                if (Number.isSafeInteger(parsed)) collectionId = parsed;
            } catch {}

            if (collectionId)
            {
                try
                {
                    const games = await (await this.getButler(ctx.app.config.get('downloadPath')))
                        .collectionGames(collectionId, ctx.config.get('collectionLimit'));
                    if (games)
                    {
                        return games.flatMap(game =>
                        {
                            if (!game.url || !game.title) return [];
                            const pageUrl = new URL(game.url);
                            if (pageUrl.protocol !== 'https:' || !pageUrl.hostname.endsWith('.itch.io')) return [];
                            return [{
                                id: encodeGameId(pageUrl.href),
                                itchId: String(game.id),
                                pageUrl: pageUrl.href,
                                name: game.title,
                                coverUrl: game.coverUrl,
                                summary: undefined,
                                author: undefined,
                                genre: undefined,
                                web: false
                            } satisfies ItchListing];
                        });
                    }
                } catch {}
            }

            return this.client.collection(collectionUrl);
        };

        ctx.hooks.games.fetchGames.tapPromise(pkg.name, async ({ query, games }) =>
        {
            if (query.source !== 'store' || query.collection_source || query.collection_id) return;

            const search = query.search?.trim().toLocaleLowerCase();
            const collection = (await getCollection())
                .slice(0, ctx.config.get('collectionLimit'))
                .filter(game => !search
                    || game.name.toLocaleLowerCase().includes(search)
                    || game.author?.toLocaleLowerCase().includes(search)
                    || game.genre?.toLocaleLowerCase().includes(search));
            const offset = query.offset ?? 0;
            const limit = query.limit ?? 50;
            const listings = collection.slice(offset, offset + limit);
            const settled = await Promise.allSettled(listings.map(game => this.client.game(game.pageUrl)));
            const itchGames = settled.filter((result): result is PromiseFulfilledResult<ItchGame> => result.status === 'fulfilled')
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
            return toDetailedGame(game);
        });

        ctx.hooks.games.fetchDownloads.tapPromise(pkg.name, async ({ source, id, downloadId }) =>
        {
            if (source !== pkg.name) return;
            const game = await getGame(id);
            const webDownloads = game.web ? [toWebDownloadInfo(game)] : [];
            if (downloadId === WEB_DOWNLOAD_ID) return webDownloads;
            if (!game.itchId) return downloadId ? [] : webDownloads;
            const itchId = Number(game.itchId);
            if (!Number.isSafeInteger(itchId)) return downloadId ? [] : webDownloads;
            let result: ButlerUploadSet;
            try
            {
                result = await (await this.getButler(ctx.app.config.get('downloadPath'))).getUploads(itchId);
            } catch (error)
            {
                if (webDownloads.length && !downloadId) return webDownloads;
                throw error;
            }
            const downloads = result.uploads.map(upload => toButlerDownloadInfo(game, upload));
            const available = [...webDownloads, ...downloads];
            return downloadId ? available.filter(download => download.id === downloadId) : available;
        });

        const performInstall = (ctx.hooks.games as typeof ctx.hooks.games & {
            performInstall: { tapPromise: (name: string, handler: (install: {
                source: string;
                id: string;
                downloadId?: string;
                info: DownloadInfo;
                downloadPath: string;
                abortSignal?: AbortSignal;
                updateProgress: (progress: number) => void;
            }) => Promise<{ info: DownloadInfo; files: string[]; } | undefined>) => void; };
        }).performInstall;
        if (!performInstall) throw new Error('The itch.io download integration requires a Gameflow SDK with games.performInstall support');
        performInstall.tapPromise(pkg.name, async ({ source, id, downloadId, info, downloadPath, abortSignal, updateProgress }) =>
        {
            if (source !== pkg.name) return;
            const game = await getGame(id);
            if ((downloadId ?? info.id) === WEB_DOWNLOAD_ID)
            {
                if (!game.web) throw new Error('This itch.io game does not provide a browser version');
                updateProgress(100);
                return { info: toWebDownloadInfo(game), files: [] };
            }
            const itchId = Number(game.itchId);
            if (!Number.isSafeInteger(itchId)) throw new Error('This itch.io page does not expose a numeric game ID required by Butler');
            const uploadId = Number(downloadId ?? info.id);
            if (!Number.isSafeInteger(uploadId)) throw new Error('Invalid itch.io upload ID: ' + (downloadId ?? info.id));
            const installed = await (await this.getButler(downloadPath)).install(itchId, uploadId, abortSignal, updateProgress)
                .catch(error => { throw butlerError('Could not install itch.io game', error); });
            return {
                info: {
                    ...info,
                    path_fs: installed.relativePath,
                    metadata: {
                        ...info.metadata,
                        itchUpload: { ...info.metadata?.itchUpload, id: installed.upload.id, caveId: installed.caveId }
                    }
                },
                files: [installed.path]
            };
        });

        const performUninstall = (ctx.hooks.games as typeof ctx.hooks.games & {
            performUninstall?: { tapPromise: (name: string, handler: (uninstall: {
                source: string;
                id: string;
                gamePath: string | null;
                downloadPath: string;
            }) => Promise<boolean | undefined>) => void; };
        }).performUninstall;
        if (!performUninstall) throw new Error('The itch.io download integration requires a Gameflow SDK with games.performUninstall support');
        performUninstall.tapPromise(pkg.name, async ({ source, id, gamePath, downloadPath }) =>
        {
            if (source !== pkg.name) return;
            if (!gamePath) return true;
            const game = await getGame(id);
            const itchId = Number(game.itchId);
            if (!Number.isSafeInteger(itchId))
                throw new ButlerPluginError('This installed itch.io game has no valid Butler game ID');
            try
            {
                await (await this.getButler(downloadPath)).uninstall(itchId, gamePath);
                return true;
            } catch (error)
            {
                throw butlerError('Could not uninstall itch.io game', error);
            }
        });

        ctx.hooks.games.buildLaunchCommands.tapPromise({ name: pkg.name, before: 'com.simeonradivoev.gameflow.umu', stage: -200 }, async ({ source, sourceId, gamePath }) =>
        {
            if (source !== pkg.name || !sourceId) return;
            if (gamePath)
            {
                const game = await getGame(sourceId);
                const itchId = Number(game.itchId);
                if (!Number.isSafeInteger(itchId)) return new ButlerPluginError('This installed itch.io game has no valid Butler game ID');
                try
                {
                    const commands = await (await this.getButler(ctx.app.config.get('downloadPath'))).launchCommands(itchId, gamePath, { nativeOnly: process.platform === 'linux' });
                    return commands.length ? commands : undefined;
                } catch (error)
                {
                    return butlerError('Could not prepare the itch.io game for launch', error);
                }
            }
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
                metadata: { webUrl: game.embedUrl } as any
            }] as import('@simeonradivoev/gameflow-sdk/shared').CommandEntry[];
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

            const results = search
                ? await this.client.search(search, page ?? 1)
                : await getCollection();
            const listings = Array.from(new Map(results.map(game => [game.id, game])).values());
            const limit = rows ?? 20;
            // Search is paged remotely; collections are fetched as a single list.
            const offset = search ? 0 : ((page ?? 1) - 1) * limit;
            const items = listings.slice(offset, offset + limit).map(toDownloadEntry);
            // Collection totals are stable across pages. Search has no reported
            // total, so allow another page while the remote page is full.
            const count = search
                ? ((page ?? 1) - 1) * limit + items.length + (items.length === limit ? 1 : 0)
                : listings.length;
            matches.set(pkg.name, { count, items });
            return matches;
        });

        ctx.hooks.games.downloadLookup.tapPromise(pkg.name, async ({ source, id }) =>
        {
            if (source !== pkg.name) return;
            const game = await getGame(id);
            const files: DownloadLookupDetails['files'] = game.web ? [webDownloadLookupFile(game)] : [];
            const itchId = Number(game.itchId);
            if (Number.isSafeInteger(itchId))
            {
                try
                {
                    const result = await (await this.getButler(ctx.app.config.get('downloadPath'))).getUploads(itchId);
                    files.push(...result.uploads.map(upload => toDownloadLookupFile(game, upload)));
                } catch (error)
                {
                    if (!game.web) throw error;
                }
            }
            return {
                source: pkg.name,
                id: game.id,
                cover_url: game.coverUrl,
                name: game.name,
                summary: game.summary,
                date: game.updatedAt,
                files,
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

    async getEventsNames ()
    {
        if (!this.getDownloadPath) return itchAccountActions(undefined, 'Plugin is not loaded');
        try
        {
            const profile = await (await this.getButler(this.getDownloadPath())).profileStatus();
            return itchAccountActions(profile);
        } catch (error)
        {
            const message = error instanceof Error ? error.message : 'Unable to check itch.io login';
            return itchAccountActions(undefined, message);
        }
    }

    async onEvent (id: string, values?: unknown)
    {
        if (id === 'itch-api-key-help') return { openTab: API_KEYS_URL };
        if (!this.getDownloadPath) throw new ButlerPluginError('The itch.io plugin is not loaded');
        const butler = await this.getButler(this.getDownloadPath());
        if (id === 'itch-connect')
        {
            const apiKey = values && typeof values === 'object' && 'apiKey' in values && typeof values.apiKey === 'string'
                ? values.apiKey
                : '';
            await butler.loginWithAPIKey(apiKey);
            return { reload: true };
        }
        if (id === 'itch-disconnect')
        {
            await butler.logout();
            return { reload: true };
        }
        throw new ButlerPluginError(`Unknown itch.io action: ${id}`);
    }

    async cleanup ()
    {
        this.client.clear();
        const transition = this.butlerTransition.then(async () =>
        {
            const butler = this.butler;
            this.butler = undefined;
            this.butlerDownloadPath = undefined;
            if (butler) await butler.cleanup();
        });
        this.butlerTransition = transition.catch(() => {});
        await transition;
        this.getDownloadPath = undefined;
    }
}
