import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(__dirname, "..", "..", ".env") });

import express from "express";
import { createRouter } from "./routes.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 4317;

const app = express();
app.use(createRouter());

const frontendDist = path.join(__dirname, "..", "..", "frontend", "dist");
app.use(express.static(frontendDist));
app.get("*", (_req, res) => {
  res.sendFile(path.join(frontendDist, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Claude dashboard server listening on http://localhost:${PORT}`);
});
