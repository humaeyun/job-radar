import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // GitHub Pages serves a project site under /<repo>/. The deploy workflow sets
  // VITE_BASE=/job-radar/; local dev leaves it "/".
  base: process.env.VITE_BASE || "/",
  plugins: [react()],
});
