import './polyfills';
import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import { clusterApiUrl } from "@solana/web3.js";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./index.css";
import App from "./App.jsx";

function Root() {
  const endpoint = useMemo(() => {
    const envEndpoint = import.meta.env.VITE_SOLANA_RPC;
    if (envEndpoint && typeof envEndpoint === "string") {
      return envEndpoint;
    }
    // Default to mainnet to match backend/production network unless overridden
    return clusterApiUrl("mainnet-beta");
  }, []);
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Root />
  </StrictMode>
);

