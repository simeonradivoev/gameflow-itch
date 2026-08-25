import { createNotification, createRequest } from '@itchio/butlerd';

export interface Profile
{
    id: number;
    lastConnected: string;
    user?: {
        username?: string;
        displayName?: string;
        coverUrl?: string;
    };
}

export interface Platforms
{
    windows?: boolean | string;
    linux?: boolean | string;
    osx?: boolean | string;
}

export interface Upload
{
    id: number;
    filename: string;
    displayName: string;
    size: number;
    type: string;
    platforms: Platforms;
    build?: unknown;
}

export interface Game
{
    id: number;
    title?: string;
    url?: string;
    coverUrl?: string;
    [key: string]: unknown;
}

export interface CollectionGame
{
    collectionId: number;
    gameId: number;
    game: Game;
    position: number;
}

export interface Cave
{
    id: string;
    game?: Game;
    upload?: Upload;
    installInfo: {
        installFolder: string;
        installedSize: number;
    };
}

export interface LaunchTarget
{
    action: {
        name: string;
        path: string;
        args?: string[];
    };
    host: {
        wrapper?: {
            beforeTarget: string[];
            betweenTargetAndArgs: string[];
            afterArgs: string[];
            wrapperBinary: string;
            env: Record<string, string>;
            needRelativeTarget: boolean;
        };
    };
    strategy: {
        strategy: 'native' | 'html' | 'url' | 'shell' | '';
        fullTargetPath: string;
        candidate?: { flavor?: string; };
    };
}
export const ProfileList = createRequest<Record<string, never>, { profiles: Profile[]; }>('Profile.List');
export const ProfileUseSavedLogin = createRequest<{ profileId: number; }, { profile: Profile; }>('Profile.UseSavedLogin');
export const ProfileLoginWithAPIKey = createRequest<{ apiKey: string; }, { profile: Profile; }>('Profile.LoginWithAPIKey');
export const ProfileForget = createRequest<{ profileId: number; }, Record<string, never>>('Profile.Forget');

export const InstallGetUploads = createRequest<{ gameId: number; profileId?: number; }, {
    game: Game;
    uploads: Upload[];
}>('Install.GetUploads');

export const FetchGame = createRequest<{ gameId: number; fresh?: boolean; }, { game?: Game; stale?: boolean; }>('Fetch.Game');
export const FetchGameUploads = createRequest<{ gameId: number; compatible: boolean; fresh?: boolean; }, {
    uploads: Upload[];
    stale?: boolean;
}>('Fetch.GameUploads');


export const FetchCollectionGames = createRequest<{
    profileId: number;
    collectionId: number;
    limit?: number;
    search?: string;
    fresh?: boolean;
}, {
    items: CollectionGame[];
    nextCursor?: unknown;
    stale?: boolean;
}>('Fetch.Collection.Games');
export interface InstallLocation
{
    id: string;
    path: string;
}

export const InstallLocationsList = createRequest<Record<string, never>, { installLocations: InstallLocation[]; }>('Install.Locations.List');
export const InstallLocationsAdd = createRequest<{ path: string; }, { installLocation?: InstallLocation; }>('Install.Locations.Add');
export const InstallQueue = createRequest<{
    caveId?: string;
    reason: 'install' | 'reinstall' | 'update' | 'version-switch';
    installLocationId?: string;
    game: Game;
    upload: Upload;
    build?: unknown;
    queueDownload: boolean;
    profileId?: number;
}, {
    id: string;
    caveId: string;
    stagingFolder: string;
}>('Install.Queue');
export const InstallPerform = createRequest<{ id: string; stagingFolder: string; }, { caveId: string; }>('Install.Perform');
export const InstallCancel = createRequest<{ id: string; }, { didCancel: boolean; }>('Install.Cancel');
export const UninstallPerform = createRequest<{ caveId: string; hard: boolean; }, Record<string, never>>('Uninstall.Perform');
export const FetchCave = createRequest<{ caveId: string; profileId?: number; }, { cave?: Cave; }>('Fetch.Cave');

export const FetchCaves = createRequest<{
    limit?: number;
    cursor?: unknown;
    profileId?: number;
}, { items: Cave[]; nextCursor?: unknown; }>('Fetch.Caves');
export const LaunchGetTargets = createRequest<{ caveId: string; }, { targets: LaunchTarget[]; }>('Launch.GetTargets');
export const Log = createNotification<unknown>('Log');
export const Progress = createNotification<{ progress: number; eta: number; bps: number; }>('Progress');
