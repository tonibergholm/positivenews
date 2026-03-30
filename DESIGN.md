# Design System — PositiveNews

## Product Context
- **What this is:** A bilingual (English/Finnish) positive news aggregator with user feedback learning
- **Who it's for:** People seeking uplifting, solutions-focused journalism — antidote to doom-scrolling
- **Space/industry:** Positive news aggregation (peers: Positive News, Good News Network, Reasons to be Cheerful)
- **Project type:** Editorial web app — card-based news feed with category filtering

## Aesthetic Direction
- **Direction:** Editorial/Magazine
- **Decoration level:** Intentional — subtle warm shadows on cards, soft borders. Not flat, not noisy.
- **Mood:** Warm, optimistic, editorially credible. Like morning sunlight on a newspaper. Human and crafted, not sterile tech.
- **Differentiation:** Warm amber palette (competitors all use blue/cyan/teal). Serif headlines give editorial weight that no aggregator in this space has.
- **Reference sites:** positive.news (editorial hierarchy), reasonstobecheerful.world (distinctive typography), thebetterindia.com (dense grid)

## Typography
- **Display/Hero:** Fraunces — Warm variable serif with optical sizing. Gives editorial credibility and personality. No other positive-news aggregator uses a serif — this is our visual signature.
- **Body:** DM Sans — Clean geometric sans with natural warmth. Excellent readability at small sizes, good tabular numbers for timestamps.
- **UI/Labels:** DM Sans (same as body)
- **Data/Tables:** DM Sans with `font-variant-numeric: tabular-nums`
- **Code:** Geist Mono (already loaded via Next.js)
- **Loading:** Google Fonts via `next/font/google` — Fraunces (variable, ~30KB), DM Sans (variable, ~20KB)
- **Scale:**
  - `xs`: 11px / 0.6875rem — timestamps, meta
  - `sm`: 13px / 0.8125rem — card summaries, captions
  - `base`: 15px / 0.9375rem — body text
  - `lg`: 18px / 1.125rem — section headers (DM Sans)
  - `xl`: 22px / 1.375rem — page titles (Fraunces)
  - `2xl`: 28px / 1.75rem — hero headlines (Fraunces)
  - `3xl`: 42px / 2.625rem — display text (Fraunces)

## Color
- **Approach:** Restrained warm — one amber primary + warm neutrals. Color is rare and meaningful.
- **Primary:** `#c76a1a` / `oklch(0.58 0.18 45)` — warm amber-orange. Our differentiator in a sea of blue news sites. Used for active states, links, accents.
- **Background:** `#faf8f5` — warm off-white, like aged paper
- **Foreground:** `#2d2418` — warm near-black, never pure black
- **Card:** `#ffffff` — pure white cards on warm background make images pop
- **Secondary:** `#f0ebe4` — warm cream for hover states, secondary surfaces
- **Muted text:** `#8a7a68` — warm gray for timestamps, meta info
- **Accent:** `#e8d5a0` — warm gold for highlights, active category tabs
- **Border:** `#e8e0d6` — warm border, never cool gray
- **Semantic:** success `#3d8b5e`, warning `#c4930a`, error `#c44b3f`, info `#4a7fb5`
- **Category badges:** Science (sky), Environment (emerald), Society (violet), Health (rose), Innovation (amber)
- **Dark mode strategy:** Reduce saturation 10-20%, warm dark surfaces (`#1a1612` base), amber primary brightened to `#e08a3a`

## Spacing
- **Base unit:** 4px
- **Density:** Comfortable — news cards need breathing room
- **Scale:** 2xs(4) xs(8) sm(16) md(24) lg(32) xl(48) 2xl(64)

## Layout
- **Approach:** Grid-disciplined
- **Grid:** 1 col mobile, 2 col tablet (sm), 3 col desktop (lg), 4 col wide (xl)
- **Max content width:** 1280px (max-w-7xl)
- **Card gap:** 16px
- **Border radius:** sm: 4px, md: 8px, lg: 12px, full: 9999px (badges)

## Motion
- **Approach:** Minimal-functional
- **Card hover:** translateY(-2px) + shadow elevation, 200ms ease-out
- **Image hover:** scale(1.05), 300ms ease-out
- **Color transitions:** 150ms ease
- **Easing:** enter(ease-out) exit(ease-in) move(ease-in-out)
- **Duration:** micro(50-100ms) short(150-250ms) medium(250-400ms)

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-30 | Initial design system created | Created by /design-consultation based on competitive research of positive-news sites |
| 2026-03-30 | Fraunces serif for headlines | No competitor uses a serif — instant editorial differentiation |
| 2026-03-30 | Warm amber primary kept | Every competitor uses blue/cyan/teal — amber says "sunshine, optimism" directly |
| 2026-03-30 | DM Sans over Geist for body | Warmer character than Geist, better pairing with Fraunces, not a default Next.js font |
