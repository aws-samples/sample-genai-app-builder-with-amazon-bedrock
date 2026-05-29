import { useEffect } from 'react';
import { kTheme } from '~/lib/stores/theme';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    useEffect(() => {
        if (typeof window !== 'undefined') {
            localStorage.setItem(kTheme, 'light');
            document.querySelector('html')?.setAttribute('data-theme', 'light');
        }
    }, []);

    return <>{children}</>;
}
