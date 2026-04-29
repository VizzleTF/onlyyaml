(function () {
  // ─── mobile burger ───
  const burger = document.getElementById('navBurger');
  const navLinks = document.getElementById('navLinks');
  if (burger && navLinks) {
    const close = () => {
      burger.classList.remove('open');
      navLinks.classList.remove('open');
      burger.setAttribute('aria-expanded', 'false');
      document.body.classList.remove('nav-open');
    };
    burger.addEventListener('click', () => {
      const isOpen = burger.classList.toggle('open');
      navLinks.classList.toggle('open', isOpen);
      burger.setAttribute('aria-expanded', String(isOpen));
      document.body.classList.toggle('nav-open', isOpen);
    });
    navLinks.querySelectorAll('a').forEach(a => a.addEventListener('click', close));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  }

  // ─── code-block copy button ───
  const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><rect x="8" y="8" width="12" height="12"/><path d="M16 4H4v12"/></svg>';
  const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square"><path d="M4 12l5 5L20 6"/></svg>';

  document.querySelectorAll('.post-body pre').forEach(pre => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.setAttribute('aria-label', 'copy code');
    btn.innerHTML = COPY_ICON + '<span>copy</span>';
    pre.appendChild(btn);
    btn.addEventListener('click', async () => {
      const code = pre.querySelector('code');
      const text = (code ? code.innerText : pre.innerText).trim();
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch {}
        document.body.removeChild(ta);
      }
      btn.classList.add('copied');
      btn.innerHTML = CHECK_ICON + '<span>copied</span>';
      clearTimeout(btn._t);
      btn._t = setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = COPY_ICON + '<span>copy</span>';
      }, 1600);
    });
  });

  // ─── TOC active section highlight ───
  const tocLinks = document.querySelectorAll('.toc a[href^="#"]');
  if (tocLinks.length) {
    const byId = new Map();
    const sections = [];
    tocLinks.forEach(a => {
      const id = decodeURIComponent((a.getAttribute('href') || '').slice(1));
      const el = id && document.getElementById(id);
      if (el) { byId.set(id, a); sections.push(el); }
    });
    if (sections.length && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver(entries => {
        entries.forEach(e => {
          if (e.isIntersecting) {
            tocLinks.forEach(l => l.classList.remove('active'));
            const a = byId.get(e.target.id);
            if (a) a.classList.add('active');
          }
        });
      }, { rootMargin: '-20% 0px -70% 0px', threshold: 0 });
      sections.forEach(s => io.observe(s));
    }
  }

  // ─── tag filter (blog archive) ───
  const chips = document.querySelectorAll('.chips .chip');
  if (chips.length) {
    const rows = document.querySelectorAll('.list-row[data-tags], .featured-row[data-tags]');
    const tagsOf = el => (el.dataset.tags || '').split(',').map(s => s.trim()).filter(Boolean);
    chips.forEach(chip => {
      chip.addEventListener('click', () => {
        chips.forEach(c => c.classList.remove('on'));
        chip.classList.add('on');
        const filter = chip.dataset.filter;
        rows.forEach(row => {
          const match = filter === 'all' || tagsOf(row).includes(filter);
          row.hidden = !match;
        });
      });
    });
  }

  // ─── cmd-k search ───
  const cmdk = document.getElementById('cmdk');
  if (cmdk) {
    const trigger = document.getElementById('cmdkTrigger');
    const input = document.getElementById('cmdkInput');
    const list = document.getElementById('cmdkList');
    let posts = null;
    let results = [];
    let active = 0;

    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const norm = s => String(s || '').toLowerCase();

    async function load() {
      if (posts) return posts;
      try {
        const r = await fetch('/posts.json', { cache: 'no-cache' });
        posts = await r.json();
        // Кешируем lowercased поля, чтобы каждый ввод не перегонял всё заново.
        for (const p of posts) {
          p._t = norm(p.title);
          p._sl = norm(p.slug);
          p._tg = (p.tags || []).join(' ').toLowerCase();
          p._su = norm(p.summary);
          p._b = norm(p.body);
        }
      } catch { posts = []; }
      return posts;
    }

    // Минимальный fuzzy: substring по полю + бонус за позицию,
    // fallback — subsequence по title. Возвращает {sc, where} для UI.
    function rank(q, p) {
      let i;
      if ((i = p._t.indexOf(q)) >= 0) return { sc: 1000 - i, where: 'title' };
      if ((i = p._sl.indexOf(q)) >= 0) return { sc: 800 - i, where: 'slug' };
      if ((i = p._tg.indexOf(q)) >= 0) return { sc: 500 - i, where: 'tags' };
      if ((i = p._su.indexOf(q)) >= 0) return { sc: 200 - i, where: 'summary' };
      if ((i = p._b.indexOf(q)) >= 0) return { sc: 120 - Math.min(i, 100) / 100, where: 'body' };
      let qi = 0;
      for (let ti = 0; ti < p._t.length && qi < q.length; ti++) {
        if (p._t[ti] === q[qi]) qi++;
      }
      return qi === q.length ? { sc: 30, where: 'title' } : null;
    }

    function search(raw) {
      const q = raw.trim().toLowerCase();
      if (!q) return posts.slice(0, 8).map(p => ({ p, where: 'summary' }));
      const out = [];
      for (const p of posts) {
        const r = rank(q, p);
        if (r) out.push({ p, sc: r.sc, where: r.where });
      }
      out.sort((a, b) => b.sc - a.sc || (a.p.date < b.p.date ? 1 : -1));
      return out.slice(0, 8);
    }

    function highlight(text, q) {
      if (!q) return esc(text);
      const i = text.toLowerCase().indexOf(q);
      if (i < 0) return esc(text);
      return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
    }

    function snippet(text, q) {
      const lc = text.toLowerCase();
      const i = lc.indexOf(q);
      if (i < 0) return esc(text.slice(0, 90));
      const start = Math.max(0, i - 32);
      const end = Math.min(text.length, i + q.length + 60);
      const slice = text.slice(start, end);
      const rel = i - start;
      return (start > 0 ? '…' : '')
        + esc(slice.slice(0, rel))
        + '<mark>' + esc(slice.slice(rel, rel + q.length)) + '</mark>'
        + esc(slice.slice(rel + q.length))
        + (end < text.length ? '…' : '');
    }

    function render() {
      const q = input.value.trim().toLowerCase();
      if (!results.length) {
        list.innerHTML = '<li class="cmdk-empty">// no posts match</li>';
        return;
      }
      if (active >= results.length) active = results.length - 1;
      list.innerHTML = results.map((res, i) => {
        const p = res.p;
        const sub = res.where === 'body'
          ? snippet(p.body || '', q)
          : esc((p.summary || '').slice(0, 90));
        const tag = res.where === 'body' ? '<span class="cmdk-where">body</span>' : '';
        return `<li class="cmdk-item${i === active ? ' on' : ''}" data-i="${i}" style="--cat:var(--cat-${p.catSlug});" role="option" aria-selected="${i === active}">
          <span class="cmdk-cat">${esc(p.catLabel)}</span>
          <span class="cmdk-title">${highlight(p.title, q)}${tag}</span>
          <span class="cmdk-sub">${sub}</span>
        </li>`;
      }).join('');
    }

    function update() {
      if (!posts) return;
      results = search(input.value);
      active = 0;
      render();
    }

    function open() {
      load().then(() => {
        cmdk.hidden = false;
        input.value = '';
        results = search('');
        active = 0;
        render();
        document.body.classList.add('cmdk-open');
        requestAnimationFrame(() => input.focus());
      });
    }
    function close() {
      cmdk.hidden = true;
      document.body.classList.remove('cmdk-open');
    }
    function go(res) { if (res && res.p) location.href = '/blog/' + res.p.slug + '/'; }
    function scrollActive() {
      const el = list.querySelector('.cmdk-item.on');
      if (el) el.scrollIntoView({ block: 'nearest' });
    }

    trigger?.addEventListener('click', open);

    document.addEventListener('keydown', e => {
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === 'k') {
        e.preventDefault();
        cmdk.hidden ? open() : close();
        return;
      }
      if (cmdk.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(results.length - 1, active + 1); render(); scrollActive(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); render(); scrollActive(); }
      else if (e.key === 'Enter') { e.preventDefault(); go(results[active]); }
    });

    input.addEventListener('input', update);

    cmdk.addEventListener('click', e => {
      if (e.target.closest('[data-cmdk-close]')) { close(); return; }
      const item = e.target.closest('.cmdk-item');
      if (item) go(results[Number(item.dataset.i)]);
    });
    cmdk.addEventListener('mousemove', e => {
      const item = e.target.closest('.cmdk-item');
      if (!item) return;
      const i = Number(item.dataset.i);
      if (i !== active) { active = i; render(); }
    });
  }

  // ─── reading progress bar (post page) ───
  const readBar = document.getElementById('readBar');
  if (readBar) {
    const update = () => {
      const h = document.documentElement;
      const max = h.scrollHeight - h.clientHeight;
      const pct = max > 0 ? Math.min(100, Math.max(0, (h.scrollTop / max) * 100)) : 0;
      readBar.style.width = pct.toFixed(2) + '%';
    };
    document.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
  }
})();
