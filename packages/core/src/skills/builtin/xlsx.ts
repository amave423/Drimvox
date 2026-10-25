/** Drimvox's own skill for Excel workbooks (docs/specs/catalog.md). */
export const XLSX = `---
name: xlsx
description: "When the user wants an Excel workbook (.xlsx, .csv) made, filled, cleaned, analysed or read: tables, budgets, reports with formulas and charts"
---

# Excel workbooks (.xlsx)

Work with spreadsheets through libraries, never by driving Excel (no COM, no \`-ComObject\`: a hidden Excel window
waits for answers nobody gives).

## Tools

- \`openpyxl\` (Python): formulas, formatting, charts, freezing, filters, data validation. The default choice.
- \`pandas\` (with openpyxl): reading, cleaning, grouping and summing data; write the result, then format it with openpyxl.
- Node: \`exceljs\` to make and format workbooks; \`xlsx\` (SheetJS) to read many formats.
- Install into the project or a virtual environment.

## Making a workbook people can work with

\`\`\`python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.chart import BarChart, Reference

wb = Workbook()
ws = wb.active
ws.title = "Бюджет"
ws.append(["Статья", "План", "Факт", "Отклонение"])
rows = [("Аренда", 120000, 120000), ("Реклама", 50000, 63500), ("Зарплаты", 900000, 910000)]
for i, (name, plan, fact) in enumerate(rows, start=2):
    ws.append([name, plan, fact, f"=C{i}-B{i}"])
last = len(rows) + 1
ws.append(["Итого", f"=SUM(B2:B{last})", f"=SUM(C2:C{last})", f"=SUM(D2:D{last})"])

header = Font(bold=True, color="FFFFFF")
for cell in ws[1]:
    cell.font = header
    cell.fill = PatternFill("solid", fgColor="2B4C7E")
    cell.alignment = Alignment(horizontal="center", vertical="center")
for row in ws.iter_rows(min_row=2, min_col=2, max_col=4):
    for cell in row:
        cell.number_format = '#,##0 ₽;[Red]-#,##0 ₽'
for cell in ws[last + 1]:
    cell.font = Font(bold=True)
    cell.border = Border(top=Side(style="thin"))

widths = [24, 14, 14, 14]
for i, w in enumerate(widths, start=1):
    ws.column_dimensions[get_column_letter(i)].width = w
ws.freeze_panes = "A2"
ws.auto_filter.ref = f"A1:D{last}"

chart = BarChart()
chart.title = "План и факт"
chart.add_data(Reference(ws, min_col=2, max_col=3, min_row=1, max_row=last), titles_from_data=True)
chart.set_categories(Reference(ws, min_col=1, min_row=2, max_row=last))
ws.add_chart(chart, "F2")
wb.save("budget.xlsx")
\`\`\`

## Rules

- Keep values as numbers and dates, not text: \`1200\` not \`"1 200"\`, a \`datetime\` not \`"25.10.2026"\`. Show them with
  number formats (\`#,##0.00\`, \`0%\`, \`DD.MM.YYYY\`).
- Write formulas where the user will change inputs (totals, differences, percentages), so the workbook stays alive.
  Constants that drive formulas (a rate, a tax) go into labelled cells, referenced absolutely (\`$B$1\`).
- One table per sheet, starting at A1, one header row, no merged cells inside data (they break sorting and filters).
- Header formatted, frozen (\`freeze_panes = "A2"\`), filter on, column widths set to the content.
- Sheet names short and meaningful; a "Сводка" (summary) sheet first when there are several.
- Colour only to mean something (negative in red, inputs in a light fill), never decoration.
- CSV for other programs: UTF-8 with BOM (\`encoding="utf-8-sig"\`) and a semicolon for Russian Excel, or ask.

## Reading and cleaning

- \`pd.read_excel(path, sheet_name=None)\` reads every sheet; look at the first rows and the types before changing anything.
- Find the real header row (reports often have a title above it), drop empty rows and columns, normalise spaces, parse
  numbers written with spaces and commas, parse dates with \`dayfirst=True\` for Russian files.
- Never overwrite the user's file: write \`name (cleaned).xlsx\` next to it unless asked otherwise.

## Check before saying it is done

1. Open the saved workbook again (\`load_workbook(path)\`) and list sheets, header rows, the number of data rows, formulas
   in the totals. openpyxl does not compute formulas: when the values matter, compute them in Python too and compare, or
   recalculate with LibreOffice (\`soffice --headless --convert-to xlsx\`) and read with \`data_only=True\`.
2. Look for \`#REF!\`, \`#DIV/0!\`, \`#NAME?\` after a recalculation.
3. Say where the file is, what each sheet holds and which cells the user should change.
`;
