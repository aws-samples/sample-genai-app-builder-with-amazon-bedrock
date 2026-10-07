import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import { bundleBrandTemplatesLambda } from './brand-templates-bundler';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3Deployment from 'aws-cdk-lib/aws-s3-deployment';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cognitoIdentityPool from 'aws-cdk-lib/aws-cognito-identitypool';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Duration } from 'aws-cdk-lib';
import { SandboxInfrastructure } from './sandbox';
import { ORIGIN_VERIFY_HEADER } from './sandbox/sandbox-alb';
import { SharedSitesBucket } from './shared-sites/shared-sites-bucket';
import { SharedSitesTable } from './shared-sites/shared-sites-table';
import {
  createUntrustedContent,
  legacyRedirectFunctionCode,
  type UntrustedContent,
} from './untrusted-content/untrusted-content';
import { ProjectsTable } from './projects/projects-table';

interface InfraStackProps extends cdk.StackProps {
  config: {
    stackName: string;
    region: string;
    bedrockModelId: string;
    // Optional: model used by the brand-templates extractor. Defaults to
    // Haiku 4.5 for ~2x faster extraction. Override per env if you need
    // higher fidelity at the cost of latency.
    extractionModelId?: string;
    cognitoUsers?: string[];
    customDomain?: string; // Optional custom domain
    // Optional separate registrable domain for untrusted content (live previews,
    // shared sites), e.g. vibe-preview.example.net. Needs a Route 53 hosted zone
    // for it in this account. Defaults to preview.<customDomain>.
    previewDomain?: string;
    // Email(s) notified when the weekly sandbox container patch build fails.
    // Set in prod so patch failures can't drift out of CVE-remediation SLA unnoticed.
    alarmEmail?: string | string[];
  };
}

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: InfraStackProps) {
    super(scope, id, {
      ...props,
      description: "Vibe - AI-powered web development agent (uksb-4t2x71ky88)"
    });

    const { config } = props;

    // Use stack name as prefix for all resources
    const stackPrefix = config.stackName.toLowerCase();

    // Customer-managed KMS key for encryption
    const encryptionKey = new kms.Key(this, 'BedrockVibeEncryptionKey', {
      alias: `${stackPrefix}-encryption-key`,
      description: 'Customer-managed KMS key for Vibe encryption',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      policy: new iam.PolicyDocument({
        statements: [
          // Allow root account full access
          new iam.PolicyStatement({
            sid: 'Enable IAM User Permissions',
            effect: iam.Effect.ALLOW,
            principals: [new iam.AccountRootPrincipal()],
            actions: ['kms:*'],
            resources: ['*'],
          }),
          // CloudTrail KMS permissions disabled (CloudTrail not in use)
          // Allow services to use key
          new iam.PolicyStatement({
            sid: 'Allow services to use encryption key',
            effect: iam.Effect.ALLOW,
            principals: [
              new iam.ServicePrincipal('s3.amazonaws.com'),
              new iam.ServicePrincipal('secretsmanager.amazonaws.com'),
            ],
            actions: [
              'kms:Decrypt',
              'kms:GenerateDataKey*',
            ],
            resources: ['*'],
          }),
        ],
      }),
    });

    // ========================================
    // BEDROCK GUARDRAIL
    // ========================================

    const guardrail = new bedrock.CfnGuardrail(this, 'BedrockGuardrail', {
      name: `${stackPrefix}-guardrail`,
      blockedInputMessaging: 'Your request contains content that is not allowed. Please rephrase your message.',
      blockedOutputsMessaging: 'The response was blocked due to content policy. Please try a different request.',
      contentPolicyConfig: {
        filtersConfig: [
          { type: 'HATE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'INSULTS', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'SEXUAL', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'VIOLENCE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'MISCONDUCT', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' },
        ],
      },
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          { type: 'EMAIL', action: 'ANONYMIZE' },
          { type: 'PHONE', action: 'ANONYMIZE' },
          { type: 'US_SOCIAL_SECURITY_NUMBER', action: 'BLOCK' },
          { type: 'CREDIT_DEBIT_CARD_NUMBER', action: 'BLOCK' },
        ],
      },
    });

    // Create guardrail version for production use
    const guardrailVersion = new bedrock.CfnGuardrailVersion(this, 'BedrockGuardrailVersion', {
      guardrailIdentifier: guardrail.attrGuardrailId,
    });

    // S3 bucket for access logs
    const accessLogsBucket = new s3.Bucket(this, 'BedrockVibeAccessLogs', {
      bucketName: `${stackPrefix}-access-logs-${this.account}-${this.region}`,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: encryptionKey,
    });

    // Access logs for the edge: sandbox ALB, every CloudFront distribution.
    // Separate from accessLogsBucket because ALB log delivery only supports
    // SSE-S3, not KMS. CloudFront standard (legacy) logging writes with ACLs,
    // hence BUCKET_OWNER_PREFERRED rather than ACLs disabled.
    //
    // CloudFront logs include the query string, which on /ws/* carries the
    // signed-URL Policy, Signature and Key-Pair-Id. Those signatures expire after
    // 120 s and are bound to one session path, and this bucket is private and
    // TLS-only, so the exposure is small. Dropping the field needs CloudFront
    // v2 logging (field selection), which must be configured in us-east-1 and so
    // can't live in this stack.
    const edgeLogsBucket = new s3.Bucket(this, 'EdgeAccessLogs', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      lifecycleRules: [{ id: 'expire-after-one-year', expiration: Duration.days(365) }],
      // Logs outlive the stack; a teardown must not erase the audit trail.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // S3 Bucket for static assets
    const staticAssetsBucket = new s3.Bucket(this, 'BedrockVibeStaticAssets', {
      bucketName: `${stackPrefix}-static-assets-${this.account}-${this.region}`,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: encryptionKey,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'static-assets-access-logs/',
    });

    // ========================================
    // STYLE EXTRACTION INFRASTRUCTURE
    // ========================================

    // S3 Bucket for uploaded UI screenshots and brand-template source files
    const styleExtractionBucket = new s3.Bucket(this, 'BedrockVibeStyleExtraction', {
      bucketName: `${stackPrefix}-style-extraction-${this.account}-${this.region}`,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: encryptionKey,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'style-extraction-access-logs/',
      // CORS allowedOrigins are added later via addCorsRule once the
      // CloudFront distribution exists (see below). Bucket-creation-time
      // would require a hardcoded domain that breaks on stack rename.
      lifecycleRules: [
        {
          // Delete temporary files after 24 hours
          id: 'delete-temp-files',
          prefix: 'uploads/',
          expiration: Duration.days(1),
          enabled: true,
        },
      ],
    });

    // DynamoDB Table for Brand Templates
    const brandTemplatesTable = new dynamodb.Table(this, 'BedrockVibeBrandTemplatesTable', {
      tableName: `${stackPrefix}-brand-templates`,
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'skillId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: encryptionKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: true,
    });

    // GSI for status polling by jobId (async extraction worker writes via this).
    brandTemplatesTable.addGlobalSecondaryIndex({
      indexName: 'jobId-index',
      partitionKey: {
        name: 'jobId',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ========================================
    // SIMPLIFIED COGNITO SETUP
    // ========================================

    // Cognito User Pool - Simple setup
    const userPool = new cognito.UserPool(this, 'BedrockVibeUserPool', {
      userPoolName: `${stackPrefix}-user-pool`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      selfSignUpEnabled: false,
      autoVerify: { email: true },
      signInAliases: {
        email: true,
      },
      userVerification: {
        emailSubject: 'Welcome to Vibe - Verify your account',
        emailBody: `Hello {username},

Welcome to Vibe - an AI-powered web development platform!

Please click the link below to verify your email and set your password:
{##Verify Email##}

Once verified, you can sign in at the application URL provided in your deployment.

Best regards,
The Vibe Team`,
        emailStyle: cognito.VerificationEmailStyle.LINK,
      },
    });

    // Cognito User Pool Client - Simple setup
    const userPoolClient = userPool.addClient('BedrockVibeUserPoolClient', {
      userPoolClientName: `${stackPrefix}-user-pool-client`,
      generateSecret: false,
      authFlows: {
        adminUserPassword: true,
        userPassword: true,
        userSrp: true,
      },
    });

    // Cognito Identity Pool - Simple setup
    const identityPool = new cognitoIdentityPool.IdentityPool(this, 'BedrockVibeIdentityPool', {
      identityPoolName: `${stackPrefix}_identity_pool`,
      authenticationProviders: {
        userPools: [
          new cognitoIdentityPool.UserPoolAuthenticationProvider({
            userPool,
            userPoolClient,
          }),
        ],
      },
    });

    // Create Cognito users from config
    if (config.cognitoUsers) {
      for (const email of config.cognitoUsers) {
        new cognito.CfnUserPoolUser(this, `User-${email.replace(/[^a-zA-Z0-9]/g, '-')}`, {
          userPoolId: userPool.userPoolId,
          username: email,
          desiredDeliveryMediums: ['EMAIL'],
          userAttributes: [
            { name: 'email', value: email },
            { name: 'email_verified', value: 'true' },
          ],
        });
      }
    }

    // ========================================
    // LAMBDA FUNCTION
    // ========================================

    // IAM Role for Lambda Function
    const lambdaRole = new iam.Role(this, 'BedrockVibeLambdaRole', {
      roleName: `${stackPrefix}-lambda-role-${this.region}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Grant Lambda access to KMS key
    encryptionKey.grantDecrypt(lambdaRole);

    // Add Bedrock permissions to the Lambda role
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: [
        // Allow invoking any Bedrock foundation model or inference profile
        'arn:aws:bedrock:*::foundation-model/*',
        `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
      ],
    }));

    // Add Bedrock Guardrail permissions
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:ApplyGuardrail',
      ],
      resources: [
        `arn:aws:bedrock:${this.region}:${this.account}:guardrail/${guardrail.attrGuardrailId}`,
      ],
    }));

    // Add SSM permissions to Lambda role for reading config
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${stackPrefix}/*`],
    }));

    // Prevent privilege escalation by denying IAM permission mutation actions
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      actions: [
        'iam:AttachRolePolicy',
        'iam:AttachUserPolicy',
        'iam:AttachGroupPolicy',
        'iam:PutRolePolicy',
        'iam:PutUserPolicy',
        'iam:PutGroupPolicy',
        'iam:CreatePolicyVersion',
        'iam:SetDefaultPolicyVersion',
        'iam:PassRole',
        'iam:UpdateAssumeRolePolicy',
      ],
      resources: ['*'],
    }));

    // Grant Lambda access to style extraction S3 bucket (reused for brand templates)
    styleExtractionBucket.grantReadWrite(lambdaRole);

    // Lambda Function for server-side rendering and API routes
    const remixLambda = new lambda.Function(this, 'BedrockVibeRemixLambda', {
      functionName: `${stackPrefix}-remix-${config.region}`,
      code: lambda.Code.fromAsset('../frontend/build/lambda'),
      handler: 'index.handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(15),
      role: lambdaRole,
      environment: {
        NODE_ENV: 'production',
        BEDROCK_MODEL_ID: config.bedrockModelId,
        BEDROCK_GUARDRAIL_ID: guardrail.attrGuardrailId,
        BEDROCK_GUARDRAIL_VERSION: guardrailVersion.attrVersion,
        FORCE_UPDATE_TIMESTAMP: new Date().toISOString(),
        // Configuration now stored in SSM Parameter Store to avoid circular dependencies
        STACK_PREFIX: stackPrefix,
      },
    });

    // ========================================
    // DEDICATED STREAMING LAMBDA (for chat streaming only)
    // ========================================

    // Dedicated streaming Lambda for chat requests only
    const streamingLambda = new lambda.Function(this, 'BedrockVibeStreamingLambda', {
      functionName: `${stackPrefix}-streaming-${config.region}`,
      code: lambda.Code.fromAsset('../frontend/build/lambda'),
      handler: 'streaming.handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(5),
      role: lambdaRole,
      environment: {
        NODE_ENV: 'production',
        BEDROCK_MODEL_ID: config.bedrockModelId,
        BEDROCK_GUARDRAIL_ID: guardrail.attrGuardrailId,
        BEDROCK_GUARDRAIL_VERSION: guardrailVersion.attrVersion,
        FORCE_UPDATE_TIMESTAMP: new Date().toISOString(),
        STACK_PREFIX: stackPrefix,
      },
    });

    // ========================================
    // DESIGN SKILLS LAMBDA
    // ========================================
    // Reuses the `BedrockVibeStyleExtraction` S3 bucket (kept for name stability);
    // the old style-extraction Lambda / table / routes were removed in favor of
    // this single flow that produces a structured BrandTemplate record.

    const brandTemplatesLambdaRole = new iam.Role(this, 'BrandTemplatesLambdaRole', {
      roleName: `${stackPrefix}-brand-templates-lambda-role-${this.region}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    encryptionKey.grantDecrypt(brandTemplatesLambdaRole);
    encryptionKey.grantEncryptDecrypt(brandTemplatesLambdaRole);

    brandTemplatesLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: [
        'arn:aws:bedrock:*::foundation-model/*',
        `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
      ],
    }));

    styleExtractionBucket.grantReadWrite(brandTemplatesLambdaRole);
    brandTemplatesTable.grantReadWriteData(brandTemplatesLambdaRole);

    const brandTemplatesLambda = new lambda.Function(this, 'BrandTemplatesLambda', {
      functionName: `${stackPrefix}-brand-templates-${config.region}`,
      code: lambda.Code.fromAsset('lambda/brand-templates', {
        exclude: [
          '.venv',
          '.venv/**',
          '__pycache__',
          '**/__pycache__',
          '.pytest_cache',
          '**/.pytest_cache',
          '*.pyc',
          'tests',
          'tests/**',
          'requirements-dev.txt',
        ],
        // OUTPUT hashing: the asset hash is computed from the bundled
        // contents, not the source directory. Without this, a Jest run with
        // BV_SKIP_LAMBDA_BUNDLE=1 (deps-free source copy) leaves a stub
        // under cdk.out/asset.<hash>/ that a subsequent `cdk deploy`
        // reuses — uploading a Lambda missing jsonschema, Pillow, etc.
        // OUTPUT hashing means the stub and the real pip-installed bundle
        // get different hashes, so they can't poison each other.
        assetHashType: cdk.AssetHashType.OUTPUT,
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          command: [
            'bash', '-c',
            'pip install -r requirements.txt -t /asset-output && cp -au . /asset-output',
          ],
          local: {
            tryBundle(outputDir: string): boolean {
              return bundleBrandTemplatesLambda(
                path.join(__dirname, '..', 'lambda', 'brand-templates'),
                outputDir,
              );
            },
          },
        },
      }),
      handler: 'lambda_function.handler',
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 2048,
      // Bedrock Sonnet multimodal calls can run 30-90s each, and the
      // extractor may chain up to 3 (initial + parse-retry + schema-retry).
      // 5 min was killing legitimate slow runs mid-stream; 10 min covers the
      // observed worst case. Lambda is per-ms billed so the unused headroom
      // is free.
      timeout: Duration.minutes(10),
      role: brandTemplatesLambdaRole,
      environment: {
        BEDROCK_MODEL_ID: config.bedrockModelId,
        // Token extraction uses Haiku for speed; chat (a different Lambda)
        // keeps using BEDROCK_MODEL_ID (Sonnet) for code-gen quality.
        EXTRACTION_MODEL_ID:
          config.extractionModelId ?? 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        BRAND_TEMPLATES_BUCKET: styleExtractionBucket.bucketName,
        BRAND_TEMPLATES_TABLE: brandTemplatesTable.tableName,
      },
    });

    // Self-invoke for async extraction — same pattern as the old Lambda.
    brandTemplatesLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${stackPrefix}-brand-templates-${config.region}`],
    }));

    new ssm.StringParameter(this, 'BrandTemplatesLambdaArnParameter', {
      parameterName: `/${stackPrefix}/brand-templates/lambda-arn`,
      stringValue: brandTemplatesLambda.functionArn,
      description: 'Brand Templates Lambda ARN',
    });

    // ========================================
    // LAMBDA FUNCTION URLS
    // ========================================
    // NOTE: Lambda Function URLs are AWS-managed TLS endpoints that do not support
    // configuring a minimum TLS version. They accept TLS 1.0+ by default.
    // Mitigation: Both Function URLs use AWS_IAM auth (no anonymous access) and are
    // accessed exclusively through CloudFront, which enforces TLS 1.2+ on the
    // viewer-facing side. Direct invocation requires SigV4-signed requests from
    // authenticated Cognito Identity Pool users. This is an accepted AWS service
    // limitation — see https://repost.aws/questions/QUoEeYfMb0T4iHYeh0PDXDHQ

    // Main Lambda Function URL (regular responses for SSR)
    const mainFunctionUrl = remixLambda.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      invokeMode: lambda.InvokeMode.BUFFERED, // Regular responses
      cors: {
        allowCredentials: true,
        allowedHeaders: [
          'Content-Type',
          'Authorization',
          'X-Amz-Date',
          'X-Api-Key',
          'X-Amz-Security-Token',
          'X-Amz-User-Agent',
          'X-Amz-Content-Sha256',
          'Accept',
          'Origin',
          'Referer'
        ],
        allowedMethods: [
          lambda.HttpMethod.GET,
          lambda.HttpMethod.POST
        ],
        allowedOrigins: ['*'], // Will be restricted by CloudFront
        maxAge: Duration.hours(1),
      },
    });

    // Streaming Lambda Function URL (streaming responses for chat)
    const streamingFunctionUrl = streamingLambda.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM, // Streaming responses
      cors: {
        allowCredentials: true,
        allowedHeaders: [
          'Content-Type',
          'Authorization',
          'X-Amz-Date',
          'X-Api-Key',
          'X-Amz-Security-Token',
          'X-Amz-User-Agent',
          'X-Amz-Content-Sha256',
          'Accept',
          'Origin',
          'Referer'
        ],
        allowedMethods: [
          lambda.HttpMethod.POST
        ],
        allowedOrigins: ['*'], // Will be restricted by CloudFront
        maxAge: Duration.hours(1),
      },
    });

    // Grant Identity Pool authenticated users permission to invoke both Function URLs.
    //
    // As of October 2025, AWS requires BOTH permissions for Function URLs with
    // AWS_IAM auth type, even in the same account. See:
    // https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html
    //   - lambda:InvokeFunctionUrl is the permission on the URL itself.
    //   - lambda:InvokeFunction is the downstream invoke; without it, Lambda
    //     returns a generic "Forbidden" from the Function URL auth layer and
    //     no CloudWatch log entry is produced.
    //
    // The lambda:InvokedViaFunctionUrl condition keeps the InvokeFunction grant
    // scoped to Function-URL calls only, preventing any indirect invocation path.
    const authenticatedRole = identityPool.authenticatedRole as iam.Role;
    authenticatedRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunctionUrl'],
      resources: [remixLambda.functionArn, streamingLambda.functionArn],
      conditions: {
        StringEquals: {
          'lambda:FunctionUrlAuthType': 'AWS_IAM'
        }
      }
    }));
    authenticatedRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [remixLambda.functionArn, streamingLambda.functionArn],
      conditions: {
        Bool: {
          'lambda:InvokedViaFunctionUrl': 'true'
        }
      }
    }));

    // ========================================
    // SSM PARAMETERS FOR RUNTIME CONFIGURATION
    // ========================================

    // Store all configuration in SSM Parameter Store to avoid circular dependencies
    new ssm.StringParameter(this, 'CognitoUserPoolIdParameter', {
      parameterName: `/${stackPrefix}/cognito/user-pool-id`,
      stringValue: userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });
    new ssm.StringParameter(this, 'CognitoUserPoolClientIdParameter', {
      parameterName: `/${stackPrefix}/cognito/user-pool-client-id`,
      stringValue: userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
    });
    new ssm.StringParameter(this, 'CognitoIdentityPoolIdParameter', {
      parameterName: `/${stackPrefix}/cognito/identity-pool-id`,
      stringValue: identityPool.identityPoolId,
      description: 'Cognito Identity Pool ID',
    });
    new ssm.StringParameter(this, 'RemixFunctionUrlParameter', {
      parameterName: `/${stackPrefix}/lambda/remix-function-url`,
      stringValue: mainFunctionUrl.url,
      description: 'Remix Lambda Function URL for SSR and regular API requests',
    });
    new ssm.StringParameter(this, 'StreamingFunctionUrlParameter', {
      parameterName: `/${stackPrefix}/lambda/streaming-function-url`,
      stringValue: streamingFunctionUrl.url,
      description: 'Streaming Lambda Function URL for chat streaming requests',
    });
    new ssm.StringParameter(this, 'AwsRegionParameter', {
      parameterName: `/${stackPrefix}/aws/region`,
      stringValue: config.region,
      description: 'AWS Region',
    });

    // Grant Identity Pool authenticated users permission to read SSM parameters
    authenticatedRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${stackPrefix}/*`],
    }));

    // Grant authenticated users permission to upload to style extraction bucket
    authenticatedRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:PutObject', 's3:GetObject'],
      resources: [`${styleExtractionBucket.bucketArn}/uploads/*`],
    }));

    // Store style-extraction bucket configuration in SSM (bucket is reused by Brand Templates)
    new ssm.StringParameter(this, 'StyleExtractionBucketParameter', {
      parameterName: `/${stackPrefix}/style-extraction/bucket-name`,
      stringValue: styleExtractionBucket.bucketName,
      description: 'S3 bucket for style extraction uploads (reused by brand-templates Lambda)',
    });

    // Store brand-templates configuration in SSM for the new Lambda wiring.
    new ssm.StringParameter(this, 'BrandTemplatesTableParameter', {
      parameterName: `/${stackPrefix}/brand-templates/table-name`,
      stringValue: brandTemplatesTable.tableName,
      description: 'DynamoDB table for Brand Template records',
    });

    // ========================================
    // API GATEWAY (for regular API calls with Cognito auth)
    // ========================================

    // Secret for CloudFront origin verification
    const xOriginVerifySecret = new secretsmanager.Secret(this, 'BedrockVibeOriginSecret', {
      secretName: `${stackPrefix}-origin-verify-secret`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryptionKey: encryptionKey,
      generateSecretString: {
        excludePunctuation: true,
        generateStringKey: 'headerValue',
        secretStringTemplate: '{}',
      },
    });

    // Grant Lambda access to the secret
    xOriginVerifySecret.grantRead(remixLambda);
    remixLambda.addEnvironment('X_ORIGIN_VERIFY_SECRET_ARN', xOriginVerifySecret.secretArn);

    // CloudFront key pair for sandbox WebSocket signed URLs.
    //
    // The sandbox socket can run shell commands in the workspace, and the session
    // id is not a secret (it appears in preview URLs and load-balancer logs), so
    // the upgrade must be authorised. The session manager — after checking the
    // caller owns or was invited to the session — issues a short-lived CloudFront
    // signed URL, and CloudFront verifies it against this trusted key group before
    // forwarding anything. The private key is held only in Secrets Manager.
    const wsSigningKeySecret = new secretsmanager.Secret(this, 'SandboxWsSigningKey', {
      secretName: `${stackPrefix}-sandbox-ws-signing-key`,
      description: 'Private key for CloudFront signed URLs on sandbox WebSockets',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryptionKey: encryptionKey,
    });

    // Neither CloudFormation nor Secrets Manager can generate an RSA key pair, so
    // a custom resource generates one, writes the private half into the secret
    // and hands back only the public half. Bump KeyVersion to rotate.
    const wsSigningKeyFn = new lambdaNodejs.NodejsFunction(this, 'SandboxWsSigningKeyFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: 'lib/sandbox/ws-signing-key/index.ts',
      handler: 'handler',
      timeout: Duration.seconds(30),
      bundling: { minify: true, externalModules: [] },
    });
    wsSigningKeySecret.grantWrite(wsSigningKeyFn);

    const wsSigningKey = new cdk.CustomResource(this, 'SandboxWsSigningKeyPair', {
      serviceToken: new cr.Provider(this, 'SandboxWsSigningKeyProvider', {
        onEventHandler: wsSigningKeyFn,
      }).serviceToken,
      properties: {
        SecretArn: wsSigningKeySecret.secretArn,
        KeyVersion: '1',
      },
    });

    const wsPublicKey = new cloudfront.PublicKey(this, 'SandboxWsPublicKey', {
      encodedKey: wsSigningKey.getAttString('PublicKey'),
      comment: `${stackPrefix} sandbox WebSocket signed URLs`,
    });

    const wsKeyGroup = new cloudfront.KeyGroup(this, 'SandboxWsKeyGroup', {
      items: [wsPublicKey],
      comment: `${stackPrefix} sandbox WebSocket signed URLs`,
    });

    // Sent by CloudFront on every request to the sandbox ALB, and required by
    // every ALB forwarding rule, so the containers are reachable only through
    // this stack's distributions and therefore only past the signed-URL check.
    const originVerifyHeaderValue = xOriginVerifySecret
      .secretValueFromJson('headerValue')
      .unsafeUnwrap();


    // API Gateway REST API
    const restApi = new apigateway.RestApi(this, 'BedrockVibeRestApi', {
      restApiName: `${stackPrefix}-rest-api`,
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      cloudWatchRole: true,
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type',
          'Authorization',
          'X-Amz-Date',
          'X-Amz-Security-Token',
        ],
        maxAge: cdk.Duration.minutes(10),
      },
      deploy: true,
      deployOptions: {
        stageName: 'api',
        // Access logs (one line per request, no query string or body).
        accessLogDestination: new apigateway.LogGroupLogDestination(
          new logs.LogGroup(this, 'RestApiAccessLogs', {
            retention: logs.RetentionDays.ONE_YEAR,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
          }),
        ),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        tracingEnabled: true,
        metricsEnabled: true,
        throttlingRateLimit: 2500,
      },
    });

    // TLS enforcement: the REST API is REGIONAL and accessed exclusively through
    // CloudFront, which enforces TLS 1.2+ on the viewer-facing side.
    // SecurityPolicy on AWS::ApiGateway::RestApi is not a valid CloudFormation
    // property — it only applies to AWS::ApiGateway::DomainName. The actual TLS
    // enforcement is configured on the CloudFront distribution below via
    // minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021.

    // Override the default 4xx and 5xx gateway responses so they include CORS
    // headers. Without this, when the Cognito authorizer rejects a token or
    // the Lambda integration crashes (e.g., the missing-jsonschema bundle bug
    // on 2026-05-20), API Gateway emits its built-in error response with no
    // Access-Control-Allow-Origin header. The browser then surfaces the
    // failure as a "CORS policy" error instead of the real 401/502, which
    // wastes time chasing the wrong cause.
    new apigateway.GatewayResponse(this, 'CorsDefault4XX', {
      restApi,
      type: apigateway.ResponseType.DEFAULT_4XX,
      responseHeaders: {
        'Access-Control-Allow-Origin': "'*'",
        'Access-Control-Allow-Headers': "'Content-Type,Authorization,X-Amz-Date,X-Amz-Security-Token'",
        'Access-Control-Allow-Methods': "'GET,POST,PATCH,DELETE,OPTIONS'",
      },
    });
    new apigateway.GatewayResponse(this, 'CorsDefault5XX', {
      restApi,
      type: apigateway.ResponseType.DEFAULT_5XX,
      responseHeaders: {
        'Access-Control-Allow-Origin': "'*'",
        'Access-Control-Allow-Headers': "'Content-Type,Authorization,X-Amz-Date,X-Amz-Security-Token'",
        'Access-Control-Allow-Methods': "'GET,POST,PATCH,DELETE,OPTIONS'",
      },
    });

    // Cognito Authorizer for API Gateway
    const cognitoAuthorizer = new apigateway.CfnAuthorizer(this, 'BedrockVibeCognitoAuthorizer', {
      name: 'CognitoAuthorizer',
      identitySource: 'method.request.header.Authorization',
      providerArns: [userPool.userPoolArn],
      restApiId: restApi.restApiId,
      type: apigateway.AuthorizationType.COGNITO,
    });

    // API Gateway v1 resource with Cognito authorization (for authenticated API calls)
    // IMPORTANT: Define /v1 resource BEFORE root proxy to ensure proper route matching
    const v1Resource = restApi.root.addResource('v1', {
      defaultMethodOptions: {
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer: { authorizerId: cognitoAuthorizer.ref },
      },
    });

    // ----- Brand Templates endpoints -----
    const brandTemplatesResource = v1Resource.addResource('brand-templates');

    // POST /api/v1/brand-templates/upload-urls
    const dsUploadUrlsResource = brandTemplatesResource.addResource('upload-urls');
    dsUploadUrlsResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(brandTemplatesLambda, { proxy: true })
    );

    // POST /api/v1/brand-templates (create) + GET /api/v1/brand-templates (list)
    brandTemplatesResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(brandTemplatesLambda, { proxy: true })
    );
    brandTemplatesResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(brandTemplatesLambda, { proxy: true })
    );

    // GET /api/v1/brand-templates/status/{jobId}
    const dsStatusResource = brandTemplatesResource.addResource('status');
    const dsStatusJobResource = dsStatusResource.addResource('{jobId}');
    dsStatusJobResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(brandTemplatesLambda, { proxy: true })
    );

    // GET / PATCH / DELETE /api/v1/brand-templates/{skillId}
    const dsSkillIdResource = brandTemplatesResource.addResource('{skillId}');
    dsSkillIdResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(brandTemplatesLambda, { proxy: true })
    );
    dsSkillIdResource.addMethod(
      'PATCH',
      new apigateway.LambdaIntegration(brandTemplatesLambda, { proxy: true })
    );
    dsSkillIdResource.addMethod(
      'DELETE',
      new apigateway.LambdaIntegration(brandTemplatesLambda, { proxy: true })
    );

    // GET /api/v1/brand-templates/{skillId}/export
    const dsExportResource = dsSkillIdResource.addResource('export');
    dsExportResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(brandTemplatesLambda, { proxy: true })
    );

    // Proxy resource for other authenticated API calls under /v1
    const v1ProxyResource = v1Resource.addResource('{proxy+}');
    v1ProxyResource.addMethod(
      'ANY',
      new apigateway.LambdaIntegration(remixLambda, {
        proxy: true,
      })
    );

    // Root proxy resource for SSR (no auth required)
    // IMPORTANT: Define AFTER /v1 resource to ensure /v1/* routes are matched first
    const rootProxyResource = restApi.root.addResource('{proxy+}');
    rootProxyResource.addMethod(
      'ANY',
      new apigateway.LambdaIntegration(remixLambda, {
        proxy: true,
      }),
      {
        authorizationType: apigateway.AuthorizationType.NONE,
      }
    );

    // Root method for homepage (no auth required)
    restApi.root.addMethod(
      'ANY',
      new apigateway.LambdaIntegration(remixLambda, {
        proxy: true,
      }),
      {
        authorizationType: apigateway.AuthorizationType.NONE,
      }
    );

    // ========================================
    // API GATEWAY STREAMING WITH JWT AUTH
    // ========================================

    // Lambda authorizer for Cognito JWT validation
    const jwtAuthorizerLambda = new lambda.Function(this, 'JwtAuthorizerLambda', {
      functionName: `${stackPrefix}-jwt-authorizer`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('../frontend/build/lambda-authorizer'),
      timeout: Duration.seconds(10),
      memorySize: 128,
      architecture: lambda.Architecture.ARM_64,
      // The authorizer verifies every token against this user pool and app
      // client with aws-jwt-verify; without these it denies every caller.
      environment: {
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
      },
    });

    // Request authorizer using Cognito JWT
    const jwtAuthorizer = new apigateway.RequestAuthorizer(this, 'JwtRequestAuthorizer', {
      handler: jwtAuthorizerLambda,
      identitySources: [apigateway.IdentitySource.header('Authorization')],
      resultsCacheTtl: Duration.minutes(5),
    });

    // /api/* Remix resource routes (CloudFront forwards /api/chat as /api/chat;
    // the stage name is the origin path). These invoke the model, so they must
    // not fall through to the public SSR proxy above: everything under /api
    // runs the REQUEST authorizer by default, and only the two read-only
    // bootstrap routes the signed-out landing page needs are left open. The
    // chat / enhancer handlers also reject calls without a verified caller.
    const remixApiResource = restApi.root.addResource('api', {
      defaultMethodOptions: {
        authorizationType: apigateway.AuthorizationType.CUSTOM,
        authorizer: jwtAuthorizer,
      },
    });
    remixApiResource.addResource('{proxy+}').addMethod(
      'ANY',
      new apigateway.LambdaIntegration(remixLambda, { proxy: true }),
    );
    for (const publicRoute of ['config', 'metrics']) {
      remixApiResource.addResource(publicRoute).addMethod(
        'GET',
        new apigateway.LambdaIntegration(remixLambda, { proxy: true }),
        { authorizationType: apigateway.AuthorizationType.NONE },
      );
    }

    // Streaming resource with JWT auth
    const streamResource = restApi.root.addResource('stream');
    
    // Add POST method with streaming Lambda integration
    streamResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(streamingLambda, {
        proxy: true,
        responseTransferMode: apigateway.ResponseTransferMode.STREAM,
        timeout: Duration.minutes(5),
      }),
      {
        authorizer: jwtAuthorizer,
        authorizationType: apigateway.AuthorizationType.CUSTOM,
      }
    );

    // Store streaming endpoint URL in SSM
    new ssm.StringParameter(this, 'ApiGatewayStreamUrl', {
      parameterName: `/${stackPrefix}/api-gateway/stream-url`,
      stringValue: `${restApi.url}stream`,
      description: 'API Gateway streaming endpoint URL',
    });

    // Store REST API base URL in SSM (used by frontend session client)
    new ssm.StringParameter(this, 'ApiGatewayRestUrl', {
      parameterName: `/${stackPrefix}/api-gateway/rest-url`,
      stringValue: restApi.url,
      description: 'API Gateway REST API base URL',
    });

    // ========================================
    // CUSTOM DOMAIN - Optional
    // ========================================

    let hostedZone: route53.IHostedZone | undefined;
    let certificate: acm.ICertificate | undefined;

    if (config.customDomain) {
      // Import existing hosted zone
      hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
        domainName: config.customDomain,
      });

      // Create SSL certificate (must be in us-east-1 for CloudFront)
      certificate = new acm.DnsValidatedCertificate(this, 'Certificate', {
        domainName: config.customDomain,
        hostedZone: hostedZone,
        region: 'us-east-1', // Required for CloudFront
      });

      // DMARC record (recommended for email security)
      new route53.TxtRecord(this, 'DmarcRecord', {
        zone: hostedZone,
        recordName: '_dmarc',
        values: ['v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s;'],
        ttl: Duration.hours(1),
      });
    }

    // ========================================
    // CLOUDFRONT DISTRIBUTION
    // ========================================

    // CloudFront Origin Access Control (OAC) for S3 bucket
    const cloudfrontOac = new cloudfront.S3OriginAccessControl(this, 'CloudFrontOac', {
      signing: cloudfront.Signing.SIGV4_ALWAYS,
    });

    // Shared-sites S3 bucket (created before distribution to avoid circular dependency)
    const sharedSitesBucket = new SharedSitesBucket(this, 'SharedSites', {
      stackPrefix,
      kmsKey: encryptionKey,
    });

    // CloudFront Function: rewrite /shared/{id}/ → /shared/{id}/index.html
    const sharedSitesRewriteFn = new cloudfront.Function(this, 'SharedSitesRewriteFunction', {
      functionName: `${stackPrefix}-shared-sites-rewrite`,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.endsWith('/')) {
    request.uri += 'index.html';
  } else if (!uri.includes('.')) {
    request.uri += '/index.html';
  }
  return request;
}
      `),
    });

    // Set once the untrusted-content distribution exists (below); read lazily by
    // the app CSP so the app may frame previews and nothing else.
    let untrustedContent: UntrustedContent | undefined;

    // Response headers policy for security headers
    const securityHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeadersPolicy', {
      responseHeadersPolicyName: `${stackPrefix}-security-headers`,
      comment: 'Security headers for Vibe',
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.SAMEORIGIN, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.seconds(47304000),
          includeSubdomains: true,
          preload: true,
          override: true
        },
        contentSecurityPolicy: {
          contentSecurityPolicy: cdk.Lazy.string({
            produce: () => cdk.Fn.join('', [
              `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cognito-idp.${this.region}.amazonaws.com https://cognito-identity.${this.region}.amazonaws.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://*.amazonaws.com wss://*.amazonaws.com ws://*.amazonaws.com https://*.lambda-url.${this.region}.on.aws wss://*.preview.${config.customDomain || 'localhost'} ws://`,
              sandbox.alb.alb.loadBalancerDnsName,
              `:443 wss://`,
              sandbox.alb.alb.loadBalancerDnsName,
              `:443; frame-src `,
              untrustedContent!.frameSource,
              `; frame-ancestors 'self';`,
            ]),
          }),
          override: true
        },
      },
    });

    // CloudFront Distribution
    const distribution = new cloudfront.Distribution(this, 'BedrockVibeDistribution', {
      comment: `CloudFront distribution for ${stackPrefix} Remix App`,
      enableLogging: true,
      logBucket: edgeLogsBucket,
      logFilePrefix: 'cloudfront/main/',
      logIncludesCookies: false,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      // Custom domain configuration (if provided)
      ...(config.customDomain && certificate ? {
        domainNames: [config.customDomain],
        certificate: certificate,
      } : {}),
      // Default behavior: All page requests go to Lambda for SSR
      defaultBehavior: {
        origin: new origins.RestApiOrigin(restApi, {
          customHeaders: {
            'X-Origin-Verify': xOriginVerifySecret
              .secretValueFromJson('headerValue')
              .unsafeUnwrap(),
          },
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: securityHeadersPolicy,
        cachePolicy: new cloudfront.CachePolicy(this, 'SsrCachePolicy', {
          cachePolicyName: `${stackPrefix}-ssr-cache-policy`,
          defaultTtl: Duration.seconds(0),
          maxTtl: Duration.seconds(1),
          minTtl: Duration.seconds(0),
          headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
            'Authorization',
            'Content-Type',
            'Accept',
            'User-Agent'
          ),
          queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
          cookieBehavior: cloudfront.CacheCookieBehavior.all(),
        }),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
      additionalBehaviors: {
        // Static assets from S3 share the same cache/origin config, so build it once.
        ...((): Record<string, cloudfront.BehaviorOptions> => {
          const staticAssetBehavior: cloudfront.BehaviorOptions = {
            origin: origins.S3BucketOrigin.withOriginAccessControl(staticAssetsBucket, {
              originAccessControl: cloudfrontOac,
            }),
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          };
          // /assets/* = JS/CSS/images built by Vite; *.svg/png/jpg/ico = root-level static files (favicon, etc.)
          return {
            '/assets/*': staticAssetBehavior,
            '*.svg': staticAssetBehavior,
            '*.png': staticAssetBehavior,
            '*.jpg': staticAssetBehavior,
            '*.ico': staticAssetBehavior,
          };
        })(),
        // aws-exports.json from S3
        '/aws-exports.json': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(staticAssetsBucket, {
            originAccessControl: cloudfrontOac,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: new cloudfront.CachePolicy(this, 'AwsExportsCachePolicy', {
            cachePolicyName: `${stackPrefix}-aws-exports-cache-policy`,
            defaultTtl: Duration.minutes(5),
            maxTtl: Duration.minutes(10),
            minTtl: Duration.seconds(0),
          }),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        },
        // API calls go to API Gateway
        '/api/*': {
          origin: new origins.RestApiOrigin(restApi, {
            customHeaders: {
              'X-Origin-Verify': xOriginVerifySecret
                .secretValueFromJson('headerValue')
                .unsafeUnwrap(),
            },
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: new cloudfront.CachePolicy(this, 'ApiCachePolicy', {
            cachePolicyName: `${stackPrefix}-api-cache-policy`,
            defaultTtl: Duration.seconds(0),
            maxTtl: Duration.seconds(1),
            minTtl: Duration.seconds(0),
            headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
              'Authorization',
              'Content-Type',
              'Accept'
            ),
            queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
            cookieBehavior: cloudfront.CacheCookieBehavior.all(),
          }),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          // CloudFront Function to strip /api prefix before forwarding to API Gateway
          // This is needed because RestApiOrigin adds the stage name (/api) as origin path,
          // so /api/v1/... would become /api/api/v1/... without this rewrite
          // Only strip /api for /api/v1/* paths (authenticated API calls)
          // Other /api/* paths (like /api/config, /api/chat) should keep the /api prefix
          functionAssociations: [{
            function: new cloudfront.Function(this, 'ApiPathRewriteFunction', {
              functionName: `${stackPrefix}-api-path-rewrite`,
              code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  // Only strip /api prefix for /api/v1/* paths (authenticated API calls to API Gateway)
  // Other /api/* paths (like /api/config, /api/chat) go to Remix Lambda and need the full path
  if (request.uri.startsWith('/api/v1/')) {
    request.uri = request.uri.substring(4); // Remove /api, keep /v1/...
  }
  return request;
}
              `),
            }),
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          }],
        },
        // Shared sites are NOT served here: see the legacy redirect behaviors
        // added after the untrusted-content distribution below.
      },
    });

    // Grant CloudFront access to the S3 bucket using OAC
    staticAssetsBucket.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [staticAssetsBucket.arnForObjects('*')],
      principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
      conditions: {
        StringEquals: {
          'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
        },
      }
    }));

    // Bucket CORS for browser uploads via presigned URLs.
    //
    // Using `allowedOrigins: ['*']` is the standard pattern for buckets that
    // only serve presigned-URL traffic and never raw public access. Binding
    // this to `distribution.distributionDomainName` would create a circular
    // dependency: the CloudFront distribution already depends (transitively)
    // on this bucket via the shared `lambdaRole` → `grantReadWrite` chain,
    // so referencing the distribution here would close the cycle.
    //
    // Why this is safe:
    //   - `BlockPublicAccess.BLOCK_ALL` blocks anonymous access at the bucket
    //     layer; no object is reachable without a valid presigned URL.
    //   - Presigned URLs are minted server-side by the brand-templates Lambda
    //     after Cognito authorization and are scoped to
    //     `uploads/{userId}/{jobId}/*`, 1 h expiry.
    //   - CORS governs the browser; server-side authz is unaffected.
    styleExtractionBucket.addCorsRule({
      allowedMethods: [
        s3.HttpMethods.PUT,
        s3.HttpMethods.POST,
        s3.HttpMethods.GET,
        s3.HttpMethods.HEAD,
      ],
      allowedOrigins: ['*'],
      allowedHeaders: ['*'],
      exposedHeaders: ['ETag'],
      maxAge: 3000,
    });

    // ========================================
    // DNS RECORDS (for custom domain)
    // ========================================

    if (config.customDomain && hostedZone) {
      // A Record (IPv4)
      new route53.ARecord(this, 'ARecord', {
        zone: hostedZone,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.CloudFrontTarget(distribution)
        ),
      });

      // AAAA Record (IPv6)
      new route53.AaaaRecord(this, 'AaaaRecord', {
        zone: hostedZone,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.CloudFrontTarget(distribution)
        ),
      });
    }

    // ========================================
    // AWS EXPORTS
    // ========================================

    // Create aws-exports.json asset
    const exportsAsset = s3Deployment.Source.jsonData('aws-exports.json', {
      region: config.region,
      Auth: {
        Cognito: {
          userPoolClientId: userPoolClient.userPoolClientId,
          userPoolId: userPool.userPoolId,
          identityPoolId: identityPool.identityPoolId,
        },
      },
      API: {
        REST: {
          RestApi: {
            endpoint: `https://${distribution.distributionDomainName}/api/v1`,
          },
        },
        STREAMING: {
          FunctionUrl: {
            endpoint: streamingFunctionUrl.url,
          },
        },
      },
    });

    // Deploy static assets and aws-exports.json to S3 bucket.
    // Invalidate both the static asset paths AND the root/SSR HTML so the
    // browser always picks up a fresh bundle after a redeploy. Without this,
    // CloudFront keeps serving the old HTML that references stale JS hashes
    // and manual `aws cloudfront create-invalidation` is required.
    //
    // memoryLimit: the default 128 MB gave us flaky S3 PutObject RequestTimeout
    // failures during deploys because Shiki splits into ~1000 tiny language
    // files and Lambda network bandwidth scales with memory. 1024 MB gives the
    // sync process enough headroom to finish all parallel PUTs reliably.
    // useEfs + ephemeralStorageSize stay at defaults; the ~16 MiB payload
    // fits comfortably in /tmp.
    new s3Deployment.BucketDeployment(this, 'DeployStaticAssets', {
      sources: [
        s3Deployment.Source.asset('../frontend/build/client'),
        exportsAsset,
      ],
      destinationBucket: staticAssetsBucket,
      distribution: distribution,
      distributionPaths: ['/*'],
      memoryLimit: 1024,
    });

    // ========================================
    // Platform Metrics Cache Lambda
    // ========================================
    const metricsLambda = new lambdaNodejs.NodejsFunction(this, 'MetricsCacheLambda', {
      functionName: `${stackPrefix}-metrics-cache`,
      entry: '../frontend/metrics-lambda/index.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        STACK_PREFIX: stackPrefix,
      },
    });

    // Grant permissions to read CloudWatch metrics and write SSM parameters
    metricsLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudwatch:GetMetricStatistics',
        'cloudwatch:ListMetrics',
      ],
      resources: ['*'],
    }));

    metricsLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:PutParameter',
        'ssm:GetParameter',
        'ssm:GetParametersByPath',
      ],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${stackPrefix}/metrics/*`],
    }));

    // EventBridge rule to trigger every 5 minutes
    const metricsRule = new events.Rule(this, 'MetricsCacheRule', {
      ruleName: `${stackPrefix}-metrics-cache-schedule`,
      schedule: events.Schedule.rate(Duration.minutes(5)),
    });
    metricsRule.addTarget(new targets.LambdaFunction(metricsLambda));

    // ========================================
    // CLOUDWATCH ALARMS FOR LAMBDA MONITORING
    // ========================================

    // Remix Lambda Error Alarm
    new cloudwatch.Alarm(this, 'RemixLambdaErrorAlarm', {
      alarmName: `${stackPrefix}-remix-lambda-errors`,
      alarmDescription: 'Alarm when Remix Lambda function has errors',
      metric: remixLambda.metricErrors({
        period: Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Remix Lambda Duration Alarm (80% of timeout)
    new cloudwatch.Alarm(this, 'RemixLambdaDurationAlarm', {
      alarmName: `${stackPrefix}-remix-lambda-duration`,
      alarmDescription: 'Alarm when Remix Lambda function duration is high',
      metric: remixLambda.metricDuration({
        period: Duration.minutes(5),
      }),
      threshold: Duration.minutes(12).toMilliseconds(), // 80% of 15-minute timeout
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Remix Lambda Throttle Alarm
    new cloudwatch.Alarm(this, 'RemixLambdaThrottleAlarm', {
      alarmName: `${stackPrefix}-remix-lambda-throttles`,
      alarmDescription: 'Alarm when Remix Lambda function is throttled',
      metric: remixLambda.metricThrottles({
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Streaming Lambda Error Alarm
    new cloudwatch.Alarm(this, 'StreamingLambdaErrorAlarm', {
      alarmName: `${stackPrefix}-streaming-lambda-errors`,
      alarmDescription: 'Alarm when Streaming Lambda function has errors',
      metric: streamingLambda.metricErrors({
        period: Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Streaming Lambda Duration Alarm (80% of timeout)
    new cloudwatch.Alarm(this, 'StreamingLambdaDurationAlarm', {
      alarmName: `${stackPrefix}-streaming-lambda-duration`,
      alarmDescription: 'Alarm when Streaming Lambda function duration is high',
      metric: streamingLambda.metricDuration({
        period: Duration.minutes(5),
      }),
      threshold: Duration.minutes(4).toMilliseconds(), // 80% of 5-minute timeout
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Streaming Lambda Throttle Alarm
    new cloudwatch.Alarm(this, 'StreamingLambdaThrottleAlarm', {
      alarmName: `${stackPrefix}-streaming-lambda-throttles`,
      alarmDescription: 'Alarm when Streaming Lambda function is throttled',
      metric: streamingLambda.metricThrottles({
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // CloudTrail for API auditing
    const cloudTrailBucket = new s3.Bucket(this, 'CloudTrailBucket', {
      bucketName: `${stackPrefix}-cloudtrail-logs-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const trail = new cloudtrail.Trail(this, 'BedrockVibeTrail', {
      trailName: `${stackPrefix}-trail`,
      bucket: cloudTrailBucket,
      isMultiRegionTrail: false,
      includeGlobalServiceEvents: true,
      sendToCloudWatchLogs: true,
      cloudWatchLogsRetention: logs.RetentionDays.ONE_YEAR,
    });

    // CloudTrail-based security detections
    const cloudTrailLogGroup = trail.logGroup!;

    // Detection: IAM policy changes (privilege escalation)
    const iamChangesFilter = new logs.MetricFilter(this, 'IAMChangesFilter', {
      logGroup: cloudTrailLogGroup,
      metricNamespace: `${stackPrefix}/Security`,
      metricName: 'IAMPolicyChanges',
      filterPattern: logs.FilterPattern.literal('{ ($.eventName = AttachRolePolicy) || ($.eventName = AttachUserPolicy) || ($.eventName = CreateAccessKey) || ($.eventName = CreateUser) || ($.eventName = CreateRole) || ($.eventName = PutRolePolicy) }'),
      metricValue: '1',
    });

    new cloudwatch.Alarm(this, 'IAMChangesAlarm', {
      alarmName: `${stackPrefix}-iam-changes`,
      alarmDescription: 'Detects IAM policy changes that could indicate privilege escalation',
      metric: iamChangesFilter.metric({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Detection: CloudTrail tampering (defense evasion)
    const cloudTrailTamperFilter = new logs.MetricFilter(this, 'CloudTrailTamperFilter', {
      logGroup: cloudTrailLogGroup,
      metricNamespace: `${stackPrefix}/Security`,
      metricName: 'CloudTrailTampering',
      filterPattern: logs.FilterPattern.literal('{ ($.eventName = StopLogging) || ($.eventName = DeleteTrail) || ($.eventName = UpdateTrail) || ($.eventName = PutEventSelectors) }'),
      metricValue: '1',
    });

    new cloudwatch.Alarm(this, 'CloudTrailTamperAlarm', {
      alarmName: `${stackPrefix}-cloudtrail-tamper`,
      alarmDescription: 'Detects attempts to disable or modify CloudTrail logging',
      metric: cloudTrailTamperFilter.metric({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Detection: Root account usage
    const rootUsageFilter = new logs.MetricFilter(this, 'RootUsageFilter', {
      logGroup: cloudTrailLogGroup,
      metricNamespace: `${stackPrefix}/Security`,
      metricName: 'RootAccountUsage',
      filterPattern: logs.FilterPattern.literal('{ $.userIdentity.type = "Root" && $.userIdentity.invokedBy NOT EXISTS && $.eventType != "AwsServiceEvent" }'),
      metricValue: '1',
    });

    new cloudwatch.Alarm(this, 'RootUsageAlarm', {
      alarmName: `${stackPrefix}-root-usage`,
      alarmDescription: 'Detects root account usage',
      metric: rootUsageFilter.metric({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // CloudWatch alarm for failed authentication attempts
    new cloudwatch.Alarm(this, 'FailedAuthenticationAlarm', {
      alarmName: `${stackPrefix}-failed-authentication`,
      alarmDescription: 'Alarm for failed authentication attempts',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Cognito',
        metricName: 'SignInSuccesses',
        dimensionsMap: {
          'UserPool': userPool.userPoolId,
        },
        period: Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 0,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });


    // ========================================
    // CLOUDWATCH SYNTHETICS CANARY
    // ========================================

    // Canary S3 bucket for artifacts
    const canaryBucket = new s3.Bucket(this, 'CanaryArtifactsBucket', {
      bucketName: `${stackPrefix}-canary-artifacts-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Canary execution role
    const canaryRole = new iam.Role(this, 'CanaryRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchSyntheticsFullAccess'),
      ],
    });
    canaryBucket.grantReadWrite(canaryRole);

    // Determine canary URL
    const canaryUrl = config.customDomain 
      ? `https://${config.customDomain}` 
      : `https://${distribution.distributionDomainName}`;

    // Availability canary - checks app is accessible
    new cdk.CfnResource(this, 'AvailabilityCanary', {
      type: 'AWS::Synthetics::Canary',
      properties: {
        Name: `${stackPrefix}-avail`.substring(0, 21), // Max 21 chars
        RuntimeVersion: 'syn-nodejs-puppeteer-13.1',
        ArtifactS3Location: `s3://${canaryBucket.bucketName}`,
        ExecutionRoleArn: canaryRole.roleArn,
        Schedule: {
          Expression: 'rate(5 minutes)',
        },
        StartCanaryAfterCreation: true,
        Code: {
          Handler: 'index.handler',
          Script: `
const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');
const https = require('https');

function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => reject(new Error('Timeout')));
    if (options.body) req.write(options.body);
    req.end();
  });
}

exports.handler = async () => {
  const url = '${canaryUrl}';
  const errors = [];

  // 1. Availability: page loads with 200
  log.info('Check: availability');
  const page = await synthetics.getPage();
  const pageResponse = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (pageResponse.status() !== 200) errors.push('Availability: got ' + pageResponse.status());

  // 2. Security headers present
  log.info('Check: security headers');
  const headersResponse = await httpsRequest(url, { method: 'GET' });
  const h = headersResponse.headers;
  if (!h['strict-transport-security']) errors.push('Missing Strict-Transport-Security');
  if (h['x-content-type-options'] !== 'nosniff') errors.push('Missing X-Content-Type-Options: nosniff');
  if (h['x-frame-options'] !== 'SAMEORIGIN') errors.push('Missing X-Frame-Options: SAMEORIGIN');

  // 3. Unauthenticated API access denied
  log.info('Check: unauth /api/chat rejected');
  const chatResponse = await httpsRequest(url + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'canary-test' }),
  });
  if (chatResponse.statusCode === 200) errors.push('/api/chat allowed unauthenticated access');

  log.info('Check: unauth /v1/health rejected');
  const v1Response = await httpsRequest(url + '/v1/health', { method: 'GET' });
  if (v1Response.statusCode === 200) errors.push('/v1/health allowed unauthenticated access');

  // 4. Invalid token rejected
  log.info('Check: invalid token rejected');
  const invalidTokenResponse = await httpsRequest(url + '/v1/health', {
    method: 'GET',
    headers: { 'Authorization': 'Bearer invalid-token' },
  });
  if (invalidTokenResponse.statusCode === 200) errors.push('/v1/health accepted invalid token');

  if (errors.length > 0) throw new Error('Security canary failures: ' + errors.join('; '));
  log.info('All checks passed');
};
          `,
        },
        SuccessRetentionPeriod: 7,
        FailureRetentionPeriod: 14,
      },
    });

    // Canary failure alarm
    new cloudwatch.Alarm(this, 'CanaryFailureAlarm', {
      alarmName: `${stackPrefix}-canary-failure`,
      alarmDescription: 'Alarm when availability canary fails',
      metric: new cloudwatch.Metric({
        namespace: 'CloudWatchSynthetics',
        metricName: 'SuccessPercent',
        dimensionsMap: {
          CanaryName: `${stackPrefix}-avail`.substring(0, 21),
        },
        period: Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold: 100,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ========================================
    // ANALYTICS DASHBOARD
    // ========================================

    const analyticsNamespace = 'BedrockVibe';

    const dashboard = new cloudwatch.Dashboard(this, 'AnalyticsDashboard', {
      dashboardName: `${stackPrefix}-analytics`,
    });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Unique Users (Daily)',
        left: [new cloudwatch.MathExpression({
          expression: `SEARCH('{${analyticsNamespace},UserId} MetricName="UserLogin"', 'Sum', 86400)`,
          label: 'Users',
        })],
        width: 12,
        period: Duration.days(1),
      }),
      new cloudwatch.GraphWidget({
        title: 'Chat Requests',
        left: [new cloudwatch.Metric({
          namespace: analyticsNamespace,
          metricName: 'ChatRequest',
          statistic: 'Sum',
          period: Duration.hours(1),
        })],
        width: 12,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Websites Created',
        left: [new cloudwatch.Metric({
          namespace: analyticsNamespace,
          metricName: 'WebsiteCreated',
          statistic: 'Sum',
          period: Duration.hours(1),
        })],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Token Usage',
        left: [
          new cloudwatch.Metric({
            namespace: analyticsNamespace,
            metricName: 'InputTokens',
            statistic: 'Sum',
            period: Duration.hours(1),
            label: 'Input Tokens',
          }),
          new cloudwatch.Metric({
            namespace: analyticsNamespace,
            metricName: 'OutputTokens',
            statistic: 'Sum',
            period: Duration.hours(1),
            label: 'Output Tokens',
          }),
        ],
        width: 12,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: 'Total Chat Requests (24h)',
        metrics: [new cloudwatch.Metric({
          namespace: analyticsNamespace,
          metricName: 'ChatRequest',
          statistic: 'Sum',
          period: Duration.days(1),
        })],
        width: 8,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Total Websites Created (24h)',
        metrics: [new cloudwatch.Metric({
          namespace: analyticsNamespace,
          metricName: 'WebsiteCreated',
          statistic: 'Sum',
          period: Duration.days(1),
        })],
        width: 8,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Total Tokens (24h)',
        metrics: [new cloudwatch.Metric({
          namespace: analyticsNamespace,
          metricName: 'OutputTokens',
          statistic: 'Sum',
          period: Duration.days(1),
        })],
        width: 8,
      }),
    );

    // ========================================
    // SANDBOX CONTAINER INFRASTRUCTURE
    // ========================================

    const sandbox = new SandboxInfrastructure(this, 'Sandbox', {
      stackPrefix,
      kmsKey: encryptionKey,
      logsBucket: edgeLogsBucket,
      warmPoolSize: 5,   // Min tasks always warm (instant response for first users)
      maxCapacity: 50,   // Max concurrent users (auto-scales based on demand)
      alarmEmail: config.alarmEmail,
      originVerifyHeaderValue,
      // TLS on the CloudFront → ALB hop needs a hostname we own; without a
      // custom domain the hop stays HTTP (SandboxAlb emits a synth warning).
      ...(config.customDomain && hostedZone
        ? { originTls: { hostedZone, domainName: config.customDomain } }
        : {}),
    });

    // Every CloudFront origin for the sandbox ALB uses the certificate's hostname
    // and HTTPS when the ALB has a certificate. CloudFront checks the certificate
    // against the origin domain, so the ALB's own DNS name can't be used.
    const sandboxOriginProps: origins.HttpOriginProps = sandbox.originUsesTls
      ? {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          httpsPort: 443,
          originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
          customHeaders: { [ORIGIN_VERIFY_HEADER]: originVerifyHeaderValue },
        }
      : {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          httpPort: 443,
          customHeaders: { [ORIGIN_VERIFY_HEADER]: originVerifyHeaderValue },
        };

    // ALB origin shared by WebSocket and preview behaviors
    const albOrigin = new origins.HttpOrigin(sandbox.originDomainName, sandboxOriginProps);

    // CloudFront Function: extract sessionId from the request path and set the
    // X-Sandbox-Session header for ALB listener rule matching.
    //
    // Covers both /sandbox-preview/{sessionId}/... and /ws/{sessionId}: the WS
    // path needs it so a session's traffic can be routed to the one container
    // serving it. Without that, /ws/* only has per-browser cookie stickiness, so a
    // second collaborator opening the same session lands on an arbitrary container.
    //
    // URI is NOT modified — Vite's base is /sandbox-preview/{sessionId}/ so it
    // expects the full path including the prefix and session ID.
    const previewRewriteFn = new cloudfront.Function(this, 'PreviewRewriteFunction', {
      functionName: `${stackPrefix}-preview-rewrite`,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var match = request.uri.match(/^\\/sandbox-preview\\/([^\\/]+)(\\/.*)?$/)
    || request.uri.match(/^\\/ws\\/([^\\/?#]+)/);
  if (match) {
    request.headers['x-sandbox-session'] = { value: match[1] };
  }
  return request;
}
      `),
    });

    // Untrusted content (live previews, shared sites) on its own distribution and
    // hostnames, never on the app's origin. See lib/untrusted-content.
    const untrustedParentDomain = config.previewDomain
      ?? (config.customDomain ? `preview.${config.customDomain}` : undefined);
    const untrustedZone = config.previewDomain
      ? route53.HostedZone.fromLookup(this, 'PreviewHostedZone', { domainName: config.previewDomain })
      : hostedZone;

    untrustedContent = createUntrustedContent(this, {
      stackPrefix,
      albOrigin,
      logBucket: edgeLogsBucket,
      previewRequestFunction: previewRewriteFn,
      sharedSitesBucket: sharedSitesBucket.bucket,
      sharedSitesRewriteFunction: sharedSitesRewriteFn,
      originAccessControl: cloudfrontOac,
      appOrigin: config.customDomain ? `https://${config.customDomain}` : undefined,
      domain: untrustedParentDomain && untrustedZone
        ? { parentDomain: untrustedParentDomain, hostedZone: untrustedZone }
        : undefined,
    });

    // The app origin used to serve /sandbox-preview/* and /shared/* itself. Those
    // paths now only redirect to the untrusted host; the function answers every
    // request, so the (trusted) static-assets origin below is never contacted.
    const legacyUntrustedRedirectFn = new cloudfront.Function(this, 'LegacyUntrustedRedirectFunction', {
      functionName: `${stackPrefix}-legacy-untrusted-redirect`,
      code: cloudfront.FunctionCode.fromInline(legacyRedirectFunctionCode({
        previewHostTemplate: untrustedContent.previewHostTemplate,
        sharedSitesHost: untrustedContent.sharedSitesHost,
      })),
    });
    const legacyRedirectBehavior: cloudfront.BehaviorOptions = {
      origin: origins.S3BucketOrigin.withOriginAccessControl(staticAssetsBucket, {
        originAccessControl: cloudfrontOac,
      }),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      functionAssociations: [{
        function: legacyUntrustedRedirectFn,
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
      }],
    };
    distribution.addBehavior('/shared/*', legacyRedirectBehavior.origin, legacyRedirectBehavior);
    distribution.addBehavior('/sandbox-preview*', legacyRedirectBehavior.origin, legacyRedirectBehavior);

    // Add /ws/* behavior to the main CloudFront distribution → ALB for WebSocket.
    //
    // Restricted to signed URLs from the trusted key group: CloudFront refuses
    // any upgrade without a valid, unexpired signature for this session's path,
    // so the request never reaches the load balancer or the container.
    distribution.addBehavior('/ws/*', albOrigin, {
      trustedKeyGroups: [wsKeyGroup],
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      functionAssociations: [{
        function: previewRewriteFn,
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
      }],
    });

    // Session Manager Lambda for sandbox lifecycle (bundled from TypeScript)
    const sessionManagerLambda = new lambdaNodejs.NodejsFunction(this, 'SessionManagerLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: 'lib/sandbox/session-manager-lambda/index.ts',
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(30),
      bundling: {
        minify: true,
        sourceMap: true,
        // The Node 20 runtime ships some SDK v3 clients but not all of them, and
        // Secrets Manager (used to fetch the URL signing key) is not guaranteed
        // to be present — bundle it rather than fail at runtime.
        externalModules: [
          '@aws-sdk/client-dynamodb',
          '@aws-sdk/client-ecs',
          '@aws-sdk/client-cloudwatch',
          '@aws-sdk/client-ssm',
          '@aws-sdk/util-dynamodb',
          '@aws-sdk/client-elastic-load-balancing-v2',
        ],
      },
      environment: {
        SESSIONS_TABLE_NAME: sandbox.sessions.table.tableName,
        ECS_CLUSTER_ARN: sandbox.cluster.cluster.clusterArn,
        ECS_SERVICE_NAME: sandbox.cluster.service.serviceName,
        PREVIEW_DOMAIN: config.customDomain ? `preview.${config.customDomain}` : 'preview.localhost',
        // Where the client loads a session's live preview: the untrusted origin.
        PREVIEW_URL_TEMPLATE: untrustedContent.previewUrlTemplate,
        CLOUDFRONT_DOMAIN_PARAM: `/${stackPrefix}/cloudfront/domain-name`,
        METRIC_NAMESPACE: `${stackPrefix}/Sandbox`,
        // Needed to pin a session's WebSocket traffic to the container serving
        // it, so every collaborator on a shared session reaches the same one.
        SANDBOX_ALB_LISTENER_ARN: sandbox.alb.httpsListener.listenerArn,
        SANDBOX_VPC_ID: sandbox.vpc.vpc.vpcId,
        STACK_PREFIX: stackPrefix,
        // Only the ARN — the key itself is fetched at runtime so it never appears
        // in the template or the function's visible configuration.
        WS_SIGNING_KEY_SECRET_ARN: wsSigningKeySecret.secretArn,
        WS_SIGNING_KEY_PAIR_ID: wsPublicKey.publicKeyId,
        // Per-session ALB rules must require the same origin-verify header as
        // the static ones.
        X_ORIGIN_VERIFY_SECRET_ARN: xOriginVerifySecret.secretArn,
      },
    });

    // The session manager is the only issuer of WebSocket signed URLs.
    wsSigningKeySecret.grantRead(sessionManagerLambda);
    xOriginVerifySecret.grantRead(sessionManagerLambda);

    // Grant permissions
    sandbox.sessions.table.grantReadWriteData(sessionManagerLambda);
    // The session manager reads and stops tasks; it never changes the service,
    // so it has no ecs:UpdateService.
    sessionManagerLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ecs:ListTasks',
        'ecs:DescribeTasks',
        'ecs:StopTask',
      ],
      resources: ['*'],
      conditions: {
        ArnLike: {
          'ecs:cluster': sandbox.cluster.cluster.clusterArn,
        },
      },
    }));
    // Assign a claimed task to its session (the sidecar serves only the session
    // in this tag). Limited to this cluster's tasks and to that one tag key.
    sessionManagerLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:TagResource'],
      resources: [`arn:aws:ecs:${this.region}:${this.account}:task/${sandbox.cluster.cluster.clusterName}/*`],
      conditions: {
        'ForAllValues:StringEquals': { 'aws:TagKeys': ['SandboxSession'] },
      },
    }));
    // SSM read for CloudFront domain (using name pattern to avoid circular dependency)
    sessionManagerLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${stackPrefix}/cloudfront/*`],
    }));
    // CloudWatch metrics for auto-scaling
    sessionManagerLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: {
        StringEquals: { 'cloudwatch:namespace': `${stackPrefix}/Sandbox` },
      },
    }));
    // Per-session WebSocket routing: the Lambda creates a target group holding
    // the session's container plus a listener rule that steers the session there,
    // and removes both when the session ends.
    //
    // CreateTargetGroup and the Describe* calls do not support resource-level
    // permissions, so they are necessarily '*'. The mutating calls that do
    // support it are scoped to this ALB's listener and to target groups created
    // for it.
    sessionManagerLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'elasticloadbalancing:CreateTargetGroup',
        'elasticloadbalancing:DescribeTargetGroups',
        'elasticloadbalancing:DescribeRules',
        'elasticloadbalancing:DescribeTargetHealth',
        // Orphan reconciliation only deletes target groups tagged ManagedBy this stack.
        'elasticloadbalancing:DescribeTags',
      ],
      resources: ['*'],
    }));
    sessionManagerLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'elasticloadbalancing:CreateRule',
        'elasticloadbalancing:DeleteRule',
        'elasticloadbalancing:ModifyRule',
        // CreateRule passes tags, which ELBv2 authorises separately against the
        // rule being created — without this the call fails with AccessDenied.
        'elasticloadbalancing:AddTags',
      ],
      resources: [
        sandbox.alb.httpsListener.listenerArn,
        `arn:aws:elasticloadbalancing:${this.region}:${this.account}:listener-rule/app/${sandbox.alb.alb.loadBalancerName}/*`,
      ],
    }));
    sessionManagerLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'elasticloadbalancing:RegisterTargets',
        'elasticloadbalancing:DeregisterTargets',
        'elasticloadbalancing:DeleteTargetGroup',
        'elasticloadbalancing:AddTags',
      ],
      resources: [
        `arn:aws:elasticloadbalancing:${this.region}:${this.account}:targetgroup/sbx-s-*/*`,
      ],
    }));
    // EventBridge rule to trigger session cleanup every 5 minutes
    new events.Rule(this, 'SessionCleanupRule', {
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(sessionManagerLambda)],
      description: 'Triggers session cleanup to stop idle sandbox containers',
    });

    // Session Manager API via API Gateway
    const sessionResource = restApi.root.addResource('session');
    // `join` is a sibling of `{id}`, not a child: a joiner redeems an invite
    // token without knowing the session id, so the token identifies the session.
    // API Gateway prefers the literal path segment over the `{id}` variable.
    const joinResource = sessionResource.addResource('join');
    const sessionIdResource = sessionResource.addResource('{id}');
    const heartbeatResource = sessionIdResource.addResource('heartbeat');
    const inviteResource = sessionIdResource.addResource('invite');

    const sessionLambdaIntegration = new apigateway.LambdaIntegration(sessionManagerLambda);
    const sessionAuthOptions = {
      authorizer: jwtAuthorizer,
      authorizationType: apigateway.AuthorizationType.CUSTOM,
    };
    const createSessionMethod = sessionResource.addMethod('POST', sessionLambdaIntegration, sessionAuthOptions);
    sessionIdResource.addMethod('GET', sessionLambdaIntegration, sessionAuthOptions);
    sessionIdResource.addMethod('DELETE', sessionLambdaIntegration, sessionAuthOptions);
    heartbeatResource.addMethod('POST', sessionLambdaIntegration, sessionAuthOptions);
    // Both collaboration routes stay behind the same authorizer: an invite widens
    // access for an authenticated user, it never creates anonymous access.
    inviteResource.addMethod('POST', sessionLambdaIntegration, sessionAuthOptions);
    // Revoking a link is what replaced its expiry, so it ships alongside minting
    // one rather than as a later addition.
    inviteResource.addMethod('DELETE', sessionLambdaIntegration, sessionAuthOptions);
    joinResource.addMethod('POST', sessionLambdaIntegration, sessionAuthOptions);
    // No /session/{id}/bind: routing derives only from the task the session
    // manager assigned, never from an address a client reports.

    // Throttle session creation to prevent warm pool exhaustion
    restApi.addUsagePlan('SessionCreationThrottle', {
      name: `${stackPrefix}-session-creation-throttle`,
      description: 'Rate-limits sandbox session creation',
      throttle: {
        rateLimit: 50,
        burstLimit: 100,
      },
      apiStages: [{
        api: restApi,
        stage: restApi.deploymentStage,
        throttle: [{
          method: createSessionMethod,
          throttle: {
            rateLimit: 5,
            burstLimit: 10,
          },
        }],
      }],
    });

    // ========================================
    // SHARED SITES (static snapshot sharing)
    // ========================================

    const sharedSitesTable = new SharedSitesTable(this, 'SharedSitesTable', {
      stackPrefix,
      kmsKey: encryptionKey,
    });

    const shareLambda = new lambdaNodejs.NodejsFunction(this, 'ShareLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: 'lib/shared-sites/share-lambda/index.ts',
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(30),
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        SHARES_TABLE_NAME: sharedSitesTable.table.tableName,
        SHARED_SITES_BUCKET: sharedSitesBucket.bucket.bucketName,
        // Share links are minted on the untrusted origin, never the app's.
        SHARED_SITES_DOMAIN: untrustedContent.sharedSitesOrigin,
        CLOUDFRONT_DOMAIN_PARAM: `/${stackPrefix}/cloudfront/domain-name`,
      },
    });

    sharedSitesTable.table.grantReadWriteData(shareLambda);
    sharedSitesBucket.bucket.grantReadWrite(shareLambda);
    shareLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${stackPrefix}/cloudfront/*`],
    }));

    const shareResource = restApi.root.addResource('share');
    const shareIdResource = shareResource.addResource('{id}');
    const shareLambdaIntegration = new apigateway.LambdaIntegration(shareLambda);
    const shareAuthOptions = {
      authorizer: jwtAuthorizer,
      authorizationType: apigateway.AuthorizationType.CUSTOM,
    };
    shareResource.addMethod('POST', shareLambdaIntegration, shareAuthOptions);
    shareResource.addMethod('GET', shareLambdaIntegration, shareAuthOptions);
    shareIdResource.addMethod('DELETE', shareLambdaIntegration, shareAuthOptions);

    // ========================================
    // PROJECTS (durable chat history)
    // ========================================

    const projectsTable = new ProjectsTable(this, 'ProjectsTable', {
      stackPrefix,
      kmsKey: encryptionKey,
    });

    const projectsLambda = new lambdaNodejs.NodejsFunction(this, 'ProjectsLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: 'lib/projects/projects-lambda/index.ts',
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(30),
      bundling: {
        minify: true,
        sourceMap: true,
        // Listed individually rather than as '@aws-sdk/*': the Node 20 runtime
        // ships some SDK v3 clients but not all of them, so anything not named
        // here is bundled rather than assumed present.
        externalModules: [
          '@aws-sdk/client-dynamodb',
          '@aws-sdk/client-ssm',
          '@aws-sdk/util-dynamodb',
        ],
      },
      environment: {
        PROJECTS_TABLE_NAME: projectsTable.table.tableName,
        CLOUDFRONT_DOMAIN_PARAM: `/${stackPrefix}/cloudfront/domain-name`,
      },
    });

    projectsTable.table.grantReadWriteData(projectsLambda);
    projectsLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${stackPrefix}/cloudfront/*`],
    }));

    // Redeeming an invite grants the inviter's project as well as their sandbox, so
    // the session manager writes the membership item, and revoking the invite
    // deletes it. It also reads the project's META item, because an invite may only
    // carry a project its minter owns. Granted here rather than at its declaration
    // because the table is defined further down.
    sessionManagerLambda.addEnvironment('PROJECTS_TABLE_NAME', projectsTable.table.tableName);
    projectsTable.table.grantReadWriteData(sessionManagerLambda);

    const projectsResource = restApi.root.addResource('projects');
    const projectIdResource = projectsResource.addResource('{id}');
    const projectMessagesResource = projectIdResource.addResource('messages');
    // Granting access to a project's conversation, so someone invited into a live
    // session can read the history behind the files they are editing.
    const projectMembersResource = projectIdResource.addResource('members');
    // Membership no longer expires, so it has to be listable and revocable. The
    // path variable also carries the literal `me`, which is how a collaborator
    // leaves a project they were invited into.
    const projectMemberIdResource = projectMembersResource.addResource('{memberId}');
    const projectsLambdaIntegration = new apigateway.LambdaIntegration(projectsLambda);
    // Chat history is per-user data, so every route sits behind the same
    // authorizer — there is no anonymous read of someone's conversation.
    const projectsAuthOptions = {
      authorizer: jwtAuthorizer,
      authorizationType: apigateway.AuthorizationType.CUSTOM,
    };
    projectsResource.addMethod('GET', projectsLambdaIntegration, projectsAuthOptions);
    projectsResource.addMethod('POST', projectsLambdaIntegration, projectsAuthOptions);
    projectIdResource.addMethod('GET', projectsLambdaIntegration, projectsAuthOptions);
    projectIdResource.addMethod('PATCH', projectsLambdaIntegration, projectsAuthOptions);
    projectIdResource.addMethod('DELETE', projectsLambdaIntegration, projectsAuthOptions);
    projectMessagesResource.addMethod('POST', projectsLambdaIntegration, projectsAuthOptions);
    projectMembersResource.addMethod('POST', projectsLambdaIntegration, projectsAuthOptions);
    projectMembersResource.addMethod('GET', projectsLambdaIntegration, projectsAuthOptions);
    projectMemberIdResource.addMethod('DELETE', projectsLambdaIntegration, projectsAuthOptions);

    // ========================================
    // OUTPUTS
    // ========================================

    // SSM parameter for CloudFront domain (used by session manager Lambda at runtime
    // to avoid circular dependency: CloudFront → API GW → Lambda → CloudFront)
    new ssm.StringParameter(this, 'CloudFrontDomainParam', {
      parameterName: `/${stackPrefix}/cloudfront/domain-name`,
      stringValue: distribution.distributionDomainName,
      description: 'CloudFront distribution domain name',
    });

    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'The CloudFront distribution URL',
    });

    if (config.customDomain) {
      new cdk.CfnOutput(this, 'CustomDomainUrl', {
        value: `https://${config.customDomain}`,
        description: 'The custom domain URL',
      });
    }

    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'The CloudFront distribution ID',
    });

    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      value: restApi.url,
      description: 'The API Gateway URL',
    });

    new cdk.CfnOutput(this, 'RemixFunctionUrl', {
      value: mainFunctionUrl.url,
      description: 'Remix Lambda Function URL for SSR (AWS_IAM authenticated)',
    });

    new cdk.CfnOutput(this, 'StreamingFunctionUrl', {
      value: streamingFunctionUrl.url,
      description: 'Streaming Lambda Function URL for chat (AWS_IAM authenticated)',
    });

    new cdk.CfnOutput(this, 'CognitoUserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'CognitoUserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
    });

    new cdk.CfnOutput(this, 'CognitoIdentityPoolId', {
      value: identityPool.identityPoolId,
      description: 'Cognito Identity Pool ID',
    });

    new cdk.CfnOutput(this, 'StyleExtractionBucketName', {
      value: styleExtractionBucket.bucketName,
      description: 'S3 bucket for style extraction uploads (reused by Brand Templates)',
    });
  }
}
