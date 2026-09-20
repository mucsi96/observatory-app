export interface Workload {
  name: string;
  images: string[];
  ready: number;
  desired: number;
  status: string;
}
export interface PullRequest {
  number: number;
  title: string;
  url: string;
  pipeline: string;
  draft: boolean;
}
export interface Deployment {
  status: string;
  url: string;
  updatedAt: string;
}
export interface RepositoryData {
  openMRs: number;
  issues: number;
  mrs: PullRequest[];
  deployment: Deployment | null;
}
export interface Application {
  name: string;
  namespace: string;
  repository: string;
  url: string;
  health: string;
  workloads: Workload[];
  repositoryData: RepositoryData | null;
  errors: string[];
}
export interface Snapshot {
  environment: string;
  updatedAt: string;
  apps: Application[];
}
