import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { InfraStack } from '../lib/infra-stack';
import { legacyRedirectFunctionCode } from '../lib/untrusted-content/untrusted-content';

/**
 * Generated apps are untrusted, LLM-written code. They must never run on the
 * authenticated app's origin, where they could read the sign-in tokens
 * the app keeps in localStorage/sessionStorage and call the API as the user.
 *
 * These pin that live previews and shared sites are served only from the
 * separate "untrusted content" distribution, that the app's own distribution
 * merely redirects the legacy paths there, and that each side carries the
 * headers that keep the two apart.
 */

const baseConfig = {
  stackName: 'test-stack',
  region: 'us-west-2',
  bedrockModelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
};

const synth = (config: Record<string, unknown>) => {
  const app = new cdk.App();
  const stack = new InfraStack(app, 'TestStack', {
    config: { ...baseConfig, ...config } as any,
    env: { account: '123456789012', region: 'us-west-2' },
  });
  return Template.fromStack(stack);
};

const templates = {
  'without a custom domain': synth({}),
  'with a custom domain': synth({ customDomain: 'vibe.example.dev' }),
  'with a separate preview domain': synth({
    customDomain: 'vibe.example.dev',
    previewDomain: 'vibe-preview.example.net',
  }),
};

const distributions = (template: Template) =>
  Object.entries(template.findResources('AWS::CloudFront::Distribution')) as [string, any][];

const appDistribution = (template: Template) => {
  const found = distributions(template).filter(([id]) => id.startsWith('BedrockVibeDistribution'));
  expect(found).toHaveLength(1);
  return found[0][1].Properties.DistributionConfig;
};

const untrustedDistribution = (template: Template) => {
  const found = distributions(template).filter(([id]) => id.startsWith('PreviewDistribution'));
  expect(found).toHaveLength(1);
  return found[0][1].Properties.DistributionConfig;
};

const headersPolicy = (template: Template, ref: any) => {
  const id = ref?.Ref;
  expect(id).toBeDefined();
  return template.toJSON().Resources[id].Properties.ResponseHeadersPolicyConfig;
};

const originOf = (config: any, behavior: any) =>
  config.Origins.find((o: any) => o.Id === behavior.TargetOriginId);

// With a custom domain the ALB origin is its TLS hostname, sandbox-origin.<domain>.
const isAlb = (origin: any) => /SandboxAlb|sandbox-origin\./.test(JSON.stringify(origin.DomainName));
const isSharedBucket = (origin: any) => JSON.stringify(origin.DomainName).includes('SharedSites');

const behaviorFor = (config: any, path: string) =>
  (config.CacheBehaviors ?? []).find((b: any) => b.PathPattern === path);

const cspOf = (policy: any): string => {
  const csp = policy.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy;
  return typeof csp === 'string' ? csp : JSON.stringify(csp);
};

describe.each(Object.entries(templates))('Origin isolation %s', (_label, template) => {
  describe('app distribution', () => {
    test('serves no generated content: no origin is the shared-sites bucket', () => {
      const config = appDistribution(template);
      expect(config.Origins.filter(isSharedBucket)).toEqual([]);
    });

    test('only the signed /ws/* behavior reaches the sandbox ALB', () => {
      const config = appDistribution(template);
      const albBehaviors = [config.DefaultCacheBehavior, ...(config.CacheBehaviors ?? [])].filter(
        (b: any) => isAlb(originOf(config, b)),
      );

      expect(albBehaviors.map((b: any) => b.PathPattern)).toEqual(['/ws/*']);
    });

    test.each(['/shared/*', '/sandbox-preview*'])(
      'the legacy %s path only redirects to the untrusted origin',
      (path) => {
        const config = appDistribution(template);
        const behavior = behaviorFor(config, path);

        expect(behavior).toBeDefined();
        expect(behavior.AllowedMethods).toEqual(['GET', 'HEAD']);
        const assoc = behavior.FunctionAssociations ?? [];
        expect(assoc).toHaveLength(1);
        expect(assoc[0].EventType).toBe('viewer-request');
        expect(JSON.stringify(assoc[0].FunctionARN)).toContain('LegacyUntrustedRedirectFunction');
      },
    );

    test('CSP: framed only by itself, and frames only the untrusted origin', () => {
      const config = appDistribution(template);
      const csp = cspOf(headersPolicy(template, config.DefaultCacheBehavior.ResponseHeadersPolicyId));

      expect(csp).toContain("frame-ancestors 'self'");
      const frameSrc = csp.match(/frame-src([^;]*);/)?.[1] ?? '';
      expect(frameSrc).not.toContain("'self'");
      expect(frameSrc.trim().length).toBeGreaterThan(0);
    });

    test('app headers: X-Frame-Options, HSTS, nosniff, Referrer-Policy', () => {
      const config = appDistribution(template);
      const sec = headersPolicy(template, config.DefaultCacheBehavior.ResponseHeadersPolicyId)
        .SecurityHeadersConfig;

      expect(sec.FrameOptions.FrameOption).toBe('SAMEORIGIN');
      expect(sec.StrictTransportSecurity.AccessControlMaxAgeSec).toBeGreaterThanOrEqual(31536000);
      expect(sec.ContentTypeOptions.Override).toBe(true);
      expect(sec.ReferrerPolicy.ReferrerPolicy).toBe('strict-origin-when-cross-origin');
    });
  });

  describe('untrusted content distribution', () => {
    test('serves previews from the sandbox ALB with the session-routing function', () => {
      const config = untrustedDistribution(template);
      const behavior = behaviorFor(config, '/sandbox-preview*');

      expect(behavior).toBeDefined();
      expect(isAlb(originOf(config, behavior))).toBe(true);
      expect(JSON.stringify(behavior.FunctionAssociations)).toContain('PreviewRewriteFunction');
    });

    test('does not proxy arbitrary paths to the sandbox', () => {
      const config = untrustedDistribution(template);
      expect(isAlb(originOf(config, config.DefaultCacheBehavior))).toBe(false);
    });

    test('serves shared sites from the shared-sites bucket', () => {
      const config = untrustedDistribution(template);
      const behavior = behaviorFor(config, '/shared/*');

      expect(behavior).toBeDefined();
      expect(isSharedBucket(originOf(config, behavior))).toBe(true);
      expect(behavior.AllowedMethods).toEqual(['GET', 'HEAD']);
    });

    test('preview responses may only be framed by the app, and never grant credentialed CORS', () => {
      const config = untrustedDistribution(template);
      const policy = headersPolicy(template, behaviorFor(config, '/sandbox-preview*').ResponseHeadersPolicyId);
      const csp = cspOf(policy);

      expect(csp).toMatch(/frame-ancestors [^;']*https:\/\//);
      expect(csp).not.toContain("frame-ancestors 'self'");
      expect(csp).not.toMatch(/frame-ancestors[^;]*\*;/);
      expect(policy.SecurityHeadersConfig.ContentTypeOptions.Override).toBe(true);
      expect(policy.SecurityHeadersConfig.StrictTransportSecurity).toBeDefined();
      expect(policy.SecurityHeadersConfig.ReferrerPolicy.ReferrerPolicy).toBe('no-referrer');
      expect(policy.RemoveHeadersConfig.Items).toEqual(
        expect.arrayContaining([{ Header: 'Access-Control-Allow-Credentials' }]),
      );
    });

    test('shared sites are standalone: not frameable, restrictive headers, no credentialed CORS', () => {
      const config = untrustedDistribution(template);
      const policy = headersPolicy(template, behaviorFor(config, '/shared/*').ResponseHeadersPolicyId);
      const csp = cspOf(policy);

      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(policy.SecurityHeadersConfig.FrameOptions.FrameOption).toBe('DENY');
      expect(policy.SecurityHeadersConfig.ContentTypeOptions.Override).toBe(true);
      expect(policy.SecurityHeadersConfig.StrictTransportSecurity).toBeDefined();
      expect(policy.SecurityHeadersConfig.ReferrerPolicy.ReferrerPolicy).toBe('no-referrer');
      expect(policy.RemoveHeadersConfig.Items).toEqual(
        expect.arrayContaining([{ Header: 'Access-Control-Allow-Credentials' }]),
      );
    });

    test('the session manager hands out preview URLs on the untrusted origin', () => {
      const fns = Object.values(template.findResources('AWS::Lambda::Function')) as any[];
      const sessionManager = fns.find((f) => f.Properties.Environment?.Variables?.PREVIEW_URL_TEMPLATE);

      expect(sessionManager).toBeDefined();
      const tpl = JSON.stringify(sessionManager.Properties.Environment.Variables.PREVIEW_URL_TEMPLATE);
      expect(tpl).toContain('/sandbox-preview/{sessionId}/');
    });
  });
});

describe('Origin isolation with a custom domain', () => {
  const template = templates['with a custom domain'];

  test('previews get one origin per session under preview.<app domain>', () => {
    expect(untrustedDistribution(template).Aliases).toEqual(['*.preview.vibe.example.dev']);
  });

  test('preview frame-ancestors is exactly the app origin', () => {
    const config = untrustedDistribution(template);
    const csp = cspOf(headersPolicy(template, behaviorFor(config, '/sandbox-preview*').ResponseHeadersPolicyId));
    expect(csp).toContain('frame-ancestors https://vibe.example.dev;');
  });

  test('the app CSP frames only the per-session preview origins', () => {
    const csp = cspOf(headersPolicy(template, appDistribution(template).DefaultCacheBehavior.ResponseHeadersPolicyId));
    expect(csp).toContain('frame-src https://*.preview.vibe.example.dev;');
  });

  test('share links point at the untrusted origin, not the app', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: { SHARED_SITES_DOMAIN: 'https://shared.preview.vibe.example.dev' } },
    });
  });

  test('preview URLs carry the session in the host', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          PREVIEW_URL_TEMPLATE: 'https://{sessionId}.preview.vibe.example.dev/sandbox-preview/{sessionId}/',
        },
      },
    });
  });
});

describe('Origin isolation with a separate preview domain', () => {
  const template = templates['with a separate preview domain'];

  test('untrusted content lives on the separate registrable domain', () => {
    expect(untrustedDistribution(template).Aliases).toEqual(['*.vibe-preview.example.net']);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: { SHARED_SITES_DOMAIN: 'https://shared.vibe-preview.example.net' } },
    });
  });

  test('the app CSP frames only the separate domain', () => {
    const csp = cspOf(headersPolicy(template, appDistribution(template).DefaultCacheBehavior.ResponseHeadersPolicyId));
    expect(csp).toContain('frame-src https://*.vibe-preview.example.net;');
  });
});

describe('legacy redirect function', () => {
  const run = (code: string, uri: string, querystring: Record<string, any> = {}) => {
    // eslint-disable-next-line no-new-func
    const handler = new Function(`${code}\nreturn handler;`)();
    return handler({ request: { uri, querystring, headers: {} } });
  };

  const code = legacyRedirectFunctionCode({
    previewHostTemplate: '{sessionId}.preview.vibe.example.dev',
    sharedSitesHost: 'shared.preview.vibe.example.dev',
  });

  test('redirects a preview path to that session\'s own origin', () => {
    const res = run(code, '/sandbox-preview/abc-123/src/main.tsx');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location.value).toBe(
      'https://abc-123.preview.vibe.example.dev/sandbox-preview/abc-123/src/main.tsx',
    );
  });

  test('redirects a shared site to the shared-sites origin, keeping the query', () => {
    const res = run(code, '/shared/xyz/', { a: { value: '1' }, b: { value: '2', multiValue: [{ value: '2' }, { value: '3' }] } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location.value).toBe('https://shared.preview.vibe.example.dev/shared/xyz/?a=1&b=2&b=3');
  });

  test('refuses a session id that is not a DNS label', () => {
    expect(run(code, '/sandbox-preview/evil.com%2f/x').statusCode).toBe(404);
    expect(run(code, '/sandbox-preview/').statusCode).toBe(404);
    expect(run(code, '/sandbox-preview').statusCode).toBe(404);
  });

  test('a single-host template keeps every session on that host', () => {
    const single = legacyRedirectFunctionCode({
      previewHostTemplate: 'd111.cloudfront.net',
      sharedSitesHost: 'd111.cloudfront.net',
    });
    expect(run(single, '/sandbox-preview/abc/').headers.location.value).toBe(
      'https://d111.cloudfront.net/sandbox-preview/abc/',
    );
  });

  test('is never cached', () => {
    expect(run(code, '/shared/xyz/').headers['cache-control'].value).toBe('no-store');
  });
});
