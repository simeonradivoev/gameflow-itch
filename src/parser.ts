import { load } from 'cheerio';
import type { ItchGame, ItchListing } from './types';

const ITCH_GAME_HOST = /^(?<creator>[^.]+)\.itch\.io$/i;

export function encodeGameId (pageUrl: string)
{
    return Buffer.from(new URL(pageUrl).href, 'utf8').toString('base64url');
}

export function decodeGameId (id: string)
{
    const pageUrl = Buffer.from(id, 'base64url').toString('utf8');
    const url = new URL(pageUrl);
    if (url.protocol !== 'https:' || !ITCH_GAME_HOST.test(url.hostname))
        throw new Error('Invalid itch.io game ID');
    return url.href;
}

export function parseListings (html: string): ItchListing[]
{
    const $ = load(html);
    return $('.game_cell').map((_, element) =>
    {
        const cell = $(element);
        const link = cell.find('.game_title .game_link, .thumb_link.game_link').first();
        const pageUrl = link.attr('href');
        if (!pageUrl) return undefined;

        let normalizedUrl: string;
        try
        {
            normalizedUrl = new URL(pageUrl).href;
        } catch
        {
            return undefined;
        }

        return {
            id: encodeGameId(normalizedUrl),
            itchId: cell.attr('data-game_id'),
            pageUrl: normalizedUrl,
            name: cell.find('.game_title .game_link').first().text().trim(),
            summary: cell.find('.game_text').attr('title')?.trim() || cell.find('.game_text').text().trim() || undefined,
            author: cell.find('.game_author a').first().text().trim() || undefined,
            genre: cell.find('.game_genre').first().text().trim() || undefined,
            coverUrl: cell.find('.game_thumb img').first().attr('src') || cell.find('.game_thumb img').first().attr('data-lazy_src') || undefined,
            web: cell.find('.web_flag').length > 0
        } satisfies ItchListing;
    }).get().filter(entry => !!entry && !!entry.name) as ItchListing[];
}

function readInfoRow ($: ReturnType<typeof load>, label: string)
{
    const row = $('.game_info_panel_widget tr').filter((_, element) => $(element).find('td').first().text().trim() === label).first();
    return row.find('td').eq(1);
}

export function parseGamePage (pageUrl: string, html: string): ItchGame
{
    const $ = load(html);
    const iframeMarkup = $('.iframe_placeholder').attr('data-iframe');
    const embedUrl = iframeMarkup ? load(iframeMarkup)('iframe').attr('src') : undefined;
    let safeEmbedUrl: string | undefined;
    if (embedUrl)
    {
        const url = new URL(embedUrl);
        if (url.protocol === 'https:' && (url.hostname === 'html.itch.zone' || url.hostname.endsWith('.itch.zone')))
            safeEmbedUrl = url.href;
    }

    const title = $('meta[property="twitter:title"]').attr('content')?.split(' by ')[0]
        || $('title').text().split(' by ')[0]
        || $('.game_title').first().text().trim();
    const summary = $('meta[name="description"]').attr('content')?.trim()
        || $('meta[property="og:description"]').attr('content')?.trim()
        || undefined;
    const coverUrl = $('meta[property="og:image"]').attr('content') || undefined;
    const authorLinks = readInfoRow($, 'Authors').find('a');
    const authors = authorLinks.map((_, element) => $(element).text().trim()).get().filter(Boolean);
    const genres = readInfoRow($, 'Genre').find('a').map((_, element) => $(element).text().trim()).get().filter(Boolean);
    const tags = readInfoRow($, 'Tags').find('a').map((_, element) => $(element).text().trim()).get().filter(Boolean);
    const updatedTitle = readInfoRow($, 'Updated').find('abbr').attr('title');
    const updatedAt = updatedTitle ? new Date(updatedTitle.replace(' @ ', ' ')) : undefined;
    const screenshots = $('.screenshot_list a').map((_, element) => $(element).attr('href')).get()
        .filter((url): url is string => !!url && url.startsWith('https://img.itch.zone/'));
    const normalizedUrl = new URL(pageUrl).href;

    return {
        id: encodeGameId(normalizedUrl),
        itchId: $('meta[name="itch:path"]').attr('content')?.split('/').at(-1),
        pageUrl: normalizedUrl,
        name: title.trim(),
        summary,
        author: authors[0],
        genre: genres[0],
        coverUrl,
        web: !!safeEmbedUrl,
        embedUrl: safeEmbedUrl,
        screenshots,
        genres,
        tags,
        authors,
        updatedAt: updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : undefined
    };
}
