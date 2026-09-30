import type { Request } from 'express';
import type { Db } from '@paperclipai/db';
import { forbidden, unprocessable } from '../errors.js';
import { toolAccessService } from './tool-access.js';
import { resolveGitHubOperationCredentials } from './github-operation-credentials.js';
import type { GitHubRead } from './github-skill-source.js';

/** Only fixed GitHub API paths are accepted. Credentials never follow redirects. */
export function skillSourceGitHubReader(db: Db, companyId: string, actor: Request['actor'], connectionId: string | null): GitHubRead {
  const headers = (force = false, grantId?: string | null): Promise<Record<string, string>> => {
    // Re-check the caller and grant for every provider request, including long scans.
    return (async () => {
      if (actor.type === 'agent') {
        if (!actor.runId || !actor.agentId || actor.companyId !== companyId) {
          if (connectionId) throw forbidden('Private GitHub skills require an authenticated agent run.');
          return {};
        }
        const result = await resolveGitHubOperationCredentials(db, { companyId, agentId: actor.agentId, runId: actor.runId });
        if (result.status === 'available') {
          if (connectionId && result.connectionId !== connectionId) throw forbidden('This run cannot use the source’s saved GitHub connection. Choose the run’s authorized connection.');
          return { Authorization: `Bearer ${result.env.GH_TOKEN}` };
        }
        if (connectionId || result.status === 'unavailable') throw forbidden(result.reason ?? 'GitHub authorization is unavailable.');
        return {};
      }
      if (actor.type !== 'board') throw forbidden('Authentication required.');
      if (!connectionId) return {};
      return toolAccessService(db).githubReadHeaders(companyId, connectionId, actor.userId ?? null, actor.source === 'local_implicit', force, grantId);
    })();
  };
  return async (apiPath: string) => {
    if (!apiPath.startsWith('/repos/') || apiPath.includes('://') || apiPath.startsWith('//')) throw unprocessable('Invalid GitHub repository request.');
    const request = async (grantId: string | null | undefined, force = false) => fetch(`https://api.github.com${apiPath}`, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...await headers(force, grantId) },
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    let response: Response | undefined;
    let authorizationError: unknown;
    try {
      const grantIds = connectionId && actor.type === 'board'
        ? await toolAccessService(db).githubReadGrantIds(companyId, connectionId, actor.userId ?? null, actor.source === 'local_implicit')
        : [undefined];
      for (const grantId of grantIds) {
        try {
          response = await request(grantId);
          if (response.status === 401 && connectionId && actor.type === 'board') response = await request(grantId, true);
          if (![401, 403, 404].includes(response.status)) break;
        } catch (error) {
          authorizationError = error instanceof Error && 'status' in error ? error
            : unprocessable('Could not read GitHub. Check your connection and try again.');
        }
      }
    } catch (error) {
      if (error instanceof Error && 'status' in error) throw error;
      throw unprocessable('Could not read GitHub. Check your connection and try again.');
    }
    if (!response) {
      if (authorizationError) throw authorizationError;
      throw forbidden('Reconnect an active GitHub authorization to read this repository.');
    }
    if (!response.ok) {
      const message = response.status === 404 ? 'Repository, branch, or file is unavailable. Check the URL and GitHub repository access.'
        : [401, 403].includes(response.status) ? 'GitHub denied this read or reached its request limit. Check connection access and try again.'
        : response.status === 429 ? 'GitHub request limit reached. Try again later.' : 'GitHub could not complete the read. Try again.';
      throw unprocessable(message, { code: 'skill_source_github_read_failed', status: response.status });
    }
    return response.json();
  };
}
