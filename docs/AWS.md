# AWS accounts

Steward reads what runs in an AWS account for an application: the **resources** that carry the application tag, their **costs** per month and the **IAM users** with the tag and the age and last use of their **access keys**. Everything is read-only, signed with AWS Signature Version 4 by Steward itself (no AWS SDK).

| What                      | AWS API                                                                   | How often                                 |
| ------------------------- | ------------------------------------------------------------------------- | ----------------------------------------- |
| Who the credentials are   | STS `GetCallerIdentity`                                                   | connection test, every read               |
| Resources with the tag    | Resource Groups Tagging API `GetResources`, per region                    | every 6 hours, or _Read now_              |
| Costs per month           | Cost Explorer `GetCostAndUsage`, by the tag and by service                | **once a day** (it costs $0.01 a request) |
| IAM users and access keys | IAM `ListUsers`, `ListUserTags`, `ListAccessKeys`, `GetAccessKeyLastUsed` | every 6 hours, or _Read now_              |

One platform is one AWS account. What the account answers is read once and shared by all components that use it (table `aws_account_cache`), so ten applications in one account cost one read, not ten.

## Connect an account

Under _Platforms_, add a platform of type _Amazon Web Services (AWS account, read-only)_:

- **Base URL**: `https://sts.<region>.amazonaws.com` – Steward calls each service at its own endpoint (`tagging.<region>.amazonaws.com`, `ce.us-east-1.amazonaws.com`, `iam.amazonaws.com`; China: `.amazonaws.com.cn`). Signed requests of an AWS platform go only to `https://…amazonaws.com` hosts. Any other base URL (LocalStack, a proxy) receives every service, like `AWS_ENDPOINT_URL`.
- **Authentication**: _AWS request signing (SigV4)_ with the account's main region. Recommended: an IAM user (or a workload identity's key) that may only **assume a role** in the account, with role ARN and external ID ([PLATFORM-SIGN-IN.md](PLATFORM-SIGN-IN.md)) – so one key can read several accounts, each as its own platform.
- **Variables**: `regions` – the regions to read, comma-separated (default: the main region); `tagKey` – the tag that links resources to applications (default `application`).

The test (_Test connection_) shows the account, the principal (`arn:aws:sts::…:assumed-role/steward-read/…`), the regions and the tag.

A policy for the role, read-only:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["tag:GetResources", "ce:GetCostAndUsage", "iam:ListUsers", "iam:ListUserTags", "iam:ListAccessKeys", "iam:GetAccessKeyLastUsed"],
      "Resource": "*"
    }
  ]
}
```

Leave out `ce:GetCostAndUsage` to read no costs (the readout says why there are none), or the `iam:` actions to read no users. Cost Explorer must be enabled in the account (the management account of an organisation sees the costs of all member accounts – then use the tag to tell them apart, or one platform per member account with its own role).

## Components of an application

An application component of type **Cloud account** names the AWS platform; its **name is the value of the tag** – `shop` for `application=shop`. Without a platform, a cloud account stays a plain entry as before.

Steward then shows, every 6 hours or on _Read now_:

- **Resources**: every resource with the tag in the regions read, with service, type, name and region (S3 buckets have none), counted per service. Resources that came or went are recorded in the application's history (`application.aws_resources_changed`).
- **Costs**: unblended costs per month for the tag, the current month so far and the last month on the component, six months in the readout (also for processes). Costs are read at most once a day, also on _Read now_.
- **IAM users** that carry the tag: each access key with its status, age and last use (date and service). Active keys older than 90 days are marked. _Add to the credentials register_ opens a new credential with the key's id, creation date and user, belonging to the component – review it and save; the secret part of a key is never read (AWS does not give it out after creation).

When the account cannot be read, the component keeps the last readout and says why; a region that fails is named while the others are read.

Processes see the readout as `readout` of the component (input type _Application_): `readout.resources`, `readout.services`, `readout.costs.months`, `readout.users`.

## Tagging

The tag is the link: give every resource of an application the same tag (AWS _cost allocation tag_ – activate it in the Billing console so Cost Explorer can group by it; costs from before the activation are not grouped). Tag policies of AWS Organizations can require it. The tagging API lists resources of most services; a few (some global ones) only appear in `us-east-1` – add it to `regions` if you use them.

## Demo

The demo has _AWS (demo)_, an account `123456789012` with resources tagged `application=shop` and `application=crm` in `eu-central-1` and `eu-west-1`, six months of costs and three IAM users. The mock checks the signature of every request.
