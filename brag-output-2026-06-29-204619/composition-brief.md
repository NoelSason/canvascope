# Hyperframes Composition Brief: Canvascope

## Objective
Create a short launch-style brag video for Canvascope.

## Output
- Composition directory: `brag-output-2026-06-29-204619/composition/`
- Rendered video: `brag-output-2026-06-29-204619/brag.mp4`
- Format: vertical - 1080x1920
- Duration: 21.4 seconds

## Source Material
- Project root: `/Users/noelsason/Desktop/Canvascope Inc./02-Subsidiaries/canvascope-extension/app/extension-core`
- Primary files read: `README.md`, `manifest.json`, `src/popup/popup.html`, `src/sidepanel/sidepanel.html`, `src/styles/tokens.css`, `src/styles/styles.css`, `src/sidepanel/sidepanel.css`, DropBridge sources/tests, and sibling public-site copy under `web/extension-web`.
- Product name: Canvascope
- Tagline / strongest claim: "Turn Canvas into an AI study hub: cited course answers, instant PDF search, deadline insights, and smarter planning for every class."
- Key UI or visual moment to recreate: Canvascope popup search, AI side panel with source chips, and DropBridge v3 delivery receipts.
- Copy that must appear verbatim:
  - Canvascope
  - Ask anything across your course.
  - Send PDF to Lectra
  - DropBridge v3
  - Canvascope 10.1

## Creative Direction
- Tone preset: cinematic
- Creative direction: epic vertical Instagram launch reel for a serious academic tool.
- Interpretation: fast product montage, dramatic but readable UI, strong edge-anchored frames, premium audio.
- Angle: Canvascope is the command center students wish their LMS had.
- Hook: Your LMS finally has a command center.
- Outro / punchline: Turn Canvas into an AI study hub.
- Avoid:
  - Generic SaaS language
  - Abstract filler visuals
  - Unrelated visual redesign
  - Claims not reflected in the local source

## Visual Identity
- Background: #07090f
- Text: #edf0f8
- Accent: #b9a5ff
- Secondary accents: #6fce9a, #e8b770, #e57373
- Display font: Geist, system fallback
- Body font: Geist, system fallback
- Visual references from the project: dark popup shell, AI side panel, violet reticle controls, source chips, DropBridge status rail, Canvascope logo.

## Storyboard
Use the storyboard in `brag-plan.md` as the creative contract.

Scene summary:
1. Command Center Hook - 2.7s - logo, reticle, "Your LMS finally has a command center."
2. Search The Course Stack - 4.3s - popup search types "enzyme kinetics" and shows course results.
3. Ask With Sources - 4.2s - side panel answer with [1] [2] source chips.
4. PDFs, OCR, Planner - 4.6s - cached PDF pages, OCR hits, planner blocks, quiz chip.
5. Lectra Handoff Receipts - 3.4s - Send PDF to Lectra and DropBridge receipt states.
6. Logo Lockup - 2.2s - Canvascope 10.1 and final product line.

## Audio
- Audio role: punchy launch bed with sparse professional UI accents.
- Audio arc: immediate lift, lighter focus during Ask, strong rise through DropBridge, clean final hit.
- Music: `assets/music/happy-beats-business-moves-vol-10-by-ende-dot-app.mp3`.
- Music treatment: 0.32 baseline volume, short fade near final logo.
- Music cue guidance: bundled preset at `assets/music/cues/happy-beats-business-moves-vol-10-by-ende-dot-app.music-cues.md`; strongest planned locks around 15.82s, 18.55s, and 20.19s.
- Audio-reactive treatment: subtle; pre-extracted `assets/music/audio-data.js` drives CSS glow variables for grid/panels/logo.
- Audio-coupled moments:
  - Search query and result cards - typing/click/drop cues.
  - Source chips - light drop cues.
  - DropBridge receipts - soft impacts and UI click ticks.
  - Final logo - bell impact, music fade.
- SFX selection guidance: low-risk `/brag` SFX copied into `assets/sfx/`; favor interface clicks, soft impacts, and one final bell.
- SFX analysis guidance: `/tmp/brag-skill.iOCsvo/skills/brag/assets/sfx/sfx-analysis.md` was read; low-risk picks were selected.
- Exact SFX choice: implemented after the visual storyboard with copied local assets.
- Audio files: music and SFX are local under `composition/assets/`.

## Hyperframes Instructions
Use current HyperFrames conventions.

Requirements:
- Show at least one real UI, copy, or visual element from the source project.
- Keep all text readable in the final render.
- Keep the video within 15-25 seconds.
- Include the planned music/SFX layer.
- Use local assets for audio and logo.
- Run HyperFrames lint, validate, inspect, snapshot, and render.
