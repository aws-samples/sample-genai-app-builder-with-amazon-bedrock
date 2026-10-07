import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface ProjectsTableProps {
  stackPrefix: string;
  kmsKey?: kms.IKey;
}

/**
 * Durable store for projects and their chat history.
 *
 * Single-table: the partition holds one `META` item, one `MEMBER#{userId}` item
 * per collaborator, and one item per message. Messages are separate items
 * because a long conversation would blow past the 400KB item limit, and because
 * appending a message must not rewrite the whole history.
 */
export class ProjectsTable extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: ProjectsTableProps) {
    super(scope, id);

    const { stackPrefix, kmsKey } = props;

    this.table = new dynamodb.Table(this, 'Table', {
      tableName: `${stackPrefix}-projects`,
      partitionKey: { name: 'projectId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: kmsKey
        ? dynamodb.TableEncryption.CUSTOMER_MANAGED
        : dynamodb.TableEncryption.AWS_MANAGED,
      encryptionKey: kmsKey,
    });

    // GSI: byOwner — the sidebar's project list, most recently touched first.
    // Sparse by construction: only META items carry `ownerId`, so member and
    // message items never appear in it.
    this.table.addGlobalSecondaryIndex({
      indexName: 'byOwner',
      partitionKey: { name: 'ownerId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: byUrlId — the frontend routes on the human-readable urlId, not the
    // projectId, so a chat URL has to be resolvable back to its partition.
    this.table.addGlobalSecondaryIndex({
      indexName: 'byUrlId',
      partitionKey: { name: 'urlId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
  }
}
