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

// Tags shown as the visible category label in cards/list — first match wins.
const PRIMARY_TECH_TAGS = ["terraform", "talos", "kubernetes", "longhorn", "argocd", "cilium", "vault", "cnpg", "proxmox"];

// Map any label (tech tag or category) → unique color slot.
// Каждый тег получает свой цвет, чтобы соседние чипы/пиллы не сливались.
const CAT_SLUG = {
  terraform: "tf",
  proxmox: "px",
  kubernetes: "k8s",
  talos: "tl",
  longhorn: "lh",
  cilium: "cl",
  gitops: "go",
  argocd: "ag",
  cnpg: "cn",
  observability: "ob",
  prometheus: "ob",
  vault: "vt",
  security: "sc",
  networking: "nt",
  storage: "st",
  iac: "tf",
  misc: "ms",
};
function catSlug(label) { return CAT_SLUG[String(label).toLowerCase()] || "tf"; }
function displayCategory(post) {
  const lower = post.tags.map(t => String(t).toLowerCase());
  for (const tech of PRIMARY_TECH_TAGS) if (lower.includes(tech)) return tech;
  return post.category;
}

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
  let draftCount = 0;
  for (const f of files) {
    const slug = basename(f, ".md");
    const raw = await readFile(join(POSTS_DIR, f), "utf8");
    const { data, content } = matter(raw);
    if (data.draft === true) { draftCount++; continue; }
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
  return { posts, draftCount };
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
  const set = new Set([post.category, displayCategory(post), ...post.tags.map(t => String(t).toLowerCase())]);
  return Array.from(set).join(",");
}

function formatCardDate(date) {
  return `${date.getDate().toString().padStart(2,"0")} ${MONTHS_RU[date.getMonth()].toUpperCase()}`;
}
function formatListDate(date) {
  return `${date.getFullYear()} · ${(date.getMonth()+1).toString().padStart(2,"0")} · ${date.getDate().toString().padStart(2,"0")}`;
}

function cardLabels(post) {
  const lower = post.tags.map(t => String(t).toLowerCase());
  const matched = PRIMARY_TECH_TAGS.filter(tech => lower.includes(tech));
  return matched.length ? matched : [post.category];
}

function cardHtml(post) {
  const href = `/blog/${post.slug}/`;
  const labels = cardLabels(post);
  const primarySlug = catSlug(labels[0]);
  const tagsHtml = labels.map(l =>
    `<span class="card-tag" style="--cat: var(--cat-${catSlug(l)});">${escapeHtml(l)}</span>`
  ).join("");
  return `    <a href="${href}" class="card" data-tags="${escapeAttr(tagsAttr(post))}" style="--cat: var(--cat-${primarySlug});">
      <div class="card-tags">${tagsHtml}</div>
      <h3>${escapeHtml(post.title)}</h3>
      <p>${escapeHtml(post.summary)}</p>
      <div class="card-meta">
        <span>${formatCardDate(post.date)} · ${post.readingMinutes} MIN</span>
        <span class="arrow">→</span>
      </div>
    </a>`;
}

function featuredRowHtml(post, index = 1) {
  if (!post) return "";
  const href = `/blog/${post.slug}/`;
  const label = displayCategory(post);
  const slug = catSlug(label);
  const stamp = String(index).padStart(2, "0");
  const dateUpper = `${post.date.getDate().toString().padStart(2,"0")} ${MONTHS_RU[post.date.getMonth()].toUpperCase()} ${post.date.getFullYear()}`;
  return `    <a href="${href}" class="featured-row" data-tags="${escapeAttr(tagsAttr(post))}" style="--cat: var(--cat-${slug});">
      <div class="featured-body">
        <span class="badge">FEATURED · ${escapeHtml(label.toUpperCase())}</span>
        <h3>${escapeHtml(post.title)}</h3>
        <p>${escapeHtml(post.summary)}</p>
        <div class="meta">
          <span>${dateUpper}</span>
          <span>·</span>
          <span><b>${post.readingMinutes}</b> MIN READ</span>
          <span>·</span>
          <span><b>${post.wordCount.toLocaleString("ru-RU").replace(/,/g, " ")}</b> WORDS</span>
        </div>
      </div>
      <div class="featured-art" aria-hidden="true">
        <div class="stamp">${stamp}</div>
        <div class="lbl">${escapeHtml(label)}<br>${escapeHtml(post.slug)}<br>// 2k${(post.date.getFullYear()%100).toString().padStart(2,"0")}</div>
      </div>
    </a>`;
}

function listRowHtml(post) {
  const href = `/blog/${post.slug}/`;
  const labels = cardLabels(post);
  const primarySlug = catSlug(labels[0]);
  const catsHtml = labels.map(l =>
    `<span class="cat-pill" style="--cat: var(--cat-${catSlug(l)});">${escapeHtml(l)}</span>`
  ).join("");
  const sub = post.summary && post.summary.length > 110 ? post.summary.slice(0, 107).trimEnd() + "…" : (post.summary || "");
  return `      <a href="${href}" class="list-row" data-tags="${escapeAttr(tagsAttr(post))}" style="--cat: var(--cat-${primarySlug});">
        <span class="date">${formatListDate(post.date)}</span>
        <span class="cat">${catsHtml}</span>
        <span class="ttl">${escapeHtml(post.title)}${sub ? `<small>${escapeHtml(sub)}</small>` : ""}</span>
        <span class="len">~${post.readingMinutes} MIN</span>
        <span class="arr">→</span>
      </a>`;
}

function relatedSectionHtml(related) {
  if (!related.length) return "";
  const cards = related.map(p => cardHtml(p)).join("\n");
  return `<section class="related">
  <h2>Связанные <i>записи.</i></h2>
  <div class="cards">
${cards}
  </div>
</section>`;
}

// ---------- build steps ----------
const TERM_DOTS = '<span class="term-dots"><span></span><span></span><span></span></span>';
function injectTermChrome(html) {
  // Shiki emits <pre class="shiki ..." style="background-color:..;color:.." tabindex="0">
  //   <code class="language-xxx">…</code></pre>
  // 1. Strip the outer <pre> inline style so our CSS background/foreground takes effect
  //    (token spans inside <code> keep their own colors, so syntax highlighting still works).
  // 2. Inject term-dots + lang label after the opening <pre>.
  return html.replace(/<pre([^>]*)>([\s\S]*?<code(?:[^>]*?)class="(?:language-([\w-]+)|[^"]*)"(?:[^>]*)>)/g, (_m, preAttrs, codeOpen, lang) => {
    const cleanedAttrs = preAttrs.replace(/\sstyle="[^"]*"/, "");
    const langLabel = lang ? `<span class="term-name">${escapeHtml(lang)}</span>` : "";
    return `<pre${cleanedAttrs}>${TERM_DOTS}${langLabel}${codeOpen}`;
  });
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
    return `      <li><a href="#${escapeAttr(it.id)}"><span class="n">${n}</span><span>${escapeHtml(it.text)}</span></a></li>`;
  }).join("\n");
  return `  <aside class="toc" aria-label="оглавление">
    <div class="head">// оглавление</div>
    <ol>
${lis}
    </ol>
  </aside>`;
}

async function buildPostPages(posts, md, templates, partials) {
  for (const post of posts) {
    const bodyHtml = injectTermChrome(md.render(post.body));
    const canonicalUrl = `${SITE_URL}/blog/${post.slug}/`;
    const label = displayCategory(post);
    const slug = catSlug(label);
    const dateUpper = `${post.date.getDate().toString().padStart(2,"0")} ${MONTHS_RU[post.date.getMonth()].toUpperCase()} ${post.date.getFullYear()}`;
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
      categoryLabel: escapeHtml(label),
      catSlug: slug,
      slug: escapeHtml(post.slug),
      deck: escapeHtml(post.summary || ""),
      dateHuman: dateUpper,
      readingMinutes: String(post.readingMinutes),
      wordCount: post.wordCount.toLocaleString("ru-RU").replace(/,/g, " "),
      updatedBadge: post.updatedDate
        ? `<span class="sep">·</span><span class="updated">обновлено ${formatDateShort(post.updatedDate)}</span>`
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
  // Авто-featured: если в frontmatter ни один пост не помечен `featured: true`,
  // показываем самый свежий — пустая шапка архива выглядит криво.
  const featured = posts.find(p => p.featured) || posts[0] || null;
  const rest = featured ? posts.filter(p => p.slug !== featured.slug) : posts;

  // Chip набор: PRIMARY_TECH_TAGS, у которых есть хоть один пост, плюс "все".
  // Цвет берётся из CAT_SLUG, count — сколько постов имеют этот лейбл по displayCategory.
  const labelCounts = new Map();
  for (const p of posts) {
    const lower = p.tags.map(t => String(t).toLowerCase());
    for (const tech of PRIMARY_TECH_TAGS) if (lower.includes(tech)) {
      labelCounts.set(tech, (labelCounts.get(tech) || 0) + 1);
    }
    // также учитываем категорию, если она не в PRIMARY_TECH_TAGS
    if (!PRIMARY_TECH_TAGS.includes(p.category)) {
      labelCounts.set(p.category, (labelCounts.get(p.category) || 0) + 1);
    }
  }
  const usedLabels = Array.from(labelCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const chipParts = [
    `  <button class="chip on" data-filter="all">все · <span class="count">${posts.length}</span></button>`,
    ...usedLabels.map(([label, count]) =>
      `  <button class="chip" data-filter="${escapeAttr(label)}" style="--cat: var(--cat-${catSlug(label)});">${escapeHtml(label)} · <span class="count">${count}</span></button>`
    ),
  ];
  const chips = chipParts.join("\n");

  const vars = {
    headCommon: partials.head,
    nav: partials.nav.replace(/\{\{nav(Home|Blog|About)Active\}\}/g, (_m, k) => k === "Blog" ? "active" : ""),
    footer: partials.footer,
    postCount: String(posts.length),
    tagsChipsHtml: chips,
    featuredRowHtml: featuredRowHtml(featured, 1),
    archiveListHtml: rest.map(p => listRowHtml(p)).join("\n"),
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

async function buildHome(posts, draftCount, templates, partials) {
  const latest = posts.slice(0, 3);
  const vars = {
    headCommon: partials.head,
    nav: partials.nav.replace(/\{\{nav(Home|Blog|About)Active\}\}/g, (_m, k) => k === "Home" ? "active" : ""),
    footer: partials.footer,
    publishedCount: String(posts.length),
    draftCount: String(draftCount),
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
  // Никаких 30x: rewrite-правила (200) подавляют trailing-slash нормализацию Cloudflare Pages.
  // /blog, /blog.html и /blog/<slug> отдают тот же index.html, что и канонические /blog/, /blog/<slug>/.
  const r = `/blog          /blog/index.html         200
/blog.html     /blog/index.html         200
/blog/:slug    /blog/:slug/index.html   200
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

  const { posts, draftCount } = await loadPosts();
  if (!posts.length) console.warn("! no posts found in posts/");

  await buildPostPages(posts, md, templates, partials);
  await buildBlogIndex(posts, templates, partials);
  await buildHome(posts, draftCount, templates, partials);
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
