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

// The app is served under /app/, so the bundle must reference its assets from there.
execSync("bun run build -- --base=/app/", { cwd: "web", stdio: "inherit" });

cpSync("landing", out, { recursive: true });
// Public build points at the unified /app route instead of the tailnet dev URL.
import { readFileSync } from "fs";
const idx = `${out}/index.html`;
writeFileSync(idx, readFileSync(idx, "utf8").replaceAll("http://100.64.0.1:5273", "/app"));
cpSync("web/dist", `${out}/app`, { recursive: true });
cpSync("deck", `${out}/deck`, { recursive: true });
cpSync("assets/brand", `${out}/brand`, { recursive: true });
if (existsSync("docs/brand.html")) cpSync("docs/brand.html", `${out}/brand/index.html`);
// Directory routes (/dossier/, /agents/) instead of .html files: Pages' own
// .html-stripping redirect would otherwise bounce /dossier.html -> /dossier forever.
if (existsSync("docs/dossier.html")) {
  mkdirSync(`${out}/dossier`, { recursive: true });
  cpSync("docs/dossier.html", `${out}/dossier/index.html`);
}
if (existsSync("docs/agents.html")) {
  mkdirSync(`${out}/agents`, { recursive: true });
  cpSync("docs/agents.html", `${out}/agents/index.html`);
}

// No _redirects: Pages already serves /dossier and /agents from the .html files.
// An explicit rewrite fights Pages' own .html-stripping redirect and loops (308).

console.log("site assembled at", out);
