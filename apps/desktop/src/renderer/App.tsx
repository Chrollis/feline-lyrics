import { useState } from 'react';

declare global {
    interface Window {
        felyrics: {
            ping: () => string;
        };
    }
}

export function App() {
    const [reply] = useState(() => window.felyrics.ping());

    return (
        <main>
            <h1>Felyrics</h1>
            <p>preload says: {reply}</p>
        </main>
    );
}
