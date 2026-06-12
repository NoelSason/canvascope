/* ============================================================================
 * Canvascope Targeting Grid — replaces the old SVG radar.
 *
 * Why a grid, not a circle: real student workloads are skewed (many items in one
 * course, often clustered as overdue). A radial plot stacks them in one quadrant
 * and reads as a blob. A pivot table — rows = courses, columns = urgency
 * windows — answers "where is my pressure" with one glance.
 *
 * Public API:
 *   window.CanvascopeRadar.render(mountEl, {
 *     items:                 Array<task>,
 *     now:                   number (ms),
 *     onOpen:                (item, evt) => void,
 *     onFilterCourse:        (courseName) => void,
 *     onFilterCourseWindow:  (courseName, windowKey) => void,
 *   });
 *
 * Each row is a course (top rows by total, plus "Other"). Each cell is a count
 * within an urgency window. Empty cells are quiet; loaded cells have a tone
 * background and intensity by count. Clicks bubble up.
 *
 * windowKey ∈ { 'overdue', 'h24', 'd3', 'd7', 'd14' }
 * ========================================================================== */
(function () {
  const MAX_COURSE_ROWS = 4;
  const WINDOW_COLS = [
    { key: 'overdue', label: 'OVRDUE', tone: 'stop' },
    { key: 'h24',     label: '24H',    tone: 'warn' },
    { key: 'd3',      label: '3D',     tone: 'go' },
    { key: 'd7',      label: '7D',     tone: 'go' },
    { key: 'd14',     label: '14D',    tone: 'mute' }
  ];
  const MS_DAY = 24 * 60 * 60 * 1000;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function parseDueTs(item) {
    if (!item || !item.dueAt) return 0;
    const ts = new Date(item.dueAt).getTime();
    return isNaN(ts) ? 0 : ts;
  }

  // "2026 Spring Biology 1A" → "BIO 1A".  "Chem 3BL: Organic Chem (S25)" → "CHEM 3BL".
  function compactCourseLabel(name) {
    if (!name) return '—';
    let s = String(name).trim();
    s = s.replace(/^\d{4}\s+(spring|fall|winter|summer|autumn)\s+/i, '');
    s = s.replace(/^(spring|fall|winter|summer|autumn)\s+\d{4}\s+/i, '');
    s = s.replace(/\s*\([^)]*\)\s*$/, '').trim();
    s = s.replace(/\s*[:,–—]\s*.+$/, '').trim();

    // Pattern: "<word> <number>" — abbreviate word to ≤4 chars
    const m = s.match(/^([A-Za-z]+)\s+(\d{1,3}[A-Za-z]{0,3})$/);
    if (m) {
      const word = m[1];
      const num  = m[2];
      const courseAbbrs = {
        biology: 'BIO',
        chemistry: 'CHEM',
        physics: 'PHYS',
        mathematics: 'MATH',
        calculus: 'MATH',
        statistics: 'STAT',
        english: 'ENGL',
        history: 'HIST',
        psychology: 'PSYC',
        economics: 'ECON',
        computer: 'CS'
      };
      const key = word.toLowerCase();
      const abbr = courseAbbrs[key] || (word.length <= 4 ? word.toUpperCase() : word.slice(0, 4).toUpperCase());
      return `${abbr} ${num.toUpperCase()}`;
    }

    // Pattern: existing code-shaped string ("CS161", "BIOL101A")
    const tight = s.replace(/\s+/g, '');
    const codeM = tight.match(/^([A-Za-z]{2,5})(\d{1,3}[A-Za-z]{0,3})$/);
    if (codeM) return `${codeM[1].toUpperCase()} ${codeM[2].toUpperCase()}`;

    const upper = s.toUpperCase();
    return upper.length > 9 ? upper.slice(0, 8) + '…' : upper;
  }

  // Classify a task into one of the urgency windows.
  function classifyWindow(item, now) {
    const ts = parseDueTs(item);
    if (!ts) return 'd14';   // undated → far bucket
    const diff = ts - now;
    if (diff < 0) return 'overdue';
    if (diff <= MS_DAY)       return 'h24';
    if (diff <= 3 * MS_DAY)   return 'd3';
    if (diff <= 7 * MS_DAY)   return 'd7';
    return 'd14';
  }

  // Build a pivot { course -> { overdue, h24, d3, d7, d14, total, items: { window -> [item] } } }
  function buildPivot(items, now) {
    const pivot = new Map();
    items.forEach(item => {
      const course = item.courseName || '—';
      const win = classifyWindow(item, now);
      if (!pivot.has(course)) {
        pivot.set(course, {
          overdue: 0, h24: 0, d3: 0, d7: 0, d14: 0,
          total: 0,
          items: { overdue: [], h24: [], d3: [], d7: [], d14: [] }
        });
      }
      const row = pivot.get(course);
      row[win] += 1;
      row.total += 1;
      row.items[win].push(item);
    });

    // Sort by total desc and collapse overflow into "Other"
    const rows = Array.from(pivot.entries())
      .sort((a, b) => b[1].total - a[1].total);

    let other = null;
    if (rows.length > MAX_COURSE_ROWS) {
      const overflow = rows.slice(MAX_COURSE_ROWS - 1);
      const visible = rows.slice(0, MAX_COURSE_ROWS - 1);
      other = {
        overdue: 0, h24: 0, d3: 0, d7: 0, d14: 0, total: 0,
        items: { overdue: [], h24: [], d3: [], d7: [], d14: [] }
      };
      overflow.forEach(([, r]) => {
        ['overdue', 'h24', 'd3', 'd7', 'd14'].forEach(k => {
          other[k] += r[k];
          other.items[k].push(...r.items[k]);
        });
        other.total += r.total;
      });
      visible.push(['Other', other]);
      return visible;
    }
    return rows;
  }

  // Cell intensity by count — used to drive bg color depth.
  function intensityClass(count) {
    if (count <= 0) return 'i-0';
    if (count === 1) return 'i-1';
    if (count <= 3)  return 'i-2';
    if (count <= 6)  return 'i-3';
    return 'i-4';
  }

  function totalsByWindow(pivot) {
    const t = { overdue: 0, h24: 0, d3: 0, d7: 0, d14: 0, total: 0 };
    pivot.forEach(([, row]) => {
      t.overdue += row.overdue; t.h24 += row.h24;
      t.d3      += row.d3;      t.d7  += row.d7;
      t.d14     += row.d14;     t.total += row.total;
    });
    return t;
  }

  function pickHottestCell(pivot) {
    // Prefer the most loaded overdue cell; fall back to today; then 3d.
    const order = ['overdue', 'h24', 'd3', 'd7', 'd14'];
    for (const win of order) {
      let best = null;
      for (const [course, row] of pivot) {
        if (row[win] > 0 && (!best || row[win] > best.count)) {
          best = { course, win, count: row[win] };
        }
      }
      if (best) return best;
    }
    return null;
  }

  function formatRelDue(item, now) {
    const ts = parseDueTs(item);
    if (!ts) return 'no due';
    const diff = ts - now;
    const abs = Math.abs(diff);
    if (abs >= MS_DAY) {
      const d = Math.floor(abs / MS_DAY);
      return diff < 0 ? `${d}d overdue` : `in ${d}d`;
    }
    const h = Math.floor(abs / (60 * 60 * 1000));
    const m = Math.floor((abs % (60 * 60 * 1000)) / (60 * 1000));
    if (diff < 0) return `${h}h overdue`;
    return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
  }

  function render(mount, opts = {}) {
    if (!mount) return;
    const {
      items = [],
      now = Date.now(),
      onOpen,
      onFilterCourse,
      onFilterCourseWindow
    } = opts;

    mount.innerHTML = '';

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'cs-grid-empty';
      empty.textContent = '— no targets in range —';
      mount.appendChild(empty);
      return;
    }

    const pivot = buildPivot(items, now);
    const totals = totalsByWindow(pivot);

    // ---- Wrapper ----------------------------------------------------------
    const wrap = document.createElement('div');
    wrap.className = 'cs-grid';

    // Header
    wrap.innerHTML = `
      <div class="cs-grid-head">
        <span class="cs-grid-title">⟫ Targeting grid</span>
        <span class="cs-grid-total">${totals.total} TGT</span>
      </div>
    `;

    // ---- Table ------------------------------------------------------------
    const table = document.createElement('div');
    table.className = 'cs-grid-table';
    table.style.gridTemplateColumns = `minmax(108px, 1.45fr) repeat(${WINDOW_COLS.length}, minmax(30px, 0.72fr))`;

    // Column headers
    const corner = document.createElement('span');
    corner.className = 'cs-grid-h cs-grid-h-corner';
    corner.textContent = 'COURSE';
    table.appendChild(corner);

    WINDOW_COLS.forEach(col => {
      const h = document.createElement('span');
      h.className = `cs-grid-h cs-grid-h-col tone-${col.tone}`;
      h.textContent = col.label;
      h.title = ({
        overdue: 'Overdue items',
        h24:     'Due in the next 24 hours',
        d3:      'Due in 1–3 days',
        d7:      'Due in 4–7 days',
        d14:     'Due in 8–14 days (or undated)'
      })[col.key];
      table.appendChild(h);
    });

    // Course rows
    pivot.forEach(([courseName, row], rowIdx) => {
      const courseBtn = document.createElement('button');
      courseBtn.type = 'button';
      courseBtn.className = 'cs-grid-course';
      courseBtn.style.animationDelay = `${rowIdx * 50}ms`;
      courseBtn.innerHTML = `
        <span class="cs-grid-course-name">${escapeHtml(compactCourseLabel(courseName))}</span>
        <span class="cs-grid-course-total">${row.total}</span>
      `;
      courseBtn.title = `Filter results to ${courseName}`;
      courseBtn.addEventListener('click', () => {
        if (typeof onFilterCourse === 'function') onFilterCourse(courseName);
      });
      table.appendChild(courseBtn);

      WINDOW_COLS.forEach(col => {
        const count = row[col.key];
        const cell = document.createElement('button');
        cell.type = 'button';
        const intensity = intensityClass(count);
        cell.className = `cs-grid-cell tone-${col.tone} ${intensity}`;
        cell.style.animationDelay = `${rowIdx * 50 + 20}ms`;

        if (count > 0) {
          cell.classList.add('has-count');
          cell.innerHTML = `<span class="cs-grid-cell-num">${count}</span>`;
          cell.setAttribute('aria-label', `${count} ${col.label} ${courseName}`);
          cell.title = `${count} item${count === 1 ? '' : 's'} · ${courseName} · ${col.label}`;
        } else {
          cell.innerHTML = `<span class="cs-grid-cell-empty">·</span>`;
          cell.setAttribute('aria-label', `No ${col.label} items in ${courseName}`);
          cell.disabled = true;
        }

        cell.addEventListener('click', () => {
          if (typeof onFilterCourseWindow === 'function') onFilterCourseWindow(courseName, col.key);
        });
        table.appendChild(cell);
      });
    });

    wrap.appendChild(table);

    // ---- Hottest-cell callout (bottom panel) ------------------------------
    const callout = document.createElement('div');
    callout.className = 'cs-grid-callout';
    const hot = pickHottestCell(pivot);
    if (hot) {
      const row = pivot.find(([n]) => n === hot.course)[1];
      const sample = row.items[hot.win].slice().sort((a, b) => parseDueTs(a) - parseDueTs(b))[0];
      const winLabel = WINDOW_COLS.find(c => c.key === hot.win).label;
      const winTone  = WINDOW_COLS.find(c => c.key === hot.win).tone;
      callout.innerHTML = `
        <div class="cs-grid-callout-head">
          <span class="cs-grid-callout-kicker tone-${winTone}">
            <span class="cs-status-dot"></span>HOT TARGET · ${winLabel} · ${escapeHtml(compactCourseLabel(hot.course))}
          </span>
          <span class="cs-grid-callout-count">${hot.count}</span>
        </div>
        <div class="cs-grid-callout-title" data-cs-grid-hot-title>${escapeHtml(sample?.title || '')}</div>
        <div class="cs-grid-callout-meta">${escapeHtml(sample ? formatRelDue(sample, now) : '')}</div>
        <div class="cs-grid-callout-actions">
          <button type="button" class="cs-btn cs-btn--primary" data-cs-grid-open>Open ↗</button>
          <button type="button" class="cs-btn cs-btn--ghost"   data-cs-grid-show>Show all (${hot.count})</button>
        </div>
      `;
      callout.querySelector('[data-cs-grid-open]').addEventListener('click', (e) => {
        if (sample && typeof onOpen === 'function') onOpen(sample, e);
      });
      callout.querySelector('[data-cs-grid-show]').addEventListener('click', () => {
        if (typeof onFilterCourseWindow === 'function') onFilterCourseWindow(hot.course, hot.win);
      });
    } else {
      callout.innerHTML = `
        <div class="cs-grid-callout-empty">
          <span class="cs-grid-callout-kicker tone-go"><span class="cs-status-dot"></span>ALL CLEAR</span>
          <span>No urgent targets in your scope.</span>
        </div>
      `;
    }
    wrap.appendChild(callout);

    // ---- Bottom totals strip ---------------------------------------------
    const strip = document.createElement('div');
    strip.className = 'cs-grid-strip';
    strip.innerHTML = `
      <span class="cs-grid-strip-cell tone-stop"><span class="cs-grid-strip-dot"></span>OVERDUE <strong>${String(totals.overdue).padStart(2, '0')}</strong></span>
      <span class="cs-grid-strip-cell tone-warn"><span class="cs-grid-strip-dot"></span>24H <strong>${String(totals.h24).padStart(2, '0')}</strong></span>
      <span class="cs-grid-strip-cell tone-go"><span class="cs-grid-strip-dot"></span>7D <strong>${String(totals.d3 + totals.d7).padStart(2, '0')}</strong></span>
    `;
    wrap.appendChild(strip);

    mount.appendChild(wrap);
  }

  window.CanvascopeRadar = { render };
})();
