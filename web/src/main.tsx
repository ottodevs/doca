import { useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import LpDesk from "./LpDesk";
import "@fontsource-variable/inter";
import "./styles.css";

type View = "demo" | "desk";

function Root() {
    const [view, setView] = useState<View>("desk");

    return (
        <>
            <nav className="view-nav" aria-label="App views">
                <button
                    type="button"
                    className={view === "demo" ? "on" : ""}
                    onClick={() => setView("demo")}
                >
                    Demo
                </button>
                <button
                    type="button"
                    className={view === "desk" ? "on" : ""}
                    onClick={() => setView("desk")}
                >
                    LP Desk
                </button>
            </nav>
            {view === "demo" ? <App /> : <LpDesk />}
        </>
    );
}

createRoot(document.getElementById("root")!).render(<Root />);
