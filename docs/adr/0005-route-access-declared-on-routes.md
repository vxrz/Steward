# 0005. Route access declared on the route

- **Status:** Accepted
- **Date:** 2026-11-02
- **Since:** 0.3.0 (#16)

## Context

Who may call a route used to be checked inside each handler (`requireRole(...)`, a sign-in check, a token check). A handler that forgot it was open; a check that ran after the body was parsed let anonymous callers make the server read large bodies. Reviews had to read every handler to know which routes were public.

## Decision

Every route declares **who may reach it** in its config – `{ config: { access: ACCESS.admin } }`, `ACCESS.public`, `ACCESS.session` (signed-in web session, no API tokens), `ACCESS.hook` (authenticated by the route's own secret), roles and whether a status viewer may (`server/src/auth/access.ts`). `app.ts` checks it once, for every route, before the body is read; a route that declares nothing needs a signed-in user. **Object rights** – what the caller may do with a given process, platform or record – stay in the services, because they depend on the object (`auth/permissions.ts`, `auth/policy.ts`). `server/test/route-matrix.test.ts` lists every route with its declared access and fails for a route that is not classified, so a new route cannot slip in unreviewed.

## Consequences

- The default is closed; public routes are visible in one place and in the test matrix.
- Anonymous callers are refused before their body is read, with small body limits for requests without credentials.
- Two layers must both be right: the route layer cannot express "may edit this process", so services still call the object checks – the test matrix covers the first layer, feature tests the second.
- Plugins with their own authentication (the public API `/api/v1`, the MCP endpoint) are resolved as `api` and do their own checks.
