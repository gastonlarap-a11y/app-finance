// pdf.js adapter: the only module that touches pdfjs-dist. It is loaded with a
// dynamic import by the import screen, so the (large) library and its worker
// stay out of the main bundle until a statement is actually opened.
import * as pdfjs from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { TextRun } from '@/lib/statements/layout'

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc

// Keep in sync with frontend/scripts/pdf-runs.mjs (the Node fixture dumper).
function isTextItem(item: object): item is { str: string; transform: number[]; width: number } {
  return 'str' in item && 'transform' in item
}

// extractRuns reads every page's text runs with their position. transform is
// the run's text matrix [a, b, c, d, e, f]: e/f are its x/y in page space.
export async function extractRuns(data: ArrayBuffer): Promise<TextRun[]> {
  const task = pdfjs.getDocument({ data: new Uint8Array(data) })
  try {
    const doc = await task.promise
    const runs: TextRun[] = []
    for (let page = 1; page <= doc.numPages; page++) {
      const content = await (await doc.getPage(page)).getTextContent()
      for (const item of content.items) {
        if (!isTextItem(item)) continue
        // pdf.js types the matrix as any[]; it is always six numbers.
        const matrix = item.transform as number[]
        runs.push({ page, str: item.str, x: matrix[4] ?? 0, y: matrix[5] ?? 0, width: item.width })
      }
    }
    return runs
  } finally {
    // Frees the document and its worker-side resources, even on failure.
    await task.destroy()
  }
}
