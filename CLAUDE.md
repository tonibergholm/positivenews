@AGENTS.md

## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.

## Next.js basePath
App is served under `basePath: "/news"`. Browser-side URLs (EventSource, fetch, Image src) must include the `/news` prefix. Server-side routes do not.
