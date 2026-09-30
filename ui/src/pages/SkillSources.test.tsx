// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillSources } from './SkillSources';
import { skillSourcesApi } from '@/api/skillSources';

const context = vi.hoisted(() => ({ navigate: vi.fn(), breadcrumbs: vi.fn(), sourceId: 'new' }));
vi.mock('@/context/CompanyContext', () => ({ useCompany: () => ({ selectedCompanyId: 'company-1', selectedCompany: { name: 'Acme' } }) }));
vi.mock('@/context/BreadcrumbContext', () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: context.breadcrumbs }) }));
vi.mock('@/lib/router', () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => context.navigate,
  useParams: () => ({ sourceId: context.sourceId }),
}));
vi.mock('@/api/skillSources', () => ({ skillSourcesApi: { list: vi.fn(), repositories: vi.fn(), discover: vi.fn(), create: vi.fn(), select: vi.fn(), refresh: vi.fn(), disconnect: vi.fn() } }));

const repos = {
  connections: [{ id: 'personal', name: 'Personal' }, { id: 'shared', name: 'Engineering' }],
  connectionCount: 2, failedConnectionCount: 0,
  repositories: [
    { id: '1', fullName: 'acme/team-skills', url: 'https://github.com/acme/team-skills', private: true, connections: ['Personal', 'Engineering'], connectionIds: ['personal', 'shared'] },
    { id: '2', fullName: 'acme/design', url: 'https://github.com/acme/design', private: true, connections: ['Engineering'], connectionIds: ['shared'] },
  ],
};
const discovery = { repositoryId: '1', repositoryUrl: 'https://github.com/acme/team-skills', fullName: 'acme/team-skills', trackingRef: 'feature/new-skills', commitSha: 'a'.repeat(40), candidates: [], warnings: [] };
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function mount() {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><SkillSources /></QueryClientProvider>));
  await flush(); await flush();
}
function button(text: string) { return [...document.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent === text)!; }
async function input(selector: string, value: string) {
  await act(async () => {
    const element = document.querySelector<HTMLInputElement>(selector)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  vi.mocked(skillSourcesApi.list).mockResolvedValue([]);
  vi.mocked(skillSourcesApi.repositories).mockResolvedValue(structuredClone(repos));
  vi.mocked(skillSourcesApi.discover).mockResolvedValue(discovery);
  context.sourceId = 'new';
  sessionStorage.clear();
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove(); client?.clear(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals();
});

describe('GitHub skill source import', () => {
  it('searches the combined repository inventory and uses the selected repository’s authorized connection', async () => {
    await mount();
    expect(document.querySelectorAll('[cmdk-item]')).toHaveLength(2);
    expect(document.body.textContent).toContain('Personal · Engineering');
    expect([...document.querySelectorAll('a')].find(el => el.textContent === 'Add repos')?.getAttribute('href')).toBe('/apps/connect?source=github');
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Refresh repositories"]')!.click());
    await flush();
    expect(skillSourcesApi.repositories).toHaveBeenCalledTimes(2);
    expect(document.querySelector('select')).toBeNull();
    expect(document.body.textContent).not.toContain('Choose a branch');
    expect(document.querySelector('input[placeholder="https://github.com/owner/repository"]')).toBeNull();
    await input('[aria-label="Search repositories"]', 'design');
    expect(document.querySelectorAll('[cmdk-item]')).toHaveLength(1);
    await act(async () => (document.querySelector('[cmdk-item]') as HTMLElement).click());
    await act(async () => button('Find skills').click());
    expect(skillSourcesApi.discover).toHaveBeenCalledWith('company-1', { repositoryUrl: 'https://github.com/acme/design', connectionId: 'shared' });
  });
  it('recognizes pasted branch URLs and does not reuse their branch or credentials for another repository', async () => {
    await mount();
    await act(async () => button('... or add public repo by URL').click());
    await input('input[placeholder="https://github.com/owner/repository"]', 'https://github.com/ACME/team-skills/tree/feature/new-skills');
    await act(async () => button('Find skills').click());
    expect(skillSourcesApi.discover).toHaveBeenLastCalledWith('company-1', { repositoryUrl: 'https://github.com/ACME/team-skills/tree/feature/new-skills', connectionId: 'personal' });
    await flush();
    expect(document.body.textContent).toContain('feature/new-skills');
    await act(async () => button('Back').click());
    await input('input[placeholder="https://github.com/owner/repository"]', 'https://github.com/public/skills');
    await act(async () => button('Find skills').click());
    expect(skillSourcesApi.discover).toHaveBeenLastCalledWith('company-1', { repositoryUrl: 'https://github.com/public/skills', connectionId: null });
  });
  it('links empty repositories to standard GitHub setup in Apps while preserving the import draft', async () => {
    vi.mocked(skillSourcesApi.repositories).mockResolvedValue({ repositories: [], connections: [], connectionCount: 0, failedConnectionCount: 0 });
    await mount();
    const link = [...document.querySelectorAll('a')].find(el => el.textContent === 'Connect GitHub to see your repos');
    expect(link?.getAttribute('href')).toBe('/apps/connect?source=github');
    expect(document.querySelector('input[placeholder="https://github.com/owner/repository"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Imported skills will be available');
    await act(async () => button('... or add public repo by URL').click());
    expect(document.body.textContent).not.toContain('Uses the default branch');
    await input('input[placeholder="https://github.com/owner/repository"]', 'https://github.com/acme/team-skills/tree/release');
    await act(async () => root.unmount());
    expect(JSON.parse(sessionStorage.getItem('paperclip.skill-source-draft:company-1:new')!).repositoryUrl).toBe('https://github.com/acme/team-skills/tree/release');
    // Returning from Apps remounts the importer and rechecks the new inventory.
    host.remove();
    await mount();
    expect(document.querySelector<HTMLInputElement>('input[placeholder="https://github.com/owner/repository"]')?.value).toBe('https://github.com/acme/team-skills/tree/release');
    expect(skillSourcesApi.repositories).toHaveBeenCalledTimes(2);
  });
  it('keeps usable repositories visible during partial failure and provides recovery in Apps', async () => {
    vi.mocked(skillSourcesApi.repositories).mockResolvedValue({ ...repos, failedConnectionCount: 1 });
    await mount();
    expect(document.querySelectorAll('[cmdk-item]')).toHaveLength(2);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Some GitHub connections could not load repositories.');
    expect([...document.querySelectorAll('a')].find(el => el.textContent === 'Manage connections')?.getAttribute('href')).toBe('/apps');
    expect(button('Try again')).toBeTruthy();
  });
});
