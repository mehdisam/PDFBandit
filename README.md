# PDFBandit

**Fix/Translate PDFs, your way.**

PDFBandit is a local-first, browser-based PDF editor for mapping a page once, then translating it, rebuilding it, or adding a selectable text layer. It runs without a build step and without a PDFBandit backend. The source PDF is never modified.

## Features

- **Translate in place** — map text regions and translate them into a target-language content variant.
- **Make PDFs selectable** — extract source text or run on-device OCR, then export a copy with an invisible selectable text layer.
- **One map, many variants** — keep a shared `.pmap` structure and a separate `.content.json` file per language or working copy.
- **Find & replace** — search the loaded Translate or Improve content across all pages, with optional regular expressions and case matching; replacements keep character formatting and land as one undo step.
- **Proposal-only detection** — detected regions remain proposals until reviewed; nothing is silently overwritten.
- **Local-first storage** — the PDF, map, and variants stay in the browser (IndexedDB) and survive refreshes.
- **On-device OCR** — Tesseract.js runs lazily in the browser and never writes placeholder text when it fails.
- **Reconstructed and digitalized export** — export the edited page or add a searchable text layer to the original.
- **RTL and contextual editing** — text boxes, tables, alignment, and direction controls are built into the editor.

## Project layout

```text
.
├── pdfbandit/            # the editor (runtime source)
│   ├── index.html
│   ├── assets/
│   ├── src/
│   └── tools/            # Node tests and migration CLI
├── site/                 # public landing page and legal pages
│   ├── index.html
│   ├── privacy.html
│   ├── terms.html
│   └── assets/
├── LICENSE
└── README.md
```

## Run locally

Start a static server from the app folder:

```bash
cd pdfbandit
python3 -m http.server 8901
```

Then open <http://127.0.0.1:8901/>.

## How the editor stores a project

A project is two files:

- a shared `document.pmap` map containing pages, region IDs, polygons, and locks;
- one `document.<language>.content.json` variant containing backgrounds and content items keyed by region ID.

The same map can back many variants. Use **File ▸ Save map** and **File ▸ Save content** to write the two halves independently, or **Ctrl/Cmd+S** to save the active pair. The PDF is never overwritten.

## Privacy

PDFBandit does not upload your PDF to a PDFBandit server. OCR and extraction run on-device. Optional translation sends text only to the provider you choose. See the full [Privacy Policy](./site/privacy.html) and [Terms of Use](./site/terms.html).

## Contributing

- Use [GitHub Discussions](https://github.com/mehdisam/PDFBandit/discussions/) for questions and ideas.
- Use [GitHub Issues](https://github.com/mehdisam/PDFBandit/issues) for reproducible bugs.
- Keep changes consistent with the existing dependency-free, no-build-step style.
- Run `npm test` before opening a pull request.
- Do not commit private documents, credentials, generated `dist/`, or the internal `doc/` directory.

## License

Copyright 2026 PDFBandit.

Licensed under the [Apache License, Version 2.0](./LICENSE). You may use, modify, and distribute the source under that license.
