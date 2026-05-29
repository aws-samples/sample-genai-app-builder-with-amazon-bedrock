# GenAI App Builder with Amazon Bedrock

An AI-powered web development agent that allows you to prompt, run, edit, and deploy full-stack applications directly from your browser. Powered by Amazon Bedrock's foundation models and agentic capabilities.

## Features

- **Natural language to code** — Describe what you want and the AI builds it
- **Live preview** — See your app running in real-time as it's being built
- **Full-stack generation** — Generates HTML, CSS, JavaScript, and React components
- **Brand templates** — Extract design systems from existing websites or images and apply them consistently
- **Iterative refinement** — Provide feedback and the AI adjusts the code
- **Secure sandbox** — Code runs in an isolated ECS container

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  CloudFront │────▶│  API Gateway │────▶│  Lambda (Remix)  │
│    (CDN)    │     │  + Cognito   │     │  Server-Side     │
└─────────────┘     └──────────────┘     └────────┬────────┘
                                                   │
                    ┌──────────────┐               │
                    │   Bedrock    │◀──────────────┘
                    │  (Claude)    │
                    └──────────────┘     ┌─────────────────┐
                                         │  ECS Fargate    │
                    ┌──────────────┐     │  (Sandbox)      │
                    │  DynamoDB    │     └─────────────────┘
                    │  (Sessions)  │
                    └──────────────┘     ┌─────────────────┐
                                         │  S3 (Static     │
                    ┌──────────────┐     │   Assets)       │
                    │ Brand Templ. │     └─────────────────┘
                    │  Lambda+DDB  │
                    └──────────────┘
```

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ and [pnpm](https://pnpm.io/)
- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) configured with credentials
- [AWS CDK](https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html) (`npm install -g aws-cdk`)
- [Docker](https://www.docker.com/) or [Finch](https://github.com/runfinch/finch) (for building the sandbox container)
- An AWS account with [Amazon Bedrock model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html) enabled for Claude models

## Supported Regions

Deploy in any region that supports both Amazon Bedrock (Claude) and all required services:

- `us-west-2` (Oregon) — recommended
- `us-east-1` (N. Virginia)
- `eu-west-1` (Ireland)

## Quick Start

### 1. Clone and configure

```bash
git clone https://github.com/aws-samples/genai-app-builder-with-amazon-bedrock.git
cd genai-app-builder-with-amazon-bedrock
cp config.example.yml infra/config.yml
# Edit infra/config.yml with your desired stack name and region
```

### 2. Deploy

```bash
./deploy.sh
```

This will:
- Install all dependencies (frontend + infrastructure)
- Build the frontend and Lambda handlers
- Bootstrap CDK (if needed)
- Deploy the full stack (~15 minutes on first deploy)
- Output the CloudFront URL and Cognito configuration

### 3. Create a user

After deployment, create a Cognito user:

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <USER_POOL_ID_FROM_OUTPUT> \
  --username your@email.com \
  --user-attributes Name=email,Value=your@email.com Name=email_verified,Value=true \
  --temporary-password 'YourTempPass123!' \
  --message-action SUPPRESS

aws cognito-idp admin-set-user-password \
  --user-pool-id <USER_POOL_ID_FROM_OUTPUT> \
  --username your@email.com \
  --password 'YourPermanentPass123!' \
  --permanent
```

### 4. Access the app

Open the CloudFront URL from the deployment output in your browser and log in.

## Local Development

```bash
cd frontend
pnpm install
pnpm run dev
```

The app runs at `http://localhost:5173`. You'll need the deployed backend (API Gateway, Bedrock, etc.) — local dev connects to the cloud services via `aws-exports.json`.

## Cost Estimate

Monthly cost for light usage (~100 chat sessions/month):

| Service | Estimated Cost |
|---------|---------------|
| Amazon Bedrock (Claude) | $5–50 (usage-based) |
| Lambda | < $1 |
| ECS Fargate (sandbox) | $5–15 |
| CloudFront | < $1 |
| DynamoDB | < $1 |
| S3 | < $1 |
| **Total** | **~$15–70/month** |

Costs scale with usage. The ECS sandbox runs on-demand and scales to zero when idle.

## Clean Up

To avoid ongoing charges, destroy all resources:

```bash
cd infra
cdk destroy --force
```

This removes all AWS resources created by the stack.

## Security

- All data is encrypted at rest (KMS) and in transit (TLS 1.2+)
- Authentication via Amazon Cognito
- API Gateway with Cognito authorizer on all endpoints
- S3 buckets are private (no public access)
- Lambda function URLs use IAM authentication
- SSRF protections on URL-based brand template extraction
- CloudTrail logging enabled

See [CONTRIBUTING.md](CONTRIBUTING.md) for reporting security issues.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `cdk bootstrap` fails | Ensure your AWS credentials have admin access |
| Docker/Finch build fails | Start Docker/Finch VM: `finch vm start` or start Docker Desktop |
| Bedrock returns 403 | Enable model access in the [Bedrock console](https://console.aws.amazon.com/bedrock/home#/modelaccess) |
| CloudFront returns 403 after deploy | Wait 2-3 minutes for cache invalidation to propagate |
| Login fails | Verify user was created with `--permanent` flag |

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.
