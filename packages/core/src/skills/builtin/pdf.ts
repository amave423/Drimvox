/** Drimvox's own skill for PDF files (docs/specs/catalog.md). */
export const PDF = `---
name: pdf
description: "When the user wants something done with PDF files: read text or tables, merge, split, rotate, fill forms, make a PDF from a document or a page, OCR a scan"
---

# PDF files

## Tools

- \`pypdf\`: merge, split, rotate, crop, read form fields, fill forms, encrypt, read simple text.
- \`pdfplumber\`: text with its positions and **tables** (\`page.extract_tables()\`); the best reader for reports and invoices.
- \`PyMuPDF\` (\`fitz\`): fast text, pictures out of a PDF, pages rendered to PNG, annotations.
- Making PDFs: from HTML with Playwright (\`page.pdf()\`), which keeps the page's CSS and fonts; from a .docx or .pptx with
  LibreOffice (\`soffice --headless --convert-to pdf file.docx\`); from scratch with \`reportlab\`.
- Scans: OCR with \`ocrmypdf --language rus+eng in.pdf out.pdf\` (needs Tesseract), which adds a text layer.
- Command line when present: \`qpdf\` (merge, split, repair), \`pdftotext -layout\`, \`pdftoppm -png\`.

## Common tasks

\`\`\`python
from pypdf import PdfReader, PdfWriter

# Merge
writer = PdfWriter()
for path in ["a.pdf", "b.pdf"]:
    for page in PdfReader(path).pages:
        writer.add_page(page)
writer.write("merged.pdf")

# Pages 3–5 into their own file (pages count from 0)
reader = PdfReader("big.pdf")
part = PdfWriter()
for i in range(2, 5):
    part.add_page(reader.pages[i])
part.write("pages-3-5.pdf")

# Fill a form
form = PdfReader("form.pdf")
print(form.get_fields().keys())          # the field names first
filled = PdfWriter(clone_from=form)
filled.update_page_form_field_values(filled.pages[0], {"ФИО": "Иванов Иван", "Дата": "25.10.2026"}, auto_regenerate=False)
filled.set_need_appearances_writer(True)
filled.write("form-filled.pdf")
\`\`\`

\`\`\`python
import pdfplumber
with pdfplumber.open("invoice.pdf") as pdf:
    for page in pdf.pages:
        for table in page.extract_tables():
            for row in table:
                print(row)
\`\`\`

\`\`\`python
# HTML to PDF with the page's own styles
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.goto("file:///path/report.html")
    page.pdf(path="report.pdf", format="A4", print_background=True, margin={"top": "2cm", "bottom": "2cm", "left": "2cm", "right": "2cm"})
    browser.close()
\`\`\`

## Rules

- Never overwrite the user's PDF; write a new file next to it with a clear name.
- Text from a PDF comes in reading order only roughly: check columns, headers and footers repeated on each page,
  hyphenated words at line ends.
- No text at all from a page means a scan: OCR it (or say that OCR is needed) instead of guessing.
- Making a document for people: A4, fonts embedded (Playwright and LibreOffice do it), page numbers, a title, links
  that work.
- Encrypted files: ask for the password; never try to break one.

## Check before saying it is done

1. Reopen the result: the number of pages, the first lines of text, the form values (\`get_fields()\`).
2. Render the pages you changed to PNG (\`pdftoppm\` or PyMuPDF \`page.get_pixmap()\`) and look at them when you can see
   pictures.
3. Say where the file is, how many pages it has and what was done.
`;
