# Platform sign-in

How Steward signs in to a platform is its **auth type** (_Platforms → a platform → Settings → Authentication_). Credentials are stored encrypted in the vault, sent only to the platform's own origins (and to its token or STS endpoint), never shown again and masked in everything Steward returns – the request explorer, test runs, the MCP gateway, logs.

| Auth type                       | Credentials                                                 | Used by                                                       |
| ------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| None                            | –                                                           | public APIs (endoflife.date)                                  |
| Basic                           | `username`, `password`                                      | many on-prem APIs; on Kafka platforms the Schema Registry key |
| Static bearer token             | `token`                                                     | GitHub, GitLab, Forgejo, Kubernetes, CheckMk                  |
| API key                         | `apiKey` (header or query)                                  |                                                               |
| OAuth2 client credentials       | `clientId`, `clientSecret` – or `privateKey`, `certificate` | Insights Hub, Microsoft Graph (Entra ID)                      |
| Custom login request            | any, referenced as `{{ secrets.x }}`                        | Industrial Edge Management, IBM Verify Privilege Vault        |
| **Key-pair JWT**                | `privateKey` (PEM), optionally `privateKeyPassphrase`       | Snowflake; Google service accounts, Salesforce (exchange)     |
| **AWS request signing (SigV4)** | `accessKeyId`, `secretAccessKey`, optionally `sessionToken` | AWS APIs, S3 and S3-compatible storage                        |

The connection test, _Get a new token_ (for logins, JWTs and assumed roles) and the MCP gateway work the same for every type.

## Identities

Since 0.9.0 a platform's credentials belong to an **identity** under it ([ADR 0009](adr/0009-platform-identities.md)). Every platform has exactly one **default identity**, and that is all there is for now: it holds the credentials of the _Credentials_ tab and the MCP mode of the _MCP_ tab, signs in with the platform's auth type and is open to everybody with the _use_ right on the platform – exactly as before. The _Identities_ tab of a platform shows it. Updating moves each platform's credentials to its default identity at the first unlock (sealed like the platform: a change made directly in the database is refused until an administrator confirms it); a platform whose settings were changed outside Steward waits until an administrator confirms them. Tokens, assumed AWS roles and database connections are kept per identity. Several identities per platform – for example a read-only and an admin account of one system – come in a later release.

**Confirming settings changed outside Steward** (since 0.9.0): the confirmation dialog lists, per identity, its MCP mode and the names of its credentials, and what it changes: settings an identity cannot have in this release – variables, its own sign-in, flags, an operation filter, a credential source – are reset to the platform's, and every identity but the default one is removed (only a change in the database can make one). The `platform.config_confirmed` audit entry records the same (never credential values). Variables used in the base URL, a token URL, the trusted origins or the portal URL always stay the platform's: an identity's own value for them is ignored when a request is sent (`IDENTITY_VARIABLE_FIXED`), not only refused when it is saved.

**One platform's credentials, one connection** (since 0.9.0): in a process, a platform's credentials are only used in requests sent through its own connection – `$secret('<slot>', …)` in a step on another slot fails before anything is sent ([SECURITY-HARDENING.md](SECURITY-HARDENING.md#which-rule-checks-which-call)).

## Adding a platform

_Platforms → Add platform_ opens a wizard (v0.4.0): **1** choose a connector (search, grouped by area), **2** its address and only the credentials it needs – on a connector that takes several sign-ins (Prometheus, the generic REST API) the auth type follows the fields you fill in –, **3** a **live connection test** with the plain-language diagnosis and the usual fixes inline (credentials, base URL, a sign-in page instead of the API, DNS, outbound policy, certificates), _Change the settings_ and _Test again_ until it works, **4** what's next: the matching template bundles and templates, the monitor check types and examples, access checks and the MCP gateway, one click each. _Skip the wizard_ opens the quick form.

## Platform health

The platform page shows the **last connection test** – passed or failed, when, by whom (or the periodic test), its message. **Test periodically** (off by default; every 15 minutes to once a day, platform managers) runs the same test from the server; when it starts failing, the platform's managers (else administrators) get **Platform connection failing**, routed like every other notification ([NOTIFICATIONS.md](NOTIFICATIONS.md)) – once per failing period. Every test is in the audit log (`platform.tested`, `details.periodic` for the periodic one), the setting too (`platform.health_changed`). API: `GET/PUT /api/platforms/:id/health`.

The tab **Get started** lists the same "what's next" as the wizard's last step (`GET /api/platforms/:id/get-started`).

## Custom login request with a refresh token

A custom login (`token_request`) posts its request (`auth.request`), takes the token from the answer (`tokenPath`, default `access_token`) and keeps it until shortly before its lifetime (`expiresInPath`) ends. With **`auth.refresh`** (v0.5.0) an expired token is first renewed with the refresh token of the last answer; only when that fails does Steward sign in again:

```json
"refresh": {
  "tokenPath": "refresh_token",
  "request": { "method": "POST", "url": "/oauth2/token", "bodyType": "form",
               "body": { "grant_type": "refresh_token", "refresh_token": "{{ refreshToken }}" } }
}
```

The refresh token is kept with the cached token in memory, never stored, and masked like it. A `401` from the platform drops both and signs in again. The preset _IBM Verify Privilege Vault_ uses it ([IBM-PAM.md](IBM-PAM.md#sign-in)).

## Key-pair JWT

Steward signs a JWT with the platform's private key for every new token: algorithm RS256, RS384, RS512, PS256 (RSA keys) or ES256, ES384 (EC keys), valid for at most an hour (`lifetimeSeconds`, default 3600). The **claims** are templates with `{{ vars.x }}`, `{{ secrets.x }}` and `{{ publicKeyFingerprint }}` (`SHA256:` and the base64 SHA-256 of the DER public key – what Snowflake expects); `iat`, `exp` and a random `jti` are set by Steward.

- **Send the JWT as the token** (`mode: token`): the header is `Authorization: Bearer <jwt>` unless _Header name_ and _Header value_ say otherwise. The JWT is reused until shortly before it ends.
- **Exchange it for an access token** (`mode: exchange`, RFC 7523): Steward posts `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>` (plus scope and extra parameters) to the _token URL_ and uses the `access_token` it gets.

Snowflake (SQL API, key-pair authentication):

```yaml
auth:
  type: jwt
  jwt:
    alg: RS256
    claims:
      iss: "{{ $uppercase(vars.account) & '.' & $uppercase(vars.user) & '.' & publicKeyFingerprint }}"
      sub: "{{ $uppercase(vars.account) & '.' & $uppercase(vars.user) }}"
variables: { account: xy12345, user: STEWARD_READER }
http:
  defaultHeaders: { X-Snowflake-Authorization-Token-Type: KEYPAIR_JWT }
```

Create the key pair with `openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out steward_key.p8` and `openssl rsa -in steward_key.p8 -pubout`, and give the user the public key (`ALTER USER … SET RSA_PUBLIC_KEY = '…'`). The private key goes into the credential `privateKey`; it never leaves Steward.

## Client assertion (certificate)

OAuth2 client credentials can sign in with a **client assertion** instead of the client secret (v0.5.0; RFC 7523 `private_key_jwt`, what Entra ID calls certificate credentials): _Send client credentials as → Client assertion signed with a certificate_ (`clientAuth: assertion`), or simply no `clientSecret` but a `privateKey`. For every token Steward signs a JWT valid for ten minutes – RS256 for an RSA key, PS256 for RSA-PSS, ES256 for EC –, with the client id as `iss` and `sub`, the token URL as `aud`, `nbf`, `iat`, `exp` and a random `jti`, and names the certificate in its header by `x5t#S256` and `x5t` (SHA-256 and SHA-1 thumbprints of the credential `certificate`, the public certificate in PEM; or `x5t` from the variable `certificateThumbprint`, a SHA-1 thumbprint in hex). It posts `client_id`, `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer` and `client_assertion` to the token URL; the private key never leaves Steward. The _scope_ may use `{{ baseUrl }}` and `{{ vars.x }}` like the token URL – Microsoft Graph asks for `{{ baseUrl }}/.default`. See [ENTRA.md](ENTRA.md#certificate-or-client-secret).

## Client certificate (mutual TLS)

A platform presents a **client certificate** when its credentials hold `tlsCertificate` and `tlsKey` (PEM; an encrypted key with `tlsKeyPassphrase`) – 0.9.0, for example for a Kafka Connect REST API behind mutual TLS ([KAFKA.md](KAFKA.md#kafka-connect-and-debezium)). It works with every authentication type, also _none_. Like every other credential it is only presented to the platform's own origins (its base URL and trusted origins), never on a request or redirect to another host; the private key stays in the vault. A private CA of the server goes under the platform's HTTP settings (`caPem`).

## AWS request signing (SigV4)

Every request to the platform is signed right before it is sent – over the exact body that goes over the wire – with AWS Signature Version 4: _region_ (e.g. `eu-central-1`) and _service_ (the signing name: `s3`, `execute-api`, `ce`, `tagging`, `iam` …). Steward's implementation is checked against the examples in AWS's documentation; no AWS SDK is involved.

- **Access key**: credentials `accessKeyId` and `secretAccessKey`, and `sessionToken` for temporary keys.
- **Assume a role** (recommended): with a _role ARN_ (and an _external ID_ if the role's trust policy asks for one), the platform's key only calls `sts:AssumeRole`; requests are signed with the role's temporary credentials, renewed five minutes before they end (one hour) or on _Get a new token_. The STS endpoint is `https://sts.<region>.amazonaws.com/` unless set (GovCloud, China, VPC endpoints).
- **S3**: requests carry `x-amz-content-sha256`; `unsignedPayload` signs large uploads without hashing the body. S3-compatible storage (MinIO, Ceph, Wasabi, Hetzner, Cloudflare R2) works with its own region name.

Give the key (or the role) only the read rights it needs – the AWS and backup docs list them per feature.
