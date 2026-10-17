import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiOrigin = env.HARDWIRE_API_ORIGIN || "http://127.0.0.1:3000";
  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api": {
          target: apiOrigin,
          changeOrigin: false,
        },
      },
    },
  };
});
