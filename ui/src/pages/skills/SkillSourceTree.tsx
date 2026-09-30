import { useMemo, useState } from 'react';
import type { SkillSourceCandidate } from '@paperclipai/shared';
import { FileTree, buildFileTree, collectAllPaths, type FileTreeNode } from '@/components/FileTree';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Search } from 'lucide-react';

export type SkillTreeCandidate = Pick<SkillSourceCandidate, 'path' | 'name' | 'description' | 'error'> & { note?: string; warnings?: string[] };
export function updateSkillTreeSelection(candidates: SkillTreeCandidate[], selected: Set<string>, folder: string, checked: boolean) {
  const result = new Set(selected);
  for (const skill of candidates.filter(skill => !folder || skill.path.startsWith(`${folder}/`))) {
    if (checked) result.add(skill.path); else result.delete(skill.path);
  }
  return result;
}
/** Join empty folder chains while retaining exact paths for selection and exclusions. */
function compactSkillFolders(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.map(node => {
    let compact = { ...node };
    while (compact.kind === 'dir' && compact.children.length === 1 && compact.children[0]!.kind === 'dir') {
      const child = compact.children[0]!;
      compact = { ...child, name: `${compact.name}/${child.name}` };
    }
    return { ...compact, children: compactSkillFolders(compact.children) };
  });
}

export function SkillSourceTree({ candidates, selected, excludedFolders, onChange, disabled = false }: {
  candidates: SkillTreeCandidate[]; selected: Set<string>; excludedFolders: string[];
  onChange: (selected: Set<string>, excludedFolders: string[]) => void; disabled?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const nodes = useMemo(() => compactSkillFolders(buildFileTree(Object.fromEntries(candidates.map(skill => [skill.path, null])))), [candidates]);
  const skillsByPath = new Map(candidates.map(skill => [skill.path, skill]));
  const allDirs = collectAllPaths(nodes, 'dir');
  const expanded = new Set([...allDirs].filter(path => search || !collapsed.has(path)));
  const visiblePaths = search ? new Set<string>() : undefined;
  for (const skill of candidates) {
    if (!visiblePaths || !`${skill.path} ${skill.name} ${skill.description ?? ''}`.toLowerCase().includes(search.toLowerCase())) continue;
    visiblePaths.add('');
    const segments = skill.path.split('/');
    segments.forEach((_, index) => visiblePaths.add(segments.slice(0, index + 1).join('/')));
  }
  function toggleCheck(path: string, kind: 'file' | 'dir') {
    if (disabled) return;
    if (kind === 'file') {
      const next = new Set(selected);
      if (next.has(path)) next.delete(path); else next.add(path);
      onChange(next, excludedFolders);
      return;
    }
    const descendants = candidates.filter(skill => !path || skill.path.startsWith(`${path}/`));
    const checked = !descendants.every(skill => selected.has(skill.path));
    const next = updateSkillTreeSelection(candidates, selected, path, checked);
    const folders = excludedFolders.filter(folder => Boolean(path) && folder !== path && !folder.startsWith(`${path}/`));
    if (!checked) folders.push(path);
    onChange(next, folders);
  }
  const selectedCount = candidates.filter(skill => selected.has(skill.path)).length;
  const allCollapsed = allDirs.size > 0 && [...allDirs].every(path => collapsed.has(path));
  return <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border">
    <div className="flex items-center gap-2 px-3">
      <Search className="size-4 shrink-0 text-muted-foreground" />
      <Input className="border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search skills…" aria-label="Search discovered skills" />
    </div>
    <div className="flex items-center justify-between gap-2 border-y border-border bg-muted/30 px-3 py-1.5">
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" className="size-3.5 accent-foreground" aria-label="Import folder Repository"
          checked={candidates.length > 0 && selectedCount === candidates.length}
          ref={element => { if (element) element.indeterminate = selectedCount > 0 && selectedCount < candidates.length; }}
          disabled={disabled || candidates.length === 0} onChange={() => toggleCheck('', 'dir')} />
        <span>{selectedCount} of {candidates.length} selected</span>
      </label>
      <Button type="button" variant="ghost" size="xs" className="font-normal text-muted-foreground" disabled={disabled || Boolean(search) || allDirs.size === 0} onClick={() => setCollapsed(allCollapsed ? new Set() : allDirs)}>{allCollapsed ? 'Expand all' : 'Collapse all'}</Button>
    </div>
    <div className="min-h-0 max-h-(--sz-480px) overflow-auto py-1">
      <FileTree
        layout="explorer" wrapLabels={false}
        nodes={nodes} selectedFile={null} expandedDirs={expanded} checkedFiles={selected}
        visiblePaths={visiblePaths} disabled={disabled} ariaLabel="Discovered skills"
        empty={{ title: 'No matching skills found.', description: 'Try another skill name or path.' }}
        onToggleDir={path => setCollapsed(previous => {
          const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next;
        })}
        onSelectFile={path => toggleCheck(path, 'file')} onToggleCheck={toggleCheck}
        checkboxLabel={node => node.kind === 'dir' ? `Import folder ${node.path}` : `Import ${node.path}`}
        renderLabel={node => {
          if (node.kind === 'dir') return <span className="block truncate font-mono text-xs" title={node.path}>{node.name}</span>;
          const skill = skillsByPath.get(node.path)!;
          const summary = skill.error ?? [skill.description, ...(skill.warnings ?? [])].filter(Boolean).join(' · ');
          return <span className="flex min-w-0 items-baseline gap-2" title={[skill.path, skill.description, skill.error, ...(skill.warnings ?? [])].filter(Boolean).join('\n')}>
            <span className="max-w-full shrink-0 truncate font-medium text-foreground">{skill.name}</span>
            {summary && <span className={`min-w-0 flex-1 truncate text-xs ${skill.error ? 'text-destructive' : 'text-muted-foreground'}`}>{summary}</span>}
          </span>;
        }}
        renderFileExtra={node => {
          const skill = skillsByPath.get(node.path)!;
          const label = skill.error ? 'Invalid' : skill.note === 'New skill' ? 'New' : skill.note === 'Already imported' ? 'Installed' : skill.note?.startsWith('Removed from source') ? 'Removed' : skill.note;
          return label ? <Badge variant={skill.error || label === 'New' ? 'outline' : 'ghost'} className={skill.error ? 'hidden border-destructive/30 font-normal text-destructive sm:inline-flex' : label === 'Installed' ? 'hidden font-normal text-muted-foreground sm:inline-flex' : 'font-normal text-muted-foreground'} title={skill.error ?? skill.note}>{label}</Badge> : null;
        }}
      />
    </div>
  </div>;
}
