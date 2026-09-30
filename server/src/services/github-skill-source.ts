import path from 'node:path';
import type { CompanySkillVersionFileInventoryEntry, SkillSourceCandidate, SkillSourceDiscovery } from '@paperclipai/shared';
import { parseFrontmatterMarkdown, parseGitHubSkillRepositoryUrl } from '@paperclipai/shared';
import { unprocessable } from '../errors.js';
import { assertSkillSnapshotPath, snapshotFile } from './skill-snapshot.js';
import { auditSkillSnapshot, classifyInventoryKind } from './company-skills.js';

export type GitHubRead = (apiPath: string) => Promise<unknown>;
type TreeEntry = { path: string; type: string; mode: string; sha: string; size?: number };
export type DiscoveredSkill = SkillSourceCandidate & { files: CompanySkillVersionFileInventoryEntry[] };
export type ScannedSkillSource = SkillSourceDiscovery & { skills: DiscoveredSkill[]; defaultBranch: string };
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SCAN_BYTES = 100 * 1024 * 1024;

export function parseSkillRepository(url: string) {
  const parsed = parseGitHubSkillRepositoryUrl(url);
  if (!parsed) throw unprocessable('Enter an HTTPS GitHub repository or branch URL without credentials.');
  return parsed;
}

export async function scanGitHubSkills(input: { repositoryUrl: string; trackingRef?: string; commitSha?: string }, read: GitHubRead): Promise<ScannedSkillSource> {
  const parsed = parseSkillRepository(input.repositoryUrl);
  const repo = await read(`/repos/${parsed.fullName}`) as { id: number; full_name: string; default_branch: string };
  if (!repo.id || !repo.full_name || !repo.default_branch) throw unprocessable('GitHub returned incomplete repository information.');
  const base = `/repos/${repo.full_name}`;
  const requestedRef = input.trackingRef || parsed.trackingRef;
  const trackingRef = !requestedRef || requestedRef === 'HEAD' ? repo.default_branch : requestedRef;
  const commit = await read(`${base}/commits/${encodeURIComponent(input.commitSha || trackingRef)}`) as { sha: string };
  if (!/^[a-f0-9]{40}$/i.test(commit.sha ?? '')) throw unprocessable('GitHub did not return an immutable commit.');
  const tree = await read(`${base}/git/trees/${commit.sha}?recursive=1`) as { tree: TreeEntry[]; truncated?: boolean };
  let entries = tree.tree;
  if (tree.truncated) {
    entries = [];
    const queue = [{ sha: commit.sha, prefix: '' }];
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i]!;
      const subtree = await read(`${base}/git/trees/${current.sha}`) as { tree: TreeEntry[]; truncated?: boolean };
      if (subtree.truncated || !Array.isArray(subtree.tree)) throw unprocessable('GitHub returned an incomplete repository tree. Try again.');
      for (const entry of subtree.tree) {
        const fullPath = current.prefix + entry.path;
        assertSkillSnapshotPath(fullPath);
        if (entry.type === 'tree') queue.push({ sha: entry.sha, prefix: `${fullPath}/` });
        else entries.push({ ...entry, path: fullPath });
      }
      if (queue.length > 100000) throw unprocessable('Repository scan exceeded its directory limit.');
    }
  }
  if (!Array.isArray(entries)) throw unprocessable('GitHub returned an incomplete repository tree.');
  for (const entry of entries) assertSkillSnapshotPath(entry.path);
  const roots = entries.filter(e => e.type === 'blob' && /(^|\/)skill\.md$/i.test(e.path) && ['100644', '100755'].includes(e.mode));
  const directories = new Set(roots.map(e => path.posix.dirname(e.path)));
  const warnings = entries.filter(e => e.mode === '120000' || e.type === 'commit').map(e => `Not followed: ${e.path} (${e.mode === '120000' ? 'symlink' : 'submodule'}).`);
  const blobs = new Map<string, Buffer>();
  let totalBytes = 0;
  const readBlob = async (entry: TreeEntry) => {
    if ((entry.size ?? 0) > MAX_FILE_BYTES) return null;
    let bytes = blobs.get(entry.sha);
    if (!bytes) {
      const blob = await read(`${base}/git/blobs/${entry.sha}`) as { encoding: string; content: string };
      if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw unprocessable('GitHub returned an unreadable file.');
      bytes = Buffer.from(blob.content, 'base64');
      totalBytes += bytes.length;
      if (totalBytes > MAX_SCAN_BYTES) throw unprocessable('Skill packages exceed the 100 MB scan limit.');
      if (bytes.length > MAX_FILE_BYTES) return null;
      blobs.set(entry.sha, bytes);
    }
    return bytes;
  };
  const skills: DiscoveredSkill[] = [];
  for (const root of roots.sort((a, b) => a.path.localeCompare(b.path))) {
    const dir = path.posix.dirname(root.path);
    const prefix = dir === '.' ? '' : `${dir}/`;
    const owns = (entry: TreeEntry) => {
      if (!entry.path.startsWith(prefix)) return false;
      let parent = path.posix.dirname(entry.path);
      while (parent !== dir && parent !== '.') {
        if (directories.has(parent)) return false;
        parent = path.posix.dirname(parent);
      }
      return parent === dir;
    };
    const inventory = entries.filter(e => e.type !== 'tree' && owns(e));
    const files: CompanySkillVersionFileInventoryEntry[] = [];
    let error: string | null = roots.filter(entry => path.posix.dirname(entry.path) === dir).length > 1 ? 'Multiple SKILL.md entrypoints share this package directory.' : null;
    for (const entry of inventory) {
      if (!['100644', '100755'].includes(entry.mode) || entry.type !== 'blob') { error = `Unsupported symlink or submodule: ${entry.path}`; continue; }
      const bytes = await readBlob(entry);
      if (!bytes) { error = `File exceeds the 1 MB limit: ${entry.path}`; continue; }
      const relative = entry.path === root.path ? 'SKILL.md' : entry.path.slice(prefix.length);
      const kind = relative !== 'SKILL.md' && (entry.mode === '100755' || bytes.subarray(0, 2).toString() === '#!') ? 'script' : classifyInventoryKind(relative);
      files.push(snapshotFile(relative, kind, bytes, entry.mode === '100755'));
    }
    const markdown = files.find(f => f.path === 'SKILL.md');
    const frontmatter = markdown && markdown.encoding !== 'base64' ? parseFrontmatterMarkdown(markdown.content).frontmatter : {};
    if (markdown?.encoding === 'base64') error = 'SKILL.md must contain UTF-8 text.';
    const name = typeof frontmatter.name === 'string' && frontmatter.name.trim() ? frontmatter.name.trim() : path.posix.basename(dir) || repo.full_name;
    const description = typeof frontmatter.description === 'string' ? frontmatter.description : null;
    const findings = !error ? await auditSkillSnapshot(files) : [];
    error ??= findings.filter(f => f.severity === 'error').map(f => `${f.path ?? root.path}: ${f.message}`).join(' ') || null;
    skills.push({ path: root.path, name, description, fileCount: inventory.length, error, warnings: findings.filter(f => f.severity === 'warning').map(f => f.message), files });
  }
  return { repositoryId: String(repo.id), repositoryUrl: `https://github.com/${repo.full_name.toLowerCase()}`, fullName: repo.full_name, trackingRef, commitSha: commit.sha,
    defaultBranch: repo.default_branch, candidates: skills.map(({ files: _files, ...candidate }) => candidate), warnings, skills };
}
