# HA Card Playground — by VDG7

**v0.7.95 · Prévisualisez vos cartes Home Assistant en temps réel — même sur un second écran**

---

Vous avez déjà passé du temps à peaufiner une carte dans Home Assistant, pour réaliser qu'agrandir la zone d'édition fait disparaître l'aperçu ? Vous travaillez "à l'aveugle", sans savoir à quoi ressemble votre carte avant de sauvegarder ?

**HA Card Playground** règle ce problème une bonne fois pour toutes.

C'est un panneau que vous ajoutez dans votre barre latérale Home Assistant. D'un côté vous écrivez votre carte, de l'autre vous la voyez s'afficher en direct — exactement comme elle apparaîtra sur votre vrai tableau de bord. Et si vous avez deux écrans, vous pouvez envoyer l'aperçu sur le second pendant que vous travaillez sur le premier.

---

## Ce que vous pouvez faire avec

### 🔍 Recherche YAML *(Bêta)*

> ⚠️ **Fonctionnalité en bêta-test** — le comportement principal est stable, des cas limites peuvent subsister.

Cliquez sur le bouton **🔍 Chercher** dans la barre de l'éditeur pour ouvrir le popup de recherche, ancré juste sous les contrôles de taille de police.

- **Recherche live** — les résultats s'affichent dès 2 caractères, l'occurrence est centrée dans l'éditeur
- **Navigation** — bouton `↓` ou flèche `↓` : occurrence suivante · bouton `↑` ou flèche `↑` : occurrence précédente · retour automatique au début
- **Entrée** — confirme une suggestion ou saute à l'occurrence suivante
- **Échap** ou `✕` — ferme le popup et efface le surlignage

**Suggestions d'autocomplétion** (par ordre de priorité) :
1. Les `entity_id` référencés dans la carte courante (même extraction que `✓ Vérifier`)
2. Les types de carte présents dans le YAML
3. Les mots bruts du YAML en dernier recours

**Surlignage CodeMirror sur l'occurrence trouvée :**
- Fond rouge sur le texte correspondant
- Bordure gauche rouge sur toute la ligne
- Numéro de ligne en rouge gras (via `GutterMarker`)
- Centrage vertical automatique dans l'éditeur
- Le surlignage disparaît à la fermeture du popup

### Voir votre carte en direct

Dès que vous tapez, votre carte se met à jour automatiquement sous vos yeux (après 400 ms de pause pour ne pas surcharger). Pas besoin de sauvegarder, pas besoin de recharger la page. Ce que vous voyez est exactement ce que vous obtiendrez sur votre tableau de bord — y compris les cartes personnalisées installées via HACS.

Si le YAML contient une erreur ou si un type de carte est introuvable, la même carte d'erreur que HA affiche dans vos tableaux de bord apparaît — pas de message cryptique, juste le rendu natif de Home Assistant.

Si vous changez les paramètres de la carte sans changer son `type:`, la carte est **mise à jour en place** sans recréation — zéro scintillement, zéro perte de l'état visuel.

Vous pouvez aussi choisir la largeur d'affichage de votre carte pour simuler différentes mises en page :

| Preset | Largeur | Équivalent |
|--------|---------|------------|
| 1 col | 1200 px | Toute la largeur |
| 2 col | 600 px | Moitié d'écran |
| 3 col | 400 px | Un tiers |
| 4 col | 300 px | **Défaut HA** |
| 5 col | 240 px | |
| 6 col | 200 px | |
| 8 col | 150 px | |
| 10 col | 120 px | Très étroit |

Ou utilisez le curseur pour régler pixel par pixel (100–1600 px), ou tapez directement un nombre.

### Travailler sur deux écrans

Cliquez sur **↗ Détacher** — l'aperçu s'ouvre dans une nouvelle fenêtre (540×760 px) que vous placez sur votre second écran. La fenêtre détachée charge le frontend complet de Home Assistant, exactement comme votre tableau de bord. Continuez à éditer sur le premier écran — la carte se met à jour en temps réel grâce à l'API BroadcastChannel.

**Zoom dans la fenêtre détachée :**

Une barre fixe en bas à droite vous permet de zoomer :
- `−` / `+` pour diminuer ou augmenter le zoom par pas de 25% (plage 25%–200%)
- `↺` pour revenir à 100%
- Le zoom utilise la propriété CSS `zoom` (et non `transform: scale`) pour que le scroll reste naturel quelle que soit la taille
- Quand le zoom est différent de 100%, un badge **"Aperçu · taille non contractuelle"** s'affiche sous la carte pour rappeler que la taille affichée n'est pas la vraie taille de la carte

Quand vous fermez la fenêtre détachée (ou cliquez **↙ Réintégrer**), l'aperçu revient automatiquement dans le panneau principal et se remet à jour.

### Glisser-déposer vos fichiers YAML

Faites glisser directement un fichier `.yaml` depuis votre explorateur de fichiers sur l'éditeur — son contenu se charge instantanément. Les sauts de ligne Windows (`\r\n`) sont normalisés automatiquement, même depuis un partage Samba (`\\NAS\config`).

Un **badge 📁 nom.yaml** apparaît dans la barre d'outils pour indiquer que vous êtes en mode fichier.

Le bouton **`⬇ Fichier`** vous permet de télécharger le fichier modifié. Le fichier d'origine n'est **jamais écrasé automatiquement** — vous téléchargez une copie, vous remplacez vous-même si vous le souhaitez. Ce bouton devient rouge et est désactivé si des erreurs sont détectées — corrigez-les d'abord.

Le bouton **`🗑 Vider`** efface complètement l'éditeur et quitte le mode fichier.

En mode fichier, l'auto-sauvegarde dans le navigateur est suspendue — pour ne pas polluer votre snapshot normal avec le contenu d'un fichier de configuration.

### Vérifier votre YAML — bouton `✓ Vérifier`

Cliquez sur **`✓ Vérifier`** pour lancer une validation complète. Un panneau s'ouvre avec le détail de chaque vérification. La couleur du bouton reflète le résultat le plus grave : vert ✓ / orange ⚠ / rouge ✗.

Une **vérification automatique** se déclenche 800 ms après chaque modification.

| Vérification | Niveau |
|--------------|--------|
| Syntaxe YAML complète | erreur |
| Tabulations dans le YAML (interdites) | erreur |
| Indentation irrégulière | avertissement |
| Clés HA racines mal indentées (`sensor:`, `homeassistant:`…) | avertissement |
| Accolades `{{` / `}}` mal alignées sur plusieurs lignes | avertissement |
| Crochets `[[[` / `]]]` mal alignés sur plusieurs lignes | avertissement |
| Types de cartes natifs HA reconnus | ok / erreur |
| Cartes HACS chargées dans le navigateur | ok / avertissement |
| Entités référencées présentes dans HA | ok / erreur |
| Services appelés présents dans HA | ok / avertissement |
| Typos dans `!include` | erreur |
| Extension `.yaml`/`.yml` manquante dans `!include` | erreur |
| Cohérence clé ↔ segments du chemin dans `!include` | avertissement |
| Check API HA (`/api/config/core/check_config`) | ok / erreur / avertissement |

Le vérificateur ignore intelligemment les zones de contenu libre : blocs `[[[...]]]` (JavaScript) et scalaires bloc `|` / `>` (templates Jinja2, CSS, scripts…) — seule la structure YAML elle-même est analysée.

### Ne plus jamais perdre votre travail

Tout ce que vous tapez est sauvegardé **automatiquement** dans le navigateur à chaque frappe. Si vous fermez la page par accident ou si le navigateur plante, votre travail est toujours là à la réouverture.

Si l'auto-save vous pose problème (par exemple si un YAML cassé fait planter le panneau au démarrage), vous pouvez le désactiver dans les paramètres ⚙.

**Sauvegarde manuelle :**

Avant de faire une modification importante, cliquez sur **💾 Sauver** — le bouton vire à l'ambré pendant 1 seconde pour confirmer. Si quelque chose tourne mal, **↩ Restaurer** recharge exactement le YAML que vous aviez sauvegardé — le bouton vire à la couleur accent pendant 1 seconde. Ces snapshots survivent aux rechargements de page.

### Autocomplétion intelligente — 12 sources contextuelles (niveau VS Code)

L'éditeur reconnaît le contexte exact de chaque ligne et propose les bonnes suggestions automatiquement, sans jamais mélanger les sources.

**Sur une ligne `type:` ou `- type:`** :

Toutes les cartes natives HA (35+) et vos cartes HACS installées. Filtrage en direct. Les cartes HACS affichent leur nom à droite.

**Au début d'une nouvelle ligne — dans un bloc de carte :**

Dès que vous appuyez sur Entrée après avoir choisi un type, la liste des clés disponibles s'ouvre **automatiquement**. Chaque clé affiche son type à droite. Fonctionne aussi dans les stacks imbriquées.

**Indentation automatique après les clés bloc :**

Appuyer sur Entrée après une clé sans valeur (`tap_action:`, `entities:`, `styles:`…) indente automatiquement de 2 espaces et ouvre le popup de complétion — exactement comme dans VS Code.

**Au début d'une nouvelle ligne — dans `tap_action:` / `hold_action:` / `double_tap_action:` :**

L'éditeur détecte que vous êtes dans un bloc d'action et propose les sous-clés : `action`, `entity`, `service`, `data`, `target`, `navigation_path`, `url`, `confirmation`.

**Sur une ligne `action:`** :

9 valeurs avec leur description : `none`, `more-info`, `toggle`, `call-service`, `perform-action`, `navigate`, `url`, `assist`, `fire-dom-event`.

**Sur une ligne `service:` ou `perform_action:`** :

Tous les **services disponibles dans votre HA en direct** — lus depuis `hass.services`. Format `domain.service_name`, jusqu'à 80 résultats, filtrage live.

**Sur une ligne `color:`, `icon_color:`, `card_color:`…** :

25 couleurs HA nommées (`red`, `blue`, `cyan`, `green`, `amber`, `warning`, `error`…) + variables CSS HA (`var(--primary-color)`, `var(--accent-color)`…).

**Sur une ligne `icon:`** :

La **totalité de la bibliothèque MDI — 7447 icônes** — toutes les icônes disponibles dans HA. Chaque suggestion affiche un **vrai aperçu SVG** via `<ha-icon>`. Tapez `mdi:light` ou juste `light`. Fonctionne aussi dans les attributs HTML Lovelace (`icon="mdi:..."`).

**Pour `custom:ha-canvas-card`** :

Schéma complet pour cette carte de positionnement libre en pixels :
- Clés racine : `background`, `height`, `cards`
- Dans un item de la liste `cards:` : `x`, `y`, `w`, `h`, `right`, `bottom`, `z`, `opacity`, `card` — avec descriptions de positionnement
- Le preview applique automatiquement une hauteur fixe (700 px par défaut) pour éviter l'effondrement à 0 px dû au `height: 100%`

**Sur une ligne `attribute:` ou `state_attribute:`** :

Les **attributs réels** de l'entité déclarée dans la même carte, avec leur valeur actuelle.

**À l'intérieur de `{{ ... }}` ou `{% ... %}`** :

**35 fonctions Jinja2 HA** : `states()`, `state_attr()`, `is_state()`, `now()`, `utcnow()`, `relative_time()`, `float()`, `int()`, `iif()`, `expand()`, `area_entities()`, `device_id()`… La signature complète s'affiche à droite. Fonctionne dans les cartes `markdown:`, les templates `button-card`, les conditions.

**À l'intérieur d'un bloc `style: |` ou `extra_styles: |`** :

**60+ propriétés CSS** + **variables CSS HA** (`--ha-card-border-radius`, `--mdc-icon-size`, `--primary-color`…). Activé seulement en position de propriété (avant le `:`).

**Sur les clés à valeur fixe — directement après les `:`** :

L'éditeur reconnaît les clés booléennes et les clés à valeurs enumérées et propose immédiatement les choix valides :

| Type de clé | Exemples de clés | Valeurs proposées |
|-------------|-----------------|-------------------|
| Booléen | `show_name`, `show_icon`, `state_color`, `show_header`, `fill_container`… | `true` / `false` |
| Format d'affichage | `secondary_info` | `last-changed`, `last-updated`, `attribute`, `state`, `none`… |
| Format nombre/date | `format` | `none`, `relative`, `total`, `date`, `time`, `datetime`, `duration`… |
| Ratio d'aspect | `aspect_ratio` | `1/1`, `2/1`, `16/9`, `4/3`… |
| Disposition | `layout` | `vertical`, `horizontal`, `default`, `icon_only`… |
| Graphique | `chart_type` | `line`, `bar` |
| Période stats | `period` | `5minute`, `hour`, `day`, `week`, `month` |
| Mise à jour | `triggers_update` | `all` + toutes vos entités |

Filtrage T9 : tapez `tr` sur `show_name:` → seul `true` reste. Tapez `la` sur `secondary_info:` → `last-changed` et `last-updated`.

**Sur toutes les autres lignes de valeur** :

Les identifiants d'entités de votre HA avec leur état actuel + unité. Jusqu'à 80 résultats.

**Comportement commun :**
- Survol souris : surlignage au passage (`#4d78cc` sombre / `#2563eb` clair), fonctionne dans le Shadow DOM de HA
- Navigation clavier : `↑` / `↓` pour se déplacer, `Entrée` ou `Tab` pour valider, `Échap` pour fermer
- `Ctrl+Espace` force l'ouverture à tout moment, même sur une ligne vide

### Éditer les couleurs visuellement

Chaque valeur de couleur hexadécimale dans votre YAML — qu'elle soit au format `#rgb`, `#rrggbb` ou `#rrggbbaa` — affiche automatiquement un **petit carré coloré cliquable** juste avant la valeur dans l'éditeur :

- Cliquez sur le carré → un sélecteur de couleur natif s'ouvre
- Déplacez le curseur dans le picker → la valeur hex dans l'éditeur se met à jour **en temps réel**
- Fermez le picker → la valeur est finalisée
- Le carré se met à jour immédiatement si vous changez la valeur à la main dans l'éditeur

### Un éditeur agréable à utiliser

**Coloration syntaxique complète** — chaque élément YAML a sa propre couleur pour repérer les erreurs d'un coup d'œil :
- **Clés YAML** (`type:`, `entity:`, `name:`…) → cyan en thème sombre, bleu en thème clair
- **Valeurs simples** (texte, nombres, entity IDs) → jaune en thème sombre, vert en thème clair
- **Booléens et null** (`true`, `false`, `yes`, `no`, `on`, `off`, `null`, `~`) → magenta — couleur distincte pour les repérer immédiatement
- **Commentaires** → gris italique
- **Expressions JavaScript** dans les blocs `[[[` … `]]]` (button-card, etc.) → colorées en orange/magenta/gris selon la syntaxe JS

**Taille du texte** : boutons `A−` et `A+` pour ajuster de 10 à 28 px, `↺` pour revenir à 14 px. La taille est mémorisée.

**⌥ Format** : reformate et ré-indente tout votre YAML en un clic — pratique quand le code est mal aligné. Si le YAML est invalide, rien ne se passe.

**⎘ Copier** : copie la sélection active si vous avez sélectionné du texte, sinon copie tout le YAML. Le bouton vire au vert pendant 1 seconde.

**⎘ Coller** : active le focus dans l'éditeur et affiche "→ Ctrl+V" pendant 1,5 seconde (le navigateur interdit le collage automatique pour des raisons de sécurité).

**⇥ / ⇤** : indente ou désindente la sélection de 2 espaces.

**Séparateur glissable** : faites glisser la barre entre l'éditeur et l'aperçu pour ajuster la répartition (de 20% à 80%). La barre change de couleur au survol et pendant le glissement.

**◀ Plein écran / ▶ Aperçu** : masque complètement l'aperçu pour maximiser l'espace d'édition, ou le restaure.

---

## Référence des boutons de la barre d'outils

La barre s'adapte automatiquement — les boutons passent à la ligne si la fenêtre est trop étroite.

| Bouton | Action | Retour visuel |
|--------|--------|---------------|
| 🔍 Chercher *(Bêta)* | Ouvrir le popup de recherche YAML | Surligné tant qu'ouvert |
| 📁 `nom.yaml` | Badge mode fichier (après glisser-déposer) | — |
| ⬇ Fichier | Télécharger le fichier modifié | Vert "✓ Téléchargé" · Rouge "✗ Erreurs" si erreurs |
| 💾 Sauver | Sauvegarder un instantané manuel | Ambré "✓ Sauvé" pendant 1 s |
| 🗑 Vider | Vider l'éditeur + quitter le mode fichier | — |
| ↩ Restaurer | Revenir au dernier instantané | Accent "✓ Restauré" pendant 1 s |
| ⎘ Copier | Copier la sélection ou tout le YAML | Vert "✓ Copié" pendant 1 s |
| ⎘ Coller | Focus éditeur pour Ctrl+V | Bleu "→ Ctrl+V" pendant 1,5 s |
| ⌥ Format | Reformater et ré-indenter le YAML | Ambré "✓ Formaté" pendant 1 s |
| ✓ Vérifier | Vérifier le YAML + ouvrir/fermer le panneau | Vert / Orange / Rouge |
| ⇥ | Indenter la sélection (+2 espaces) | — |
| ⇤ | Désindenter la sélection (−2 espaces) | — |
| A− | Réduire la taille du texte (min 10 px) | — |
| `Xpx` | Indicateur de taille actuelle | — |
| A+ | Augmenter la taille du texte (max 28 px) | — |
| ↺ | Réinitialiser la taille du texte (14 px) | — |

---

## Paramètres disponibles (⚙)

| Paramètre | Défaut | Description |
|-----------|--------|-------------|
| Largeur colonne Desktop | 300 px | Presets 1–10 col + curseur + saisie directe |
| Thème clair | Désactivé | Bascule l'éditeur et l'aperçu en mode clair |
| Sauvegarde automatique | Activé | Écrit le YAML dans le navigateur à chaque frappe |
| Éditeur plein écran au détachement | Désactivé | Étend automatiquement l'éditeur à la détachement |

---

## Comment l'installer

L'installation se fait en quelques clics depuis **HACS**, le gestionnaire d'extensions de Home Assistant.

1. Ouvrez **HACS** dans votre Home Assistant
2. Cliquez sur les trois points → **Dépôts personnalisés**, ajoutez `https://github.com/vdgced/ha-card-playground` en type **Interface**
3. Cherchez **HA Card Playground** et installez-le
4. Ajoutez ceci dans votre `configuration.yaml` :

```yaml
panel_custom:
  - name: ha-card-playground
    sidebar_title: Card Playground
    sidebar_icon: mdi:palette
    url_path: card-playground
    module_url: /local/community/ha-card-playground/ha-card-playground.js
```

5. **Redémarrez Home Assistant** — le panneau **Card Playground** apparaît dans votre barre latérale

---

## Comment l'utiliser au quotidien

Ouvrez le panneau **Card Playground** depuis la barre latérale. Collez ou tapez votre YAML — l'aperçu apparaît immédiatement à droite. Utilisez **🔍 Chercher** *(Bêta)* pour rechercher n'importe quel texte dans le YAML avec surlignage en direct. Travaillez, ajustez, peaufinez. Quand vous êtes satisfait, copiez le résultat avec **⎘ Copier** et collez-le dans votre vrai tableau de bord.

Avant de tenter quelque chose de risqué, pensez à cliquer sur **💾 Sauver**. Si ça ne donne pas le résultat voulu, **↩ Restaurer** vous ramène à votre point de départ en un clic.

---

## Ce dont vous avez besoin

- Home Assistant installé et fonctionnel
- L'extension HACS installée sur votre Home Assistant

---

*Développé avec ❤️ par VDG7 — Licence libre MIT*
