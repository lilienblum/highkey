---

name: "Piko"
description: "Kanagawa Wave in ordered dither: sumi-ink analytics with warm text, glossy orange pills, Geist Pixel measurements, and 2px Bayer screen tones."
colors:
  background: "#1f1f28"
  foreground: "#dcd7ba"
  heading: "#dcd7ba"
  card: "#2a2a37"
  card-foreground: "#dcd7ba"
  popover: "#363646"
  popover-foreground: "#dcd7ba"
  primary: "#ffa066"
  primary-foreground: "#16161d"
  primary-hover: "#ffb585"
  primary-active: "#ed925c"
  secondary: "#363646"
  secondary-foreground: "#dcd7ba"
  muted: "#363646"
  muted-foreground: "#c8c093"
  accent: "#49443c"
  accent-foreground: "#dcd7ba"
  selection: "#49443c"
  selection-foreground: "#e6c384"
  destructive: "#ff5d62"
  destructive-foreground: "#16161d"
  border: "#41414f"
  input: "#7a7888"
  ring: "#e6c384"
  surface-inset: "#1a1a22"
  surface-hover: "#363646"
  surface-pressed: "#41414f"
  success: "#98bb6c"
  subtle: "#1a1a22"
  data: "#e6c384"
  data-secondary: "#957fb8"
  data-tertiary: "#7aa89f"
  sidebar: "#16161d"
  sidebar-foreground: "#dcd7ba"
  sidebar-primary: "#ffa066"
  sidebar-primary-foreground: "#16161d"
  sidebar-accent: "#2a2a37"
  sidebar-accent-foreground: "#dcd7ba"
  sidebar-border: "#41414f"
  sidebar-ring: "#e6c384"
typography:
  display:
    fontFamily: "Geist Pixel Variable, Geist Variable, sans-serif"
    fontSize: "32px"
    fontWeight: 400
    lineHeight: 1.15
    letterSpacing: "0"
  headline:
    fontFamily: "Geist Pixel Variable, Geist Variable, sans-serif"
    fontSize: "28px"
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: "0"
  title:
    fontFamily: "Geist Mono Variable, ui-monospace, monospace"
    fontSize: "15px"
    fontWeight: 650
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Geist Mono Variable, ui-monospace, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  control:
    fontFamily: "Geist Mono Variable, ui-monospace, monospace"
    fontSize: "14px"
    fontWeight: 550
    lineHeight: 1.5
    letterSpacing: "normal"
  supporting:
    fontFamily: "Geist Mono Variable, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Geist Mono Variable, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  full: "999px"
spacing:
  2: "8px"
  3: "12px"
  4: "16px"
  5: "20px"
  6: "24px"
  8: "32px"
components:
  button-primary:
    backgroundColor: "linear-gradient(180deg, color-mix(in oklab, var(--primary-hover) 72%, #fff), var(--primary) 46%, color-mix(in oklab, var(--primary-active) 88%, #000))"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.full}"
    padding: "8px 16px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "linear-gradient(180deg, color-mix(in oklab, var(--primary-hover) 60%, #fff), var(--primary-hover) 50%, var(--primary))"
  button-primary-active:
    backgroundColor: "linear-gradient(180deg, var(--primary-active), var(--primary))"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.destructive-foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.full}"
    padding: "8px 16px"
    height: "36px"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.full}"
    padding: "8px 16px"
    height: "36px"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.full}"
    padding: "8px 16px"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted-foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.full}"
    padding: "8px 16px"
    height: "36px"
  button-link:
    backgroundColor: "transparent"
    textColor: "{colors.primary}"
    typography: "{typography.control}"
    rounded: "{rounded.full}"
    padding: "8px 16px"
    height: "36px"
  input:
    backgroundColor: "{colors.surface-inset}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
    height: "36px"
  select:
    backgroundColor: "{colors.surface-inset}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
    height: "36px"
  navigation-active:
    backgroundColor: "25% Bayer tone of color-mix(in oklab, var(--primary) 30%, var(--sidebar)) over {colors.sidebar}"
    textColor: "{colors.sidebar-primary}"
    rounded: "{rounded.md}"
    padding: "8px"
    height: "36px"
  badge-outline:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "2px 8px"
  card-contained:
    backgroundColor: "{colors.card}"
    textColor: "{colors.card-foreground}"
    rounded: "{rounded.xl}"
    padding: "20px 24px"
  overview-widget:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.xl}"
    padding: "20px"
  measurement-field:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "0px"
    padding: "20px 0"
  breakdown-row:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    padding: "0 10px"
    height: "36px"
    rounded: "0px"
  segmented-group:
    backgroundColor: "{colors.surface-inset}"
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.full}"
    padding: "3px"
  segmented-selected:
    backgroundColor: "linear-gradient(180deg, color-mix(in oklab, var(--selection) 82%, var(--foreground)), var(--selection) 55%, color-mix(in oklab, var(--selection) 85%, var(--background)))"
    textColor: "{colors.selection-foreground}"
    rounded: "{rounded.full}"
    padding: "0 10px"
    height: "28px"
  tabs-line:
    backgroundColor: "transparent"
    textColor: "{colors.muted-foreground}"
    rounded: "0px"
    height: "36px"
  tabs-line-active:
    backgroundColor: "transparent"
    textColor: "{colors.primary}"
    rounded: "0px"
    height: "36px"
---

# Design System: Piko

## Overview

**Creative North Star: "Kanagawa Wave"**

Piko is a compact measurement tool using the user-selected Kanagawa palette. Sumi-ink surfaces and warm Fuji text frame Surimi Orange actions, Carp Yellow measurements, violet/aqua source categories, and green outcomes. Self-hosted Geist with Geist Pixel measurements, glossy pill controls, inset fields, single-frame segmented choices, ordered-dither screen tones, and the upright three-bar mark give the interface a precise character with a printed, 1-bit texture. Accessible shadcn Base UI primitives and Hugeicons provide the shared component language.

Analytical regions use flat surfaces, fine seams, aligned labels, and tabular values. Overview presents small square metrics, one wide activity chart, and paired reports; Events retains its open analytical field. Editing and inspection use contained surfaces where boundaries clarify the task. Density serves reading: supporting context remains visible, and loading states preserve the geometry of the result they will replace. One palette is present in server-rendered HTML and CSS. There is no appearance selector, theme preference, or system-theme listener.

**Key Characteristics:**

- Sumi-ink surfaces, warm text, orange actions, and yellow/violet/aqua data accents.
- Geist typography: Geist Mono for all interface text, Geist Pixel for page titles and measurements, and Geist only in the wordmark.
- Ordered-dither (Bayer 4×4, 2px pixel) screen tones wherever the interface would otherwise use a translucent tint.
- Flat analytical fields, small square metrics, and rectangular reports; contained forms and inspection.
- Glossy pill actions and segmented choices, inset fields, one focus outline, and stable geometry.

## Colors

The palette is drawn from the [official Kanagawa colors](https://github.com/rebelot/kanagawa.nvim/blob/master/lua/kanagawa/colors.lua), with semantic interaction states derived for the built interface. Frontmatter values are normative. Piko uses one dark Wave palette, with warm primary accents and bounded data colors. All components use semantic CSS variables; foreground aliases resolve to their actual values in the frontmatter.

### Primary

- **Surimi Orange** (`primary`): filled primary actions, active navigation text, active tab underlines, and the shared logo/favicon. Sumi-ink text (`primary-foreground`) keeps filled controls readable. Explicit `primary-hover` and `primary-active` tokens provide brighter hover and deeper pressed states.
- **Carp Yellow** (`data`, `ring`, `selection-foreground`): time-series strokes, the first source category, a visible keyboard outline, and warm selected-choice text.

### Secondary

- **Seasonal categories** (`data-secondary`, `data-tertiary`): Oni Violet and Wave Aqua for additional sources. Exact labels and values remain available independently of color.
- **Winter Yellow field** (`accent`, `selection`): muted warm emphasis, selected choices, and proportional breakdown fills. `accent-foreground` retains warm body text while `selection-foreground` emphasizes the chosen value.
- **Spring Green** (`success`): successful outcomes and healthy-state indicators.
- **Peach Red** (`destructive`): errors and destructive actions, with dark foreground on filled destructive controls.


Log severity reuses these roles with literal labels: info uses aqua, warning uses yellow, error/fatal use destructive red, debug uses violet, and trace remains supporting text. Color never replaces the severity name.


### Syntax

Code snippets, raw JSON, and inspected values use Kanagawa Wave syntax roles: strings springGreen (`#98bb6c`), numbers sakuraPink (`#d27e99`), booleans and null surimiOrange (`#ffa066`), keywords oniViolet (`#957fb8`), functions crystalBlue (`#7e9cd8`), types waveAqua2 (`#7aa89f`), keys, properties, and shell variables carpYellow (`#e6c384`), shell flags and HTML tags springBlue (`#7fb4ca`), and punctuation springViolet2 (`#9cabca`). Comments use supporting text in italics rather than fujiGray, which falls below 4.5:1 on the inset code surface. Highlighting is a small lexical pass (`lib/highlight.tsx`) that renders identical spans on the server and in the browser. Placeholders use their own warm gray (`#8f8b76`, about 5:1 on inset fields) so they never read as entered text.
### Neutral

- **Sumi-ink workspace** (`background`, `sidebar`, `subtle`): layered dark surfaces, with a deeper sidebar.
- **Working surface** (`card`, `card-foreground`): contained widgets and editing regions with warm text.
- **Floating surface** (`popover`, `popover-foreground`): brighter sumi ink for select menus, with its own readable foreground.
- **Quiet controls** (`secondary`, `muted`, `surface-hover`): subordinate actions and neutral hover fields. `surface-pressed` is the stronger pressed neutral; `surface-inset` gives fields and grouped choices a recessed ground.
- **Fuji White** (`foreground`, `heading`): warm primary text and measurements.
- **Old White** (`muted-foreground`): readable supporting text, axes, and metadata.
- **Fine seam** (`border`, `sidebar-border`): passive divisions and container boundaries.
- **Field stroke** (`input`): stronger boundaries on editable controls; hover moves to supporting-text color.

**The Measured Color Rule.** Orange marks actions and destination selection; yellow, violet, and aqua distinguish measurements; green and red label outcomes. Selected choices and keyboard focus use warm yellow within the same palette.

## Typography

**Display Font:** Geist Pixel Variable (single 400 weight, OFL-1.1, self-hosted) for page titles and measurement values, falling back to Geist.
**Interface Font:** Geist Mono Variable (self-hosted, OFL-1.1) for every label, control, heading, prose line, identifier, and snippet. Both `--font-sans` and `--font-mono` resolve to it, with the platform monospace stack as fallback.
**Wordmark Font:** Geist Variable at 800, only in the logo wordmark.

**Character:** an instrument set in two cuts of one family. Geist Mono carries the whole interface, so labels, values, and code share one grid-like rhythm; Geist Pixel sets the titles and numbers people come to read, matching the dithered marks around them. Size and alignment carry hierarchy because the pixel cut has a single weight; oversized display typography does not compete with the data.

### Hierarchy

- **Display:** the frontmatter display role is a metric value in Geist Pixel, not a marketing headline. Its size reduces at narrower widths while tabular numerals preserve alignment.
- **Headline:** page titles in Geist Pixel at its single weight with neutral tracking; the narrow layout uses a small size reduction.
- **Title:** chart, card, and section headings share a steady, moderately bold scale; Overview uses a smaller widget-title treatment recorded in its surface brief.
- **Body:** controls and general interface text.
- **Supporting:** page explanations, with a measured line length of up to (65ch).
- **Label:** field labels, metadata, legends, and table headers. Labels use sentence case; chart ticks and secondary table annotations can use the observed smaller (11px) treatment.

The logo is a distinct wordmark treatment, not an additional heading scale. Mono text is never negatively tracked. Card headings (metric labels and widget titles) sit at 13px and a level 500 weight. Mono glyphs are wider than proportional ones, so short descriptions may wrap in narrow cards; long names truncate with accessible full labels rather than shrinking.

**The Value Alignment Rule.** Use tabular numerals for measurements, percentages, durations, and times that readers compare across rows. Geist Pixel has proportional digits only, so it is reserved for single headline values; anything compared down a column stays in Geist Mono, whose digits are already tabular.

## Layout

The persistent shell places a deeper sumi-ink rail beside a continuous workspace. The expanded rail is (15rem), the collapsed rail (3.5rem), and controls share the report heading’s content grid rather than a separate top bar. Content centers within a maximum width of (1480px), with the observed desktop gutter (32px). Small gaps group labels and actions; the repeated spacing scale in frontmatter governs fields, sections, and container padding.

The logo and project picker share one borderless shadcn SidebarHeader. Behind this identity area, an ordered-dither field (`DitherField`, a low-resolution canvas in an `aria-hidden` frame) draws an orange and a violet bloom over a slow wave and dissolves into the sidebar ground before the project picker. It drifts at 12fps with 2px pixels for six seconds after arrival and while the identity area is hovered, then holds a still frame; it pauses in background tabs, never animates under reduced motion, and never changes layout dimensions. The sidebar owns project selection, destination navigation, and a visible source list. All sources and individual source rows are mutually exclusive scope controls; their active treatment is quieter than active destination navigation: the same 25% screen in neutral ink (22%, 30% on hover) with no frame and no check mark (`aria-pressed` carries the state). Hovering any inactive rail row lays a faint neutral screen (14%), so the rail has one state language. The dotted Sources leader separates the groups; there is no solid rule above it. Source lists scroll independently, long names truncate with accessible full labels, and Documentation anchors the footer. Desktop navigation rows are (36px), collapsed rows (32px), and mobile drawer rows at least (40px). The sidebar supplies project/source context. Its desktop collapse control sits beside the logo in the header; when collapsed, the expand control replaces the logo in that same top row, preserving header height and navigation positions. The mobile drawer retains its explicit close button. One date-period trigger, flanked by Previous on the left and Next on the right when navigation applies, sits left-aligned on a row below the report heading at every width; mobile navigation has a separate row above the heading. Settings omits date controls. Mobile moves source selection into the drawer. Connection status and version/license text are not product chrome.

Overview uses a six-metric strip, one full-width Activity chart, and paired reports. The strip becomes three columns at an available container width of (870px) and two at (550px); metric tiles stay square. Reports become one column at (550px). Breakdown keeps the first report position as source data resolves; the adjacent slot contains Sources when multiple sources contribute, otherwise Identified actors. Success and duration occupy the following pair. Buckets follow the selected reporting period automatically, with UTC labels and partial-boundary notes. Empty ranges retain sections and controls. This user-selected Plausible-style composition with small iOS-style metric squares is an extension of the existing world; detailed hierarchy and geometry belong in the Overview surface brief. Settings uses enclosed editing regions. Events is one implemented expression: a shallow query region, a result count, a two-thirds plot and one-third categorical breakdown, then the event stream. Its desktop plot and compact rows support the first viewport; those dimensions are surface-specific and remain in the surface brief rather than becoming universal chart or table tokens. Logs uses the same project/source shell with its own time window in the query bar instead of the analytics date control. A shallow volume histogram leads into aligned time, severity, service, and message columns. The right-hand inspector is bounded by (620px) or the viewport width. On narrow screens, query controls form two columns, times become compact, and the service column moves into inspection; the message remains the main scanning field. Exact stream geometry and breakpoints belong in the Logs surface brief.

At (1150px) and below, Events's results stack and query controls wrap. At (800px) and below, Settings regions stack. Overview responds to its available container width as described above. Below (768px), navigation becomes a sheet. At (640px) and below, toolbar controls wrap, page gutters become (16px), and buttons, selects, and inputs have a minimum height of (40px). The compact event view retains event/context columns and inline time; inspection exposes full metadata. Loading layouts retain the content's regions instead of replacing the whole page with an unrelated spinner.

## Elevation & Depth

Analytical regions and cards stay nearly flat: a faint top-edge highlight and a sheen that fades within 64px. Filled actions are glossy pills with a lit top edge, a dark outer ring, and a short drop; quiet actions are dark pills with the same lit edge. Fields read as inset through their darker surface. Menus and dialogs use progressively wider soft shadows. Dialog and sheet backdrops are a sparse 25% black dot screen over a translucent sumi dim (plain dim when the user prefers more contrast). Depth communicates temporary overlay hierarchy, while container seams organize persistent content.

### Dither Vocabulary

Ordered dither uses the 4×4 Bayer matrix with 2px pixels on a 4px (CSS) or 8px (SVG) tile. Tones are declared as `--tone-25`, `--tone-50`, and `--tone-75` on the elements that use them, each resolving that element's `--tone-ink`.

- **12.5%:** two diagonal dots per 8px tile; the outer chart fill near the baseline.
- **25%:** a regular dot grid; active destination navigation (brighter ink on hover), the last 4px of a breakdown bar, the middle chart band, a pressed filled action, hovered and focused log rows (darker ink over a lifted face), and the backdrop screen.
- **50%:** a checkerboard; quiet-action hover and open states, the highlighted menu or select row, the 4px before a bar's last step, the chart band under the line, and log volume columns (aqua ink under a solid 2px cap, with error volume solid red from the base).
- **75%:** an inverse dot grid; quiet actions while pressed.
- **Leaders:** a row of 2px dots every 4px runs from sidebar section labels and date-period labels to the edge of their region. Card headings (metric labels and widget titles) lead instead into a braille strip: even six-dot cells (⠿) drawn in the same 2px dots on the 4px pitch with 4px between cells (10px tall), in an ink quieter than the rule ink, solid for its first 120px (or half its width) and then dissolving toward the card edge. It is decorative and hidden from assistive technology.
- **Seams:** structural rules are dotted in the same unit: 2px pixels on a 4px pitch in `--rule-ink` (border 70%, supporting text 30%). That covers the sidebar edge and nested sidebar rails, open analytical regions and their dividers, column headers, line tabs, and popover and sheet section rules. They are drawn with `border-image`, so layout and backgrounds hold. Field and card frames stay solid, and fine row hairlines stay continuous for scanning. Under forced colors seams fall back to plain system borders.
- **Horizon:** the main area's top edge carries a 10px falloff: a dotted rule, then rows at half and quarter density, in the neutral rule ink. It fades in and out symmetrically over the first and last 240px (at most 30% of the width each), so the sidebar's dither field keeps the corner. It is decorative, ignores the pointer, and is hidden under forced colors.

### Shadow Vocabulary

- **Pill** (button drop): a 1px dark ring of the action color, `0 1px 2px rgb(0 0 0 / 40%)`, and a short tinted glow below, plus inset lit and shaded edges. `elevation-control` remains only for elements that borrow button classes without the Button slot, such as calendar navigation.
- **Menu** (`elevation-menu`): `0 8px 24px rgb(0 0 0 / 28%)`, used by select menu surfaces.
- **Dialog** (`elevation-dialog`): `0 20px 60px rgb(0 0 0 / 40%)`, used by modal dialogs and sheets.
- **Flat surfaces:** cards (beyond their inset top highlight), analytical fields, navigation, ghost actions, and metadata have no resting shadow.

**The Shared Ground Rule.** Keep analytical regions flat and aligned. Fine boundaries group related measurements; reserve gloss for actions and soft elevation for temporary overlays.

**The Screen Tone Rule.** Where the interface would use a translucent tint, it uses an ordered-dither tone at the matching density instead. Dither is the only texture: don't combine it with blur or grain. Behind text, a tone is drawn in an ink darker than the face beneath it, so labels keep at least 4.5:1 on every pixel; lighter inks stay at 25% or sparser. The one exception is the modal backdrop, which puts a sparse dot screen over a translucent dim so a full-screen pattern never flickers. Under forced colors, controls gain a system outline and selected segments and the active page use the system highlight.

## Shapes

Buttons, button-like triggers, the date control, compact report selects, and segmented choices are pills (`rounded.full`). Form fields and navigation use softly squared medium corners; small badges use the small corner. Menus use the large corner, while contained cards, dialogs, and Overview widgets use the extra-large corner. The frontmatter radius scale is normative. Open analytical fields, proportional bars, and line-tab underlines remain square. Open analytical fields also drop the card's inset top highlight, so a region's seam is drawn once. Ranked report lists keep their column heading sticky while rows scroll beneath it. Time charts and the log volume histogram zoom by drag (or a single-bucket click): the pending selection is a 25% orange screen between solid 1px orange edges, and releasing applies an ordinary custom range. Small circular status dots remain purposeful status marks. The upright three-bar logo and favicon are the same `/favicon.svg?v=7` asset, with a Surimi Orange tile and dark sumi-ink bars.

Thin borders define forms and seams. A stronger input stroke distinguishes editable fields from passive separators. Select triggers are one continuous field with an inline arrow. Segmented choices have one outer frame, internal spacing, and a selected fill; individual options do not acquire independent frames. Overview metric tiles retain their square aspect ratio and softly rounded corners without a resting shadow; chart and report containers remain rectangular.

## Components

### Buttons

Compact pill actions with stable geometry. Primary buttons are glossy Surimi Orange: a vertical gradient from a lightened hover tone through primary to a deepened active tone, an inset lit top edge, a dark outer ring, and the dark primary foreground. Destructive actions use the same construction in Peach Red. Outline and secondary actions are dark sumi-ink pills with a lit top edge and a fine ring; ghost actions start transparent with supporting text; links use primary-colored text with a hover underline. Base UI triggers that render a Button (dialog, dropdown, collapsible, sidebar) keep the same treatment. All share the label weight (550).

Filled hover brightens the gradient around `primary-hover`; press inverts it toward `primary-active`, swaps the lit edge for an inset shade, and adds a 25% tone. Outline, secondary, and ghost actions lift their face to `surface-pressed` and print a 50% tone of darker `surface-hover` dots over it on hover, while pressed, or while their menu is open. State changes affect color and tone density, never position. The default height is (36px), with (24px), (32px), and (40px) size variants and matching icon-only sizes. Disabled controls reduce opacity to (50%) and stop pointer interaction. Keyboard focus uses the shared ring outline (2px) with an offset (3px), without a second shadow ring. Color transitions run for (160ms) with ease-out timing and honor reduced motion.

### Chips

Small field labels. Source, type, and filter badges use a compact squared badge with the outline or secondary treatment. Status badges can use semantic success/destructive treatments. Keep real source and identity language visible; badge shape does not imply that every label is an action.

### Cards / Containers

Contained editing cards use the card and card-foreground pair, a fine border, the extra-large corner, vertical padding (20px), and horizontal content padding (24px). Their headers size to their actual content. Open analytical variants remove the surrounding card shell and align headings and content on the same field. Overview report containers use the card surface, a fine border, the same extra-large corner, and equal padding from the frontmatter; the body flexes between a steady header and footer. Its small metric tiles use a distinct rounded-square silhouette, documented in the surface brief. Cards, Overview widgets, and metric tiles share a faint inset top highlight and a short top sheen; menus and dialogs own the larger soft shadows.

### Inputs / Fields

Clear, compact instruments. Inputs and select triggers share the inset surface, field stroke, and medium corner. Input text uses (14px) at desktop widths and (16px) below the medium breakpoint. Selects place a small arrow inline after their label; no separate arrow compartment or divider appears. Labels retain leading icons, truncate safely, and keep existing widths and nonmodal behavior. Hover strengthens the border; an open select uses the hover surface and ring-colored border without moving its anchor or removing the page scrollbar.

Menus and select popups share one lit panel: the popover surface with a short top sheen, a fine border and inset top highlight, the extra-large corner, and the menu shadow. Rows are pills. The pointer or keyboard row takes the quiet-control hover (a lifted face with darker 50% dots); the applied row is the shared selection pill (`--selection-face`, warm-yellow text) and keeps its check; separators are dotted 2px rules. Long option sets, such as Event timezone, use a searchable picker: a select-style trigger whose popup holds a pill search field over a short list (at most 320px) that scrolls on its own, with UTC offsets as an aria-hidden Geist Mono hint. Form labels, nearby helper/error text, destructive invalid boundaries, visible focus, and the (40px) narrow-screen minimum remain. Disabled fields reduce opacity and stop interaction.

### Navigation

The four destinations (Overview, Events, Logs, Settings) sit on the deeper sumi-ink rail. Logs uses a console-window icon, distinct from the command glyph on `command_run` event rows. Active links sit on a 25% dither tone of orange mixed into the sidebar ground (30%), with orange text and the built stronger weight (650); hover brightens the tone's ink to 38% without raising its density, keeping the label above 4.5:1 on every dot. Inactive hover uses the sidebar accent. Navigation remains flat with the medium corner. The rail can collapse to icons with labels available accessibly; on mobile it opens as a sheet. Use the shared straight three-bar logo asset alongside the Geist wordmark.

The sidebar retains project/source scope across destinations; report controls retain the date range within the content layout. Report date controls sit left-aligned below the title on every viewport. One outlined date trigger opens a nonmodal shadcn Base UI popover containing preset periods and a Custom range action. Today, Yesterday, Last 7/30/90 days, This month, Last month, This year, and Last 12 months share this control. Applicable previous/next buttons sit beside it; unavailable future navigation is disabled. Custom mode shows two calendar months on desktop and one on mobile, supports keyboard date entry, and applies drafts only after Apply range. Cancel and Escape discard drafts. Calendar days are inclusive in UTC, with a 366-day limit. Opening the picker must not move the page scrollbar or layout. The desktop sidebar toggle sits beside the logo in the sidebar header; mobile navigation has its own row above the title. The footer contains Documentation; retention is managed in project Settings, and no theme selector appears in expanded, collapsed, or mobile navigation.

### Tabs

Line tabs sit on a shared bottom seam with transparent faces. The selected tab uses orange text and a (2px) underline; inactive tabs use supporting text and brighten on hover. There is no active-tab frame or top highlight. The default tab variant uses an inset group surface and a warm selected fill. Preserve keyboard navigation, explicit focus, and existing dimensions.

Connected toggle groups use one pill frame on the inset surface with an inner shade, padding (3px), and a gap (2px). Their borderless pill options have a desktop height of (28px). The chosen option is a lit sumi pill in the selection field with warm-yellow text and a fine top highlight; gloss stays reserved for actions. Overview chart intervals are automatic; report dates use the unified popover described above. Chart groups expand their options to the existing (40px) minimum on narrow screens.

### Shared measurements and event inspection

Time series use an angular single-series line with linear interpolation, the Carp Yellow stroke, light horizontal grid marks, muted axes, and a dithered Carp Yellow falloff: a 50% band within 8% of the series peak below the line, a 25% band to 22%, then 12.5% to the baseline. Overview source and outcome reports use ranked bars with visible values; duration uses numeric summaries and comparison bars. Breakdown rows place the proportional accent fill behind the label, solid to the exact value except a pixel-stepped leading edge: the last 8px step through 4px of 50% and 4px of 25% tone. Values and shares align on the right. Report rows keep their 30px height inside fixed report cards; a report body that cannot fit scrolls instead of compressing rows. Overview rows apply a filter in place. Hovering or focusing a filterable row prints a sparse 25% dot screen across its empty track, warms the bar slightly toward Carp Yellow at its exact length, and underlines the label; a row never fills to look like a larger value. Supported destinations have a separate external-link action revealed on hover or keyboard focus and visible on touch; it never replaces the filter action. Event tables use a subtle header field, fine row divisions, and clear event, context, identity, and time hierarchy. The inspector contains full properties and metadata without changing the surrounding analytical identity.

### Log stream and inspection

The log explorer is an open analytical field, not a stack of cards. Its inset search field takes the available query-bar space, with Search, a single-frame segmented time window (15m, 1h, 6h, 24h, 7d, each with its full name as the accessible label), and Follow alongside it. Dragging across the histogram replaces the window with a "Selected range" chip that clears back to the rolling window. Severity and service are compact choices; additional context filters expand locally. Anything Piko has already received is a choice, never free text: services, environments, and attribute keys come from the query's facets (choosing a key also sets its value type). Only unbounded values, such as a trace ID or an attribute value, are typed. The volume histogram draws one dithered aqua column per bucket (a 50% tone under a solid 2px cap, as HTML columns so the 2px pixels stay square), with error volume solid red from the base. Counts, timestamps, aligned row seams, and literal messages provide the evidence without decorative framing.

Rows remain dense, keyboard-focusable, and visibly separated; hover and keyboard focus lift the row with a 25% tone in darker ink. Severity always has a text label; color supports it through the existing semantic palette. The inspector preserves the selected record while newest results follow in the background. It uses the shared Sheet, context pairs, line tabs, typed attribute literals, and wrapped raw JSON. Values drop JSON quotes; their type shows through syntax color (strings green, numbers pink, booleans and null orange), a `title`, and a visually hidden type label. Failed requests, empty searches, and services awaiting their first logs receive distinct feedback; background failures keep the last results visible.

The page is the stream's only scroll container: a window virtualizer keeps only the rows in view plus a small overscan mounted, and the column header stays sticky at the top of the window. The footer follows the last loaded row; loading and empty feedback reserve a minimum height. Never add a second scrollbar beside the page's. Scrolling pauses Follow; older requests append bounded cursor batches without moving the reading position. Keep focused/inspected rows mounted while present, use one tab stop with arrow/Home/End/Page navigation, and restore focus after inspection even when a live burst removes the original row. Older pages append as the reader nears the end; there is no load button. The 10,000-record buffer cap ends the list with a note to narrow the range or search instead of silently dropping records. At narrow widths, time and severity share the first row and the message uses the full width below, wrapping to two lines. Keep functional metadata at least 11px and the message 12px. Draft edits show a quiet unapplied-state notice with Discard changes, outside the result region.

### Charts

Use TanStack Charts for Overview and Events. Chart colors derive from the semantic theme and its bounded source-category palette. Preserve linear plots, dithered falloff fills (SVG patterns referenced as `url(#…)`), zero baselines, missing-value gaps, UTC labels, metric units, keyboard inspection, and touch scrolling. Keep plots mounted during refresh and preserve their region height while measuring. Source and outcome reports expose values without requiring hover. Overview has one activity time series and no separate duration plot or donuts. Reveal and scale animations are disabled so changing results stays immediate; reduced-motion also suppresses tooltip/axis transitions.

### Motion and loading

Transitions clarify state rather than introducing spectacle. The sidebar dither field is the one ambient motion: a slow 12fps drift for six seconds on arrival and while its area is hovered, then a still frame; it pauses with the tab and never moves under reduced motion. Menus and popovers open with a (160ms) fade and a scale from 96% at the trigger on a strong ease-out (`cubic-bezier(0.23, 1, 0.32, 1)`); a select that opens over its own trigger only fades in over (120ms). All of them close with a faster (100ms) fade. The rail uses a short linear size/position transition; dialogs and sheets use the existing short entry/exit treatment, and every exit holds its last frame until the element unmounts so nothing flashes back. Reduced-motion preference disables animations and transitions, including those on pseudo-elements. Loading uses the official Skullet package, with measured text and fixed-size SkeletonBox elements mapped to the same regions as real content. Skeleton base/highlight colors derive from foreground at (10%)/(8%), with (3px) corners and a slow shared shimmer. Skullet holds fast loads for (150ms), reveals together over (120ms), and respects reduced motion. The root route loads the project catalog on the server, so project pages arrive with the rail, picker, sources, and page heading in place; only bare URLs that depend on the browser's saved project show the workspace placeholder until hydration. A server catalog failure shows a full-screen retry. The server-rendered rail and report controls keep their geometry through hydration, including a saved collapsed rail. No full-page skeleton, connection-state label, or version/license footer. Existing data stays visible during automatic updates. Analytics results are cached (TanStack Query) per project and report scope, so returning to a page shows its last results at once and revalidates in the background; a different scope still uses placeholders. No routine refresh button appears; applied queries update without submitting drafts, and open event inspectors retain their records. Only incoming data regions receive placeholders. Overview retains the current section containers during background refresh while Skullet fills pending values or bodies locally; failures surface within the affected widget with a retry action. Event timezone is a browser preference in Settings; every displayed time (event and log rows, inspectors, log volume) uses it in one readable format (`13 Nov 2026, 15:03:37.602`), UTC included, while chart/calendar buckets and raw JSON stay UTC. Reports and filter chips show known dimension values with their proper names (`macos` reads macOS, `aarch64` ARM64) through `lib/display-values.ts`; inspectors, raw JSON, and filters keep the stored literal. Controls that require JavaScript become enabled after hydration.

## Do's and Don'ts

### Do:

- **Do** reuse semantic theme variables to preserve one consistent palette from the first server paint.
- **Do** preserve the shared upright three-bar logo/favicon, Geist, and the Kanagawa sumi-ink/orange/yellow relationship.
- **Do** align measurements and use fine dividers to connect analytical regions.
- **Do** use inset fields, pill segmented choices, and semantic hover/pressed/selection states.
- **Do** express tints, fills, and state density with the shared ordered-dither tones at 2px pixels, keeping data marks exact.
- **Do** keep visible labels, one ring-colored focus outline, readable metadata, and touch-sized controls on narrow screens.
- **Do** preserve chart and table geometry while data loads or refreshes.
- **Do** use TanStack charts, actual event identity kinds, and truthful empty or error states.
- **Do** keep Overview metric tiles square and analytical reports flat while preserving their exact measures, local loading, and responsive reading order.

### Don't:

- **Don't** return to a corporate blue card grid or a black neon terminal identity.
- **Don't** wrap every measurement in a raised, rounded card.
- **Don't** reintroduce split-arrow compartments, individual segment frames, or filled orange destination navigation. Gloss belongs to pill actions only.
- **Don't** add decorative botanical imagery, faux paper textures, grain, blur, or ornamental glow; dither is the only texture.
- **Don't** replace useful event context with decoration or hide an actual loading failure behind a skeleton.
- **Don't** turn either the Events composition or the Overview report composition into a mandatory layout for every page.


## Shareable report state

Use `/projects/<slug>`, `/projects/<slug>/events`, `/projects/<slug>/logs`, and `/projects/<slug>/settings` as the canonical routes. Treat the project path and validated search parameters as authoritative for source, range, chart metric, Overview filter, applied Events queries and pagination, and applied Logs filters and cursors. Browser preferences only initialize bare URLs. Preserve workspace context across sidebar navigation within a project and view state through Back/Forward. Selecting another project, including a newly created one, starts with All sources and Last 7 days; clear Overview filters and chart choices, Events queries and drafts, Logs filters, drilldowns, and pagination. History navigation and direct report links must still restore their saved scope. Keep draft edits local until Run query. Calendar range selection applies explicit UTC start/end timestamps without promising immutable results; dates include whole days and the API end is exclusive. Automatic freshness must never add URL/history churn. Invalid or unavailable scope shows an error instead of silently querying another project.


### Reporting-period menu

Use the official shadcn Base UI DropdownMenu with RadioGroup, semantic groups and separators, Hugeicons selection checks, and shadcn Kbd hints. Keep the date label and applicable previous/next arrows in one compact frame, with Previous on the left and Next on the right. The menu is 272px wide, bounded by the viewport, with 40px rows and vertical overflow only. Align check and shortcut columns, distinguish the applied range (selection pill) from the keyboard-highlighted row (focus outline), and preserve visible focus. Shortcut hints are small physical keycaps with a lit top edge and a 2px lip.

Group today/yesterday, rolling ranges (24 hours, 7/30/90 days), calendar months, years, and custom range. The first four groups carry small labels (Days, Rolling, Months, Years) with dotted leaders, and the separators before them are spacing only; a dotted rule sets off Custom range. Custom range hands focus into the existing shadcn Popover/Calendar; Escape and Cancel return focus to the shared trigger without scrolling the page. Date shortcuts appear beside working options, respect editable fields and other open overlays, and can be disabled in browser preferences. Do not show unsupported Realtime, All time, or Compare actions.
