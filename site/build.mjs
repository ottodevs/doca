// Assembles the unified static site for doca.pages.dev:
//   /        landing
//   /app     the web app (vite build output)
//   /deck    pitch deck
//   /brand   brand assets
//   /dossier design dossier
// Run from repo root: bun site/build.mjs  (expects web/ already built)
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";

const out = "site/dist";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

execSync("bun run build", { cwd: "web", stdio: "inherit" });

cpSync("landing", out, { recursive: true });
cpSync("web/dist", `${out}/app`, { recursive: true });
cpSync("deck", `${out}/deck`, { recursive: true });
cpSync("assets/brand", `${out}/brand`, { recursive: true });
if (existsSync("docs/dossier.html")) cpSync("docs/dossier.html", `${out}/dossier.html`);

// SPA-ish niceties + trailing-slash routes handled by Pages automatically via directories.
writeFileSync(`${out}/_redirects`, "/dossier /dossier.html 200\n");

console.log("site assembled at", out);
