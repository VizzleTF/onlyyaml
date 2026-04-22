// Build: posts/*.md + templates/ → dist/
// - Рендерит каждый пост в dist/blog/<slug>/index.html
// - Собирает dist/blog.html (архив + фильтр по tags)
// - Обновляет dist/index.html (3 свежих карточки)
// - Пишет dist/rss.xml, dist/sitemap.xml, dist/_redirects
// - Копирует public/* в dist/

import { readFile, writeFile, mkdir, readdir, stat, cp, rm } from "node:fs/promises";
import { join, dirname, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import MarkdownIt from "markdown-it";
import markdownItAnchor from "markdown-it-anchor";
import Shiki from "@shikijs/markdown-it";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const POSTS_DIR = join(ROOT, "posts");
const TEMPLATES_DIR = join(ROOT, "templates");
const PARTIALS_DIR = join(ROOT, "partials");
const PUBLIC_DIR = join(ROOT, "public");
const DIST = join(ROOT, "dist");

const SITE_URL = "https://onlyyaml.dev";
const SITE_TITLE = "onlyyaml";
const SITE_DESC = "Блог DevOps-инженера о Terraform, Kubernetes, Proxmox, CI/CD и автоматизации инфраструктуры.";
const AUTHOR = { name: "Ivan K", url: `${SITE_URL}/about.html` };
const DEFAULT_OG = `${SITE_URL}/open-graph.png`;

const CATEGORIES = ["kubernetes", "gitops", "storage", "networking", "observability", "security", "misc"];
const MONTHS_RU = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];

// ---------- helpers ----------
async function exists(p) { try { await stat(p); return true; } catch { return false; } }
const escapeHtml = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
const escapeAttr = s => String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;");
const escapeXml = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");

function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] ?? "" : m));
}

function formatDateHuman(date) {
  const d = date.getDate().toString().padStart(2, "0");
  const m = MONTHS_RU[date.getMonth()];
  const y = date.getFullYear();
  return `${d} · ${m} · ${y}`;
}
function formatDateShort(date) {
  return `${date.getDate().toString().padStart(2,"0")} · ${MONTHS_RU[date.getMonth()]} · ${date.getFullYear()}`;
}
function isoDate(date) { return date.toISOString(); }

function countWords(text) {
  return (text.trim().match(/\S+/g) || []).length;
}
function readingMinutes(text) {
  return Math.max(1, Math.round(countWords(text) / 200));
}

async function readPartials() {
  const [nav, footer, head] = await Promise.all([
    readFile(join(PARTIALS_DIR, "nav.html"), "utf8"),
    readFile(join(PARTIALS_DIR, "footer.html"), "utf8"),
    readFile(join(PARTIALS_DIR, "head-common.html"), "utf8"),
  ]);
  return { nav, footer, head };
}

async function loadTemplates() {
  const [post, blog, index, about] = await Promise.all([
    readFile(join(TEMPLATES_DIR, "post.html"), "utf8"),
    readFile(join(TEMPLATES_DIR, "blog.html"), "utf8"),
    readFile(join(TEMPLATES_DIR, "index.html"), "utf8"),
    readFile(join(TEMPLATES_DIR, "about.html"), "utf8"),
  ]);
  return { post, blog, index, about };
}

// ---------- markdown ----------
async function createMd() {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
  md.use(markdownItAnchor, { slugify: s => s.toLowerCase().replace(/\s+/g, "-").replace(/[^\w\-Ѐ-ӿ]/g, "") });
  md.use(await Shiki({ theme: "github-dark" }));
  return md;
}

// ---------- posts ----------
async function loadPosts() {
  await mkdir(POSTS_DIR, { recursive: true });
  const files = (await readdir(POSTS_DIR)).filter(f => f.endsWith(".md"));
  const posts = [];
  for (const f of files) {
    const slug = basename(f, ".md");
    const raw = await readFile(join(POSTS_DIR, f), "utf8");
    const { data, content } = matter(raw);
    if (data.draft === true) continue;
    const date = new Date(data.date);
    const updatedDate = data.updatedDate ? new Date(data.updatedDate) : null;
    const tags = Array.isArray(data.tags) ? data.tags.map(String) : [];
    let category = data.category && CATEGORIES.includes(data.category) ? data.category : null;
    if (!category) category = tags.find(t => CATEGORIES.includes(String(t).toLowerCase())) || "misc";
    posts.push({
      slug,
      title: data.title || slug,
      summary: data.summary || "",
      seoTitle: data.seoTitle || data.title || slug,
      seoDescription: data.seoDescription || data.summary || "",
      rss: data.rss || data.summary || "",
      image: data.image || null,
      date, updatedDate, tags,
      category,
      featured: Boolean(data.featured),
      body: content,
      wordCount: countWords(content),
      readingMinutes: readingMinutes(content),
    });
  }
  posts.sort((a, b) => b.date - a.date);
  return posts;
}

// ---------- per-post render ----------
function renderTagsMeta(tags) {
  return tags.map(t => `<meta property="article:tag" content="${escapeAttr(t)}">`).join("\n");
}

function jsonLdBlogPosting(post, canonicalUrl) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.summary,
    datePublished: isoDate(post.date),
    dateModified: isoDate(post.updatedDate || post.date),
    url: canonicalUrl,
    image: post.image ? `${SITE_URL}${post.image}` : DEFAULT_OG,
    inLanguage: "ru-RU",
    author: {
      "@type": "Person",
      name: AUTHOR.name,
      url: AUTHOR.url,
    },
    publisher: {
      "@type": "Organization",
      name: SITE_TITLE,
      url: SITE_URL,
      logo: { "@type": "ImageObject", url: `${SITE_URL}/favicon.png` },
    },
    keywords: post.tags.join(", "),
    mainEntityOfPage: { "@type": "WebPage", "@id": canonicalUrl },
  });
}

function jsonLdBreadcrumb(post, canonicalUrl) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Главная", item: `${SITE_URL}/` },
      { "@type": "ListItem", position: 2, name: "Блог", item: `${SITE_URL}/blog/` },
      { "@type": "ListItem", position: 3, name: post.title, item: canonicalUrl },
    ],
  });
}

function relatedFor(post, allPosts, limit = 3) {
  const tagSet = new Set(post.tags);
  const scored = allPosts
    .filter(p => p.slug !== post.slug)
    .map(p => ({ p, score: p.tags.filter(t => tagSet.has(t)).length }))
    .sort((a, b) => b.score - a.score || b.p.date - a.p.date);
  return scored.slice(0, limit).map(x => x.p);
}

function tagsAttr(post) {
  const set = new Set([post.category, ...post.tags.map(t => String(t).toLowerCase())]);
  return Array.from(set).join(",");
}

function cardHtml(post) {
  const href = `/blog/${post.slug}/`;
  return `    <a href="${href}" class="post-card" data-tags="${escapeAttr(tagsAttr(post))}">
      <div class="post-tag">// ${escapeHtml(post.category)}</div>
      <h3 class="post-title">${escapeHtml(post.title)}</h3>
      <p class="post-excerpt">${escapeHtml(post.summary)}</p>
      <div class="post-meta"><span>${formatDateShort(post.date)}</span><span class="arrow">→</span></div>
    </a>`;
}

function featuredHtml(post) {
  if (!post) return "";
  const href = `/blog/${post.slug}/`;
  const stamp = post.category.slice(0, 3);
  const month = (post.date.getMonth() + 1).toString().padStart(2, "0");
  return `  <a href="${href}" class="post-featured" data-tags="${escapeAttr(tagsAttr(post))}">
    <div class="post-featured-body">
      <div>
        <div class="post-tag">// ${escapeHtml(post.category)} · featured</div>
        <h3>${escapeHtml(post.title)}</h3>
      </div>
      <p class="post-excerpt">${escapeHtml(post.summary)}</p>
      <div class="post-meta">
        <span><span class="badge">// new</span>${formatDateShort(post.date)} · ~${post.readingMinutes} min</span>
        <span class="arrow">→</span>
      </div>
    </div>
    <div class="post-featured-art">
      <div class="art-stamp">${escapeHtml(stamp)}<br>/${month}</div>
      <div class="art-label">#${post.date.getFullYear()}.${month}.${post.date.getDate().toString().padStart(2,"0")}<br>${escapeHtml(post.slug)}</div>
    </div>
  </a>`;
}

function relatedSectionHtml(related) {
  if (!related.length) return "";
  const cards = related.map(p => `    <a href="/blog/${p.slug}/" class="post-card">
      <div class="post-tag">// ${escapeHtml(p.category)}</div>
      <h3 class="post-title">${escapeHtml(p.title)}</h3>
      <p class="post-excerpt">${escapeHtml(p.summary)}</p>
      <div class="post-meta"><span>${formatDateShort(p.date)}</span><span class="arrow">→</span></div>
    </a>`).join("\n");
  return `<section class="related">
  <h2>related</h2>
  <div class="post-grid">
${cards}
  </div>
</section>`;
}

// ---------- build steps ----------
const TERM_DOTS = '<span class="term-dots"><span></span><span></span><span></span></span>';
function injectTermDots(html) {
  return html.replace(/<pre([^>]*)>(?!<span class="term-dots")/g, `<pre$1>${TERM_DOTS}`);
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, "").trim();
}

function extractToc(bodyHtml) {
  const re = /<h2\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/g;
  const items = [];
  let m;
  while ((m = re.exec(bodyHtml)) !== null) {
    items.push({ id: m[1], text: stripTags(m[2]) });
  }
  return items;
}

function tocHtml(items) {
  if (items.length < 2) return "";
  const lis = items.map((it, i) => {
    const n = String(i + 1).padStart(2, "0");
    return `    <li><a href="#${escapeAttr(it.id)}"><span class="toc-num">${n}</span><span class="toc-text">${escapeHtml(it.text)}</span></a></li>`;
  }).join("\n");
  return `<aside class="post-toc" aria-label="Содержание">
  <div class="toc-title">Содержание</div>
  <ol class="toc-list">
${lis}
  </ol>
</aside>`;
}

async function buildPostPages(posts, md, templates, partials) {
  for (const post of posts) {
    const bodyHtml = injectTermDots(md.render(post.body));
    const canonicalUrl = `${SITE_URL}/blog/${post.slug}/`;
    const vars = {
      headCommon: partials.head,
      nav: partials.nav.replace(/\{\{nav(Home|Blog|About)Active\}\}/g, (_m, k) => k === "Blog" ? "active" : ""),
      footer: partials.footer,
      title: escapeHtml(post.title),
      seoTitle: escapeHtml(post.seoTitle),
      seoDescription: escapeAttr(post.seoDescription),
      ogTitle: escapeAttr(post.title),
      ogDescription: escapeAttr(post.summary),
      ogImage: post.image ? `${SITE_URL}${post.image}` : DEFAULT_OG,
      canonicalUrl,
      robots: "index,follow",
      datePublishedIso: isoDate(post.date),
      dateModifiedIso: isoDate(post.updatedDate || post.date),
      articleTagsMeta: renderTagsMeta(post.tags),
      jsonLdBlogPosting: jsonLdBlogPosting(post, canonicalUrl),
      jsonLdBreadcrumb: jsonLdBreadcrumb(post, canonicalUrl),
      category: escapeHtml(post.category),
      slug: escapeHtml(post.slug),
      dateHuman: `<b>${post.date.getDate().toString().padStart(2,"0")}</b> ${MONTHS_RU[post.date.getMonth()]} <b>${post.date.getFullYear()}</b>`,
      readingMinutes: String(post.readingMinutes),
      wordCount: post.wordCount.toLocaleString("ru-RU").replace(/,/g, " "),
      updatedBadge: post.updatedDate
        ? `<span class="dot">·</span><span>upd: <b>${formatDateShort(post.updatedDate)}</b></span>`
        : "",
      bodyHtml,
      tocHtml: tocHtml(extractToc(bodyHtml)),
      relatedSection: relatedSectionHtml(relatedFor(post, posts)),
    };
    const html = render(templates.post, vars);
    const outDir = join(DIST, "blog", post.slug);
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "index.html"), html);
  }
}

async function buildBlogIndex(posts, templates, partials) {
  const featured = posts.find(p => p.featured) || null;
  const rest = featured ? posts.filter(p => p.slug !== featured.slug) : posts;

  // Чипы: все реальные теги из постов + категории, отсортированные по частоте, затем по алфавиту
  const counts = new Map();
  for (const p of posts) {
    const set = new Set([p.category, ...p.tags.map(t => String(t).toLowerCase())]);
    for (const t of set) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const allTags = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
  const chips = [
    `  <button class="tag-chip active" data-filter="all">all</button>`,
    ...allTags.map(t => `  <button class="tag-chip" data-filter="${escapeAttr(t)}">${escapeHtml(t)}</button>`),
  ].join("\n");

  const vars = {
    headCommon: partials.head,
    nav: partials.nav.replace(/\{\{nav(Home|Blog|About)Active\}\}/g, (_m, k) => k === "Blog" ? "active" : ""),
    footer: partials.footer,
    postCount: String(posts.length),
    tagsChipsHtml: chips,
    featuredCardHtml: featuredHtml(featured),
    postCardsHtml: rest.map(p => cardHtml(p)).join("\n"),
  };
  const html = render(templates.blog, vars);
  await mkdir(join(DIST, "blog"), { recursive: true });
  await writeFile(join(DIST, "blog", "index.html"), html);
}

async function buildAbout(templates, partials) {
  const vars = {
    headCommon: partials.head,
    nav: partials.nav.replace(/\{\{nav(Home|Blog|About)Active\}\}/g, (_m, k) => k === "About" ? "active" : ""),
    footer: partials.footer,
  };
  const html = render(templates.about, vars);
  await writeFile(join(DIST, "about.html"), html);
}

async function buildHome(posts, templates, partials) {
  const latest = posts.slice(0, 3);
  const vars = {
    headCommon: partials.head,
    nav: partials.nav.replace(/\{\{nav(Home|Blog|About)Active\}\}/g, (_m, k) => k === "Home" ? "active" : ""),
    footer: partials.footer,
    latestThreeHtml: latest.map(p => cardHtml(p)).join("\n"),
  };
  const html = render(templates.index, vars);
  await writeFile(join(DIST, "index.html"), html);
}

async function buildRss(posts) {
  const items = posts.map(p => `    <item>
      <title>${escapeXml(p.title)}</title>
      <link>${SITE_URL}/blog/${p.slug}/</link>
      <guid isPermaLink="true">${SITE_URL}/blog/${p.slug}/</guid>
      <pubDate>${p.date.toUTCString()}</pubDate>
      <description>${escapeXml(p.rss)}</description>
      ${p.tags.map(t => `<category>${escapeXml(t)}</category>`).join("\n      ")}
    </item>`).join("\n");

  const rss = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(SITE_TITLE)}</title>
    <link>${SITE_URL}/</link>
    <description>${escapeXml(SITE_DESC)}</description>
    <language>ru-RU</language>
    <atom:link href="${SITE_URL}/rss.xml" rel="self" type="application/rss+xml" />
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
  await writeFile(join(DIST, "rss.xml"), rss);
}

async function buildSitemap(posts) {
  const urls = [
    { loc: `${SITE_URL}/`, lastmod: new Date(), priority: "1.0", changefreq: "weekly" },
    { loc: `${SITE_URL}/blog/`, lastmod: posts[0]?.date || new Date(), priority: "0.9", changefreq: "weekly" },
    ...posts.map(p => ({
      loc: `${SITE_URL}/blog/${p.slug}/`,
      lastmod: p.updatedDate || p.date,
      priority: "0.8",
      changefreq: "monthly",
    })),
  ];
  const body = urls.map(u =>
    `  <url>
    <loc>${escapeXml(u.loc)}</loc>
    <lastmod>${u.lastmod.toISOString().slice(0,10)}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join("\n");
  const sm = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
  await writeFile(join(DIST, "sitemap.xml"), sm);
}

async function buildRedirects() {
  // Архив — /blog/ (index.html). Старый путь /blog.html уводим на /blog/.
  const r = `/blog.html   /blog/   301
`;
  await writeFile(join(DIST, "_redirects"), r);
}

async function copyPublic() {
  if (!(await exists(PUBLIC_DIR))) return;
  await cp(PUBLIC_DIR, DIST, { recursive: true });
}

async function buildRobots() {
  const robots = `User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`;
  await writeFile(join(DIST, "robots.txt"), robots);
}

// ---------- main ----------
async function build() {
  const t0 = Date.now();
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  const [templates, partials, md] = await Promise.all([
    loadTemplates(),
    readPartials(),
    createMd(),
  ]);

  await copyPublic();

  const posts = await loadPosts();
  if (!posts.length) console.warn("! no posts found in posts/");

  await buildPostPages(posts, md, templates, partials);
  await buildBlogIndex(posts, templates, partials);
  await buildHome(posts, templates, partials);
  await buildAbout(templates, partials);
  await buildRss(posts);
  await buildSitemap(posts);
  await buildRobots();
  await buildRedirects();

  const ms = Date.now() - t0;
  console.log(`✓ built ${posts.length} posts → ${DIST} in ${ms}ms`);
}

async function watch() {
  const { default: chokidar } = await import("chokidar");
  await build();
  const watcher = chokidar.watch([POSTS_DIR, TEMPLATES_DIR, PARTIALS_DIR, PUBLIC_DIR], { ignoreInitial: true });
  let timer;
  watcher.on("all", () => {
    clearTimeout(timer);
    timer = setTimeout(() => build().catch(e => console.error(e)), 100);
  });
  console.log("watching posts/, templates/, partials/, public/ ...");
}

const args = process.argv.slice(2);
if (args.includes("--watch")) watch();
else build().catch(e => { console.error(e); process.exit(1); });
