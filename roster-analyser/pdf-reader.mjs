export async function readPdf(file, { detectStrikes = false } = {}) {
  const pdfjsLib = await import("./vendor/pdfjs/pdf.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "./vendor/pdfjs/pdf.worker.mjs",
    import.meta.url,
  ).href;
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({ data });
  const pages = [];
  try {
    const doc = await loadingTask.promise;
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const items = textContent.items
        .map((item) => {
          const str = item.str.trim();
          return {
            str,
            x: item.transform[4],
            y: item.transform[5],
            width: item.width || 0,
            height: item.height || 0,
          };
        })
        .filter((item) => item.str);
      if (detectStrikes) {
        const operators = await page.getOperatorList();
        markStruckText(items, operators, pdfjsLib.OPS);
      }

      pages.push({
        pageNumber,
        width: viewport.width,
        height: viewport.height,
        items,
        text: items.map((item) => item.str).join(" "),
      });
    }

    return { fileName: file.name, pages };
  } finally {
    await loadingTask.destroy();
  }
}

// This roster export draws strike-throughs as thin filled rectangles in page space.
function markStruckText(items, { fnArray, argsArray }, ops) {
  const transforms = fnArray.flatMap((op, index) => op === ops.transform ? [argsArray[index]] : []);
  if (transforms.length !== 1) return;
  const [sx, skewY, skewX, sy, tx, ty] = transforms[0];
  if (sx <= 0 || sy >= 0 || skewX || skewY) return;
  const bars = [];
  for (let index = 0; index < fnArray.length - 1; index++) {
    if (fnArray[index] !== ops.constructPath || fnArray[index + 1] !== ops.fill) continue;
    const [path, , box] = argsArray[index];
    if (path.length !== 5 || !box) continue;
    const [left, top, right, bottom] = box;
    const thickness = (top - bottom) * sy;
    if (thickness < 0.18 || thickness > 0.35 || (right - left) * sx < 1) continue;
    bars.push({ left: left * sx + tx, right: right * sx + tx, y: bottom * sy + ty });
  }
  for (const item of items) {
    if (bars.some(bar => Math.abs(bar.y - item.y - item.height * 0.2) < 0.16 &&
        Math.min(bar.right, item.x + item.width) - Math.max(bar.left, item.x) > item.width * 0.7)) {
      item.struckOut = true;
    }
  }
}
