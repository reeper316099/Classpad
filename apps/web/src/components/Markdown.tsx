import 'katex/dist/katex.min.css';
import { useQuery } from '@tanstack/react-query';
import { Children, isValidElement, useEffect, useState, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { get } from '../lib/api.js';
import { attachmentBlobUrl, parseAttachmentLink } from '../lib/attachments.js';
import { remarkToggles } from '../lib/remarkToggles.js';
import { parseWikiHref, remarkWikiLinks } from '../lib/remarkWikiLinks.js';

export const slugHeading = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
const textOf = (n: ReactNode): string =>
  Children.toArray(n)
    .map((c) =>
      typeof c === 'string' || typeof c === 'number'
        ? String(c)
        : isValidElement(c)
          ? textOf((c.props as { children?: ReactNode }).children)
          : '',
    )
    .join('');

/** Only http(s)/mailto, relative and our own attachment:/wiki: links survive; everything else (javascript:, data:, vbscript:…) is dropped. */
export const urlTransform = (url: string) =>
  /^(attachment|wiki):/i.test(url) ? url : defaultUrlTransform(url);

function AttachmentImage({ href, alt }: { href: string; alt?: string }) {
  const a = parseAttachmentLink(href);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!a) return;
    let live = true;
    attachmentBlobUrl(a.hash).then(
      (u) => live && setSrc(u),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [a?.hash]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!a || failed)
    return <span className="badge warning">Missing image{alt ? `: ${alt}` : ''}</span>;
  return src ? (
    <img src={src} alt={alt ?? ''} loading="lazy" />
  ) : (
    <span className="skeleton" style={{ display: 'inline-block', width: 120, height: 80 }} />
  );
}

export interface MarkdownHandlers {
  onWikiLink?: (target: string, heading?: string) => void;
  onOpenAttachment?: (hash: string, ext: string, name: string) => void;
}

function WikiLink({
  href,
  children,
  onWikiLink,
}: {
  href: string;
  children: ReactNode;
  onWikiLink?: MarkdownHandlers['onWikiLink'];
}) {
  const w = parseWikiHref(href)!;
  const { data } = useQuery({
    queryKey: ['wiki-resolve', w.target],
    queryFn: () =>
      get<{ id: string } | null>(`/notes/resolve?title=${encodeURIComponent(w.target)}`),
    staleTime: 30_000,
  });
  return (
    <a
      href="#"
      className={`wikilink ${data === null ? 'missing' : ''}`}
      title={data === null ? `No note called “${w.target}” yet` : w.target}
      onClick={(e) => {
        e.preventDefault();
        onWikiLink?.(w.target, w.heading);
      }}
    >
      {children}
    </a>
  );
}

/** A fenced code block with its language and a copy button. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = (Array.isArray(children) ? children[0] : children) as
    { props?: { className?: string; children?: ReactNode } } | undefined;
  const lang = /language-([\w+#-]+)/.exec(code?.props?.className ?? '')?.[1];
  const copy = () => {
    void navigator.clipboard
      ?.writeText(textOf(code?.props?.children).replace(/\n$/, ''))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => null);
  };
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="muted small">{lang && lang !== 'math' ? lang : 'code'}</span>
        <button type="button" className="btn ghost sm" onClick={copy} aria-label="Copy code">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

export function Markdown({
  source,
  onWikiLink,
  onOpenAttachment,
}: { source: string } & MarkdownHandlers) {
  const components: Components = {
    a({ href = '', children }) {
      if (parseWikiHref(href))
        return (
          <WikiLink href={href} onWikiLink={onWikiLink}>
            {children}
          </WikiLink>
        );
      const att = parseAttachmentLink(href);
      if (att)
        return (
          <a
            href="#"
            className="attachment-link"
            onClick={(e) => {
              e.preventDefault();
              onOpenAttachment?.(att.hash, att.ext, textOf(children) || att.name);
            }}
          >
            {children}
          </a>
        );
      if (/^(https?:|mailto:)/i.test(href))
        return (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      return <span>{children}</span>; // relative or unknown targets are not navigable
    },
    pre({ children }) {
      return <CodeBlock>{children}</CodeBlock>;
    },
    img({ src = '', alt }) {
      if (parseAttachmentLink(src)) return <AttachmentImage href={src} alt={alt} />;
      return (
        <span className="badge" title="Remote images are never loaded">
          Image not loaded: {alt || 'remote image'}
        </span>
      ); // no remote content
    },
    ...Object.fromEntries(
      ([1, 2, 3, 4, 5, 6] as const).map((n) => [
        `h${n}`,
        ({ children }: { children?: ReactNode }) => {
          const Tag = `h${n}` as 'h1';
          return <Tag id={`h-${slugHeading(textOf(children))}`}>{children}</Tag>;
        },
      ]),
    ),
  };
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkWikiLinks, remarkToggles]}
        rehypePlugins={[
          [rehypeKatex, { throwOnError: false, strict: 'ignore', trust: false, maxExpand: 200 }],
          [rehypeHighlight, { detect: false, ignoreMissing: true }],
        ]}
        urlTransform={urlTransform}
        components={components}
        skipHtml
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
