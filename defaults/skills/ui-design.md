# UI Design Skill
# trigger: design|beautiful|modern|stunning|polished|premium|elegant|theme|dark.?mode|color|typography|spacing|animation|gradient

## Design System Foundations
- Use an 8px spacing grid: 8, 16, 24, 32, 48, 64, 80, 96
- Pick ONE accent color + neutrals (slate/zinc/gray) + semantic (success/warning/error)
- Typography: 2 fonts max — one for headings, one for body (or one variable-weight font)
- Border radius: pick ONE size and use consistently (4px subtle, 8px default, 12px rounded, 16px pill)
- Shadows: use sparingly — elevation indicates importance, not decoration
- Max content width: 1200-1440px for readability

## Color Strategy
- Neutral base: slate-50 to slate-950 for backgrounds, text, borders
- Accent: ONE vibrant color for CTAs, links, active states (blue, indigo, violet)
- Semantic: green=success, red=error/destructive, amber=warning, blue=info
- Dark mode: invert the neutral scale, keep accent/semantic — desaturate slightly
- Contrast: 4.5:1 minimum for text — test with browser devtools

## Layout Patterns
- Use CSS Grid for 2D layouts (page grids, card grids, dashboards)
- Use Flexbox for 1D layouts (navbars, card content, button groups)
- Consistent page structure: header → hero/content → footer
- Cards: consistent padding (16-24px), subtle border or shadow, clear hierarchy
- Forms: label above input, consistent spacing, clear error states, disabled states

## Micro-interactions
- Button: scale(0.98) on active, opacity transition on hover
- Cards: subtle shadow increase on hover, smooth 200ms transition
- Modals: fade-in backdrop + scale-up content, close on Escape + backdrop click
- Loading: skeleton shimmer animation, not spinners (unless inline)
- Toasts: slide in from top-right, auto-dismiss with progress bar
- Page transitions: subtle fade or slide, 150-300ms duration

## Typography Rules
- Heading hierarchy: clear size difference between h1→h2→h3 (use ratio 1.25-1.5)
- Body text: 16px minimum, 1.5-1.75 line-height for readability
- Max line length: 65-75 characters (use max-w-prose or similar)
- Font weight: 400 body, 500 labels, 600 subheadings, 700 headings
- Letter-spacing: -0.02em for large headings, normal for body
