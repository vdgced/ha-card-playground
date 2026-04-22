import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  EditorView, keymap, lineNumbers, drawSelection,
  highlightActiveLine, highlightActiveLineGutter,
  ViewPlugin, DecorationSet, Decoration, WidgetType, ViewUpdate,
  GutterMarker, gutterLineClass,
} from "@codemirror/view";
import { EditorState, Compartment, RangeSetBuilder, RangeSet, Prec, StateEffect, StateField } from "@codemirror/state";
import { yaml as yamlLang } from "@codemirror/lang-yaml";
import { javascript } from "@codemirror/lang-javascript";
import { defaultKeymap, history, historyKeymap, indentWithTab, indentMore, indentLess } from "@codemirror/commands";
import { autocompletion, completionKeymap, CompletionContext, CompletionResult, startCompletion, acceptCompletion, completionStatus, currentCompletions } from "@codemirror/autocomplete";
import { indentUnit, syntaxHighlighting, HighlightStyle, LanguageSupport, LRLanguage, syntaxTree } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { parseMixed } from "@lezer/common";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { MDI_ICON_NAMES } from "./mdi-icon-names";

// Injecté par Rollup (valeur de package.json → version)
declare const __VERSION__: string;

// ── Types Home Assistant ────────────────────────────────────────────────────

interface HomeAssistant {
  language: string;
  themes: { darkMode: boolean };
  [key: string]: unknown;
}

interface CardHelpers {
  createCardElement: (config: Record<string, unknown>) => HTMLElement & { hass?: HomeAssistant };
}

declare global {
  interface Window {
    loadCardHelpers: () => Promise<CardHelpers>;
  }
}

// ── Canal BroadcastChannel ──────────────────────────────────────────────────

const CHANNEL = "card-playground";
type Msg =
  | { type: "yaml-update"; yaml: string }
  | { type: "request-yaml" }
  | { type: "settings-update"; desktopWidth: number };

// ── Détecte si on est en mode preview (fenêtre détachée) ───────────────────

const IS_PREVIEW = window.location.hash === "#preview";

// HighlightStyle.define() mappe directement les tags Lezer aux couleurs
// Plus fiable que classHighlighter dans le contexte Shadow DOM de HA

// Tags réels du parser @lezer/yaml (src/highlight.js) :
// Key/Literal Key/QuotedLiteral → t.definition(t.propertyName)
// Literal (scalaires plain) → t.content
// QuotedLiteral → t.string
// BlockLiteralContent → t.content
// Comment → t.lineComment
// Anchor Alias → t.labelName   Tag → t.typeName   DirectiveName → t.keyword

const darkHighlight = syntaxHighlighting(HighlightStyle.define([
  // YAML
  { tag: tags.definition(tags.propertyName), color: "#59bec2" },  // clés YAML — cyan
  { tag: tags.propertyName,                  color: "#59bec2" },
  { tag: tags.content,                       color: "#b58900" },  // scalaires plain — jaune
  { tag: tags.string,                        color: "#b58900" },  // quoted strings — jaune
  { tag: tags.special(tags.string),          color: "#b58900" },  // block header | >
  { tag: tags.attributeValue,               color: "#b58900" },
  { tag: tags.lineComment,  fontStyle: "italic", color: "#586e75" },
  { tag: tags.blockComment, fontStyle: "italic", color: "#586e75" },
  { tag: tags.meta,                          color: "#586e75" },
  { tag: tags.labelName,                     color: "#59bec2" },
  { tag: tags.typeName,                      color: "#59bec2" },
  // JS embarqué dans [[[...]]]
  { tag: tags.keyword,                       color: "#cb4b16" },  // if/var/let/return — orange
  { tag: tags.number,                        color: "#d33682" },  // nombres JS — magenta
  { tag: tags.operator,                      color: "#839496" },  // opérateurs JS — gris
  { tag: tags.variableName,                  color: "#e8eced" },  // identifiants JS — blanc
  { tag: tags.definition(tags.variableName), color: "#e8eced" },
]));

const lightHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.definition(tags.propertyName), color: "#0550ae" },
  { tag: tags.propertyName,                  color: "#0550ae" },
  { tag: tags.content,                       color: "#116329" },
  { tag: tags.string,                        color: "#116329" },
  { tag: tags.special(tags.string),          color: "#116329" },
  { tag: tags.attributeValue,               color: "#116329" },
  { tag: tags.lineComment,  fontStyle: "italic", color: "#6e7781" },
  { tag: tags.blockComment, fontStyle: "italic", color: "#6e7781" },
  { tag: tags.meta,                          color: "#6e7781" },
  { tag: tags.labelName,                     color: "#0550ae" },
  { tag: tags.typeName,                      color: "#8250df" },
  { tag: tags.keyword,                       color: "#cf222e" },
  { tag: tags.number,                        color: "#953800" },
  { tag: tags.operator,                      color: "#0550ae" },
  { tag: tags.variableName,                  color: "#1a1a1a" },
  { tag: tags.definition(tags.variableName), color: "#1a1a1a" },
]));

// YAML + JavaScript embarqué dans les blocs [[[...]]]
function yamlJsLang(): LanguageSupport {
  const jsParser = javascript().language.parser;
  const yamlSupport = yamlLang();
  const mixedLang = (yamlSupport.language as LRLanguage).configure({
    wrap: parseMixed((node, input) => {
      if (node.name !== "BlockLiteralContent" &&
          node.name !== "Literal" &&
          node.name !== "QuotedLiteral") return null;
      const text = input.read(node.from, node.to);
      const overlay: { from: number; to: number }[] = [];
      let pos = 0;
      while (pos < text.length) {
        const start = text.indexOf("[[[", pos);
        if (start === -1) break;
        const end = text.indexOf("]]]", start + 3);
        if (end === -1) break;
        overlay.push({ from: node.from + start + 3, to: node.from + end });
        pos = end + 3;
      }
      return overlay.length > 0 ? { parser: jsParser, overlay } : null;
    }),
  });
  return new LanguageSupport(mixedLang, yamlSupport.support);
}

// Nœuds YAML Literal dont la valeur est un booléen ou null — couleur distincte
const BOOL_NULL_RE = /^(true|false|yes|no|on|off|null|~)$/i;

function boolNullPlugin(color: string) {
  return Prec.highest(ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = buildDeco(view, color); }
    update(u: { docChanged: boolean; viewportChanged: boolean; view: EditorView }) {
      if (u.docChanged || u.viewportChanged)
        this.decorations = buildDeco(u.view, color);
    }
  }, { decorations: v => v.decorations }));
}

function buildDeco(view: EditorView, color: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const mark = Decoration.mark({ attributes: { style: `color:${color}` } });
  syntaxTree(view.state).cursor().iterate(node => {
    if (node.name === "Literal") {
      const text = view.state.sliceDoc(node.from, node.to).trim();
      if (BOOL_NULL_RE.test(text)) builder.add(node.from, node.to, mark);
    }
  });
  return builder.finish();
}

// ── Color swatch — carré coloré cliquable devant chaque valeur hex ─────────

const HEX_COLOR_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g;

class ColorSwatchWidget extends WidgetType {
  constructor(readonly color: string, readonly from: number, readonly to: number) { super(); }

  eq(other: ColorSwatchWidget) { return this.color === other.color && this.from === other.from; }
  ignoreEvent() { return false; }

  toDOM(view: EditorView): HTMLElement {
    const swatch = document.createElement("span");
    swatch.title = this.color;
    swatch.style.cssText = [
      "display:inline-block", "width:10px", "height:10px",
      "border-radius:2px", `background:${this.color}`,
      "border:1px solid rgba(128,128,128,.5)",
      "cursor:pointer", "margin:0 3px 0 1px",
      "vertical-align:middle", "position:relative", "top:-1px",
    ].join(";");

    swatch.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const input = document.createElement("input");
      input.type = "color";
      input.value = this._toHex6(this.color);
      input.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.bottom}px;width:1px;height:1px;opacity:0.01;border:0;padding:0;margin:0;outline:0;pointer-events:none`;
      document.body.appendChild(input);

      input.addEventListener("input", () => {
        // Retrouve la longueur courante de la couleur à la position from
        const slice = view.state.doc.sliceString(this.from, Math.min(this.from + 10, view.state.doc.length));
        const m = slice.match(/^#[0-9a-fA-F]{3,8}/);
        const currentTo = this.from + (m ? m[0].length : this.to - this.from);
        view.dispatch({ changes: { from: this.from, to: currentTo, insert: input.value } });
      });

      input.addEventListener("change", () => document.body.removeChild(input));
      input.addEventListener("blur", () => setTimeout(() => {
        if (input.parentNode) document.body.removeChild(input);
      }, 200));
      requestAnimationFrame(() => input.click());
    });

    return swatch;
  }

  private _toHex6(color: string): string {
    const m3 = color.match(/^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/i);
    if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`.toLowerCase();
    return color.slice(0, 7).toLowerCase(); // #rrggbb (ignore alpha pour picker)
  }
}

const colorSwatchPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this._build(view); }
  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged) this.decorations = this._build(u.view);
  }
  _build(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    for (const { from, to } of view.visibleRanges) {
      const text = view.state.sliceDoc(from, to);
      HEX_COLOR_RE.lastIndex = 0;
      let m;
      while ((m = HEX_COLOR_RE.exec(text)) !== null) {
        const start = from + m.index;
        const end = start + m[0].length;
        builder.add(start, start, Decoration.widget({
          widget: new ColorSwatchWidget(m[0], start, end),
          side: -1,
        }));
      }
    }
    return builder.finish();
  }
}, { decorations: v => v.decorations });

// ── Recherche YAML — highlight de l'occurrence trouvée ──────────────────────
class _SearchGutterMarker extends GutterMarker {
  elementClass = 'cm-search-gutter';
}
const _searchGutterMark = new _SearchGutterMarker();

interface _SearchHL { decos: DecorationSet; gutterMarks: RangeSet<GutterMarker>; }
const _searchHighlightEffect = StateEffect.define<{ from: number; to: number } | null>();
const _searchHighlightField = StateField.define<_SearchHL>({
  create: () => ({ decos: Decoration.none, gutterMarks: RangeSet.empty }),
  update({ decos, gutterMarks }, tr) {
    decos = decos.map(tr.changes);
    gutterMarks = gutterMarks.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(_searchHighlightEffect)) {
        if (e.value === null) {
          decos = Decoration.none;
          gutterMarks = RangeSet.empty;
        } else {
          const { from, to } = e.value;
          const line = tr.state.doc.lineAt(from);
          const db = new RangeSetBuilder<Decoration>();
          db.add(line.from, line.from, Decoration.line({ class: 'cm-search-line' }));
          db.add(from, to, Decoration.mark({ class: 'cm-search-match' }));
          decos = db.finish();
          const gb = new RangeSetBuilder<GutterMarker>();
          gb.add(line.from, line.from, _searchGutterMark);
          gutterMarks = gb.finish();
        }
      }
    }
    return { decos, gutterMarks };
  },
  provide: f => [
    EditorView.decorations.from(f, s => s.decos),
    gutterLineClass.from(f, s => s.gutterMarks),
  ],
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPOSANT PRINCIPAL — rend soit l'éditeur, soit l'aperçu selon le hash
// ═══════════════════════════════════════════════════════════════════════════

@customElement("ha-card-playground")
class HaCardPlayground extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;
  @property({ type: Boolean }) narrow = false;

  protected firstUpdated(): void {
    // En mode preview, cacher la sidebar HA pour avoir plus d'espace
    if (IS_PREVIEW) {
      this._hideSidebar();
    }
  }

  private _hideSidebar(): void {
    // Remonte dans le DOM pour trouver et masquer la sidebar HA
    try {
      const ha = document.querySelector("home-assistant");
      const root = (ha as HTMLElement & { shadowRoot: ShadowRoot })?.shadowRoot;
      const drawer = root?.querySelector("ha-drawer") as HTMLElement | null;
      if (drawer) drawer.style.setProperty("--mdc-drawer-width", "0px");
    } catch { /* silencieux */ }
  }

  render() {
    if (IS_PREVIEW) {
      return html`<ha-card-playground-preview .hass=${this.hass}></ha-card-playground-preview>`;
    }
    return html`<ha-card-playground-editor .hass=${this.hass}></ha-card-playground-editor>`;
  }

  // Pas de shadow DOM sur le wrapper — on laisse les sous-composants gérer le leur
  protected createRenderRoot() { return this; }
}

// ═══════════════════════════════════════════════════════════════════════════
// ÉDITEUR (fenêtre principale)
// ═══════════════════════════════════════════════════════════════════════════

@customElement("ha-card-playground-editor")
class HaCardPlaygroundEditor extends LitElement {
  // Setter manuel : pousse hass sur la carte immédiatement,
  // sans attendre le cycle de rendu LitElement (requestUpdate).
  set hass(value: HomeAssistant | undefined) {
    const old = this._hass;
    this._hass = value;
    if (this._cardElement && value) this._cardElement.hass = value;
    this.requestUpdate("hass", old);
  }
  get hass(): HomeAssistant | undefined { return this._hass; }
  private _hass?: HomeAssistant;

  private _yaml = `type: markdown
content: |
  ## HA Card Playground
  Colle ou tape ton YAML de carte ici.
  Utilise **📋 Snippets** pour démarrer depuis un modèle.`;

  private _cmView?: EditorView;
  private _fontCompartment = new Compartment();
  private _themeCompartment = new Compartment();
  private _cardElement?: HTMLElement & { hass?: HomeAssistant };
  private _lastCardType = "";
  private _lastStylesKey = "";
  private _debounceTimer?: ReturnType<typeof setTimeout>;
  private _checkTimer?: ReturnType<typeof setTimeout>;
  private _highlightTimer?: ReturnType<typeof setTimeout>;
  private _lastHighlightValue = "";
  private _helpers?: CardHelpers;
  private _channel = new BroadcastChannel(CHANNEL);
  private _previewWin?: WindowProxy | null;
  private _winWatcher?: ReturnType<typeof setInterval>;
  @state() private _parseError: string | null = null;
  @state() private _loading = false;
  @state() private _detached = false;
  @state() private _splitPct = 62;    // % de largeur pour l'éditeur (62–80)
  @state() private _previewZoom = 100; // zoom aperçu inline (10–200%)
  @state() private _dragging = false;
  @state() private _inspectMode = false; // mode inspection carte ↔ YAML
  @state() private _showInspectBtn = false; // bouton 🔍 visible (feature beta)
  @state() private _inspectOverlays: Array<{left:number;top:number;width:number;height:number}> = [];
  @state() private _fontSize = 14;   // taille police éditeur (px)
  @state() private _previewHidden = false;      // éditeur plein écran
  @state() private _autoFullOnDetach = false;   // plein écran auto au détachement
  @state() private _autoSave = true;            // sauvegarde YAML dans localStorage
  @state() private _copied = false;
  @state() private _pasted: "ok" | "fail" | false = false;
  @state() private _saved = false;
  @state() private _restored = false;
  @state() private _formatted = false;
  @state() private _darkMode = true;
  @state() private _settingsOpen = false;
  @state() private _searchOpen = false;
  @state() private _searchSuggestions: string[] = [];
  @state() private _searchSugIdx = -1;
  private _searchLast = '';
  @state() private _desktopWidth = 300;         // largeur colonne desktop (px) — 4 col HA par défaut
  @state() private _canvasHeight: string | null = null; // hauteur forcée quand type canvas
  @state() private _checkOpen = false;
  @state() private _checkResult: Array<{ type: 'ok' | 'error' | 'warn'; msg: string }> | null = null;
  @state() private _fileSaved = false;
  @state() private _droppedFileName: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _droppedFileHandle: any = null; // FileSystemFileHandle (File System Access API)

  static styles = css`
    :host {
      display: block;
      height: 100%;
      background: var(--primary-background-color);
      color: var(--primary-text-color);
      font-family: var(--primary-font-family, inherit);
    }
    .header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 24px; height: 65px; box-sizing: border-box;
      border-bottom: 1px solid var(--divider-color);
      background: var(--app-header-background-color, var(--primary-color));
      color: var(--app-header-text-color, white);
    }
    .header h1 { margin: 0; font-size: 20px; font-weight: 400; }
    .btn {
      padding: 5px 14px; border: 1px solid rgba(255,255,255,.22); border-radius: 6px;
      cursor: pointer; font-size: 13px; font-weight: 600; line-height: 1.6;
      background: rgba(255,255,255,.1); color: inherit;
      transition: background .15s, border-color .15s;
    }
    .btn:hover  { background: rgba(255,255,255,.22); border-color: rgba(255,255,255,.38); }
    .btn.active { background: rgba(255,255,255,.28); border-color: rgba(255,255,255,.45); }
    .unified-toolbar {
      display: flex; align-items: center; flex-wrap: nowrap; gap: 4px;
      padding: 6px 24px 6px 12px; flex-shrink: 0;
      background: var(--secondary-background-color);
      border-bottom: 1px solid var(--divider-color);
    }
    .toolbar-section-label {
      font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: .05em;
      color: var(--secondary-text-color); white-space: nowrap; flex-shrink: 0;
    }
    .toolbar-sep {
      width: 1px; height: 22px; background: var(--divider-color); flex-shrink: 0; margin: 0 8px;
    }
    .workspace { display: flex; height: calc(100% - 65px - 45px); overflow: hidden; user-select: none; }
    .editor-pane {
      flex: 0 0 var(--editor-w, 50%); display: flex; flex-direction: column; min-width: 0;
    }
    .pane-title {
      padding: 8px 16px; font-size: 12px; font-weight: 500;
      text-transform: uppercase; letter-spacing: .05em;
      color: var(--secondary-text-color); background: var(--secondary-background-color);
      border-bottom: 1px solid var(--divider-color); flex-shrink: 0;
    }
    .editor-area { flex: 1; overflow: hidden; transition: background .2s; }
    .editor-area.light { background: #ffffff; }
    .font-ctrl {
      display: flex; align-items: center; gap: 4px;
      flex-wrap: nowrap;
      flex: 1; min-width: 0;
    }
    .font-btn {
      padding: 5px 14px; border: 1px solid var(--divider-color); border-radius: 6px;
      cursor: pointer; font-size: 13px; font-weight: 600; line-height: 1.6; white-space: nowrap;
      background: var(--card-background-color, rgba(255,255,255,.07));
      color: var(--primary-text-color);
      transition: background .15s, color .15s, border-color .15s;
    }
    .font-btn:hover { background: var(--primary-color); color: white; border-color: var(--primary-color); }
    .font-btn.copied    { background: var(--success-color, #22c55e); color: white; border-color: var(--success-color, #22c55e); }
    .font-btn.pasted-ok { background: var(--primary-color); color: white; border-color: var(--primary-color); }
    .font-btn.pasted-fail { background: var(--error-color, #ef4444); color: white; border-color: var(--error-color, #ef4444); }
    .font-btn.saved    { background: var(--warning-color, #f59e0b); color: white; border-color: var(--warning-color, #f59e0b); }
    .font-btn.restored { background: var(--accent-color, var(--primary-color)); color: white; border-color: var(--accent-color, var(--primary-color)); }
    .font-btn.active   { background: var(--primary-color); color: white; border-color: var(--primary-color); }
    .font-size-label { font-size: 13px; font-weight: 700; opacity: .9; min-width: 36px; text-align: center; }
    .editor-area .cm-editor { height: 100%; font-size: var(--code-font-size, 14px); }
    .editor-area .cm-scroller {
      font-family: "Fira Code","Cascadia Code","Consolas",monospace !important;
      line-height: 1.6;
    }
    .editor-area .cm-editor.cm-focused { outline: none; }
    .split-handle {
      flex-shrink: 0; width: 6px; cursor: col-resize;
      background: var(--divider-color, #333);
      display: flex; align-items: center; justify-content: center;
      transition: background .15s;
    }
    .split-handle:hover, .split-handle.dragging { background: var(--primary-color); }
    .split-handle::after {
      content: ''; display: block;
      width: 2px; height: 32px; border-radius: 2px;
      background: rgba(255,255,255,.3);
      box-shadow: -3px 0 0 rgba(255,255,255,.3);
    }
    .preview-pane { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .preview-toolbar {
      display: flex; align-items: center; flex-wrap: nowrap; overflow: hidden;
      padding: 6px 24px 6px 12px; background: var(--secondary-background-color);
      border-bottom: 1px solid var(--divider-color); flex-shrink: 0;
    }
    .preview-toolbar .pane-title { padding: 0; background: none; border: none; flex: 1; }
    .toolbar-center { flex: 1; text-align: center; }
    .toolbar-right { flex: 1; }
    .preview-area {
      flex: 1; overflow: auto; padding: 24px;
      display: flex; align-items: flex-start; justify-content: center;
      background: var(--primary-background-color, #111827); transition: background .2s;
      position: relative;
    }
    .workspace.light-mode .preview-area { background: var(--primary-background-color); }
    .preview-frame { width: var(--desktop-w, 300px); max-width: none; }
    .zoom-btn {
      padding: 5px 14px; border: 1px solid var(--divider-color); border-radius: 6px;
      cursor: pointer; font-size: 13px; font-weight: 600; line-height: 1.6;
      background: var(--card-background-color, rgba(255,255,255,.07));
      color: var(--primary-text-color);
      transition: background .15s, color .15s, border-color .15s;
    }
    .zoom-btn:hover { background: var(--primary-color); color: white; border-color: var(--primary-color); }
    .zoom-btn.active { background: var(--primary-color); color: white; border-color: var(--primary-color); }
    .zoom-label { font-size: 13px; font-weight: 700; opacity: .9; min-width: 48px; text-align: center; }
    .preview-col { display: flex; flex-direction: column; align-items: stretch; }
    .preview-badge {
      font-size: 15px; text-align: center; padding: 6px 0 0;
      opacity: .45; letter-spacing: .04em; user-select: none;
    }
    .detached-msg {
      flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 8px; color: var(--secondary-text-color); font-size: 14px;
    }
    .reattach-btn {
      display: flex; flex-direction: column; align-items: center; gap: 6px;
      padding: 16px 24px; border-radius: 12px; cursor: pointer;
      border: 1px solid var(--divider-color); background: transparent;
      color: var(--secondary-text-color); transition: background .15s, opacity .15s;
    }
    .reattach-btn:hover { background: var(--secondary-background-color); opacity: .85; }
    /* Éditeur plein écran — handle + preview masqués */
    .workspace.editor-full .split-handle,
    .workspace.editor-full .preview-pane { display: none; }
    .workspace.editor-full .editor-pane { flex: 0 0 100%; }
    /* Panneau paramètres */
    .settings-wrap { position: relative; }
    .settings-panel {
      position: absolute; top: calc(100% + 8px); right: 0; z-index: 99;
      background: var(--card-background-color, var(--primary-background-color));
      border: 1px solid var(--divider-color); border-radius: var(--ha-card-border-radius, 8px);
      padding: 16px; min-width: 260px;
      box-shadow: var(--ha-card-box-shadow, 0 4px 20px rgba(0,0,0,.3));
    }
    .settings-panel h3 {
      margin: 0 0 12px; font-size: 13px; font-weight: 500;
      text-transform: uppercase; letter-spacing: .05em;
      color: var(--secondary-text-color);
    }
    .setting-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 0; border-bottom: 1px solid var(--divider-color); gap: 16px;
    }
    .setting-row:last-child { border-bottom: none; }
    .setting-label { font-size: 13px; line-height: 1.4; }
    .setting-desc { font-size: 11px; opacity: .55; margin-top: 2px; }
    .toggle {
      flex-shrink: 0; width: 36px; height: 20px; border-radius: 10px;
      border: none; cursor: pointer; position: relative;
      background: var(--divider-color); transition: background .2s;
    }
    .toggle.on { background: var(--primary-color); }
    .toggle::after {
      content: ''; position: absolute; top: 3px; left: 3px;
      width: 14px; height: 14px; border-radius: 50%;
      background: white; transition: transform .2s;
    }
    .toggle.on::after { transform: translateX(16px); }
    .setting-row--col { flex-direction: column; align-items: stretch; gap: 8px; }
    .setting-slider-row { display: flex; align-items: center; gap: 8px; }
    .setting-slider-row input[type=range] { flex: 1; accent-color: var(--primary-color); }
    .setting-val { font-size: 12px; min-width: 44px; text-align: right; opacity: .75; }
    .setting-num {
      width: 56px; background: transparent; border: 1px solid var(--divider-color);
      border-radius: 4px; color: var(--primary-text-color); font-size: 12px;
      text-align: right; padding: 2px 4px;
    }
    .setting-num:focus { outline: none; border-color: var(--primary-color); }
    .col-presets { display: flex; flex-wrap: wrap; gap: 6px; }
    .col-preset {
      flex: 0 0 calc(25% - 5px); padding: 3px 0; font-size: 11px; border-radius: 4px; cursor: pointer;
      border: 1px solid var(--divider-color); background: transparent;
      color: var(--primary-text-color); text-align: center;
    }
    .col-preset.active { background: var(--primary-color); color: white; border-color: var(--primary-color); }
    .preview-error {
      padding: 16px; background: var(--error-color,#f44336); color: white;
      border-radius: 8px; font-size: 13px; font-family: monospace;
      white-space: pre-wrap; word-break: break-word;
    }
    .preview-loading {
      color: var(--secondary-text-color); text-align: center;
      padding: 48px 24px; font-size: 13px; opacity: .6;
    }
    /* Check panel */
    .check-panel {
      position: absolute; top: calc(100% + 4px); right: 0; z-index: 99;
      background: var(--card-background-color, var(--primary-background-color));
      border: 1px solid var(--divider-color); border-radius: var(--ha-card-border-radius, 8px);
      padding: 8px 12px; min-width: 300px;
      box-shadow: var(--ha-card-box-shadow, 0 4px 20px rgba(0,0,0,.3));
      max-height: 50vh; overflow-y: auto;
    }
    .check-item { display: flex; gap: 8px; padding: 3px 0; font-size: 12px; align-items: flex-start; line-height: 1.5; }
    .check-item.ok   { color: var(--success-color, #22c55e); }
    .check-item.error { color: var(--error-color, #ef4444); }
    .check-item.warn  { color: var(--warning-color, #f59e0b); }
    .check-separator { height: 1px; background: var(--divider-color); margin: 6px 0; }
    /* Fichier badge */
    .file-badge {
      font-size: 11px; padding: 1px 6px; border-radius: 4px;
      background: var(--secondary-background-color); color: var(--secondary-text-color);
      border: 1px solid var(--divider-color); max-width: 140px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .font-btn.file-ok    { background: var(--success-color, #22c55e); color: white; border-color: var(--success-color, #22c55e); }
    .font-btn.check-ok   { background: var(--success-color, #22c55e); color: white; border-color: var(--success-color, #22c55e); }
    .font-btn.check-warn { background: var(--warning-color, #f59e0b); color: white; border-color: var(--warning-color, #f59e0b); }
    .font-btn.check-error{ background: var(--error-color, #ef4444);   color: white; border-color: var(--error-color, #ef4444); }
    /* Search popup */
    .search-popup {
      position: absolute; top: calc(100% + 4px); left: 0; z-index: 999;
      background: var(--card-background-color, var(--primary-background-color));
      border: 1px solid var(--divider-color); border-radius: var(--ha-card-border-radius, 8px);
      display: flex; flex-direction: column; overflow: hidden;
      box-shadow: var(--ha-card-box-shadow, 0 4px 20px rgba(0,0,0,.4));
    }
    .search-popup-row { display: flex; gap: 6px; align-items: center; padding: 8px 10px; }
    .search-popup input {
      border: 1px solid var(--divider-color); border-radius: 4px;
      background: var(--secondary-background-color); color: var(--primary-text-color);
      padding: 4px 8px; font-size: 13px; width: 200px; outline: none;
    }
    .search-popup input:focus { border-color: var(--primary-color, #3b82f6); }
    .search-popup-close {
      background: none; border: none; color: var(--secondary-text-color);
      cursor: pointer; font-size: 16px; padding: 0 2px; line-height: 1;
    }
    .search-popup-close:hover { color: var(--primary-text-color); }
    .search-nav-btn {
      background: none; border: 1px solid var(--divider-color); border-radius: 4px;
      color: var(--secondary-text-color); cursor: pointer; font-size: 13px;
      padding: 2px 7px; line-height: 1; flex-shrink: 0;
    }
    .search-nav-btn:hover { background: var(--secondary-background-color); color: var(--primary-text-color); }
    .search-sug-list { border-top: 1px solid var(--divider-color); }
    .search-sug-item {
      display: block; width: 100%; text-align: left; padding: 5px 12px;
      border: none; background: transparent; color: var(--primary-text-color);
      font-size: 12px; cursor: pointer; white-space: nowrap;
    }
    .search-sug-item:hover, .search-sug-item.active { background: var(--secondary-background-color); color: var(--primary-color, #3b82f6); }
  `;

  protected async firstUpdated(): Promise<void> {
    const savedAutoSave = localStorage.getItem("card-playground-autosave");
    if (savedAutoSave !== null) this._autoSave = savedAutoSave === "1";
    // Toujours lire le YAML sauvegardé (auto-save contrôle l'écriture, pas la lecture)
    const saved = localStorage.getItem("card-playground-yaml");
    if (saved) this._yaml = saved;
    const savedWidth = localStorage.getItem("card-playground-desktop-width");
    if (savedWidth !== null) this._desktopWidth = Number(savedWidth);
    const savedAutoFull = localStorage.getItem("card-playground-auto-full");
    if (savedAutoFull !== null) this._autoFullOnDetach = savedAutoFull === "1";
    const savedInspect = localStorage.getItem("card-playground-inspect-btn");
    if (savedInspect !== null) this._showInspectBtn = savedInspect === "1";
    const savedDark = localStorage.getItem("card-playground-dark");
    if (savedDark !== null) this._darkMode = savedDark !== "0";
    this._applyCompletionStyles();
    this._initCodeMirror();
    this._initDragDrop();
    this._channel.onmessage = (e: MessageEvent<Msg>) => {
      if (e.data.type === "request-yaml") {
        this._send(this._yaml);
        this._sendSettings();
      }
    };
    try { this._helpers = await window.loadCardHelpers(); } catch { /* ignore */ }
    await this._loadLovelaceResources(); // charge button-card, card-mod, etc.
    this._scheduleRender();
    this._scheduleCheck();
  }

  /**
   * Charge les ressources Lovelace (HACS frontend) via <script type="module">,
   * exactement comme HA le fait lui-même. Ignore celles déjà présentes dans le DOM.
   */
  private async _loadLovelaceResources(): Promise<void> {
    try {
      const conn = (this.hass as any)?.connection;
      if (!conn) return;

      const resources = await conn.sendMessagePromise({ type: "lovelace/resources" }) as
        Array<{ url: string; type: string }>;

      await Promise.allSettled(
        resources
          .filter(r => r.type === "module")
          .filter(r => !document.head.querySelector(`script[src="${r.url}"]`))
          .map(r => new Promise<void>((resolve) => {
            const s = document.createElement("script");
            s.type = "module";
            s.src = r.url;
            s.onload = () => resolve();
            s.onerror = () => resolve(); // ressource manquante → on continue
            document.head.appendChild(s);
          }))
      );
    } catch (err) {
      console.warn("[Card Playground] Ressources Lovelace non chargées:", err);
    }
  }

  protected updated(ch: Map<string, unknown>): void {
    if (ch.has("_fontSize") && this._cmView) {
      // Reconfigure le thème via Compartment — CodeMirror recalcule gutter + layout
      this._cmView.dispatch({
        effects: this._fontCompartment.reconfigure(
          EditorView.theme({ "&": { fontSize: `${this._fontSize}px` } })
        ),
      });
    }
    if (ch.has("_desktopWidth") && this._detached) {
      this._sendSettings();
    }
    if (ch.has("_autoSave")) {
      localStorage.setItem("card-playground-autosave", this._autoSave ? "1" : "0");
    }
    if (ch.has("_desktopWidth")) {
      localStorage.setItem("card-playground-desktop-width", String(this._desktopWidth));
    }
    if (ch.has("_autoFullOnDetach")) {
      localStorage.setItem("card-playground-auto-full", this._autoFullOnDetach ? "1" : "0");
    }
    if (ch.has("_showInspectBtn")) {
      localStorage.setItem("card-playground-inspect-btn", this._showInspectBtn ? "1" : "0");
    }
    if (ch.has("_darkMode") && this._cmView) {
      localStorage.setItem("card-playground-dark", this._darkMode ? "1" : "0");
      this._cmView.dispatch({
        effects: this._themeCompartment.reconfigure(this._darkMode ? this._darkTheme() : this._lightTheme()),
      });
      this._applyCompletionStyles();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._cmView?.destroy();
    this._channel.close();
    clearTimeout(this._debounceTimer);
    clearInterval(this._winWatcher);
  }

  private _onDividerDown = (e: MouseEvent): void => {
    e.preventDefault();
    this._dragging = true;
    const onMove = (ev: MouseEvent) => {
      const ws = this.renderRoot.querySelector(".workspace") as HTMLElement | null;
      if (!ws) return;
      const rect = ws.getBoundingClientRect();
      const pct = Math.max(62, Math.min(80, ((ev.clientX - rect.left) / rect.width) * 100));
      this._splitPct = pct;
    };
    const onUp = () => {
      this._dragging = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  private _send(yaml: string): void {
    this._channel.postMessage({ type: "yaml-update", yaml } satisfies Msg);
  }

  private _copyYaml = async (): Promise<void> => {
    const sel = this._cmView?.state.selection.main;
    const text = (sel && sel.from !== sel.to)
      ? this._cmView!.state.sliceDoc(sel.from, sel.to)
      : this._yaml;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (!ok) {
      try { await navigator.clipboard.writeText(this._yaml); } catch { return; }
    }
    this._copied = true;
    setTimeout(() => { this._copied = false; }, 1000);
  };

  private _darkTheme() {
    // Thème adapté aux couleurs personnalisées Noctis Solarized de l'utilisateur
    // Utilise les variables CSS HA pour suivre automatiquement le thème actif
    return [darkHighlight, boolNullPlugin("#d33682"), EditorView.theme({
      "&":             { height: "100%", background: "#002b36", color: "#e8eced" },
      ".cm-content":   { caretColor: "#268bd2" },
      ".cm-gutters":   { background: "#073642", border: "none", color: "#586e75" },
      ".cm-activeLineGutter": { background: "#073642" },
      ".cm-activeLine":       { background: "rgba(7,54,66,.6)" },
      ".cm-selectionBackground, ::selection": { background: "rgba(38,139,210,.3) !important" },
      ".cm-cursor":    { borderLeftColor: "var(--accent-color, #268bd2)" },
      ".cm-completionDetail": { color: "#59bec2", fontStyle: "normal", marginLeft: "8px" },
      ".cm-completionLabel":  { color: "var(--text-color, #e8eced)" },
    }, { dark: true }), EditorView.baseTheme({
      ".cm-tooltip-autocomplete ul": { maxHeight: "50vh !important", minWidth: "340px !important" },
      ".cm-tooltip-autocomplete li": { padding: "3px 8px !important" },
      ".cm-tooltip-autocomplete li.cp-hover": { background: "rgba(38,139,210,.25) !important", cursor: "pointer" },
      ".cm-tooltip-autocomplete li[aria-selected]": { background: "#268bd2 !important", color: "#002b36 !important" },
    })];
  }

  private _lightTheme() {
    return [lightHighlight, boolNullPlugin("#8250df"), EditorView.theme({
      "&": { height: "100%", background: "var(--code-editor-background-color, #ffffff)", color: "var(--primary-text-color, #1a1a1a)" },
      ".cm-content": { caretColor: "var(--primary-color, #333)" },
      ".cm-gutters": { background: "var(--secondary-background-color, #f3f4f6)", color: "var(--secondary-text-color, #9ca3af)", border: "none" },
      ".cm-activeLineGutter": { background: "rgba(0,0,0,.04)" },
      ".cm-activeLine": { background: "rgba(0,0,0,.04)" },
      ".cm-selectionBackground, ::selection": { background: "rgba(0,0,0,.1) !important" },
      ".cm-cursor": { borderLeftColor: "var(--primary-color, #1d4ed8)" },
      ".cm-completionDetail": { color: "#0550ae", fontStyle: "normal", marginLeft: "8px" },
      ".cm-completionLabel": { color: "var(--primary-text-color, #1a1a1a)" },
    }, { dark: false }), EditorView.baseTheme({
      ".cm-tooltip-autocomplete ul": { maxHeight: "50vh !important", minWidth: "340px !important" },
      ".cm-tooltip-autocomplete li": { padding: "3px 8px !important" },
      ".cm-tooltip-autocomplete li.cp-hover": { background: "rgba(0,0,0,.06) !important", cursor: "pointer" },
      ".cm-tooltip-autocomplete li[aria-selected]": { background: "var(--primary-color, #2563eb) !important", color: "#fff !important" },
    })];
  }

  private _applyCompletionStyles(): void {
    if (document.getElementById("cp-hover-marker")) return;
    const marker = document.createElement("span");
    marker.id = "cp-hover-marker";
    marker.style.display = "none";
    document.body.appendChild(marker);

    let mx = 0, my = 0;
    window.addEventListener("mousemove", e => { mx = e.clientX; my = e.clientY; }, { passive: true, capture: true });

    const getItems = (): HTMLElement[] => [
      ...Array.from(document.querySelectorAll<HTMLElement>(".cm-tooltip-autocomplete li")),
      ...Array.from(this.renderRoot.querySelectorAll<HTMLElement>(".cm-tooltip-autocomplete li")),
    ];

    const tick = () => {
      const items = getItems();
      items.forEach(li => {
        // ── Hover souris ────────────────────────────────────────────────────
        const r = li.getBoundingClientRect();
        const over = mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom;
        li.style.background = over ? (this._darkMode ? "#4d78cc" : "#2563eb") : "";
        li.style.cursor = over ? "pointer" : "";

        // ── Aperçu icône MDI via <ha-icon> ──────────────────────────────────
        if (li.dataset.haIconInjected) return;
        const labelEl = li.querySelector(".cm-completionLabel") as HTMLElement | null;
        const iconName = labelEl?.textContent?.trim() ?? "";
        if (!iconName.startsWith("mdi:")) return;

        li.dataset.haIconInjected = "1";
        li.style.cssText += ";display:flex;align-items:center;";

        const haIcon = document.createElement("ha-icon") as HTMLElement;
        haIcon.setAttribute("icon", iconName);
        const iconColor = this._darkMode ? "#59bec2" : "#0550ae";
        haIcon.style.cssText = `width:20px;height:20px;--mdc-icon-size:18px;flex-shrink:0;pointer-events:none;margin-left:auto;padding-left:8px;color:${iconColor};`;
        li.appendChild(haIcon);
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private _saveSnapshot = (): void => {
    localStorage.setItem("card-playground-snapshot", this._yaml);
    localStorage.setItem("card-playground-yaml", this._yaml); // persiste même sans auto-save
    this._saved = true;
    setTimeout(() => { this._saved = false; }, 1000);
  };

  private _restoreSnapshot = (): void => {
    const snap = localStorage.getItem("card-playground-snapshot");
    if (!snap || !this._cmView) return;
    this._cmView.dispatch({
      changes: { from: 0, to: this._cmView.state.doc.length, insert: snap },
    });
    this._restored = true;
    setTimeout(() => { this._restored = false; }, 1000);
  };

  private _pasteYaml = (): void => {
    this._cmView?.contentDOM.focus();
    this._pasted = "ok";
    setTimeout(() => { this._pasted = false; }, 1500);
  };

  private _formatYaml = (): void => {
    if (!this._cmView) return;
    try {
      const parsed = parseYaml(this._yaml, { uniqueKeys: false });
      const formatted = stringifyYaml(parsed, { indent: 2, lineWidth: 0 });
      this._cmView.dispatch({
        changes: { from: 0, to: this._cmView.state.doc.length, insert: formatted },
      });
      this._formatted = true;
      setTimeout(() => { this._formatted = false; }, 1000);
    } catch {
      // YAML invalide — on ne touche pas à l'éditeur
    }
  };

  private _sendSettings(): void {
    this._channel.postMessage({ type: "settings-update", desktopWidth: this._desktopWidth } satisfies Msg);
  }

  // ── Clés YAML par type de carte ────────────────────────────────────────────
  private static readonly _CARD_KEYS: Record<string, Array<{ label: string; detail?: string }>> = {
    entity: [
      { label: "entity",              detail: "entity_id — requis" },
      { label: "name",                detail: "string" },
      { label: "icon",                detail: "string (mdi:...)" },
      { label: "show_state",          detail: "boolean" },
      { label: "state_color",         detail: "boolean" },
      { label: "theme",               detail: "string" },
      { label: "tap_action",          detail: "object" },
      { label: "hold_action",         detail: "object" },
      { label: "double_tap_action",   detail: "object" },
      { label: "footer",              detail: "object" },
    ],
    button: [
      { label: "entity",              detail: "entity_id" },
      { label: "name",                detail: "string" },
      { label: "icon",                detail: "string (mdi:...)" },
      { label: "show_name",           detail: "boolean" },
      { label: "show_state",          detail: "boolean" },
      { label: "show_icon",           detail: "boolean" },
      { label: "icon_height",         detail: "string (ex: 40px)" },
      { label: "theme",               detail: "string" },
      { label: "tap_action",          detail: "object" },
      { label: "hold_action",         detail: "object" },
      { label: "double_tap_action",   detail: "object" },
    ],
    tile: [
      { label: "entity",              detail: "entity_id — requis" },
      { label: "name",                detail: "string" },
      { label: "icon",                detail: "string (mdi:...)" },
      { label: "color",               detail: "string" },
      { label: "show_entity_picture", detail: "boolean" },
      { label: "vertical",            detail: "boolean" },
      { label: "hide_state",          detail: "boolean" },
      { label: "state_content",       detail: "string | list" },
      { label: "features",            detail: "list" },
      { label: "tap_action",          detail: "object" },
      { label: "hold_action",         detail: "object" },
      { label: "double_tap_action",   detail: "object" },
    ],
    gauge: [
      { label: "entity",              detail: "entity_id — requis" },
      { label: "name",                detail: "string" },
      { label: "unit",                detail: "string" },
      { label: "min",                 detail: "number" },
      { label: "max",                 detail: "number" },
      { label: "needle",              detail: "boolean" },
      { label: "severity",            detail: "object (green / yellow / red)" },
      { label: "theme",               detail: "string" },
      { label: "tap_action",          detail: "object" },
    ],
    markdown: [
      { label: "content",             detail: "string (Jinja2) — requis" },
      { label: "title",               detail: "string" },
      { label: "card_size",           detail: "number" },
      { label: "text_only",           detail: "boolean" },
      { label: "theme",               detail: "string" },
    ],
    "history-graph": [
      { label: "entities",            detail: "list — requis" },
      { label: "hours_to_show",       detail: "number (défaut: 24)" },
      { label: "refresh_interval",    detail: "number (secondes)" },
      { label: "title",               detail: "string" },
      { label: "show_names",          detail: "boolean" },
    ],
    "statistics-graph": [
      { label: "entities",            detail: "list — requis" },
      { label: "title",               detail: "string" },
      { label: "days_to_show",        detail: "number (défaut: 30)" },
      { label: "period",              detail: "object (5minute / hour / day / week / month)" },
      { label: "chart_type",          detail: "bar | line" },
      { label: "stat_types",          detail: "list (mean / min / max / sum / state)" },
      { label: "hide_legend",         detail: "boolean" },
    ],
    "weather-forecast": [
      { label: "entity",              detail: "entity_id (weather.*) — requis" },
      { label: "name",                detail: "string" },
      { label: "show_forecast",       detail: "boolean" },
      { label: "forecast_type",       detail: "daily | hourly | twice_daily" },
      { label: "secondary_info_attribute", detail: "string" },
      { label: "theme",               detail: "string" },
      { label: "tap_action",          detail: "object" },
    ],
    thermostat: [
      { label: "entity",              detail: "entity_id (climate.*) — requis" },
      { label: "name",                detail: "string" },
      { label: "theme",               detail: "string" },
    ],
    "media-control": [
      { label: "entity",              detail: "entity_id (media_player.*) — requis" },
      { label: "name",                detail: "string" },
      { label: "theme",               detail: "string" },
    ],
    glance: [
      { label: "entities",            detail: "list — requis" },
      { label: "title",               detail: "string" },
      { label: "show_name",           detail: "boolean" },
      { label: "show_icon",           detail: "boolean" },
      { label: "show_state",          detail: "boolean" },
      { label: "columns",             detail: "number" },
      { label: "state_color",         detail: "boolean" },
      { label: "theme",               detail: "string" },
    ],
    "picture-entity": [
      { label: "entity",              detail: "entity_id — requis" },
      { label: "image",               detail: "string (URL)" },
      { label: "camera_image",        detail: "entity_id (camera.*)" },
      { label: "camera_view",         detail: "auto | live" },
      { label: "name",                detail: "string" },
      { label: "show_name",           detail: "boolean" },
      { label: "show_state",          detail: "boolean" },
      { label: "state_image",         detail: "object (état → URL)" },
      { label: "aspect_ratio",        detail: "string (ex: 16x9)" },
      { label: "tap_action",          detail: "object" },
      { label: "hold_action",         detail: "object" },
      { label: "double_tap_action",   detail: "object" },
    ],
    "picture-glance": [
      { label: "entities",            detail: "list — requis" },
      { label: "image",               detail: "string (URL)" },
      { label: "camera_image",        detail: "entity_id (camera.*)" },
      { label: "title",               detail: "string" },
      { label: "show_state",          detail: "boolean" },
      { label: "aspect_ratio",        detail: "string" },
      { label: "tap_action",          detail: "object" },
      { label: "hold_action",         detail: "object" },
    ],
    "vertical-stack": [
      { label: "cards",               detail: "list — requis" },
      { label: "title",               detail: "string" },
    ],
    "horizontal-stack": [
      { label: "cards",               detail: "list — requis" },
      { label: "title",               detail: "string" },
    ],
    grid: [
      { label: "cards",               detail: "list — requis" },
      { label: "columns",             detail: "number" },
      { label: "square",              detail: "boolean" },
      { label: "title",               detail: "string" },
    ],
    conditional: [
      { label: "conditions",          detail: "list — requis" },
      { label: "card",                detail: "object — requis" },
    ],
    map: [
      { label: "entities",            detail: "list" },
      { label: "geo_location_sources",detail: "list" },
      { label: "title",               detail: "string" },
      { label: "aspect_ratio",        detail: "string" },
      { label: "default_zoom",        detail: "number" },
      { label: "dark_mode",           detail: "boolean" },
      { label: "hours_to_show",       detail: "number" },
      { label: "auto_fit",            detail: "boolean" },
    ],
    "alarm-panel": [
      { label: "entity",              detail: "entity_id (alarm_control_panel.*) — requis" },
      { label: "name",                detail: "string" },
      { label: "states",              detail: "list (armed_home / armed_away / armed_night)" },
      { label: "theme",               detail: "string" },
    ],
    iframe: [
      { label: "url",                 detail: "string (URL) — requis" },
      { label: "title",               detail: "string" },
      { label: "aspect_ratio",        detail: "string (ex: 75%)" },
    ],
    calendar: [
      { label: "entities",            detail: "list — requis" },
      { label: "title",               detail: "string" },
      { label: "initial_view",        detail: "dayGridMonth | dayGridDay | listWeek" },
      { label: "theme",               detail: "string" },
    ],
    logbook: [
      { label: "entities",            detail: "list — requis" },
      { label: "title",               detail: "string" },
      { label: "hours_to_show",       detail: "number (défaut: 24)" },
      { label: "theme",               detail: "string" },
    ],
    humidifier: [
      { label: "entity",              detail: "entity_id (humidifier.*) — requis" },
      { label: "name",                detail: "string" },
      { label: "theme",               detail: "string" },
    ],
    light: [
      { label: "entity",              detail: "entity_id (light.*) — requis" },
      { label: "name",                detail: "string" },
      { label: "theme",               detail: "string" },
    ],
    entities: [
      { label: "entities",            detail: "list — requis" },
      { label: "title",               detail: "string" },
      { label: "show_header",         detail: "boolean (défaut: true)" },
      { label: "state_color",         detail: "boolean" },
      { label: "column_config",       detail: "object — largeurs de colonnes" },
      { label: "header",              detail: "object" },
      { label: "footer",              detail: "object" },
      { label: "theme",               detail: "string" },
      { label: "card_mod",            detail: "object" },
    ],
    // ── Custom cards HACS ───────────────────────────────────────────────────

    // ── ha-canvas-card ───────────────────────────────────────────────────
    "custom:ha-canvas-card": [
      { label: "background",  detail: "couleur CSS (ex: #0a0a1a)" },
      { label: "height",      detail: "string (ex: 100%, 800px)" },
      { label: "cards",       detail: "list — sous-cartes positionnées" },
    ],

    // ── bubble-card ──────────────────────────────────────────────────────
    "custom:bubble-card": [
      { label: "card_type",           detail: "button | separator | empty-column | cover | media-player | select | pop-up | horizontal-buttons-stack — requis" },
      { label: "entity",              detail: "entity_id" },
      { label: "name",                detail: "string" },
      { label: "icon",                detail: "mdi:icon-name" },
      { label: "icon_color",          detail: "couleur HA ou var(--)" },
      { label: "sub_button",          detail: "list — boutons secondaires" },
      { label: "tap_action",          detail: "object (action)" },
      { label: "hold_action",         detail: "object (action)" },
      { label: "double_tap_action",   detail: "object (action)" },
      { label: "styles",              detail: "string CSS — surcharge visuelle" },
      { label: "scrolling_effect",    detail: "boolean" },
      { label: "columns",             detail: "number — pour horizontal-buttons-stack" },
      { label: "open_sensor",         detail: "entity_id — capteur d'ouverture (pop-up)" },
      { label: "close_sensor",        detail: "entity_id" },
      { label: "auto_close",          detail: "number — ms avant fermeture auto (pop-up)" },
      { label: "margin_top_mobile",   detail: "string (ex: 56px) — pop-up mobile" },
      { label: "margin_top_desktop",  detail: "string (ex: 56px) — pop-up desktop" },
      { label: "hash",                detail: "string — ancre URL pour pop-up (#popup-1)" },
      { label: "button_type",         detail: "button | name | icon | state | slider" },
      { label: "state_display",       detail: "string | template" },
      { label: "show_state",          detail: "boolean" },
      { label: "card_mod",            detail: "object — card-mod styles" },
    ],

    // ── mushroom (socle commun) ──────────────────────────────────────────
    "custom:mushroom-entity-card": [
      { label: "entity",              detail: "entity_id — requis" },
      { label: "name",                detail: "string" },
      { label: "icon",                detail: "mdi:icon-name" },
      { label: "icon_color",          detail: "couleur HA" },
      { label: "primary_info",        detail: "name | state | last-changed | last-updated | attribute | none" },
      { label: "secondary_info",      detail: "name | state | last-changed | last-updated | attribute | none" },
      { label: "badge_icon",          detail: "mdi:icon-name" },
      { label: "badge_color",         detail: "couleur HA" },
      { label: "layout",              detail: "default | vertical | horizontal" },
      { label: "fill_container",      detail: "boolean" },
      { label: "tap_action",          detail: "object (action)" },
      { label: "hold_action",         detail: "object (action)" },
      { label: "double_tap_action",   detail: "object (action)" },
      { label: "card_mod",            detail: "object — card-mod styles" },
    ],
    "custom:mushroom-template-card": [
      { label: "primary",             detail: "string | template — ligne principale" },
      { label: "secondary",           detail: "string | template — ligne secondaire" },
      { label: "icon",                detail: "mdi:icon-name | template" },
      { label: "icon_color",          detail: "couleur HA | template" },
      { label: "badge_icon",          detail: "mdi:icon-name | template" },
      { label: "badge_color",         detail: "couleur HA | template" },
      { label: "picture",             detail: "string URL | template" },
      { label: "entity",              detail: "entity_id" },
      { label: "multiline_secondary", detail: "boolean" },
      { label: "layout",              detail: "default | vertical | horizontal" },
      { label: "fill_container",      detail: "boolean" },
      { label: "tap_action",          detail: "object (action)" },
      { label: "hold_action",         detail: "object (action)" },
      { label: "double_tap_action",   detail: "object (action)" },
      { label: "card_mod",            detail: "object" },
    ],
    "custom:mushroom-light-card": [
      { label: "entity",              detail: "entity_id (light.*) — requis" },
      { label: "name",                detail: "string" },
      { label: "icon",                detail: "mdi:icon-name" },
      { label: "icon_color",          detail: "couleur HA" },
      { label: "show_brightness_control",  detail: "boolean" },
      { label: "show_color_temp_control",  detail: "boolean" },
      { label: "show_color_control",       detail: "boolean" },
      { label: "use_light_color",          detail: "boolean" },
      { label: "layout",              detail: "default | vertical | horizontal" },
      { label: "fill_container",      detail: "boolean" },
      { label: "tap_action",          detail: "object (action)" },
      { label: "hold_action",         detail: "object (action)" },
      { label: "double_tap_action",   detail: "object (action)" },
      { label: "card_mod",            detail: "object" },
    ],
    "custom:mushroom-climate-card": [
      { label: "entity",              detail: "entity_id (climate.*) — requis" },
      { label: "name",                detail: "string" },
      { label: "icon",                detail: "mdi:icon-name" },
      { label: "show_temperature_control", detail: "boolean" },
      { label: "hvac_modes",          detail: "list — modes affichés" },
      { label: "layout",              detail: "default | vertical | horizontal" },
      { label: "fill_container",      detail: "boolean" },
      { label: "tap_action",          detail: "object (action)" },
      { label: "hold_action",         detail: "object (action)" },
      { label: "card_mod",            detail: "object" },
    ],
    "custom:mushroom-chips-card": [
      { label: "chips",               detail: "list — requis" },
      { label: "alignment",           detail: "start | end | center | justify" },
      { label: "card_mod",            detail: "object" },
    ],
    "custom:mushroom-media-player-card": [
      { label: "entity",              detail: "entity_id (media_player.*) — requis" },
      { label: "name",                detail: "string" },
      { label: "icon",                detail: "mdi:icon-name" },
      { label: "use_media_artwork",   detail: "boolean" },
      { label: "show_volume_level",   detail: "boolean" },
      { label: "media_controls",      detail: "list (on_off / shuffle / previous / play_pause_stop / next / repeat)" },
      { label: "volume_controls",     detail: "list (volume_mute / volume_set / volume_buttons)" },
      { label: "layout",              detail: "default | vertical | horizontal" },
      { label: "fill_container",      detail: "boolean" },
      { label: "tap_action",          detail: "object (action)" },
      { label: "hold_action",         detail: "object (action)" },
      { label: "card_mod",            detail: "object" },
    ],
    "custom:mushroom-person-card": [
      { label: "entity",              detail: "entity_id (person.*) — requis" },
      { label: "name",                detail: "string" },
      { label: "layout",              detail: "default | vertical | horizontal" },
      { label: "fill_container",      detail: "boolean" },
      { label: "tap_action",          detail: "object (action)" },
      { label: "hold_action",         detail: "object (action)" },
      { label: "card_mod",            detail: "object" },
    ],
    "custom:mushroom-cover-card": [
      { label: "entity",              detail: "entity_id (cover.*) — requis" },
      { label: "name",                detail: "string" },
      { label: "icon",                detail: "mdi:icon-name" },
      { label: "show_buttons_control", detail: "boolean" },
      { label: "show_position_control", detail: "boolean" },
      { label: "show_tilt_position_control", detail: "boolean" },
      { label: "layout",              detail: "default | vertical | horizontal" },
      { label: "fill_container",      detail: "boolean" },
      { label: "tap_action",          detail: "object (action)" },
      { label: "hold_action",         detail: "object (action)" },
      { label: "card_mod",            detail: "object" },
    ],
    "custom:mushroom-alarm-control-panel-card": [
      { label: "entity",              detail: "entity_id (alarm_control_panel.*) — requis" },
      { label: "name",                detail: "string" },
      { label: "icon",                detail: "mdi:icon-name" },
      { label: "states",              detail: "list — états affichés" },
      { label: "layout",              detail: "default | vertical | horizontal" },
      { label: "fill_container",      detail: "boolean" },
      { label: "tap_action",          detail: "object (action)" },
      { label: "card_mod",            detail: "object" },
    ],

    // ── mini-graph-card ──────────────────────────────────────────────────
    "custom:mini-graph-card": [
      { label: "entities",            detail: "list — requis (entity_id ou objet)" },
      { label: "name",                detail: "string" },
      { label: "icon",                detail: "mdi:icon-name" },
      { label: "unit",                detail: "string — unité affichée" },
      { label: "hours_to_show",       detail: "number (défaut: 24)" },
      { label: "points_per_hour",     detail: "number (défaut: 0.5)" },
      { label: "aggregate_func",      detail: "mean | min | max | first | last | sum | delta" },
      { label: "group_by",            detail: "interval | date | hour" },
      { label: "line_color",          detail: "couleur hex ou liste" },
      { label: "line_width",          detail: "number (défaut: 5)" },
      { label: "font_size",           detail: "number — % de la taille de la carte" },
      { label: "font_size_header",    detail: "number" },
      { label: "decimals",            detail: "number" },
      { label: "animate",             detail: "boolean — animation du tracé" },
      { label: "smoothing",           detail: "boolean" },
      { label: "logarithmic",         detail: "boolean" },
      { label: "hour24",              detail: "boolean — format 24h" },
      { label: "show",                detail: "object — icon / name / state / graph / labels / points / legend / average / extrema" },
      { label: "color_thresholds",    detail: "list — seuils de couleur" },
      { label: "color_thresholds_transition", detail: "smooth | hard" },
      { label: "tap_action",          detail: "object (action)" },
      { label: "card_mod",            detail: "object" },
    ],

    // ── apexcharts-card ──────────────────────────────────────────────────
    "custom:apexcharts-card": [
      { label: "series",              detail: "list — requis (entity + config par série)" },
      { label: "graph_span",          detail: "string (ex: 24h, 7d, 1month)" },
      { label: "chart_type",          detail: "line | bar | scatter | pie | donut | radialBar" },
      { label: "stacked",             detail: "boolean" },
      { label: "update_interval",     detail: "string (ex: 1h, 5min)" },
      { label: "header",              detail: "object — show / title / colorize_states" },
      { label: "yaxis",               detail: "list — configuration axe Y" },
      { label: "all_series_config",   detail: "object — config commune à toutes les séries" },
      { label: "apex_config",         detail: "object — config ApexCharts native" },
      { label: "now",                 detail: "object — indicateur temps réel" },
      { label: "span",                detail: "object — start / end / offset" },
      { label: "card_mod",            detail: "object" },
    ],

    // ── auto-entities ────────────────────────────────────────────────────
    "custom:auto-entities": [
      { label: "card",                detail: "object — carte conteneur — requis" },
      { label: "filter",              detail: "object — include / exclude" },
      { label: "entities",            detail: "list — entités additionnelles fixes" },
      { label: "sort",                detail: "object — method / reverse / count / numeric_base" },
      { label: "show_empty",          detail: "boolean (défaut: true)" },
      { label: "unique",              detail: "boolean — déduplique les entités" },
      { label: "card_param",          detail: "string (défaut: entities)" },
    ],

    // ── button-card ──────────────────────────────────────────────────────
    "custom:button-card": [
      { label: "entity",              detail: "entity_id" },
      { label: "name",                detail: "string | false" },
      { label: "icon",                detail: "mdi:icon-name" },
      { label: "color",               detail: "couleur HA ou hex" },
      { label: "color_type",          detail: "icon | card | label | blank-card | label-card" },
      { label: "size",                detail: "string (ex: 40%)" },
      { label: "aspect_ratio",        detail: "string (ex: 1/1)" },
      { label: "show_name",           detail: "boolean" },
      { label: "show_icon",           detail: "boolean" },
      { label: "show_state",          detail: "boolean" },
      { label: "show_label",          detail: "boolean" },
      { label: "show_units",          detail: "boolean" },
      { label: "show_last_changed",   detail: "boolean" },
      { label: "show_entity_picture", detail: "boolean" },
      { label: "label",               detail: "string | template" },
      { label: "state_display",       detail: "string | template" },
      { label: "triggers_update",     detail: "list d'entity_id | 'all'" },
      { label: "hold_action",         detail: "object (action)" },
      { label: "tap_action",          detail: "object (action)" },
      { label: "double_tap_action",   detail: "object (action)" },
      { label: "styles",              detail: "object — styles CSS par élément" },
      { label: "state",               detail: "list — styles conditionnels par état" },
      { label: "custom_fields",       detail: "object — champs personnalisés" },
      { label: "extra_styles",        detail: "string CSS global" },
      { label: "card_size",           detail: "number" },
      { label: "variables",           detail: "object — variables CSS/template" },
      { label: "template",            detail: "string | list — templates à appliquer" },
      { label: "layout",              detail: "vertical | horizontal | name_state | icon_name" },
    ],
  };

  // ── Éléments du bloc styles: de button-card ──────────────────────────────
  private static readonly _BUTTON_CARD_STYLE_ELEMENTS = [
    { label: "card",            detail: "styles de la carte entière" },
    { label: "icon",            detail: "styles de l'icône" },
    { label: "name",            detail: "styles du nom" },
    { label: "state",           detail: "styles de l'état" },
    { label: "label",           detail: "styles du label" },
    { label: "grid",            detail: "layout CSS grid" },
    { label: "img_cell",        detail: "cellule image/icône" },
    { label: "custom_fields",   detail: "champs personnalisés (clé = nom du champ)" },
    { label: "lock",            detail: "styles du cadenas" },
    { label: "entities_area",   detail: "zone entités (multi-entity)" },
  ];

  // ── Clés qui prennent un sous-bloc (apply sans espace → Enter handler indente)
  private static readonly _BLOCK_KEYS = new Set([
    // Blocs action
    'tap_action', 'hold_action', 'double_tap_action', 'hold_action_repeat',
    // Sous-clés d'action qui sont des objets
    'target', 'confirmation', 'data', 'service_data',
    // Listes de cartes / vues
    'cards', 'views', 'conditions', 'badges', 'features',
    // Listes d'entités / items
    'entities',
    // Styles button-card (blocs)
    'styles', 'state_styles', 'styles_javascript', 'state',
    // Éléments sous styles: (card, icon, grid…)
    'card', 'img_cell', 'custom_fields', 'lock', 'entities_area',
    // Divers blocs carte
    'card_mod', 'header', 'footer', 'severity', 'segments',
    'filter', 'sort', 'variables', 'color_thresholds', 'series',
    'period',
  ]);

  // ── Clés à valeur booléenne ──────────────────────────────────────────────────
  private static readonly _BOOL_KEYS = new Set([
    // button-card
    'show_name', 'show_icon', 'show_state', 'show_label', 'show_units',
    'show_last_changed', 'show_entity_picture',
    // entités / generique
    'show_header', 'state_color', 'show_attribute_icon',
    // history / statistics
    'logarithmic_scale', 'hide_legend', 'show_names',
    // mushroom
    'fill_container', 'use_entity_picture', 'use_media_artwork', 'show_volume_level',
    // tile
    'hide_state', 'vertical',
    // misc
    'hold_action_repeat', 'selectable', 'scrolling', 'hour24',
    'show_camera', 'dark_mode', 'auto_fit', 'power_source_icon',
    'read_only', 'show_current_as_primary', 'show_indicator',
  ]);

  // Clés qui acceptent à la fois des valeurs enum ET des entity_id
  // (les deux compléteurs s'appliquent)
  private static readonly _ENTITY_ALSO_KEYS = new Set(['triggers_update']);

  // ── Valeurs scalaires connues par clé ────────────────────────────────────────
  private static readonly _KEY_VALUES: Record<string, Array<{ label: string; detail?: string }>> = {
    secondary_info: [
      { label: 'last-changed',  detail: 'date du dernier changement' },
      { label: 'last-updated',  detail: 'date de la dernière mise à jour' },
      { label: 'attribute',     detail: "valeur d'un attribut" },
      { label: 'state',         detail: 'état actuel' },
      { label: 'none',          detail: 'rien afficher' },
      { label: 'entity-id',     detail: "identifiant de l'entité" },
      { label: 'position',      detail: 'position (cover)' },
      { label: 'tilt-position', detail: 'inclinaison (cover)' },
      { label: 'brightness',    detail: 'luminosité (light)' },
      { label: 'volume-level',  detail: 'volume (media_player)' },
    ],
    format: [
      { label: 'none' },
      { label: 'relative',  detail: 'temps relatif (ex: il y a 2 h)' },
      { label: 'total',     detail: 'valeur totale' },
      { label: 'date',      detail: 'date seulement' },
      { label: 'time',      detail: 'heure seulement' },
      { label: 'datetime',  detail: 'date + heure' },
      { label: 'duration',  detail: 'durée formatée' },
      { label: 'precision', detail: 'précision numérique' },
      { label: 'kilo',      detail: '÷ 1000' },
      { label: 'hecto',     detail: '÷ 100' },
      { label: 'deca',      detail: '÷ 10' },
      { label: 'deci',      detail: '× 10' },
      { label: 'centi',     detail: '× 100' },
      { label: 'milli',     detail: '× 1000' },
    ],
    aspect_ratio: [
      { label: '1/1',  detail: 'carré' },
      { label: '2/1',  detail: 'large' },
      { label: '1/2',  detail: 'portrait' },
      { label: '16/9', detail: 'format vidéo' },
      { label: '9/16', detail: 'portrait vidéo' },
      { label: '4/3',  detail: 'classique' },
      { label: '3/4',  detail: 'portrait classique' },
    ],
    layout: [
      { label: 'vertical' },
      { label: 'horizontal' },
      { label: 'default' },
      { label: 'icon_only' },
      { label: 'name_only' },
      { label: 'label_only' },
      { label: 'icon_name',  detail: 'button-card' },
      { label: 'name_state', detail: 'button-card' },
    ],
    color_type: [
      { label: 'icon',       detail: "couleur sur l'icône" },
      { label: 'card',       detail: 'couleur sur la carte' },
      { label: 'label',      detail: 'couleur sur le label' },
      { label: 'blank-card', detail: 'carte sans fond' },
      { label: 'label-card', detail: 'carte label' },
    ],
    chart_type: [
      { label: 'line', detail: 'graphique linéaire' },
      { label: 'bar',  detail: 'graphique en barres' },
    ],
    period: [
      { label: '5minute', detail: '5 minutes' },
      { label: 'hour',    detail: 'heure' },
      { label: 'day',     detail: 'jour' },
      { label: 'week',    detail: 'semaine' },
      { label: 'month',   detail: 'mois' },
    ],
    stat_types: [
      { label: 'mean',   detail: 'moyenne' },
      { label: 'min',    detail: 'minimum' },
      { label: 'max',    detail: 'maximum' },
      { label: 'sum',    detail: 'somme' },
      { label: 'state',  detail: 'état brut' },
      { label: 'change', detail: 'variation' },
    ],
    initial_view: [
      { label: 'dayGridMonth', detail: 'vue mensuelle' },
      { label: 'dayGridDay',   detail: 'vue journalière' },
      { label: 'listWeek',     detail: 'vue liste semaine' },
    ],
    alignment: [
      { label: 'start' }, { label: 'end' }, { label: 'center' }, { label: 'justify' },
    ],
    bubble_card_type: [
      { label: 'button' },
      { label: 'separator' },
      { label: 'cover' },
      { label: 'select' },
      { label: 'empty-column' },
      { label: 'horizontal-buttons-stack' },
      { label: 'pop-up' },
    ],
    camera_view: [
      { label: 'auto', detail: 'live si disponible' },
      { label: 'live', detail: 'toujours en direct' },
    ],
    triggers_update: [
      { label: 'all', detail: 'réagit à tous les changements' },
    ],
    state_content: [
      { label: 'state',        detail: "état de l'entité" },
      { label: 'last-changed', detail: 'date du dernier changement' },
      { label: 'last-updated', detail: 'date de la dernière mise à jour' },
    ],
  };

  // Remonte les lignes depuis le curseur pour trouver le type de carte applicable.
  // Gestion des listes : quand on croise un marqueur "- " en remontant, on abaisse
  // le seuil d'indentation valide pour ignorer les siblings (ex: - type: attribute).
  private _getCardTypeAtCursor(state: import("@codemirror/state").EditorState, pos: number): string | null {
    const doc = state.doc;
    const cursorLine = doc.lineAt(pos);
    const cursorIndent = (cursorLine.text.match(/^(\s*)/) ?? ["", ""])[1].length;
    // threshold : indent max autorisé pour qu'un type: soit considéré comme parent
    let threshold = cursorIndent;

    for (let ln = cursorLine.number - 1; ln >= 1; ln--) {
      const line = doc.line(ln);
      if (line.text.trim() === '') continue;
      const lineIndent = (line.text.match(/^(\s*)/) ?? ["", ""])[1].length;
      if (lineIndent > threshold) continue; // trop indenté ou sibling → ignorer

      // type: trouvé dans le seuil autorisé → c'est le type de la carte parente
      const m = line.text.match(/^\s*-?\s*type:\s*(\S+)/);
      if (m) return m[1];

      // Marqueur de liste "-" à un niveau moins profond que le curseur :
      // tout type: au même niveau ou au-dessus est un sibling → abaisser le seuil
      if (/^\s*-/.test(line.text) && lineIndent < cursorIndent) {
        threshold = lineIndent - 1;
      }
    }
    return null;
  }

  private _keyComplete = (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const lineText = line.text;
    const lineFrom = line.from;

    // Ignorer les lignes type: (géré par _typeComplete)
    if (/^\s*-?\s*type:\s*/.test(lineText)) return null;

    // Ignorer les lignes qui ont déjà une valeur après ":"
    const textBeforeCursor = lineText.slice(0, ctx.pos - lineFrom);
    if (textBeforeCursor.includes(":")) return null;

    // Trouver le mot tapé juste avant le curseur — $ ancre à la fin (avant curseur)
    // Evite que /[\w-]+/ capture "- na" au lieu de "na" sur une ligne "  - na"
    const wordMatch = ctx.matchBefore(/[\w-]*$/);
    const fromPos = wordMatch ? wordMatch.from : ctx.pos;
    const typed = wordMatch ? wordMatch.text.toLowerCase() : '';

    // Vérifier qu'avant le mot il n'y a que des espaces ou un tiret de liste
    const beforeWord = lineText.slice(0, fromPos - lineFrom);
    if (!/^[\s-]*$/.test(beforeWord)) return null;

    // Priorité -1 : bloc target: → entity_id / device_id / area_id / label_id
    const parentKey = this._getParentBlockKey(ctx.state, ctx.pos, ['target', 'service_data', 'data']);
    if (parentKey === 'target') {
      const opts = [
        { label: 'entity_id', detail: 'entity_id | list — entité(s) cible(s)' },
        { label: 'device_id', detail: 'device_id | list' },
        { label: 'area_id',   detail: 'area_id | list' },
        { label: 'label_id',  detail: 'label_id | list' },
        { label: 'floor_id',  detail: 'floor_id | list' },
      ]
        .filter(o => typed.length === 0 || o.label.startsWith(typed))
        .map(o => ({ ...o, type: "variable" as const, apply: o.label + ': ' }));
      return opts.length ? { from: fromPos, options: opts, validFor: /[\w-]*/ } : null;
    }
    if (parentKey === 'service_data' || parentKey === 'data') {
      // Champs réels du service depuis hass.services[domain][service].fields
      const serviceId = this._getServiceAtCursor(ctx.state, ctx.pos);
      if (serviceId && serviceId.includes('.')) {
        const [domain, svcName] = serviceId.split('.');
        const fields = (this._hass as any)?.services?.[domain]?.[svcName]?.fields as
          Record<string, { description?: string; example?: unknown }> | undefined;
        if (fields) {
          const opts = Object.entries(fields)
            .filter(([k]) => typed.length === 0 || k.includes(typed))
            .map(([k, v]) => ({
              label: k,
              detail: (v.description ?? String(v.example ?? '')).slice(0, 50),
              type: "variable" as const,
              apply: k + ': ',
            }));
          if (opts.length) return { from: fromPos, options: opts, validFor: /[\w-]*/ };
        }
      }
      // Fallback générique si service inconnu
      return { from: fromPos, options: [
        { label: 'entity_id', detail: 'entity_id cible', type: "variable" as const, apply: 'entity_id: ' },
      ].filter(o => typed.length === 0 || o.label.includes(typed)), validFor: /[\w-]*/ };
    }

    // Priorité 0 : on est dans un bloc styles: de button-card
    const stylesLevel = this._getStylesBlockLevel(ctx.state, ctx.pos);
    if (stylesLevel === 'element') {
      // Directement sous styles: → noms d'éléments (card, icon, grid, custom_fields…)
      const opts = HaCardPlaygroundEditor._BUTTON_CARD_STYLE_ELEMENTS
        .filter(e => typed.length === 0 || e.label.startsWith(typed) || e.label.includes(typed))
        .map(e => ({ label: e.label, detail: e.detail, type: "variable" as const, apply: e.label + ':' }));
      return opts.length ? { from: fromPos, options: opts, validFor: /[\w-]*/ } : null;
    }
    if (stylesLevel === 'css') {
      // Dans un élément → propriétés CSS (format YAML liste : - property: value)
      const opts = HaCardPlaygroundEditor._CSS_PROPS
        .filter(p => typed.length === 0 || p.startsWith(typed) || p.includes(typed))
        .map(p => ({ label: p, type: "property" as const, apply: p + ': ' }));
      return opts.length ? { from: fromPos, options: opts, validFor: /[\w-]*/ } : null;
    }

    // Priorité 1 : on est dans un bloc tap_action / hold_action → sous-clés d'action
    const actionBlock = this._getActionBlockAtCursor(ctx.state, ctx.pos);
    if (actionBlock) {
      const opts = HaCardPlaygroundEditor._ACTION_KEYS
        .filter(k => typed.length === 0 || k.label.startsWith(typed) || k.label.includes(typed))
        .map(k => ({
          label: k.label, detail: k.detail, type: "variable" as const,
          apply: HaCardPlaygroundEditor._BLOCK_KEYS.has(k.label) ? k.label + ':' : k.label + ': ',
        }));
      return opts.length ? { from: fromPos, options: opts, validFor: /[\w-]*/ } : null;
    }

    // Priorité 2 : on est dans un bloc style: | → CSS
    if (this._getStyleBlockAtCursor(ctx.state, ctx.pos)) return null; // géré par _cssComplete

    // Priorité 2b : dans une liste entities: → clés de ligne d'entité
    const entitiesParent = this._getParentBlockKey(ctx.state, ctx.pos, ['entities']);
    if (entitiesParent === 'entities') {
      const rowKeys = [
        { label: 'entity',            detail: 'entity_id — requis' },
        { label: 'name',              detail: 'string' },
        { label: 'icon',              detail: 'mdi:icon-name' },
        { label: 'type',              detail: 'section | divider | weblink | button | custom' },
        { label: 'secondary_info',    detail: 'last-changed | last-updated | attribute | state | none' },
        { label: 'state_color',       detail: 'boolean' },
        { label: 'format',            detail: 'string (formatage date/nombre)' },
        { label: 'label',             detail: 'string — pour type: section' },
        { label: 'url',               detail: 'string — pour type: weblink' },
        { label: 'color',             detail: 'couleur — pour history/statistics-graph' },
        { label: 'attribute',         detail: "string — attribut à afficher (secondary_info: attribute)" },
        { label: 'tap_action',        detail: 'object' },
        { label: 'hold_action',       detail: 'object' },
        { label: 'double_tap_action', detail: 'object' },
      ]
        .filter(k => typed.length === 0 || k.label.includes(typed))
        .map(k => ({
          ...k, type: "variable" as const,
          apply: HaCardPlaygroundEditor._BLOCK_KEYS.has(k.label) ? k.label + ':' : k.label + ': ',
        }));
      return rowKeys.length ? { from: fromPos, options: rowKeys, validFor: /[\w-]*/ } : null;
    }

    // Priorité 2d : dans un item de cards: d'une ha-canvas-card → clés de positionnement
    const cardsParent = this._getParentBlockKey(ctx.state, ctx.pos, ['cards']);
    if (cardsParent === 'cards') {
      const rootType = this._getCardTypeAtCursor(ctx.state, ctx.pos);
      if (rootType === 'custom:ha-canvas-card') {
        const canvasItemKeys = [
          { label: 'x',       detail: 'number | string — position gauche (pixels ou %)' },
          { label: 'y',       detail: 'number | string — position haut (pixels ou %)' },
          { label: 'w',       detail: 'number | string — largeur (pixels ou %)' },
          { label: 'h',       detail: 'number | string — hauteur (pixels ou %)' },
          { label: 'right',   detail: 'number | string — ancrage bord droit' },
          { label: 'bottom',  detail: 'number | string — ancrage bord bas' },
          { label: 'z',       detail: 'number — z-index' },
          { label: 'opacity', detail: 'number (0–1)' },
          { label: 'card',    detail: 'object — carte HA imbriquée' },
        ]
          .filter(k => typed.length === 0 || k.label.includes(typed))
          .map(k => ({
            ...k, type: "variable" as const,
            apply: HaCardPlaygroundEditor._BLOCK_KEYS.has(k.label) ? k.label + ':' : k.label + ': ',
          }));
        if (canvasItemKeys.length) return { from: fromPos, options: canvasItemKeys, validFor: /[\w-]*/ };
      }
    }

    // Priorité 3 : clés selon le type de carte
    const cardType = this._getCardTypeAtCursor(ctx.state, ctx.pos);
    if (!cardType) return null;

    const keys = HaCardPlaygroundEditor._CARD_KEYS[cardType] ?? [];
    if (!keys.length) return null;

    const options = keys
      .filter(k => typed.length === 0 || k.label.includes(typed))
      .map(k => ({
        label: k.label, detail: k.detail, type: "variable" as const,
        apply: HaCardPlaygroundEditor._BLOCK_KEYS.has(k.label) ? k.label + ':' : k.label + ': ',
      }));

    if (!options.length) return null;
    return { from: fromPos, options, validFor: /[\w-]*/ };
  };

  private static readonly _NATIVE_CARD_TYPES = [
    "alarm-panel", "area", "button", "calendar", "conditional",
    "energy-distribution", "energy-gas-graph", "energy-solar-graph",
    "energy-usage-graph", "energy-water-graph",
    "entities", "entity", "gauge", "glance", "grid", "history-graph",
    "horizontal-stack", "humidifier", "iframe", "light", "logbook",
    "map", "markdown", "media-control", "picture", "picture-elements",
    "picture-entity", "picture-glance", "plant-status", "sensor",
    "shopping-list", "statistics-graph", "thermostat", "tile", "todo-list",
    "vertical-stack", "weather-forecast", "webpage",
  ];

  // ── Sous-clés des blocs tap_action / hold_action ────────────────────────
  private static readonly _ACTION_KEYS = [
    { label: 'action',          detail: 'none | more-info | toggle | call-service | navigate | url | assist' },
    { label: 'entity',          detail: 'entity_id — pour more-info / toggle' },
    { label: 'service',         detail: 'domain.service — pour call-service' },
    { label: 'data',            detail: 'object — payload du service (nouveau nom)' },
    { label: 'service_data',    detail: 'object — payload du service (legacy)' },
    { label: 'target',          detail: 'object — entity_id / device_id / area_id' },
    { label: 'navigation_path', detail: 'string — ex: /lovelace/0' },
    { label: 'url',             detail: 'string — URL externe' },
    { label: 'url_path',        detail: 'string — chemin relatif' },
    { label: 'confirmation',    detail: 'boolean | object — dialog de confirmation' },
  ];

  // ── Couleurs nommées HA ──────────────────────────────────────────────────
  private static readonly _HA_COLORS = [
    'red', 'pink', 'purple', 'deep-purple', 'indigo', 'blue', 'light-blue',
    'cyan', 'teal', 'green', 'light-green', 'lime', 'yellow', 'amber',
    'orange', 'deep-orange', 'brown', 'grey', 'blue-grey', 'black', 'white',
    'disabled', 'warning', 'error', 'success', 'info',
    'var(--primary-color)', 'var(--accent-color)', 'var(--primary-text-color)',
    'var(--secondary-text-color)', 'var(--error-color)', 'var(--warning-color)',
    'var(--success-color)', 'var(--info-color)',
  ];

  // ── Fonctions Jinja2 / templates HA ─────────────────────────────────────
  private static readonly _HA_TEMPLATE_FNS: Array<{ label: string; detail: string }> = [
    { label: 'states',               detail: "states('entity_id') → valeur de l'entité" },
    { label: 'state_attr',           detail: "state_attr('entity_id', 'attr')" },
    { label: 'is_state',             detail: "is_state('entity_id', 'state') → bool" },
    { label: 'is_state_attr',        detail: "is_state_attr('entity_id', 'attr', val)" },
    { label: 'has_value',            detail: "has_value('entity_id') → bool" },
    { label: 'now',                  detail: "now() → datetime locale actuelle" },
    { label: 'utcnow',               detail: "utcnow() → datetime UTC" },
    { label: 'today_at',             detail: "today_at('HH:MM') → datetime" },
    { label: 'as_timestamp',         detail: "as_timestamp(dt) → timestamp UNIX" },
    { label: 'as_datetime',          detail: "as_datetime(ts) → datetime" },
    { label: 'relative_time',        detail: "relative_time(dt) → 'il y a 5 min'" },
    { label: 'timedelta',            detail: "timedelta(hours=1, minutes=30)" },
    { label: 'float',                detail: "float(value, default=0)" },
    { label: 'int',                  detail: "int(value, default=0)" },
    { label: 'bool',                 detail: "bool(value, default=False)" },
    { label: 'min',                  detail: "min(a, b) ou min([liste])" },
    { label: 'max',                  detail: "max(a, b) ou max([liste])" },
    { label: 'round',                detail: "round(value, precision)" },
    { label: 'abs',                  detail: "abs(value)" },
    { label: 'log',                  detail: "log(value, base=e)" },
    { label: 'sqrt',                 detail: "sqrt(value)" },
    { label: 'sin',                  detail: "sin(angle)" },
    { label: 'cos',                  detail: "cos(angle)" },
    { label: 'iif',                  detail: "iif(condition, true_val, false_val)" },
    { label: 'expand',               detail: "expand(entity) → entités du groupe" },
    { label: 'area_id',              detail: "area_id('entity_id')" },
    { label: 'area_name',            detail: "area_name('entity_id')" },
    { label: 'area_entities',        detail: "area_entities('area_name')" },
    { label: 'device_id',            detail: "device_id('entity_id')" },
    { label: 'device_attr',          detail: "device_attr('device_id', 'attr')" },
    { label: 'label_id',             detail: "label_id('label_name')" },
    { label: 'label_name',           detail: "label_name('label_id')" },
    { label: 'integration_entities', detail: "integration_entities('integration')" },
    { label: 'trigger',              detail: "trigger — objet déclencheur (automations)" },
    { label: 'this',                 detail: "this — entité courante" },
    { label: 'namespace',            detail: "namespace() — partager entre boucles Jinja2" },
    { label: 'range',                detail: "range(n) — séquence 0..n-1" },
    { label: 'dict',                 detail: "dict(key=val) — créer un dictionnaire" },
  ];

  // ── Propriétés CSS pour blocs style: | ──────────────────────────────────
  private static readonly _CSS_PROPS = [
    'background', 'background-color', 'background-image', 'background-size',
    'background-position', 'background-repeat',
    'border', 'border-radius', 'border-color', 'border-width', 'border-style',
    'border-top', 'border-bottom', 'border-left', 'border-right',
    'color', 'opacity', 'visibility',
    'font-size', 'font-weight', 'font-family', 'font-style',
    'display', 'flex', 'flex-direction', 'flex-wrap', 'align-items',
    'justify-content', 'justify-self', 'gap',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
    'position', 'top', 'right', 'bottom', 'left', 'z-index',
    'overflow', 'cursor', 'pointer-events',
    'transform', 'transition', 'animation',
    'box-shadow', 'text-shadow',
    'text-align', 'text-transform', 'text-decoration', 'line-height',
    'letter-spacing', 'white-space', 'overflow-wrap',
    // Variables CSS HA
    '--card-background-color',
    '--primary-text-color', '--secondary-text-color', '--disabled-text-color',
    '--primary-color', '--accent-color',
    '--ha-card-border-radius', '--ha-card-box-shadow',
    '--ha-card-border-color', '--ha-card-border-width', '--ha-card-background',
    '--mdc-icon-size', '--mdc-icon-button-size',
    '--state-icon-color', '--state-color',
    '--paper-item-icon-color', '--sidebar-icon-color',
  ];

  // ── Emoji visuels pour les icônes MDI les plus communes ──────────────────
  private static readonly _MDI_EMOJI: Record<string, string> = {
    // Éclairage
    "lightbulb":"💡","lightbulb-outline":"💡","lightbulb-on":"💡","lightbulb-on-outline":"💡","lightbulb-off":"💡","ceiling-light":"💡","floor-lamp":"💡","desk-lamp":"💡","string-lights":"💡","led-strip":"💡","lamp":"💡","lava-lamp":"💡",
    // Interrupteurs & alimentation
    "toggle-switch":"🔘","toggle-switch-off":"🔘","power":"⚡","power-plug":"🔌","power-plug-off":"🔌","power-socket":"🔌","electric-switch":"🔘","lightning-bolt":"⚡","flash":"⚡",
    // Climatisation & chauffage
    "thermometer":"🌡️","thermometer-high":"🌡️","thermometer-low":"🌡️","thermostat":"🌡️","thermostat-box":"🌡️","air-conditioner":"❄️","fan":"🌀","fan-off":"🌀","snowflake":"❄️","snowflake-melt":"❄️","heat-wave":"🔥","hvac":"🌡️","radiator":"🔥","fireplace":"🔥","heat-pump":"♨️",
    // Capteurs
    "motion-sensor":"👁️","motion-sensor-off":"👁️","door-sensor":"🚪","window-sensor":"🪟","smoke-detector":"🚨","water-alert":"💧","leak":"💧","water":"💧","vibration":"📳","brightness-5":"☀️","brightness-6":"☀️","brightness-7":"☀️","eye":"👁️","eye-off":"👁️","radar":"📡","pulse":"💓",
    // Sécurité
    "lock":"🔒","lock-open":"🔓","lock-outline":"🔒","lock-open-outline":"🔓","lock-alert":"🔒","shield":"🛡️","shield-outline":"🛡️","shield-check":"🛡️","shield-home":"🛡️","alarm-light":"🚨","alarm-panel":"🚨","cctv":"📷","doorbell":"🔔","doorbell-video":"📷","key":"🗝️","key-outline":"🗝️","security":"🛡️",
    // Médias
    "play":"▶️","pause":"⏸️","stop":"⏹️","skip-forward":"⏭️","skip-backward":"⏮️","rewind":"⏪","fast-forward":"⏩","speaker":"🔊","speaker-wireless":"🔊","speaker-off":"🔇","speaker-multiple":"🔊","television":"📺","television-classic":"📺","television-play":"📺","radio":"📻","cast":"📡","volume-high":"🔊","volume-medium":"🔉","volume-low":"🔈","volume-mute":"🔇","volume-off":"🔇","music":"🎵","music-note":"🎵","microphone":"🎤","microphone-off":"🎤","headphones":"🎧","remote-tv":"📺",
    // Météo
    "weather-sunny":"☀️","weather-sunny-off":"🌤️","weather-night":"🌙","weather-cloudy":"☁️","weather-partly-cloudy":"⛅","weather-rainy":"🌧️","weather-pouring":"🌧️","weather-snowy":"❄️","weather-snowy-rainy":"🌨️","weather-windy":"💨","weather-fog":"🌫️","weather-lightning":"⛈️","weather-lightning-rainy":"⛈️","weather-hail":"🌨️","umbrella":"☂️",
    // Réseau
    "wifi":"📶","wifi-off":"📵","lan":"🔗","router-wireless":"📡","router-network":"📡","bluetooth":"🔵","bluetooth-off":"🔵","cloud":"☁️","cloud-off-outline":"☁️","hub":"🔗","server":"🖥️",
    // Énergie
    "solar-power":"☀️","solar-power-variant":"☀️","wind-power":"💨","battery":"🔋","battery-outline":"🔋","battery-high":"🔋","battery-medium":"🔋","battery-low":"🪫","battery-charging":"🔋","power-cycle":"⚡","meter-electric":"⚡","meter-gas":"🔥","meter-water":"💧","ev-station":"🔌","ev-plug-type2":"🔌","transmission-tower":"⚡",
    // Transport
    "car":"🚗","car-electric":"🚗","car-connected":"🚗","garage":"🏠","garage-open":"🏠","bus":"🚌","train":"🚂","bicycle":"🚲","walk":"🚶","run":"🏃","airplane":"✈️","rocket":"🚀",
    // Maison & pièces
    "home":"🏠","home-outline":"🏠","home-city":"🏘️","home-assistant":"🏠","sofa":"🛋️","bed":"🛏️","bathtub":"🛁","shower":"🚿","toilet":"🚽","kitchen-set":"🍳","door-open":"🚪","door-closed":"🚪",
    // Jardin & plantes
    "flower":"🌸","flower-outline":"🌸","sprout":"🌱","sprout-outline":"🌱","watering-can":"🪣","leaf":"🍃","leaf-off":"🍃","pine-tree":"🌲","grass":"🌿","tree":"🌳","cactus":"🌵",
    // Personnes & animaux
    "account":"👤","account-outline":"👤","account-group":"👥","account-group-outline":"👥","baby":"👶","human":"🧍","human-male":"👨","human-female":"👩","dog":"🐕","dog-side":"🐕","cat":"🐈","bird":"🐦","fish":"🐟","rabbit":"🐇","paw":"🐾",
    // Électroménager
    "washing-machine":"🫧","dishwasher":"🍽️","dryer":"🫧","iron":"👔","vacuum":"🌀","robot-vacuum":"🤖","robot-vacuum-variant":"🤖","coffee-maker":"☕","kettle":"☕","microwave":"📦","fridge":"🧊","oven":"🔥",
    // Divers
    "bell":"🔔","bell-ring":"🔔","bell-outline":"🔔","bell-off":"🔕","clock":"🕐","clock-outline":"🕐","calendar":"📅","calendar-outline":"📅","cog":"⚙️","cog-outline":"⚙️","cogs":"⚙️","wrench":"🔧","wrench-outline":"🔧","check":"✅","check-circle":"✅","alert":"⚠️","alert-circle":"⚠️","information":"ℹ️","information-outline":"ℹ️","help-circle":"❓","star":"⭐","star-outline":"⭐","heart":"❤️","heart-outline":"🤍","bookmark":"🔖","tag":"🏷️","pencil":"✏️","trash-can":"🗑️","delete":"🗑️","plus":"➕","minus":"➖","refresh":"🔄","sync":"🔄","send":"📤","share":"📤","link":"🔗","qrcode":"📱","fire":"🔥",
  };


  // Remonte / descend les lignes pour trouver l'entity: du bloc courant
  private _getEntityAtCursor(state: import("@codemirror/state").EditorState, pos: number): string | null {
    const doc = state.doc;
    const cursorLine = doc.lineAt(pos);
    const cursorIndent = (cursorLine.text.match(/^(\s*)/) ?? ["", ""])[1].length;

    const entityRe = /^\s*-?\s*entity:\s*(\S+)/;
    // Scan vers le haut
    for (let ln = cursorLine.number; ln >= 1; ln--) {
      const line = doc.line(ln);
      const indent = (line.text.match(/^(\s*)/) ?? ["", ""])[1].length;
      if (indent > cursorIndent) continue;
      if (indent < cursorIndent) break;
      const m = line.text.match(entityRe);
      if (m) return m[1];
    }
    // Scan vers le bas (entity peut être après attribute dans le YAML)
    for (let ln = cursorLine.number + 1; ln <= doc.lines; ln++) {
      const line = doc.line(ln);
      const indent = (line.text.match(/^(\s*)/) ?? ["", ""])[1].length;
      if (indent < cursorIndent) break;
      const m = line.text.match(entityRe);
      if (m) return m[1];
    }
    return null;
  }

  // Détecte si le curseur est dans un bloc styles: de button-card
  // Retourne : null | 'element' (directement sous styles:) | 'css' (dans un élément, position - prop:)
  private _getStylesBlockLevel(state: import("@codemirror/state").EditorState, pos: number): 'element' | 'css' | null {
    const doc = state.doc;
    const cursorLine = doc.lineAt(pos);
    const cursorIndent = (cursorLine.text.match(/^(\s*)/) ?? ["", ""])[1].length;

    // Remonte en cherchant le contexte : styles: ou un element sous styles:
    const stylesRe = /^(\s*)(styles|state_styles|styles_javascript):\s*$/;
    const elementRe = /^(\s+)[\w-]+:\s*$/; // ligne de type  "  card:", "  grid:"
    let foundElementIndent: number | null = null;

    for (let ln = cursorLine.number - 1; ln >= 1; ln--) {
      const l = state.doc.line(ln);
      if (l.text.trim() === '') continue;
      const lIndent = (l.text.match(/^(\s*)/) ?? ["", ""])[1].length;

      if (lIndent >= cursorIndent) continue; // même niveau ou plus profond → ignorer

      // On cherche un ancêtre direct
      if (foundElementIndent === null) {
        // Premier ancêtre avec indent < curseur
        const mStyles = l.text.match(stylesRe);
        if (mStyles) return 'element'; // directement sous styles:
        // Sinon, on est peut-être dans un élément (card/icon/grid/…) sous styles:
        foundElementIndent = lIndent;
        continue;
      }

      // Deuxième ancêtre (parent de l'élément trouvé)
      if (lIndent < foundElementIndent) {
        const mStyles = l.text.match(stylesRe);
        return mStyles ? 'css' : null;
      }
    }
    return null;
  }

  // Retourne la clé du bloc parent direct si elle fait partie de la liste donnée.
  // Gère les listes YAML : si l'ancêtre direct est un item "-", remonte encore
  // jusqu'à trouver la vraie clé parente (ex: entities:) ou un ancêtre non-liste.
  private _getParentBlockKey(state: import("@codemirror/state").EditorState, pos: number, keys: string[]): string | null {
    const line = state.doc.lineAt(pos);
    const cursorIndent = (line.text.match(/^(\s*)/) ?? ["", ""])[1].length;
    const re = new RegExp(`^\\s*(${keys.join('|')}):\\s*$`);
    let lastIndent = cursorIndent;

    for (let lineNum = line.number - 1; lineNum >= 1; lineNum--) {
      const l = state.doc.line(lineNum);
      if (l.text.trim() === '') continue;
      const lIndent = (l.text.match(/^(\s*)/) ?? ["", ""])[1].length;
      if (lIndent >= lastIndent) continue;

      // Correspond à une des clés recherchées → trouvé
      const m = l.text.match(re);
      if (m) return m[1];

      // Marqueur de liste "- " : on est sorti d'un item de liste vers son parent
      // → continuer à remonter depuis ce niveau
      if (/^\s*-/.test(l.text)) {
        lastIndent = lIndent;
        continue;
      }

      // Autre ancêtre qui ne correspond pas → hors contexte
      return null;
    }
    return null;
  }

  // Trouve le service: ou perform_action: dans le bloc courant (action block)
  private _getServiceAtCursor(state: import("@codemirror/state").EditorState, pos: number): string | null {
    const line = state.doc.lineAt(pos);
    const cursorIndent = (line.text.match(/^(\s*)/) ?? ["", ""])[1].length;
    const serviceRe = /^\s*(?:service|perform_action):\s*(\S+)/;
    for (let lineNum = line.number - 1; lineNum >= 1; lineNum--) {
      const l = state.doc.line(lineNum);
      if (l.text.trim() === '') continue;
      const lIndent = (l.text.match(/^(\s*)/) ?? ["", ""])[1].length;
      if (lIndent < cursorIndent - 4) break;
      const m = l.text.match(serviceRe);
      if (m) return m[1];
    }
    return null;
  }

  // Détecte si le curseur est dans un bloc tap_action / hold_action / double_tap_action
  private _getActionBlockAtCursor(state: import("@codemirror/state").EditorState, pos: number): string | null {
    const line = state.doc.lineAt(pos);
    const cursorIndent = (line.text.match(/^(\s*)/) ?? ["", ""])[1].length;
    const actionRe = /^(\s*)(tap_action|hold_action|double_tap_action|hold_action_repeat|confirmation):\s*$/;
    for (let lineNum = line.number - 1; lineNum >= 1; lineNum--) {
      const l = state.doc.line(lineNum);
      if (l.text.trim() === '') continue;
      const lIndent = (l.text.match(/^(\s*)/) ?? ["", ""])[1].length;
      if (lIndent >= cursorIndent) continue;
      const m = l.text.match(actionRe);
      return m ? m[2] : null; // premier ancêtre avec moins d'indent
    }
    return null;
  }

  // Détecte si le curseur est dans un bloc style: | ou extra_styles: |
  private _getStyleBlockAtCursor(state: import("@codemirror/state").EditorState, pos: number): boolean {
    const line = state.doc.lineAt(pos);
    const cursorIndent = (line.text.match(/^(\s*)/) ?? ["", ""])[1].length;
    if (cursorIndent === 0) return false;
    const styleRe = /^\s*(style|extra_styles|card_style):\s*[|>]/;
    for (let lineNum = line.number - 1; lineNum >= 1; lineNum--) {
      const l = state.doc.line(lineNum);
      if (l.text.trim() === '') continue;
      if (styleRe.test(l.text)) {
        const styleIndent = (l.text.match(/^(\s*)/) ?? ["", ""])[1].length;
        return styleIndent < cursorIndent;
      }
      // Clé YAML racine qui n'est pas style: → on est sorti du bloc
      if (/^\S/.test(l.text)) return false;
    }
    return false;
  }

  // Complétion pour icon: → mdi:...
  private _iconComplete = (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const lineText = line.text;
    const cursorCol = ctx.pos - line.from;

    let valueFrom: number;
    let typed: string;

    // Cas 1 — clé YAML :  icon: mdi:...
    const yamlMatch = lineText.match(/^(\s*icon:\s*)(.*)/);
    if (yamlMatch && ctx.pos >= line.from + yamlMatch[1].length) {
      valueFrom = line.from + yamlMatch[1].length;
      typed = yamlMatch[2].toLowerCase();
      // Valeur vide → propose juste "mdi:" pour démarrer la saisie
      if (typed.length === 0) {
        return { from: valueFrom, options: [{ label: "mdi:", detail: "→ tapez le nom de l'icône", type: "variable" as const }] };
      }
    } else {
      // Cas 2 — attribut HTML :  icon="mdi:..."  ou  icon='mdi:...'
      const textUpToCursor = lineText.slice(0, cursorCol);
      const attrMatch = textUpToCursor.match(/icon=(["'])([^"']*)/);
      if (!attrMatch || attrMatch.index === undefined) return null;
      valueFrom = line.from + attrMatch.index + 6;
      typed = attrMatch[2].toLowerCase();
      if (typed.length === 0) {
        return { from: valueFrom, options: [{ label: "mdi:", detail: "→ tapez le nom de l'icône", type: "variable" as const }] };
      }
    }

    const search = typed.startsWith("mdi:") ? typed.slice(4) : typed;
    const options = MDI_ICON_NAMES
      .filter(i => i.includes(search))
      .slice(0, 80)
      .map(i => ({
        label: `mdi:${i}`,
        type: "variable" as const,
      }));

    if (!options.length) return null;
    return { from: valueFrom, options };
  };

  // Complétion pour attribute: → attributs réels de l'entité courante
  private _attributeComplete = (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const m = line.text.match(/^(\s*(?:attribute|state_attribute):\s*)(.*)/);
    if (!m) return null;

    const valueFrom = line.from + m[1].length;
    if (ctx.pos < valueFrom) return null;

    const typed = m[2].toLowerCase();
    if (!ctx.explicit && typed.length === 0) return null;

    const entityId = this._getEntityAtCursor(ctx.state, ctx.pos);
    if (!entityId) return null;

    const attrs = (this._hass as any)?.states?.[entityId]?.attributes as Record<string, unknown> | undefined;
    if (!attrs) return null;

    const options = Object.entries(attrs)
      .filter(([k]) => k.toLowerCase().includes(typed))
      .map(([k, v]) => ({
        label: k,
        detail: String(v).slice(0, 40),
        type: "variable" as const,
      }));

    if (!options.length) return null;
    return { from: valueFrom, options };
  };

  // ── Valeurs pour action: ─────────────────────────────────────────────────
  private _actionValueComplete = (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const m = line.text.match(/^(\s*action:\s*)(.*)/);
    if (!m) return null;
    const valueFrom = line.from + m[1].length;
    if (ctx.pos < valueFrom) return null;
    const typed = m[2].toLowerCase();
    const actions = [
      { label: 'none',           detail: 'Aucune action' },
      { label: 'more-info',      detail: "Ouvrir le panneau d'infos de l'entité" },
      { label: 'toggle',         detail: 'Toggle on/off' },
      { label: 'call-service',   detail: 'Appeler un service HA (legacy)' },
      { label: 'perform-action', detail: 'Appeler un service HA (nouveau)' },
      { label: 'navigate',       detail: 'Naviguer vers une vue Lovelace' },
      { label: 'url',            detail: 'Ouvrir une URL externe' },
      { label: 'assist',         detail: "Ouvrir l'assistant vocal" },
      { label: 'fire-dom-event', detail: 'Émettre un événement DOM personnalisé' },
    ];
    const options = actions
      .filter(a => a.label.includes(typed))
      .map(a => ({ ...a, type: "variable" as const }));
    if (!options.length) return null;
    return { from: valueFrom, options };
  };

  // ── Vues Lovelace pour navigation_path: ─────────────────────────────────
  private _navPathComplete = (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const m = line.text.match(/^(\s*(?:navigation_path|url_path):\s*)(.*)/);
    if (!m) return null;
    const valueFrom = line.from + m[1].length;
    if (ctx.pos < valueFrom) return null;
    const typed = m[2].toLowerCase();

    // Lire les vues depuis le panneau Lovelace
    const panels = (window as any).__lovelace_panels ?? (window as any).lovelaceConfig?.views;
    const lovelace = (document.querySelector("home-assistant") as any)
      ?.__lovelace ?? (window as any).__lovelaceConfig;
    const views: Array<{ path?: string; title?: string; url_path?: string }> =
      lovelace?.config?.views ?? lovelace?.views ?? [];

    const options: Array<{ label: string; detail?: string; type: string }> = [];

    // Vues Lovelace
    for (const v of views) {
      const path = v.path ?? v.url_path;
      if (!path) continue;
      const full = `/lovelace/${path}`;
      if (!typed || full.includes(typed) || path.includes(typed)) {
        options.push({ label: full, detail: v.title ?? path, type: "variable" as const });
      }
    }

    // Panneaux HA (sidebar)
    const haPanels = (this._hass as any)?.panels as Record<string, { title?: string; url_path?: string }> | undefined;
    if (haPanels) {
      for (const [key, panel] of Object.entries(haPanels)) {
        const full = `/${key}`;
        if (!typed || full.includes(typed)) {
          options.push({ label: full, detail: panel.title ?? key, type: "variable" as const });
          if (options.length >= 60) break;
        }
      }
    }

    // Suggestions statiques si rien trouvé
    if (!options.length) {
      const statics = ['/lovelace/0', '/lovelace/1', '/lovelace/2', '/lovelace/home', '/lovelace/rooms', '/energy', '/map', '/logbook', '/history'];
      statics.filter(s => !typed || s.includes(typed))
        .forEach(s => options.push({ label: s, type: "variable" as const }));
    }

    return options.length ? { from: valueFrom, options: options.slice(0, 60) } : null;
  };

  // ── Services depuis hass.services ───────────────────────────────────────
  private _serviceComplete = (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const m = line.text.match(/^(\s*(?:service|perform_action):\s*)(.*)/);
    if (!m) return null;
    const valueFrom = line.from + m[1].length;
    if (ctx.pos < valueFrom) return null;
    const typed = m[2].toLowerCase();
    if (!ctx.explicit && typed.length < 1) return null;

    const services = (this._hass as any)?.services as Record<string, Record<string, unknown>> | undefined;
    if (!services) return null;

    const options: Array<{ label: string; detail?: string; type: string }> = [];
    for (const [domain, svcs] of Object.entries(services)) {
      for (const svcName of Object.keys(svcs)) {
        const full = `${domain}.${svcName}`;
        if (full.includes(typed)) {
          options.push({ label: full, detail: domain, type: "variable" as const });
          if (options.length >= 80) break;
        }
      }
      if (options.length >= 80) break;
    }
    return options.length ? { from: valueFrom, options } : null;
  };

  // ── Couleurs HA nommées ──────────────────────────────────────────────────
  private _colorComplete = (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const m = line.text.match(/^(\s*(?:color|icon_color|card_color|badge_color|label_color|accent_color|background_color):\s*)(.*)/);
    if (!m) return null;
    const valueFrom = line.from + m[1].length;
    if (ctx.pos < valueFrom) return null;
    const typed = m[2].toLowerCase();
    const options = HaCardPlaygroundEditor._HA_COLORS
      .filter(c => typed.length === 0 || c.toLowerCase().includes(typed))
      .map(c => ({ label: c, type: "variable" as const }));
    if (!options.length) return null;
    return { from: valueFrom, options };
  };

  // ── Fonctions Jinja2 dans {{ }} et {% %} ─────────────────────────────────
  private _templateComplete = (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const textUpToCursor = line.text.slice(0, ctx.pos - line.from);
    // Détecter si on est à l'intérieur de {{ ... }} ou {% ... %}
    const lastOpen = Math.max(textUpToCursor.lastIndexOf('{{'), textUpToCursor.lastIndexOf('{%'));
    const lastClose = Math.max(textUpToCursor.lastIndexOf('}}'), textUpToCursor.lastIndexOf('%}'));
    if (lastOpen === -1 || lastOpen < lastClose) return null;

    const word = ctx.matchBefore(/[\w.]+/);
    if (!word && !ctx.explicit) return null;
    const typed = (word?.text ?? '').toLowerCase();

    const options = HaCardPlaygroundEditor._HA_TEMPLATE_FNS
      .filter(f => typed.length === 0 || f.label.startsWith(typed) || f.label.includes(typed))
      .map(f => ({ ...f, type: "function" as const }));
    if (!options.length) return null;
    return { from: word?.from ?? ctx.pos, options };
  };

  // ── Propriétés CSS dans blocs style: | ──────────────────────────────────
  private _cssComplete = (ctx: CompletionContext): CompletionResult | null => {
    if (!this._getStyleBlockAtCursor(ctx.state, ctx.pos)) return null;
    const line = ctx.state.doc.lineAt(ctx.pos);
    const textUpToCursor = line.text.slice(0, ctx.pos - line.from);
    // En position de propriété : avant tout ":"
    if (textUpToCursor.includes(':')) return null;
    const word = ctx.matchBefore(/[-\w]+/);
    if (!word && !ctx.explicit) return null;
    const typed = (word?.text ?? '').toLowerCase();
    const options = HaCardPlaygroundEditor._CSS_PROPS
      .filter(p => typed.length === 0 || p.startsWith(typed) || p.includes(typed))
      .map(p => ({ label: p, type: "property" as const }));
    if (!options.length) return null;
    return { from: word?.from ?? ctx.pos, options };
  };

  private _typeComplete = (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const m = line.text.match(/^(\s*-?\s*type:\s*)(.*)/);
    if (!m) return null;

    const valueFrom = line.from + m[1].length;
    if (ctx.pos < valueFrom) return null;

    const typed = m[2].toLowerCase();

    // Cartes natives HA
    const options: Array<{ label: string; detail?: string; type: string; boost: number }> =
      HaCardPlaygroundEditor._NATIVE_CARD_TYPES
        .filter(t => t.includes(typed))
        .map(t => ({ label: t, type: "keyword", boost: 2 }));

    // Cartes HACS — se déclarent dans window.customCards
    const registry = (window as any).customCards as Array<{ type: string; name?: string }> | undefined;
    if (registry) {
      registry
        .filter(c => c.type && `custom:${c.type}`.includes(typed))
        .forEach(c => options.push({
          label: `custom:${c.type}`,
          detail: c.name,
          type: "variable",
          boost: 1,
        }));
    }

    if (!options.length) return null;
    return { from: valueFrom, options };
  };

  // ── Valeurs scalaires (booléens + enums) ─────────────────────────────────────
  private _scalarValueComplete = (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const lineText = line.text;

    if (/^\s*-?\s*type:\s*/.test(lineText)) return null;
    const textBeforeCursor = lineText.slice(0, ctx.pos - line.from);
    if (!textBeforeCursor.includes(':')) return null;

    // Extraire "clé: valeur_tapée" — supporte / . - dans la valeur (aspect_ratio, etc.)
    const m = textBeforeCursor.match(/^\s*-?\s*([\w_]+):\s*([\w\/.-]*)$/);
    if (!m) return null;
    const key = m[1];
    const typed = m[2].toLowerCase();
    const from = ctx.pos - m[2].length;

    // Clés booléennes
    if (HaCardPlaygroundEditor._BOOL_KEYS.has(key)) {
      const opts = [
        { label: 'true',  type: 'keyword' as const },
        { label: 'false', type: 'keyword' as const },
      ].filter(o => !typed || o.label.startsWith(typed));
      return opts.length ? { from, options: opts, validFor: /[a-z]*/ } : null;
    }

    // Clés enum
    const vals = HaCardPlaygroundEditor._KEY_VALUES[key];
    if (vals?.length) {
      const opts = vals
        .filter(o => !typed || o.label.toLowerCase().includes(typed))
        .map(o => ({ ...o, type: 'keyword' as const }));
      return opts.length ? { from, options: opts, validFor: /[\w\/.-]*/ } : null;
    }

    return null;
  };

  private _haComplete = (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const lineText = line.text;

    // Ne pas interférer avec type: ni avec les clés (ligne sans ":" avant le curseur)
    if (/^\s*-?\s*type:\s*/.test(lineText)) return null;
    const textBeforeCursor = lineText.slice(0, ctx.pos - line.from);
    if (!textBeforeCursor.includes(":")) return null;

    // Laisser _scalarValueComplete gérer les booléens et enums purs
    // Laisser _iconComplete gérer icon: (ne pas mélanger entités et icônes)
    const keyM = textBeforeCursor.match(/^\s*-?\s*([\w_]+):\s*/);
    const keyName = keyM?.[1];
    if (keyName) {
      const isBool = HaCardPlaygroundEditor._BOOL_KEYS.has(keyName);
      const isEnum = !!(HaCardPlaygroundEditor._KEY_VALUES[keyName]?.length);
      const alsoEntity = HaCardPlaygroundEditor._ENTITY_ALSO_KEYS.has(keyName);
      if ((isBool || isEnum) && !alsoEntity) return null;
      if (keyName === 'icon') return null;
    }

    // Capturer ce qui est tapé depuis le dernier ":" jusqu'au curseur
    // /[\w.:-]*$/ → ancré à la fin pour ne prendre que la partie valeur
    const word = ctx.matchBefore(/[\w.:-]*$/);
    if (!word) return null;
    // Extraire seulement la valeur après le dernier ":" (ex: "triggers_update:" → "")
    const colonIdx = word.text.lastIndexOf(':');
    const valueText = colonIdx >= 0 ? word.text.slice(colonIdx + 1) : word.text;
    const typed = valueText.replace(/^\s+/, '').toLowerCase();
    // Le "from" pointe sur le début de la valeur (après ":" et espace éventuel)
    const spaceAfterColon = colonIdx >= 0 && word.text[colonIdx + 1] === ' ' ? 1 : 0;
    const from = colonIdx >= 0 ? word.from + colonIdx + 1 + spaceAfterColon : word.from;

    const states = (this._hass as any)?.states as Record<string, {
      state?: string;
      attributes?: { friendly_name?: string; unit_of_measurement?: string };
    }> | undefined;
    if (!states) return null;
    const options = Object.entries(states)
      .filter(([id]) => id.toLowerCase().includes(typed))
      .slice(0, 80)
      .map(([id, s]) => {
        const unit = s?.attributes?.unit_of_measurement ?? "";
        const stateVal = s?.state ? `${s.state}${unit ? " " + unit : ""}` : "";
        return {
          label: id,
          detail: stateVal || undefined,
          type: "variable",
          boost: id.toLowerCase().startsWith(typed) ? 1 : 0,
        };
      });
    if (!options.length) return null;
    return { from, options };
  };

  private _doSearch(text: string, fromStart = false): void {
    if (!this._cmView || !text) return;
    const doc = this._cmView.state.doc.toString();
    const lower = doc.toLowerCase();
    const needle = text.toLowerCase();
    // fromStart=true : live search depuis le début (changement de terme)
    // fromStart=false : occurrence suivante depuis la fin de la sélection courante
    const start = fromStart ? 0 : this._cmView.state.selection.main.head + 1;
    let idx = lower.indexOf(needle, start);
    if (idx < 0) idx = lower.indexOf(needle, 0); // wraparound
    if (idx < 0) return; // not found
    this._cmView.dispatch({
      selection: { anchor: idx, head: idx + needle.length },
      effects: [
        _searchHighlightEffect.of({ from: idx, to: idx + needle.length }),
        EditorView.scrollIntoView(idx, { y: 'center' }),
      ],
    });
    // NE PAS appeler cmView.focus() — garder le focus sur l'input
    // sinon le prochain Enter irait à CodeMirror et effacerait la sélection
  }

  private _doSearchPrev(text: string): void {
    if (!this._cmView || !text) return;
    const doc = this._cmView.state.doc.toString();
    const lower = doc.toLowerCase();
    const needle = text.toLowerCase();
    const start = this._cmView.state.selection.main.anchor - 1;
    let idx = lower.lastIndexOf(needle, start);
    if (idx < 0) idx = lower.lastIndexOf(needle); // wraparound vers la fin
    if (idx < 0) return;
    this._cmView.dispatch({
      selection: { anchor: idx, head: idx + needle.length },
      effects: [
        _searchHighlightEffect.of({ from: idx, to: idx + needle.length }),
        EditorView.scrollIntoView(idx, { y: 'center' }),
      ],
    });
  }

  private _closeSearch(): void {
    this._searchOpen = false;
    this._searchSuggestions = [];
    this._searchSugIdx = -1;
    if (this._cmView) {
      this._cmView.dispatch({ effects: _searchHighlightEffect.of(null) });
    }
  }

  private _getSearchSuggestions(prefix: string): string[] {
    if (prefix.length < 2) return [];
    const lower = prefix.toLowerCase();
    const seen = new Set<string>();
    const results: string[] = [];

    // Tente de parser le YAML courant pour extraire les mêmes données que le check
    let config: Record<string, unknown> | null = null;
    try { config = parseYaml(this._yaml, { uniqueKeys: false }) as Record<string, unknown>; } catch { /* noop */ }

    if (config) {
      // 1. Entity IDs référencés dans la carte (même logique que _checkYaml)
      for (const id of this._extractEntityIds(config)) {
        if (id.toLowerCase().startsWith(lower) && !seen.has(id)) {
          seen.add(id); results.push(id);
          if (results.length >= 10) return results;
        }
      }
      // 2. Types de carte référencés (type:, custom:xxx)
      for (const { cardType } of this._extractCardTypes(config)) {
        if (cardType.toLowerCase().startsWith(lower) && !seen.has(cardType)) {
          seen.add(cardType); results.push(cardType);
          if (results.length >= 10) return results;
        }
      }
    }

    // 3. Mots bruts du YAML (fallback — pour les clés, valeurs, templates…)
    if (this._cmView && results.length < 10) {
      const doc = this._cmView.state.doc.toString();
      const re = /[\w\-\.\/]+/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(doc)) !== null) {
        const w = m[0];
        if (w.length > prefix.length && w.toLowerCase().startsWith(lower) && !seen.has(w)) {
          seen.add(w); results.push(w);
          if (results.length >= 10) break;
        }
      }
    }

    return results;
  }

  private _selectSuggestion(word: string): void {
    this._searchLast = word;
    this._searchSuggestions = [];
    this._searchSugIdx = -1;
    this._doSearch(word, true);
  }

  private _initDragDrop(): void {
    const el = this.renderRoot.querySelector(".editor-area") as HTMLElement | null;
    if (!el) return;
    // capture:true → intercepte avant les handlers internes de CodeMirror
    el.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        e.stopPropagation();
        el.style.outline = `2px dashed var(--primary-color, #268bd2)`;
      }
    }, { capture: true });
    el.addEventListener("dragleave", () => { el.style.outline = ""; });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.style.outline = "";

      const file = e.dataTransfer?.files[0];
      if (!file) return;

      // Nom du fichier depuis File (toujours disponible)
      this._droppedFileName = file.name;

      const reader = new FileReader();
      reader.onload = () => {
        // Normalise CRLF → LF (fichiers Windows/Samba)
        const text = (reader.result as string).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (!this._cmView) return;
        this._cmView.dispatch({
          changes: { from: 0, to: this._cmView.state.doc.length, insert: text },
        });
        this._cmView.focus();
      };
      reader.onerror = () => { console.error("FileReader error"); };
      reader.readAsText(file);
    }, { capture: true });
  }

  private _initCodeMirror(): void {
    const el = this.renderRoot.querySelector(".editor-area") as HTMLElement | null;
    if (!el) return;
    this._cmView = new EditorView({
      state: EditorState.create({
        doc: this._yaml,
        extensions: [
          history(), lineNumbers(), drawSelection(),
          highlightActiveLine(), highlightActiveLineGutter(),
          _searchHighlightField,
          EditorView.baseTheme({
            '.cm-search-match': { background: 'rgba(185,28,28,.85)', borderRadius: '2px' },
            '.cm-search-line':  { borderLeft: '4px solid rgb(185,28,28)' },
            '.cm-search-gutter':{ background: 'rgba(185,28,28,.6) !important', color: 'rgb(255,100,100) !important', fontWeight: '700' },
          }),
          yamlJsLang(), indentUnit.of("  "), colorSwatchPlugin,
          this._themeCompartment.of(this._darkMode ? this._darkTheme() : this._lightTheme()),
          this._fontCompartment.of(EditorView.theme({
            "&": { fontSize: `${this._fontSize}px` },
          })),
          EditorView.domEventHandlers({
            keydown: (e) => { e.stopPropagation(); },
            keyup:   (e) => { e.stopPropagation(); },
            keypress:(e) => { e.stopPropagation(); },
          }),
          autocompletion({ activateOnTyping: true, closeOnBlur: false, override: [
  this._typeComplete,
  this._keyComplete,
  this._scalarValueComplete,
  this._actionValueComplete,
  this._serviceComplete,
  this._navPathComplete,
  this._colorComplete,
  this._iconComplete,
  this._attributeComplete,
  this._templateComplete,
  this._cssComplete,
  this._haComplete,
] }),
          keymap.of([
            // Enter sur une ligne "clé:" (bloc YAML sans valeur) → indente de 2 espaces
            // Cas spécial : clés de liste de cartes (cards:, views:) → insère "- type: "
            {
              key: "Enter",
              run(view: EditorView): boolean {
                const { state } = view;
                const sel = state.selection.main;
                if (!sel.empty) return false;
                const line = state.doc.lineAt(sel.from);
                const beforeCursor = line.text.slice(0, sel.from - line.from);
                // Cas 1 : ligne qui se termine exactement par ":" (bloc YAML, sans espace après)
                if (/^\s*-?\s*[\w_-]+:$/.test(beforeCursor)) {
                  const indent = (line.text.match(/^(\s*)/) ?? ['', ''])[1];
                  const key = beforeCursor.match(/^\s*-?\s*([\w_-]+):$/)?.[1] ?? '';
                  // Clés de liste de cartes → pré-remplir "- type: " pour ouvrir le type picker
                  const isCardList = key === 'cards' || key === 'views';
                  const ins = isCardList
                    ? '\n' + indent + '  - type: '
                    : '\n' + indent + '  ';
                  view.dispatch(state.update({
                    changes: { from: sel.from, to: sel.to, insert: ins },
                    selection: { anchor: sel.from + ins.length },
                    userEvent: 'input',
                  }));
                  return true;
                }
                // Cas 2 : item de liste "  - clé: valeur" → continuer le mapping au bon niveau
                // Évite que CM6 crée "  - " (nouvel item) au lieu de "    " (clé suivante)
                const listItemMatch = beforeCursor.match(/^(\s*)-\s+[\w_-]+:\s+\S/);
                if (listItemMatch) {
                  const baseIndent = listItemMatch[1];
                  const ins = '\n' + baseIndent + '  ';
                  view.dispatch(state.update({
                    changes: { from: sel.from, to: sel.to, insert: ins },
                    selection: { anchor: sel.from + ins.length },
                    userEvent: 'input',
                  }));
                  return true;
                }
                return false;
              },
            },
            indentWithTab, ...defaultKeymap, ...historyKeymap, ...completionKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            this._yaml = u.state.doc.toString();
            // Pas d'auto-save en mode fichier — évite de polluer le YAML de session
            if (this._autoSave && !this._droppedFileName) localStorage.setItem("card-playground-yaml", this._yaml);
            this._scheduleRender();
            this._scheduleCheck();
            if (this._detached && !this._previewWin?.closed) this._send(this._yaml);

            // ── Auto-déclenchement contextuel ──────────────────────────────
            let shouldTrigger = false;
            let shouldTriggerIcon = false;
            for (const tr of u.transactions) {
              if (!tr.docChanged) continue;
              tr.changes.iterChanges((_fa, _ta, fb, tb) => {
                const curLine = tr.newDoc.lineAt(tb);
                const inserted = tr.newDoc.sliceString(fb, tb);

                // ── Cascade après Entrée ──────────────────────────────────
                if (!shouldTrigger && inserted.includes("\n") && curLine.number > 1) {
                  const prev = tr.newDoc.line(curLine.number - 1).text;
                  shouldTrigger = (
                    // type: (avec ou sans valeur) → cartes natives + HACS
                    /^\s*-?\s*type:\s*/.test(prev)
                    // blocs action → sous-clés d'action
                    || /^\s*(tap_action|hold_action|double_tap_action|hold_action_repeat):\s*$/.test(prev)
                    // sous-clés d'action remplies → clé suivante
                    || /^\s*(action|service|perform_action|data|service_data|target|navigation_path|url|confirmation|entity):\s*\S/.test(prev)
                    // styles: / state_styles: → éléments (card, icon, grid…)
                    || /^\s*(styles|state_styles|styles_javascript):\s*$/.test(prev)
                    // élément styles → propriétés CSS
                    || /^\s*(card|icon|name|state|label|grid|img_cell|custom_fields|lock|entities_area):\s*$/.test(prev)
                    // item CSS liste → prop suivante
                    || /^\s*-\s+[\w-]+:\s*\S/.test(prev)
                    // toute clé YAML (avec ou sans "- ") → suggérer la clé suivante (catch-all)
                    || /^\s*-?\s*[\w-]+:\s*/.test(prev)
                  );
                }

                // ── mdi: accepté → liste d'icônes ────────────────────────
                if (!shouldTriggerIcon && /mdi:$/.test(curLine.text.slice(0, tb - curLine.from))) {
                  if (/^\s*icon:/.test(curLine.text)) shouldTriggerIcon = true;
                }
              });
            }
            if (shouldTrigger) setTimeout(() => { if (this._cmView) startCompletion(this._cmView); }, 50);
            if (shouldTriggerIcon) setTimeout(() => { if (this._cmView) startCompletion(this._cmView); }, 80);

            // ── Cascade après acceptation d'une clé scalaire ─────────────
            // Quand une clé est acceptée via apply (insert "clé: "), déclencher
            // immédiatement les suggestions de valeur — sans attendre Enter
            const hasAcceptEvent = u.transactions.some(tr => tr.isUserEvent('input.complete.accept'));
            if (hasAcceptEvent && !shouldTrigger) {
              const sel = u.state.selection.main;
              const cl = u.state.doc.lineAt(sel.from);
              const before = cl.text.slice(0, sel.from - cl.from);
              // Cursor après ': ' (colon + espace) = clé scalaire acceptée
              if (/:\s$/.test(before)) {
                setTimeout(() => { if (this._cmView) startCompletion(this._cmView); }, 50);
              }
            }

          }),
          // ── Listener dédié : auto-accept si une seule option ─────────────
          // Doit être HORS du guard docChanged — startCompletion ne change pas le doc
          EditorView.updateListener.of((u) => {
            const prevStatus = completionStatus(u.startState);
            const curStatus  = completionStatus(u.state);
            // On réagit uniquement quand la liste vient de devenir active
            if (curStatus === 'active' && prevStatus !== 'active') {
              const completions = currentCompletions(u.state);
              if (completions.length === 1) {
                setTimeout(() => {
                  if (this._cmView && completionStatus(this._cmView.state) === 'active') {
                    acceptCompletion(this._cmView);
                  }
                }, 50);
              }
            }
          }),
          // ── Listener cursor : YAML → highlight carte (debounce 350ms) ──
          EditorView.updateListener.of((u) => {
            if (!u.selectionSet && !u.docChanged) return;
            if (this._inspectMode) return;
            clearTimeout(this._highlightTimer);
            const snap = u.state;
            this._highlightTimer = setTimeout(() => this._updateCardHighlight(snap), 350);
          }),
        ],
      }),
      parent: el,
    });
  }

  // ── Inspection bidirectionnelle carte ↔ YAML ────────────────────────────

  /**
   * Parcourt récursivement le DOM (shadow piercing) pour collecter tous les custom elements
   * dont le bounding rect contient le point (x, y).
   * `withCfg` = éléments avec ._config ; `noCfg` = éléments sans config (fallback tagName).
   */
  private _collectCardsAtPoint(
    x: number, y: number,
    node: Element | ShadowRoot,
    withCfg: Array<{ el: Element; area: number; cfg: Record<string, unknown> }>,
    noCfg: Array<{ el: Element; area: number }>,
    shadowDepth = 0,  // compte les franchissements de shadow-root uniquement
  ): void {
    if (shadowDepth > 14) return;
    for (const el of Array.from(node.children ?? [])) {
      let rect: DOMRect;
      try { rect = el.getBoundingClientRect(); } catch (_) { continue; }
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.left <= x && x <= rect.right && rect.top <= y && y <= rect.bottom) {
        if (el.tagName.includes('-')) {
          const any = el as any;
          const cfg = any._config ?? any.config ?? any.__config;
          if (cfg && typeof cfg === 'object') {
            withCfg.push({ el, area: rect.width * rect.height, cfg: cfg as Record<string, unknown> });
          } else {
            noCfg.push({ el, area: rect.width * rect.height });
          }
        }
        // Traversal DOM classique : pas d'incrément (les divs/spans ne coûtent rien)
        this._collectCardsAtPoint(x, y, el, withCfg, noCfg, shadowDepth);
        // Franchissement shadow root : incrément du compteur
        if (el.shadowRoot) this._collectCardsAtPoint(x, y, el.shadowRoot, withCfg, noCfg, shadowDepth + 1);
      }
    }
  }

  /** Extrait les textes et attributs significatifs d'une liste d'éléments */
  private _extractMeaningfulTexts(elements: Element[]): string[] {
    const texts: string[] = [];
    for (const el of elements) {
      for (const attr of ['entity-id', 'entity', 'name', 'title', 'aria-label']) {
        const val = el.getAttribute?.(attr)?.trim();
        if (val && val.length >= 2) texts.push(val);
      }
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const t = (child.textContent ?? '').trim();
          if (t.length >= 2 && t.length <= 100) texts.push(t);
        }
      }
    }
    return [...new Set(texts)];
  }

  /**
   * Saute à la ligne `type:` du bloc YAML correspondant au config cliqué.
   *
   * Approche générale :
   * 1. Extraire TOUTES les valeurs string simples du config (clé: valeur)
   * 2. Trier : `name:` sans template > longueur décroissante (plus long = plus unique)
   * 3. Pour chaque pattern `clé: valeur`, chercher dans le YAML et remonter au type: parent
   * 4. Fallback : valeur seule, puis type de carte
   */
  private _jumpToCardConfig(cfg: Record<string, unknown>): boolean {
    if (!this._cmView) return false;
    const doc = this._cmView.state.doc;
    const fullText = doc.toString();
    const cardType = cfg.type ? String(cfg.type) : '';

    // Clés à ignorer (objets complexes ou props structurelles non-identifiantes)
    const SKIP = new Set([
      'styles','card_mod','tap_action','hold_action','double_tap_action',
      'cards','card','conditions','custom_fields','service_data','target',
      'variables','trigger','action_data','state_filter','type',
      // Props structurelles qui ne désignent pas un contenu identifiable
      'mode','layout','direction','columns','column_span','rows','row_span',
      'color','color_type','size','aspect_ratio','show_state','show_name',
      'show_icon','show_label','show_last_changed',
    ]);

    // Valeurs layout/CSS trop génériques pour identifier un bloc YAML de manière fiable
    const VAL_SKIP = new Set([
      'vertical','horizontal','none','auto','left','right','center',
      'top','bottom','flex','block','inline','on','off','true','false',
      'open','close','closed','start','end','wrap','nowrap',
    ]);

    // Construire la liste des patterns (clé: valeur) à chercher dans le YAML
    const patterns: Array<{ key: string; value: string }> = [];
    const addPattern = (key: string, val: unknown) => {
      if (SKIP.has(key)) return;
      if (typeof val !== 'string') return;
      const v = val.trim();
      // Valeur trop courte, trop longue, ou template JS
      if (v.length < 3 || v.length > 120 || v.includes('[[[') ||
          v.startsWith('{') || v.startsWith('[') || v.startsWith('<')) return;
      // Valeur générique layout/CSS — pas un identifiant fiable
      if (VAL_SKIP.has(v.toLowerCase())) return;
      patterns.push({ key, value: v });
    };

    for (const [k, v] of Object.entries(cfg)) addPattern(k, v);

    // Trier : name simple en premier, puis valeur plus longue = plus unique
    patterns.sort((a, b) => {
      const aName = a.key === 'name' && !a.value.includes('[[[');
      const bName = b.key === 'name' && !b.value.includes('[[[');
      if (aName !== bName) return aName ? -1 : 1;
      return b.value.length - a.value.length;
    });

    // Chercher chaque pattern et naviguer vers le bloc YAML correspondant
    const tryJump = (searchValue: string, requireType: boolean): boolean => {
      let searchFrom = 0;
      while (searchFrom < fullText.length) {
        const idx = fullText.indexOf(searchValue, searchFrom);
        if (idx < 0) break;
        const line = doc.lineAt(idx);
        const indent = (line.text.match(/^(\s*)/) ?? ['', ''])[1].length;

        // ── Scan arrière : chercher type: au même niveau ou "- type:" au niveau parent ──
        let ln = line.number - 1;
        let foundBackward = false;
        while (ln >= 1) {
          const prev = doc.line(ln);
          const prevIndent = (prev.text.match(/^(\s*)/) ?? ['', ''])[1].length;
          const trimmed = prev.text.trimStart();
          if (prevIndent < indent) {
            // Cas liste YAML : "- type: ..." au niveau parent (indent < celui des props)
            const afterDash = trimmed.replace(/^-\s*/, '');
            if (afterDash.startsWith('type:')) {
              if (!requireType || !cardType || afterDash.includes(cardType)) {
                this._goTo(prev.from); return true;
              }
            }
            break;
          }
          if (prevIndent === indent && trimmed.startsWith('type:')) {
            if (!requireType || !cardType || trimmed.includes(cardType)) {
              this._goTo(prev.from); return true;
            }
            break;
          }
          ln--;
        }

        // ── Scan avant : entity-row où type: vient APRÈS entity: (ex: slider-entity-row) ──
        if (!foundBackward) {
          let fln = line.number + 1;
          while (fln <= doc.lines && fln <= line.number + 8) {
            const next = doc.line(fln);
            const nextIndent = (next.text.match(/^(\s*)/) ?? ['', ''])[1].length;
            const trimmed = next.text.trimStart();
            if (nextIndent < indent) break;
            if (trimmed.startsWith('type:')) {
              if (!requireType || !cardType || trimmed.includes(cardType)) {
                // Sauter sur la ligne type: (l'en-tête du bloc), pas la valeur trouvée
                this._goTo(next.from); return true;
              }
              break;
            }
            fln++;
          }
        }

        searchFrom = idx + searchValue.length;
      }
      return false;
    };

    // Passe 1 : pattern `clé: valeur` + vérification du type
    for (const { key, value } of patterns) {
      if (tryJump(`${key}: ${value}`, true)) return true;
    }
    // Passe 2 : pattern `clé: valeur` sans vérification du type (type inconnu)
    for (const { key, value } of patterns) {
      if (tryJump(`${key}: ${value}`, false)) return true;
    }
    // Passe 3 : valeur seule (dans tout le YAML)
    for (const { value } of patterns) {
      const idx = fullText.indexOf(value);
      if (idx >= 0) { this._goTo(idx); return true; }
    }
    // Passe 4 : type de carte — seulement si l'occurrence est UNIQUE dans le YAML
    // Si multiple occurrences, on retourne false pour que le fallback positionnel prenne le relai
    if (cardType && !['vertical-stack','horizontal-stack','grid','entities','conditional'].includes(cardType)) {
      const searchStr = `type: ${cardType}`;
      const first = fullText.indexOf(searchStr);
      if (first >= 0) {
        const second = fullText.indexOf(searchStr, first + searchStr.length);
        if (second < 0) { this._goTo(first); return true; }
        // Plusieurs occurrences → fallback positionnel dans l'appelant
      }
    }
    return false;
  }

  /** Déplace le curseur de l'éditeur à une position absolue et centre la vue */
  private _goTo(pos: number): void {
    if (!this._cmView) return;
    this._cmView.dispatch({
      selection: { anchor: pos },
      scrollIntoView: true,
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    });
    this._cmView.focus();
  }

  /**
   * Cherche un texte visible dans le YAML comme valeur de clé connue.
   * Ordre : name/title/label avec et sans guillemets, puis occurrence brute.
   */
  /**
   * Trouve la position YAML de la N-ème entrée dans le bloc `cards:` d'un container.
   * Utilisé quand _jumpToCardConfig échoue (carte 100% templates, aucun identifiant littéral).
   * Requiert que le parent ait un type unique dans le YAML.
   */
  private _findNthCardInParent(parentCfg: Record<string, unknown>, cardIdx: number): number | null {
    if (!this._cmView) return null;
    const doc = this._cmView.state.doc;
    const fullText = doc.toString();

    // Trouver le bloc parent dans le YAML via son type
    const parentType = String(parentCfg.type ?? '');
    if (!parentType) return null;
    const parentTypeStr = `type: ${parentType}`;
    const parentStart = fullText.indexOf(parentTypeStr);
    if (parentStart < 0) return null;
    // N'utiliser que si occurrence unique (sinon on ne sait pas quel bloc)
    if (fullText.indexOf(parentTypeStr, parentStart + parentTypeStr.length) >= 0) return null;

    const parentLine = doc.lineAt(parentStart);
    const parentIndent = (parentLine.text.match(/^(\s*)/) ?? ['', ''])[1].length;

    // Chercher la ligne `cards:` dans le bloc parent
    let ln = parentLine.number + 1;
    let cardsLn = -1;
    while (ln <= doc.lines) {
      const l = doc.line(ln);
      if (l.text.trim() === '') { ln++; continue; }
      const li = (l.text.match(/^(\s*)/) ?? ['', ''])[1].length;
      if (li <= parentIndent) break; // Sorti du bloc parent
      if (l.text.trimStart().startsWith('cards:')) { cardsLn = ln; break; }
      ln++;
    }
    if (cardsLn < 0) return null;

    // Compter les entrées de liste YAML après `cards:`
    ln = cardsLn + 1;
    let entryIndent = -1;
    let entryCount = 0;
    while (ln <= doc.lines) {
      const l = doc.line(ln);
      if (l.text.trim() === '') { ln++; continue; }
      const li = (l.text.match(/^(\s*)/) ?? ['', ''])[1].length;
      const trimmed = l.text.trimStart();
      // Premier tiret de liste fixe le niveau d'indentation
      if (entryIndent < 0 && trimmed.startsWith('- ')) entryIndent = li;
      if (entryIndent >= 0) {
        if (li < entryIndent) break; // Sorti de la liste
        if (li === entryIndent && trimmed.startsWith('- ')) {
          if (entryCount === cardIdx) {
            // Trouvé : renvoyer la position de la ligne type: de cette entrée
            const afterDash = trimmed.slice(2);
            if (afterDash.startsWith('type:')) return l.from;
            // Chercher type: dans les prochaines lignes
            for (let sl = ln + 1; sl <= Math.min(ln + 6, doc.lines); sl++) {
              const sl_l = doc.line(sl);
              if (sl_l.text.trimStart().startsWith('type:')) return sl_l.from;
            }
            return l.from; // Fallback : ligne du tiret
          }
          entryCount++;
        }
      }
      ln++;
    }
    return null;
  }

  private _jumpToYamlMatch(texts: string[]): void {
    if (!this._cmView) return;
    const doc = this._cmView.state.doc.toString();
    const KEYS = ['name','title','label','header','content'];
    for (const text of texts) {
      // Essayer clé: valeur (avec ou sans guillemets)
      for (const key of KEYS) {
        for (const q of ['', '"', "'"]) {
          const idx = doc.indexOf(`${key}: ${q}${text}${q}`);
          if (idx >= 0) { this._goTo(idx); return; }
        }
      }
    }
    // Fallback : occurrence brute — seulement pour les textes "nom propre"
    // (contient espace, tiret, ou >= 7 chars) pour éviter les mots structurels courts
    for (const text of texts) {
      if (text.length < 7 && !text.includes(' ') && !text.includes('-')) continue;
      const idx = doc.indexOf(text);
      if (idx >= 0) { this._goTo(idx); return; }
    }
  }

  /** Cherche un texte dans le DOM de la carte (shadow piercing) et met à jour les overlays */
  private _updateCardHighlight(state: EditorState): void {
    const line = state.doc.lineAt(state.selection.main.head);
    const raw = line.text;
    const colonIdx = raw.indexOf(':');
    let value = (colonIdx >= 0 ? raw.slice(colonIdx + 1) : raw).trim();
    value = value.replace(/^["'`]|["'`]$/g, '').trim();
    // Ignore les valeurs trop courtes, clés seules, ou structures complexes
    if (value.length < 3 || value.startsWith('{') || value.startsWith('[') || value.startsWith('!')) {
      if (this._inspectOverlays.length) this._inspectOverlays = [];
      this._lastHighlightValue = '';
      return;
    }
    // Cache : ne re-traverser le DOM que si la valeur a changé
    if (value === this._lastHighlightValue) return;
    this._lastHighlightValue = value;
    const frame = this.renderRoot.querySelector('.preview-frame') as HTMLElement | null;
    if (!frame || !frame.firstElementChild) { this._inspectOverlays = []; return; }
    const found = this._findTextInDOM(frame.firstElementChild, value);
    const zoom = this._previewZoom / 100;
    const frameRect = frame.getBoundingClientRect();
    this._inspectOverlays = found.slice(0, 6).map(el => {
      const r = el.getBoundingClientRect();
      return {
        left:   (r.left   - frameRect.left) / zoom,
        top:    (r.top    - frameRect.top)  / zoom,
        width:  r.width  / zoom,
        height: r.height / zoom,
      };
    });
  }

  /** Parcourt récursivement DOM + shadow roots pour trouver les éléments contenant le texte (max 6) */
  private _findTextInDOM(root: Element | ShadowRoot, text: string): Element[] {
    const results: Element[] = [];
    const lower = text.toLowerCase();
    const MAX = 6;
    const walk = (node: Node): void => {
      if (results.length >= MAX) return; // early exit
      if (node.nodeType === Node.TEXT_NODE) {
        const content = (node.textContent ?? '').trim();
        const parent = (node as Text).parentElement;
        if (content.toLowerCase().includes(lower) && parent &&
            parent.tagName !== 'STYLE' && parent.tagName !== 'SCRIPT') {
          results.push(parent);
        }
        return;
      }
      if (node instanceof Element && node.shadowRoot) walk(node.shadowRoot);
      for (const child of node.childNodes) {
        if (results.length >= MAX) return;
        walk(child);
      }
    };
    walk(root);
    return [...new Set(results)];
  }

  /** Gestionnaire de clic en mode inspection : carte → YAML */
  private _onInspectClick = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    this._inspectMode = false;
    this._inspectOverlays = [];
    try {
      const frame = this.renderRoot.querySelector('.preview-frame') as HTMLElement | null;
      if (!frame || !frame.firstElementChild) return;
      const root = frame.firstElementChild;

      type C = { el: Element; area: number; cfg: Record<string, unknown> };
      const withCfg: C[] = [];
      const noCfg: Array<{ el: Element; area: number }> = [];

      // ── Traversal BoundingRect ───────────────────────────────────────────────
      // Parcourt récursivement les shadow roots ouverts sous la preview-frame
      this._collectCardsAtPoint(e.clientX, e.clientY, root, withCfg, noCfg);
      if (root.shadowRoot) this._collectCardsAtPoint(e.clientX, e.clientY, root.shadowRoot, withCfg, noCfg);

      // Trier : entité présente > pas hui-* > petite surface (plus spécifique)
      withCfg.sort((a, b) => {
        const aEnt = !!(a.cfg.entity || a.cfg.entity_id);
        const bEnt = !!(b.cfg.entity || b.cfg.entity_id);
        if (aEnt !== bEnt) return aEnt ? -1 : 1;
        const aHui = a.el.tagName.toLowerCase().startsWith('hui-');
        const bHui = b.el.tagName.toLowerCase().startsWith('hui-');
        if (aHui !== bHui) return aHui ? 1 : -1;
        return a.area - b.area;
      });

      // Essayer chaque candidat avec config
      for (const { el, cfg } of withCfg) {
        // Cas spécial : carte entities — utiliser la position Y pour choisir la bonne ligne d'entité
        // (clic sur label ou valeur d'une ligne peut tomber hors des bounds du custom element)
        if (Array.isArray(cfg.entities) && (cfg.entities as unknown[]).length > 0) {
          const rect = el.getBoundingClientRect();
          const rows = cfg.entities as Array<Record<string, unknown>>;
          const rowRatio = rect.height > 0
            ? Math.max(0, Math.min(0.999, (e.clientY - rect.top) / rect.height)) : 0;
          const estIdx = Math.min(rows.length - 1, Math.floor(rowRatio * rows.length));
          for (let d = 0; d < rows.length; d++) {
            const rowCfg = rows[(estIdx + d) % rows.length];
            if (rowCfg && typeof rowCfg === 'object' && this._jumpToCardConfig(rowCfg)) return;
          }
          continue;
        }

        let resolved: Record<string, unknown> = cfg;
        if (!resolved.entity && !resolved.entity_id && cfg.card && typeof cfg.card === 'object') {
          resolved = cfg.card as Record<string, unknown>;
        }
        const detectedType: string = (resolved.type as string | undefined)
          ?? (cfg.type as string | undefined)
          ?? `custom:${el.tagName.toLowerCase()}`;
        const fullCfg: Record<string, unknown> = { type: detectedType, ...resolved };
        if (fullCfg.entity || fullCfg.entity_id || fullCfg.name || fullCfg.type) {
          if (this._jumpToCardConfig(fullCfg)) return;
        }
      }

      // Éléments sans config → chercher par tagName dans le YAML
      noCfg.sort((a, b) => a.area - b.area);
      const fullText = this._cmView?.state.doc.toString() ?? '';
      for (const { el } of noCfg.slice(0, 5)) {
        const t = el.tagName.toLowerCase();
        // Convertir 'custom-foo-bar' → 'custom:foo-bar' pour matcher le YAML
        const customType = t.startsWith('custom-') ? `custom:${t.slice(7)}` : t;
        const idx = fullText.indexOf(`type: ${customType}`);
        if (idx >= 0) { this._goTo(idx); return; }
        const idx2 = fullText.indexOf(`type: custom:${t}`);
        if (idx2 >= 0) { this._goTo(idx2); return; }
      }

      // ── Méthode 3 : extraction de texte via walker BoundingRect (shadow-aware) ──
      // Traverse le même arbre que _collectCardsAtPoint mais collecte le texte des
      // éléments non-custom (div#name.ellipsis etc. de button-card) au point cliqué.
      // Plus fiable que document.elementsFromPoint qui ne perce pas toujours les shadow roots imbriqués.
      {
        const YAML_RE   = /^(type|entity|cards|entities|conditions|tap_action|hold_action|styles|card_mod):/i;
        const NUM_RE    = /^\d+(\.\d+)?(%|px|em|rem|s|ms|°|vh|vw)?$/;
        const TMPL_RE   = /\[\[\[|\{\{/;
        const LAYOUT_WORDS = new Set([
          'vertical','horizontal','stack','card','grid','row','column','col',
          'none','auto','left','right','center','top','bottom','flex','block',
          'inline','on','off','true','false','open','close','closed',
        ]);
        const isGoodText = (t: string) =>
          t.length >= 2 && t.length <= 80 &&
          !YAML_RE.test(t) && !NUM_RE.test(t) && !TMPL_RE.test(t) &&
          !t.startsWith('{') && !t.startsWith('[') && !t.startsWith('<') &&
          !LAYOUT_WORDS.has(t.toLowerCase());

        const previewTexts: string[] = [];

        const walkForText = (node: Element | ShadowRoot, depth: number) => {
          if (depth > 14) return;
          for (const el of Array.from((node as any).children ?? [])) {
            let rect: DOMRect;
            try { rect = (el as Element).getBoundingClientRect(); } catch (_) { continue; }
            if (!rect || (rect.width === 0 && rect.height === 0)) continue;
            if (rect.left > e.clientX || e.clientX > rect.right) continue;
            if (rect.top  > e.clientY || e.clientY > rect.bottom) continue;
            // Texte des nœuds texte directs
            for (const child of (el as Element).childNodes) {
              if (child.nodeType !== Node.TEXT_NODE) continue;
              const t = (child.textContent ?? '').trim().replace(/\s+/g, ' ');
              if (isGoodText(t)) previewTexts.push(t);
            }
            // Attributs sémantiques
            for (const attr of ['aria-label','title','alt']) {
              const v = (el as Element).getAttribute?.(attr)?.trim() ?? '';
              if (isGoodText(v)) previewTexts.push(v);
            }
            walkForText(el as Element, depth + 1);
            if ((el as Element).shadowRoot) walkForText((el as Element).shadowRoot!, depth + 1);
          }
        };

        walkForText(root, 0);
        if (root.shadowRoot) walkForText(root.shadowRoot, 0);

        const uniqTexts = [...new Set(previewTexts)];
        if (uniqTexts.length > 0) { this._jumpToYamlMatch(uniqTexts); return; }
      }

      // ── Fallback positionnel : plusieurs occurrences du même type dans le YAML ─
      // Dernier recours absolu. Stratégie 0 (nouvelle) : si un container parent a cfg.cards,
      // utiliser l'index DOM pour accéder au config exact depuis cfg.cards[idx].
      // Stratégie 1 : index DOM parmi siblings du même type → occ[sibIdx] dans le YAML.
      // Stratégie 2 : ratio Y dans le rect du parent.
      {
        const GENERIC = new Set(['vertical-stack','horizontal-stack','grid','entities','conditional']);
        for (const { el, cfg, area } of withCfg) {
          const rawTag = el.tagName.toLowerCase();
          const ct = (cfg.type as string | undefined)
            ?? (rawTag.startsWith('custom-') ? `custom:${rawTag.slice(7)}` : `custom:${rawTag}`);
          if (!ct || GENERIC.has(ct) || rawTag.startsWith('hui-')) continue;

          // Stratégie 0 : parent container avec cfg.cards
          // a) Égalité par référence : cfg === parentCfg.cards[i] → index exact sans heuristique DOM
          // b) _jumpToCardConfig sur le config ciblé (fonctionne si propriété littérale)
          // Stratégie 0 : parent container avec cfg.cards
          // hui-card strip le `type` avant setConfig → référence cassée → comparaison structurelle
          const parentEntry = withCfg.find(w =>
            w.el !== el && Array.isArray(w.cfg.cards) && w.area > area
          );
          if (parentEntry) {
            const parentCards = parentEntry.cfg.cards as Record<string, unknown>[];

            // a) Comparaison structurelle : tous champs sauf `type` (hui-card strip le type)
            const cfgMatch = (child: Record<string, unknown>, parent: Record<string, unknown>): boolean => {
              const keys = Object.keys(child).filter(k => k !== 'type');
              if (keys.length === 0) return false;
              try { return keys.every(k => JSON.stringify(child[k]) === JSON.stringify(parent[k])); }
              catch { return false; }
            };
            let targetIdx = parentCards.findIndex(c => cfgMatch(cfg, c as Record<string, unknown>));

            // b) Fallback DOM : remonter jusqu'au premier ancêtre avec >1 enfants
            //    (évite les wrapper divs qui ont 1 seul enfant chacun)
            if (targetIdx < 0) {
              let container: Element | null = el.parentElement;
              while (container && container.children.length <= 1) container = container.parentElement;
              if (container) {
                let ancestor: Element | null = el;
                while (ancestor && ancestor.parentElement !== container) ancestor = ancestor.parentElement;
                if (ancestor) {
                  const idx = Array.from(container.children).indexOf(ancestor);
                  if (idx >= 0 && idx < parentCards.length) targetIdx = idx;
                }
              }
            }

            if (targetIdx >= 0) {
              const specificCfg = parentCards[targetIdx];
              if (specificCfg && typeof specificCfg === 'object') {
                // Tenter via le config ciblé (fonctionne si entity/name/icon littéraux)
                if (this._jumpToCardConfig(specificCfg as Record<string, unknown>)) return;
                // Dernier recours : scan YAML bloc parent → N-ème entrée de cards:
                const nthPos = this._findNthCardInParent(parentEntry.cfg, targetIdx);
                if (nthPos !== null) { this._goTo(nthPos); return; }
              }
            }
          }

          // Stratégie 1 : occurrences YAML globales + index DOM parmi siblings du même type
          const ss = `type: ${ct}`;
          const occ: number[] = [];
          let p = 0;
          while (true) { const i = fullText.indexOf(ss, p); if (i < 0) break; occ.push(i); p = i + ss.length; }
          if (occ.length === 0) continue;
          if (occ.length === 1) { this._goTo(occ[0]); return; }

          {
            const domParent = el.parentElement;
            if (domParent) {
              const sameType = Array.from(domParent.children).filter(c => c.tagName === el.tagName);
              const sibIdx = sameType.indexOf(el);
              if (sibIdx >= 0 && sibIdx < occ.length) { this._goTo(occ[sibIdx]); return; }
            }
          }

          // Stratégie 2 : ratio Y dans le rect du parent
          const parentRect = (el.parentElement ?? frame).getBoundingClientRect();
          const yRatio = parentRect.height > 0
            ? Math.max(0, Math.min(0.999, (e.clientY - parentRect.top) / parentRect.height)) : 0;
          const est = Math.min(occ.length - 1, Math.floor(yRatio * occ.length));
          this._goTo(occ[est]); return;
        }
      }
    } catch (_) { /* sécurité — ne jamais bloquer l'UI */ }
  };

  private _scheduleRender(): void {
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this._renderCard(), 400);
  }

  private async _renderCard(): Promise<void> {
    if (!this._helpers || this._detached) return;

    let config: Record<string, unknown>;
    try {
      config = parseYaml(this._yaml, { uniqueKeys: false }) as Record<string, unknown>;
      if (!config || typeof config !== "object") throw new Error("Le YAML doit être un objet");
      if (!config.type) throw new Error('"type" manquant');
    } catch (err) {
      this._parseError = String(err instanceof Error ? err.message : err);
      this._clearFrame();
      return;
    }

    this._parseError = null;
    await this._doRender(config);
  }

  /** Rendu effectif avec un config déjà résolu (peut être appelé plusieurs fois) */
  private async _doRender(config: Record<string, unknown>): Promise<void> {
    const frame = this.renderRoot.querySelector(".preview-frame") as HTMLElement;
    if (!frame) return;

    const cardType = config.type as string;

    // Canvas card : hauteur 100% collapse sans parent fixe → forcer la hauteur immédiatement
    // sur le DOM (pas via @state Lit qui est asynchrone — la carte serait déjà montée avant)
    if (cardType === "custom:ha-canvas-card") {
      const cfgH = config.height as string | undefined;
      const h = cfgH && !cfgH.includes('%') ? cfgH : "700px";
      this._canvasHeight = h;
      frame.style.height = h;
    } else {
      this._canvasHeight = null;
      frame.style.height = "";
    }

    // Mise à jour en place si même type ET styles inchangés → zéro flickering
    // Exception : ha-canvas-card re-construit ses enfants dans _setup() → toujours re-créer
    const stylesKey = JSON.stringify(config.styles ?? null);
    const canForceUpdate = cardType !== "custom:ha-canvas-card";
    if (canForceUpdate && cardType === this._lastCardType && this._cardElement && stylesKey === this._lastStylesKey) {
      try {
        const isCustom = cardType.startsWith("custom:");
        const { type: _t, ...configWithoutType } = config;
        const updateConfig = isCustom ? configWithoutType : config;
        if (typeof (this._cardElement as any).setConfig === "function") {
          (this._cardElement as any).setConfig(updateConfig);
        } else {
          (this._cardElement as any).config = updateConfig;
        }
        (this._cardElement as any).requestUpdate?.();
        this._cardElement.hass = this.hass;
        return;
      } catch { /* recréer */ }
    }

    // Recréation complète (type changé ou styles modifiés)
    this._lastStylesKey = stylesKey;
    this._loading = true;
    frame.innerHTML = "";
    try {
      await this._mountCard(config, frame);
    } finally {
      this._loading = false;
    }
  }

  /**
   * Monte une carte dans frame.
   * Pour les cartes custom: (HACS), crée l'élément directement pour éviter
   * la double-encapsulation de createCardElement qui peut masquer les vraies erreurs.
   */
  private async _mountCard(config: Record<string, unknown>, frame: HTMLElement): Promise<void> {
    const cardType = config.type as string;
    type AnyCard = HTMLElement & { hass?: HomeAssistant; setConfig?: (c: Record<string, unknown>) => void };

    // ── Cartes custom: (HACS — button-card, bubble-card, etc.) ──────────────
    if (cardType.startsWith("custom:")) {
      const tagName = cardType.slice(7); // "custom:button-card" → "button-card"
      const defined = customElements.get(tagName);

      if (!defined) {
        this._showErrorCard(frame,
          new Error(`Élément "${tagName}" introuvable.\nVérifie que la ressource HACS est chargée.`),
          config);
        return;
      }

      try {
        const card = document.createElement(tagName) as AnyCard;
        // Certaines cartes (button-card) n'acceptent pas "type" dans setConfig
        const { type: _t, ...configWithoutType } = config;
        if (typeof card.setConfig === "function") {
          card.setConfig(configWithoutType as Record<string, unknown>);
        }
        card.hass = this.hass;
        frame.appendChild(card);
        this._cardElement = card;
        this._lastCardType = cardType;
        await Promise.resolve();
        return;
      } catch (err) {
        this._showErrorCard(frame, err, config);
        return;
      }
    }

    // ── Cartes natives HA (via createCardElement) ────────────────────────────
    try {
      const card = this._helpers!.createCardElement(config);
      card.hass = this.hass;
      frame.appendChild(card);
      this._cardElement = card;
      this._lastCardType = cardType;
      await Promise.resolve();
    } catch (err) {
      this._showErrorCard(frame, err, config);
    }
  }

  /** Affiche le vrai hui-error-card de HA (même rendu qu'un dashboard) */
  private _showErrorCard(
    frame: HTMLElement,
    err: unknown,
    origConfig: Record<string, unknown>
  ): void {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      const errCard = this._helpers!.createCardElement({
        type: "error",
        error: msg,
        origConfig,
      });
      frame.appendChild(errCard);
    } catch {
      // Dernier recours : message texte simple
      this._parseError = msg;
    }
    this._cardElement = undefined;
    this._lastCardType = "";
    this._lastStylesKey = "";
  }

  private _clearFrame(): void {
    const f = this.renderRoot.querySelector(".preview-frame");
    if (f) f.innerHTML = "";
    this._cardElement = undefined;
    this._lastCardType = "";
    this._lastStylesKey = "";
  }

  // ── Vérification YAML ─────────────────────────────────────────────────────

  // Clés HA connues qui doivent toujours être à la racine (indentation 0)
  private static readonly _HA_ROOT_KEYS = new Set([
    'homeassistant','default_config','frontend','http','recorder','history','logbook',
    'sun','sensor','binary_sensor','switch','light','climate','cover','fan',
    'media_player','camera','alarm_control_panel','automation','script','scene',
    'input_boolean','input_number','input_select','input_text','input_datetime',
    'timer','counter','group','notify','tts','stt','wake_word','conversation',
    'assist_pipeline','person','zone','device_tracker','proximity','calendar',
    'weather','energy','utility_meter','schedule','tag','plant','mqtt',
    'zwave_js','modbus','rfxtrx','knx','zha','ring','nest','hue','sonos',
    'cast','plex','esphome','python_script','shell_command','rest_command',
    'template','panel_custom','panel_iframe','lovelace','cloud','mobile_app',
    'system_health','map','config','hassio','onboarding','updater',
  ]);

  private _checkIndentation(yaml: string): Array<{ type: 'ok' | 'error' | 'warn'; msg: string }> {
    const results: Array<{ type: 'ok' | 'error' | 'warn'; msg: string }> = [];
    const lines = yaml.split('\n');

    // Construit un masque des lignes à ignorer
    const skipLines = new Set<number>();

    // 1. Blocs [[[...]]] (JavaScript button-card / card-mod)
    let inTriple = false;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i];
      if (!inTriple) {
        if (t.includes('[[[')) {
          inTriple = true;
          if (t.includes(']]]')) inTriple = false; // ouverture+fermeture sur la même ligne
        }
      } else {
        skipLines.add(i);
        if (t.includes(']]]')) inTriple = false;
      }
    }

    // 2. Scalaires bloc YAML (| et >) — contenu libre, indentation non significative
    // Une ligne terminant par |, |+, |-, >, >+, >- démarre un scalaire bloc.
    // Toutes les lignes suivantes plus indentées (ou vides) en font partie.
    for (let i = 0; i < lines.length; i++) {
      if (skipLines.has(i)) continue;
      const line = lines[i];
      if (!/[|>][+\-]?\s*$/.test(line)) continue;
      const blockIndent = line.match(/^( *)/)?.[1].length ?? 0;
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (!next.trim()) { skipLines.add(j); j++; continue; } // ligne vide : fait partie du scalaire
        const nextIndent = next.match(/^( *)/)?.[1].length ?? 0;
        if (nextIndent > blockIndent) { skipLines.add(j); j++; }
        else break; // ligne moins ou aussi indentée : scalaire terminé
      }
    }

    // Tabs → toujours interdit en YAML (hors blocs JS)
    const tabLine = lines.findIndex((l, i) => !skipLines.has(i) && /^\t/.test(l));
    if (tabLine >= 0) {
      results.push({ type: 'error', msg: `Tabulation ligne ${tabLine + 1} — YAML n'accepte que des espaces` });
      return results;
    }

    // Détermine la taille de base d'indentation (plus petit indent > 0 trouvé, hors JS)
    const indents = lines
      .filter((l, i) => !skipLines.has(i) && l.trim() && !l.trim().startsWith('#'))
      .map(l => l.match(/^( +)/)?.[1].length ?? 0)
      .filter(n => n > 0);

    if (indents.length === 0) return results;

    const baseIndent = Math.min(...indents);

    // Indentation non-multiple de la base (hors JS)
    const badLines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (skipLines.has(i)) continue;
      const line = lines[i];
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const indent = line.match(/^( +)/)?.[1].length ?? 0;
      if (indent > 0 && indent % baseIndent !== 0) badLines.push(i + 1);
    }

    if (badLines.length > 0) {
      const sample = badLines.slice(0, 3).join(', ');
      const more = badLines.length > 3 ? ` (+${badLines.length - 3})` : '';
      results.push({
        type: 'warn',
        msg: `Indentation irrégulière ligne${badLines.length > 1 ? 's' : ''} ${sample}${more} (base : ${baseIndent} espaces)`,
      });
    } else {
      results.push({ type: 'ok', msg: `Indentation cohérente (${baseIndent} espaces)` });
    }

    // Clés HA racines indentées par erreur (hors JS)
    const shiftedRootKeys: Array<{ key: string; line: number }> = [];
    for (let i = 0; i < lines.length; i++) {
      if (skipLines.has(i)) continue;
      const line = lines[i];
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const indent = line.match(/^( +)/)?.[1].length ?? 0;
      if (indent === 0) continue;
      const keyMatch = line.trim().match(/^([\w_]+)\s*:/);
      if (keyMatch && HaCardPlaygroundEditor._HA_ROOT_KEYS.has(keyMatch[1])) {
        shiftedRootKeys.push({ key: keyMatch[1], line: i + 1 });
      }
    }

    for (const { key, line } of shiftedRootKeys) {
      results.push({ type: 'warn', msg: `"${key}:" ligne ${line} — clé HA racine qui semble mal indentée` });
    }

    // Alignement {{ }} et [[[ ]]] multi-lignes
    // Si les délimiteurs ouvrants/fermants sont sur des lignes séparées, leur indentation doit correspondre
    type DelimPair = { open: string; close: string; label: string };
    const pairs: DelimPair[] = [
      { open: '{{',  close: '}}',  label: 'accolades Jinja2' },
      { open: '[[[', close: ']]]', label: 'crochets JavaScript' },
    ];
    for (const { open, close, label } of pairs) {
      const stack: Array<{ indent: number; line: number }> = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const hasOpen  = line.includes(open);
        const hasClose = line.includes(close);
        if (hasOpen && !hasClose) {
          stack.push({ indent: line.match(/^( *)/)?.[1].length ?? 0, line: i + 1 });
        } else if (hasClose && !hasOpen && stack.length > 0) {
          const entry = stack.pop()!;
          const closeIndent = line.match(/^( *)/)?.[1].length ?? 0;
          if (closeIndent !== entry.indent) {
            results.push({
              type: 'warn',
              msg: `"${open}" ligne ${entry.line} (indent ${entry.indent}) et "${close}" ligne ${i + 1} (indent ${closeIndent}) — ${label} mal alignés`,
            });
          }
        }
      }
    }

    return results;
  }

  private async _checkIncludes(yaml: string): Promise<Array<{ type: 'ok' | 'error' | 'warn'; msg: string }>> {
    const results: Array<{ type: 'ok' | 'error' | 'warn'; msg: string }> = [];

    // Extrait tous les !include* du texte brut
    const includeRe = /!include(?:_dir_(?:merge_named|named|merge_list|list))?\s+(\S+)/g;
    const includes: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = includeRe.exec(yaml)) !== null) includes.push(m[1]);

    // 0. Typos dans le mot "!include" lui-même
    const validTags = /!include(?:_dir_(?:merge_named|named|merge_list|list))?(?=\s)/g;
    const suspectTags = yaml.match(/![a-zA-Z_]+/g) ?? [];
    for (const tag of suspectTags) {
      if (tag.startsWith('!include')) {
        // Vérifie que c'est un tag valide connu
        if (!/^!include(?:_dir_(?:merge_named|named|merge_list|list))?$/.test(tag)) {
          results.push({ type: 'error', msg: `Tag inconnu "${tag}" — faute dans !include ?` });
        }
      }
    }
    // Supprime les doublons du tableau suspectTags (même tag peut apparaître plusieurs fois)
    void validTags;

    if (includes.length === 0) return results;

    // 1. Analyse statique — toujours exécutée (vérifie le texte dans l'éditeur)
    for (const inc of includes) {
      const hasValidExt = /\.(yaml|yml)$/.test(inc) || !inc.includes('.');
      const hasInvalidChars = /[<>:"|?*]/.test(inc);
      const hasSpace = /\s/.test(inc);
      if (hasInvalidChars) {
        results.push({ type: 'error', msg: `!include "${inc}" — caractères invalides` });
      } else if (hasSpace) {
        results.push({ type: 'error', msg: `!include "${inc}" — espace dans le nom de fichier` });
      } else if (!hasValidExt) {
        results.push({ type: 'error', msg: `!include "${inc}" — extension incorrecte (attendu .yaml ou .yml)` });
      } else {
        results.push({ type: 'ok', msg: `!include "${inc}"` });
      }
    }

    // 1b. Cohérence clé ↔ nom de fichier
    // ex: "sensor: !include automations.yaml" → suspect
    const keyIncludeRe = /^\s*([\w_]+)\s*:\s*!include(?:_dir_\w+)?\s+(\S+)/gm;
    let km: RegExpExecArray | null;
    while ((km = keyIncludeRe.exec(yaml)) !== null) {
      const key = km[1].toLowerCase();
      // Découpe tous les segments du chemin (ex: packages/carte_multiroom/_package.yaml → ['packages','carte_multiroom','_package'])
      const pathParts = km[2].replace(/\.(yaml|yml)$/, '').replace(/\/$/, '').toLowerCase().split(/[/\\]/);
      // OK si N'IMPORTE QUEL segment commence par la clé ou vice-versa
      // ex: sensor → sensors ✓, carte_multiroom → carte_multiroom/ ✓, automation → automations ✓
      const match = pathParts.some(part => part.startsWith(key) || key.startsWith(part));
      if (!match) {
        results.push({ type: 'warn', msg: `"${km[1]}:" inclut "${km[2]}" — nom de fichier inhabituel pour cette clé` });
      }
    }

    // 2. API HA check_config — vérifie les fichiers sur disque (bonus)
    try {
      const token = (this._hass as any)?.auth?.data?.access_token
        ?? (document.querySelector("home-assistant") as any)?.hass?.auth?.data?.access_token;
      if (token) {
        const resp = await fetch("/api/config/core/check_config", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        });
        if (resp.ok) {
          const data = await resp.json() as { result: string; errors: string | null };
          if (data.result === "valid") {
            results.push({ type: 'ok', msg: `Config HA sur disque valide` });
          } else if (data.errors) {
            data.errors.split('\n').filter(Boolean).forEach(err => {
              results.push({ type: 'error', msg: `HA check: ${err.trim()}` });
            });
          }
        }
      }
    } catch { /* API inaccessible */ }

    return results;
  }

  private _scheduleCheck(): void {
    clearTimeout(this._checkTimer);
    this._checkTimer = setTimeout(() => this._runCheck(), 800);
  }

  private _checkYaml(): void {
    // Clic bouton : lance le check immédiatement et bascule le panel
    this._runCheck();
    this._checkOpen = !this._checkOpen;
  }

  private _runCheck(): void {
    // Lance la vérification includes async en parallèle (si fichier config HA)
    if (!this._yaml.trim().startsWith('type:')) {
      this._checkIncludes(this._yaml).then(includeResults => {
        // Fusionne avec les résultats existants (remplace les anciens includes)
        if (this._checkResult) {
          const withoutIncludes = this._checkResult.filter(r => !r.msg.startsWith('!include'));
          this._checkResult = [...withoutIncludes, ...includeResults];
        }
      });
    }
    const results: Array<{ type: 'ok' | 'error' | 'warn'; msg: string }> = [];

    // 1. Syntaxe YAML
    let config: Record<string, unknown>;
    try {
      config = parseYaml(this._yaml, { uniqueKeys: false }) as Record<string, unknown>;
      if (!config || typeof config !== "object") throw new Error("Le YAML doit être un objet");
      results.push({ type: 'ok', msg: 'Syntaxe YAML valide' });
    } catch (e) {
      results.push({ type: 'error', msg: `Syntaxe YAML : ${e instanceof Error ? e.message : e}` });
      this._checkResult = results;
      return;
    }

    // 1b. Cohérence d'indentation
    const indentIssues = this._checkIndentation(this._yaml);
    for (const issue of indentIssues) results.push(issue);

    // 2. Détection du mode : carte Lovelace vs fichier config HA général
    const isCardYaml = typeof config.type === 'string';
    if (!isCardYaml) {
      results.push({ type: 'ok', msg: 'Fichier config HA — vérification syntaxe seulement' });
    } else {
      // Vérifie tous les type: (racine + cartes imbriquées) — dédupliqué avec comptage
      const allTypes = this._extractCardTypes(config);
      const natives = HaCardPlaygroundEditor._NATIVE_CARD_TYPES;
      const customs = (window as any).customCards as Array<{ type: string }> | undefined;
      const typeCounts = new Map<string, { count: number; path: string }>();
      for (const { cardType, path } of allTypes) {
        if (!typeCounts.has(cardType)) typeCounts.set(cardType, { count: 0, path });
        typeCounts.get(cardType)!.count++;
      }
      for (const [cardType, { count, path }] of typeCounts) {
        const times = count > 1 ? ` ×${count}` : '';
        const label = path ? `"${cardType}" (${path})${times}` : `"${cardType}"${times}`;
        if (natives.includes(cardType)) {
          results.push({ type: 'ok', msg: `Type ${label} — carte native HA` });
        } else if (cardType.startsWith("custom:") && customs?.some(c => `custom:${c.type}` === cardType)) {
          results.push({ type: 'ok', msg: `Type ${label} — carte HACS détectée` });
        } else if (cardType.startsWith("custom:") && customElements.get(cardType.slice(7))) {
          results.push({ type: 'ok', msg: `Type ${label} — carte HACS détectée` });
        } else if (cardType.startsWith("custom:")) {
          results.push({ type: 'warn', msg: `Type ${label} — non trouvé dans les cartes HACS chargées` });
        } else {
          results.push({ type: 'error', msg: `Type ${label} — inconnu (faute de frappe ?)` });
        }
      }
    }

    // 3. Entités + 4. Services — uniquement pour les cartes Lovelace
    if (isCardYaml) {
      const states = (this._hass as any)?.states as Record<string, unknown> | undefined;
      if (states) {
        const entityIds = this._extractEntityIds(config);
        if (entityIds.length === 0) {
          results.push({ type: 'ok', msg: 'Aucune entité référencée' });
        }
        const entityCounts = new Map<string, number>();
        for (const id of entityIds) entityCounts.set(id, (entityCounts.get(id) ?? 0) + 1);
        for (const [id, count] of entityCounts) {
          const times = count > 1 ? ` ×${count}` : '';
          if (states[id]) {
            results.push({ type: 'ok', msg: `Entité "${id}"${times} trouvée` });
          } else {
            results.push({ type: 'error', msg: `Entité "${id}"${times} introuvable dans HA` });
          }
        }
      }

      const services = (this._hass as any)?.services as Record<string, Record<string, unknown>> | undefined;
      if (services) {
        const serviceIds = this._extractServices(config);
        const svcCounts = new Map<string, number>();
        for (const svc of serviceIds) svcCounts.set(svc, (svcCounts.get(svc) ?? 0) + 1);
        for (const [svc, count] of svcCounts) {
          const times = count > 1 ? ` ×${count}` : '';
          const [domain, name] = svc.split('.');
          if (services[domain]?.[name]) {
            results.push({ type: 'ok', msg: `Service "${svc}"${times} trouvé` });
          } else {
            results.push({ type: 'warn', msg: `Service "${svc}"${times} introuvable` });
          }
        }
      }
    }

    this._checkResult = results;
  }

  private _extractEntityIds(obj: unknown, ids: string[] = []): string[] {
    if (!obj || typeof obj !== 'object') return ids;
    if (Array.isArray(obj)) {
      for (const item of obj) this._extractEntityIds(item, ids);
      return ids;
    }
    const record = obj as Record<string, unknown>;
    for (const [key, val] of Object.entries(record)) {
      if ((key === 'entity' || key === 'entity_id') && typeof val === 'string' && val.includes('.')
          && !val.includes('[[[') && !val.includes('{{') && !val.includes(' ')) {
        ids.push(val);
      } else if (key === 'entities' && Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === 'string' && item.includes('.') && !item.includes('[[[') && !item.includes('{{') && !item.includes(' ')) ids.push(item);
          else if (typeof item === 'object') this._extractEntityIds(item, ids);
        }
      } else if (typeof val === 'object') {
        this._extractEntityIds(val, ids);
      }
    }
    return ids;
  }

  private _extractCardTypes(
    obj: unknown,
    results: Array<{ cardType: string; path: string }> = [],
    path = ""
  ): Array<{ cardType: string; path: string }> {
    if (!obj || typeof obj !== 'object') return results;
    if (Array.isArray(obj)) {
      obj.forEach((item, i) => this._extractCardTypes(item, results, `${path}[${i}]`));
      return results;
    }
    const record = obj as Record<string, unknown>;
    if (typeof record.type === 'string') {
      results.push({ cardType: record.type, path });
    }
    // Clés pouvant contenir des sous-cartes
    for (const key of ['cards', 'card', 'badges'] as const) {
      if (record[key]) {
        const label = path ? `${path} → ${key}` : key;
        this._extractCardTypes(record[key], results, label);
      }
    }
    return results;
  }

  private _extractServices(obj: unknown, svcs: string[] = []): string[] {
    if (!obj || typeof obj !== 'object') return svcs;
    if (Array.isArray(obj)) {
      for (const item of obj) this._extractServices(item, svcs);
      return svcs;
    }
    const record = obj as Record<string, unknown>;
    for (const [key, val] of Object.entries(record)) {
      if ((key === 'service' || key === 'perform_action') && typeof val === 'string' && val.includes('.')) {
        svcs.push(val);
      } else if (typeof val === 'object') {
        this._extractServices(val, svcs);
      }
    }
    return svcs;
  }

  private _saveToFile(): void {
    const filename = this._droppedFileName ?? "card.yaml";
    const blob = new Blob([this._yaml], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    this._fileSaved = true;
    setTimeout(() => { this._fileSaved = false; }, 1500);
  }

  private _toggleDetach(): void {
    if (this._detached) {
      this._reattach();
      return;
    }
    // Ouvre le MÊME panneau HA avec le hash #preview
    // → HA se charge complètement → loadCardHelpers() disponible
    const url = window.location.href.split("#")[0] + "#preview";
    const win = window.open(url, "card-playground-preview",
      "width=540,height=760,menubar=no,toolbar=no,location=no,resizable=yes");
    if (!win) { alert("Autorise les popups pour ce site."); return; }

    this._previewWin = win;
    this._detached = true;
    this._clearFrame();

    // Mode auto → éditeur plein écran dès le détachement
    if (this._autoFullOnDetach) this._previewHidden = true;

    // Surveille la fermeture de la fenêtre externe
    this._winWatcher = setInterval(() => {
      if (win.closed) {
        clearInterval(this._winWatcher);
        this._detached = false;
        this._previewWin = null;
        this._previewHidden = false; // restaure le split
        this._scheduleRender();
      }
    }, 500);
  }

  private _reattach(): void {
    if (this._previewWin && !this._previewWin.closed) this._previewWin.close();
    clearInterval(this._winWatcher);
    this._detached = false;
    this._previewWin = null;
    this._previewHidden = false; // restaure le split
    this._scheduleRender();
  }

  render() {
    return html`
      <div class="header">
        <h1>Card Playground <span style="font-size:12px;opacity:.55;font-weight:300">v${__VERSION__} · by VDG7</span></h1>
      </div>
      <div class="unified-toolbar"
        @click=${() => { if (this._settingsOpen) this._settingsOpen = false; if (this._checkOpen) this._checkOpen = false; }}>
        <span class="toolbar-section-label">Éditeur YAML</span>
        <div class="font-ctrl">
              <div class="settings-wrap" style="position:relative">
                <button class="font-btn ${this._searchOpen ? "saved" : ""}"
                  title="Rechercher dans le YAML"
                  @click=${(e: Event) => { e.stopPropagation(); if (this._searchOpen) { this._closeSearch(); } else { this._searchOpen = true; } }}>
                  🔍 Chercher
                </button>
              </div>
              ${this._droppedFileName ? html`
                <span class="file-badge" title="${this._droppedFileName}">📁 ${this._droppedFileName}</span>
                ${(() => {
                  const hasErrors = this._checkResult?.some(r => r.type === 'error') ?? false;
                  return html`<button
                    class="font-btn ${this._fileSaved ? "file-ok" : hasErrors ? "check-error" : ""}"
                    title="${hasErrors ? "Corrige les erreurs avant d\'enregistrer" : "Télécharger le fichier modifié"}"
                    ?disabled=${hasErrors}
                    style="${hasErrors ? "opacity:.5;cursor:not-allowed" : ""}"
                    @click=${hasErrors ? undefined : this._saveToFile}>
                    ${this._fileSaved ? "✓ Téléchargé" : hasErrors ? "✗ Erreurs" : "⬇ Fichier"}
                  </button>`;
                })()}
              ` : ""}
              <button class="font-btn ${this._saved ? "saved" : ""}" title="Sauvegarder un snapshot"
                @click=${this._saveSnapshot}>${this._saved ? "✓ Sauvé" : "💾 Sauver"}</button>
              <button class="font-btn" title="Vider l'éditeur"
                @click=${() => {
                  if (!this._cmView) return;
                  this._cmView.dispatch({ changes: { from: 0, to: this._cmView.state.doc.length, insert: "" } });
                  this._droppedFileHandle = null;
                  this._droppedFileName = null;
                  this._checkResult = null;
                  this._checkOpen = false;
                  this._cmView.focus();
                }}>🗑 Vider</button>
              <button class="font-btn ${this._restored ? "restored" : ""}" title="Restaurer le dernier snapshot"
                @click=${this._restoreSnapshot}>${this._restored ? "✓ Restauré" : "↩ Restaurer"}</button>
              <button class="font-btn ${this._copied ? "copied" : ""}" title="Copier la sélection ou tout le YAML"
                @click=${this._copyYaml}>${this._copied ? "✓ Copié" : "⎘ Copier"}</button>
              <button class="font-btn ${this._pasted === "ok" ? "pasted-ok" : ""}"
                title="Focus éditeur puis Ctrl+V"
                @click=${this._pasteYaml}>${this._pasted === "ok" ? "→ Ctrl+V" : "⎘ Coller"}</button>
              <button class="font-btn ${this._formatted ? "saved" : ""}" title="Formater le YAML (ré-indenter)"
                @click=${this._formatYaml}>${this._formatted ? "✓ Formaté" : "⌥ Format"}</button>
              <div class="settings-wrap" style="position:relative">
                <button class="font-btn ${
                  !this._checkResult ? '' :
                  this._checkResult.some(r => r.type === 'error') ? 'check-error' :
                  this._checkResult.some(r => r.type === 'warn')  ? 'check-warn'  :
                  'check-ok'
                }"
                  title="Vérifier le YAML"
                  @click=${(e: Event) => { e.stopPropagation(); this._checkYaml(); }}>
                  ${!this._checkResult ? '✓ Vérifier' :
                    this._checkResult.some(r => r.type === 'error') ? '✗ Erreurs' :
                    this._checkResult.some(r => r.type === 'warn')  ? '⚠ Warnings' :
                    '✓ OK'}
                </button>
                ${this._checkOpen && this._checkResult ? html`
                  <div class="check-panel" @click=${(e: Event) => e.stopPropagation()}>
                    ${this._checkResult.map((r, i) => html`
                      ${i > 0 ? html`<div class="check-separator"></div>` : ""}
                      <div class="check-item ${r.type}">
                        <span>${r.type === 'ok' ? '✓' : r.type === 'error' ? '✗' : '⚠'}</span>
                        <span>${r.msg}</span>
                      </div>
                    `)}
                  </div>` : ""}
              </div>
              <button class="font-btn" title="Indenter (+2 espaces)"
                @click=${() => { if (this._cmView) indentMore(this._cmView); }}>⇥</button>
              <button class="font-btn" title="Dédenter (−2 espaces)"
                @click=${() => { if (this._cmView) indentLess(this._cmView); }}>⇤</button>
              <div style="position:relative;display:flex;align-items:center;gap:4px">
                <button class="font-btn"
                  @click=${() => { this._fontSize = Math.max(10, this._fontSize - 1); }}>A−</button>
                <span class="font-size-label">${this._fontSize}px</span>
                <button class="font-btn"
                  @click=${() => { this._fontSize = Math.min(28, this._fontSize + 1); }}>A+</button>
                <button class="font-btn" title="Police par défaut"
                  @click=${() => { this._fontSize = 14; }}>↺</button>
                ${this._searchOpen ? html`
                  <div class="search-popup" @click=${(e: Event) => e.stopPropagation()}>
                    <div class="search-popup-row">
                      <input type="text" placeholder="Rechercher…" autofocus
                        .value=${this._searchLast}
                        @input=${(e: Event) => {
                          const val = (e.target as HTMLInputElement).value;
                          this._searchLast = val;
                          this._searchSugIdx = -1;
                          this._searchSuggestions = this._getSearchSuggestions(val);
                          if (val.length >= 2) this._doSearch(val, true);
                        }}
                        @keydown=${(e: KeyboardEvent) => {
                          e.stopPropagation();
                          if (e.key === 'ArrowDown') {
                            e.preventDefault();
                            if (this._searchSuggestions.length > 0)
                              this._searchSugIdx = Math.min(this._searchSugIdx + 1, this._searchSuggestions.length - 1);
                            else this._doSearch(this._searchLast);
                          } else if (e.key === 'ArrowUp') {
                            e.preventDefault();
                            if (this._searchSuggestions.length > 0)
                              this._searchSugIdx = Math.max(this._searchSugIdx - 1, -1);
                            else this._doSearchPrev(this._searchLast);
                          } else if (e.key === 'Enter') {
                            e.preventDefault();
                            if (this._searchSugIdx >= 0) {
                              this._selectSuggestion(this._searchSuggestions[this._searchSugIdx]);
                            } else {
                              this._doSearch(this._searchLast);
                            }
                          } else if (e.key === 'Escape') {
                            this._closeSearch();
                          }
                        }}
                      />
                      <button class="search-nav-btn" title="Occurrence précédente"
                        @click=${() => this._doSearchPrev(this._searchLast)}>↑</button>
                      <button class="search-nav-btn" title="Occurrence suivante"
                        @click=${() => this._doSearch(this._searchLast)}>↓</button>
                      <button class="search-popup-close" title="Fermer"
                        @click=${() => { this._closeSearch(); }}>✕</button>
                    </div>
                    ${this._searchSuggestions.length > 0 ? html`
                      <div class="search-sug-list">
                        ${this._searchSuggestions.map((s, i) => html`
                          <button class="search-sug-item ${i === this._searchSugIdx ? 'active' : ''}"
                            @mousedown=${(e: Event) => { e.preventDefault(); this._selectSuggestion(s); }}>
                            ${s}
                          </button>`)}
                      </div>` : ''}
                  </div>` : ''}
              </div>
        </div>
        <div class="toolbar-sep"></div>
        <span class="toolbar-section-label">Aperçu</span>
        <span style="flex-shrink:0;margin:0 8px 0 4px;font-size:13px;font-weight:700;color:var(--primary-text-color)">${this._desktopWidth}px</span>
        <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
          ${this._showInspectBtn ? html`<button class="zoom-btn ${this._inspectMode ? "active" : ""}"
            title="${this._inspectMode ? "Mode inspection actif — clic sur la carte pour sauter au YAML" : "Inspecter — clic sur carte → YAML · curseur YAML → surbrillance carte"}"
            @mousedown=${(e: Event) => e.preventDefault()}
            @click=${(e: Event) => {
              e.stopPropagation();
              const sel = window.getSelection();
              const selText = sel?.toString().trim() ?? '';
              if (selText.length >= 2) {
                sel!.removeAllRanges();
                this._jumpToYamlMatch([selText]);
                return;
              }
              this._inspectMode = !this._inspectMode;
              if (!this._inspectMode) this._inspectOverlays = [];
            }}>🔍</button>` : ''}
          <button class="zoom-btn" title="Zoom −"
            @click=${() => { this._previewZoom = Math.max(10, this._previewZoom - 2); }}>−</button>
          <input type="range" min="10" max="200" step="2"
            .value=${String(this._previewZoom)}
            style="width:80px;cursor:pointer;accent-color:var(--primary-color)"
            @input=${(e: Event) => { this._previewZoom = Number((e.target as HTMLInputElement).value); }}>
          <span style="font-size:13px;font-weight:700;min-width:38px;text-align:center;color:var(--primary-text-color)">${this._previewZoom}%</span>
          <button class="zoom-btn" title="Zoom +"
            @click=${() => { this._previewZoom = Math.min(200, this._previewZoom + 2); }}>+</button>
          <button class="zoom-btn" title="Réinitialiser zoom"
            @click=${() => { this._previewZoom = 100; }}>↺</button>
          <button class="zoom-btn ${this._previewHidden ? "active" : ""}"
            title="${this._previewHidden ? "Afficher l'aperçu" : "Masquer l'aperçu"}"
            @click=${() => { this._previewHidden = !this._previewHidden; }}>
            ${this._previewHidden ? "▶ Aperçu" : "◀ Plein écran"}
          </button>
          <button class="zoom-btn ${this._detached ? "active" : ""}" @click=${this._toggleDetach}>
            ${this._detached ? "↙ Réintégrer" : "↗ Détacher"}
          </button>
          <div class="settings-wrap" style="position:relative">
            <button class="zoom-btn ${this._settingsOpen ? "active" : ""}"
              title="Paramètres"
              @click=${(e: Event) => { e.stopPropagation(); this._settingsOpen = !this._settingsOpen; }}>⚙</button>
            ${this._settingsOpen ? html`
              <div class="settings-panel" @click=${(e: Event) => e.stopPropagation()}>
                <h3>Paramètres</h3>
                <div class="setting-row setting-row--col">
                  <div class="setting-label">
                    Largeur colonne Desktop
                    <div class="setting-desc">4 col = défaut HA · plus de colonnes = carte plus étroite</div>
                  </div>
                  <div class="col-presets">
                    ${([
                      {l:"1",w:1200},{l:"2",w:600},{l:"3",w:400},{l:"4",w:300},
                      {l:"5",w:240},{l:"6",w:200},{l:"8",w:150},{l:"10",w:120}
                    ] as const).map(p => html`
                      <button class="col-preset ${this._desktopWidth===p.w?"active":""}"
                        title="${p.w}px"
                        @click=${()=>{this._desktopWidth=p.w;}}>${p.l} col</button>`)}
                  </div>
                  <div class="setting-slider-row">
                    <input type="range" min="100" max="1600" step="1"
                      .value=${String(this._desktopWidth)}
                      @input=${(e: Event) => { this._desktopWidth = Number((e.target as HTMLInputElement).value); }}>
                    <input type="number" class="setting-num" min="100" max="1600"
                      .value=${String(this._desktopWidth)}
                      @change=${(e: Event) => {
                        const v = Math.min(1600, Math.max(100, Number((e.target as HTMLInputElement).value)));
                        this._desktopWidth = v;
                      }}>
                  </div>
                </div>
                <div class="setting-row">
                  <div class="setting-label">
                    Thème clair
                    <div class="setting-desc">Éditeur et aperçu en mode clair</div>
                  </div>
                  <button class="toggle ${!this._darkMode ? "on" : ""}"
                    @click=${() => { this._darkMode = !this._darkMode; }}></button>
                </div>
                <div class="setting-row">
                  <div class="setting-label">
                    Sauvegarde automatique
                    <div class="setting-desc">Restaure le YAML à la réouverture<br>Désactiver si YAML cassé au démarrage</div>
                  </div>
                  <button class="toggle ${this._autoSave ? "on" : ""}"
                    @click=${() => { this._autoSave = !this._autoSave; }}></button>
                </div>
                <div class="setting-row">
                  <div class="setting-label">
                    Éditeur plein écran au détachement
                    <div class="setting-desc">Auto : l'éditeur prend toute la largeur<br>dès que l'aperçu est détaché</div>
                  </div>
                  <button class="toggle ${this._autoFullOnDetach ? "on" : ""}"
                    @click=${() => { this._autoFullOnDetach = !this._autoFullOnDetach; }}></button>
                </div>
                <div class="setting-row">
                  <div class="setting-label">
                    Bouton inspection 🔍
                    <div class="setting-desc" style="color:var(--warning-color,#f59e0b);font-weight:500">Bêta — clic carte → YAML</div>
                  </div>
                  <button class="toggle ${this._showInspectBtn ? "on" : ""}"
                    @click=${() => { this._showInspectBtn = !this._showInspectBtn; if (!this._showInspectBtn) { this._inspectMode = false; this._inspectOverlays = []; } }}></button>
                </div>
              </div>` : ""}
          </div>
        </div>
      </div>
      <div class="workspace ${this._previewHidden ? "editor-full" : ""} ${this._darkMode ? "" : "light-mode"}"
        style="--editor-w:${this._splitPct}%;--desktop-w:${this._desktopWidth}px">
        <div class="editor-pane">
          <div class="editor-area ${this._darkMode ? "" : "light"}" style="--code-font-size:${this._fontSize}px"></div>
        </div>
        <div class="split-handle ${this._dragging ? "dragging" : ""}"
          @mousedown=${this._onDividerDown}></div>
        <div class="preview-pane">
          ${this._detached ? html`
            <div class="detached-msg">
              <button class="reattach-btn" @click=${this._reattach}>
                <div style="font-size:36px">↙</div>
                <div style="font-size:14px;font-weight:500">Réintégrer l'aperçu</div>
                <div style="font-size:11px;opacity:.5">Ferme la fenêtre externe</div>
              </button>
            </div>` : html`
            <div class="preview-area" style="${this._inspectMode ? "cursor:crosshair" : ""}">
              ${this._inspectMode ? html`
                <div style="position:absolute;inset:0;z-index:200;cursor:crosshair"
                  @click=${this._onInspectClick}></div>` : ""}
              <div class="preview-col">
                <div class="preview-frame" style="zoom:${this._previewZoom/100};position:relative${this._canvasHeight ? `;height:${this._canvasHeight}` : ''}">
                  ${this._parseError
                    ? html`<div class="preview-error">⚠ ${this._parseError}</div>`
                    : this._loading
                    ? html`<div class="preview-loading">Chargement…</div>`
                    : html``}
                  ${this._inspectOverlays.map(o => html`
                    <div style="position:absolute;left:${o.left}px;top:${o.top}px;
                      width:${o.width}px;height:${o.height}px;
                      outline:2px solid #3b82f6;background:rgba(59,130,246,.15);
                      pointer-events:none;z-index:100;box-sizing:border-box;border-radius:2px"></div>
                  `)}
                </div>
              </div>
            </div>`}
      </div>`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// APERÇU DÉTACHÉ (fenêtre externe — même URL + #preview)
// ═══════════════════════════════════════════════════════════════════════════

@customElement("ha-card-playground-preview")
class HaCardPlaygroundPreview extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;

  private _helpers?: CardHelpers;
  private _channel = new BroadcastChannel(CHANNEL);
  private _cardElement?: HTMLElement & { hass?: HomeAssistant };
  private _lastCardType = "";
  private _lastStylesKey = "";
  private _hassTimer?: ReturnType<typeof setInterval>;
  private _stateUnsub?: () => void;

  @state() private _error: string | null = null;
  @state() private _zoom = 100;
  @state() private _desktopWidth = 300;
  @state() private _canvasHeight: string | null = null;

  static styles = css`
    :host {
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; padding: 24px; box-sizing: border-box;
      background: var(--primary-background-color, #111827);
    }
    .wrap { width: 100%; max-width: 540px; }
    .error {
      padding: 16px; background: #ef4444; color: white;
      border-radius: 8px; font-size: 13px; font-family: monospace;
      white-space: pre-wrap;
    }
    .waiting { color: #6b7280; text-align: center; font-family: sans-serif; font-size: 14px; }
    .zoom-controls {
      position: fixed; bottom: 16px; right: 16px;
      display: flex; align-items: center; gap: 8px;
    }
    .zoom-bar {
      display: flex; align-items: center; gap: 8px;
      background: rgba(0,0,0,.6); backdrop-filter: blur(6px);
      border-radius: 20px; padding: 8px 16px;
    }
    .zoom-bar button {
      background: none; border: none; color: white; cursor: pointer;
      font-size: 20px; font-weight: bold; line-height: 1; padding: 0 4px;
      opacity: .85;
    }
    .zoom-bar button:hover { opacity: 1; }
    .zoom-bar span { color: white; font-size: 13px; min-width: 42px; text-align: center; opacity: .75; }
    .refresh-btn {
      background: rgba(0,0,0,.6); backdrop-filter: blur(6px);
      border: none; border-radius: 50%; width: 38px; height: 38px;
      color: white; cursor: pointer; font-size: 18px;
      display: flex; align-items: center; justify-content: center;
      opacity: .75; transition: opacity .15s, transform .2s;
    }
    .refresh-btn:hover { opacity: 1; transform: rotate(-30deg); }
    .preview-badge {
      text-align: center; font-size: 15px; opacity: .45;
      margin-top: 10px; letter-spacing: .04em; font-family: sans-serif;
    }
  `;

  protected async firstUpdated(): Promise<void> {
    try {
      this._helpers = await window.loadCardHelpers();
    } catch {
      this._error = "loadCardHelpers() indisponible — recharge la page.";
      return;
    }

    // Charge les ressources Lovelace dans la fenêtre preview également
    try {
      const ha = document.querySelector("home-assistant") as any;
      const conn = ha?.hass?.connection;
      if (conn) {
        const resources = await conn.sendMessagePromise({ type: "lovelace/resources" }) as
          Array<{ url: string; type: string }>;
        await Promise.allSettled(
          resources
            .filter(r => r.type === "module")
            .filter(r => !document.head.querySelector(`script[src="${r.url}"]`))
            .map(r => new Promise<void>((resolve) => {
              const s = document.createElement("script");
              s.type = "module";
              s.src = r.url;
              s.onload = () => resolve();
              s.onerror = () => resolve();
              document.head.appendChild(s);
            }))
        );
      }
    } catch { /* silencieux */ }

    // Écoute les mises à jour depuis l'éditeur
    this._channel.onmessage = (e: MessageEvent<Msg>) => {
      if (e.data.type === "yaml-update") this._renderCard(e.data.yaml);
      if (e.data.type === "settings-update") this._desktopWidth = e.data.desktopWidth;
    };

    // Demande le YAML courant
    this._channel.postMessage({ type: "request-yaml" } satisfies Msg);

    // Abonnement state_changed : pousse hass sur la carte dès qu'un état HA change.
    // Zéro polling — réactif comme le dashboard natif HA.
    try {
      const conn = (document.querySelector("home-assistant") as any)?.hass?.connection;
      if (conn) {
        const unsub = await conn.subscribeEvents(() => {
          const freshHass = (document.querySelector("home-assistant") as any)?.hass;
          if (freshHass && this._cardElement) this._cardElement.hass = freshHass;
        }, "state_changed");
        // Stocker le unsub pour nettoyage
        this._stateUnsub = unsub;
      }
    } catch { /* silencieux — fallback timer */ }

    // Fallback si l'abonnement échoue (réseau, droits, etc.)
    if (!this._stateUnsub) {
      this._hassTimer = setInterval(() => {
        const ha = document.querySelector("home-assistant") as (HTMLElement & { hass?: HomeAssistant }) | null;
        if (ha?.hass && this._cardElement) this._cardElement.hass = ha.hass;
      }, 500);
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._channel.close();
    clearInterval(this._hassTimer);
    try { this._stateUnsub?.(); } catch {}
  }

  private _getHass(): HomeAssistant | undefined {
    const ha = document.querySelector("home-assistant") as (HTMLElement & { hass?: HomeAssistant }) | null;
    return ha?.hass ?? this.hass;
  }

  private async _renderCard(yamlStr: string): Promise<void> {
    if (!this._helpers) return;

    let config: Record<string, unknown>;
    try {
      config = parseYaml(yamlStr, { uniqueKeys: false }) as Record<string, unknown>;
      if (!config || typeof config !== "object") throw new Error("Le YAML doit être un objet");
      if (!config.type) throw new Error('"type" manquant');
    } catch (err) {
      this._error = String(err instanceof Error ? err.message : err);
      return;
    }

    this._error = null;
    await this._doRender(config);
  }

  private async _doRender(config: Record<string, unknown>): Promise<void> {
    const wrap = this.renderRoot.querySelector(".wrap") as HTMLElement;
    if (!wrap) return;

    const cardType = config.type as string;

    // Canvas card : forcer la hauteur immédiatement sur le DOM (pas via @state Lit — asynchrone)
    if (cardType === "custom:ha-canvas-card") {
      const cfgH = config.height as string | undefined;
      const h = cfgH && !cfgH.includes('%') ? cfgH : "700px";
      this._canvasHeight = h;
      wrap.style.height = h;
    } else {
      this._canvasHeight = null;
      wrap.style.height = "";
    }

    // Mise à jour en place si même type ET styles inchangés → zéro flickering
    // Exception : ha-canvas-card re-construit ses enfants dans _setup() → toujours re-créer
    const stylesKey = JSON.stringify(config.styles ?? null);
    const canForceUpdate = cardType !== "custom:ha-canvas-card";
    if (canForceUpdate && cardType === this._lastCardType && this._cardElement && stylesKey === this._lastStylesKey) {
      try {
        const isCustom = cardType.startsWith("custom:");
        const { type: _t, ...configWithoutType } = config;
        const updateConfig = isCustom ? configWithoutType : config;
        if (typeof (this._cardElement as any).setConfig === "function") {
          (this._cardElement as any).setConfig(updateConfig);
        } else {
          (this._cardElement as any).config = updateConfig;
        }
        (this._cardElement as any).requestUpdate?.();
        this._cardElement.hass = this._getHass();
        return;
      } catch { /* recréer */ }
    }

    // Recréation complète (type changé ou styles modifiés)
    this._lastStylesKey = stylesKey;
    wrap.innerHTML = "";

    type AnyCard = HTMLElement & { hass?: HomeAssistant; setConfig?: (c: Record<string, unknown>) => void };

    if (cardType.startsWith("custom:")) {
      const tagName = cardType.slice(7);
      const defined = customElements.get(tagName);
      if (!defined) {
        this._mountErrorCard(wrap, new Error(`Élément "${tagName}" introuvable.`), config);
        return;
      }
      try {
        const card = document.createElement(tagName) as AnyCard;
        const { type: _t, ...configWithoutType } = config;
        if (typeof card.setConfig === "function") {
          card.setConfig(configWithoutType as Record<string, unknown>);
        }
        card.hass = this._getHass();
        wrap.appendChild(card);
        this._cardElement = card;
        this._lastCardType = cardType;
        return;
      } catch (err) {
        this._mountErrorCard(wrap, err, config);
        return;
      }
    }

    try {
      const card = this._helpers!.createCardElement(config);
      card.hass = this._getHass();
      wrap.appendChild(card);
      this._cardElement = card;
      this._lastCardType = cardType;
    } catch (err) {
      this._mountErrorCard(wrap, err, config);
    }
  }

  private _mountErrorCard(
    container: HTMLElement,
    err: unknown,
    origConfig: Record<string, unknown>
  ): void {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      const errCard = this._helpers!.createCardElement({
        type: "error",
        error: msg,
        origConfig,
      });
      container.appendChild(errCard);
    } catch {
      this._error = msg;
    }
    this._cardElement = undefined;
    this._lastCardType = "";
  }

  render() {
    return html`
      <div class="wrap" style="zoom:${this._zoom / 100};max-width:${this._desktopWidth}px${this._canvasHeight ? `;height:${this._canvasHeight}` : ''}">
        ${this._error
          ? html`<div class="error">⚠ ${this._error}</div>`
          : html`<div class="waiting">En attente du YAML…</div>`}
      </div>
      ${this._zoom !== 100 ? html`<div class="preview-badge">Aperçu · taille non contractuelle</div>` : ""}
      <div class="zoom-controls">
        <button class="refresh-btn" title="Vue normale"
          @click=${() => { this._zoom = 100; }}>↺</button>
        <div class="zoom-bar">
          <button @click=${() => { this._zoom = Math.max(10, this._zoom - 2); }}>−</button>
          <input type="range" min="10" max="200" step="2"
            .value=${String(this._zoom)}
            style="width:90px;cursor:pointer;accent-color:white"
            @input=${(e: Event) => { this._zoom = Number((e.target as HTMLInputElement).value); }}>
          <span>${this._zoom}%</span>
          <button @click=${() => { this._zoom = Math.min(200, this._zoom + 2); }}>+</button>
        </div>
      </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-card-playground": HaCardPlayground;
    "ha-card-playground-editor": HaCardPlaygroundEditor;
    "ha-card-playground-preview": HaCardPlaygroundPreview;
  }
}
