// Assembles the unified static site for doca.pages.dev:
//   /        landing
//   /app     the web app (vite build output)
//   /deck    pitch deck
//   /brand   brand assets
//   /dossier design dossier
//   /agents  agent (MCP) integration surface
// Run from repo root: bun site/build.mjs  (expects web/ already built)
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";

const out = "site/dist";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

execSync("bun run build", { cwd: "web", stdio: "inherit" });

cpSync("landing", out, { recursive: true });
// Public build points at the unified /app route instead of the tailnet dev URL.
import { readFileSync } from "fs";
const idx = `${out}/index.html`;
writeFileSync(idx, readFileSync(idx, "utf8").replaceAll("http://100.64.0.1:5273", "/app"));
cpSync("web/dist", `${out}/app`, { recursive: true });
cpSync("deck", `${out}/deck`, { recursive: true });
cpSync("assets/brand", `${out}/brand`, { recursive: true });
if (existsSync("docs/dossier.html")) cpSync("docs/dossier.html", `${out}/dossier.html`);
if (existsSync("docs/agents.html")) cpSync("docs/agents.html", `${out}/agents.html`);

// SPA-ish niceties + trailing-slash routes handled by Pages automatically via directories.
writeFileSync(`${out}/_redirects`, "/dossier /dossier.html 200\n/agents /agents.html 200\n");

console.log("site assembled at", out);
