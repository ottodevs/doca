import { useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import LpDesk from "./LpDesk";
import "@fontsource/fraunces/500.css";
import "@fontsource/fraunces/600.css";
import "@fontsource/schibsted-grotesk/400.css";
import "@fontsource/schibsted-grotesk/500.css";
import "@fontsource/schibsted-grotesk/600.css";
import "@fontsource/schibsted-grotesk/700.css";
import "./styles.css";

type View = "journey" | "desk";

// Two faces of the same primitives: the guided journey and the pro LP desk.
function Root() {
    const [view, setView] = useState<View>("journey");

    return (
        <>
            <nav className="view-nav" aria-label="App views">
                <button
                    type="button"
                    className={view === "journey" ? "on" : ""}
                    onClick={() => setView("journey")}
                >
                    Journey
                </button>
                <button
                    type="button"
                    className={view === "desk" ? "on" : ""}
                    onClick={() => setView("desk")}
                >
                    LP Desk
                </button>
            </nav>
            {view === "journey" ? <App /> : <LpDesk />}
        </>
    );
}

createRoot(document.getElementById("root")!).render(<Root />);
