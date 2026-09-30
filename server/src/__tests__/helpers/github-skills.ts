import type { GitHubRead } from "../../services/github-skill-source.js";
export function githubFixture(files: Record<string, string | Buffer>, modes: Record<string, string> = {}, commit = "a".repeat(40)): GitHubRead {
  return async url => {
    if (url === '/repos/acme/skills') return { id: 42, full_name: 'acme/skills', default_branch: 'main' };
    if (url.startsWith('/repos/acme/skills/commits/')) return { sha: commit };
    if (url.includes('/git/trees/')) return { tree: Object.keys(files).map((path, i) => ({ path, type: 'blob', mode: modes[path] ?? '100644', sha: String(i), size: Buffer.byteLength(files[path]!) })), truncated: false };
    const key = Object.keys(files)[Number(url.split('/').at(-1))];
    if (!key) throw new Error(`Unexpected request ${url}`);
    return { encoding: 'base64', content: Buffer.from(files[key]!).toString('base64') };
  };
}
