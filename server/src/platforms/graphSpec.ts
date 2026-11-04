import { spec } from './gitSpecs.js';

/**
 * The read endpoints of Microsoft Graph that Steward uses for Entra ID (v0.5.0, docs/ENTRA.md), attached to platforms
 * made from the Microsoft Graph preset: process steps look the operations up, and MCP clients can read them through
 * the platform gateway. GET only – Steward's Graph permissions are read-only anyway. Lists page with @odata.nextLink
 * (in a process step: paginate mode nextLink, nextPath `@odata.nextLink`, itemsPath value).
 */
const LIST = ['$select', '$filter', '$top', '$expand', '$orderby', '$count', '$search'];

export const graphSpec = () =>
  spec('Microsoft Graph (Entra ID read endpoints)', 'https://learn.microsoft.com/graph/api/overview', [
    ['/v1.0/organization', 'listOrganization', 'The tenant: name, verified domains (connection test)', ['$select']],
    ['/v1.0/users', 'listUsers', 'Users and guests (signInActivity needs AuditLog.Read.All and Entra ID P1)', LIST],
    ['/v1.0/users/{id}', 'getUser', 'One user', ['$select', '$expand']],
    ['/v1.0/users/{id}/transitiveMemberOf', 'listUserTransitiveMemberOf', 'Groups and roles of a user, also through nested groups', LIST],
    ['/v1.0/users/{id}/appRoleAssignments', 'listUserAppRoleAssignments', 'App roles assigned to a user', LIST],
    ['/v1.0/groups', 'listGroups', 'Groups', LIST],
    ['/v1.0/groups/{id}', 'getGroup', 'One group', ['$select', '$expand']],
    ['/v1.0/groups/{id}/members', 'listGroupMembers', 'Direct members of a group', LIST],
    ['/v1.0/groups/{id}/transitiveMembers', 'listGroupTransitiveMembers', 'Members of a group, also through nested groups', LIST],
    ['/v1.0/groups/{id}/owners', 'listGroupOwners', 'Owners of a group', LIST],
    ['/v1.0/roleManagement/directory/roleDefinitions', 'listRoleDefinitions', 'Directory roles (built-in and custom)', LIST],
    ['/v1.0/roleManagement/directory/roleAssignments', 'listRoleAssignments', 'Active directory role assignments ($expand=principal,roleDefinition)', LIST],
    [
      '/v1.0/roleManagement/directory/roleEligibilityScheduleInstances',
      'listRoleEligibilityScheduleInstances',
      'Eligible role assignments (PIM, Entra ID P2)',
      LIST,
    ],
    ['/v1.0/servicePrincipals', 'listServicePrincipals', 'Service principals (enterprise applications)', LIST],
    ['/v1.0/servicePrincipals/{id}/appRoleAssignedTo', 'listAppRoleAssignedTo', 'Who is assigned to an enterprise application', LIST],
    ['/v1.0/applications', 'listApplications', 'App registrations with their secrets and certificates (end dates, never the values)', LIST],
    ['/v1.0/reports/authenticationMethods/userRegistrationDetails', 'listUserRegistrationDetails', 'MFA registration per user (Entra ID P1/P2)', LIST],
    ['/v1.0/admin/serviceAnnouncement/healthOverviews', 'listServiceHealth', 'Microsoft 365 service health (ServiceHealth.Read.All)', ['$select', '$filter']],
    ['/v1.0/admin/serviceAnnouncement/issues', 'listServiceIssues', 'Microsoft 365 service issues (ServiceHealth.Read.All)', ['$select', '$filter', '$top']],
  ]);
