# Changelog — HA Card Playground

Toutes les modifications validées, par version. Les tentatives abandonnées ou les chemins qui n'ont pas fonctionné ne sont pas listés ici.

---

## En cours — Corrections et améliorations (non releasé)

### 🔍 Chercher — Recherche YAML avec highlight

Remplace le bouton **📋 Snippets** (supprimé entièrement, code inclus).

- **Bouton `🔍 Chercher`** dans la barre éditeur, à la même position que Snippets
- **Popup de recherche** ancrée sous la zone de taille de police (`A−` / `14px` / `A+` / `↺`)
- **Recherche automatique** dès 2 caractères tapés — occurrence trouvée et centrée en temps réel
- **Navigation** : boutons `↑` / `↓` dans le popup + flèches clavier (quand aucune suggestion sélectionnée)
- **Occurrence suivante** : `↓` ou `Entrée` — **occurrence précédente** : `↑` — wraparound automatique
- **Autocomplétion** : suggestions issues des `entity_id` et types de carte du YAML courant (même extraction que `✓ Vérifier`), complété par les mots bruts du YAML
- **Fermeture** : `Échap`, bouton `✕`, ou re-clic sur `🔍 Chercher`

**Surlignage triple de l'occurrence trouvée :**
- **Numéro de ligne en rouge gras** via `GutterMarker` + `gutterLineClass`
- **Bordure gauche rouge** sur toute la ligne (`Decoration.line`)
- **Fond rouge sur le mot** recherché (`Decoration.mark`)
- Centrage vertical automatique (`EditorView.scrollIntoView` avec `y: 'center'`)
- Le surlignage disparaît à la fermeture du popup

**Implémentation :** `StateEffect` + `StateField` + `Decoration.mark` / `Decoration.line` + `GutterMarker` — tout défini au niveau module. `_doSearch(text, fromStart?)` / `_doSearchPrev(text)` / `_closeSearch()` / `_getSearchSuggestions(prefix)` / `_selectSuggestion(word)`.

---

### Palette de couleurs — s'ouvrait dans le coin supérieur gauche

- **Bug** : le `<input type="color">` invisible était créé sans dimensions (`width:0;height:0`) et le `.click()` était appelé avant le recalcul du layout → le picker natif s'ancrait à `0,0`
- **Fix** : `width:1px;height:1px` + `opacity:0.01` + `requestAnimationFrame(() => input.click())` — le layout est calculé avant l'ouverture du picker, qui s'ouvre maintenant au niveau du swatch cliqué

### Zoom aperçu — curseur 10%–200% pas de 2%

- Aperçu inline : curseur `<input range>` + boutons −/+ (pas de 2%) + bouton ↺ reset dans la barre aperçu
- Fenêtre détachée : même curseur ajouté dans la barre flottante de zoom (remplace les anciens pas de 25%)
- Appliqué via `zoom` CSS sur `.preview-frame` — le layout recalcule autour de la carte

### Interface — refonte barre toolbar

- **Boutons unifiés** : même gabarit partout (`padding: 5px 14px`, `font-size: 13px`, `border-radius: 6px`) — hauteur identique header / éditeur / aperçu
- **Header épuré** : uniquement le titre — les boutons action déplacés dans la barre aperçu
- **Barre aperçu** : `APERÇU` · largeur px · zoom − ▬ + % ↺ · `◀ Plein écran` · `↗ Détacher` · `⚙` avec panneau paramètres intégré
- **Séparateur colonne** : minimum fixe à 62% — ne peut pas aller plus à gauche, boutons toujours visibles
- **Palette de couleurs** : s'ouvre maintenant au niveau du swatch cliqué (corrigé `position:fixed` + `requestAnimationFrame`)

### Vérificateur YAML — faux positifs types de cartes HACS

- **Bug** : certaines cartes HACS s'enregistrent via `customElements.define()` sans se déclarer dans `window.customCards` → signalées comme introuvables malgré leur présence dans HA
- **Fix** : double vérification — `window.customCards` d'abord, puis `customElements.get(tagName)` comme source de vérité réelle (même logique que le rendu dans `_mountCard`)

### Vérificateur YAML — faux positifs templates button-card

- **Bug** : les valeurs `[[[return variables.xxx]]]` dans `entity:` ou `entity_id:` contenaient un `.` → le checker les signalait comme entités introuvables dans HA
- **Fix** : guards ajoutés dans `_extractEntityIds` — une valeur est ignorée si elle contient `[[[`, `{{` ou un espace (jamais présents dans un vrai entity_id)

### Inspection bidirectionnelle carte ↔ YAML (bouton 🔍)

- **YAML → Carte** : déplacer le curseur sur une ligne avec une valeur (`entity: light.salon`, `name: Mon titre`…) encadre automatiquement en bleu les éléments correspondants dans l'aperçu — traverse récursivement tous les Shadow DOM des custom elements
- **Carte → YAML** : activer le mode 🔍 (bouton passe en bleu), cliquer sur n'importe quel élément de la carte → le curseur saute directement à la ligne correspondante dans l'éditeur et sélectionne la valeur
- **Implémentation** : `elementsFromPoint` avec traversal récursif des `shadowRoot` (shadow DOM piercing), `getBoundingClientRect()` pour le positionnement des overlays, overlay `position:absolute` dans `.preview-frame` (coordonnées divisées par le zoom)
- Fonctionne sur toutes les cartes HA natives et HACS, quelle que soit la profondeur du Shadow DOM

### Vérificateur YAML — déduplication avec comptage (types, entités, services)

- **Bug** : une carte avec 36× `custom:button-card` affichait 36 lignes identiques dans le panel
- **Fix** : `Map<string, count>` pour types, entités et services — chaque élément unique apparaît **une seule fois** avec `×N` si présent plusieurs fois (ex: `"custom:button-card" ×36 — carte HACS détectée`)
- Appliqué sur les 3 sections : types de cartes, entités HA, services HA

### Interface — barre de contrôles unifiée (unified toolbar)

- **Architecture** : tous les boutons (éditeur YAML + contrôles aperçu) sont regroupés dans une **unique barre pleine largeur** (`unified-toolbar`) placée au-dessus du split
- Le workspace en dessous ne contient plus que les zones de contenu pures : éditeur CodeMirror à gauche, aperçu carte à droite
- **Résultat** : tirer le séparateur de colonne n'affecte jamais les boutons — seuls le code et l'aperçu bougent
- Séparateur visuel (`toolbar-sep`) entre la section éditeur et la section aperçu
- La section aperçu (zoom, ◀ Plein écran, ↗ Détacher, ⚙) est toujours visible à droite, même quand l'aperçu est masqué

### Bouton "Plein écran" — impossible de revenir à l'aperçu splitté

- **Bug** : cliquer "◀ Plein écran" masquait la `.preview-pane` entière, emportant avec elle le bouton "▶ Aperçu" — pas moyen de restaurer le split
- **Fix** : le bouton "▶ Aperçu" apparaît directement dans la toolbar **éditeur** (en couleur primary) quand le plein écran est actif — l'éditeur ne disparaissant jamais, le bouton reste toujours accessible

### Aperçu temps réel — `styles:` ne se mettait pas à jour

- **Bug** : modifier `styles:` (ex. `grid-template-areas`) ne recréait pas l'aperçu — button-card mémoïse ses styles compilés, `setConfig` seul ne forçait pas la recompilation
- **Fix** : comparaison `JSON.stringify(config.styles)` entre deux renders (`_lastStylesKey`) — si `styles` change → recréation complète de l'élément ; sinon → fast path `setConfig` conservé (pas de flickering pour les changements d'entité, variables, etc.)

---

## v0.7.91 — Glisser-déposer fichier + vérificateur YAML + toolbar responsive

### Glisser-déposer fichier YAML

- Glisser un fichier `.yaml` sur la zone éditeur charge son contenu directement
- Normalisation CRLF → LF automatique (fichiers Windows/Samba `\\NAS\config`)
- **Badge fichier** `📁 nom.yaml` apparaît dans la toolbar — mode fichier actif
- Bouton **`⬇ Fichier`** — télécharge le fichier modifié via `<a download>` (jamais de re-sauvegarde automatique sur le fichier d'origine)
- Bouton `⬇ Fichier` désactivé (rouge) si des erreurs sont présentes dans le vérificateur
- Bouton **`🗑 Vider`** — vide complètement l'éditeur, réinitialise le mode fichier
- **Fix doublement contenu** : les listeners `dragover` et `drop` utilisent `{ capture: true }` — intercepte l'événement avant que CodeMirror (qui a son propre handler drop interne) ne le reçoive ; `stopPropagation()` empêche la double insertion

### Vérificateur YAML — bouton `✓ Vérifier`

Panneau déroulant sous le bouton, coloré selon le résultat le plus grave (`✓ OK` vert / `⚠ Warnings` orange / `✗ Erreurs` rouge).
Auto-check déclenché 800 ms après chaque modification (debounce).

**Checks effectués :**

| Check | Type |
|-------|------|
| Syntaxe YAML (parse complet) | error |
| Tabulations dans le YAML | error |
| Indentation irrégulière (non-multiple de la base) | warn |
| Clés HA racines mal indentées (`homeassistant:`, `sensor:`, etc.) | warn |
| Alignement `{{` / `}}` sur lignes séparées | warn |
| Alignement `[[[` / `]]]` sur lignes séparées | warn |
| Types de cartes natifs HA reconnus | ok/error |
| Types HACS chargés dans le navigateur | ok/warn |
| Entités référencées existantes dans HA | ok/error |
| Services appelés existants dans HA | ok/warn |
| `!include` — typos dans le mot-clé | error |
| `!include` — extension `.yaml`/`.yml` manquante | error |
| `!include` — cohérence clé ↔ segments du chemin | warn |
| Check API HA (`/api/config/core/check_config`) | ok/error/warn |

**Masque de lignes ignorées par le vérificateur d'indentation :**
- Blocs `[[[...]]]` (JavaScript button-card) — détection par délimiteurs texte
- Scalaires bloc `|` / `>` — détection par niveau d'indentation (toutes les lignes plus indentées que la ligne indicatrice sont ignorées — couvre templates Jinja2, CSS multi-lignes, scripts)

**Cohérence `!include` clé / chemin :**
Tous les segments du chemin sont vérifiés (pas seulement le nom de fichier) — `carte_multiroom: !include packages/carte_multiroom/_package.yaml` est correct car le segment de répertoire `carte_multiroom` correspond à la clé.

**Types natifs HA complets :**
Ajout de `entities` et `picture-elements` qui manquaient dans la liste des cartes natives.

### Toolbar responsive

- `.font-ctrl` : `flex-wrap: wrap` + `justify-content: flex-end` — les boutons passent à la ligne si la fenêtre est trop étroite
- Titre "Éditeur YAML" aligné en haut (`align-items: flex-start`) quand la toolbar est sur plusieurs lignes

### Dev/prod switching avec redémarrage HA automatique

- `npm run use:dev` → `module_url: http://192.168.0.17:5500/...` + build watch + redémarre HA via REST API
- `npm run use:prod` → build + copie NAS + `module_url: /local/ha-card-playground.js` + redémarre HA
- Script `switch-mode.mjs` — lit/écrit `configuration.yaml` sur Samba, appelle `POST /api/services/homeassistant/restart`
- Avantage prod : pas de popup de sécurité au détachement fenêtre (même origine que HA)

### Corrections mineures

- YAML par défaut au chargement : carte `markdown` générique — suppression de `weather.seraing` (entité spécifique à un utilisateur)
- Variable `item` inutilisée supprimée du drop handler

---

## v0.7.90 — Autocomplétion valeurs scalaires + indentation automatique

### Valeurs scalaires directement après `:`

Nouvelle source `_scalarValueComplete` — 12e source dans l'`override` array, positionnée avant `_haComplete`.

**Clés booléennes** (26 clés reconnues) → `true` / `false` immédiatement après les `:` :
- `show_name`, `show_icon`, `show_state`, `show_label`, `show_units`, `show_last_changed`, `show_entity_picture`, `show_header`, `state_color`, `show_attribute_icon`, `logarithmic_scale`, `hide_legend`, `show_names`, `fill_container`, `use_entity_picture`, `use_media_artwork`, `show_volume_level`, `hide_state`, `vertical`, `hold_action_repeat`, `selectable`, `scrolling`, `hour24`, `show_camera`, `dark_mode`, `auto_fit`, `read_only`, `show_current_as_primary`, `show_indicator`

**Clés enum** (10 clés reconnues) → valeurs avec description contextuelle :
| Clé | Valeurs proposées |
|-----|-------------------|
| `secondary_info` | `last-changed`, `last-updated`, `attribute`, `state`, `none`, `entity-id`, `position`, `tilt-position`, `brightness`, `volume-level` |
| `format` | `none`, `relative`, `total`, `date`, `time`, `datetime`, `duration`, `precision`, `kilo`, `hecto`, `deca`, `deci`, `centi`, `milli` |
| `aspect_ratio` | `1/1`, `2/1`, `1/2`, `16/9`, `9/16`, `4/3`, `3/4` |
| `layout` | `vertical`, `horizontal`, `default`, `icon_only`, `name_only`, `label_only`, `icon_name`, `name_state` |
| `color_type` | `icon`, `card`, `label`, `blank-card`, `label-card` |
| `chart_type` | `line`, `bar` |
| `period` | `5minute`, `hour`, `day`, `week`, `month` |
| `stat_types` | `mean`, `min`, `max`, `sum`, `state`, `change` |
| `initial_view` | `dayGridMonth`, `dayGridDay`, `listWeek` |
| `state_content` | `state`, `last-changed`, `last-updated` |
| `alignment` | `start`, `end`, `center`, `justify` |
| `bubble_card_type` | `button`, `separator`, `cover`, `select`, `empty-column`, `horizontal-buttons-stack`, `pop-up` |
| `camera_view` | `auto`, `live` |
| `triggers_update` | `all` (+ entités HA via `_haComplete` en parallèle) |

**Comportement :**
- `_scalarValueComplete` se déclenche dès que le curseur est après `clé:` (avec ou sans espace)
- Filtrage T9 : taper `tr` sur `show_name:` → seul `true` reste ; taper `la` sur `secondary_info:` → `last-changed` et `last-updated`
- `validFor: /[a-z]*/` (booléens) ou `validFor: /[\w\/.-]*/` (enums) — le popup reste ouvert en continuant de taper
- `_haComplete` est bloqué pour toutes les clés booléennes et enum pures (sauf `triggers_update` qui accepte les deux)

### Correction `_haComplete` — extraction valeur après `:`

- **Avant** : `ctx.matchBefore(/[\w.:-]*/)` capturait `"triggers_update:"` entier → `typed = "triggers_update:"` → aucune entité ne matchait → dropdown vide
- **Après** : `ctx.matchBefore(/[\w.:-]*$/)` + `lastIndexOf(':')` → extrait uniquement la partie valeur après le dernier `:` → `triggers_update:` → `typed = ""` → toutes les entités s'affichent

### Correction `_keyComplete` — `matchBefore` ancré à la fin

- **Avant** : `ctx.matchBefore(/[\w-]+/)` sur `"  - na"` capturait `"- na"` (depuis le premier `-`) → `typed = "- na"` → aucune clé ne matchait `"-"`
- **Après** : `ctx.matchBefore(/[\w-]*$/)` → ancré à la fin → capturant uniquement `"na"` → filtrage correct

### Indentation automatique après les clés bloc YAML

Handler `Enter` personnalisé ajouté en tête du keymap (priorité absolue avant `defaultKeymap`).

**Déclenchement** : quand la ligne courante se termine par `clé:` sans valeur (ex: `tap_action:`, `entities:`, `styles:`)

**Comportement** :
- Insert `\n` + indentation courante + 2 espaces supplémentaires
- `startCompletion` se déclenche automatiquement via `updateListener` (catch-all `[\w-]+:\s*`)
- Résultat : Enter sur `tap_action:` → curseur à `  ` (2 espaces de plus) + popup autocomplete avec les sous-clés d'action ouvert

Si la ligne a déjà une valeur ou la sélection est non-vide → `return false` → `defaultKeymap` reprend le contrôle.

---

## v0.7.89 — Cartes HACS, `service_data:` réel, `navigation_path:` depuis Lovelace

### Clés des grandes cartes HACS populaires
- **`custom:bubble-card`** — 23 clés : `card_type`, `entity`, `name`, `icon`, `icon_color`, `sub_button`, `tap_action`, `hold_action`, `styles`, `scrolling_effect`, `columns`, `auto_close`, `margin_top_mobile`, `hash`, `button_type`, `state_display`…
- **`custom:mushroom-entity-card`** — clés communes mushroom : `entity`, `name`, `icon`, `icon_color`, `primary_info`, `secondary_info`, `badge_icon`, `badge_color`, `layout`, `fill_container`, `tap_action`, `hold_action`, `double_tap_action`, `card_mod`
- **`custom:mushroom-template-card`** — `primary`, `secondary`, `icon`, `icon_color`, `badge_icon`, `picture`, `multiline_secondary`… (tout en template)
- **`custom:mushroom-light-card`** — `show_brightness_control`, `show_color_temp_control`, `show_color_control`, `use_light_color`
- **`custom:mushroom-climate-card`** — `show_temperature_control`, `hvac_modes`
- **`custom:mushroom-chips-card`** — `chips`, `alignment`
- **`custom:mushroom-media-player-card`** — `use_media_artwork`, `show_volume_level`, `media_controls`, `volume_controls`
- **`custom:mushroom-person-card`**, **`custom:mushroom-cover-card`**, **`custom:mushroom-alarm-control-panel-card`**
- **`custom:mini-graph-card`** — 20 clés : `entities`, `hours_to_show`, `points_per_hour`, `aggregate_func`, `line_color`, `line_width`, `animate`, `show`, `color_thresholds`, `group_by`, `logarithmic`…
- **`custom:apexcharts-card`** — `series`, `graph_span`, `chart_type`, `stacked`, `update_interval`, `header`, `yaxis`, `apex_config`, `span`
- **`custom:auto-entities`** — `card`, `filter`, `sort`, `show_empty`, `unique`, `card_param`

### `service_data:` / `data:` — champs réels depuis `hass.services`
- Nouvelle détection `_getParentBlockKey` : détecte si le curseur est dans un bloc `target:`, `service_data:`, ou `data:`
- Dans `service_data:` / `data:` : `_getServiceAtCursor` remonte le bloc pour trouver la valeur de `service:` ou `perform_action:`, puis lit `hass.services[domain][service].fields`
- Chaque champ du service affiché avec sa description tronquée à 50 chars dans la colonne detail — **toujours synchronisé avec les services réels de l'instance HA**
- Fallback `entity_id` si le service n'est pas trouvé

### `target:` — sous-clés standards
- Dans un bloc `target:` : propose `entity_id`, `device_id`, `area_id`, `label_id`, `floor_id`

### `navigation_path:` — vues et panneaux HA en direct
- Nouvelle source `_navPathComplete` : activée sur `navigation_path:` et `url_path:`
- Lit les **vues Lovelace** depuis la config HA en mémoire (`__lovelace.config.views`) — format `/lovelace/path`
- Lit les **panneaux sidebar** depuis `hass.panels` — `/energy`, `/map`, `/logbook`, `/history`…
- Suggestions statiques si la config n'est pas accessible (premier chargement)
- 11 sources dans l'override array : `typeComplete → keyComplete → actionValueComplete → serviceComplete → navPathComplete → colorComplete → iconComplete → attributeComplete → templateComplete → cssComplete → haComplete`

---

## v0.7.88 — Cascade universelle : autocomplétion à chaque `Entrée`

### Déclenchement automatique après chaque `Entrée` dans un contexte connu
- Le listener `updateListener` détecte maintenant 6 catégories de contexte sur la ligne précédente et appelle `startCompletion()` automatiquement après insertion d'un saut de ligne :

| Contexte détecté | Ce qui s'ouvre |
|---|---|
| `type: xxx` | Clés de la carte |
| `tap_action:` / `hold_action:` / `double_tap_action:` (bloc vide) | Sous-clés d'action |
| `action: xxx` / `service: xxx` / `navigation_path: xxx`… | Prochaine sous-clé d'action |
| `styles:` / `state_styles:` (bloc vide) | Éléments (`card`, `icon`, `grid`…) |
| `card:` / `icon:` / `grid:`… sous `styles:` | Propriétés CSS |
| `- property: value` (item CSS liste) | Prochaine propriété CSS |
| Clés de carte communes : `entity:`, `name:`, `icon:`, `color:`, `show_name:`… | Prochaine clé |

- Résultat : l'éditeur "écrit avec l'utilisateur" — chaque `Entrée` dans un bloc ouvre immédiatement la liste suivante sans `Ctrl+Space`
- Les sources ont leurs propres guards → aucun risque de suggestion incorrecte en cas de faux déclenchement

### Cascade `icon:` → `mdi:` → icônes
- `icon:` vide → propose `mdi:` immédiatement
- Dès que `mdi:` est inséré → liste des 7447 icônes s'ouvre automatiquement (80ms après insertion)

---

## v0.7.87 — Autocomplétion `custom:button-card` — clés, `styles:`, CSS liste

### Clés `custom:button-card`
- Ajout de `custom:button-card` dans `_CARD_KEYS` : 30+ clés avec descriptions — `entity`, `name`, `icon`, `color`, `color_type`, `size`, `show_name`, `show_icon`, `show_state`, `show_label`, `label`, `state_display`, `triggers_update`, `tap_action`, `hold_action`, `double_tap_action`, `styles`, `state`, `custom_fields`, `extra_styles`, `variables`, `template`, `layout`…
- Dès que le type est `custom:button-card`, Entrée après le `type:` ouvre la liste complète

### Éléments du bloc `styles:`
- Nouvelle détection `_getStylesBlockLevel` : remonte deux niveaux depuis le curseur pour identifier si on est directement sous `styles:` (niveau "element") ou dans un élément (niveau "css")
- Au niveau "element" → liste les 10 sous-éléments disponibles : `card`, `icon`, `name`, `state`, `label`, `grid`, `img_cell`, `custom_fields`, `lock`, `entities_area`
- Fonctionne aussi pour `state_styles:` et `styles_javascript:`

### CSS en format liste YAML (`- property: value`)
- Au niveau "css" (dans `card:`, `icon:`, `grid:`…) → propose les 60+ propriétés CSS + variables HA comme clés YAML
- Format attendu : `- background-color: red`, `- border-radius: 5px`, `- grid-template-areas: |`
- Inclut les propriétés grid : `grid-template-areas`, `grid-template-rows`, `grid-template-columns`, `justify-self`, `align-self`
- Priorité 0 dans `_keyComplete` — avant les clés de carte et les blocs action

---

## v0.7.86 — Autocomplétion VS Code-like : actions, services, couleurs, templates, CSS

### Sous-clés `tap_action` / `hold_action` / `double_tap_action`
- Nouvelle source `_keyComplete` étendue : quand le curseur est dans un bloc `tap_action:` / `hold_action:` / `double_tap_action:`, la liste des sous-clés s'ouvre automatiquement : `action`, `entity`, `service`, `data`, `service_data`, `target`, `navigation_path`, `url`, `confirmation`
- Détection via `_getActionBlockAtCursor` : remonte les lignes depuis le curseur, s'arrête au premier ancêtre avec un indent inférieur — si c'est un bloc action, retourne ses clés
- Intégré dans `_keyComplete` (priorité 1, avant la détection de type de carte)

### Valeurs `action:` (`_actionValueComplete`)
- Sur toute ligne `action:`, propose les 9 valeurs HA : `none`, `more-info`, `toggle`, `call-service`, `perform-action`, `navigate`, `url`, `assist`, `fire-dom-event`
- Description contextuelle dans la colonne detail pour chaque valeur

### Services HA (`_serviceComplete`) — 7447 icônes MDI
- Nouvelle source `_serviceComplete` : activée sur les lignes `service:` et `perform_action:`
- Source : `hass.services` — liste tous les services disponibles dans l'instance HA en direct, format `domain.service_name`
- Jusqu'à 80 résultats, filtrage live, domaine affiché dans la colonne detail
- Seuil : 2 caractères tapés ou `Ctrl+Space`

### Couleurs HA nommées (`_colorComplete`)
- Nouvelle source `_colorComplete` : activée sur `color:`, `icon_color:`, `card_color:`, `badge_color:`, `label_color:`, `accent_color:`, `background_color:`
- 25 couleurs HA nommées (matériel design + semantic : `red`, `pink`, `purple`, `blue`, `cyan`, `green`, `amber`, `orange`, `warning`, `error`, `success`…) + variables CSS HA (`var(--primary-color)`, `var(--accent-color)`…)

### Templates Jinja2 HA (`_templateComplete`)
- Nouvelle source `_templateComplete` : activée quand le curseur est à l'intérieur de `{{ ... }}` ou `{% ... %}`
- **35 fonctions HA** : `states()`, `state_attr()`, `is_state()`, `has_value()`, `now()`, `utcnow()`, `today_at()`, `relative_time()`, `float()`, `int()`, `iif()`, `expand()`, `area_entities()`, `device_id()`, `label_id()`, `namespace()`, etc.
- Description complète de chaque fonction dans la colonne detail (signature + comportement)
- Fonctionne dans les cartes `markdown:`, dans les templates `button-card`, dans les conditions `conditional:`

### CSS dans les blocs `style: |` (`_cssComplete`)
- Nouvelle source `_cssComplete` : activée quand le curseur est dans un bloc scalaire `style: |` ou `extra_styles: |`
- Détection via `_getStyleBlockAtCursor` : remonte les lignes jusqu'au premier `style: |` avec un indent inférieur
- **60+ propriétés CSS** + variables CSS HA : `background-color`, `border-radius`, `box-shadow`, `display`, `flex`, `padding`, `margin`, `transform`, `transition`, `--ha-card-border-radius`, `--mdc-icon-size`, `--primary-color`…
- Activé seulement en position de propriété (avant tout `:` sur la ligne)

### Architecture
- Ordre des sources : `typeComplete → keyComplete → actionValueComplete → serviceComplete → colorComplete → iconComplete → attributeComplete → templateComplete → cssComplete → haComplete`
- Chaque source est mutuellement exclusive grâce à ses guards (regex + contexte)

---

## v0.7.85 — Aperçu icônes MDI réel + bibliothèque complète (7447 icônes)

### Bibliothèque MDI complète
- Remplacement de la liste curated (~250 icônes) par la **totalité de `@mdi/js`** : 7447 icônes en kebab-case
- Fichier `src/mdi-icon-names.ts` généré automatiquement depuis `@mdi/js` — ne pas éditer à la main
- Toutes les icônes MDI disponibles dans HA sont désormais proposées, y compris `mdi:harddisk`, `mdi:led-strip`, etc.

### Aperçu icône via `<ha-icon>` (côté droit)
- Chaque suggestion `icon:` affiche un **vrai rendu SVG** de l'icône via `<ha-icon>` dans la colonne droite
- Injection via boucle `requestAnimationFrame` + marqueur `dataset.haIconInjected` pour éviter les doublons
- Icône positionnée à droite via `margin-left:auto` dans un conteneur flex
- Couleur état : `#59bec2` (thème sombre) / `#0550ae` (thème clair) — identique aux clés YAML

### Suppression des emoji ⬡ et detail — icône MDI seule
- Retrait du bloc `EditorView.baseTheme` qui surchargeait `cm-completionIcon-variable/keyword/property::after` avec le symbole `⬡` — les icônes par défaut CodeMirror (lettre) sont restaurées pour les sources non-MDI
- La colonne `detail` ne contient plus d'emoji redondants — le rendu `<ha-icon>` natif HA à droite suffit comme aperçu visuel
- **7447 icônes MDI** disponibles dans l'autocomplétion `icon:` (bibliothèque complète `@mdi/js`)

### Support HTML `icon="mdi:..."` 
- `_iconComplete` s'active aussi sur les attributs HTML de template Lovelace : `icon="mdi:` 
- Regex étendue pour détecter `icon="mdi:` en plus de `icon:` YAML

---

## v0.7.84 — Autocomplétion contextuelle : clés, icônes, attributs

### Clés contextuelles (selon `type:`)
- Nouvelle source `_keyComplete` : au début d'une ligne (position clé — seulement espaces ou `- ` avant le mot, pas de `:` avant le curseur), propose les clés disponibles selon le type de carte détecté
- Détection du type de carte via `_getCardTypeAtCursor` : remonte les lignes depuis le curseur, s'arrête sur le premier `type:` dont l'indentation est ≤ à celle du curseur — gère correctement les stacks imbriquées
- **Auto-déclenchement sur Entrée** : quand une nouvelle ligne est insérée après une ligne `type: xxx`, `startCompletion()` est appelé après 50 ms — la liste s'ouvre sans `Ctrl+Space`
- 24 types de cartes couverts avec leurs clés spécifiques + type hint dans la colonne detail
- N'active pas sur les lignes ayant déjà une valeur après `:`

### Correction `- type:` (items de liste)
- `_typeComplete` ne matchait pas `- type:` (avec tiret de liste YAML) — regex corrigée de `/^(\s*type:\s*)(.*)/` vers `/^(\s*-?\s*type:\s*)(.*)/`
- `_keyComplete` et `_haComplete` avaient déjà le `-?` dans leurs guards — uniformisé

### Complétion `icon:` — 250+ icônes MDI
- Nouvelle source `_iconComplete` : activée sur les lignes `icon:`, après le `:`, dès 2 caractères tapés ou `Ctrl+Space`
- **250+ icônes MDI curated** couvrant : éclairage, interrupteurs, climatisation, capteurs, sécurité, médias, météo, réseau, énergie, transport, jardin, personnes, électroménager
- Accepte `mdi:light` ou `light` — le préfixe `mdi:` est détecté et retiré pour le filtrage
- Max 80 résultats affichés, filtrés live

### Complétion `attribute:` — attributs réels depuis `hass.states`
- Nouvelle source `_attributeComplete` : activée sur les lignes `attribute:` et `state_attribute:`
- `_getEntityAtCursor` : scan bidirectionnel (haut + bas) depuis le curseur pour trouver `entity:` au même niveau d'indentation — l'ordre des clés dans le YAML n'a pas d'importance
- Arrêt du scan quand l'indentation diminue (hors du bloc de carte courant)
- Chaque suggestion affiche la valeur actuelle de l'attribut dans la colonne detail (tronquée à 40 chars)
- Source : `hass.states[entityId].attributes` — toujours synchronisé avec l'instance HA

### Uniformisation visuelle de toutes les sources
- Toutes les suggestions (types, clés, icônes, attributs, entités) utilisent `type: "variable"` — icône identique
- `EditorView.baseTheme` surcharge les icônes CodeMirror par défaut : `cm-completionIcon-variable/keyword/property::after` → contenu `⬡`, couleur `#59bec2` (sombre) / `#0550ae` (clair)
- Hover souris et sélection clavier identiques pour toutes les sources
- `README.md`, `README.fr.md` et `CHANGELOG.md` mis à jour

---

## v0.7.83 — Autocomplétion `type:` (cartes natives + HACS)

- Sur toute ligne `type:` (y compris indentée, ex: `  type:` dans un stack), frappe ou `Ctrl+Space` déclenche l'autocomplétion
- **35+ types de cartes natifs HA** proposés : `alarm-panel`, `area`, `button`, `calendar`, `conditional`, `entity`, `gauge`, `glance`, `grid`, `history-graph`, `horizontal-stack`, `humidifier`, `iframe`, `light`, `logbook`, `map`, `markdown`, `media-control`, `picture`, `picture-entity`, `picture-glance`, `plant-status`, `sensor`, `shopping-list`, `statistics-graph`, `thermostat`, `tile`, `todo-list`, `vertical-stack`, `weather-forecast`, `webpage` et les cartes énergie
- **Cartes HACS détectées automatiquement** via `window.customCards` (convention standard des cartes HACS) — apparaissent avec le préfixe `custom:`, leur nom déclaré s'affiche dans la colonne `detail` à droite
- Les cartes natives sont classées au-dessus des cartes custom dans le ranking (`boost: 2` vs `boost: 1`)
- Filtrage en direct : `type: ga` → uniquement `gauge`, `type: custom` → uniquement les cartes HACS
- L'autocomplétion entités ne s'active plus sur les lignes `type:` — suppression du conflit entre les deux sources
- `README.md` et `README.fr.md` mis à jour avec documentation détaillée

---

## v0.7.82 — Snippets de démarrage + confirmation avant remplacement

- Ajout du bouton **📋 Snippets** dans la barre de l'éditeur (avant 💾 Sauver)
- Dropdown avec **14 modèles** de cartes prêts à l'emploi, groupés en 5 catégories :
  - **Basique** : Entity, Button, Markdown
  - **Visualisation** : Gauge, History graph, Statistics graph, Weather forecast
  - **Contrôle** : Thermostat, Media player
  - **Mise en page** : Vertical stack, Horizontal stack, Grid
  - **Avancé** : Glance, Picture entity
- **Comportement intelligent** :
  - Éditeur vide → insertion directe sans confirmation
  - Éditeur avec contenu → `confirm()` natif "Remplacer le contenu actuel par ce snippet ?" avant d'écraser
- Après insertion : éditeur focus + aperçu mis à jour dans les 400 ms
- Le dropdown se ferme en cliquant en dehors (même mécanisme que le panneau ⚙)
- Snippets déclarés en `static readonly` sur la classe — partagés entre instances, pas recréés
- `README.md`, `README.fr.md` et `CHANGELOG.md` créés/mis à jour

---

## v0.7.81 — Booléens et null en couleur distincte

- `true`, `false`, `yes`, `no`, `on`, `off`, `null`, `~` s'affichent en **magenta** (`#d33682` thème sombre, `#8250df` thème clair) au lieu du jaune/vert des valeurs scalaires normales
- Implémenté via `ViewPlugin` avec `Prec.highest` — obligatoire pour que les spans du plugin soient intérieurs et gagnent sur le `TreeHighlighter` du `HighlightStyle`
- Regex de détection : `/^(true|false|yes|no|on|off|null|~)$/i` sur les nœuds `Literal` du parse tree
- Fonctionne dans les deux thèmes (sombre et clair)

---

## v0.7.79 — JavaScript embarqué dans `[[[...]]]`

- L'éditeur détecte automatiquement les blocs `[[[` … `]]]` dans le YAML et applique un **highlighting JavaScript complet** à l'intérieur :
  - Mots-clés JS (`if`, `let`, `return`…) → orange `#cb4b16`
  - Nombres → magenta `#d33682`
  - Opérateurs → gris `#839496`
  - Identifiants / variables → blanc `#e8eced`
- Détection dans les nœuds `BlockLiteralContent`, `Literal` et `QuotedLiteral` — couvre tous les contextes où button-card peut placer du JS
- Implémenté via `parseMixed` (`@lezer/common`) + parser JS de `@codemirror/lang-javascript`
- Plusieurs blocs `[[[...]]]` par nœud YAML supportés (overlay multiple)
- Remplace `yamlLang()` par `yamlJsLang()` comme langage principal de l'éditeur

---

## v0.7.68 — Suppression du line wrap

- Retrait de `EditorView.lineWrapping`
- Cause : le line wrap cassait l'indentation visuelle des blocs `[[[...]]]` multi-lignes

---

## Versions antérieures à v0.7.68

Fonctionnalités construites progressivement avant le suivi détaillé des versions :

### Éditeur

- **CodeMirror 6** — éditeur professionnel embarqué dans le panneau sidebar HA
- **Numéros de ligne** + highlight ligne active + highlight gouttière ligne active
- **Isolation clavier** — `stopPropagation` sur `keydown`/`keyup`/`keypress` pour éviter les conflits avec les raccourcis HA
- **Thème sombre (Noctis Solarized)** :
  - Clés YAML → `#59bec2` (cyan)
  - Valeurs scalaires / strings → `#b58900` (jaune)
  - Commentaires → `#586e75` italic
  - Fond éditeur → `#002b36`, gouttière → `#073642`
  - Cursor → `var(--accent-color, #268bd2)`
  - Sélection → `rgba(38,139,210,.3)`
- **Thème clair** :
  - Clés → `#0550ae`, valeurs → `#116329`, commentaires → `#6e7781`
  - Fond → CSS vars HA (`--code-editor-background-color`)
- **Font size** — boutons `A−` / `A+` (10–28 px), `↺` reset à 14 px, persistée `card-playground-font-size`, reconfigurée via `Compartment` sans recréer l'éditeur

### Color swatches (hex picker inline)

- Regex de détection : `/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g`
- Formats supportés : `#rgb`, `#rrggbb`, `#rrggbbaa`
- Widget inline (10×10 px, border-radius 2 px, border `rgba(128,128,128,.5)`)
- Clic → crée un `<input type="color">` invisible fixé hors écran → `.click()` programmatique
- Pendant le déplacement dans le picker (`input` event) : retrouve la longueur courante de la couleur à la position exacte et dispatche la mise à jour CodeMirror en temps réel
- Shorthand `#rgb` → converti en `#rrggbb` pour le picker, la valeur dans l'éditeur reste en 6 chiffres après sélection
- `ViewPlugin` + `RangeSetBuilder` — recalcul sur chaque `docChanged` ou `viewportChanged`

### Autocomplétion entités HA

- Source : `hass.states` — toujours synchronisé avec l'instance HA en direct
- Max 80 résultats, filtrage `includes(typed)`, boost +1 si `startsWith(typed)`
- Colonne label (entity ID) : `#e8eced` (sombre) / `var(--text-color)` (clair)
- Colonne detail (état + unité) : `#59bec2` (sombre) / `#0550ae` (clair) — `friendly_name` volontairement absent
- `activateOnTyping: true`, `closeOnBlur: false`, `Ctrl+Space` pour forcer
- **Hover souris** — boucle `requestAnimationFrame` + `getBoundingClientRect()` en dual-context (`document` + `this.renderRoot`) pour fonctionner dans le Shadow DOM HA
  - Couleur hover : `#4d78cc` (sombre) / `#2563eb` (clair), appliquée en style inline (priorité absolue)
- Liste : min-width 340 px, max-height 50vh, padding item 3 px vertical

### Sauvegarde & Restauration

- **Auto-save** : chaque `docChanged` écrit dans `card-playground-yaml` si activé
- **💾 Sauver** : écrit `card-playground-snapshot` + `card-playground-yaml` — bouton ambré "✓ Sauvé" 1 s
- **↩ Restaurer** : charge `card-playground-snapshot` dans l'éditeur — bouton accent "✓ Restauré" 1 s

### Clipboard & Formatage

- **⎘ Copier** : copie la sélection active ou tout le YAML — `execCommand('copy')` + fallback `navigator.clipboard` — bouton vert "✓ Copié" 1 s
- **⎘ Coller** : focus `contentDOM` + affiche "→ Ctrl+V" 1,5 s
- **⌥ Format** : `parseYaml` → `stringifyYaml` (indent 2, lineWidth 0, uniqueKeys false) — bouton ambré "✓ Formaté" 1 s — silencieux si YAML invalide
- **⇥ / ⇤** : `indentMore` / `indentLess` CodeMirror

### Séparateur glissable & plein écran

- Drag sur la barre de 6 px entre éditeur et aperçu — plage 20%–80%, CSS `--editor-w`
- Barre change de couleur au hover et pendant le drag (couleur primaire HA)
- **◀ Plein écran** / **▶ Aperçu** : toggle `_previewHidden`, classe `.editor-full` masque le séparateur et le panneau aperçu via CSS

### Fenêtre détachée

- Ouvre `window.location.href + '#preview'` dans un popup 540×760 px sans chrome navigateur
- BroadcastChannel `card-playground` — messages : `yaml-update`, `request-yaml`, `settings-update`
- À l'ouverture : la fenêtre détachée envoie `request-yaml` → l'éditeur répond immédiatement
- Surveillance fermeture : `setInterval` 500 ms vérifie `win.closed` → restaure le split si fermée
- **Zoom** (fenêtre détachée) : barre fixe bas-droite, `−`/`+` par pas de 25% (25%–200%), `↺` reset, CSS `zoom` (pas `transform:scale`), scroll naturel
- Badge "Aperçu · taille non contractuelle" (15 px, opacity 45%) si zoom ≠ 100%
- Sync `desktopWidth` via `settings-update` à chaque changement de largeur colonne

### Aperçu temps réel

- `createCardElement()` natif HA — rendu pixel-identique au vrai tableau de bord
- Chargement ressources Lovelace (`lovelace/resources`) via `<script type="module">` — même méthode que HA, évite les erreurs MIME
- Mise à jour en place (`setConfig()` sans recréation) si `type:` inchangé — zéro flickering
- Pour `custom:` : `setConfig()` sans la clé `type` (button-card & co. rejettent `type` dans `setConfig`)
- Debounce 400 ms sur chaque `docChanged`
- Erreur de parse ou type introuvable → `hui-error-card` natif HA (même rendu que les dashboards)

### Largeur colonne Desktop

- 8 presets : 1 col=1200 px, 2=600, 3=400, 4=300, 5=240, 6=200, 8=150, 10=120
- Slider 100–1600 px (step 1) + input numérique direct
- Largeur affichée en temps réel dans la toolbar aperçu
- Persistée `card-playground-desktop-width`, synchronisée vers la fenêtre détachée via `settings-update`

### Panneau ⚙ Paramètres

- Thème clair/sombre (toggle) — reconfigure `_themeCompartment` + `_applyCompletionStyles()`
- Auto-save (toggle) — persisté `card-playground-autosave`
- Plein écran auto au détachement (toggle) — persisté `card-playground-auto-full`
- Largeur colonne Desktop (presets + slider + input)
- Se ferme au clic en dehors via le listener `@click` sur `.workspace`
