/**
 * Small OpenAPI descriptions of the read-only endpoints Steward uses on GitHub, GitLab and Forgejo/Gitea (#107), attached
 * to platforms made from their presets so process steps can look the operations up. Not the hosts' full specifications
 * (GitHub's alone is over 10 MB); for more, add the official one to the platform.
 */

type Op = [path: string, operationId: string, summary: string, query?: string[]];

function spec(title: string, docs: string, ops: Op[]): object {
  const paths: Record<string, object> = {};
  for (const [path, operationId, summary, query = []] of ops) {
    const params = [
      ...[...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } })),
      ...query.map((name) => ({ name, in: 'query', required: false, schema: { type: 'string' } })),
    ];
    paths[path] = {
      get: {
        operationId,
        summary,
        parameters: params,
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    };
  }
  return {
    openapi: '3.0.3',
    info: { title, version: '1', description: `Read-only subset used by Steward. Full reference: ${docs}` },
    paths,
    components: { securitySchemes: { token: { type: 'http', scheme: 'bearer' } } },
    security: [{ token: [] }],
  };
}

const PAGE = ['per_page', 'page'];

export const githubSpec = () =>
  spec('GitHub REST API (Steward subset)', 'https://docs.github.com/en/rest', [
    ['/rate_limit', 'getRateLimit', 'Rate limit of the token (connection test)'],
    ['/repos/{owner}/{repo}', 'getRepository', 'A repository'],
    ['/repos/{owner}/{repo}/commits/{ref}', 'getCommit', 'A commit, e.g. the head of a branch'],
    ['/repos/{owner}/{repo}/actions/runs', 'listWorkflowRuns', 'Workflow runs', ['branch', 'status', 'exclude_pull_requests', ...PAGE]],
    ['/repos/{owner}/{repo}/releases/latest', 'getLatestRelease', 'The latest release'],
    ['/repos/{owner}/{repo}/dependabot/alerts', 'listDependabotAlerts', 'Dependabot alerts', ['state', 'severity', ...PAGE]],
    ['/repos/{owner}/{repo}/code-scanning/alerts', 'listCodeScanningAlerts', 'Code scanning alerts', ['state', ...PAGE]],
    ['/repos/{owner}/{repo}/keys', 'listDeployKeys', 'Deploy keys', PAGE],
    ['/repos/{owner}/{repo}/contents/{path}', 'getContent', 'A file of the repository', ['ref']],
    ['/repos/{owner}/{repo}/collaborators', 'listCollaborators', 'Collaborators', ['affiliation', ...PAGE]],
    ['/repos/{owner}/{repo}/branches/{branch}/protection', 'getBranchProtection', 'Branch protection of a branch'],
    ['/orgs/{org}/members', 'listOrgMembers', 'Organisation members', ['role', ...PAGE]],
    ['/orgs/{org}/outside_collaborators', 'listOutsideCollaborators', 'Outside collaborators', PAGE],
    ['/orgs/{org}/repos', 'listOrgRepos', 'Repositories of an organisation', ['type', ...PAGE]],
    ['/orgs/{org}/packages', 'listOrgPackages', 'Packages of an organisation', ['package_type', ...PAGE]],
  ]);

export const gitlabSpec = () =>
  spec('GitLab REST API v4 (Steward subset)', 'https://docs.gitlab.com/api/rest/', [
    ['/version', 'getVersion', 'GitLab version (connection test)'],
    ['/projects/{id}', 'getProject', 'A project (id or URL-encoded path)'],
    ['/projects/{id}/repository/branches/{branch}', 'getBranch', 'A branch and its head commit'],
    ['/projects/{id}/pipelines', 'listPipelines', 'Pipelines', ['ref', 'status', ...PAGE]],
    ['/projects/{id}/releases', 'listReleases', 'Releases', PAGE],
    ['/projects/{id}/registry/repositories', 'listRegistryRepositories', 'Container repositories', PAGE],
    ['/projects/{id}/packages', 'listPackages', 'Packages', PAGE],
    ['/projects/{id}/deploy_keys', 'listDeployKeys', 'Deploy keys', PAGE],
    ['/projects/{id}/deploy_tokens', 'listDeployTokens', 'Deploy tokens', ['active', ...PAGE]],
    ['/projects/{id}/access_tokens', 'listProjectAccessTokens', 'Project access tokens', ['state', ...PAGE]],
    ['/projects/{id}/repository/files/{file_path}/raw', 'getRawFile', 'A file of the repository', ['ref']],
    ['/projects/{id}/members/all', 'listProjectMembers', 'Members of a project, inherited ones too', PAGE],
    ['/projects/{id}/protected_branches', 'listProtectedBranches', 'Protected branches', PAGE],
    ['/groups/{id}/members/all', 'listGroupMembers', 'Members of a group, inherited ones too', PAGE],
    ['/groups/{id}/projects', 'listGroupProjects', 'Projects of a group', ['include_subgroups', ...PAGE]],
  ]);

export const forgejoSpec = () =>
  spec('Forgejo / Gitea API v1 (Steward subset)', 'https://forgejo.org/docs/latest/user/api-usage/', [
    ['/version', 'getVersion', 'Server version (connection test)'],
    ['/repos/{owner}/{repo}', 'repoGet', 'A repository'],
    ['/repos/{owner}/{repo}/branches/{branch}', 'repoGetBranch', 'A branch and its head commit'],
    ['/repos/{owner}/{repo}/commits/{ref}/status', 'repoGetCombinedStatusByRef', 'Combined commit status (Actions, Woodpecker …)'],
    ['/repos/{owner}/{repo}/releases/latest', 'repoGetLatestRelease', 'The latest release'],
    ['/repos/{owner}/{repo}/keys', 'repoListKeys', 'Deploy keys', ['page', 'limit']],
    ['/repos/{owner}/{repo}/raw/{filepath}', 'repoGetRawFile', 'A file of the repository', ['ref']],
    ['/repos/{owner}/{repo}/collaborators', 'repoListCollaborators', 'Collaborators', ['page', 'limit']],
    ['/repos/{owner}/{repo}/collaborators/{collaborator}/permission', 'repoGetRepoPermissions', 'Rights of a collaborator'],
    ['/repos/{owner}/{repo}/branch_protections', 'repoListBranchProtection', 'Branch protections'],
    ['/orgs/{org}/repos', 'orgListRepos', 'Repositories of an organisation', ['page', 'limit']],
    ['/orgs/{org}/teams', 'orgListTeams', 'Teams of an organisation', ['page', 'limit']],
    ['/teams/{id}/members', 'orgListTeamMembers', 'Members of a team', ['page', 'limit']],
    ['/packages/{owner}', 'listPackages', 'Packages of an owner', ['type', 'page', 'limit']],
  ]);
