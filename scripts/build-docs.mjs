import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FEATURE_HELP } from '../src/feature-help.js';

export const DOC_GUIDES = Object.freeze([
  { source: 'USER_GUIDE.md', page: 'user-guide.html', title: 'User guide' },
  { source: 'FORMATS.md', page: 'formats.html', title: 'File formats' },
  { source: 'STRUCTURE_ANALYSIS.md', page: 'structure-analysis.html', title: 'Analysis implementation' },
  { source: 'VALIDATION.md', page: 'validation.html', title: 'Validation' },
  { source: 'DEPLOYMENT.md', page: 'deployment.html', title: 'Deployment' },
  { source: 'ATOMEYE_REVIEW.md', page: 'atomeye-review.html', title: 'AtomEye implementation review' },
]);

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function safeLink(value) {
  if (/^(?:javascript|data|vbscript):/i.test(value.trim())) return '#';
  const [pathname, fragment] = value.split('#', 2);
  const guide = DOC_GUIDES.find(item => item.source === pathname.split('/').at(-1));
  if (guide) return pathname.slice(0, pathname.length - guide.source.length) + guide.page + (fragment ? `#${fragment}` : '');
  if (pathname.split('/').at(-1) === 'INDEX.md') return pathname.slice(0, -'INDEX.md'.length) + 'index.html' + (fragment ? `#${fragment}` : '');
  if (/\.md$/i.test(pathname)) return pathname.replace(/\.md$/i, '.html') + (fragment ? `#${fragment}` : '');
  return value;
}

function inlineMarkdown(value) {
  const tokens = [];
  const token = html => `\u0000${tokens.push(html) - 1}\u0000`;
  let text = String(value).replace(/`([^`]+)`/g, (_, code) => token(`<code>${escapeHtml(code)}</code>`));
  text = text.replace(/!\[([^\]]*)\]\(([^\s)]+)\)/g, (_, label, url) => token(`<img src="${escapeHtml(safeLink(url))}" alt="${escapeHtml(label)}" loading="lazy">`));
  text = text.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_, label, url) => {
    const external = /^https?:/i.test(url);
    return token(`<a href="${escapeHtml(safeLink(url))}"${external ? ' target="_blank" rel="noopener"' : ''}>${inlineMarkdown(label)}</a>`);
  });
  text = text.replace(/<(https?:\/\/[^>]+)>/g, (_, url) => token(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`));
  text = escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)]);
}

/** A deliberately small, escaped Markdown renderer for checked-in documentation. */
export function renderMarkdown(markdown) {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const html = [];
  const headingIds = new Map();
  let index = 0;
  const isBlock = line => /^(?:#{1,6}\s|\s*```|\s*[-*]\s|\s*\d+[.)]\s|>\s|\|)/.test(line);
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = line.match(/^\s*```([^\s]*)/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index++]);
      index += 1;
      html.push(`<pre><code${fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      const base = heading[2].replace(/[`*_]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section';
      const count = headingIds.get(base) ?? 0;
      headingIds.set(base, count + 1);
      const id = count ? `${base}-${count}` : base;
      html.push(`<h${heading[1].length} id="${escapeHtml(id)}">${inlineMarkdown(heading[2])}</h${heading[1].length}>`);
      index += 1;
      continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { html.push('<hr>'); index += 1; continue; }
    if (/^\|/.test(line) && /^\|?[\s:|-]+\|\s*$/.test(lines[index + 1] ?? '')) {
      const cells = value => value.trim().replace(/^\||\|$/g, '').split('|').map(item => inlineMarkdown(item.trim()));
      const header = cells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && /^\|/.test(lines[index])) rows.push(cells(lines[index++]));
      html.push(`<div class="table-scroll"><table><thead><tr>${header.map(cell => `<th>${cell}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const item = line.match(/^\s*(?:([-*])|(\d+)[.)])\s+(.+)$/);
    if (item) {
      const ordered = Boolean(item[2]);
      const items = [];
      while (index < lines.length) {
        const next = lines[index].match(/^\s*(?:([-*])|(\d+)[.)])\s+(.+)$/);
        if (!next || Boolean(next[2]) !== ordered) break;
        const content = [next[3]];
        index += 1;
        while (index < lines.length && lines[index].trim() && !isBlock(lines[index])) content.push(lines[index++].trim());
        items.push(`<li>${inlineMarkdown(content.join(' '))}</li>`);
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ''));
      html.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlock(lines[index])) paragraph.push(lines[index++].trim());
    html.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
  }
  return html.join('\n');
}

function pageTemplate({ title, body, page, guides }) {
  const prefix = page.startsWith('features/') ? '../' : './';
  const back = page.startsWith('features/') ? '../../' : '../';
  const link = (path, label) => `<a href="${prefix}${path}"${page === path ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`;
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="AlloyView documentation: ${escapeHtml(title)}">
  <title>${escapeHtml(title)} · AlloyView documentation</title>
  <link rel="stylesheet" href="${prefix}styles.css">
  <script>try { const saved = localStorage.getItem('alloyview-theme'); document.documentElement.dataset.theme = saved === 'dark' || saved === 'light' ? saved : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch {}</script>
</head>
<body>
  <header class="docs-header"><a class="docs-brand" href="${back}">Alloy<span>View</span></a><span class="docs-label">Documentation</span><div class="docs-header-actions"><a href="https://github.com/Yazhuo-Liu/AlloyView" target="_blank" rel="noopener">GitHub</a><button id="docs-theme" type="button" aria-label="Switch color theme">Theme</button></div></header>
  <div class="docs-layout"><nav class="docs-nav" aria-label="Documentation navigation">
    <p>Start here</p>${link('index.html', 'Overview')}${guides.slice(0, 2).map(item => link(item.page, item.title)).join('')}
    <p>Features</p>${Object.values(FEATURE_HELP).map(item => link(`features/${item.page}.html`, item.title)).join('')}
    <p>Development</p>${guides.slice(2).map(item => link(item.page, item.title)).join('')}
  </nav><main class="docs-content" id="content">${body}<footer>AlloyView · By Yazhuo Liu and Ting Zhu at Georgia Tech · <a href="${back}">Open the viewer</a></footer></main></div>
  <script>
    const button = document.getElementById('docs-theme');
    function updateThemeLabel() { button.textContent = document.documentElement.dataset.theme === 'dark' ? 'Light mode' : 'Dark mode'; }
    button.addEventListener('click', () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; try { localStorage.setItem('alloyview-theme', theme); } catch {} updateThemeLabel(); });
    addEventListener('storage', event => { if (event.key === 'alloyview-theme' && ['light', 'dark'].includes(event.newValue)) { document.documentElement.dataset.theme = event.newValue; updateThemeLabel(); } });
    updateThemeLabel();
  </script>
</body></html>`;
}

/** Render in memory for both the static build and the development server. */
export async function createDocumentationPages(root) {
  const directory = resolve(root, 'docs');
  const pages = new Map();
  const guides = [];
  for (const guide of DOC_GUIDES) {
    try {
      const markdown = await readFile(resolve(directory, guide.source), 'utf8');
      guides.push({ ...guide, markdown });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const index = await readFile(resolve(directory, 'INDEX.md'), 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '# AlloyView documentation\n\nChoose a feature from the navigation to read its controls, algorithms and implementation.';
  });
  pages.set('index.html', pageTemplate({ title: 'Overview', body: renderMarkdown(index), page: 'index.html', guides }));
  for (const guide of guides) pages.set(guide.page, pageTemplate({ title: guide.title, body: renderMarkdown(guide.markdown), page: guide.page, guides }));
  for (const feature of Object.values(FEATURE_HELP)) {
    const page = `features/${feature.page}.html`;
    const markdown = await readFile(resolve(directory, 'features', `${feature.page}.md`), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return `# ${feature.title}\n\n${feature.summary}`;
    });
    pages.set(page, pageTemplate({ title: feature.title, body: renderMarkdown(markdown), page, guides }));
  }
  pages.set('styles.css', await readFile(resolve(directory, 'site.css'), 'utf8'));
  return pages;
}

export async function buildDocumentation(root, destination) {
  const pages = await createDocumentationPages(root);
  for (const [page, content] of pages) {
    const path = resolve(destination, page);
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, content);
  }
  return { pages: pages.size - 1 };
}
