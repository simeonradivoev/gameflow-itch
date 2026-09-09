import { describe, expect, test } from 'bun:test';
import { toButlerDownloadInfo, toDownloadLookupFile, toWebDownloadInfo, webDownloadLookupFile } from '../src';
import type { Upload } from '../src/butler/messages';
import type { ItchGame } from '../src/types';

const game: ItchGame = {
    id: 'https://example.itch.io/title',
    itchId: '42',
    pageUrl: 'https://example.itch.io/title',
    name: 'Example Game',
    summary: 'Summary',
    coverUrl: 'https://img.itch.zone/cover.png',
    web: true,
    embedUrl: 'https://html.itch.zone/html/example/index.html',
    screenshots: [],
    genres: [],
    tags: [],
    authors: ['Developer']
};

const upload: Upload = {
    id: 7,
    filename: 'example-windows.zip',
    displayName: 'Windows build',
    size: 12345,
    type: 'default',
    platforms: { windows: true }
};

describe('itch.io download choices', () =>
{
    test('exposes a pathless web install descriptor', () =>
    {
        const info = toWebDownloadInfo(game);
        expect(info).toMatchObject({
            id: 'web',
            source_id: game.id,
            system_slug: 'web',
            files: [],
            platform: { slug: 'web' },
            metadata: { itchUpload: { id: 'web', name: 'Web version' } }
        });
    });

    test('keeps native Butler uploads as separate install choices', () =>
    {
        const info = toButlerDownloadInfo(game, upload);
        expect(info).toMatchObject({
            id: '7',
            system_slug: 'win',
            metadata: { itchUpload: { id: 7, name: 'Windows build', size: 12345 } }
        });
    });

    test('populates download detail rows for web and native versions', () =>
    {
        expect(webDownloadLookupFile(game)).toMatchObject({
            id: 'web',
            format: 'HTML5 — play in Gameflow',
            download_url: game.pageUrl
        });
        expect(toDownloadLookupFile(game, upload)).toEqual({
            id: '7',
            format: 'Windows build',
            mtime: null,
            size: 12345,
            download_url: game.pageUrl
        });
    });
});

test('multi-platform uploads prefer the host platform while Windows-only uploads stay Windows', async () =>
{
    const { uploadSystemSlug } = await import('../src');
    const mixed = { ...upload, platforms: { windows: true, linux: true, osx: true } };
    expect(uploadSystemSlug(mixed, 'linux')).toBe('linux');
    expect(uploadSystemSlug(mixed, 'win32')).toBe('win');
    expect(uploadSystemSlug(mixed, 'darwin')).toBe('macos');
    expect(uploadSystemSlug(upload, 'linux')).toBe('win');
});
