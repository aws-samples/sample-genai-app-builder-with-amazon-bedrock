import { useEffect, useState } from "react";
import { signOut, fetchAuthSession } from "aws-amplify/auth";
import { APP_NAME } from "~/lib/constants";

export default function GlobalHeader() {
    const [userName, setUserName] = useState<string | null>(null);

    useEffect(() => {
        (async () => {
            try {
                const session = await fetchAuthSession();

                if (!session) {
                    signOut();
                    return;
                }

                setUserName(session.tokens?.idToken?.payload?.email?.toString() ?? "");
            } catch (error) {
                console.error("Error fetching session:", error);
            }
        })();
    }, []);

    const handleSignOut = () => {
        signOut();
    };

    return (
        <div className="fixed top-0 left-0 right-0 z-50 bg-bolt-elements-background-depth-1 border-b border-bolt-elements-borderColor">
            <div className="flex items-center justify-between px-6 py-4">
                <div className="flex items-center gap-2">
                    <img src="/bedrock_vibe_192x192.png" alt="Bedrock Vibe" className="w-8 h-8" />
                    <h1 className="text-xl font-semibold text-bolt-elements-textPrimary">
                        {APP_NAME}
                    </h1>
                </div>

                {userName && (
                    <div className="flex items-center gap-4">
                        <span className="text-bolt-elements-textSecondary text-sm">
                            {userName}
                        </span>
                        <button
                            onClick={handleSignOut}
                            className="px-3 py-1 text-sm bg-bolt-elements-button-primary-background text-bolt-elements-button-primary-text rounded hover:bg-bolt-elements-button-primary-backgroundHover transition-colors"
                        >
                            Sign Out
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
} 