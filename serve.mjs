/**
 * Serveur de développement local
 * Sert dist/ avec CORS pour que HA puisse charger le JS depuis ce PC
 * Lance aussi rollup --watch en parallèle
 * Usage: node serve.mjs
 */
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, "dist");
const PORT = 5500;

const server = http.createServer((req, res) => {
  // CORS — autorise HA à charger le fichier
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const filePath = path.join(DIST_DIR, req.url === "/" ? "ha-card-playground.js" : req.url);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end(`Not found: ${req.url}`);
      return;
    }
    res.setHeader("Content-Type", "application/javascript");
    res.writeHead(200);
    res.end(data);
    console.log(`[${new Date().toLocaleTimeString()}] served: ${req.url}`);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n✅ Serveur de dev actif sur http://192.168.0.17:${PORT}/`);
  console.log(`   HA charge le plugin depuis :`);
  console.log(`   http://192.168.0.17:${PORT}/ha-card-playground.js\n`);

  // Lance rollup --watch en parallèle dans le même terminal
  const rollup = spawn("npx", ["rollup", "-c", "rollup.config.js", "--watch"], {
    stdio: "inherit",
    shell: true,
  });
  rollup.on("error", (err) => console.error("rollup error:", err));
});
