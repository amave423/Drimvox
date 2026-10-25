/** Drimvox's own skill for PowerPoint decks (docs/specs/catalog.md). */
export const PPTX = `---
name: pptx
description: "When the user wants a presentation (.pptx) made, changed or read: pitch decks, reports, lectures, slides from a document or data"
---

# PowerPoint presentations (.pptx)

Make decks with a library, never by driving PowerPoint (no COM, no \`-ComObject\`: hidden PowerPoint waits for
answers nobody gives).

## Tools

- \`python-pptx\` (Python): slides from layouts, text, pictures, tables, charts, notes.
- \`pptxgenjs\` (Node): good for decks built from scratch with exact positions.
- For pictures of slides (to check them): LibreOffice \`soffice --headless --convert-to pdf deck.pptx\`, then
  \`pdftoppm -png -r 60 deck.pdf slide\`.

## Plan the deck before writing code

1. One idea per slide; a title that says the idea as a sentence ("Выручка выросла на 18 %"), not a topic ("Выручка").
2. 10–15 slides for a 10-minute talk; a title slide, an agenda only for long decks, a closing slide with the ask or the
   next steps.
3. Write the outline (titles plus 2–4 points each) and follow it.

## Making slides

\`\`\`python
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE

prs = Presentation()                      # or Presentation("template.pptx") to keep the user's design
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)   # 16:9

title = prs.slides.add_slide(prs.slide_layouts[0])
title.shapes.title.text = "Итоги третьего квартала"
title.placeholders[1].text = "Отдел продаж · октябрь 2026"

slide = prs.slides.add_slide(prs.slide_layouts[5])   # title only
slide.shapes.title.text = "Выручка выросла на 18 %"
data = CategoryChartData()
data.categories = ["Июль", "Август", "Сентябрь"]
data.add_series("Выручка, млн ₽", (3.1, 3.4, 3.7))
chart = slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(0.8), Inches(1.6), Inches(11.7), Inches(5.2), data).chart
chart.has_legend = False

slide.notes_slide.notes_text_frame.text = "Рост за счёт новых клиентов в регионах."
prs.save("deck.pptx")
\`\`\`

## Rules for slides people can read

- Text at least 20 pt, titles 32–40 pt; at most 6 lines of text on a slide; no paragraphs — what the speaker says goes
  into the notes.
- A grid: the same margins on every slide (about 0.5–0.8 in), elements aligned to it, nothing touching the edges.
- One accent colour plus neutrals; contrast at least 4.5:1; the user's template colours and fonts when there is one.
- Pictures and charts instead of bullet walls: a number big and alone, a chart with its message in the title, a photo
  that fills the slide with a short line on it.
- Charts made as real PowerPoint charts (editable), with units in the title, no 3D, no unnecessary legend.
- A template from the user: use its layouts (\`prs.slide_layouts\`) and placeholders, do not draw over them.

## Changing an existing deck

- Keep the deck's layouts and theme; replace text in placeholders and shapes (\`shape.has_text_frame\`) run by run so the
  formatting stays.
- Reordering slides: move \`prs.slides._sldIdLst\` entries; deleting: drop the id and the relationship.

## Check before saying it is done

1. Reopen the file and list slides with their titles and the kind of content on each.
2. Render the slides to pictures (LibreOffice, see above) and look for text that overflows its box, overlapping shapes,
   tiny text and empty placeholders. Fix and render again.
3. Say where the file is and give the outline in a few lines.
`;
