import type { CompanySkill } from './company-skill.js';

export interface SkillSourceEntry {
  id: string;
  sourceId: string;
  path: string;
  name: string;
  description: string | null;
  skillId: string | null;
  selection: 'selected' | 'excluded' | 'new';
  present: boolean;
  error: string | null;
}
export interface SkillSource {
  id: string;
  companyId: string;
  repositoryId: string | null;
  repositoryUrl: string;
  fullName: string;
  trackingRef: string;
  connectionId: string | null;
  excludedFolders: string[];
  enabled: boolean;
  revision: number;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastScanCommit: string | null;
  lastError: string | null;
  entries: SkillSourceEntry[];
}
export interface SkillSourceDiscoveryRequest {
  repositoryUrl: string;
  trackingRef?: string;
  connectionId?: string | null;
}
export interface SkillSourceCandidate {
  path: string;
  name: string;
  description: string | null;
  fileCount: number;
  error: string | null;
  warnings: string[];
}
export interface SkillSourceDiscovery {
  repositoryId: string;
  repositoryUrl: string;
  fullName: string;
  trackingRef: string;
  commitSha: string;
  candidates: SkillSourceCandidate[];
  warnings: string[];
}
export interface SkillSourceCreateRequest extends SkillSourceDiscoveryRequest {
  commitSha: string;
  selectedPaths: string[];
  excludedFolders?: string[];
}
export interface SkillSourceSelectionRequest {
  revision: number;
  selectedPaths: string[];
  excludedFolders: string[];
  connectionId?: string | null;
}
export interface SkillSourceRefreshResult {
  source: SkillSource;
  imported: CompanySkill[];
  updated: CompanySkill[];
  unchanged: number;
  warnings: string[];
}
