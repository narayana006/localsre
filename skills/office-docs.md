---
name: office-docs
description: CREATE PowerPoint (.pptx), Word (.docx), Excel (.xlsx), and PDF files programmatically with Python.
---
# Creating documents (PPTX / DOCX / XLSX / PDF)

To READ documents, use the `read_document` tool. To CREATE them: install the library (see python-env), `write_file` a generator script, then `run_command` `python3 gen.py`, and verify the file exists.

## PowerPoint (.pptx) — python-pptx
`pip install python-pptx`
```python
from pptx import Presentation
from pptx.util import Inches, Pt
p = Presentation()
s = p.slides.add_slide(p.slide_layouts[0]); s.shapes.title.text = "Title"; s.placeholders[1].text = "Subtitle"
b = p.slides.add_slide(p.slide_layouts[1]); b.shapes.title.text = "Agenda"
tf = b.placeholders[1].text_frame; tf.text = "First point"; tf.add_paragraph().text = "Second point"
p.save("out.pptx")
```

## Word (.docx) — python-docx
`pip install python-docx`
```python
from docx import Document
d = Document(); d.add_heading("Title", 0); d.add_paragraph("Body text")
d.add_heading("Section", level=1); d.add_paragraph("a bullet", style="List Bullet")
t = d.add_table(rows=1, cols=2); t.rows[0].cells[0].text = "A"; t.rows[0].cells[1].text = "B"
d.save("out.docx")
```

## Excel (.xlsx) — openpyxl
`pip install openpyxl`
```python
from openpyxl import Workbook
wb = Workbook(); ws = wb.active; ws.append(["name", "value"]); ws.append(["x", 1]); wb.save("out.xlsx")
```

## PDF
- From scratch: `pip install reportlab` (or `fpdf2`) and flow content onto a canvas.
- From Markdown/HTML (easiest for reports): `brew install pandoc` then `pandoc report.md -o report.pdf` (PDF needs a LaTeX engine: `brew install basictex`). For HTML→PDF: `pip install weasyprint`.
- DOCX → PDF: `pandoc in.docx -o out.pdf`.

Workflow: install lib (python-env/homebrew) → write generator script → run it → confirm the output file. Then open or report the path.
