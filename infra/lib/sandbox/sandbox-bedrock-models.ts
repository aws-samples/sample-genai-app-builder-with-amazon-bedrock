import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Global cross-region inference profiles that apps generated inside the sandbox
 * may call. This must match the "Model IDs" list in
 * frontend/app/lib/.server/llm/prompts.ts — that prompt is what tells generated
 * code which models to use. test/security.test.ts fails if the two drift.
 */
export const SANDBOX_BEDROCK_INFERENCE_PROFILES: readonly string[] = [
  'global.amazon.nova-micro-v1:0',
  'global.amazon.nova-2-lite-v1:0',
  'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  'global.amazon.nova-pro-v1:0',
  'global.anthropic.claude-sonnet-4-6',
  'global.anthropic.claude-opus-4-6-v1',
];

const INVOKE_ACTIONS = ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'];

export interface SandboxBedrockPolicyProps {
  /** Region the generated apps call Bedrock in (the inference profile's home region). */
  region: string;
  account: string;
  /** Requests must arrive through this VPC's bedrock-runtime endpoint. */
  vpcId: string;
}

/**
 * Policy statements for the sandbox task role.
 *
 * The container runs user-generated code, which can read these credentials and
 * copy them out. So:
 *  - only the listed inference profiles in this account may be invoked;
 *  - the underlying foundation models are allowed only when reached through one
 *    of those profiles (`bedrock:InferenceProfileArn`). A global profile routes
 *    to any commercial region, and to the region-less global model ARN, so the
 *    model ARNs name a specific model but any region;
 *  - every inference-profile invocation is denied unless it arrives through the
 *    sandbox VPC's bedrock-runtime endpoint. Copied credentials therefore do not
 *    work from anywhere else. The deny targets the profile — the entry point,
 *    always evaluated in the caller's request context — rather than the routed
 *    foundation-model check, so cross-region routing is unaffected. A direct
 *    foundation-model call has no inference profile and matches no Allow.
 */
export function sandboxBedrockStatements(props: SandboxBedrockPolicyProps): iam.PolicyStatement[] {
  const { region, account, vpcId } = props;
  const profileArns = SANDBOX_BEDROCK_INFERENCE_PROFILES.map(
    (id) => `arn:aws:bedrock:${region}:${account}:inference-profile/${id}`,
  );
  const modelIds = SANDBOX_BEDROCK_INFERENCE_PROFILES.map((id) => id.replace(/^global\./, ''));

  return [
    new iam.PolicyStatement({
      sid: 'InvokeAllowedInferenceProfiles',
      actions: INVOKE_ACTIONS,
      resources: profileArns,
    }),
    new iam.PolicyStatement({
      sid: 'InvokeModelsOnlyViaAllowedProfiles',
      actions: INVOKE_ACTIONS,
      resources: modelIds.flatMap((id) => [
        `arn:aws:bedrock:*::foundation-model/${id}`,
        `arn:aws:bedrock:::foundation-model/${id}`,
      ]),
      conditions: {
        StringEquals: { 'bedrock:InferenceProfileArn': profileArns },
      },
    }),
    new iam.PolicyStatement({
      sid: 'DenyBedrockOutsideSandboxVpc',
      effect: iam.Effect.DENY,
      actions: INVOKE_ACTIONS,
      resources: [
        'arn:aws:bedrock:*:*:inference-profile/*',
        'arn:aws:bedrock:*:*:application-inference-profile/*',
      ],
      conditions: {
        StringNotEquals: { 'aws:SourceVpc': vpcId },
      },
    }),
  ];
}
