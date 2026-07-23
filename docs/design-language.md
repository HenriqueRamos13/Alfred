# Design language

The visual language of Alfred's control centre — a **sci-fi HUD**: dark glass
panels, thin neon borders with a soft glow, L-shaped corner brackets, uppercase
mono labels, live status dots. Ported from the Claude Design canvas
(`ui/ALFRED-Control-Center.dc.html`); the tokens live in
[`src/renderer/theme.css`](../src/renderer/theme.css).

**Any UI Alfred generates follows this** — both surfaces:
- **`render_ui`** — generative components on the surface; they already inherit
  `theme.css`, so the tokens and shell fonts apply.
- **tier-2 `schedule` widgets** — custom HTML in a sandboxed iframe. They do
  **not** inherit `theme.css`, so the base tokens are injected into every widget
  by `wrapWidgetHtml` / `wrapWidgetHtmlJs` (`WIDGET_THEME_CSS` in
  [`src/main/core/widget-html-pure.ts`](../src/main/core/widget-html-pure.ts)).
  The **colour tokens travel; the exact fonts do not** — use `var(--acc)` etc.
  for colour and a monospace for data (falls back to the shell's Share Tech Mono
  where present).

## Palette (CSS vars)

| Token | Value | Role |
|-------|-------|------|
| `--acc` | `#59e8ff` | **ciano — PRIMARY** (accents, borders, headings) |
| `--amb` | `#ffb45e` | âmbar — accent / warning |
| `--mag` | `#c77bff` | magenta — secondary |
| `--grn` | `#4dffa6` | verde — ok / active |
| `--red` | `#ff5f6e` | vermelho — danger / destructive |
| `--dim` | `#5b7a8a` | muted labels/meta |
| `--text` | `#cfe8f2` | body text |
| `--card` | `rgba(7,13,22,.88)` | dark-glass panel surface |
| `--bg` | `#04070d` | app background (dark) |

Use the **vars**, never hard-coded hexes — that is what keeps generated UI in
step with the rest of the centre (and lets the palette shift in one place).

## Typography

- **Rajdhani** — headers and labels, **UPPERCASE** with wide letter-spacing
  (`letter-spacing: .14em–.18em`, `text-transform: uppercase`).
- **Share Tech Mono** — data, numbers, metrics, IDs.

The fonts are vendored into the app shell only. In a tier-2 widget the exact
faces are not available, so use `font-family: "Share Tech Mono", ui-monospace,
monospace` for data — the tokens give you the colour either way.

## Chrome conventions

- **Dark glass panels** — `background: var(--card)`, a subtle `backdrop-filter:
  blur(7px)`.
- **Neon border + glow** — `border: 1px solid color-mix(in oklab, var(--acc)
  28%, transparent)` with a soft `box-shadow` glow in the accent.
- **L-shaped corner brackets** — short 2px accent borders in the four corners of
  a card (decorative, `pointer-events: none`).
- **Mono uppercase labels** — small, wide-tracked, `--dim` or `--acc`.
- **Live dot** — a small `--grn` dot with a glow marks an active/live element
  (green = active is the convention).
- Spare, instrument-like. Motion is subtle and honours
  `prefers-reduced-motion`.

## Example — a tier-2 widget in the right style

Declarative (no JS): the injected tokens colour it, `data-alfred` bindings fill
the live values on every refresh.

```html
<div style="
  padding:12px 14px;
  background:var(--card);
  border:1px solid color-mix(in oklab, var(--acc) 28%, transparent);
  box-shadow:0 0 22px color-mix(in oklab, var(--acc) 12%, transparent);
  color:var(--text);
">
  <div style="
    font-family:'Share Tech Mono',ui-monospace,monospace;
    font-size:10px; letter-spacing:.16em; text-transform:uppercase;
    color:var(--dim);
  ">Lisboa · °C</div>

  <div style="
    font-family:'Share Tech Mono',ui-monospace,monospace;
    font-size:40px; line-height:1; color:var(--acc);
    text-shadow:0 0 12px color-mix(in oklab, var(--acc) 45%, transparent);
  " data-alfred="current.temperature_2m"></div>

  <!-- last 24h as a live neon sparkline -->
  <div data-alfred-sparkline="hourly.temperature_2m" style="margin-top:8px"></div>
</div>
```

Do **not** bake a fixed value into the markup — use a `data-alfred*` binding.
No `<script>`, no `<script src>`, no external libraries, no network (the widget
CSP forbids all of it). See [tools/schedule.md](tools/schedule.md) for the full
tier-2 contract and the security model.
