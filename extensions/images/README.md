# images

Images in [Amira](https://github.com/CAMB-dev/Amira)'s replies, drawn in the terminal: an
image that stands on a line of its own (`![chart](out/chart.png)`, maybe inside a link) shows
as the picture, in the inline and the full-screen transcript. Other extensions' images go
through it too, such as diagrams the `mermaid` extension renders.

```sh
amira ext install images
```

Needs Amira extension API 0.1.3 or later (image providers).

## Where it works

Amira decides whether the terminal draws images (`tui.images`: `"auto"`, the default, asks
the terminal; `"on"`, `"off"`) and which protocol it speaks: Sixel (Windows Terminal 1.22+,
xterm, foot, VS Code with `terminal.integrated.enableImages`), the kitty graphics protocol
(kitty, Ghostty, WezTerm) or iTerm2's inline images (iTerm2, WezTerm, VS Code). Amira places
the images, crops them to what is in view and clears them. This extension makes them:

- **Local files**, relative to the session's working directory, absolute, or `file:` URLs on
  this machine. Never a network path (`\\host\share`, `//host`, `\\?\UNC\…`, `\??\…`): Windows
  would connect to that host with your credentials before anything could tell it is not an
  image.
- **http(s) URLs**, downloaded with web_fetch's protection: no loopback, private-network or
  link-local address (every redirect checked, the connection pinned to the checked address),
  image content types only, at most 10 MB, within 10 seconds.
- **PNG, JPEG and GIF** (the first frame) for Sixel and kitty, decoded and scaled here (to
  fit the width and at most 20 rows, 40% of the screen); iTerm2's protocol takes the file as
  it is, **WebP** too.

Decoding and encoding run in a worker, so a large image never stalls typing or scrolling;
two images are read or encoded at a time. An image that fails, or is not ready within 3
seconds in the inline transcript, shows as `🖼️ alt text` (a link to the image where the
terminal supports links), which is what every image shows without this extension.

## Tests

The tests use Amira's extension API and draw what this encodes with Amira's terminal kit, so
they need Amira's packages:

```sh
bun install
bun run link-amira <path to an Amira checkout>   # after `bun install` there
bun test
```
