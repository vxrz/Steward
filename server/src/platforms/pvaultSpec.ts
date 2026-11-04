import { spec } from './gitSpecs.js';

/**
 * The read endpoints of IBM Security Verify Privilege Vault 12.0 (Delinea Secret Server REST API v1) that Steward
 * uses, attached to platforms made from the preset (#205): process steps look them up, MCP clients read through the
 * gateway. Metadata only – secret values are not part of it: GET /secrets/{id} (its answer holds the field values),
 * /secrets/{id}/fields/{slug}, file downloads and /secrets/{id}/restricted/… are left out, and refused for this kind
 * whatever asks (platforms/deniedPaths.ts). Sources of every endpoint: docs/IBM-PAM.md.
 */

const PAGE = ['skip', 'take', 'sortBy[0].name', 'sortBy[0].direction'];

export const pvaultSpec = () =>
  spec(
    'IBM Verify Privilege Vault REST API (metadata, Steward subset)',
    'docs/IBM-PAM.md and the REST API guide of your installation (Help → REST API Guide)',
    [
      ['/api/v1/healthcheck', 'healthCheck', 'Whether the application is healthy (no sign-in needed)'],
      ['/api/v1/version', 'getVersion', 'The version of the installation'],
      ['/api/v1/users/current', 'getCurrentUser', 'The signed-in service account (connection test)'],
      [
        '/api/v1/secrets',
        'searchSecrets',
        'Search secrets: summaries with template, folder, heartbeat, last password change, expiry, checkout and approval settings – no field values',
        [
          'filter.searchText',
          'filter.folderId',
          'filter.includeSubFolders',
          'filter.secretTemplateId',
          'filter.heartbeatStatus',
          'filter.includeRestricted',
          'filter.includeInactive',
          'filter.onlyRPCEnabled',
          ...PAGE,
        ],
      ],
      ['/api/v1/secrets/lookup', 'lookupSecrets', 'Secret ids and names', ['filter.searchText', 'filter.folderId', ...PAGE]],
      ['/api/v1/secrets/{id}/summary', 'getSecretSummary', 'One secret as a summary (no field values)'],
      [
        '/api/v1/secrets/{id}/audits',
        'getSecretAudits',
        "A secret's audit: views, checkouts, check-ins, edits, launches",
        ['filter.includePasswordChangeLog', ...PAGE],
      ],
      ['/api/v1/folders', 'searchFolders', 'Folders with their paths', ['filter.parentFolderId', 'filter.searchText', 'filter.folderTypeId', ...PAGE]],
      ['/api/v1/folders/{id}', 'getFolder', 'One folder'],
      [
        '/api/v1/secret-permissions',
        'searchSecretPermissions',
        'Who has which access to a secret (List, View, Edit, Owner)',
        ['filter.secretId', 'filter.userId', 'filter.groupId', ...PAGE],
      ],
      [
        '/api/v1/folder-permissions',
        'searchFolderPermissions',
        'Who has which access to a folder and its secrets',
        ['filter.folderId', 'filter.userId', 'filter.groupId', ...PAGE],
      ],
      [
        '/api/v1/users',
        'searchUsers',
        'Users with domain, e-mail address, last login, application accounts',
        ['filter.searchText', 'filter.includeInactive', 'filter.domainId', ...PAGE],
      ],
      ['/api/v1/users/{id}', 'getUser', 'One user'],
      ['/api/v1/users/{id}/groups', 'getUserGroups', 'The groups of a user', PAGE],
      ['/api/v1/users/{id}/roles-assigned', 'getUserRolesAssigned', 'The roles of a user, directly or through groups', PAGE],
      ['/api/v1/groups', 'searchGroups', 'Groups', ['filter.searchText', 'filter.includeInactive', 'filter.domainId', ...PAGE]],
      ['/api/v1/groups/{id}/users', 'getGroupUsers', 'The members of a group', ['filter.includeInactiveUsersForGroup', ...PAGE]],
      ['/api/v1/groups/{id}/roles', 'getGroupRoles', 'The roles of a group', PAGE],
      ['/api/v1/roles', 'searchRoles', 'Roles', ['filter.includeInactive', ...PAGE]],
      [
        '/api/v1/secret-templates',
        'searchSecretTemplates',
        'Secret templates (whether a heartbeat and password changing are set up)',
        ['filter.searchText', ...PAGE],
      ],
      [
        '/api/v1/secret-access-requests',
        'searchSecretAccessRequests',
        'Access requests of secrets that need approval',
        ['filter.status', 'filter.isMyRequest', ...PAGE],
      ],
    ],
  );
