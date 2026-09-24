// Dumps a PDF's positioned text runs as JSON — the input statement parsers
// work on (see src/lib/statements/pdfText.ts, which this mirrors). Use it to
// build test fixtures for a new statement format:
//
//   node scripts/pdf-runs.mjs ~/Downloads/statement.pdf "$TMPDIR/runs.json"
//
// Without an output path the JSON goes to stdout. It contains the statement's
// real data: anonymize names, account numbers and amounts consistently before
// committing it as a fixture.
import { readFile, writeFile } from 'node:fs/promises'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const [path, out] = process.argv.slice(2)
if (!path) {
  console.error('usage: node scripts/pdf-runs.mjs <file.pdf> [out.json]')
  process.exit(2)
}

const task = getDocument({ data: new Uint8Array(await readFile(path)) })
const doc = await task.promise
const runs = []
for (let page = 1; page <= doc.numPages; page++) {
  const content = await (await doc.getPage(page)).getTextContent()
  for (const item of content.items) {
    if (!('str' in item) || item.str.trim() === '') continue
    const round = (n) => Math.round(n * 100) / 100
    runs.push({ page, str: item.str, x: round(item.transform[4]), y: round(item.transform[5]), width: round(item.width) })
  }
}
await task.destroy()
const json = JSON.stringify(runs, null, 1) + '\n'
if (out) await writeFile(out, json)
else process.stdout.write(json)
