---
name: Vibe TTS
description: A source-aware reading instrument for controllable webpage narration.
colors:
  ink: "#172026"
  ink-soft: "#5a646a"
  paper: "#f7f7f2"
  paper-raised: "#ffffff"
  rule: "#ccd1cc"
  rule-strong: "#aeb6b1"
  control-boundary: "#838d88"
  cobalt: "#2853d8"
  cobalt-dark: "#173996"
  vermilion: "#d83c1c"
  success: "#137454"
  focus: "#1746ce"
typography:
  title:
    fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(1.08rem, 4.5vw, 1.32rem)"
    fontWeight: 700
    lineHeight: 1.18
    letterSpacing: "-0.025em"
  headline:
    fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "1.16rem"
    fontWeight: 630
    lineHeight: 1.47
    letterSpacing: "-0.018em"
  body:
    fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "0.76rem"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "0.72rem"
    fontWeight: 760
    letterSpacing: "0.09em"
rounded:
  square: "0"
  capsule: "12px"
  circle: "50%"
components:
  brand-mark:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.cobalt}"
    rounded: "{rounded.square}"
    width: "30px"
    height: "28px"
  transport-primary:
    backgroundColor: "{colors.cobalt}"
    textColor: "{colors.paper-raised}"
    rounded: "{rounded.circle}"
    size: "72px"
  transport-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.square}"
    size: "42px"
  seek-control:
    backgroundColor: "{colors.control-boundary}"
    textColor: "{colors.cobalt}"
    rounded: "{rounded.square}"
    width: "100%"
    height: "18px"
  current-reading:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.headline}"
    rounded: "{rounded.square}"
    padding: "25px 0 27px"
  quick-action:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.square}"
    padding: "10px"
    height: "54px"
  select-field:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.square}"
    padding: "7px 30px 7px 10px"
    height: "38px"
  follow-toggle:
    backgroundColor: "{colors.cobalt}"
    textColor: "{colors.paper-raised}"
    rounded: "{rounded.capsule}"
    width: "43px"
    height: "24px"
  server-disclosure:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.square}"
    height: "58px"
---

# Design System: Vibe TTS

## Overview

**Creative North Star: "The Reading Instrument"**

The Reading Instrument makes Vibe TTS feel like a precise companion to the page rather than a settings dashboard. A quiet ink-and-cobalt palette sits on a chalk-white field; crisp rules and squared controls organize the narrow surface, while the oversized circular transport control gives the primary action unmistakable weight.

The system is compact, operational, and trustworthy. Typography, alignment, and spacing create hierarchy without decorative cards; vermilion appears only as a live-reading signal, and provider disclosure remains adjacent to the neural controls so the privacy boundary is visible at the moment of choice.

**Key Characteristics:**

- A narrow, rule-separated operating surface
- Cobalt interaction against chalk-white fields
- Squared controls with one circular transport exception
- Sparse vermilion live-state signaling
- Compact type with literal, trustworthy copy

## Colors

The palette is a restrained instrument panel: dark ink and quiet gray structure, cobalt action, chalk-white working surfaces, and narrowly assigned semantic signals.

### Primary

- **Instrument Cobalt:** Dominant play/pause control, completed progress, checked toggle, and active selection.
- **Deep Cobalt:** Hover inversion, the product label, the current-word emphasis, and the selection background.
- **Focus Cobalt:** The accessible focus outline, mixed toward white for separation on both paper and raised fields.

### Secondary

- **Live Vermilion:** The reading pulse, active status dot, and short source-position marker. It signals live narration rather than general importance.

### Tertiary

- **Confirmed Green:** Connected server text only; it is paired with the explicit “Connected” label.

### Neutral

- **Reading Ink:** Primary copy, decisive rules, icons, and the dark recovery action.
- **Soft Ink:** Secondary labels, helper copy, disclosure copy, and footer metadata.
- **Chalk Paper:** The continuous panel canvas and sticky transport backing.
- **Raised Chalk:** Selects and the server address field, creating a subtle field boundary without a card.
- **Quiet Rule:** Internal dividers and the one-pixel split between quick actions.
- **Strong Rule:** Resting status dots and stronger passive boundaries.
- **Control Boundary:** Select, input, progress, and unchecked-toggle boundaries with sufficient non-text contrast.

One-off error reds remain local to status and recovery states; they are not promoted to reusable palette tokens.

### Named Rules

**The Cobalt Command Rule.** Use cobalt for active interaction, focus, and selected state—not as a decorative wash.

**The Vermilion Signal Rule.** Reserve vermilion for live narration cues; its scarcity is part of the system.

**The Chalk Field Rule.** Keep the panel on chalk paper and use raised white only inside editable or selectable fields.

## Typography

**Interface Font:** Native UI sans serif, falling through the platform stack to Segoe UI and generic sans serif.

**Character:** Dense, direct, and highly legible. The system uses a single family; scale, weight, tracking, sentence case, and alignment do the differentiating work.

### Hierarchy

- **Title** (700, `clamp(1.08rem, 4.5vw, 1.32rem)`, 1.18): The page title; it is capped at 28 characters of measure and truncates on one line.
- **Headline** (630, `1.16rem`, 1.47): The current sentence; it uses a comfortable 34-character measure for scanning while listening.
- **Body** (400, `0.76rem`, 1.45): Current-word context and compact supporting copy.
- **Label** (760, `0.72rem`, `0.09em`, uppercase): The product name. The source-position kicker uses the same idiom at a slightly smaller size and tighter tracking.
- **Control copy** (`0.65rem–0.8rem`, 520–720): Settings labels, helper text, state, and footer data. Numeric progress and buffer counts use tabular figures.

### Named Rules

**The Weight-Before-Ornament Rule.** Create hierarchy with size, weight, tracking, and alignment; do not add decorative type treatments.

## Layout

The panel is a single full-width column with a 300px minimum width and outer padding of 18px 20px 24px. Its reading order is masthead, sticky transport, current-position cue, quick actions, listening controls, and status footer. Major regions use full-width one-pixel rules instead of cards; the transport sticks at the top with a paper-colored backing and a z-index of 4.

The masthead uses a three-column grid of 30px, flexible copy, and 12px status space. The transport centers a 42px / 72px / 42px / 42px control sequence with 10px gaps. Settings use a two-column grid—`minmax(108px, 1fr)` and `minmax(120px, 1.06fr)`—with 16px between label and field. Quick actions split the width evenly, using a one-pixel grid gap as their divider.

At 340px and below, panel side padding contracts to 15px, the dominant transport becomes 66px, and the transport grid tightens to 38px / 66px / 38px / 38px with 7px gaps. Ordinary setting rows stack with an 8px gap and 14px vertical padding; the follow toggle keeps its label-and-switch row. Controls remain present and in the same reading order.

## Elevation & Depth

The system is flat and rule-led. There are no elevated cards: depth appears only where it clarifies a movable or dominant control. The play/pause control uses a cobalt ambient shadow at rest (`0 10px 24px rgba(23, 57, 150, 0.24)`) and a stronger hover shadow (`0 13px 28px rgba(23, 57, 150, 0.31)`). The switch thumb uses a compact mechanical shadow (`0 2px 5px rgba(23, 32, 38, 0.24)`), while the range thumb uses a one-pixel cobalt-dark shadow ring.

### Named Rules

**The Flat-by-Default Rule.** Surfaces stay flat at rest; shadows belong only to the dominant transport and small movable control parts.

## Shapes

Squared geometry is the default. Selects and the server URL field have no corner radius, quick-action cells meet on a crisp divider, and sections terminate in straight one-pixel rules. Circles are reserved for the primary transport, status dots, range thumb, and switch thumb. The switch alone uses a 12px capsule track because its geometry communicates binary movement.

The outlined brand mark is a compact 30px by 28px rectangle containing three unequal vertical bars. It reinforces the instrument metaphor without introducing a separate illustration style.

## Components

### Transport Buttons

- **Primary:** A 72px cobalt circle with white iconography and an ambient shadow. It darkens, lifts 2px, and deepens its shadow on hover; active press moves down 1px and scales to 0.97.
- **Playing state:** A vermilion ring expands from 0.88 to 1.16 and fades over 1.9 seconds. Reduced-motion preferences collapse animation and transitions to 0.01ms.
- **Secondary:** Square 42px icon targets remain visually open. Hover changes the icon to deep cobalt and reveals a one-pixel bottom rule.
- **Focus / disabled:** Keyboard focus uses a 3px mixed-cobalt outline with a 3px offset. Disabled controls retain their silhouette at 0.42 opacity.

### Seek Rail

The labelled sentence range is the sole progress rail. A three-pixel track fills in cobalt and remains Control Boundary gray ahead of the current sentence; its 15px cobalt thumb has a paper inset and cobalt-dark outer ring.

### Current Reading

The current-position block is a typographic container rather than a card. An uppercase source label begins with a 16px by 2px vermilion marker, the current sentence carries the strongest reading type, and the current word is emphasized in deep cobalt.

### Quick Actions

Two equal action cells sit on the paper canvas with a one-pixel divider and a 54px minimum height. Hover inverts a cell to white on deep cobalt; icon and label remain centered as one unit.

### Inputs / Fields

Selects use raised chalk, a one-pixel Control Boundary stroke, square corners, and compact 7px 30px 7px 10px padding. A right-aligned chevron communicates disclosure without an external icon font. The server URL input uses the same material and boundary at 39px high.

### Disclosure

Provider disclosure is persistent, muted, and immediately follows provider selection. The neural-server section uses native details/summary behavior, explicit Connected or Offline text, and a chevron that rotates 180 degrees over 160ms when opened.

### Toggle

The follow-narration switch is 43px by 24px with a white 18px thumb. The track moves from Control Boundary gray to cobalt, and the thumb translates 19px over 180ms with the expressive system easing.

### Status and Recovery

Status uses text plus color: reading state copy, sentence count, connection wording, and buffer count remain visible. Errors sit between thin red rules with a dark, square recovery action; the browser-speech fallback remains explicit.

## Do's and Don'ts

### Do:

- Do use one-pixel ink or quiet-gray rules to separate regions.
- Do keep the dominant play/pause action circular and visibly larger than neighboring transport controls.
- Do keep provider privacy text adjacent to provider/server controls.
- Do stack label and field rows at 340px and below without hiding controls.
- Do preserve a visible 3px focus outline and the reduced-motion override.

### Don't:

- Don't turn settings into detached cards or rounded tiles.
- Don't round selects, URL fields, or action cells; square edges are the default.
- Don't spread vermilion across general emphasis or decoration.
- Don't use elevation to separate ordinary sections; use rules, spacing, and contrast.
- Don't communicate playback, connection, or error state through color alone.
