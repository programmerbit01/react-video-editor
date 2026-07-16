# Captions — the standard

Captions had three UIs, three builders and two stylers. Every caption bug we chased for a week
turned out to be one of those copies disagreeing with another — never a caption bug. This file
exists so nobody, human or AI, adds the fourth.

**If you are about to write code that creates a caption: stop and read § The one door.**

---

## The one door

There is exactly one place captions are made or styled: the **Captions** tab in the left menu
(`src/features/editor/captions/panel.tsx`). Pick the audio or video to caption from the Source
dropdown, generate, style. That's it.

There is no Captions tab on a video clip. There is no Captions tab on an audio clip. There used
to be both, each generating onto its own track — so captioning a talking-head video *and* its
voiceover produced two sets of subtitles stacked on screen, and the left menu just told you to go
use one of them. Picking the speaker is a choice **inside** one panel, not a reason for three.

| Want to… | Use |
|---|---|
| create captions | `applyCaption` — `captions/generate.ts` |
| remove them | `removeCaption` — `captions/generate.ts` |
| count them for a clip | `captionCountFor` — `captions/generate.ts` |
| transcribe media | `transcribeMedia` — `captions/generate.ts` |
| read a clip's transcript | `getTrackTranscript` — `control-item/transcript-panel.tsx` |
| restyle captions | `BasicCaption` — `captions/style.tsx` |

**Creation and styling are separate on purpose.** Every style change used to re-run
`applyCaption`, which rebuilds the caption items from scratch — silently wiping whatever the
styler had set. `generate.ts` gives captions the style they are *born* with; `style.tsx` owns
every change after that. Don't merge them back.

---

## The shape

A caption is identified by its **owner**, never by its track. Panels group captions with
`groupBy(items, "metadata.sourceUrl")`, and the dedupe that stops a second "Apply Captions" from
stacking a duplicate set keys off `sourceTrackItemId` + `addedCaption`.

```jsonc
{
  "id": "<generated>",
  "type": "caption",
  "display": { "from": <ms on the timeline>, "to": <ms> },
  "duration": <to - from>,
  "metadata": {
    "sourceTrackItemId": "<id of the audio/video item these captions transcribe>",
    "addedCaption": true,
    "sourceUrl": "<that item's details.src — MUST match exactly>",
    "relFrom": <display.from minus the owner's display.from>,
    "relTo":   <display.to   minus the owner's display.from>
  },
  "details": { "text": "…", "words": [{ "word": "Hello", "start": <ms>, "end": <ms> }], /* style */ }
}
```

Captions live on **one shared track** per project:

```jsonc
{ "id": "captions-track--<sourceTrackItemId>", "type": "caption", "name": "Captions",
  "items": [...], "accepts": ["caption"], "metadata": { "captionTrack": true } }
```

`CAPTION_TRACK_PREFIX` (`captions/generate.ts`) is the single definition of `captions-track--`.
Import it. Re-declaring the literal is how two paths drift apart and silently stop finding each
other's tracks — no type error, no test failure.

### Metadata is not optional

A caption without `metadata` doesn't degrade, it **breaks the editor**: the style panel reads
`metadata.sourceUrl` off `null` and takes the whole app down, the caption count is structurally 0
so the panel offers "Apply Captions" on already-captioned media and never offers "Remove", and
clicking it stacks a second set on top of yours.

### Never point `fontUrl` at cdn.designcombo.dev

It 403s. The editor's font loader neither resolves nor rejects on a failed load, so `DESIGN_LOAD`
awaits it forever and the project **silently never opens** — no error, anywhere. That one dead URL
cost ~20 projects. Use a Google Fonts URL, or omit `fontUrl` entirely.

---

## Who else writes captions

| Producer | Path | Notes |
|---|---|---|
| Captions panel | `captions/generate.ts` → `applyCaption` | the standard |
| AI Edit panel | `captions/builder.ts` → `addCaptions` | **known duplicate, see below** |
| vApp MCP | `vapp_server_mcp.py` → `generate_captions` | Python; must emit the shape above |

The MCP generator is a **third implementation in another language**. It cannot import
`generate.ts`, so the shape above is its contract — and its docstring is what an MCP-driving AI
actually reads. Change the shape here and you must change that docstring, or the AI keeps emitting
last month's schema.

### Known duplicate — do not add a fourth

`captions/builder.ts::addCaptions` is `generate.ts::applyCaption` under a second name. They
disagree on exactly one field: captions born in `builder.ts` highlight words
(`highlightWords: true`), captions born in `generate.ts` don't. Same project, same transcript, two
different-looking caption sets depending on which panel you used.

`generate.ts` is the standard. `builder.ts` collapses into it once `applyCaption` returns the
created ids — `ai-edit-panel.tsx` needs them for its undo snapshot, which is the only reason the
duplicate still exists.

---

## Export

Captions render as **PNG overlays** in the FF (ffmpeg) export path, cropped to the text band.
This is not a stylistic choice: the render box's ffmpeg build may lack `libass`/`drawtext`, so
burning text directly can't be relied on. Full-frame overlays were the #1 export bottleneck
(25s and 5.5GB on a dense project); the band crop is pixel-identical and much cheaper.

FF currently honours only some of the style fields `generate.ts` emits — font family is
hardcoded there. Captions that look right in the player can still export wrong.

---

## Debugging captions

Two rules, both learned the hard way:

1. **Reproduce before fixing.** Five straight caption "fixes" shipped on theory, all wrong. The
   real causes were a prefetch dependency in `player.tsx` and a `>` that should have been `>=` in
   `caption-word.tsx` — not fonts, not CORS, not transitions, which is where the reasoning kept
   pointing. Run a dev copy of the repo and see the bug first.
2. **When the user's observation contradicts your reading of the code, your reading is wrong.**
   "Ken Burns intensity 8→12 makes the black frames stop" made no sense against the code and was
   dismissed twice. It was correct: any edit re-triggered the prefetch and reloaded the assets.

Never test against the live server. Clone the repo, `next dev` on a spare port.
