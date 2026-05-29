#!/bin/bash

# KMS Integration Test Runner
# This script runs the KMS integration tests and generates coverage reports

set -e

echo "🔐 Running KMS Integration Tests..."

# Check if required dependencies are installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm is required but not installed"
    exit 1
fi

# Install test dependencies if not present
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Run unit tests
echo "🧪 Running unit tests..."
npm test -- --testPathPattern=kms-integration.test.ts --verbose

# Generate coverage report
echo "📊 Generating coverage report..."
npm test -- --coverage --testPathPattern=kms-integration.test.ts

# Run CDK synth to validate template
echo "🏗️ Validating CDK template..."
npx cdk synth --quiet

echo "✅ KMS integration tests completed successfully!"

# Optional: Run end-to-end tests if AWS credentials are available
if [ "$RUN_E2E_TESTS" = "true" ]; then
    echo "🌐 Running end-to-end tests..."
    echo "⚠️ Note: E2E tests require actual AWS resources and may incur costs"
    # npm test -- --testPathPattern=kms-integration.test.ts --testNamePattern="End-to-End"
    echo "ℹ️ E2E tests are currently skipped. Set RUN_E2E_TESTS=true and uncomment above line to run."
fi

echo "🎉 All tests completed!"
