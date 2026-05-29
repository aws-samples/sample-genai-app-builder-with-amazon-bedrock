// Runs inside each Jest worker before the test file is loaded.
// Sets env vars that need to be visible while the stack is being
// synthesized. Must be `setupFiles`, not `globalSetup`, because Jest's
// globalSetup runs in a separate process whose env is not inherited by
// workers.
//
// BV_SKIP_LAMBDA_BUNDLE makes InfraStack's BrandTemplatesLambda use a
// local bundler stub (source copy only, no `pip install`) when no
// Docker daemon is available — which is the case on CI runners. Real
// `cdk deploy` invocations outside Jest leave this unset and still get
// the full pip-installed Docker-bundled artifact.
process.env.BV_SKIP_LAMBDA_BUNDLE = '1';
