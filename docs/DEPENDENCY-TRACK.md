# Dependency-Track

Steward reads the vulnerabilities of an application's components from **OWASP Dependency-Track**: the open findings by severity, the policy violations and the most severe findings with their fixed version and EPSS score. It shows them on the application, in the **scorecard** (part _Vulnerabilities_), in a **monitor check** and – through an example process – on a **dashboard**. Everything is read-only.

Libraries and their vulnerabilities stay in Dependency-Track: Steward does not analyse SBOMs itself, it reads what Dependency-Track found and how your team analysed it.

## Connect Dependency-Track

1. In Dependency-Track: _Administration → Access Management → Teams_, a team for Steward with the permissions **VIEW_PORTFOLIO**, **VIEW_VULNERABILITY** and **VIEW_POLICY_VIOLATION**, and an API key for it.
2. In Steward, under _Platforms_, a platform of type _Dependency-Track (vulnerabilities, read-only)_:
   - **Base URL**: the API server, e.g. `https://dtrack-api.example.com` (not the frontend).
   - **Credential** `apiKey`: the team's API key (sent as `X-Api-Key`).
   - **Variable** `frontendUrl` (optional): the frontend, e.g. `https://dtrack.example.com` – components then link to the project in Dependency-Track.

_Test connection_ lists one project with the key.

## Components of an application

Any application component – a repository, a container image, anything – can name its **Dependency-Track project** (edit the component): the platform and the project as

- `name@version` – one version, e.g. `shop-web@2.4.1`;
- `name@latest` – always the version Dependency-Track marks as latest (Dependency-Track 4.10 or later);
- the project's UUID.

Every 6 hours, or on _Read vulnerabilities now_ (shield icon), Steward reads:

| What               | Counted                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open findings      | per severity (critical, high, medium, low, unassigned) – not suppressed, not analysed as **not affected** or **false positive**                                   |
| Policy violations  | failing, warnings, info                                                                                                                                           |
| The worst findings | up to 10: critical and high first, then by EPSS and CVSS – with the package, its version, a fixed version when Dependency-Track knows one, and the analysis state |

Findings are counted from the findings themselves, so an analysis takes effect at once (Dependency-Track's own metrics follow only after its next metrics update). A new critical finding or a new failing policy violation is recorded in the application's history (`application.vulnerabilities_found`). When the project cannot be read, the component keeps the last readout and says why.

Processes see the readout as `dependencyTrack.readout` of the component (input type _Application_).

## Scorecard

The scorecard gets the part **Vulnerabilities** for services whose applications have components with a Dependency-Track project (otherwise the part is _none_ and its column is left out):

- **Attention**: a component has an open critical finding or a failing policy violation.
- **Pending**: open high findings, a readout older than two days, or a project that could not be read.
- **OK**: none of these.

## Monitor check

```yaml
checks:
  - id: shop-web
    name: No critical vulnerabilities
    type: dependency-track
    platform: Dependency-Track
    project: shop-web@latest
    maxCritical: 0 # down (or failAs) above this many open critical findings
    maxHigh: 3 # degraded above this many critical or high findings; leave out to ignore high ones
    policyFail: true # a failing policy violation counts like a critical finding
    failAs: down
```

The check reads a project at most every 5 minutes. A typical use is the example monitor _New critical vulnerabilities_: one check per production project with `maxCritical: 0`.

## Dashboard

The example process _Dependency-Track – vulnerabilities per project_ reads the whole portfolio (by default the latest version of each project) and publishes `dt.vulnerabilities` – one row per project with its open findings and policy violations, metrics `projects`, `critical`, `high`, `policyFail` – for the dashboard _Vulnerabilities_. Recommended schedule: every 6 hours.

## Demo

The demo has _Dependency-Track (demo)_ with the projects `shop-web` (2.4.1 with a critical log4j finding and a failing policy, and 2.5.0, the latest) and `crm-api` 1.0.0.
