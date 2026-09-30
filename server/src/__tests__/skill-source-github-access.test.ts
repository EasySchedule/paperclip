import type { Request } from 'express';
import type { Db } from '@paperclipai/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forbidden } from '../errors.js';
const mocks = vi.hoisted(() => ({ headers: vi.fn(), managed: vi.fn() }));
vi.mock('../services/tool-access.js', () => ({ toolAccessService: () => ({ githubReadHeaders: mocks.headers }) }));
vi.mock('../services/github-operation-credentials.js', () => ({ resolveGitHubOperationCredentials: mocks.managed }));
import { skillSourceGitHubReader } from '../services/skill-source-github-access.js';
const actor = (values: Record<string, unknown>) => values as Request['actor'];
const db = {} as Db;
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });
describe('GitHub source authorization', () => {
  it('reads public repositories anonymously without resolving a token', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: 1 })); vi.stubGlobal('fetch', fetch);
    const read = skillSourceGitHubReader(db, 'company', actor({ type: 'board', userId: 'alice', source: 'session' }), null);
    expect(await read('/repos/acme/public')).toEqual({ id: 1 });
    expect(mocks.headers).not.toHaveBeenCalled();
    expect(new Headers(fetch.mock.calls[0][1].headers).has('authorization')).toBe(false);
    expect(fetch.mock.calls[0][1].redirect).toBe('error');
    await expect(read('https://evil.test/repos/acme/public')).rejects.toThrow();
  });
  it('resolves the current caller for private reads and refreshes expired OAuth once', async () => {
    mocks.headers.mockResolvedValueOnce({ Authorization: 'Bearer old' }).mockResolvedValueOnce({ Authorization: 'Bearer new' });
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(Response.json({ id: 1 })); vi.stubGlobal('fetch', fetch);
    const read = skillSourceGitHubReader(db, 'company', actor({ type: 'board', userId: 'alice', source: 'session' }), 'connection');
    await read('/repos/acme/private');
    expect(mocks.headers.mock.calls).toEqual([['company', 'connection', 'alice', false, false], ['company', 'connection', 'alice', false, true]]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rechecks authorization if access is revoked during a repository scan', async () => {
    mocks.headers.mockResolvedValueOnce({ Authorization: 'Bearer allowed' }).mockRejectedValueOnce(forbidden('Authorization revoked.'));
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: 1 })); vi.stubGlobal('fetch', fetch);
    const read = skillSourceGitHubReader(db, 'company', actor({ type: 'board', userId: 'alice', source: 'session' }), 'connection');
    await read('/repos/acme/private');
    await expect(read('/repos/acme/private/git/trees/main')).rejects.toThrow('revoked');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not fall back to someone else’s token or anonymous access when authorization fails', async () => {
    mocks.headers.mockRejectedValue(forbidden('Reconnect your authorization.')); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(skillSourceGitHubReader(db, 'company', actor({ type: 'board', userId: 'bob', source: 'session' }), 'connection')('/repos/acme/private')).rejects.toThrow('Reconnect');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses only the active agent run’s managed identity and rejects a different connection', async () => {
    mocks.managed.mockResolvedValue({ status: 'available', connectionId: 'allowed', env: { GH_TOKEN: 'managed' } });
    const fetch = vi.fn().mockResolvedValue(Response.json({})); vi.stubGlobal('fetch', fetch);
    const run = actor({ type: 'agent', agentId: 'agent', companyId: 'company', runId: 'run' });
    await skillSourceGitHubReader(db, 'company', run, 'allowed')('/repos/acme/private');
    expect(new Headers(fetch.mock.calls[0][1].headers).get('authorization')).toBe('Bearer managed');
    await expect(skillSourceGitHubReader(db, 'company', run, 'other')('/repos/acme/private')).rejects.toThrow(/authorized connection/);
    await expect(skillSourceGitHubReader(db, 'other-company', run, 'allowed')('/repos/acme/private')).rejects.toThrow(/authenticated agent run/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reports retryable failures without returning provider bodies or credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('sensitive provider text', { status: 503 })));
    const read = skillSourceGitHubReader(db, 'company', actor({ type: 'board' }), null);
    await expect(read('/repos/acme/public')).rejects.toMatchObject({ status: 422, message: 'GitHub could not complete the read. Try again.' });
  });
});
