---
version: 1
slug: "src-webview-render-ts"
primary_target: "src/webview/render.ts"
related_targets: ["src/webview/html.ts","src/webview/views.ts"]
---

# AgentWatch webview panels

Scope: the four webview panels (Session, Conversation, Usage dashboard, Compare sessions), which share one stylesheet in `src/webview/html.ts`. Mode: Operate. The Session panel is the lead surface, usually open in a narrow editor column (about 500–800px) beside code.

Audience and job: a developer who uses Claude Code daily checks what a session cost and what drove that cost, then drills into context, subagents, files, commits and errors. Must follow the VS Code theme (dark, light, high contrast). No network. Must not look like a generic SaaS dashboard.

## Direction contract

THESIS: Each panel is a type specimen of its own numbers. Cost is set at display scale and every other figure ranks by size and weight alone. It refuses the KPI-tile dashboard grid.

OWN-WORLD: The theme's own ground and ink. One foundry accent, the theme's orange chart colour, used only for the scrubber and the current selection. Flat surfaces, no boxes or card borders, generous negative space. Display figures are 56–72px, weight 600, with tabular figures. Labels are 11px monospace caps. Table numbers carry weight by their share of the total.

STORY: The developer opens a session beside the code and reads its cost and its largest drivers without scrolling. They scrub the context timeline to see when it grew, then follow the nav into files, commits and errors.

FIRST VIEWPORT: Title at 26px. The cost figure at 64px beside a mono label and Claude Code's recorded cost. A row of three secondary figures at 28px (tokens, cache hit, duration). The actions toolbar. A sticky section nav. Then "Cost drivers": the main thread and each subagent with weight-encoded cost.

FORM: Type Specimen (catalog challenger, adopted by the user, not on the grounded list). Signature interaction: a range scrubber over the context series re-sets the context display figure, time and marker live; numbers are weight-encoded by share. seed:09d02d2cb742382c

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
