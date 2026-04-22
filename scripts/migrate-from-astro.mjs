// Одноразовый скрипт миграции: Blog/src/content/blog/*/index.md → new_blog/posts/<slug>.md
// Ассеты кладём в new_blog/public/blog/<slug>/<original-name>, чтобы абсолютные
// URL старого Astro-сайта вида /blog/<slug>/<file> оставались валидными.

import { readFile, writeFile, mkdir, readdir, copyFile, stat, rm } from "node:fs/promises";
import { join, basename, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC_CONTENT = join(ROOT, "..", "Blog", "src", "content", "blog");
const SRC_PUBLIC_BLOG = join(ROOT, "..", "Blog", "public", "blog");
const POSTS_DIR = join(ROOT, "posts");
const PUBLIC_BLOG = join(ROOT, "public", "blog");

const CATEGORIES = ["kubernetes", "gitops", "storage", "networking", "observability", "security", "misc"];
const TAG_TO_CATEGORY = {
  kubernetes: "kubernetes",
  talos: "kubernetes",
  argocd: "gitops",
  terraform: "gitops",
  proxmox: "gitops",
  longhorn: "storage",
  storage: "storage",
  cilium: "networking",
  cheatsheet: "misc",
  applications: "misc",
  "infrastructure-as-code": "gitops",
};

function deriveCategory(tags = []) {
  for (const t of tags) {
    const norm = String(t).toLowerCase().replace(/\s+/g, "-");
    if (CATEGORIES.includes(norm)) return norm;
    if (TAG_TO_CATEGORY[norm]) return TAG_TO_CATEGORY[norm];
  }
  return "misc";
}

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function listDir(p) {
  try { return await readdir(p, { withFileTypes: true }); } catch { return []; }
}

async function listPostDirs() {
  const entries = await readdir(SRC_CONTENT, { withFileTypes: true });
  return entries.filter(e => e.isDirectory()).map(e => e.name);
}

async function migrateOne(slug) {
  const srcDir = join(SRC_CONTENT, slug);
  const mdPath = join(srcDir, "index.md");
  if (!(await exists(mdPath))) {
    console.warn(`! skip ${slug} (no index.md)`);
    return;
  }
  const raw = await readFile(mdPath, "utf8");
  const parsed = matter(raw);
  const data = parsed.data || {};
  const body = parsed.content;

  // Все ассеты — рядом с md и в Blog/public/blog/<slug>/
  const assetSources = [
    { dir: srcDir, files: (await listDir(srcDir)).filter(e => e.isFile() && e.name !== "index.md").map(e => e.name) },
    { dir: join(SRC_PUBLIC_BLOG, slug), files: (await listDir(join(SRC_PUBLIC_BLOG, slug))).filter(e => e.isFile()).map(e => e.name) },
  ];
  const allAssetNames = new Set();
  for (const { files } of assetSources) files.forEach(f => allAssetNames.add(f));

  if (allAssetNames.size) {
    const destDir = join(PUBLIC_BLOG, slug);
    await mkdir(destDir, { recursive: true });
    for (const { dir, files } of assetSources) {
      for (const name of files) {
        await copyFile(join(dir, name), join(destDir, name));
      }
    }
  }

  // Ссылки в MD:
  //   ./Pasted image ....png         → /blog/<slug>/Pasted%20image%20....png
  //   (Pasted image ....png)          → то же
  //   /blog/<slug>/... (уже абс.)    → не трогаем
  let newBody = body;
  for (const name of allAssetNames) {
    const encoded = `/blog/${slug}/${encodeURI(name)}`;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Markdown-ссылка: ![...](./<file>) или ![...](<file>)
    const reRelDot = new RegExp(`\\(\\./${escaped}\\)`, "g");
    const reRelBare = new RegExp(`\\(${escaped}\\)`, "g");
    // URL-encoded варианты (пробелы → %20) тоже встречаются
    const encName = encodeURI(name);
    const escapedEnc = encName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const reRelDotEnc = new RegExp(`\\(\\./${escapedEnc}\\)`, "g");
    const reRelBareEnc = new RegExp(`\\(${escapedEnc}\\)`, "g");

    newBody = newBody
      .replace(reRelDot, `(${encoded})`)
      .replace(reRelDotEnc, `(${encoded})`)
      .replace(reRelBare, `(${encoded})`)
      .replace(reRelBareEnc, `(${encoded})`);
  }

  const frontmatter = { ...data };
  if (!frontmatter.category) frontmatter.category = deriveCategory(frontmatter.tags);
  if (frontmatter.draft === false) delete frontmatter.draft;

  const output = matter.stringify(newBody, frontmatter);
  await mkdir(POSTS_DIR, { recursive: true });
  await writeFile(join(POSTS_DIR, `${slug}.md`), output);

  console.log(`✓ ${slug}  (category=${frontmatter.category}, assets=${allAssetNames.size})`);
}

async function main() {
  if (!(await exists(SRC_CONTENT))) {
    console.error(`Source not found: ${SRC_CONTENT}`);
    process.exit(1);
  }
  // Чистим public/blog/ и posts/ — миграция идемпотентна
  await rm(PUBLIC_BLOG, { recursive: true, force: true });
  await mkdir(PUBLIC_BLOG, { recursive: true });
  await rm(POSTS_DIR, { recursive: true, force: true });
  await mkdir(POSTS_DIR, { recursive: true });

  // Подчищаем старую неудачную попытку
  const oldImages = join(ROOT, "public", "images");
  await rm(oldImages, { recursive: true, force: true });

  const slugs = await listPostDirs();
  for (const slug of slugs) {
    await migrateOne(slug);
  }
  console.log(`\nDone. ${slugs.length} posts migrated → ${POSTS_DIR}`);
}

main().catch(e => { console.error(e); process.exit(1); });
