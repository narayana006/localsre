---
name: documents
description: Read and extract text from PDF, DOCX, DOC, RTF, ODT, and HTML documents.
---
# Reading documents

For any binary document, use the `read_document` tool (NOT `read_file`). It handles PDF, DOCX, DOC, RTF, ODT, HTML.

- Office/RTF files use macOS `textutil` (built in).
- PDFs use `pdftotext` (poppler) or `pypdf`, auto-installed if missing.

If extraction fails or returns nothing:
- Install a PDF backend: `brew install poppler`  (or `pip install pypdf`), then retry.
- Scanned / image-only PDF → needs OCR: `brew install tesseract ocrmypdf`, then
  `ocrmypdf <in>.pdf <out>.pdf` and `read_document` the output.

## Screenshots / images
`read_document` also OCRs images (.png/.jpg/etc) via `tesseract` (`brew install tesseract` if missing).
This reads the TEXT in the image (error messages, logs, stack traces) — useful for "here's a screenshot of my error".
IMPORTANT: the model is text-only and cannot SEE the picture/layout — OCR only recovers the words.

After extracting, pull out exactly the information the user asked for and summarize it — don't dump the whole document back.
