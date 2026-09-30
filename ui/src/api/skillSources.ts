import type { ProjectRepositoryOptions, SkillSource, SkillSourceCreateRequest, SkillSourceDiscovery, SkillSourceDiscoveryRequest, SkillSourceRefreshResult, SkillSourceSelectionRequest } from '@paperclipai/shared';
import { api } from './client';
const base = (companyId: string) => `/companies/${companyId}/skill-sources`;
export const skillSourcesApi = {
  list: (companyId: string) => api.get<SkillSource[]>(base(companyId)),
  repositories: (companyId: string) => api.get<ProjectRepositoryOptions>(`${base(companyId)}/repositories`),
  discover: (companyId: string, input: SkillSourceDiscoveryRequest) => api.post<SkillSourceDiscovery>(`${base(companyId)}/discover`, input),
  create: (companyId: string, input: SkillSourceCreateRequest) => api.post<SkillSourceRefreshResult>(base(companyId), input),
  select: (companyId: string, id: string, input: SkillSourceSelectionRequest) => api.patch<SkillSourceRefreshResult>(`${base(companyId)}/${id}`, input),
  refresh: (companyId: string, id: string) => api.post<SkillSourceRefreshResult>(`${base(companyId)}/${id}/refresh`, {}),
  disconnect: (companyId: string, id: string) => api.delete<SkillSource>(`${base(companyId)}/${id}`),
};
