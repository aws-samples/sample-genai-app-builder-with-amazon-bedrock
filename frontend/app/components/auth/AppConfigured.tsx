import { useEffect, useState } from "react";
import {
    Alert,
    Authenticator,
    Heading,
    ThemeProvider,
    useAuthenticator,
    useTheme,
} from "@aws-amplify/ui-react";
import { Amplify } from "aws-amplify";
import { PendingExtractionsWatcher } from "~/components/brand-templates/PendingExtractionsWatcher";
import "@aws-amplify/ui-react/styles.css";

interface FullConfig {
    AWS_REGION: string;
    STACK_PREFIX: string;
    COGNITO_USER_POOL_ID: string;
    COGNITO_USER_POOL_CLIENT_ID: string;
    COGNITO_IDENTITY_POOL_ID: string;
    REMIX_FUNCTION_URL: string;
    STREAMING_FUNCTION_URL: string;
}

interface AppConfiguredProps {
    children: React.ReactNode;
}

// Sign-in header rendered inside Amplify ThemeProvider
function SignInHeader() {
    const { tokens } = useTheme();
    return (
        <Heading
            padding={`${tokens.space.xl} 0 0 ${tokens.space.xl}`}
            level={3}
        >
            GenAI App Builder
        </Heading>
    );
}

export default function AppConfigured({ children }: AppConfiguredProps) {
    const [config, setConfig] = useState<any | null>(null);
    const [error, setError] = useState<boolean | null>(null);
    const [configLoaded, setConfigLoaded] = useState(false);

    // Load full config from /api/config (server-side SSM)
    const loadConfig = async () => {
        try {
            const response = await fetch('/api/config');
            const fullConfig = await response.json() as FullConfig;
            console.log('Full config loaded from server:', fullConfig);

            if (typeof window !== 'undefined') {
                window.ENV = {
                    ...(window.ENV ?? {}),
                    ...fullConfig,
                };
            }
            setConfigLoaded(true);
            return fullConfig;
        } catch (e) {
            console.error('Error loading config:', e);
            throw e;
        }
    };

    useEffect(() => {
        // Load config then configure Amplify
        (async () => {
            try {
                const fullConfig = await loadConfig();

                // Configure Amplify with values from server
                const amplifyConfig = {
                    Auth: {
                        Cognito: {
                            userPoolId: fullConfig.COGNITO_USER_POOL_ID,
                            userPoolClientId: fullConfig.COGNITO_USER_POOL_CLIENT_ID,
                            identityPoolId: fullConfig.COGNITO_IDENTITY_POOL_ID,
                        },
                    },
                };
                Amplify.configure(amplifyConfig);
                console.log('Amplify configured');
                setConfig(amplifyConfig);
            } catch (e) {
                console.error('Error in configuration:', e);
                setError(true);
            }
        })();
    }, []);

    // Cognito authentication path
    if (!config) {
        if (error) {
            return (
                <div
                    style={{
                        height: "100%",
                        width: "100%",
                        display: "flex",
                        justifyContent: "center",
                        alignItems: "center",
                    }}
                >
                    <Alert heading="Configuration error" variation="error">
                        Error loading configuration
                    </Alert>
                </div>
            );
        }

        return (
            <div
                style={{
                    width: "100%",
                    height: "100%",
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                }}
            >
                <div className="text-bolt-elements-textPrimary">Loading authentication...</div>
            </div>
        );
    }

    return (
        <ThemeProvider
            theme={{ name: "default-theme" }}
            colorMode="light"
        >
            <Authenticator.Provider>
                <AuthenticatedShell>{children}</AuthenticatedShell>
            </Authenticator.Provider>
        </ThemeProvider>
    );
}

// The Amplify sign-in card is small and looks right vertically centered
// inside a 100vh box. Authenticated app content (chat, brand templates,
// etc.) needs the page to grow with content so it can scroll naturally —
// centering the whole subtree in 100vh pushes long pages above the
// viewport and behind the fixed GlobalHeader. Branch on `authStatus`
// so each state gets the wrapper it actually wants.
function AuthenticatedShell({ children }: { children: React.ReactNode }) {
    const { authStatus } = useAuthenticator((ctx) => [ctx.authStatus]);

    if (authStatus !== "authenticated") {
        return (
            <div
                style={{
                    width: "100%",
                    height: "100vh",
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                }}
            >
                <Authenticator
                    hideSignUp={true}
                    components={{
                        SignIn: {
                            Header: SignInHeader,
                        },
                    }}
                >
                    {() => <></>}
                </Authenticator>
            </div>
        );
    }

    return (
        <>
            {/*
             * Resumes polling for any in-flight brand-template extraction
             * after a page reload or navigation, and toasts when done.
             * Mounted here so it runs as soon as auth is settled and the
             * signed-fetch layer has credentials, not on every route.
             */}
            <PendingExtractionsWatcher />
            {children}
        </>
    );
}
