(function () {
  const nav = document.getElementById('nav');
  if (nav) {
    function updateNavScroll() {
      nav.classList.toggle('scrolled', window.scrollY > 40);
    }
    window.addEventListener('scroll', updateNavScroll, { passive: true });
    updateNavScroll();
  }

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

  const tocLinks = document.querySelectorAll('.post-toc .toc-list a');
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

  const chips = document.querySelectorAll('.tag-chip');
  if (chips.length) {
    const cards = document.querySelectorAll('[data-tags], [data-tag]');
    const tagsOf = card => {
      const raw = card.dataset.tags || card.dataset.tag || '';
      return raw.split(',').map(s => s.trim()).filter(Boolean);
    };
    chips.forEach(chip => {
      chip.addEventListener('click', () => {
        chips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        const filter = chip.dataset.filter;
        cards.forEach(card => {
          const match = filter === 'all' || tagsOf(card).includes(filter);
          card.hidden = !match;
        });
      });
    });
  }
})();
