import { describe, expect, test } from 'bun:test';
import { itchAccountActions } from '../src/index';

describe('itch.io account actions', () =>
{
    test('requests the API key through a transient password field while disconnected', () =>
    {
        const actions = itchAccountActions();
        const connect = actions.find(action => action.id === 'itch-connect');
        expect(connect?.status).toBe('Not connected');
        expect(connect?.fields).toEqual([expect.objectContaining({
            id: 'apiKey',
            type: 'password',
            required: true
        })]);
        expect(actions.some(action => action.id === 'itch-api-key-help')).toBeTrue();
    });

    test('shows account identity and disconnect after Butler restores a profile', () =>
    {
        const actions = itchAccountActions({
            id: 42,
            lastConnected: '2026-01-01T00:00:00Z',
            user: { username: 'player', displayName: 'Player One' }
        });
        expect(actions.find(action => action.id === 'itch-disconnect')?.status).toBe('Connected as Player One');
        expect(actions.some(action => action.id === 'itch-connect')).toBeFalse();
    });
});