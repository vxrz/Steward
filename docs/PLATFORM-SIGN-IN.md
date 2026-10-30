# Platform sign-in

How Steward signs in to a platform is its **auth type** (_Platforms → a platform → Settings → Authentication_). Credentials are stored encrypted in the vault, sent only to the platform's own origins (and to its token or STS endpoint), never shown again and masked in everything Steward returns – the request explorer, test runs, the MCP gateway, logs.

| Auth type                       | Credentials                                                 | Used by                                                       |
| ------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| None                            | –                                                           | public APIs (endoflife.date)                                  |
| Basic                           | `username`, `password`                                      | many on-prem APIs; on Kafka platforms the Schema Registry key |
| Static bearer token             | `token`                                                     | GitHub, GitLab, Forgejo, Kubernetes, CheckMk                  |
| API key                         | `apiKey` (header or query)                                  |                                                               |
| OAuth2 client credentials       | `clientId`, `clientSecret`                                  | Insights Hub, Entra ID apps                                   |
| Custom login request            | any, referenced as `{{ secrets.x }}`                        | Industrial Edge Management                                    |
| **Key-pair JWT**                | `privateKey` (PEM), optionally `privateKeyPassphrase`       | Snowflake; Google service accounts, Salesforce (exchange)     |
| **AWS request signing (SigV4)** | `accessKeyId`, `secretAccessKey`, optionally `sessionToken` | AWS APIs, S3 and S3-compatible storage                        |

The connection test, _Get a new token_ (for logins, JWTs and assumed roles) and the MCP gateway work the same for every type.

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

## AWS request signing (SigV4)

Every request to the platform is signed right before it is sent – over the exact body that goes over the wire – with AWS Signature Version 4: _region_ (e.g. `eu-central-1`) and _service_ (the signing name: `s3`, `execute-api`, `ce`, `tagging`, `iam` …). Steward's implementation is checked against the examples in AWS's documentation; no AWS SDK is involved.

- **Access key**: credentials `accessKeyId` and `secretAccessKey`, and `sessionToken` for temporary keys.
- **Assume a role** (recommended): with a _role ARN_ (and an _external ID_ if the role's trust policy asks for one), the platform's key only calls `sts:AssumeRole`; requests are signed with the role's temporary credentials, renewed five minutes before they end (one hour) or on _Get a new token_. The STS endpoint is `https://sts.<region>.amazonaws.com/` unless set (GovCloud, China, VPC endpoints).
- **S3**: requests carry `x-amz-content-sha256`; `unsignedPayload` signs large uploads without hashing the body. S3-compatible storage (MinIO, Ceph, Wasabi, Hetzner, Cloudflare R2) works with its own region name.

Give the key (or the role) only the read rights it needs – the AWS and backup docs list them per feature.
