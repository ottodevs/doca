import { useState } from "react";
import { createRoot } from "react-dom/client";
// ThirdwebProvider supplies the query client the header's sign-in fallback needs.
import { ThirdwebProvider } from "thirdweb/react";
import App from "./App";
import LpDesk from "./LpDesk";
import type { ViewId } from "./nav";
import "@fontsource/fraunces/500.css";
import "@fontsource/fraunces/600.css";
import "@fontsource/schibsted-grotesk/400.css";
import "@fontsource/schibsted-grotesk/500.css";
import "@fontsource/schibsted-grotesk/600.css";
import "@fontsource/schibsted-grotesk/700.css";
import "./styles.css";

// Two faces of the same primitives: the guided harbor journey and the pro LP desk.
// Each view owns its own header (wallet chip differs), but both render the same
// tab nav via ./nav so switching views never re-lays the surrounding chrome.
function Root() {
    const [view, setView] = useState<ViewId>("journey");

    return view === "journey"
        ? <App view={view} onViewChange={setView} />
        : <LpDesk view={view} onViewChange={setView} />;
}

createRoot(document.getElementById("root")!).render(<ThirdwebProvider><Root /></ThirdwebProvider>);
