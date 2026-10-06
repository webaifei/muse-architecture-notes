/**
 * 把 Markdown 章节构建成单文件 index.html。
 *
 * 版式取自阮一峰博客（ruanyifeng.com）的实际 CSS：
 *   body        background #f5f5d5 · Georgia,serif · font-size 62.5% · line-height 1.8em
 *   #container  width 65% · min 640px · max 960px · 居中
 *   .entry-body margin-left 1em · padding-left .4em · border-left .4em solid gray
 *   标题        2.88em · font-weight 500 · border-bottom 1px #d3d3d3
 *   正文        font-size 1.6em · line-height 180%
 *   行内代码     pink 背景 · border-radius 5px
 *   代码块       #f5f2f0 背景
 *   链接         #223472 · hover #d03500
 *
 * 依赖：npm i -D marked shiki
 * 用法：node tools/build-page.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { marked } from 'marked'
import { createHighlighter } from 'shiki'

const ROOT = new URL('..', import.meta.url).pathname
const THEME = 'min-light'

const highlighter = await createHighlighter({
  themes: [THEME],
  langs: ['javascript', 'typescript', 'bash', 'json', 'markdown'],
})

marked.use({
  renderer: {
    code({ text, lang }) {
      const language = highlighter.getLoadedLanguages().includes(lang) ? lang : 'text'
      const html = highlighter.codeToHtml(text, { lang: language, theme: THEME })
      return `<div class="codeblock">${html}</div>`
    },
  },
})

const render = (markdown) => marked.parse(markdown)

// PAGE_FILES 可指定只构建哪几篇（逗号分隔），用来单独预览一章
const files = process.env.PAGE_FILES
  ? process.env.PAGE_FILES.split(',').map((s) => s.trim())
  : readdirSync(ROOT)
      .filter((name) => /^ch\d+.*\.md$/.test(name))
      .sort()

const chapters = files.map((file) => {
  const markdown = readFileSync(join(ROOT, file), 'utf8')
  const title = markdown.match(/^#\s+(.+)$/m)?.[1] ?? basename(file, '.md')
  return { file, title, id: file.replace(/\.md$/, ''), html: render(markdown) }
})

const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
const intro = marked.parseInline(
  readme.replace(/^#\s+.+$/m, '').trim().split('\n\n').slice(0, 2).join(' '),
)

const toc = chapters
  .map((c, i) => `      <li><a href="#${c.id}">${c.title}</a>（第 ${i + 1} 篇）</li>`)
  .join('\n')

const body = chapters
  .map((c) => `\n<article class="hentry" id="${c.id}">\n${c.html}\n</article>\n`)
  .join('\n')

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Muse 架构剖析</title>
<style>
html { font-size: 62.5%; }
body {
  margin: 0;
  padding: 0;
  background-color: #f5f5d5;
  font-family: Georgia, "Songti SC", "SimSun", serif;
  letter-spacing: -0.01em;
  word-spacing: .2em;
  line-height: 1.8em;
  color: #111;
}
#container {
  width: 65%;
  min-width: 640px;
  max-width: 960px;
  margin: 0 auto;
  padding: 1em 1em 6em 1em;
  background-color: #f5f5d5;
}
#header { border-bottom: 1px solid #d3d3d3; padding-bottom: .6em; margin-bottom: 1.5em; }
#header h1 { font-size: 2.4em; font-weight: 500; margin: .6em 0 .2em 0; letter-spacing: -0.03em; }
#header h1 a { color: #567; text-decoration: none; }
#header-description { font-size: 1.4em; color: #567; }
#header nav { font-size: 1.4em; margin-top: .6em; }
#header nav a { color: #567; text-decoration: underline; }

.intro { font-size: 1.6em; line-height: 185%; margin: 0 0 2em .8em; }
.toc { font-size: 1.5em; line-height: 190%; margin: 0 0 3em .8em; padding-left: 1em; }
.toc li { list-style-type: square; }
.toc a { color: #223472; }

/* 正文左灰线——他的标志 */
article.hentry { margin: 0 0 6em 1em; padding-left: .4em; border-left: .4em solid gray; }

article h1 {
  font-size: 2.88em;
  font-weight: 500;
  letter-spacing: -0.03em;
  color: #000;
  margin: .4em 0 .2em 0;
  padding: 0 0 .2em 0;
  border-bottom: 1px solid #d3d3d3;
  line-height: 1.35em;
}
article h2 {
  font-size: 2.2em;
  font-weight: 500;
  letter-spacing: -0.03em;
  color: #000;
  margin: 1.6em 0 .2em 0;
  padding: 0 0 .2em 0;
  border-bottom: 1px solid #d3d3d3;
}
article h3 { font-size: 1.8em; font-weight: 500; margin: 1.2em 0 .2em 0; }
article p {
  font-size: 1.6em;
  line-height: 190%;
  margin: 1em 0 0 .8em;
}
article p code {
  display: inline-block;
  padding: 0 5px;
  font-size: 120%;
  font-family: Consolas, Monaco, "Andale Mono", monospace;
  background-color: pink;
  border-radius: 5px;
  margin: auto 3px;
}
article a { color: #223472; text-decoration: underline; }
article a:hover { color: #d03500; }
article ul, article ol { font-size: 1.6em; line-height: 190%; margin: 1em 0 0 2.2em; }
article ul li { list-style-type: square; }
article ol li { list-style-type: decimal; }
article blockquote {
  background-color: #f5f2f0;
  padding: .8em 1.2em;
  margin: 1.6em 2em;
  border-radius: 1em;
  font-size: 1.4em;
  line-height: 180%;
  color: #333;
}
article blockquote p { font-size: 100%; margin: .3em 0 0 0; }
article hr { border: 0; border-top: 1px solid #d3d3d3; margin: 2.4em 0 0 .8em; }
.codeblock { margin: 1.4em .8em; }
.codeblock pre {
  background: #f5f2f0 !important;
  padding: .8em 1em;
  border-radius: .6em;
  overflow-x: auto;
}
.codeblock code { font-family: Consolas, Monaco, "Andale Mono", monospace; font-size: 1.35em; line-height: 1.7; }

#footer {
  border-top: 1px solid #d3d3d3;
  margin-top: 4em;
  padding-top: 1.4em;
  font-size: 1.4em;
  color: gray;
}
#footer code { background: pink; padding: 0 4px; border-radius: 4px; }

@media (max-width: 700px) {
  #container { width: 92%; min-width: 0; }
  article.hentry { margin-left: .4em; }
  article p { margin-left: .4em; }
}
</style>
</head>
<body>
<div id="container">

  <header id="header">
    <h1><a href="#top">Muse 架构剖析</a></h1>
    <div id="header-description">从零实现一遍 Meta Muse 的安全架构 · 共 ${chapters.length} 篇</div>
    <nav><a href="#toc">章节列表</a> · <a href="muse-safety-blog-zh.html">Muse 安全博客中英对照</a> · <a href="https://github.com/webaifei/muse-architecture-notes">源码仓库</a></nav>
  </header>

  <div class="intro"><p>${intro}</p></div>

  <div class="toc" id="toc">
    <p style="font-size:1em;margin-left:0">共 ${chapters.length} 篇：</p>
    <ul>
${toc}
    </ul>
  </div>

${body}

  <div id="footer">
    每篇配的代码都在 <code>code/</code> 下，单独 <code>node</code> 就能跑。本页完全自包含，离线可读。
  </div>

</div>
</body>
</html>`

writeFileSync(join(ROOT, 'index.html'), html)
console.log(`index.html  ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB，${chapters.length} 篇`)
