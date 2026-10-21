---
name: Supervisor
description: Transport interchange wayfinding for following work and its supervision.
colors:
  ink: "#202c3c"
  quiet: "#53657a"
  surface: "#fff"
  line: "#dce3eb"
  soft: "#edf2f7"
  canvas: "#f6f8fb"
  blue: "#215eb2"
  control-line: "#8796a9"
  rail: "#202944"
  rail-quiet: "#becbdf"
  rail-selected: "#354563"
  teal: "#007a70"
  dark-ink: "#e6edf6"
  dark-quiet: "#adbed1"
  dark-surface: "#1d293a"
  dark-line: "#3c4c60"
  dark-soft: "#29384c"
  dark-canvas: "#152032"
  dark-blue: "#a0c4ff"
  dark-control-line: "#7e91ac"
  dark-teal: "#73dbcb"
  dark-rail: "#182138"
  on-accent: "#fff"
  blue-hover: "#17467f"
  dark-button-primary: "#2863ac"
  rail-hover: "#2a3853"
  rail-active-icon: "#72ddd4"
  rail-focus: "#7ce0d8"
  section-selected: "#e0eeef"
  section-selected-ink: "#125d58"
  dark-section-selected: "#254846"
  dark-section-selected-ink: "#b9eee5"
  native-active: "#168475"
  invalid: "#a32f25"
  dark-invalid: "#ffb9b3"
  status-blue-bg: "#e7effc"
  status-blue-ink: "#244b88"
  status-green-bg: "#e2f1eb"
  status-green-ink: "#1d5d4b"
  status-amber-bg: "#fcf0d9"
  status-amber-ink: "#7b4b0d"
  status-critical-bg: "#fbe6e4"
  status-critical-ink: "#92332b"
  dark-status-blue-bg: "#263e64"
  dark-status-blue-ink: "#c6ddff"
  dark-status-green-bg: "#203f3a"
  dark-status-green-ink: "#b6e7d6"
  dark-status-amber-bg: "#4c3a1c"
  dark-status-amber-ink: "#f4d699"
  dark-status-critical-bg: "#512e30"
  dark-status-critical-ink: "#ffcfcb"
typography:
  headline:
    fontFamily: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: -0.025em
  headline-mobile:
    fontFamily: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
    fontSize: 25px
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: -0.025em
  title:
    fontFamily: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
    fontSize: 20px
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: -0.015em
  title-mobile:
    fontFamily: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
    fontSize: 19px
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: -0.015em
  section:
    fontFamily: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
    fontSize: 17px
    fontWeight: 650
    lineHeight: 1.4
  objective:
    fontFamily: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
    fontSize: 21px
    fontWeight: 600
    lineHeight: 1.5
  objective-mobile:
    fontFamily: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
    fontSize: 19px
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
    fontSize: 14px
    fontWeight: 550
    lineHeight: 1.4
  navigation:
    fontFamily: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.55
  caption:
    fontFamily: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
  badge:
    fontFamily: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
    fontSize: 12px
    fontWeight: 550
    lineHeight: 1.5
  input:
    fontFamily: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
    fontSize: 16px
  code:
    fontFamily: ui-monospace, Menlo, Consolas, monospace
    fontSize: 0.85em
rounded:
  status: 5px
  control: 7px
  rail-item: 8px
  context: 9px
  inset: 10px
  surface: 12px
  dialog: 14px
  dot: 50%
spacing:
  "4": 4px
  "8": 8px
  "12": 12px
  "16": 16px
  "18": 18px
  "20": 20px
  "24": 24px
  "26": 26px
  "30": 30px
  "34": 34px
  "38": 38px
components:
  button-primary:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: 8px 13px
  button-primary-hover:
    backgroundColor: "{colors.blue-hover}"
  button-primary-dark:
    backgroundColor: "{colors.dark-button-primary}"
    textColor: "{colors.on-accent}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: 8px 13px
  button-secondary-hover:
    backgroundColor: "{colors.soft}"
  button-quiet:
    backgroundColor: transparent
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: 8px 13px
  input-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.input}"
    rounded: "{rounded.control}"
    padding: 9px 12px
  rail-navigation:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.rail-quiet}"
    typography: "{typography.body}"
    rounded: "{rounded.rail-item}"
    padding: 10px 13px
  rail-navigation-current:
    backgroundColor: "{colors.rail-selected}"
    textColor: "{colors.on-accent}"
  section-navigation:
    textColor: "{colors.quiet}"
    typography: "{typography.navigation}"
    rounded: "{rounded.control}"
    padding: 8px 14px
  section-navigation-current:
    backgroundColor: "{colors.section-selected}"
    textColor: "{colors.section-selected-ink}"
  status-chip:
    backgroundColor: "{colors.soft}"
    textColor: "{colors.quiet}"
    typography: "{typography.badge}"
    rounded: "{rounded.status}"
    padding: 3px 7px
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    padding: 24px
  attention-list:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
  task-path:
    backgroundColor: "{colors.soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.context}"
---

# Design System: Supervisor

## Overview

**Creative North Star: "Transport Interchange Wayfinding"**

Transport interchange wayfinding gives Supervisor a stable midnight-indigo navigation field and clear work surfaces. Teal marks the selected route; action blue identifies links, controls and keyboard focus. The personality comes from aligned information, restrained geometry and readable operational type.

The workspace is compact without compressing the meaning of work. Objectives, supervision, native activity and read times have separate places. Borders and tonal insets organize detail; the same structure changes into stacked reading on narrow screens and follows the system color preference.

**Key Characteristics:**

- A persistent indigo navigation field beside a quiet work canvas.
- Aligned rows and explicit text labels for state, scope and freshness.
- Blue actions, teal selection and semantic amber/red attention.
- Flat bordered surfaces, modest corners and minimal motion.

## Colors

The palette combines a cool neutral workspace with an indigo navigation field, blue actions, teal selection and explicit state colors. Frontmatter holds exact values; base names are the light scheme and matching `dark-` names are the implemented dark overrides.

### Primary

- **Action blue** (`blue`, `dark-blue`): links, caret, control hover borders and work-area focus. The dark link/focus blue is lighter than the filled primary control.
- **Primary control** (`blue`, `dark-button-primary`): filled actions with `on-accent` text. `blue-hover` is the implemented primary hover fill in both schemes.

### Secondary

- **Route teal** (`teal`, `dark-teal`): selected project-tab underline and quiet-state icon.
- **Selected conversation view** (`section-selected` / `section-selected-ink`, with dark counterparts): a tonal fill with stronger teal text.
- **Rail selection** (`rail-selected`, `rail-active-icon`): a lighter indigo fill, white text and pale-teal line icon. `rail-hover` and `rail-focus` complete the interaction states.

### Tertiary

These are semantic state pairs, not decorative accents. Each `status-<name>-bg` / `status-<name>-ink` pair has a dark counterpart.

- **Blue:** informational and underway records.
- **Green:** enabled, valid or completed records, according to the accompanying label.
- **Amber:** attention, incomplete reads or uncertain conditions.
- **Critical red:** blocked or failed states. `invalid` and `dark-invalid` supply invalid-input borders.
- **Native active green** (`native-active`): the connected/active dot, accompanied by its native-state text. This value stays the same in both schemes.

### Neutral

- **Ink** and **quiet**: primary work text and secondary explanatory text.
- **Surface**, **soft** and **canvas**: white work areas, cool tonal insets and the surrounding pale workspace; dark counterparts preserve their separation with blue-black tones.
- **Line** and **control line**: quiet content boundaries and stronger interactive-control outlines.
- **Rail** and **rail quiet**: midnight-indigo navigation and its subdued blue-white labels. The rail darkens in dark mode; quiet text and the selected fill retain their base values.

**The Accent Roles Rule.** Use action blue for links, controls and work-area focus. Use teal for selected project routes and conversation views; the indigo rail keeps its own selected fill and pale-teal icon.

**The State Needs Words Rule.** Pair every status color or activity dot with text. Amber and red describe an actual issue or state, and native activity remains separate from supervision and assessment.

Browser text selection uses a pale-teal background and dark ink; scrollbars use the control outline against the tonal inset. Carets and focus share action blue. These treatments extend the palette into native browser surfaces.

## Typography

**Body and operational heading font:** the platform sans stack in frontmatter. There is no separate reusable display face.

**Label/Mono font:** labels use the same sans; literal code, paths and identifiers use the recorded monospace stack.

**Character:** precise, familiar and compact. Weight and small changes of scale establish hierarchy without ornamental lettering.

### Hierarchy

- **Headline:** page headings with tight tracking and compact line height; the mobile role replaces the desktop size at the narrow breakpoint.
- **Title:** major sections, with a slightly smaller mobile size.
- **Section:** subordinate headings and fieldset legends.
- **Objective:** the focused task statement, with a larger line height and a mobile size override.
- **Body:** default work content. Measured line limits vary by purpose: page descriptions (72ch), work objectives (64ch), focused objectives (70ch), empty-state explanations (65ch), guide content (82ch) and source definitions (85ch).
- **Label:** buttons and concise form labels. The recorded label line height is the button value; ordinary labels inherit body line height.
- **Navigation:** project and conversation links; current items increase weight to (600).
- **Caption:** read times and supporting information.
- **Badge:** compact sentence-case status text.
- **Input:** readable field text; weight follows the surrounding control or label.
- **Code:** relative sizing follows surrounding text, with local sizing for excerpts.

**The Operational Type Rule.** Use the platform sans for work content, labels and operational headings. Reserve monospace for source, paths and identifiers; status labels stay in sentence case.

## Layout

The desktop shell has a fixed navigation rail (220px), a matching content offset and a viewport-height minimum. The header stays in normal document flow, with a minimum height of (70px). The centered workspace has a maximum width of (1560px) and padding of (34px 38px 24px). Settings narrow to (1000px). Rows wrap rather than forcing long labels into fixed-width controls.

At widths up to (1150px), rail and offset reduce to (190px), horizontal header/workspace padding becomes (26px), and search occupies its own filter row.

At widths up to (760px), navigation becomes an in-flow indigo header with four equal columns. Main navigation items have a minimum height of (57px); the brand detail and lower utility prose disappear. The instance header reduces to a minimum height of (62px), the workspace uses (25px 18px), and ordinary panel/task padding becomes (19px). The header still scrolls with the page.

The work table becomes stacked conversation records with visible native-activity and update labels. Checkout controls, project-configuration identity fields and the three-stage task path become single-column layouts. Project and conversation rows wrap state metadata; save actions stack vertically. The sign-in split view also stacks at this breakpoint.

Spacing is pragmatic rather than a rigid modular grid: small gaps bind labels and metadata, a normal stack separates blocks (20px), ordinary panels use (24px), task focus uses (26px), and the home workspace uses (30px), reducing to (25px) on mobile. Frontmatter lists recurring measured steps rather than every local inset.

Minimum heights remain explicit: buttons (42px), fields (44px), project navigation (46px) and conversation navigation (42px). With a coarse pointer, buttons, text fields, selects and project/conversation navigation rise to at least (48px). Long copy, paths and identifiers wrap; source text preserves line breaks. Radio and checkbox marks remain (18px).

## Elevation & Depth

Depth comes from borders and tonal surfaces. Content panels have one (1px) boundary; nested panels flatten into a top rule and vertical spacing. The navigation field, work surfaces and cool insets establish the layers. There are no authored box shadows. A modal uses the existing translucent indigo backdrop and a bounded, scrollable surface without adding a shadow vocabulary.

**The Single Boundary Rule.** Give a work surface one quiet border. Inside an existing panel, separate sections with rules and spacing instead of another rounded card.

Motion is limited to a border-color transition (140ms, ease-out) on buttons and links when reduced motion is not requested. Hover changes fill and border without a lift or entrance effect. Reduced-motion mode retains automatic scrolling.

## Shapes

Surfaces are gently rounded rectangles with crisp, quiet borders. Frontmatter records observed steps for status tags, controls, rail items, contextual insets, work surfaces and dialogs. Tags are compact rounded rectangles rather than full capsules; activity dots are circular. The filter toolbar and table form one shared rounded enclosure.

Icons are authored SVG line drawings on a (24 × 24) view box, with no fill, a (1.7) stroke and rounded caps/joins. Default rendered size is (20px), with smaller (16–18px) instances beside text. Decorative SVGs are hidden from assistive technology. The existing PNG application mark appears at (36px) in the desktop rail and (32px) on mobile.

## Components

### Buttons

Compact, explicit actions. Primary, bordered secondary and quiet variants share the control radius and recorded padding. Hover changes the border to action blue and the neutral fill to the tonal inset; primary hover uses its deeper fill. Quiet buttons remove their resting border and fill, then receive the standard neutral hover. Disabled buttons reduce opacity to (0.55) and use a default cursor. The global keyboard outline is (3px) with a (3px) offset. Busy states retain an action label such as “Saving…”.

### Chips

Small textual state markers. Neutral chips use the tonal inset and quiet text; blue, green, amber and critical variants use their recorded foreground/background pairs. Labels explain the color in sentence case. Counts use tabular numerals.

### Cards / Containers

Flat work surfaces. Ordinary panels use the surface radius, quiet border and recorded padding. Nested sections flatten into rules. Project directories and conversation lists use aligned rows with separators and clear linked titles. Empty states use a dashed control outline; loading states use static tonal bars.

### Inputs / Fields

Familiar native controls with a stronger outline than content containers. Inputs, selects and textareas share the control radius, surface fill and recorded inset. Placeholders use quiet ink at full opacity; the caret uses action blue. Invalid fields use the semantic invalid border. Textareas resize vertically and start at a minimum height of (116px). Focus uses the common visible outline; native disabled and fieldset behavior remains intact.

### Navigation

The rail pairs a label and line icon; current selection adds the selected indigo fill, white text and teal icon. Rail keyboard focus uses its pale-teal outline. An amber count marks recorded attention items. Mobile keeps the same four destinations in a top grid.

Project navigation uses a restrained bottom boundary and teal current-item underline (2px). Conversation navigation uses rounded text links and a tonal teal selected fill. Current state belongs to the active link through `aria-current`. Guide remains a separate utility link.

### Attention and notices

Attention rows keep title, reason and context together in an amber-bordered list. Hover uses a warmer surface; dark mode supplies its own border and hover colors. Quiet states use a teal-tinted inset and explanatory label. Informational and draft notices use blue-tinted backgrounds and boundaries. These treatments describe actual records or uncertainty.

### Task path

The signature task path is a tonal inset with three equal stages: task interpretation, plan agreement and Supervisor assessment. Each stage has a bold short label and supporting state text, divided by quiet rules. The stages stack on mobile. Read times remain part of assessment without making the path numerical progress.

### Disclosure and dialog

Native disclosures retain their marker and a minimum-height summary (44px); opening adds separation before the details. Activity inspection uses a native modal with the dialog radius, padding (26px), width bounded by (740px) and (100% - 32px), and maximum height (85dvh). Overflow stays within the dialog. A skip link becomes visible on keyboard focus.

## Do's and Don'ts

### Do:

- Do preserve the indigo navigation field and the distinction between canvas, work surface and tonal inset in both color schemes.
- Do keep state labels, native activity, read times and uncertainty readable together.
- Do use visible keyboard focus, labeled controls and the existing narrow-screen reflow.
- Do draw icons as consistent stroked SVG and keep monospace for literal technical content.

### Don't:

- Don't use amber or red as decoration, or let a color alone communicate status.
- Don't add decorative shadows, gradients or nested rounded cards to the flat work surfaces.
- Don't turn the task interpretation, agreement and assessment path into a percentage-complete indicator.
- Don't reuse the sign-in display scale for workspace labels.

