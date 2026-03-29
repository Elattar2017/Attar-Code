# Frontend Development Skill
# trigger: react|vue|svelte|angular|next|component|page|layout|css|tailwind|html|ui|form|button|modal|responsive

## Component Architecture
- Break UI into small, focused components (< 150 lines each)
- Use composition over inheritance — pass children, render props, or slots
- Separate presentational components (how things look) from container components (how things work)
- Keep state as close to where it's used as possible — don't lift unless needed
- Name components by what they ARE, not what they DO: UserCard not DisplayUser

## Styling Rules
- Mobile-first responsive design: start at 320px, add breakpoints up
- Use consistent spacing: 4px base unit (4, 8, 12, 16, 24, 32, 48, 64)
- Maintain visual hierarchy with typography: clear heading levels, readable body text
- Interactive elements need ALL states: default, hover, focus, active, disabled
- Minimum touch target: 44x44px on mobile
- Use CSS custom properties for theming — makes dark mode trivial

## Accessibility (a11y)
- Semantic HTML: use button for actions, a for navigation, not div/span
- Every image needs alt text — descriptive for content images, empty for decorative
- Form inputs need labels — use htmlFor/for linking or wrapping
- Color contrast: 4.5:1 for normal text, 3:1 for large text (18px+)
- Keyboard navigation: all interactive elements must be focusable and operable
- ARIA labels only when semantic HTML isn't sufficient

## Performance
- Lazy load images below the fold
- Code-split routes and heavy components
- Memoize expensive computations (useMemo, computed)
- Debounce search inputs (300ms)
- Use loading skeletons — never show blank screens
- Optimize images: correct format (WebP), correct size, blur placeholder

## State Management
- URL state for navigation/filters (searchParams)
- Form state stays local (useState, reactive)
- Server state via data fetching library (SWR, React Query, fetch)
- Global client state only for truly global concerns (auth, theme, cart)
- Never store derived data — compute it from source state
