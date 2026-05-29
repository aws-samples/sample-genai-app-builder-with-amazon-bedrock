// Test setup for KMS integration tests

// Set test environment variables
process.env.CDK_DEFAULT_ACCOUNT = '123456789012';
process.env.CDK_DEFAULT_REGION = 'us-west-2';

// Mock AWS SDK calls for unit tests
jest.mock('aws-sdk', () => ({
  KMS: jest.fn(() => ({
    describeKey: jest.fn().mockReturnValue({
      promise: () => Promise.resolve({
        KeyMetadata: {
          KeyId: 'test-key-id',
          Arn: 'arn:aws:kms:us-west-2:123456789012:key/test-key-id',
          KeyRotationStatus: true
        }
      })
    }),
    decrypt: jest.fn().mockReturnValue({
      promise: () => Promise.resolve({
        Plaintext: Buffer.from('decrypted-data')
      })
    })
  })),
  S3: jest.fn(() => ({
    getBucketEncryption: jest.fn().mockReturnValue({
      promise: () => Promise.resolve({
        ServerSideEncryptionConfiguration: {
          Rules: [{
            ApplyServerSideEncryptionByDefault: {
              SSEAlgorithm: 'aws:kms',
              KMSMasterKeyID: 'test-key-id'
            }
          }]
        }
      })
    })
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({
      promise: () => Promise.resolve({
        SecretString: 'test-secret-value'
      })
    })
  }))
}));

// Increase timeout for integration tests
jest.setTimeout(30000);
