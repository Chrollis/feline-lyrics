declare global {
    interface Window {
        felyrics: {
            ping: () => string;
        };
    }
}

export function App() {
    return (
        <main>
            <h1>Felyrics</h1>
            <p>preload says: {window.felyrics.ping()}</p>
        </main>
    );
}
