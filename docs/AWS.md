# AWS accounts

Steward reads what runs in an AWS account for an application: the **resources** that carry the application tag, their **costs** per month and the **IAM users** with the tag and the age and last use of their **access keys**. Everything is read-only, signed with AWS Signature Version 4 by Steward itself (no AWS SDK).

| What                      | AWS API                                                                                                                                                         | How often                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Who the credentials are   | STS `GetCallerIdentity` (and `AssumeRole` with a role)                                                                                                          | connection test, every read               |
| Resources with the tag    | Resource Groups Tagging API `GetResources`, per region                                                                                                          | every 6 hours, or _Read now_              |
| Costs per month           | Cost Explorer `GetCostAndUsage`, by the tag and by service (one request series, 12 months and the current one, also into the cost model – [COSTS.md](COSTS.md)) | **once a day** (it costs $0.01 a request) |
| IAM users and access keys | IAM `ListUsers`, `ListUserTags`, `ListAccessKeys`, `GetAccessKeyLastUsed`                                                                                       | every 6 hours, or _Read now_              |

One platform is one AWS account. What the account answers is read once and shared by all components that use it (table `aws_account_cache`), so ten applications in one account cost one read, not ten.

## Connect an account

Under _Platforms_, add a platform of type _Amazon Web Services (AWS account, read-only)_:

- **Base URL**: `https://sts.<region>.amazonaws.com` – Steward calls each service at its own endpoint (`tagging.<region>.amazonaws.com`, `ce.us-east-1.amazonaws.com`, `iam.amazonaws.com`; China: `.amazonaws.com.cn`). Signed requests of an AWS platform go only to `https://…amazonaws.com` hosts. Any other base URL (LocalStack, a proxy) receives every service, like `AWS_ENDPOINT_URL`.
- **Authentication**: _AWS request signing (SigV4)_ with the account's main region. Recommended: an IAM user (or a workload identity's key) that may only **assume a role** in the account, with role ARN and external ID ([PLATFORM-SIGN-IN.md](PLATFORM-SIGN-IN.md)) – so one key can read several accounts, each as its own platform.
- **Variables**: `regions` – the regions to read, comma-separated (default: the main region); `tagKey` – the tag that links resources to applications (default `application`).

The test (_Test connection_) shows the account, the principal (`arn:aws:sts::…:assumed-role/steward-read/…`), the regions and the tag, and **probes each part Steward reads** – STS `GetCallerIdentity` needs no permission at all, so on its own it said nothing about the policy:

| Part             | Probe                                                            | When it is not allowed                                          |
| ---------------- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| STS / AssumeRole | `GetCallerIdentity`, with a role after `AssumeRole`              | the test fails (nothing else can work)                          |
| Resources        | tagging `GetResources` in the first region, one item             | ✗ _the policy of … lacks tag:GetResources_                      |
| Costs            | Cost Explorer `GetCostAndUsage` for one day (one request, $0.01) | ✗ _lacks ce:GetCostAndUsage_, or _Cost Explorer is not enabled_ |
| IAM users        | IAM `ListUsers`, one item                                        | ✗ _lacks iam:ListUsers …_                                       |

The test passes when STS works; parts that are not allowed are listed as warnings, so an account that should show no costs (no `ce:` permission) can still be used.

### Policies

Recommended: a caller (an IAM user or a workload identity) that may **only assume the role**, and a role in each account with the read policy.

**1. The caller's policy** – nothing but `sts:AssumeRole` on the role(s):

```json
{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Action": "sts:AssumeRole", "Resource": "arn:aws:iam::123456789012:role/steward-read" }]
}
```

**2. The role's trust policy** – trusts the caller, only with the external ID set on the platform (_Settings → Authentication → External ID_):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::210987654321:user/steward" },
      "Action": "sts:AssumeRole",
      "Condition": { "StringEquals": { "sts:ExternalId": "steward-7f3c…" } }
    }
  ]
}
```

A wrong or missing external ID, or a trust policy that does not name the caller, makes `AssumeRole` answer `AccessDenied` – the connection test then says that the caller needs `sts:AssumeRole` on the role and that the trust policy must trust it.

**3. The role's read policy** (with the access-review actions):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "tag:GetResources",
        "ce:GetCostAndUsage",
        "iam:ListUsers",
        "iam:ListUserTags",
        "iam:ListAccessKeys",
        "iam:GetAccessKeyLastUsed",
        "iam:ListGroupsForUser",
        "iam:ListAttachedUserPolicies",
        "iam:ListUserPolicies"
      ],
      "Resource": "*"
    }
  ]
}
```

Process steps that call further AWS APIs ([below](#aws-calls-in-processes)) need their actions added. Leave out `ce:GetCostAndUsage` to read no costs (the readout says why there are none), or the `iam:` actions to read no users. The last three `iam:` actions are only for access reviews of the account (access check source _AWS IAM_, [COMPLIANCE.md](COMPLIANCE.md#access-reconciliation)). Cost Explorer must be enabled in the account (the management account of an organisation sees the costs of all member accounts – then use the tag to tell them apart, or one platform per member account with its own role).

Without a role, the same read policy goes to the IAM user directly.

### S3 backups are a separate platform

Backups to S3 ([BACKUPS.md](BACKUPS.md)) do not use the AWS account platform: they go to a storage platform of their own (type _Generic REST API_ with AWS request signing for the service `s3`, the bucket's endpoint as base URL, [BACKUPS.md](BACKUPS.md#2-the-storage-platform)) with a key that may only write to the backup bucket. Keep the two apart – the read-only account platform should never be able to write, and the backup key should not read the account.

### AWS calls in processes

A process `http` step on an AWS platform can call any AWS API Steward has no connector for, signed like the connector's own calls: give the step `aws: { service, region }` and a path relative to that service's endpoint.

```yaml
- id: instances
  type: http
  connection: aws
  method: POST
  aws: { service: ec2, region: eu-central-1 }
  path: /
  bodyType: form
  body: { Action: DescribeInstances, Version: '2016-11-15', MaxResults: '5' }
```

The request goes to `https://ec2.eu-central-1.amazonaws.com/` (an AWS platform with another base URL, such as LocalStack, receives it at its base URL), signed for `ec2` in `eu-central-1` with the platform's keys or role. The outbound policy treats that endpoint as the platform's own origin **only** because the step names the service; a step without `aws` cannot reach other `amazonaws.com` hosts through the platform. The role needs the actions the step calls (here `ec2:DescribeInstances`).

### DynamoDB monitor checks

The monitor check **DynamoDB table** ([MONITORS.md](MONITORS.md#dynamodb-tables)) reads a table of the account: the newest item per partition key (`Query`), the write activity (CloudWatch `GetMetricData`) or the table's hygiene (`Describe…`). It is signed for `dynamodb` and `monitoring` in the check's region and goes to `dynamodb.<region>.amazonaws.com` and `monitoring.<region>.amazonaws.com` (an AWS platform with another base URL receives it there). The outbound policy treats these endpoints as the platform's own origin only for the check, as for process steps. Add these read-only statements to the role's policy – only for the tables the monitors read, and their indexes:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "StewardDynamoDbFreshness",
      "Effect": "Allow",
      "Action": ["dynamodb:Query", "dynamodb:DescribeTable", "dynamodb:DescribeContinuousBackups", "dynamodb:DescribeTimeToLive"],
      "Resource": ["arn:aws:dynamodb:eu-central-1:123456789012:table/crm-contacts", "arn:aws:dynamodb:eu-central-1:123456789012:table/crm-contacts/index/*"]
    },
    { "Sid": "StewardDynamoDbWrites", "Effect": "Allow", "Action": "cloudwatch:GetMetricData", "Resource": "*" }
  ]
}
```

`cloudwatch:GetMetricData` supports no resource-level permissions (resource `*`); it only reads metrics. The check never needs `dynamodb:Scan`, `dynamodb:GetItem`, `dynamodb:BatchGetItem`, `dynamodb:PartiQLSelect` or any write action – leave them out. A `Query` returns only the key and the time attribute (`ProjectionExpression`); to keep even that narrower, a condition on `dynamodb:Attributes` with `dynamodb:Select: SPECIFIC_ATTRIBUTES` can limit the role to those attributes. Leave out the statements of a mode you do not use (only `dynamodb:Query` for _newest item_, only `cloudwatch:GetMetricData` for _write activity_).

API references: DynamoDB [`Query`](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Query.html), [`DescribeTable`](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_DescribeTable.html), [`DescribeContinuousBackups`](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_DescribeContinuousBackups.html), [`DescribeTimeToLive`](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_DescribeTimeToLive.html) (AWS JSON 1.0, `X-Amz-Target: DynamoDB_20120810.<Action>`); CloudWatch [`GetMetricData`](https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_GetMetricData.html) in the AWS JSON 1.0 protocol (`X-Amz-Target: GraniteServiceVersion20100801.GetMetricData`, timestamps as epoch seconds); the [DynamoDB metrics](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/metrics-dimensions.html) (`ConsumedWriteCapacityUnits`, dimension `TableName`).

### Object storage for data products

Since 0.25.0 ([ADR 0037](adr/0037-data-products-connectors-files-edge.md) part 2) a **discovery source** of the data products module on an AWS account reads `files.path` elements from S3 ([DATA-PRODUCTS.md](DATA-PRODUCTS.md#object-storage)) – **only the prefixes it names** (`s3://<bucket>/<prefix>/`, a bucket's root only as `s3://<bucket>/`) and the `files.path` elements of products on the platform, never the whole account. It calls **`ListObjectsV2` only** – once with the delimiter `/` for the folders one level down, then 1,000 keys a call for the keys below – and keeps metadata: the number of objects, their size, the newest `LastModified`, the format by the keys' suffixes and Hive partitions. No `GetObject`, no `HeadObject`: Steward never reads a file. The `data-element` check reads the same listing for a file element's freshness and volume.

The calls are signed for the service `s3` in the bucket's region (the platform's main region first; a bucket elsewhere answers with its region, and Steward asks there once more), go to `https://<bucket>.s3.<region>.amazonaws.com/` (path style `https://s3.<region>.amazonaws.com/<bucket>` for a bucket with dots; any other base URL – LocalStack, the demo – path style below it) and through the outbound policy like every other request: an allow-list must name the S3 addresses.

**The role's policy** needs `s3:ListBucket` – and only on the prefixes the sources name, with the `s3:prefix` condition:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "StewardListNamedPrefixes",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::invented-landing.example",
      "Condition": { "StringLike": { "s3:prefix": ["orders/", "orders/*"] } }
    }
  ]
}
```

One statement per bucket; a source's scope that names a prefix outside the condition fails with _AccessDenied_ and says so on the run. Encrypted buckets need nothing more (a listing reads no object). Limits per run: 2,000 listings and 200,000 keys – a run they cut is _truncated_ and marks nothing missing; a check reads at most 20,000 keys of its element.

## Components of an application

An application component of type **Cloud account** names the AWS platform; its **name is the value of the tag** – `shop` for `application=shop`. Without a platform, a cloud account stays a plain entry as before.

Steward then shows, every 6 hours or on _Read now_:

- **Resources**: every resource with the tag in the regions read, with service, type, name and region (S3 buckets have none), counted per service. Resources that came or went are recorded in the application's history (`application.aws_resources_changed`).
- **Costs**: unblended costs per month for the tag, the current month so far and the last month on the component, six months in the readout (also for processes). Costs are read at most once a day, also on _Read now_. The same read fills the cost model: _Costs_ shows the account's costs per application (by the tag), per service and as _unassigned_ for untagged resources, with 12 months, trend, forecast and budgets ([COSTS.md](COSTS.md)).
- **IAM users** that carry the tag: each access key with its status, age and last use (date and service). Active keys older than 90 days are marked. _Add to the credentials register_ opens a new credential with the key's id, creation date and user, belonging to the component – review it and save; the secret part of a key is never read (AWS does not give it out after creation).

Each DynamoDB table among the resources links to a new monitor with a [DynamoDB check](#dynamodb-monitor-checks) for it (for people who may create monitors).

When the account cannot be read, the component keeps the last readout and says why; a region that fails is named while the others are read.

Processes see the readout as `readout` of the component (input type _Application_): `readout.resources`, `readout.services`, `readout.costs.months`, `readout.users`.

## Tagging

The tag is the link: give every resource of an application the same tag (AWS _cost allocation tag_ – activate it in the Billing console so Cost Explorer can group by it; costs from before the activation are not grouped). Tag policies of AWS Organizations can require it. The tagging API lists resources of most services; a few (some global ones) only appear in `us-east-1` – add it to `regions` if you use them.

## Templates

The example processes read what Steward read for the cloud accounts of the applications (input type _Applications_, `components[type = 'cloud-account'].readout`) – no call to AWS from the process, so Cost Explorer is not charged again. Process http steps cannot sign requests for other AWS services yet; once they can, a template can read IAM directly as well.

| Template                                                                                            | What it does                                                                                                                        | Schedule      | Dataset        |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------------- |
| [63 AWS – IAM access key age and unused credentials](../examples/processes/63-aws-iam-key-age.yaml) | Active access keys older than N days (rotate), active keys never or not recently used, inactive keys left, unused console passwords | daily         | `aws.iam-keys` |
| [64 AWS – Costs per application](../examples/processes/64-aws-costs-per-application.yaml)           | Last full month, the month before, the change, this month so far and the average per application; a check above a growth you allow  | monthly (3rd) | `aws.costs`    |

The dashboard [Cloud costs and keys](../examples/dashboards/63-cloud-costs-and-keys.yaml) shows both. Only IAM users with the application tag are in a readout; the access reconciliation with the source _AWS_ lists every IAM user of the account.

## Demo

The demo has _AWS (demo)_, an account `123456789012` with resources tagged `application=shop` and `application=crm` in `eu-central-1` and `eu-west-1`, six months of costs and three IAM users. Its DynamoDB table `crm-contacts` (index `by-segment-updated`: `segment`, `updatedAt`) answers `Query`, the `Describe…` calls and CloudWatch `GetMetricData`; the example monitor _CRM contacts (DynamoDB)_ reads it in all three modes (the segment `partner` is stale on purpose). Since 0.25.0 it also answers S3 `ListObjectsV2` for two invented buckets – `invented-landing.example` (Parquet files by day under `orders/`, which the external stage `SHOP.RAW.LANDING` of _Snowflake (demo)_ reads) and `invented-shop-lake.example` (CSV and JSON exports and an Iceberg table) – which the discovery source _Shop files (demo)_ reads. The mock checks the signature of every request. The sample applications _Webshop (demo)_ and _CRM (demo)_ have the cloud accounts `shop` and `crm`, so the templates above have data, and the access check _Platform access (demo) – AWS IAM users_ reads the IAM users.
