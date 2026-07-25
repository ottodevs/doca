import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Reachable over the tailnet from other machines, and by name if a .test domain is wired up.
  server: {
    host: "0.0.0.0",
    port: 5273,
    strictPort: true,
    allowedHosts: ["plimsoll.test", "lady", ".ts.net", "localhost", "127.0.0.1", "100.64.0.1"],
  },
});
