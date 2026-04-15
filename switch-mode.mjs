/**
 * Bascule ha-card-playground entre mode dev et mode prod (HACS) dans configuration.yaml
 *
 * Usage :
 *   npm run use:dev   → DEV_URL  (serveur local, no-cache)
 *   npm run use:prod  → /local/community/ha-card-playground/ha-card-playground.js?v=X.Y.Z
 *                       build + copie NAS (www/ + www/community/) + redémarre HA
 *
 * Config : copier switch-config.example.json → switch-config.json et remplir les valeurs.
 */
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config utilisateur ──────────────────────────────────────────────────────
const cfgPath = path.join(__dirname, "switch-config.json");
if (!fs.existsSync(cfgPath)) {
  console.error("❌ switch-config.json introuvable.");
  console.error("   Copie switch-config.example.json → switch-config.json et remplis les valeurs.");
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

const HA_CONFIG        = cfg.HA_CONFIG;
const HA_WWW_DEST      = cfg.HA_WWW_DEST;       // /local/ha-card-playground.js  (legacy)
const HA_WWW_HACS_DEST = cfg.HA_WWW_HACS_DEST;  // /local/community/.../ha-card-playground.js
const HA_URL           = cfg.HA_URL;
const HA_TOKEN         = cfg.HA_TOKEN;
const DEV_URL          = cfg.DEV_URL;

// ── Version depuis package.json ─────────────────────────────────────────────
const pkg     = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
const VERSION = pkg.version;

const HACS_BASE = "/local/community/ha-card-playground/ha-card-playground.js";
const HACS_URL  = `${HACS_BASE}?v=${VERSION}`;

// Legacy URL (ancienne config manuelle)
const OLD_PROD_URL = "/local/ha-card-playground.js";

// ── Mode ────────────────────────────────────────────────────────────────────
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
  console.error(`❌ Impossible de lire ${HA_CONFIG} : ${e.message}`);
  process.exit(1);
}

// ── 2. Remplacer l'URL ───────────────────────────────────────────────────────
// Regex ancrée début de ligne → ne matche PAS "extra_module_url:"
// Capture group 1 = indent + "module_url: ", group 2 = URL courante
const lineRegex = /^([ \t]*module_url:[ \t]*)(\S+)/m;
const lineMatch = config.match(lineRegex);

if (!lineMatch) {
  console.error("❌ Impossible de trouver 'module_url:' dans configuration.yaml");
  process.exit(1);
}

const currentUrl = lineMatch[2];
let updated = config;

if (mode === "dev") {
  if (currentUrl === DEV_URL) {
    console.log("✅ Déjà en mode DEV, rien à changer.");
    openDevConsole();
    process.exit(0);
  }
  updated = config.replace(lineRegex, `$1${DEV_URL}`);

} else {
  if (currentUrl === HACS_URL) {
    console.log("✅ Déjà en mode PROD avec la bonne version, rien à changer.");
    process.exit(0);
  }
  updated = config.replace(lineRegex, `$1${HACS_URL}`);
}

fs.writeFileSync(HA_CONFIG, updated, "utf8");
console.log(`✅ configuration.yaml mis à jour → mode ${mode.toUpperCase()}`);
console.log(`   module_url: ${mode === "dev" ? DEV_URL : HACS_URL}`);

// ── 3. Si prod : build + double copie NAS ───────────────────────────────────
if (mode === "prod") {
  console.log(`\n🔨 Build v${VERSION}...`);
  try {
    execSync("npm run build", { stdio: "inherit", cwd: __dirname });
  } catch {
    console.error("❌ Build échoué, annulation.");
    process.exit(1);
  }

  const distFile = path.join(__dirname, "dist", "ha-card-playground.js");

  /** Sauvegarde un fichier existant en .ok.js avant de l'écraser */
  function backupBeforeCopy(dest) {
    if (fs.existsSync(dest)) {
      const backupPath = dest.replace(/\.js$/, ".ok.js");
      try {
        fs.copyFileSync(dest, backupPath);
        console.log(`💾 Sauvegarde → ${backupPath}`);
      } catch (e) {
        console.warn(`⚠️  Sauvegarde échouée : ${e.message}`);
      }
    }
  }

  // Copie 1 : /local/ha-card-playground.js (legacy)
  if (HA_WWW_DEST) {
    try {
      backupBeforeCopy(HA_WWW_DEST);
      fs.copyFileSync(distFile, HA_WWW_DEST);
      console.log(`✅ Copié → ${HA_WWW_DEST}`);
    } catch (e) {
      console.warn(`⚠️  Copie legacy échouée : ${e.message}`);
    }
  }

  // Copie 2 : /local/community/ha-card-playground/ (HACS)
  if (HA_WWW_HACS_DEST) {
    try {
      backupBeforeCopy(HA_WWW_HACS_DEST);
      fs.copyFileSync(distFile, HA_WWW_HACS_DEST);
      console.log(`✅ Copié → ${HA_WWW_HACS_DEST}`);
    } catch (e) {
      console.error(`❌ Copie HACS échouée : ${e.message}`);
      process.exit(1);
    }
  }
}

// ── 4. Redémarrer HA via REST API ────────────────────────────────────────────
console.log("\n🔄 Redémarrage de Home Assistant...");
try {
  execSync(
    `curl -s -X POST -H "Authorization: Bearer ${HA_TOKEN}" -H "Content-Type: application/json" "${HA_URL}/api/services/homeassistant/restart"`,
    { stdio: "pipe" }
  );
  console.log(`✅ HA redémarre — ouverture du navigateur dans 30 secondes...`);
} catch (e) {
  console.error(`❌ Impossible de contacter HA : ${e.message}`);
  console.error("   Redémarre HA manuellement via l'interface.");
}

// ── 5. Si dev : ouvrir une console avec npm run serve ───────────────────────
function openDevConsole() {
  console.log("\n🖥️  Ouverture du serveur de développement...");
  const winDir = __dirname.replace(/\//g, "\\");
  try {
    execSync(`cmd.exe /c start cmd /k "cd /d "${winDir}" && npm run serve"`, { stdio: "pipe" });
    console.log("✅ Console ouverte → npm run serve");
  } catch (e) {
    console.warn(`⚠️  Impossible d'ouvrir la console : ${e.message}`);
  }
}

if (mode === "dev") {
  openDevConsole();
}

// ── 6. Si prod : ouvrir HA dans le navigateur après le redémarrage ───────────
if (mode === "prod") {
  setTimeout(() => {
    console.log(`🌐 Ouverture de ${HA_URL} ...`);
    try {
      const open = process.platform === "win32" ? "start" :
                   process.platform === "darwin" ? "open" : "xdg-open";
      execSync(`${open} ${HA_URL}`, { stdio: "pipe" });
    } catch (e) {
      console.warn(`⚠️  Impossible d'ouvrir le navigateur : ${e.message}`);
    }
  }, 30_000);
}
