import { Client, getRpcErrorData, Instance, type RequestCreator } from '@itchio/butlerd';
import fs from 'node:fs/promises';
import path from 'node:path';
import pkg from '../../package.json';
import { ensureButler } from './binary';
import {
    FetchCave,
    FetchCaves,
    FetchCollectionGames,
    FetchGame,
    FetchGameUploads,
    InstallCancel,
    InstallLocationsAdd,
    InstallLocationsList,
    InstallPerform,
    InstallQueue,
    Log,
    LaunchGetTargets,
    ProfileForget,
    ProfileList,
    ProfileLoginWithAPIKey,
    ProfileUseSavedLogin,
    Progress,
    UninstallPerform,
    type Cave,
    type Game,
    type Profile,
    type Upload
} from './messages';
import { chooseFallbackNativeCandidate, isHelperLaunchTarget, isPathInside, launchTargetToCommand, samePath } from './launch';

export class ButlerPluginError extends Error
{
    override name = 'ButlerPluginError';

    toJSON ()
    {
        return { name: this.name, message: this.message };
    }
}

export function isButlerLoginRequired (error: unknown)
{
    const statusCode = error instanceof Error ? getRpcErrorData(error)?.apiError?.statusCode : undefined;
    return statusCode === 401 || statusCode === 403 || (error instanceof Error && /no profiles found/i.test(error.message));
}

export function butlerError (message: string, cause: unknown)
{
    if (cause instanceof ButlerPluginError) return cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    return new ButlerPluginError(`${message}: ${detail}`, { cause });
}

interface ButlerConversation
{
    onNotification<T> (notification: ReturnType<typeof import('@itchio/butlerd').createNotification<T>>, handler: (params: T) => void): void;
}

interface ButlerClient
{
    call<Params, Result> (request: RequestCreator<Params, Result>, params: Params, setup?: (conversation: ButlerConversation) => void): Promise<Result>;
}

const ignoreButlerLogs = (conversation: ButlerConversation) => conversation.onNotification(Log, () => {});

export async function authenticateButler (client: ButlerClient): Promise<Profile | undefined>
{
    const profiles = (await client.call(ProfileList, {})).profiles
        .toSorted((left, right) => Date.parse(right.lastConnected) - Date.parse(left.lastConnected));
    for (const profile of profiles)
    {
        try
        {
            return (await client.call(ProfileUseSavedLogin, { profileId: profile.id }, ignoreButlerLogs)).profile;
        } catch {}
    }

    return undefined;
}

export async function loginButlerWithAPIKey (client: ButlerClient, apiKey: string)
{
    const normalized = apiKey.trim();
    if (!normalized) throw new ButlerPluginError('Enter an itch.io API key');
    try
    {
        return (await client.call(ProfileLoginWithAPIKey, { apiKey: normalized }, ignoreButlerLogs)).profile;
    } catch
    {
        // Do not retain the RPC error as a cause: a transport implementation may
        // include the request parameters (and therefore the transient key) in it.
        throw new ButlerPluginError('itch.io rejected the API key. Generate a new key and try again.');
    }
}

export async function forgetButlerProfiles (client: ButlerClient)
{
    const profiles = (await client.call(ProfileList, {})).profiles;
    const results = await Promise.allSettled(profiles.map(profile => client.call(ProfileForget, { profileId: profile.id })));
    const failures = results.filter(result => result.status === 'rejected').length;
    if (failures) throw new ButlerPluginError(`Could not sign out of itch.io: failed to forget ${failures} of ${profiles.length} profiles`);
    return profiles.length;
}

export function relativeInstallPath (downloadPath: string, installFolder: string)
{
    const relative = path.relative(path.resolve(downloadPath), path.resolve(installFolder));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new Error('Butler returned an install folder outside the Gameflow download directory');
    return relative;
}

export function butlerDaemonArgs (statePath: string, processId = process.pid)
{
    return [
        `--dbpath=${path.join(statePath, 'butler.db')}`,
        '--address=https://itch.io',
        `--user-agent=${pkg.name}/${pkg.version}`,
        `--destiny-pid=${processId}`
    ];
}

export interface ButlerUploadSet
{
    game: Game;
    uploads: Upload[];
    profile?: Profile;
}

export class ButlerService
{
    private instance?: Instance;
    private client?: ButlerClient;
    private activeProfile?: Profile;
    private starting?: Promise<ButlerClient>;
    private uploadCache = new Map<number, { expiresAt: number; result: Promise<ButlerUploadSet>; }>();
    private collectionCache = new Map<string, { expiresAt: number; result: Promise<Game[] | undefined>; }>();

    constructor (private readonly downloadPath: string) {}

    private get statePath ()
    {
        return path.join(this.downloadPath, '.gameflow', 'itch');
    }

    private async start ()
    {
        if (this.client) return this.client;
        if (this.starting) return this.starting;
        this.starting = (async () =>
        {
            const binary = await ensureButler(this.statePath);
            await fs.mkdir(this.statePath, { recursive: true });
            this.instance = new Instance({
                butlerExecutable: binary,
                endpointTimeout: 15000,
                args: butlerDaemonArgs(this.statePath)
            });
            const client = new Client(await this.instance.getEndpoint());
            this.client = client;
            return client;
        })();
        try
        {
            return await this.starting;
        } finally
        {
            this.starting = undefined;
        }
    }

    private async fetchUploads (gameId: number): Promise<ButlerUploadSet>
    {
        const client = await this.start();
        const profile = this.activeProfile ?? await authenticateButler(client);
        this.activeProfile = profile;
        try
        {
            const [gameResult, uploadResult] = await Promise.all([
                client.call(FetchGame, { gameId, fresh: true }, ignoreButlerLogs),
                client.call(FetchGameUploads, { gameId, compatible: true, fresh: true }, ignoreButlerLogs)
            ]);
            if (!gameResult.game) throw new ButlerPluginError('itch.io did not return game metadata for this download');
            const uploads = uploadResult.uploads.filter(upload =>
                Boolean(upload.platforms.windows || upload.platforms.linux || upload.platforms.osx));
            return { game: gameResult.game, uploads, profile };
        } catch (error)
        {
            if (!profile && isButlerLoginRequired(error))
                throw new ButlerPluginError('itch.io download login required. Open the itch.io plugin settings and sign in, then retry the download.', { cause: error });
            throw butlerError('Could not load itch.io downloads', error);
        }
    }

    async getUploads (gameId: number): Promise<ButlerUploadSet>
    {
        const cached = this.uploadCache.get(gameId);
        if (cached && cached.expiresAt > Date.now()) return cached.result;

        const result = this.fetchUploads(gameId);
        this.uploadCache.set(gameId, { expiresAt: Date.now() + 60_000, result });
        void result.catch(() =>
        {
            if (this.uploadCache.get(gameId)?.result === result) this.uploadCache.delete(gameId);
        });
        return result;
    }

    async collectionGames (collectionId: number, limit: number, search?: string)
    {
        const client = await this.start();
        const profile = this.activeProfile ?? await authenticateButler(client);
        this.activeProfile = profile;
        if (!profile) return;

        const cacheKey = `${profile.id}:${collectionId}:${limit}:${search ?? ''}`;
        const cached = this.collectionCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return cached.result;

        const result = client.call(FetchCollectionGames, {
            profileId: profile.id,
            collectionId,
            limit,
            search,
            fresh: true
        }, ignoreButlerLogs).then(response => response.items.map(item => item.game));
        this.collectionCache.set(cacheKey, { expiresAt: Date.now() + 60_000, result });
        void result.catch(() =>
        {
            if (this.collectionCache.get(cacheKey)?.result === result) this.collectionCache.delete(cacheKey);
        });
        return result;
    }

    async profileStatus ()
    {
        const client = await this.start();
        this.activeProfile = await authenticateButler(client);
        return this.activeProfile;
    }

    async loginWithAPIKey (apiKey: string)
    {
        const client = await this.start();
        this.activeProfile = await loginButlerWithAPIKey(client, apiKey);
        this.uploadCache.clear();
        this.collectionCache.clear();
        return this.activeProfile;
    }

    async logout ()
    {
        const client = await this.start();
        try
        {
            return await forgetButlerProfiles(client);
        } finally
        {
            this.activeProfile = undefined;
            this.uploadCache.clear();
            this.collectionCache.clear();
        }
    }

    private async installLocation (client: ButlerClient)
    {
        const installPath = path.resolve(this.downloadPath, 'roms', 'itch');
        await fs.mkdir(installPath, { recursive: true });
        const matches = (locationPath: string) => process.platform === 'win32'
            ? path.resolve(locationPath).toLocaleLowerCase() === installPath.toLocaleLowerCase()
            : path.resolve(locationPath) === installPath;
        const existing = (await client.call(InstallLocationsList, {})).installLocations.find(location => matches(location.path));
        if (existing) return existing;
        const added = (await client.call(InstallLocationsAdd, { path: installPath })).installLocation;
        if (added) return added;
        const raced = (await client.call(InstallLocationsList, {})).installLocations.find(location => matches(location.path));
        if (!raced) throw new Error('Butler did not create the Gameflow itch.io install location');
        return raced;
    }

    private async cavesForGame (client: ButlerClient, gameId: number, profileId?: number)
    {
        const caves: Cave[] = [];
        let cursor: unknown;
        for (let page = 0; page < 100; page++)
        {
            const result = await client.call(FetchCaves, { limit: 100, cursor, profileId }, ignoreButlerLogs);
            caves.push(...result.items.filter(candidate => Number(candidate.game?.id) === gameId));
            if (!result.nextCursor) break;
            cursor = result.nextCursor;
        }
        return caves;
    }

    async install (gameId: number, uploadId: number, abortSignal: AbortSignal | undefined, updateProgress: (progress: number) => void)
    {
        const client = await this.start();
        const { game, uploads, profile } = await this.getUploads(gameId);
        const upload = uploads.find(candidate => candidate.id === uploadId);
        if (!upload) throw new Error(`itch.io upload ${uploadId} is no longer available for this platform`);
        abortSignal?.throwIfAborted();

        const caves = await this.cavesForGame(client, gameId, profile?.id);
        const exactCave = caves.find(cave => Number(cave.upload?.id) === uploadId);
        const cave = exactCave ?? caves[0];
        const location = cave ? undefined : await this.installLocation(client);
        const queued = await client.call(InstallQueue, {
            caveId: cave?.id,
            reason: exactCave ? 'reinstall' : cave ? 'version-switch' : 'install',
            installLocationId: location?.id,
            game,
            upload,
            build: upload.build,
            // Gameflow drives Install.Perform itself. Downloads.Drive owns and
            // completes persistent queue entries; direct performs leave them pending.
            queueDownload: false,
            profileId: profile?.id
        }, ignoreButlerLogs);

        const cancel = () => void client.call(InstallCancel, { id: queued.id }).catch(() => {});
        abortSignal?.addEventListener('abort', cancel, { once: true });
        try
        {
            if (abortSignal?.aborted)
            {
                await client.call(InstallCancel, { id: queued.id }).catch(() => {});
                abortSignal.throwIfAborted();
            }
            const performed = await client.call(InstallPerform, { id: queued.id, stagingFolder: queued.stagingFolder }, conversation =>
            {
                conversation.onNotification(Progress, progress => updateProgress(Math.max(0, Math.min(100, progress.progress * 100))));
                conversation.onNotification(Log, () => {});
            });
            abortSignal?.throwIfAborted();
            const caveId = performed.caveId || queued.caveId;
            const installedCave = (await client.call(FetchCave, { caveId, profileId: profile?.id }, ignoreButlerLogs)).cave;
            if (!installedCave) throw new Error(`Butler installed the game but could not find cave ${caveId}`);
            updateProgress(100);
            return {
                path: installedCave.installInfo.installFolder,
                relativePath: relativeInstallPath(this.downloadPath, installedCave.installInfo.installFolder),
                caveId,
                upload
            };
        } finally
        {
            abortSignal?.removeEventListener('abort', cancel);
        }
    }

    async uninstall (gameId: number, gamePath: string)
    {
        const client = await this.start();
        const profile = this.activeProfile ?? await authenticateButler(client);
        this.activeProfile = profile;
        const absoluteGamePath = path.isAbsolute(gamePath) ? path.resolve(gamePath) : path.resolve(this.downloadPath, gamePath);
        if (!isPathInside(this.downloadPath, absoluteGamePath))
            throw new ButlerPluginError('The installed itch.io game path is outside the Gameflow download directory');

        const caves = (await this.cavesForGame(client, gameId, profile?.id))
            .filter(cave => samePath(cave.installInfo.installFolder, absoluteGamePath));
        // Butler forgets the cave before wiping files and suppresses wipe errors.
        // Remove files first so a locked executable cannot orphan its cave.
        try
        {
            await fs.rm(absoluteGamePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch (error)
        {
            throw new ButlerPluginError('Could not remove the itch.io game files. Close the game and any programs using its files, then retry deletion.', { cause: error });
        }
        const failures: unknown[] = [];
        for (const cave of caves)
        {
            try
            {
                await client.call(UninstallPerform, { caveId: cave.id, hard: true }, ignoreButlerLogs);
            } catch (error)
            {
                failures.push(error);
            }
        }
        if (failures.length) throw butlerError(`Could not remove ${failures.length} Butler installation record(s)`, failures[0]);
        this.uploadCache.delete(gameId);
        return caves.length;
    }


    async launchCommands (gameId: number, gamePath: string)
    {
        const client = await this.start();
        const profile = this.activeProfile ?? await authenticateButler(client);
        this.activeProfile = profile;
        const absoluteGamePath = path.isAbsolute(gamePath) ? path.resolve(gamePath) : path.resolve(this.downloadPath, gamePath);
        if (!isPathInside(this.downloadPath, absoluteGamePath))
            throw new ButlerPluginError('The installed itch.io game path is outside the Gameflow download directory');

        const cave = (await this.cavesForGame(client, gameId, profile?.id)).find(candidate =>
            samePath(candidate.installInfo.installFolder, absoluteGamePath));
        if (!cave) throw new ButlerPluginError('Could not find the Butler installation record for this itch.io game');

        const result = await client.call(LaunchGetTargets, { caveId: cave.id }, ignoreButlerLogs);
        let targets = result.targets.filter(target => !isHelperLaunchTarget(target));
        if (!targets.length)
        {
            const entries = await fs.readdir(cave.installInfo.installFolder, { withFileTypes: true });
            const candidates = await Promise.all(entries.map(async entry =>
            {
                const executable = entry.isFile()
                    ? Boolean((await fs.stat(path.join(cave!.installInfo.installFolder, entry.name))).mode & 0o111)
                    : false;
                return { name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory(), executable };
            }));
            const fallback = chooseFallbackNativeCandidate(candidates, cave);
            if (fallback)
            {
                const fullTargetPath = path.join(cave.installInfo.installFolder, fallback.name);
                targets = [{
                    action: { name: fallback.name, path: fallback.name },
                    host: {},
                    strategy: {
                        strategy: 'native',
                        fullTargetPath,
                        candidate: {
                            flavor: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'app-macos' : 'linux'
                        }
                    }
                }];
            }
        }
        const commands = targets
            .map((target, index) => launchTargetToCommand(target, cave!, index))
            .filter((command): command is NonNullable<typeof command> => Boolean(command));
        if (!commands.length)
        {
            if (result.targets.some(isHelperLaunchTarget))
                throw new ButlerPluginError('The itch.io installation contains only a crash/helper executable. Reinstall the game to restore its main executable.');
            throw new ButlerPluginError('This itch.io game does not expose a launch target Gameflow can open');
        }
        return commands;
    }

    async cleanup ()
    {
        // If bootstrap is still resolving, wait for it to publish its Instance so
        // we can cancel that exact daemon before a replacement service starts.
        await this.starting?.catch(() => {});
        this.client = undefined;
        const instance = this.instance;
        this.activeProfile = undefined;
        this.uploadCache.clear();
        this.collectionCache.clear();
        this.instance = undefined;
        if (instance) await instance.cancel();
    }
}
