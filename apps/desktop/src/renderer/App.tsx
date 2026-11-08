import { useEffect, useState } from 'react';

declare global {
    interface Window {
        felyrics: {
            ping: () => Promise<string>;
        };
    }
}

export function App() {
    const [reply, setReply] = useState('...');

    useEffect(() => {
        let cancelled = false;

        void window.felyrics.ping().then((value) => {
            if (!cancelled) {
                setReply(value);
            }
        });

        return () => {
            cancelled = true;
        };
    }, []);
    return (
        <main>
            <h1>Felyrics</h1>
            <p>main process says: {reply}</p>
        </main>
    );
}
