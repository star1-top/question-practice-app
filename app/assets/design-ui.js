/* Navigation presentation only. Data, authentication and quiz logic stay in app.js. */
(function () {
  'use strict';
  const sidebar = document.getElementById('appSidebar');
  const toggle = document.getElementById('menuToggle');
  const main = document.getElementById('main');
  const narrow = window.matchMedia('(max-width:1000px)');
  let previousOverflow = '';
  const menuIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  const closeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
  function setMenu(open, returnFocus) {
    open = !!open && narrow.matches;
    if (open && !sidebar.classList.contains('menu-open')) previousOverflow = document.body.style.overflow;
    sidebar.classList.toggle('menu-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? '关闭导航' : '打开导航');
    toggle.innerHTML = open ? closeIcon : menuIcon;
    main.inert = open;
    if (open) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = document.getElementById('overlay').classList.contains('hide') ? previousOverflow : 'hidden';
    if (!open && returnFocus) toggle.focus();
  }
  toggle.addEventListener('click', () => setMenu(!sidebar.classList.contains('menu-open'), true));
  document.getElementById('navTabs').addEventListener('click', e => {
    if (e.target.closest('[data-tab]') && narrow.matches) setMenu(false, true);
  });
  document.getElementById('userBtn').addEventListener('click', () => {
    if (narrow.matches) setMenu(false, true);
  });
  document.getElementById('creditBtn').addEventListener('click', () => {
    if (narrow.matches) setMenu(false, false);
  });
  document.addEventListener('keydown', e => {
    if (!sidebar.classList.contains('menu-open')) return;
    if (e.key === 'Escape') { e.preventDefault(); setMenu(false, true); }
    if (e.key === 'Tab') {
      const focusable = Array.from(sidebar.querySelectorAll('button,select,a,input'))
        .filter(el => !el.disabled && el.getClientRects().length);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  narrow.addEventListener('change', () => setMenu(false, false));
  const wideFilters = window.matchMedia('(min-width:761px)');
  wideFilters.addEventListener('change', () => {
    const filters = document.querySelector('.practice-filters');
    if (filters) filters.open = wideFilters.matches || !(window.Q && Q.app && Q.app.S.pq.length);
  });
})();
