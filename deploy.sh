#!/bin/bash

# Bedrock Vibe Deployment Script
# This script installs dependencies and deploys the application to AWS

set -e  # Exit on any error

echo "🚀 Starting Bedrock Vibe deployment..."
echo ""

# Load stack configuration early (accept optional config file argument, e.g. ./deploy.sh infra/config.prod.yml)
CONFIG_FILE="${1:-infra/config.yml}"
STACK_NAME=""
if [ -f "$CONFIG_FILE" ]; then
    STACK_NAME=$(awk -F': ' '/^stackName:/{gsub(/"/,"",$2); print $2}' "$CONFIG_FILE")
fi

if [ -z "$STACK_NAME" ]; then
    STACK_NAME="GenAIAppBuilderStack"
fi

# Check if stack exists in ROLLBACK_COMPLETE state
echo "🔍 Checking for failed stack..."
STACK_STATUS=$(aws cloudformation describe-stacks --stack-name "${STACK_NAME}" --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "DOES_NOT_EXIST")

if [ "$STACK_STATUS" = "ROLLBACK_COMPLETE" ]; then
    echo "⚠️  Found stack in ROLLBACK_COMPLETE state. Deleting it first..."
    aws cloudformation delete-stack --stack-name "${STACK_NAME}"
    echo "   Waiting for stack deletion to complete..."
    aws cloudformation wait stack-delete-complete --stack-name "${STACK_NAME}"
    echo "✅ Failed stack deleted successfully!"
    echo ""
fi

# Check prerequisites
echo "📋 Checking prerequisites..."

# Check if pnpm is installed
if ! command -v pnpm &> /dev/null; then
    echo "❌ pnpm is not installed. Please install pnpm first:"
    echo "   npm install -g pnpm"
    exit 1
fi

# Check if AWS CLI is configured
if ! aws sts get-caller-identity &> /dev/null; then
    echo "❌ AWS credentials not configured. Please run:"
    echo "   aws configure sso"
    echo "   or: aws configure"
    exit 1
fi

# Check if CDK is installed
if ! command -v cdk &> /dev/null; then
    echo "❌ AWS CDK is not installed. Please install CDK first:"
    echo "   npm install -g aws-cdk"
    exit 1
fi

echo "✅ Prerequisites check passed!"
echo ""

# Install root dependencies
echo "📦 Installing root dependencies..."
pnpm install
echo "✅ Root dependencies installed!"
echo ""

# Install frontend dependencies
echo "📦 Installing frontend dependencies..."
cd frontend
pnpm install
cd ..
echo "✅ Frontend dependencies installed!"
echo ""

# Install infrastructure dependencies
echo "📦 Installing infrastructure dependencies..."
cd infra
npm install
cd ..
echo "✅ Infrastructure dependencies installed!"
echo ""

# Build sandbox agent
echo "🔨 Building sandbox agent..."
cd infra/lib/sandbox-container/agent
npm install
npm run build
cd ../../../..
echo "✅ Sandbox agent built!"
echo ""

# Build and deploy
echo "🏗️  Building and deploying to AWS..."
export CONFIG_FILE="$(basename "$CONFIG_FILE")"
pnpm run deploy:aws
echo ""

echo "📋 Retrieving deployment configuration..."
sleep 5

# Load stack configuration
STACK_NAME=""
CONFIG_REGION=""
if [ -f "$CONFIG_FILE" ]; then
    STACK_NAME=$(awk -F': ' '/^stackName:/{gsub(/"/,"",$2); print $2}' "$CONFIG_FILE")
    CONFIG_REGION=$(awk -F': ' '/^region:/{gsub(/"/,"",$2); print $2}' "$CONFIG_FILE")
fi

if [ -z "$STACK_NAME" ]; then
    echo "⚠️  Warning: Could not read stackName from $CONFIG_FILE. Falling back to existing stack."
    STACK_NAME="GenAIAppBuilderStack"
fi

STACK_PREFIX=$(echo "$STACK_NAME" | tr '[:upper:]' '[:lower:]')
AWS_REGION=${CONFIG_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region)}}
SSM_PREFIX="$STACK_PREFIX"

echo "   Using stack: $STACK_NAME"
echo "   Stack prefix: $STACK_PREFIX"
echo "   AWS region: $AWS_REGION"

# Retrieve from SSM Parameter Store
echo "   Fetching Cognito configuration..."
USER_POOL_ID=$(aws ssm get-parameter --name "/${SSM_PREFIX}/cognito/user-pool-id" --query "Parameter.Value" --output text 2>/dev/null || echo "")
USER_POOL_CLIENT_ID=$(aws ssm get-parameter --name "/${SSM_PREFIX}/cognito/user-pool-client-id" --query "Parameter.Value" --output text 2>/dev/null || echo "")
IDENTITY_POOL_ID=$(aws ssm get-parameter --name "/${SSM_PREFIX}/cognito/identity-pool-id" --query "Parameter.Value" --output text 2>/dev/null || echo "")

# Get CloudFront URL from CDK output (it's stored as an output, not SSM parameter)
echo "   Fetching CloudFront distribution URL..."
CLOUDFRONT_URL=$(aws cloudformation describe-stacks --stack-name "${STACK_NAME}" --query "Stacks[0].Outputs[?OutputKey=='CloudFrontUrl'].OutputValue" --output text 2>/dev/null || echo "")

if [ -z "$USER_POOL_ID" ] || [ -z "$USER_POOL_CLIENT_ID" ] || [ -z "$IDENTITY_POOL_ID" ] || [ -z "$CLOUDFRONT_URL" ]; then
    echo "⚠️  Warning: Could not retrieve all configuration values from AWS."
    echo "   This might be because the deployment is still in progress or there was an error."
    echo "   You may need to manually create the aws-exports.json file later."
else
    # Create the aws-exports.json file
    echo "   Creating frontend/public/aws-exports.json..."
    mkdir -p frontend/public
    cat > frontend/public/aws-exports.json << EOF
{
  "region": "${AWS_REGION}",
  "Auth": {
    "Cognito": {
      "userPoolClientId": "${USER_POOL_CLIENT_ID}",
      "userPoolId": "${USER_POOL_ID}",
      "identityPoolId": "${IDENTITY_POOL_ID}"
    }
  },
  "API": {
    "REST": {
      "RestApi": { "endpoint": "${CLOUDFRONT_URL}/api/v1" }
    }
  }
}
EOF
    echo "✅ aws-exports.json created successfully!"
    
    # Invalidate CloudFront cache to ensure fresh code is served
    echo ""
    echo "🔄 Invalidating CloudFront cache..."
    DISTRIBUTION_ID=$(aws cloudformation describe-stacks --stack-name "${STACK_NAME}" --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text 2>/dev/null || echo "")
    
    if [ ! -z "$DISTRIBUTION_ID" ]; then
        INVALIDATION_ID=$(aws cloudfront create-invalidation --distribution-id "${DISTRIBUTION_ID}" --paths "/*" --query "Invalidation.Id" --output text 2>/dev/null || echo "")
        if [ ! -z "$INVALIDATION_ID" ]; then
            echo "✅ CloudFront cache invalidation created: ${INVALIDATION_ID}"
            echo "   Cache will be cleared in a few minutes"
        else
            echo "⚠️  Warning: Could not create CloudFront invalidation"
        fi
    else
        echo "⚠️  Warning: Could not find CloudFront distribution ID"
    fi
fi

echo ""
echo "🎉 Deployment completed successfully!"
echo ""
echo "📝 Next steps:"
echo "   1. Create a Cognito user using the instructions in the README"
echo "   2. Start local development with: pnpm run dev"
echo "   3. Access your application at: http://localhost:5173"
if [ ! -z "$CLOUDFRONT_URL" ]; then
    echo "   4. Or access the deployed version at: ${CLOUDFRONT_URL}"
fi
echo ""
echo "🔧 Troubleshooting:"
echo "   - Check CloudWatch logs if you encounter issues"
echo "   - Ensure you have access to the required Bedrock model"
echo "   - Verify your AWS permissions include all necessary services" 
