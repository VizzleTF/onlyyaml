# onlyyaml

Статический блог DevOps-инженера. Собирается из Markdown в чистый HTML без фреймворков.

## Стек

- Node.js + ESM
- `markdown-it` + `markdown-it-anchor` для рендера
- `shiki` (`@shikijs/markdown-it`) для подсветки синтаксиса
- `gray-matter` для фронт-маттера
- `chokidar` для watch-режима
- Собственный сборщик `scripts/build.mjs` — никаких фреймворков

## Структура

```
posts/       # Markdown-посты с фронт-маттером
templates/   # HTML-шаблоны страниц (index, blog, post, about)
partials/    # head, nav, footer
public/      # статика (картинки, видео, CSS, JS) → копируется as-is в dist/
scripts/     # build.mjs + миграция
dist/        # результат сборки (игнорится)
```

## Локальная разработка

```bash
npm install
npm run dev        # watch + ребилд
npm run serve      # поднять dist/ на :3000
```

Одноразовая сборка:

```bash
npm run build
```

На выходе в `dist/`:
- `index.html`, `blog.html`, `about.html`
- `blog/<slug>/index.html` для каждого поста
- `rss.xml`, `sitemap.xml`, `_redirects`
- весь `public/*`

## Новый пост

Создать файл `posts/<slug>.md` с фронт-маттером:

```yaml
---
title: "Заголовок"
description: "Короткое описание для листинга и OG."
date: 2026-04-22
tags: [kubernetes, terraform]
category: kubernetes
draft: false
---

Контент в Markdown.
```

Черновики (`draft: true`) не попадают в `dist/`.

## Деплой на Cloudflare Pages

### Вариант A — через дашборд (проще)

1. Зайти в Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Авторизовать GitHub и выбрать репозиторий `VizzleTF/onlyyaml`.
3. Настройки сборки:
   - **Framework preset**: `None`
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
   - **Root directory**: (пусто)
   - **Environment variables**: `NODE_VERSION` = `20` (или новее)
4. Нажать **Save and Deploy**. Каждый push в `main` → автоматический деплой. PR-ветки получают preview-URL.

### Вариант B — через Wrangler CLI

```bash
npm i -g wrangler
wrangler login
npm run build
wrangler pages deploy dist --project-name=onlyyaml --branch=main
```

Для первого деплоя Cloudflare создаст проект и привяжет его к аккаунту.

### Кастомный домен

В проекте Pages → **Custom domains** → **Set up a custom domain** → ввести `onlyyaml.dev`. Cloudflare сам пропишет CNAME, если домен хостится у них; иначе — добавить CNAME на `<project>.pages.dev` у регистратора.

### Редиректы

`scripts/build.mjs` генерирует `dist/_redirects` — Cloudflare Pages читает его автоматически, дополнительной настройки не требуется.
