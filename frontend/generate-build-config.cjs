const fs = require('fs');
const path = require('path');

// Load config at build time (supports CONFIG_FILE env var for prod)
const configFile = process.env.CONFIG_FILE || 'config.yml';
const configPath = path.join(__dirname, '..', 'infra', configFile);

let stackName = '';
let region = 'us-west-2';

if (fs.existsSync(configPath)) {
    const configContent = fs.readFileSync(configPath, 'utf8');
    const stackNameMatch = configContent.match(/^\s*stackName:\s*["']?([^"'\n]+)["']?/m);
    const regionMatch = configContent.match(/^\s*region:\s*["']?([^"'\n]+)["']?/m);
    stackName = stackNameMatch ? stackNameMatch[1].trim() : '';
    region = regionMatch ? regionMatch[1].trim() : 'us-west-2';
} else if (process.env.CI) {
    // In CI, config.yml is not required — use placeholder values for build validation
    stackName = 'ci-placeholder';
    console.log(`ℹ️  infra/${configFile} not found — using CI defaults`);
} else {
    console.error(`❌ ERROR: infra/${configFile} not found. Copy config.example.yml to infra/config.yml`);
    process.exit(1);
}

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
