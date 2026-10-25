/** Drimvox's own skill for Word documents (docs/specs/catalog.md). */
export const DOCX = `---
name: docx
description: "When the user wants a Word document (.docx) made, filled in from a template, edited or read: reports, letters, contracts, CVs, forms"
---

# Word documents (.docx)

Make and change Word files with a library, never by driving Word itself: no COM, no \`New-Object -ComObject\`,
no AppleScript. A hidden Word window waits for answers nobody can give, and the command hangs.

## Tools

- Python: \`python-docx\` (\`pip install python-docx\`). Reads and writes paragraphs, runs, styles, tables, pictures,
  sections, headers and footers.
- Node: \`docx\` (\`npm install docx\`) to make new files; \`mammoth\` to read one as HTML or text.
- Reading only: \`python-docx\` for structure, or \`pandoc file.docx -t markdown\` when pandoc is installed.
- Install into the project or a virtual environment (\`python -m venv .venv\`), never system-wide without asking.

## Making a document

\`\`\`python
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()
section = doc.sections[0]
section.page_height, section.page_width = Cm(29.7), Cm(21.0)   # A4
section.left_margin = section.right_margin = Cm(2.5)
section.top_margin = section.bottom_margin = Cm(2)

normal = doc.styles["Normal"]
normal.font.name = "Calibri"
normal.font.size = Pt(11)

doc.add_heading("Отчёт за квартал", level=0)
doc.add_heading("Итоги", level=1)
p = doc.add_paragraph("Выручка выросла на ")
p.add_run("18 %").bold = True
p.add_run(" к прошлому кварталу.")

for item in ["Новые клиенты: 42", "Возвраты: 3"]:
    doc.add_paragraph(item, style="List Bullet")

table = doc.add_table(rows=1, cols=3, style="Light Grid Accent 1")
for cell, text in zip(table.rows[0].cells, ["Месяц", "Выручка", "Расходы"]):
    cell.text = text
for row in [("Январь", "1 200 000", "800 000"), ("Февраль", "1 350 000", "820 000")]:
    cells = table.add_row().cells
    for cell, text in zip(cells, row):
        cell.text = text

doc.add_picture("chart.png", width=Cm(15))
doc.add_page_break()
doc.save("report.docx")
\`\`\`

## Rules that make a document look right

- Structure with real styles: \`Title\`, \`Heading 1–3\`, \`List Bullet\`, \`List Number\`, table styles. Never fake headings
  with bold text or lists with dashes and spaces: the navigation pane, the table of contents and screen readers use styles.
- Page: A4 for Russian and European documents, Letter for American ones; margins 2–2.5 cm; one font family; body 11–12 pt,
  line spacing 1.15–1.5.
- Numbers in tables right-aligned, the header row repeated on each page
  (\`row._tr.get_or_add_trPr()\` with \`w:tblHeader\`), widths set so text does not wrap word by word.
- Pictures with a width in centimetres that fits the page (at most page width minus margins), a caption under each.
- Headers and footers: \`section.header.paragraphs[0].text = ...\`; page numbers need a PAGE field (\`w:fldSimple\`).
- Dates, money and numbers in the user's format (12 500,00 ₽; 25.10.2026 for Russian).

## Filling in a template

- Open the user's file with \`Document("template.docx")\` and keep its styles: add content with the template's style names.
- Placeholders such as \`{{name}}\` are often split across several runs. Join the runs of a paragraph, replace, then put
  the text back into the first run and clear the others, so the formatting of the first run stays.
- For many similar documents (letters to a list), render one per row from a CSV or an Excel sheet, named by the row.
- \`docxtpl\` (Jinja templates inside Word) is a good choice when the user wants loops and conditions in the template.

## Editing an existing document

- Change only what was asked; keep everything else byte for byte where possible (styles, numbering, comments).
- Find text by walking \`doc.paragraphs\` and every table's cells (\`table.rows[i].cells[j].paragraphs\`), headers and footers.
- Tracked changes and comments are not supported by python-docx; if the user needs them, say so and offer a list of the
  changes instead, or edit the XML (\`w:ins\`, \`w:del\`) carefully.

## Check before saying it is done

1. Open the saved file again with python-docx and list what is in it: headings in order, the number of tables and their
   first rows, pictures, sections. Compare with what the user asked for.
2. If LibreOffice is installed, convert to PDF (\`soffice --headless --convert-to pdf report.docx\`) and look at the pages
   (render the first pages to PNG with \`pdftoppm\` and look at them when you can see pictures).
3. Say where the file is and what is in it in a few lines.
`;
