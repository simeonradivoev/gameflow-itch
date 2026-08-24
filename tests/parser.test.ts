import { describe, expect, test } from 'bun:test';
import { decodeGameId, encodeGameId, parseGamePage, parseListings } from '../src/parser';

const listingHtml = `
<div class="game_cell has_cover" data-game_id="4753250">
  <div class="game_thumb"><a class="thumb_link game_link" href="https://dokanola.itch.io/druids-haven"><img src="https://img.itch.zone/cover.gif"></a></div>
  <div class="game_cell_data">
    <div class="game_title"><a class="title game_link" href="https://dokanola.itch.io/druids-haven">Druid's Haven</a></div>
    <div class="game_text" title="Grow a forest."></div>
    <div class="game_author"><a>dokanola</a></div>
    <div class="game_genre">Action</div>
    <div class="game_platform"><span class="web_flag">Play in browser</span></div>
  </div>
</div>`;

const gameHtml = `
<html><head>
  <title>Druid's Haven by dokanola - itch.io</title>
  <meta name="description" content="Grow a forest.">
  <meta name="itch:path" content="games/4753250">
  <meta property="og:image" content="https://img.itch.zone/cover.gif">
</head><body>
  <div class="iframe_placeholder" data-iframe="&lt;iframe src=&quot;https://html.itch.zone/html/123/index.html?v=1&quot;&gt;&lt;/iframe&gt;"></div>
  <div class="game_info_panel_widget"><table>
    <tr><td>Updated</td><td><abbr title="17 August 2026 @ 23:44 UTC"></abbr></td></tr>
    <tr><td>Authors</td><td><a>dokanola</a><a>Simeon</a></td></tr>
    <tr><td>Genre</td><td><a>Action</a><a>Strategy</a></td></tr>
    <tr><td>Tags</td><td><a>Web</a><a>Gamepad</a></td></tr>
  </table></div>
  <div class="screenshot_list"><a href="https://img.itch.zone/shot.png"><img class="screenshot"></a></div>
</body></html>`;

describe('itch.io parser', () =>
{
    test('parses public listing cards', () =>
    {
        const [game] = parseListings(listingHtml);
        expect(game?.name).toBe("Druid's Haven");
        expect(game?.itchId).toBe('4753250');
        expect(game?.web).toBeTrue();
        expect(game?.coverUrl).toBe('https://img.itch.zone/cover.gif');
        expect(decodeGameId(game!.id)).toBe('https://dokanola.itch.io/druids-haven');
    });

    test('parses and validates HTML5 embed metadata', () =>
    {
        const game = parseGamePage('https://dokanola.itch.io/druids-haven', gameHtml);
        expect(game.embedUrl).toBe('https://html.itch.zone/html/123/index.html?v=1');
        expect(game.authors).toEqual(['dokanola', 'Simeon']);
        expect(game.genres).toEqual(['Action', 'Strategy']);
        expect(game.tags).toEqual(['Web', 'Gamepad']);
        expect(game.screenshots).toEqual(['https://img.itch.zone/shot.png']);
        expect(game.updatedAt?.toISOString()).toBe('2026-08-17T23:44:00.000Z');
    });

    test('rejects non-itch game IDs and embed origins', () =>
    {
        expect(() => decodeGameId(encodeGameId('https://example.com/game'))).toThrow();
        const malicious = gameHtml.replace('https://html.itch.zone/html/123/index.html?v=1', 'https://example.com/game.html');
        expect(parseGamePage('https://dokanola.itch.io/druids-haven', malicious).embedUrl).toBeUndefined();
    });
});
