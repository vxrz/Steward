/** AWS accounts (#116): the inventory, costs and IAM keys Steward reads for an application. */

export const AWS_KIND = 'aws';

export const AWS_LIMITS = {
  /** Resources and IAM users are read again after this many hours (or on "Read now") */
  refreshHours: 6,
  /** Cost Explorer charges per request: costs are read at most once a day */
  costHours: 24,
  /** Months of costs (the current one so far included) */
  costMonths: 6,
  /** Resources per account and region at most */
  maxResources: 5000,
  /** Access keys older than this are marked for rotation */
  keyAgeDays: 90,
} as const;

/** AWS tag values: letters, digits, spaces and _ . : / = + - @, at most 256 characters. */
export const AWS_TAG_VALUE_RE = /^[\p{L}\p{N} _.:/=+\-@]{1,256}$/u;
export const AWS_REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;

export interface AwsResource {
  arn: string;
  service: string;
  /** e.g. instance, db, function, bucket */
  type: string;
  name: string;
  /** Empty for global resources (S3 buckets, CloudFront) */
  region: string;
  tags: Record<string, string>;
}

export interface AwsAccessKey {
  accessKeyId: string;
  status: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastService: string | null;
}

export interface AwsIamUser {
  userName: string;
  arn: string;
  createdAt: string;
  passwordLastUsed: string | null;
  keys: AwsAccessKey[];
}

export interface AwsCostMonth {
  /** YYYY-MM; the current month is so far */
  month: string;
  amount: number;
  currency: string;
}

/** What Steward read for an application component of type "Cloud account" on an AWS platform. */
export interface AwsReadout {
  readAt: string;
  error: string | null;
  account: string | null;
  /** The tag that links resources to the application, and its value (the component's name) */
  tagKey: string;
  tagValue: string;
  regions: string[];
  resources: AwsResource[];
  /** Resources per service, e.g. { ec2: 3, rds: 1 } */
  services: Record<string, number>;
  costs: { readAt: string | null; error: string | null; months: AwsCostMonth[] };
  /** IAM users that carry the tag – with the age and last use of their access keys */
  users: AwsIamUser[];
  /** Problems reading one part (costs, IAM, a region) without failing the whole readout */
  warnings: string[];
}
