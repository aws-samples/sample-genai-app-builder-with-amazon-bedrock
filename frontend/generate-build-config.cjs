const fs = require('fs');
const path = require('path');

// Load config at build time (supports CONFIG_FILE env var for prod)
const configFile = process.env.CONFIG_FILE || 'config.yml';
const configPath = path.join(__dirname, '..', 'infra', configFile);
const configContent = fs.readFileSync(configPath, 'utf8');

const stackNameMatch = configContent.match(/^\s*stackName:\s*["']?([^"'\n]+)["']?/m);
const regionMatch = configContent.match(/^\s*region:\s*["']?([^"'\n]+)["']?/m);

const stackName = stackNameMatch ? stackNameMatch[1].trim() : '';
const region = regionMatch ? regionMatch[1].trim() : 'us-west-2';

if (!stackName) {
    console.error(`❌ ERROR: stackName is empty! Check that infra/${configFile} has a valid stackName field.`);
    process.exit(1);
}

const buildConfigContent = `// This file is generated at build time from ${configFile}
// DO NOT EDIT - changes will be overwritten

export const BUILD_CONFIG = {
  STACK_PREFIX: '${stackName}',
  AWS_REGION: '${region}',
} as const;
`;

const buildConfigPath = path.join(__dirname, 'app', 'lib', 'build-config.ts');
fs.writeFileSync(buildConfigPath, buildConfigContent, 'utf8');

console.log(`🔧 Generated build-config.ts from ${configFile}:`);
console.log('   STACK_PREFIX:', stackName);
console.log('   AWS_REGION:', region);
