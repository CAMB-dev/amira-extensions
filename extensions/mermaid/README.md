# mermaid

` ```mermaid ` blocks in [Amira](https://github.com/CAMB-dev/Amira)'s replies drawn as
diagrams: flowcharts and sequence diagrams as Unicode text that fits the terminal's width,
every other type (pie, gantt, class, state, ER, …) as a picture when Amira can draw one.

```sh
amira ext install mermaid
# for pictures of the other types:
amira ext install images
amira ext install browser
```

Needs Amira extension API 0.1.3 or later (Markdown renderers). While the block streams in it
shows as code; once it closes, the diagram takes its place (in the inline transcript it is
committed once, in order; the full-screen transcript draws it again at a new width).

## As text

```
     ┌─────────────────────┐
     │ User sends a prompt │
     └──────────┬──────────┘
                │
                ▼
           ╱──────────╲
          < Tool call? >
           ╲───┬──────╱
               │  ▲
               │  │
               │  └───────────┐
        ┌──────┴───────┐      │
       yes            no      │
        ▼              ▼      │
 ┌──────────────┐  ╭───────╮  │
 │ Run the tool │  ( Reply )  │
 └──────┬───────┘  ╰───────╯  │
        │                     │
        │      ┌──────────────┘
        ▼      │
┌──────────────┴───────┐
│ Feed the result back │
└──────────────────────┘
```

- **Flowcharts** (`flowchart` / `graph`, TD, TB, BT, LR, RL): all node shapes (`[ ]`, `( )`,
  `([ ])`, `[[ ]]`, `[( )]`, `(( ))`, `>]`, `{ }`, `{{ }}`, `[/ /]`, `[\ \]`, trapezoids,
  `((( )))`), links `-->`, `---`, `-.->`, `==>`, `--o`, `--x`, `<-->`, `~~~` with labels
  (`-- text -->`, `-->|text|`), chains, `&`, subgraphs (framed). Styling (`classDef`, `style`,
  `click`, …) is left out.
- **Sequence diagrams**: participants and actors (with aliases), `->>`, `-->>`, `->`, `-->`,
  `-x`, `--x`, `-)`, `--)`, self messages, `autonumber`, notes (left of, right of, over one
  or two), `loop`, `alt`/`else`, `opt`, `par`/`and`, `critical`, `break`, nested.
- Labels are measured as the terminal draws them (CJK and emoji take two columns). Too wide
  for the screen, labels wrap, LR becomes top-down, and in the end the diagram is listed
  compactly (`[A] └──▶ B`); a line is never wider than the screen.

## As a picture

When the `images` extension can draw images in this terminal and the `browser` extension is
installed, diagrams of the types without a text layout are rendered with mermaid in the
headless browser (mermaid 12.0.0 is bundled in `vendor/`, so nothing is fetched: the render
has no network access at all) and shown as images. Each diagram is rendered once (by the hash
of its source and theme); the first one starts the browser, which takes a few seconds.
Otherwise, and when mermaid cannot parse the diagram, the block stays code.

## Settings

In `settings.json` (yours or the project's):

```jsonc
{
  "extensions": {
    "mermaid": {
      "mode": "auto",     // "auto": text where there is a layout, pictures for the rest;
                          // "image": pictures wherever possible; "text": never pictures
      "theme": "default"  // for pictures: "default", "neutral", "dark" or "forest"
    }
  }
}
```

## Tests

```sh
bun install
bun run link-amira <path to an Amira checkout>   # after `bun install` there
bun test
```

The text layouts are tested against the expected diagrams, written out in the tests.
