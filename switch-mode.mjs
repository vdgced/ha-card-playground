/**
 * Bascule ha-card-playground entre mode dev et mode prod dans configuration.yaml
 *
 * Usage :
 *   npm run use:dev   → DEV_URL  (serveur local)
 *   npm run use:prod  → /local/ha-card-playground.js  (+ build + copie NAS)
 *
 * Config : copier switch-config.example.json → switch-config.json et remplir les valeurs.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const cfgPath = path.join(__dirname, "switch-config.json");
if (!fs.existsSync(cfgPath)) {
  console.error("❌ switch-config.json introuvable.");
  console.error("   Copie switch-config.example.json → switch-config.json et remplis les valeurs.");
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

const HA_CONFIG   = cfg.HA_CONFIG;
const HA_WWW_DEST = cfg.HA_WWW_DEST;
const HA_URL      = cfg.HA_URL;
const HA_TOKEN    = cfg.HA_TOKEN;

const DEV_URL  = cfg.DEV_URL;
const PROD_URL = "/local/ha-card-playground.js";

const mode = process.argv[2];
if (mode !== "dev" && mode !== "prod") {
  console.error("Usage: node switch-mode.mjs [dev|prod]");
  process.exit(1);
}

// ── 1. Lire configuration.yaml ──────────────────────────────────────────────
let config;
try {
  config = fs.readFileSync(HA_CONFIG, "utf8");
} catch (e) {
  console.error(`❌ Impossible de lire ${HA_CONFIG}`);
  console.error(e.message);
  process.exit(1);
}

const targetUrl = mode === "dev" ? DEV_URL : PROD_URL;
const fromUrl   = mode === "dev" ? PROD_URL : DEV_URL;

if (!config.includes(fromUrl) && config.includes(targetUrl)) {
  console.log(`✅ Déjà en mode ${mode}, rien à changer.`);
  process.exit(0);
}

if (!config.includes(fromUrl)) {
  console.error(`❌ URL "${fromUrl}" introuvable dans configuration.yaml`);
  console.error("   Vérifier que la config contient bien la bonne module_url.");
  process.exit(1);
}

// ── 2. Remplacer l'URL dans configuration.yaml ──────────────────────────────
const updated = config.replace(fromUrl, targetUrl);
fs.writeFileSync(HA_CONFIG, updated, "utf8");
console.log(`✅ configuration.yaml mis à jour → mode ${mode.toUpperCase()}`);
console.log(`   module_url: ${targetUrl}`);

// ── 3. Si prod : build + copie sur le NAS ───────────────────────────────────
if (mode === "prod") {
  console.log("\n🔨 Build production...");
  try {
    execSync("npm run build", { stdio: "inherit", cwd: __dirname });
  } catch {
    console.error("❌ Build échoué, annulation.");
    process.exit(1);
  }
  console.log(`\n📋 Copie vers ${HA_WWW_DEST}...`);
  try {
    fs.copyFileSync(path.join(__dirname, "dist", "ha-card-playground.js"), HA_WWW_DEST);
    console.log("✅ Fichier copié.");
  } catch (e) {
    console.error(`❌ Copie échouée : ${e.message}`);
    process.exit(1);
  }
}

// ── 4. Redémarrer HA via REST API ────────────────────────────────────────────
console.log("\n🔄 Redémarrage de Home Assistant...");
try {
  execSync(
    `curl -s -X POST -H "Authorization: Bearer ${HA_TOKEN}" -H "Content-Type: application/json" "${HA_URL}/api/services/homeassistant/restart"`,
    { stdio: "pipe" }
  );
  console.log("✅ HA redémarre — attends ~30 secondes puis recharge la page.");
} catch (e) {
  console.error(`❌ Impossible de contacter HA : ${e.message}`);
  console.error("   Redémarre HA manuellement via l'interface.");
}
