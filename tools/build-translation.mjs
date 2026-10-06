/**
 * 把 docs/ 下的中英对照译文构建成独立网页。
 *
 * 版式沿用 tools/build-page.mjs 的阮一峰风格：
 *   米黄底 #f5f5d5 · Georgia 衬线 · 正文左灰线 · 行内代码粉底
 * 对照部分：中文正文，英文原文走 blockquote（灰底、缩小）。
 *
 * 用法：node tools/build-translation.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { marked } from 'marked'
import { createHighlighter } from 'shiki'

const ROOT = new URL('..', import.meta.url).pathname
const DOCS = join(ROOT, 'docs')
const THEME = 'min-light'

const highlighter = await createHighlighter({ themes: [THEME], langs: ['bash', 'javascript', 'json'] })

marked.use({
  renderer: {
    code({ text, lang }) {
      const language = highlighter.getLoadedLanguages().includes(lang) ? lang : 'text'
      return `<div class="codeblock">${highlighter.codeToHtml(text, { lang: language, theme: THEME })}</div>`
    },
  },
})

/** 每份文档 → 一个页面 */
const docs = readdirSync(DOCS)
  .filter((n) => n.endsWith('.md') && n.includes('中英对照'))
  .sort()

// 网页文件名用 ASCII，避免 URL 里出现百分号编码
const SLUGS = { 'muse-安全博客-中英对照.md': 'muse-safety-blog-zh' }

const pages = docs.map((file) => {
  const md = readFileSync(join(DOCS, file), 'utf8')
  const title = md.match(/^#\s+(.+)$/m)?.[1] ?? file
  const slug = SLUGS[file] ?? file.replace(/\.md$/, '')
  return { file, title, slug, html: marked.parse(md) }
})

const css = `
html { font-size: 62.5%; }
body {
  margin: 0; padding: 0; background-color: #f5f5d5;
  font-family: Georgia, "Songti SC", "SimSun", serif;
  letter-spacing: -0.01em; word-spacing: .2em;
  line-height: 1.8em; color: #111;
}
#container { width: 68%; min-width: 640px; max-width: 900px; margin: 0 auto; padding: 1em 1em 6em 1em; }
header.site { border-bottom: 1px solid #d3d3d3; padding-bottom: .6em; margin-bottom: 1.6em; }
header.site h1 { font-size: 2.4em; font-weight: 500; margin: .6em 0 .2em 0; letter-spacing: -0.03em; }
header.site h1 a { color: #567; text-decoration: none; }
header.site .sub { font-size: 1.4em; color: #567; }
header.site nav { font-size: 1.4em; margin-top: .6em; }
header.site nav a { color: #567; text-decoration: underline; }
article { margin-left: 1em; padding-left: .4em; border-left: .4em solid gray; }
article h1 {
  font-size: 2.4em; font-weight: 500; letter-spacing: -0.03em; color: #000;
  margin: .4em 0 1em 0; padding: 0 0 .2em 0; border-bottom: 1px solid #d3d3d3; line-height: 1.4em;
}
article h2 {
  font-size: 1.9em; font-weight: 500; letter-spacing: -0.03em; color: #000;
  margin: 2em 0 .4em 0; padding: 0 0 .2em 0; border-bottom: 1px solid #d3d3d3;
}
article h3 { font-size: 1.6em; font-weight: 500; margin: 1.4em 0 .2em 0; }
article p { font-size: 1.6em; line-height: 190%; margin: 1em 0 0 .8em; }
article p code {
  display: inline-block; padding: 0 5px; font-size: 120%;
  font-family: Consolas, Monaco, monospace; background-color: pink; border-radius: 5px; margin: auto 3px;
}
article a { color: #223472; text-decoration: underline; }
article a:hover { color: #d03500; }
article ul, article ol { font-size: 1.5em; line-height: 185%; margin: .8em 0 0 2.2em; }
article ul li { list-style-type: square; margin-bottom: .3em; }
article ol li { list-style-type: decimal; }
article hr { border: 0; border-top: 1px solid #d3d3d3; margin: 2.6em 0 0 .8em; }

/* 英文原文：灰底、缩小、左侧无缩进，和中文正文区分开 */
article blockquote {
  background-color: #efeede;
  border-left: .3em solid #cfceba;
  padding: .7em 1.1em;
  margin: .5em 0 1.2em 1.4em;
  border-radius: .4em;
  font-size: 1.25em;
  line-height: 175%;
  color: #4a4a42;
  letter-spacing: 0;
  word-spacing: 0;
}
article blockquote p { font-size: 100%; margin: 0 0 .4em 0; }
article blockquote p:last-child { margin-bottom: 0; }
article blockquote h2, article blockquote h3 {
  font-size: 100%; font-weight: 500; border: none; margin: 0; padding: 0; color: #4a4a42;
}
.codeblock { margin: 1.2em .8em; }
.codeblock pre { background: #f5f2f0 !important; padding: .8em 1em; border-radius: .6em; overflow-x: auto; }
.codeblock code { font-family: Consolas, Monaco, monospace; font-size: 1.35em; line-height: 1.7; }

footer { border-top: 1px solid #d3d3d3; margin-top: 4em; padding-top: 1.2em; font-size: 1.35em; color: gray; }
footer a { color: gray; }

@media (max-width: 720px) {
  #container { width: 94%; min-width: 0; }
  article { margin-left: .4em; }
  article p, article blockquote { margin-left: .4em; }
}
`

const nav = pages
  .map((p) => `<a href="${p.slug}.html">${p.title}</a>`)
  .join(' · ')

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meta Muse 安全架构 · 中英对照</title>
<style>${css}</style>
</head>
<body>
<div id="container">
  <header class="site">
    <h1><a href="index.html">Muse 架构剖析</a></h1>
    <div class="sub">官方材料 · 中英对照</div>
    <nav>${nav} · <a href="index.html">返回章节</a></nav>
  </header>
  ${pages
    .map(
      (p, i) => `
  <article id="doc-${i}">
${p.html.replace(/^<h1[^>]*>.*?<\/h1>\s*/s, `<h1>${p.title}</h1>`)}
  </article>`,
    )
    .join('\n')}
  <footer>
    英文原文与中文译文逐段对照。原文版权归 Meta 所有，此处仅作学习用途。
  </footer>
</div>
</body>
</html>`

for (const p of pages) {
  writeFileSync(join(ROOT, `${p.slug}.html`), html)
}
console.log(`生成 ${pages.length} 个页面: ${pages.map((p) => p.slug + '.html').join(', ')}  ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`)
