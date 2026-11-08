declare global {
    interface Window {
        felyrics: {
            ping: () => string;
        };
    }
}

const root = document.querySelector('#root');

if (root) {
    root.textContent = `preload says: ${window.felyrics.ping()}`;
}

export {};
