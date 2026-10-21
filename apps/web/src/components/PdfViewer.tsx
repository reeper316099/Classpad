import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { useEffect, useRef, useState } from 'react';
import { attachmentBytes } from '../lib/attachments.js';
import { Icon } from './Icon.js';

/** Bundled pdf.js (no CDN). Loaded lazily the first time a PDF is opened. */
export function PdfViewer({
  hash,
  name,
  onClose,
}: {
  hash: string;
  name: string;
  onClose: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    let loading: PDFDocumentLoadingTask | null = null;
    setDoc(null);
    setPage(1);
    setError('');
    (async () => {
      try {
        const [pdfjs, worker, data] = await Promise.all([
          import('pdfjs-dist'),
          import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
          attachmentBytes(hash),
        ]);
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const task = pdfjs.getDocument({ data });
        loading = task;
        const loaded = await task.promise;
        if (live) setDoc(loaded);
      } catch (e) {
        if (live) setError((e as Error).message || 'Could not open this PDF');
      }
    })();
    return () => {
      live = false;
      void loading?.destroy();
    };
  }, [hash]);

  useEffect(() => {
    if (!doc || !canvas.current || !wrap.current) return;
    let task: RenderTask | null = null;
    let cancelled = false;
    (async () => {
      const p = await doc.getPage(page);
      const base = p.getViewport({ scale: 1 });
      const fit = Math.max(200, (wrap.current?.clientWidth ?? 500) - 24) / base.width;
      const viewport = p.getViewport({ scale: fit * zoom });
      const ratio = window.devicePixelRatio || 1;
      const c = canvas.current;
      if (!c || cancelled) return;
      c.width = Math.floor(viewport.width * ratio);
      c.height = Math.floor(viewport.height * ratio);
      c.style.width = `${Math.floor(viewport.width)}px`;
      c.style.height = `${Math.floor(viewport.height)}px`;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      task = p.render({
        canvas: c,
        canvasContext: ctx,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      await task.promise.catch(() => undefined);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, zoom]);

  const pages = doc?.numPages ?? 0;
  return (
    <section className="pdf-pane" aria-label={`PDF: ${name}`}>
      <div className="row tight pdf-bar">
        <b
          className="grow"
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={name}
        >
          {name}
        </b>
        <button
          className="btn ghost sm icon"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          <Icon name="chevron" style={{ transform: 'rotate(180deg)' }} size={16} />
        </button>
        <span className="small">{pages ? `${page} / ${pages}` : '–'}</span>
        <button
          className="btn ghost sm icon"
          aria-label="Next page"
          disabled={page >= pages}
          onClick={() => setPage((p) => p + 1)}
        >
          <Icon name="chevron" size={16} />
        </button>
        <button
          className="btn ghost sm"
          aria-label="Zoom out"
          onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}
        >
          −
        </button>
        <button
          className="btn ghost sm"
          aria-label="Zoom in"
          onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))}
        >
          +
        </button>
        <button className="btn ghost sm icon" aria-label="Close PDF" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="pdf-scroll" ref={wrap}>
        {error ? (
          <div className="badge danger">{error}</div>
        ) : !doc ? (
          <div className="skeleton" style={{ height: 300 }} />
        ) : (
          <canvas ref={canvas} aria-label={`Page ${page} of ${name}`} />
        )}
      </div>
    </section>
  );
}
