/**
 * Research Group Planner – client-side single-page application.
 *
 * Manages personnel, projects, assignments, and expenses for a research group.
 * Features: undo/redo, cost calculations, validation warnings, inline-editable
 * tables, a timeline view with drag-and-drop assignment creation and resizing,
 * file I/O via the File System Access API (with fallback), and resizable columns.
 */
(() => {
  'use strict';

  // ─── Constants ───

  const DAY_MS = 86400000;
  const MONTH_WIDTH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--month-width"));
  const COLORS = ['#2563eb', '#0f766e', '#7c3aed', '#b45309', '#be123c', '#0369a1', '#4d7c0f', '#a21caf', '#c2410c', '#4338ca', '#047857', '#9f1239'];

  // Timeline layout constants (pixels)
  const TIMELINE_BAR_TOP = 10;
  const TIMELINE_LANE_HEIGHT = 28;
  const TIMELINE_BOTTOM_PADDING = 10;
  const TIMELINE_SALARY_HEIGHT = 20;
  const PROJECT_TIMELINE_MIN_HEIGHT = 92;
  const PERSON_TIMELINE_MIN_HEIGHT = 70;

  // ─── Application State ───

  let state = emptyState();
  let fileHandle = null;       // File System Access API handle for the open file
  let currentFileName = '';
  let activeTab = 'persons';
  let sortSpec = { key: 'lastName', dir: 1 };
  let projectSortSpec = { key: 'name', dir: 1 };

  let showPast = false;        // Whether to include past projects/contracts in views
  let history = [];            // Undo stack (serialized snapshots)
  let future = [];             // Redo stack
  let pendingEditSnapshot = null;  // Snapshot taken when a field edit begins
  let pendingEditElement = null;   // Element that is currently being edited
  let syncingScroll = false;   // Guard to prevent infinite scroll-sync loop
  let scrollMemory = { project: 0, person: 0 };
  let isDirty = false;         // Unsaved-changes flag

  // ─── DOM Helpers ───

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

  // Generate a unique ID with a prefix
  const uid = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  function safeId(raw) { return String(raw ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || uid('unknown'); }

  // ─── State Factory & Serialization ───

  function emptyState() {
    return { version: 2, persons: [], projects: [], assignments: [], expenses: [] };
  }

  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  function serializableState() {
    return {
      version: 2,
      persons: clone(state.persons),
      projects: clone(state.projects),
      assignments: clone(state.assignments),
      expenses: clone(state.expenses)
    };
  }

  // Normalize raw imported/loaded data into a well-formed state object
  function normalizeState(raw) {
    const s = emptyState();
    s.persons = Array.isArray(raw?.persons) ? raw.persons.map(p => ({
      id: safeId(p.id) || uid('person'),
      firstName: String(p.firstName ?? ''),
      lastName: String(p.lastName ?? ''),
      role: String(p.role ?? ''),
      contractStart: validDateString(p.contractStart) ? p.contractStart : '',
      contractEnd: validDateString(p.contractEnd) ? p.contractEnd : '',
      salaryIntervals: Array.isArray(p.salaryIntervals)
        ? p.salaryIntervals.map(si => ({
          id: safeId(si.id) || uid('salary'),
          start: validDateString(si.start) ? si.start : '',
          end: validDateString(si.end) ? si.end : '',
          monthlyCost: numberValue(si.monthlyCost)
        }))
        // Migrate legacy flat monthlyCost into a single salary interval
        : [{
          id: uid('salary'),
          start: validDateString(p.contractStart) ? p.contractStart : '',
          end: validDateString(p.contractEnd) ? p.contractEnd : '',
          monthlyCost: numberValue(p.monthlyCost)
        }].filter(si => si.start || si.end || si.monthlyCost),
      notes: String(p.notes ?? ''),
      hidden: Boolean(p.hidden)
    })) : [];
    s.projects = Array.isArray(raw?.projects) ? raw.projects.map(p => ({
      id: safeId(p.id) || uid('project'),
      name: String(p.name ?? ''),
      type: String(p.type ?? ''),
      start: validDateString(p.start) ? p.start : '',
      end: validDateString(p.end) ? p.end : '',
      personnelBudget: numberValue(p.personnelBudget),
      travelBudget: numberValue(p.travelBudget),
      materialBudget: numberValue(p.materialBudget),
      notes: String(p.notes ?? ''),
      hidden: Boolean(p.hidden)
    })) : [];
    s.assignments = Array.isArray(raw?.assignments) ? raw.assignments.map(a => ({
      id: safeId(a.id) || uid('assignment'),
      personId: safeId(a.personId) || '',
      projectId: safeId(a.projectId) || '',
      start: validDateString(a.start) ? a.start : '',
      end: validDateString(a.end) ? a.end : '',
      ftePercent: numberValue(a.ftePercent),
      notes: String(a.notes ?? '')
    })) : [];
    s.expenses = Array.isArray(raw?.expenses) ? raw.expenses.map(e => ({
      id: safeId(e.id) || uid('expense'),
      projectId: safeId(e.projectId) || '',
      category: ['travel', 'material', 'other'].includes(e.category) ? e.category : 'travel',
      date: validDateString(e.date) ? e.date : '',
      amount: numberValue(e.amount),
      notes: String(e.notes ?? '')
    })) : [];
    return s;
  }

  // ─── Undo / Redo ───

  // Push a snapshot of the current state onto the undo stack before a mutation
  function snapshot() {
    history.push(JSON.stringify(serializableState()));
    if (history.length > 100) history.shift();
    future = [];
    updateUndoButtons();
  }

  function undo() {
    if (!history.length) return;
    pendingEditSnapshot = null; pendingEditElement = null;
    future.push(JSON.stringify(serializableState()));
    state = normalizeState(JSON.parse(history.pop()));
    renderAll();
    updateUndoButtons();
  }

  function redo() {
    if (!future.length) return;
    pendingEditSnapshot = null; pendingEditElement = null;
    history.push(JSON.stringify(serializableState()));
    state = normalizeState(JSON.parse(future.pop()));
    renderAll();
    updateUndoButtons();
  }

  function updateUndoButtons() {
    $('#undoBtn').disabled = history.length === 0;
    $('#redoBtn').disabled = future.length === 0;
  }

  // ─── Date Utilities ───

  function parseDate(s) {
    if (!validDateString(s)) return null;
    const [y, m, d] = s.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }

  function formatDate(d) {
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  function validDateString(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !!parseDateSafe(String(s));
  }

  // Parse and reject dates that don't round-trip (e.g. 2024-02-30)
  function parseDateSafe(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
    return d;
  }

  function addDays(s, n) {
    const d = parseDate(s);
    if (!d) return s;
    d.setUTCDate(d.getUTCDate() + n);
    return formatDate(d);
  }

  // ─── Number Utilities ───

  // Coerce a value to a finite number, stripping commas
  function numberValue(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const cleaned = String(value ?? '').replace(/,/g, '').trim();
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }

  function formatNumber(n, decimals = 2) {
    return numberValue(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }

  function formatMoney(n) { return `${formatNumber(n, 2)} €`; }

  // ─── Entity Lookups ───

  function personName(p) {
    return [p?.firstName, p?.lastName].filter(Boolean).join(' ') || '(unnamed person)';
  }
  function getPerson(id) { return state.persons.find(p => p.id === id); }
  function getProject(id) { return state.projects.find(p => p.id === id); }

  function todayString() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  function isPastPerson(person) {
    return validDateString(person?.contractEnd) && person.contractEnd < todayString();
  }

  function isPastProject(project) {
    return validDateString(project?.end) && project.end < todayString();
  }

  // Filtered lists that respect the "show past" toggle
  function tablePersons() { return showPast ? state.persons : state.persons.filter(p => !isPastPerson(p)); }
  function tableProjects() { return showPast ? state.projects : state.projects.filter(p => !isPastProject(p)); }
  function visiblePersons() { return tablePersons().filter(p => !p.hidden); }
  function visibleProjects() { return tableProjects().filter(p => !p.hidden); }
  function visibleAssignments() {
    const items = state.assignments.filter(a => !getPerson(a.personId)?.hidden && !getProject(a.projectId)?.hidden);
    if (showPast) return items;
    return items.filter(a => !isPastPerson(getPerson(a.personId)) && !isPastProject(getProject(a.projectId)));
  }
  function visibleExpenses() {
    const items = state.expenses.filter(e => !getProject(e.projectId)?.hidden);
    if (showPast) return items;
    return items.filter(e => !isPastProject(getProject(e.projectId)));
  }

  // ─── "Show Past" Toggle ───

  function pastToggleHtml() {
    return `<label class="past-toggle"><input type="checkbox" class="show-past-toggle" ${showPast ? 'checked' : ''}> Show past projects and contracts</label>`;
  }

  function bindPastToggle(root) {
    $$('.show-past-toggle', root).forEach(cb => cb.addEventListener('change', () => {
      showPast = cb.checked;
      renderPersons(); renderProjects(); renderExpenses(); renderTimeline();
    }));
  }

  // ─── Cost Calculation Engine ───

  function monthStartFor(date) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)); }
  function monthEndFor(date) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)); }

  // Count the overlap in days across multiple date ranges passed as start/end pairs
  function overlapDays(...ranges) {
    const starts = [], ends = [];
    for (let i = 0; i < ranges.length; i += 2) {
      const start = parseDate(ranges[i]), end = parseDate(ranges[i + 1]);
      if (!start || !end) return 0;
      starts.push(start.getTime());
      ends.push(end.getTime());
    }
    const start = Math.max(...starts), end = Math.min(...ends);
    return start > end ? 0 : Math.floor((end - start) / DAY_MS) + 1;
  }

  // Calculate the total personnel cost for an assignment.
  // Iterates month-by-month from assignment start to end, prorating each
  // salary interval that overlaps the current month by the FTE percentage.
  // Beyond the last defined salary interval, the latest known monthly rate
  // is used as a "planned employment" projection.
  function assignmentCost(a) {
    const person = getPerson(a.personId);
    if (!person || !validDateString(a.start) || !validDateString(a.end) || parseDate(a.start) > parseDate(a.end)) return 0;
    let cursor = monthStartFor(parseDate(a.start));
    const finish = parseDate(a.end);
    let total = 0;
    const intervals = (Array.isArray(person.salaryIntervals) ? person.salaryIntervals : [])
      .filter(interval => validDateString(interval.start) && validDateString(interval.end))
      .sort((x, y) => x.start.localeCompare(y.start));
    const lastInterval = intervals.length ? intervals[intervals.length - 1] : null;
    const plannedStart = lastInterval ? addDays(lastInterval.end, 1) : '';

    while (cursor <= finish) {
      const monthStartDate = monthStartFor(cursor);
      const monthEndDate = monthEndFor(cursor);
      const monthStart = formatDate(monthStartDate);
      const monthEnd = formatDate(monthEndDate);
      const daysInMonth = monthEndDate.getUTCDate();

      // Sum cost contributions from each overlapping salary interval
      for (const interval of intervals) {
        const days = overlapDays(a.start, a.end, monthStart, monthEnd, interval.start, interval.end);
        total += numberValue(interval.monthlyCost) * (numberValue(a.ftePercent) / 100) * (days / daysInMonth);
      }

      // Planned employment beyond the last defined salary interval uses the latest known rate.
      if (lastInterval && validDateString(plannedStart)) {
        const days = overlapDays(a.start, a.end, monthStart, monthEnd, plannedStart, a.end);
        total += numberValue(lastInterval.monthlyCost) * (numberValue(a.ftePercent) / 100) * (days / daysInMonth);
      }

      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    }
    return total;
  }

  function projectAssigned(projectId) {
    return state.assignments.filter(a => a.projectId === projectId).reduce((sum, a) => sum + assignmentCost(a), 0);
  }

  function projectExpense(projectId, category) {
    return state.expenses.filter(e => e.projectId === projectId && (!category || e.category === category)).reduce((s, e) => s + numberValue(e.amount), 0);
  }

  function projectFreePersonnel(p) { return numberValue(p.personnelBudget) - projectAssigned(p.id); }

  // ─── Validation & Warnings ───

  // Scan all entities for data integrity issues: date misalignments,
  // budget overruns, FTE over/under-allocation, salary gaps, etc.
  function warnings() {
    const out = [];
    // Validate persons: contract dates, salary intervals, gaps and overlaps
    for (const p of state.persons.filter(x => !x.hidden)) {
      if (p.contractStart && p.contractEnd && parseDate(p.contractStart) > parseDate(p.contractEnd)) out.push({ level: 'error', text: `${personName(p)}: contract start is after contract end.` });
      const intervals = [...(p.salaryIntervals || [])].filter(si => validDateString(si.start) && validDateString(si.end)).sort((a, b) => a.start.localeCompare(b.start));
      for (const si of p.salaryIntervals || []) {
        if (!validDateString(si.start) || !validDateString(si.end) || parseDate(si.start) > parseDate(si.end)) out.push({ level: 'error', text: `${personName(p)}: invalid salary interval.` });
        else if (validDateString(p.contractStart) && validDateString(p.contractEnd) && (si.start < p.contractStart || si.end > p.contractEnd)) out.push({ level: 'warning', text: `${personName(p)}: salary interval ${si.start} – ${si.end} lies outside the contract.` });
      }
      // Check for overlapping salary intervals
      for (let i = 1; i < intervals.length; i++) if (intervals[i].start <= intervals[i - 1].end) out.push({ level: 'error', text: `${personName(p)}: salary intervals overlap.` });
      // Walk the contract range to detect gaps between salary intervals
      if (validDateString(p.contractStart) && validDateString(p.contractEnd)) {
        let cursor = p.contractStart;
        for (const si of intervals) {
          if (si.end < cursor) continue;
          if (si.start > cursor) out.push({ level: 'error', text: `${personName(p)}: salary interval gap from ${cursor} to ${addDays(si.start, -1)}.` });
          if (si.end >= cursor) cursor = addDays(si.end, 1);
        }
        if (cursor <= p.contractEnd) out.push({ level: 'error', text: `${personName(p)}: salary intervals end before contract (${cursor}).` });
      }
    }
    // Validate projects: dates and budget overruns
    for (const p of state.projects.filter(x => !x.hidden)) {
      if (p.start && p.end && parseDate(p.start) > parseDate(p.end)) out.push({ level: 'error', text: `${p.name || '(unnamed project)'}: project start is after project end.` });
      const free = projectFreePersonnel(p);
      if (free < -0.005) out.push({ level: 'error', text: `${p.name || '(unnamed project)'}: personnel budget exceeded by ${formatMoney(-free)}.` });
    }
    // Validate assignments: orphaned refs, date validity, contract/project bounds
    for (const a of state.assignments.filter(x => !getPerson(x.personId)?.hidden && !getProject(x.projectId)?.hidden)) {
      const person = getPerson(a.personId), project = getProject(a.projectId);
      const who = personName(person);
      const what = project?.name || '(missing project)';
      if (!person) out.push({ level: 'error', text: `Assignment references a missing person.` });
      if (!project) out.push({ level: 'error', text: `Assignment for ${who} references a missing project.` });
      if (!validDateString(a.start) || !validDateString(a.end) || parseDate(a.start) > parseDate(a.end)) out.push({ level: 'error', text: `${who} / ${what}: invalid assignment dates.` });
      if (person && validDateString(a.start) && validDateString(a.end) && validDateString(person.contractStart) && validDateString(person.contractEnd)) {
        if (parseDate(a.start) < parseDate(person.contractStart)) {
          out.push({ level: 'error', text: `${who} / ${what}: assignment starts before the contract.` });
        }
        if (parseDate(a.end) > parseDate(person.contractEnd)) {
          out.push({ level: 'warning', text: `${who} / ${what}: assignment extends beyond the current contract and is treated as planned employment.` });
        }
      }
      if (project && validDateString(a.start) && validDateString(a.end) && validDateString(project.start) && validDateString(project.end)) {
        if (parseDate(a.start) < parseDate(project.start) || parseDate(a.end) > parseDate(project.end)) out.push({ level: 'error', text: `${who} / ${what}: assignment falls outside the project duration.` });
      }
      if (numberValue(a.ftePercent) <= 0) out.push({ level: 'warning', text: `${who} / ${what}: FTE is zero.` });
    }
    // Per-person FTE under/over-allocation across timeline segments
    for (const person of state.persons.filter(x => !x.hidden)) {
      if (!validDateString(person.contractStart) || !validDateString(person.contractEnd) || parseDate(person.contractStart) > parseDate(person.contractEnd)) continue;

      const personAssignments = state.assignments.filter(a =>
        a.personId === person.id &&
        validDateString(a.start) &&
        validDateString(a.end) &&
        parseDate(a.start) <= parseDate(a.end) &&
        numberValue(a.ftePercent) > 0
      );

      // Collect all segment boundary dates (contract start/end + assignment boundaries)
      const events = new Set([person.contractStart, addDays(person.contractEnd, 1)]);
      for (const a of personAssignments) {
        const clippedStart = a.start < person.contractStart ? person.contractStart : a.start;
        const clippedEnd = a.end > person.contractEnd ? person.contractEnd : a.end;
        if (clippedStart <= clippedEnd) {
          events.add(clippedStart);
          events.add(addDays(clippedEnd, 1));
        }
      }

      // Sum FTE within each segment to detect under/over allocation
      const points = [...events].sort();
      let overAllocationReported = false;
      for (let i = 0; i < points.length - 1; i++) {
        const segmentStart = points[i];
        const segmentEnd = addDays(points[i + 1], -1);
        if (segmentStart > person.contractEnd || segmentEnd < person.contractStart) continue;

        const total = personAssignments
          .filter(a => a.start <= segmentStart && a.end >= segmentStart)
          .reduce((sum, a) => sum + numberValue(a.ftePercent), 0);

        if (total < 99.9999) {
          const period = segmentStart === segmentEnd ? segmentStart : `${segmentStart} to ${segmentEnd}`;
          const assigned = Math.max(0, total);
          const missing = Math.max(0, 100 - assigned);
          out.push({ level: 'warning', text: `${personName(person)} has ${formatNumber(assigned, 1)}% funding assigned from ${period}; ${formatNumber(missing, 1)}% is missing.` });
        }
        if (!overAllocationReported && total > 100.0001) {
          out.push({ level: 'error', text: `${personName(person)} exceeds 100% FTE from ${segmentStart} (${formatNumber(total, 1)}%).` });
          overAllocationReported = true;
        }
      }
    }
    return out;
  }

  // ─── Dashboard Rendering ───

  function renderDashboard() {
    const w = warnings();
    $('#dashboard').innerHTML = `
      <div class="dashboard-grid">
        <div class="dashboard-card">
          <h2>Free personnel funding</h2>
          ${visibleProjects().length ? groupedFreePersonnelHtml() : '<div class="muted">No visible projects</div>'}
        </div>
        <div class="dashboard-card">
          <h2>Warnings</h2>
          ${w.length ? `<ul class="warning-list">${w.map(x => `<li class="${x.level}">${esc(x.text)}</li>`).join('')}</ul>` : '<div class="ok">No errors or warnings.</div>'}
        </div>
      </div>`;
  }

  // HTML-escape a value for safe insertion into markup
  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }


  // Group projects by their type field for the free-funds summary
  function projectsGroupedByType(projects) {
    const groups = new Map();
    for (const project of projects) {
      const type = String(project.type || 'Other').trim() || 'Other';
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type).push(project);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      .map(([type, items]) => [type, items.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' }))]);
  }

  function groupedFreePersonnelHtml() {
    const projects = [...visibleProjects()].sort((a, b) =>
      String(a.type || '').localeCompare(String(b.type || ''), undefined, { numeric: true, sensitivity: 'base' }) ||
      String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' })
    );
    const totalFree = projects.reduce((sum, project) => sum + projectFreePersonnel(project), 0);

    return `
      <div class="compact-budget-list">
        ${projects.map(project => `
          <div class="budget-line compact-budget-line">
            <span><strong>${esc(project.type || 'Other')}:</strong> ${esc(project.name || '(unnamed project)')}</span>
            <strong class="${projectFreePersonnel(project) < 0 ? 'negative-funding' : ''}">${formatMoney(projectFreePersonnel(project))}</strong>
          </div>
        `).join('')}
        <div class="budget-line compact-budget-total">
          <span>Total free funds</span>
          <strong class="${totalFree < 0 ? 'negative-funding' : ''}">${formatMoney(totalFree)}</strong>
        </div>
      </div>`;
  }

  // ─── Inline Input Helper ───

  function input(kind, value, attrs = '') {
    const type = kind === 'date' ? 'date' : 'text';
    const cls = kind === 'money'
      ? 'money-input'
      : kind === 'percent'
        ? 'percent-input'
        : kind === 'date'
          ? 'iso-date-input'
          : '';
    const display = kind === 'money' ? formatNumber(value, 2) : esc(value);
    return `<input type="${type}" class="${cls}" value="${display}" ${attrs}>`;
  }

  // ─── Persons Tab ───

  function renderPersons() {
    const rows = [...tablePersons()].sort((a, b) => comparePersons(a, b, sortSpec.key) * sortSpec.dir);
    $('#tab-persons').innerHTML = `
      <div class="section-head"><h2>Personnel</h2><div class="section-actions">${pastToggleHtml()}<button class="primary" id="addPersonBtn">Add person</button></div></div>
      <div class="table-wrap"><table id="personnelTable" class="resizable-table"><thead><tr>
        ${personHeader('lastName', 'Last name')}${personHeader('firstName', 'First name')}${personHeader('role', 'Role')}${personHeader('contractStart', 'Contract start')}${personHeader('contractEnd', 'Contract end')}
        <th>Extension</th><th>Salary intervals</th><th>Notes</th>${personHeader('hidden', 'Hide')}<th></th>
      </tr></thead><tbody>
      ${rows.map(p => `<tr data-person-id="${p.id}" class="${p.hidden ? 'hidden-row' : ''}">
        <td>${input('text', p.lastName, fieldAttrs('person', p.id, 'lastName'))}</td>
        <td>${input('text', p.firstName, fieldAttrs('person', p.id, 'firstName'))}</td>
        <td>${input('text', p.role, fieldAttrs('person', p.id, 'role'))}</td>
        <td>${input('date', p.contractStart, fieldAttrs('person', p.id, 'contractStart'))}</td>
        <td>${input('date', p.contractEnd, fieldAttrs('person', p.id, 'contractEnd'))}</td>
        <td class="computed extension-cell">${requiredContractExtension(p.id) ? `+${requiredContractExtension(p.id)} months` : ''}</td>
        <td class="salary-summary">${(p.salaryIntervals || []).length} interval${(p.salaryIntervals || []).length === 1 ? '' : 's'} <button class="add-salary" data-id="${p.id}">Add interval</button></td>
        <td><textarea ${fieldAttrs('person', p.id, 'notes')}>${esc(p.notes)}</textarea></td>
        <td class="center"><input type="checkbox" ${fieldAttrs('person', p.id, 'hidden')} ${p.hidden ? 'checked' : ''}></td>
        <td><button class="danger delete-person" data-id="${p.id}">Delete</button></td>
      </tr><tr class="salary-detail-row ${p.hidden ? 'hidden-row' : ''}"><td colspan="10">${salaryIntervalsEditor(p)}</td></tr>`).join('')}
      </tbody></table></div>`;
    $('#addPersonBtn').onclick = () => addPerson();
    $$('.delete-person', $('#tab-persons')).forEach(b => b.onclick = () => deletePerson(b.dataset.id));
    $$('.add-salary', $('#tab-persons')).forEach(b => b.onclick = () => addSalaryInterval(b.dataset.id));
    $$('.delete-salary', $('#tab-persons')).forEach(b => b.onclick = () => deleteSalaryInterval(b.dataset.personId, b.dataset.salaryId));
    $$('th.sortable', $('#tab-persons')).forEach(th => th.onclick = () => sortPersons(th.dataset.sort));
    bindEditorFields($('#tab-persons'));
    bindPastToggle($('#tab-persons'));
    bindResizableTables($('#tab-persons'));
  }

  // Render the expandable salary interval sub-table for a person
  function salaryIntervalsEditor(person) {
    const intervals = [...(person.salaryIntervals || [])].sort((a, b) => String(a.start).localeCompare(String(b.start)));
    if (!intervals.length) return '<div class="salary-empty">No salary intervals defined.</div>';
    return `<div class="salary-editor"><table><thead><tr><th>Salary start</th><th>Salary end</th><th>Monthly employer cost</th><th></th></tr></thead><tbody>${intervals.map(si => `<tr data-salary-id="${si.id}"><td>${input('date', si.start, salaryFieldAttrs(person.id, si.id, 'start'))}</td><td>${input('date', si.end, salaryFieldAttrs(person.id, si.id, 'end'))}</td><td>${input('money', si.monthlyCost, salaryFieldAttrs(person.id, si.id, 'monthlyCost'))}</td><td><button class="danger delete-salary" data-person-id="${person.id}" data-salary-id="${si.id}">Delete</button></td></tr>`).join('')}</tbody></table></div>`;
  }

  function salaryFieldAttrs(personId, salaryId, field) {
    return `data-entity="salary" data-person-id="${personId}" data-id="${salaryId}" data-field="${field}"`;
  }

  function personHeader(key, label) {
    const c = sortSpec.key === key ? (sortSpec.dir === 1 ? ' asc' : ' desc') : '';
    return `<th class="sortable${c}" data-sort="${key}">${label}</th>`;
  }

  function comparePersons(a, b, key) {
    if (key === 'hidden') return Number(Boolean(a.hidden)) - Number(Boolean(b.hidden));
    return String(a[key] ?? '').localeCompare(String(b[key] ?? ''), undefined, { numeric: true, sensitivity: 'base' });
  }

  function sortPersons(key) {
    if (sortSpec.key === key) sortSpec.dir *= -1; else sortSpec = { key, dir: 1 };
    renderPersons();
  }

  // ─── Projects Tab ───

  function renderProjects() {
    const rows = [...tableProjects()].sort((a, b) => compareProjects(a, b, projectSortSpec.key) * projectSortSpec.dir);
    $('#tab-projects').innerHTML = `
      <div class="section-head"><h2>Projects</h2><div class="section-actions">${pastToggleHtml()}<button class="primary" id="addProjectBtn">Add project</button></div></div>
      <div class="table-wrap"><table id="projectsTable" class="resizable-table"><thead><tr>${projectHeader('type', 'Type')}${projectHeader('name', 'Name')}${projectHeader('start', 'Start')}${projectHeader('end', 'End')}<th>Extension</th>${projectHeader('personnelBudget', 'Personnel budget')}${projectHeader('travelBudget', 'Travel budget')}${projectHeader('materialBudget', 'Material budget')}${projectHeader('assigned', 'Assigned personnel')}${projectHeader('free', 'Free personnel')}<th>Notes</th>${projectHeader('hidden', 'Hide')}<th></th></tr></thead><tbody>
      ${rows.map(p => `<tr data-project-id="${p.id}" class="${p.hidden ? 'hidden-row' : ''}">
        <td>${input('text', p.type, fieldAttrs('project', p.id, 'type'))}</td>
        <td>${input('text', p.name, fieldAttrs('project', p.id, 'name'))}</td>
        <td>${input('date', p.start, fieldAttrs('project', p.id, 'start'))}</td>
        <td>${input('date', p.end, fieldAttrs('project', p.id, 'end'))}</td>
        <td class="computed">${requiredProjectExtension(p.id) ? `+${requiredProjectExtension(p.id)} months` : ''}</td>
        <td>${input('money', p.personnelBudget, fieldAttrs('project', p.id, 'personnelBudget'))}</td>
        <td>${input('money', p.travelBudget, fieldAttrs('project', p.id, 'travelBudget'))}</td>
        <td>${input('money', p.materialBudget, fieldAttrs('project', p.id, 'materialBudget'))}</td>
        <td class="computed money" data-project-assigned="${p.id}">${formatMoney(projectAssigned(p.id))}</td>
        <td class="computed money" data-project-free="${p.id}">${formatMoney(projectFreePersonnel(p))}</td>
        <td><textarea ${fieldAttrs('project', p.id, 'notes')}>${esc(p.notes)}</textarea></td>
        <td class="center"><input type="checkbox" ${fieldAttrs('project', p.id, 'hidden')} ${p.hidden ? 'checked' : ''}></td>
        <td><button class="danger delete-project" data-id="${p.id}">Delete</button></td>
      </tr>`).join('')}
      </tbody></table></div>`;
    $('#addProjectBtn').onclick = () => addProject();
    $$('.delete-project', $('#tab-projects')).forEach(b => b.onclick = () => deleteProject(b.dataset.id));
    $$('th.sortable', $('#tab-projects')).forEach(th => th.onclick = () => sortProjects(th.dataset.sort));
    bindEditorFields($('#tab-projects'));
    bindPastToggle($('#tab-projects'));
    bindResizableTables($('#tab-projects'));
  }

  function projectHeader(key, label) {
    const c = projectSortSpec.key === key ? (projectSortSpec.dir === 1 ? ' asc' : ' desc') : '';
    return `<th class="sortable${c}" data-sort="${key}">${label}</th>`;
  }

  function compareProjects(a, b, key) {
    if (key === 'hidden') return Number(Boolean(a.hidden)) - Number(Boolean(b.hidden));
    if (key === 'assigned') return projectAssigned(a.id) - projectAssigned(b.id);
    if (key === 'free') return projectFreePersonnel(a) - projectFreePersonnel(b);
    if (['personnelBudget', 'travelBudget', 'materialBudget'].includes(key)) return numberValue(a[key]) - numberValue(b[key]);
    return String(a[key] ?? '').localeCompare(String(b[key] ?? ''), undefined, { numeric: true, sensitivity: 'base' });
  }

  function sortProjects(key) {
    if (projectSortSpec.key === key) projectSortSpec.dir *= -1; else projectSortSpec = { key, dir: 1 };
    renderProjects();
  }

  // Build <option> list for expense project selects (only projects with travel/material budget)
  function projectOptions(selected) {
    const projects = visibleProjects().filter(p => numberValue(p.travelBudget) > 0 || numberValue(p.materialBudget) > 0);
    const selectedProject = getProject(selected);
    if (selectedProject && !selectedProject.hidden && !projects.some(p => p.id === selectedProject.id)) projects.push(selectedProject);
    return `<option value="">Select project</option>` + projects.map(p => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name || '(unnamed project)')}</option>`).join('');
  }

  // ─── Expenses Tab ───

  function renderExpenses() {
    const overviewRows = visibleProjects()
      .filter(p => numberValue(p.travelBudget) > 0 || numberValue(p.materialBudget) > 0)
      .map(p => {
        const travelSpent = projectExpense(p.id, 'travel');
        const materialSpent = projectExpense(p.id, 'material');
        return `<tr>
        <td>${esc(p.name || '(unnamed project)')}</td>
        <td class="money">${formatMoney(p.travelBudget)}</td>
        <td class="money" data-expense-summary="travel-spent" data-project-id="${p.id}">${formatMoney(travelSpent)}</td>
        <td class="money" data-expense-summary="travel-left" data-project-id="${p.id}">${formatMoney(numberValue(p.travelBudget) - travelSpent)}</td>
        <td class="money">${formatMoney(p.materialBudget)}</td>
        <td class="money" data-expense-summary="material-spent" data-project-id="${p.id}">${formatMoney(materialSpent)}</td>
        <td class="money" data-expense-summary="material-left" data-project-id="${p.id}">${formatMoney(numberValue(p.materialBudget) - materialSpent)}</td>
      </tr>`;
      }).join('');
    $('#tab-expenses').innerHTML = `
      <div class="section-head"><h2>Expenses</h2><div class="section-actions">${pastToggleHtml()}<button class="primary" id="addExpenseBtn">Add expense</button></div></div>
      <div class="expense-overview">
        <h3>Expense budget overview</h3>
        <div class="table-wrap"><table class="expense-summary-table"><thead><tr>
          <th rowspan="2">Project</th><th colspan="3">Travel</th><th colspan="3">Material</th>
        </tr><tr><th>Budget</th><th>Spent</th><th>Left</th><th>Budget</th><th>Spent</th><th>Left</th></tr></thead><tbody>
          ${overviewRows || '<tr><td colspan="7" class="muted">No projects to show.</td></tr>'}
        </tbody></table></div>
      </div>
      <div class="table-wrap"><table id="expensesTable" class="resizable-table"><thead><tr><th>Project</th><th>Category</th><th>Date</th><th>Amount</th><th>Notes</th><th></th></tr></thead><tbody>
      ${visibleExpenses().map(e => `<tr data-expense-id="${e.id}">
        <td><select ${fieldAttrs('expense', e.id, 'projectId')}>${projectOptions(e.projectId)}</select></td>
        <td><select ${fieldAttrs('expense', e.id, 'category')}><option value="travel" ${e.category === 'travel' ? 'selected' : ''}>Travel</option><option value="material" ${e.category === 'material' ? 'selected' : ''}>Material</option><option value="other" ${e.category === 'other' ? 'selected' : ''}>Other</option></select></td>
        <td>${input('date', e.date, fieldAttrs('expense', e.id, 'date'))}</td>
        <td>${input('money', e.amount, fieldAttrs('expense', e.id, 'amount'))}</td>
        <td><textarea ${fieldAttrs('expense', e.id, 'notes')}>${esc(e.notes)}</textarea></td>
        <td><button class="danger delete-expense" data-id="${e.id}">Delete</button></td>
      </tr>`).join('')}
      </tbody></table></div>`;
    $('#addExpenseBtn').onclick = () => addExpense();
    $$('.delete-expense', $('#tab-expenses')).forEach(b => b.onclick = () => deleteExpense(b.dataset.id));
    bindEditorFields($('#tab-expenses'));
    bindPastToggle($('#tab-expenses'));
    bindResizableTables($('#tab-expenses'));
  }

  // ─── Inline Editing System ───

  function fieldAttrs(entity, id, field) { return `data-entity="${entity}" data-id="${id}" data-field="${field}"`; }

  // Record the state snapshot at the moment a field edit begins (for undo granularity)
  function beginFieldEdit(el) {
    pendingEditSnapshot = JSON.stringify(serializableState());
    pendingEditElement = el;
  }

  // On the first input event for a given element, push the pre-edit snapshot
  // onto the undo stack so the entire field change is one undo step
  function recordFieldEdit(el) {
    if (pendingEditElement !== el || !pendingEditSnapshot) {
      pendingEditSnapshot = JSON.stringify(serializableState());
      pendingEditElement = el;
      return;
    }
    history.push(pendingEditSnapshot);
    if (history.length > 100) history.shift();
    future = [];
    pendingEditSnapshot = null;
    pendingEditElement = null;
    updateUndoButtons();
  }

  function endFieldEdit(el) {
    if (pendingEditElement === el) {
      pendingEditSnapshot = null;
      pendingEditElement = null;
    }
  }

  // Attach focus/input/blur handlers to all inline-editable fields
  function bindEditorFields(root) {
    $$('[data-entity]', root).forEach(el => {
      el.addEventListener('focus', () => {
        beginFieldEdit(el);
        if (el.classList.contains('money-input')) {
          if (numberValue(el.value) === 0) el.value = ''; else el.select();
        }
      });
      el.addEventListener('pointerdown', () => {
        if (document.activeElement !== el) beginFieldEdit(el);
      });
      if (el.classList.contains('money-input')) {
        el.addEventListener('blur', () => { el.value = formatNumber(numberValue(el.value), 2); endFieldEdit(el); });
      } else {
        el.addEventListener('blur', () => endFieldEdit(el));
      }
      el.addEventListener('input', () => { recordFieldEdit(el); updateModelFromElement(el, false); });
      el.addEventListener('change', () => { recordFieldEdit(el); updateModelFromElement(el, true); });
    });
  }

  // Write the DOM element's current value back into the state model
  function updateModelFromElement(el, refreshDerived) {
    let obj;
    if (el.dataset.entity === 'salary') {
      obj = getPerson(el.dataset.personId)?.salaryIntervals?.find(x => x.id === el.dataset.id);
    } else {
      const collection = ({ person: 'persons', project: 'projects', assignment: 'assignments', expense: 'expenses' })[el.dataset.entity];
      obj = state[collection]?.find(x => x.id === el.dataset.id);
    }
    if (!obj) return;
    const field = el.dataset.field;
    const numeric = ['monthlyCost', 'personnelBudget', 'travelBudget', 'materialBudget', 'ftePercent', 'amount'].includes(field);
    obj[field] = el.type === 'checkbox' ? el.checked : (numeric ? numberValue(el.value) : el.value);
    markDirty();
    if (field === 'hidden' && refreshDerived) { renderAll(); return; }
    if (refreshDerived) renderDerived();
  }

  // ─── CRUD Operations ───

  function addPerson() {
    snapshot();
    const p = { id: uid('person'), firstName: '', lastName: '', role: '', contractStart: '', contractEnd: '', salaryIntervals: [], notes: '', hidden: false };
    state.persons.push(p); renderPersons(); renderDerived(); focusFirst(`[data-person-id="${p.id}"]`);
  }

  // Auto-populate the start date of a new salary interval based on the previous one
  function addSalaryInterval(personId) {
    const person = getPerson(personId); if (!person) return;
    snapshot();
    const validIntervals = (person.salaryIntervals || []).filter(si => validDateString(si.end)).sort((a, b) => a.end.localeCompare(b.end));
    const previous = validIntervals.length ? validIntervals[validIntervals.length - 1] : null;
    const interval = { id: uid('salary'), start: previous ? addDays(previous.end, 1) : (person.contractStart || ''), end: person.contractEnd || '', monthlyCost: 0 };
    person.salaryIntervals.push(interval);
    renderPersons(); renderDerived();
    requestAnimationFrame(() => $(`[data-salary-id="${interval.id}"] input`)?.focus());
  }

  function deleteSalaryInterval(personId, salaryId) {
    const person = getPerson(personId); if (!person) return;
    snapshot();
    person.salaryIntervals = (person.salaryIntervals || []).filter(si => si.id !== salaryId);
    renderPersons(); renderDerived();
  }

  function addProject() {
    snapshot(); const p = { id: uid('project'), name: '', type: '', start: '', end: '', personnelBudget: 0, travelBudget: 0, materialBudget: 0, notes: '', hidden: false };
    state.projects.push(p); renderProjects(); renderDerived(); focusFirst(`[data-project-id="${p.id}"]`);
  }

  function addAssignment(defaults = {}) {
    snapshot(); const a = { id: uid('assignment'), personId: defaults.personId || '', projectId: defaults.projectId || '', start: defaults.start || '', end: defaults.end || '', ftePercent: defaults.ftePercent ?? 100, notes: '' };
    state.assignments.push(a); renderDerived(); return a;
  }

  function addExpense() {
    snapshot(); const e = { id: uid('expense'), projectId: '', category: 'travel', date: '', amount: 0, notes: '' };
    state.expenses.push(e); renderExpenses(); renderDerived(); focusFirst(`[data-expense-id="${e.id}"]`);
  }

  // Delete a person and cascade-remove all their assignments
  function deletePerson(id) {
    if (!confirm('Delete this person and all their assignments?')) return;
    snapshot(); state.persons = state.persons.filter(p => p.id !== id); state.assignments = state.assignments.filter(a => a.personId !== id); renderAll();
  }

  // Delete a project and cascade-remove its assignments and expenses
  function deleteProject(id) {
    if (!confirm('Delete this project, its assignments, and expenses?')) return;
    snapshot(); state.projects = state.projects.filter(p => p.id !== id); state.assignments = state.assignments.filter(a => a.projectId !== id); state.expenses = state.expenses.filter(e => e.projectId !== id); renderAll();
  }

  function deleteExpense(id) { snapshot(); state.expenses = state.expenses.filter(e => e.id !== id); renderExpenses(); renderDerived(); }

  function focusFirst(selector) {
    requestAnimationFrame(() => { const root = $(selector); const el = root?.querySelector('input,select,textarea'); el?.focus(); });
  }

  // ─── Derived / Computed UI Updates ───

  // Refresh all computed cells (costs, free budget, expense summaries) without
  // re-rendering entire tables
  function renderDerived() {
    renderDashboard();
    $$('[data-assignment-cost]').forEach(td => { const a = state.assignments.find(x => x.id === td.dataset.assignmentCost); td.textContent = formatMoney(assignmentCost(a)); });
    $$('[data-project-assigned]').forEach(td => td.textContent = formatMoney(projectAssigned(td.dataset.projectAssigned)));
    $$('[data-project-free]').forEach(td => { const p = getProject(td.dataset.projectFree); td.textContent = formatMoney(projectFreePersonnel(p)); });
    $$('[data-expense-summary]').forEach(td => {
      const p = getProject(td.dataset.projectId); if (!p) return;
      const travelSpent = projectExpense(p.id, 'travel');
      const materialSpent = projectExpense(p.id, 'material');
      const value = ({
        'travel-spent': travelSpent,
        'travel-left': numberValue(p.travelBudget) - travelSpent,
        'material-spent': materialSpent,
        'material-left': numberValue(p.materialBudget) - materialSpent
      })[td.dataset.expenseSummary];
      td.textContent = formatMoney(value);
    });
    if (activeTab === 'timeline') renderTimeline();
    
  }

  // ─── Timeline View ───

  // Determine the date range for the timeline from all visible entities
  function timelineBounds() {
    const starts = [], ends = [];
    visibleProjects().forEach(p => { if (validDateString(p.start)) starts.push(parseDate(p.start)); if (validDateString(p.end)) ends.push(parseDate(p.end)); });
    visiblePersons().forEach(p => { if (validDateString(p.contractStart)) starts.push(parseDate(p.contractStart)); if (validDateString(p.contractEnd)) ends.push(parseDate(p.contractEnd)); });
    visibleAssignments().forEach(a => { if (validDateString(a.start)) starts.push(parseDate(a.start)); if (validDateString(a.end)) ends.push(parseDate(a.end)); });
    if (!starts.length || !ends.length) { const now = new Date(); return [new Date(Date.UTC(now.getUTCFullYear(), 0, 1)), new Date(Date.UTC(now.getUTCFullYear() + 1, 11, 31))]; }
    const min = new Date(Math.min(...starts.map(d => d.getTime()))), max = new Date(Math.max(...ends.map(d => d.getTime())));
    return [new Date(Date.UTC(min.getUTCFullYear(), min.getUTCMonth(), 1)), new Date(Date.UTC(max.getUTCFullYear(), max.getUTCMonth() + 1, 0))];
  }

  // Generate an array of first-of-month dates between start and end (inclusive)
  function monthsBetween(start, end) {
    const arr = []; let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    while (d <= end) { arr.push(new Date(d)); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)); }
    return arr;
  }

  function renderTimeline() {
    const [min, max] = timelineBounds(); const months = monthsBetween(min, max); const width = months.length * MONTH_WIDTH;
    const now = new Date(); const currentYear = now.getFullYear(), currentMonth = now.getMonth();
    // Build year-group header spans
    const yearGroups = [];
    for (const m of months) {
      const year = m.getUTCFullYear();
      const last = yearGroups[yearGroups.length - 1];
      if (last && last.year === year) last.count++;
      else yearGroups.push({ year, count: 1 });
    }
    const yearHeader = yearGroups.map(g => `<div class="year-band" style="grid-column:span ${g.count}">${g.year}</div>`).join('');
    const monthHeader = months.map(m => `<div class="month-cell ${m.getUTCFullYear() === currentYear && m.getUTCMonth() === currentMonth ? 'current-month' : ''}"><span>${m.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}</span></div>`).join('');
    const header = `<div class="timeline-year-row">${yearHeader}</div><div class="timeline-month-row">${monthHeader}</div>`;
    $('#tab-timeline').innerHTML = `
      <div class="section-head"><h2>Assignments</h2><div class="section-actions">${pastToggleHtml()}<div class="help">Drag a person chip onto a project to create an assignment. Existing assignments can only be resized using their left or right edge. They may extend beyond the current contract or project end; planned extensions are striped and still count toward the budget. Hold Alt for day precision.</div></div></div>
      <div class="person-palette"><strong>Drag a person onto a project month:</strong>${visiblePersons().map((p, i) => `<span class="person-chip" draggable="true" data-drag-person="${p.id}" style="border-color:${colorFor(p.id)}">${esc(personName(p))}</span>`).join('')}</div>
      ${timelineShell('Project assignments', 'projectTimeline', projectTimelineLabels(), projectTimelineRows(min, months, width), header, width, min, max)}
      <div class="timeline-view-only-note">
        <strong>View only.</strong> Assignments are edited in the Project assignments above.
      </div>
      ${timelineShell('Personnel assignments', 'personTimeline', personTimelineLabels(), personTimelineRows(min, months, width), header, width, min, max)}
      <div id="assignmentEditorModal" class="assignment-modal" hidden>
        <div class="assignment-modal-backdrop" data-assignment-editor-close></div>
        <div class="assignment-modal-card" role="dialog" aria-modal="true" aria-labelledby="assignmentEditorTitle">
          <div class="assignment-modal-header">
            <div>
              <h3 id="assignmentEditorTitle">Edit assignment</h3>
              <div class="assignment-editor-context" id="assignmentEditorContext"></div>
            </div>
            <button type="button" class="assignment-modal-close" data-assignment-editor-close aria-label="Close">×</button>
          </div>

          <div class="assignment-modal-body">
            <div id="assignmentEditorPlanning" class="assignment-editor-planning" hidden></div>
            <label class="assignment-field">
              <span>FTE percentage</span>
              <div class="fte-input-wrap">
                <input id="assignmentEditorFte" type="text" inputmode="decimal" autocomplete="off">
                <span>%</span>
              </div>
            </label>

            <label class="assignment-field">
              <span>Notes</span>
              <textarea id="assignmentEditorNotes" rows="6" placeholder="Add a note about this assignment"></textarea>
            </label>
          </div>

          <div class="assignment-modal-footer">
            <button type="button" data-assignment-editor-close>Cancel</button>
            <button type="button" class="primary" id="assignmentEditorSave">Save changes</button>
          </div>
        </div>
      </div>
    `;
    bindPastToggle($('#tab-timeline')); bindTimelineScroll(); bindAssignmentDrag(min); bindAssignmentEditor(); bindPersonDrop(min); restoreScroll();
  }

  // Wrap a timeline section (labels column + scrollable canvas) in a shell
  function timelineShell(title, id, labels, rows, header, width, min, max) {
    const marker = currentMonthMarker(min, max);
    return `<div class="timeline-shell"><div class="timeline-title">${title}</div><div class="timeline-body">
      <div class="timeline-labels"><div class="timeline-label-spacer"></div>${labels}</div>
      <div class="timeline-scroll" id="${id}"><div class="timeline-canvas" style="width:${width}px"><div class="timeline-header">${header}</div>${marker}${rows}</div></div>
    </div></div>`;
  }

  // Render the "today" line and current-month highlight band
  function currentMonthMarker(min, max) {
    const now = new Date();
    const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const monthStart = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
    const monthEnd = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0));
    if (monthEnd < min || monthStart > max) return '';
    const left = dateToX(formatDate(monthStart), min);
    const right = dateToX(formatDate(addDays(formatDate(monthEnd), 1)), min);
    const todayX = dateToX(formatDate(today), min);
    return `<div class="current-month-band" style="left:${left}px;width:${Math.max(1, right - left)}px"></div><div class="today-line" style="left:${todayX}px" title="Today"></div>`;
  }

  // Filter to assignments that have valid, non-contradictory dates
  function validTimelineAssignments(assignments) {
    return assignments.filter(a =>
      validDateString(a.start) &&
      validDateString(a.end) &&
      parseDate(a.start) <= parseDate(a.end)
    );
  }

  // Timeline lane-packing: assigns each assignment to the first available
  // vertical lane so bars don't overlap. Uses a greedy first-fit approach
  // sorted by start date then end date.
  function packAssignmentLanes(assignments) {
    const sorted = [...validTimelineAssignments(assignments)].sort((a, b) =>
      a.start.localeCompare(b.start) || a.end.localeCompare(b.end)
    );
    const laneEnds = [];
    const packed = [];
    for (const assignment of sorted) {
      let lane = laneEnds.findIndex(end => end < assignment.start);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(assignment.end);
      } else {
        laneEnds[lane] = assignment.end;
      }
      packed.push({ assignment, lane });
    }
    return { packed, laneCount: Math.max(1, laneEnds.length) };
  }

  // Compute the pixel height for a timeline row based on the number of lanes
  function timelineRowHeight(assignments, minimumHeight, includeSalaryBand = false) {
    const { laneCount } = packAssignmentLanes(assignments);
    const contentHeight = TIMELINE_BAR_TOP +
      laneCount * TIMELINE_LANE_HEIGHT +
      TIMELINE_BOTTOM_PADDING +
      (includeSalaryBand ? TIMELINE_SALARY_HEIGHT : 0);
    return Math.max(minimumHeight, contentHeight);
  }

  function projectTimelineLabels() {
    const groups = groupProjects();
    let html = '';
    for (const [type, projects] of groups) {
      html += `<div class="group-label">${esc(type)}</div>`;
      for (const p of projects) {
        const assignments = visibleAssignments().filter(a => a.projectId === p.id);
        const height = timelineRowHeight(assignments, PROJECT_TIMELINE_MIN_HEIGHT);
        html += `<div class="timeline-label-row" style="height:${height}px">
          <strong>${esc(p.name || '(unnamed project)')}</strong>
          <div class="meta">
            <span>Duration</span><span>${esc(p.start)} – ${esc(p.end)}</span>
            <span>Budget</span><span>${formatMoney(p.personnelBudget)}</span>
            <span>Free</span><span>${formatMoney(projectFreePersonnel(p))}</span>
          </div>
        </div>`;
      }
    }
    return html || '<div class="timeline-label-row muted">No projects</div>';
  }

  function projectTimelineRows(min, months, width) {
    const groups = groupProjects();
    let html = '';
    for (const [, projects] of groups) {
      html += `<div class="group-grid" style="width:${width}px"></div>`;
      for (const p of projects) {
        html += timelineRow(
          'project',
          p.id,
          p.start,
          p.end,
          visibleAssignments().filter(a => a.projectId === p.id),
          min,
          months,
          width
        );
      }
    }
    return html || '';
  }

  // Sort persons by contract start for the person timeline ordering
  function timelinePersonsByContractStart() {
    return [...visiblePersons()].sort((a, b) =>
      String(a.contractStart || '9999-12-31').localeCompare(String(b.contractStart || '9999-12-31')) ||
      String(a.lastName || '').localeCompare(String(b.lastName || ''), undefined, { numeric: true, sensitivity: 'base' }) ||
      String(a.firstName || '').localeCompare(String(b.firstName || ''), undefined, { numeric: true, sensitivity: 'base' })
    );
  }

  function personTimelineLabels() {
    return timelinePersonsByContractStart()
      .map(p => {
        const assignments = visibleAssignments().filter(a => a.personId === p.id);
        const height = timelineRowHeight(assignments, PERSON_TIMELINE_MIN_HEIGHT, true);
        return `<div class="timeline-label-row" style="height:${height}px">
          <strong>${esc(personName(p))}</strong>
          <div class="meta">
            <span>Contract</span><span>${esc(p.contractStart)} – ${esc(p.contractEnd)}</span>
          </div>
        </div>`;
      }).join('') || '<div class="timeline-label-row muted">No persons</div>';
  }

  function personTimelineRows(min, months, width) {
    return timelinePersonsByContractStart()
      .map(p => timelineRow(
        'person',
        p.id,
        p.contractStart,
        p.contractEnd,
        visibleAssignments().filter(a => a.personId === p.id),
        min,
        months,
        width,
        p
      )).join('');
  }

  // Group visible projects by type, sorted alphabetically
  function groupProjects() {
    const map = new Map();
    visibleProjects().forEach(p => {
      const type = p.type || 'Other';
      if (!map.has(type)) map.set(type, []);
      map.get(type).push(p);
    });
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([type, projects]) => [
        type,
        projects.sort((a, b) =>
          String(a.start || '9999-12-31').localeCompare(String(b.start || '9999-12-31')) ||
          String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' })
        )
      ]);
  }

  function monthOverlapsRange(month, start, end) {
    if (!validDateString(start) || !validDateString(end)) return false;
    const monthStart = formatDate(monthStartFor(month));
    const monthEnd = formatDate(monthEndFor(month));
    return overlapDays(monthStart, monthEnd, start, end) > 0;
  }

  // Render a single timeline row: the background grid, assignment bars, and
  // optional salary interval bands (for person-mode rows)
  function timelineRow(mode, entityId, start, end, assignments, min, months, width, person = null) {
    const now = new Date();
    const grid = `<div class="timeline-row-grid">${months.map(month => {
      const active = monthOverlapsRange(month, start, end);
      const current = month.getUTCFullYear() === now.getFullYear() &&
        month.getUTCMonth() === now.getMonth();
      return `<div class="${active ? 'active-period' : ''} ${active && current ? 'current-month-cell' : ''}"></div>`;
    }).join('')}</div>`;

    const { packed, laneCount } = packAssignmentLanes(assignments);
    const minimumHeight = mode === 'project'
      ? PROJECT_TIMELINE_MIN_HEIGHT
      : PERSON_TIMELINE_MIN_HEIGHT;
    const includeSalaryBand = mode === 'person';
    const rowHeight = timelineRowHeight(assignments, minimumHeight, includeSalaryBand);

    const bars = packed.map(({ assignment, lane }) =>
      assignmentBar(assignment, mode, min, lane)
    ).join('');

    // Salary interval bands rendered below the assignment bars in person mode
    const salaryTop = TIMELINE_BAR_TOP + laneCount * TIMELINE_LANE_HEIGHT + 2;
    const salaryBands = includeSalaryBand && person
      ? [...(person.salaryIntervals || [])]
          .filter(si => validDateString(si.start) && validDateString(si.end))
          .sort((a, b) => a.start.localeCompare(b.start))
          .map((si, index) => {
            const left = dateToX(si.start, min);
            const right = dateToX(addDays(si.end, 1), min);
            const bandWidth = Math.max(4, right - left);
            const shade = index % 3;
            return `<div class="salary-interval-band salary-shade-${shade}"
              style="left:${left}px;width:${bandWidth}px;top:${salaryTop}px"
              title="${si.start} – ${si.end}: ${formatMoney(si.monthlyCost)} / month">
              <span>${formatMoney(si.monthlyCost)}</span>
            </div>`;
          }).join('')
      : '';

    const dropAttr = mode === 'project'
      ? `data-drop-project="${entityId}"`
      : `data-drop-person="${entityId}"`;

    return `<div class="timeline-row" ${dropAttr}
      style="width:${width}px;height:${rowHeight}px">
      ${grid}${bars}${salaryBands}
    </div>`;
  }

  // Determine whether an assignment extends beyond its person's contract or
  // project's end date, requiring a planned extension
  function assignmentPlanningStatus(a) {
    const person = getPerson(a.personId);
    const project = getProject(a.projectId);
    const contractExtension = Boolean(person && validDateString(person.contractEnd) && validDateString(a.end) && a.end > person.contractEnd);
    const projectExtension = Boolean(project && validDateString(project.end) && validDateString(a.end) && a.end > project.end);
    return { contractExtension, projectExtension, badge: contractExtension && projectExtension ? 'CP' : contractExtension ? 'C' : projectExtension ? 'P' : '' };
  }

  // Calculate the number of months between two dates, rounding up partial months
  function monthsExtension(fromDate, toDate) {
    if (!validDateString(fromDate) || !validDateString(toDate) || toDate <= fromDate) return 0;
    const from = parseDate(fromDate), to = parseDate(toDate);
    let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
    if (to.getUTCDate() > from.getUTCDate()) months += 1;
    return Math.max(1, months);
  }

  // How many months of contract extension a person needs based on their latest assignment
  function requiredContractExtension(personId) {
    const person = getPerson(personId);
    if (!person || !validDateString(person.contractEnd)) return 0;
    const latest = state.assignments.filter(a => a.personId === personId && validDateString(a.end)).map(a => a.end).sort().at(-1);
    return latest ? monthsExtension(person.contractEnd, latest) : 0;
  }

  // How many months of project extension a project needs based on its latest assignment
  function requiredProjectExtension(projectId) {
    const project = getProject(projectId);
    if (!project || !validDateString(project.end)) return 0;
    const latest = state.assignments.filter(a => a.projectId === projectId && validDateString(a.end)).map(a => a.end).sort().at(-1);
    return latest ? monthsExtension(project.end, latest) : 0;
  }

  // Striped overlay for the portion of an assignment that extends past the project end
  function plannedProjectOverlay(a, min, barLeft, barRight) {
    const project = getProject(a.projectId);
    if (!project || !validDateString(project.end) || !validDateString(a.end) || a.end <= project.end) return '';
    const plannedStart = a.start > project.end ? a.start : addDays(project.end, 1);
    const plannedLeft = Math.max(barLeft, dateToX(plannedStart, min));
    const left = Math.max(0, plannedLeft - barLeft);
    const width = Math.max(1, barRight - plannedLeft);
    return `<span class="assignment-planned-project-segment" style="left:${left}px;width:${width}px" title="Project extension required"></span>`;
  }

  // Striped overlay for the portion of an assignment that extends past the contract end
  function plannedContractOverlay(a, min, barLeft, barRight) {
    const person = getPerson(a.personId);
    if (!person || !validDateString(person.contractEnd) || !validDateString(a.end) || a.end <= person.contractEnd) return '';
    const plannedStart = a.start > person.contractEnd ? a.start : addDays(person.contractEnd, 1);
    const plannedLeft = Math.max(barLeft, dateToX(plannedStart, min));
    const left = Math.max(0, plannedLeft - barLeft);
    const width = Math.max(1, barRight - plannedLeft);
    return `<span class="assignment-planned-segment" style="left:${left}px;width:${width}px" title="Contract extension required"></span>`;
  }

  // Render a single assignment bar element in the timeline
  function assignmentBar(a, mode, min, lane) {
    if (!validDateString(a.start) || !validDateString(a.end)) return '';
    const left = dateToX(a.start, min);
    const right = dateToX(addDays(a.end, 1), min);
    const width = Math.max(8, right - left);
    const plannedOverlay = plannedContractOverlay(a, min, left, right);
    const plannedProject = plannedProjectOverlay(a, min, left, right);
    const planning = assignmentPlanningStatus(a);
    const planningBadge = planning.badge
      ? `<span class="assignment-planning-badge" title="${planning.badge === 'CP' ? 'Contract and project extension required' : planning.badge === 'C' ? 'Contract extension required' : 'Project extension required'}">${planning.badge}</span>`
      : '';
    const person = getPerson(a.personId);
    const project = getProject(a.projectId);
    const sourceName = project
      ? `${project.type ? `${project.type}: ` : ''}${project.name || '(missing project)'}`
      : '(missing project)';
    const label = mode === 'project'
      ? `${personName(person)} ${formatNumber(a.ftePercent, 1)}%`
      : `${sourceName} ${formatNumber(a.ftePercent, 1)}%`;
    const key = mode === 'project' ? a.personId : a.projectId;
    const top = TIMELINE_BAR_TOP + lane * TIMELINE_LANE_HEIGHT;
    const noteText = String(a.notes || '').trim();
    const planningLines = [
      planning.contractExtension ? '⚠ Contract extension required' : '',
      planning.projectExtension ? '⚠ Project extension required' : ''
    ].filter(Boolean).join('\n');
    const tooltip = `${label}\n${a.start} – ${a.end}` +
      `${planningLines ? `\n\n${planningLines}` : ''}` +
      `${noteText ? `\n\nNote: ${noteText}` : ''}`;

    // Person-mode bars are read-only (no resize handles)
    if (mode === 'person') {
      return `<div class="assignment-bar assignment-bar-readonly"
        style="left:${left}px;width:${width}px;top:${top}px;background:${colorFor(key)}"
        title="${esc(tooltip)}">
        ${plannedOverlay}${plannedProject}${planningBadge}<span class="assignment-label-text">${esc(label)}${String(a.notes || '').trim() ? '<span class="assignment-note-icon assignment-comment-icon" aria-label="Has notes">💬</span>' : ''}</span>
      </div>`;
    }

    // Project-mode bars have left/right resize handles
    return `<div class="assignment-bar assignment-bar-resize-only"
      data-assignment-bar="${a.id}"
      data-mode="${mode}"
      style="left:${left}px;width:${width}px;top:${top}px;background:${colorFor(key)}"
      title="${esc(tooltip)}">
      ${plannedOverlay}${plannedProject}${planningBadge}
      <span class="assignment-handle left" data-edge="left"></span>
      <span class="assignment-label-text">${esc(label)}${String(a.notes || '').trim() ? '<span class="assignment-note-icon assignment-comment-icon" aria-label="Has notes">💬</span>' : ''}</span>
      <span class="assignment-handle right" data-edge="right"></span>
    </div>`;
  }

  // Deterministic color assignment based on an entity's ID hash
  function colorFor(id) {
    let h = 0; for (const c of String(id || '')) h = ((h << 5) - h) + c.charCodeAt(0) | 0;
    return COLORS[Math.abs(h) % COLORS.length];
  }

  // Convert a date string to a pixel X position on the timeline
  function dateToX(dateString, min) {
    const d = parseDate(dateString); if (!d) return 0;
    const months = (d.getUTCFullYear() - min.getUTCFullYear()) * 12 + (d.getUTCMonth() - min.getUTCMonth());
    const dim = monthEndFor(d).getUTCDate();
    return months * MONTH_WIDTH + ((d.getUTCDate() - 1) / dim) * MONTH_WIDTH;
  }

  // Convert a pixel X position back to a date string; when dayPrecision is
  // true (Alt key held), resolves to the nearest day; otherwise snaps to month start
  function xToDate(x, min, dayPrecision) {
    const monthIndex = Math.max(0, Math.floor(x / MONTH_WIDTH));
    const fraction = (x - monthIndex * MONTH_WIDTH) / MONTH_WIDTH;
    const d = new Date(Date.UTC(min.getUTCFullYear(), min.getUTCMonth() + monthIndex, 1));
    if (dayPrecision) { const dim = monthEndFor(d).getUTCDate(); d.setUTCDate(Math.min(dim, Math.max(1, Math.round(fraction * dim) + 1))); }
    return formatDate(d);
  }

  // ─── Timeline Scroll Sync ───

  // Keep project and person timeline scroll positions in lock-step
  function bindTimelineScroll() {
    const timelines = [$('#projectTimeline'), $('#personTimeline')].filter(Boolean);
    if (!timelines.length) return;

    const sync = source => {
      if (syncingScroll) return;
      syncingScroll = true;
      for (const target of timelines) if (target !== source) target.scrollLeft = source.scrollLeft;
      scrollMemory.project = source.scrollLeft;
      scrollMemory.person = source.scrollLeft;
      syncingScroll = false;
    };

    timelines.forEach(t => t.addEventListener('scroll', () => sync(t)));

    // Enable click-and-drag panning on the timeline canvas
    const enablePan = source => {
      source.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        if (e.target.closest('.assignment-bar, .assignment-handle, button, input, select, textarea, a, .person-chip')) return;
        const startX = e.clientX;
        const startScroll = source.scrollLeft;
        source.classList.add('panning');
        source.setPointerCapture(e.pointerId);
        const move = ev => {
          source.scrollLeft = startScroll - (ev.clientX - startX);
          sync(source);
        };
        const stop = () => {
          source.classList.remove('panning');
          source.removeEventListener('pointermove', move);
          source.removeEventListener('pointerup', stop);
          source.removeEventListener('pointercancel', stop);
        };
        source.addEventListener('pointermove', move);
        source.addEventListener('pointerup', stop);
        source.addEventListener('pointercancel', stop);
      });
    };
    timelines.forEach(enablePan);
  }

  function restoreScroll() { requestAnimationFrame(() => { const p = $('#projectTimeline'), q = $('#personTimeline'); if (p) p.scrollLeft = scrollMemory.project; if (q) q.scrollLeft = scrollMemory.person; }); }

  // ─── Assignment Editor Modal ───

  // Double-click an assignment bar to open a modal for editing FTE and notes
  function bindAssignmentEditor() {
    const modal = $('#assignmentEditorModal');
    const fteInput = $('#assignmentEditorFte');
    const notesInput = $('#assignmentEditorNotes');
    const context = $('#assignmentEditorContext');
    const planningBox = $('#assignmentEditorPlanning');
    const saveButton = $('#assignmentEditorSave');
    if (!modal || !fteInput || !notesInput || !context || !planningBox || !saveButton) return;

    const closeModal = () => {
      modal.hidden = true;
      modal.dataset.assignmentId = '';
      document.body.classList.remove('modal-open');
    };

    $$('[data-assignment-editor-close]', modal).forEach(button => {
      button.onclick = closeModal;
    });

    modal.onkeydown = event => {
      if (event.key === 'Escape') closeModal();
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') saveButton.click();
    };

    $$('[data-assignment-bar]').forEach(bar => {
      bar.ondblclick = event => {
        event.preventDefault();
        event.stopPropagation();

        const assignment = state.assignments.find(a => a.id === bar.dataset.assignmentBar);
        if (!assignment) return;

        const person = getPerson(assignment.personId);
        const project = getProject(assignment.projectId);

        modal.dataset.assignmentId = assignment.id;
        context.innerHTML = `
          <strong>${esc(personName(person))}</strong>
          <span>${esc(project?.type || 'Other')}: ${esc(project?.name || '(missing project)')}</span>
          <span>${assignment.start} to ${assignment.end}</span>
        `;
        fteInput.value = formatNumber(assignment.ftePercent, 1);
        notesInput.value = assignment.notes || '';
        const planning = assignmentPlanningStatus(assignment);
        const planningItems = [
          planning.contractExtension ? '<div>🟡 Contract extension required</div>' : '',
          planning.projectExtension ? '<div>🟡 Project extension required</div>' : ''
        ].filter(Boolean).join('');
        planningBox.innerHTML = planningItems;
        planningBox.hidden = !planningItems;

        modal.hidden = false;
        document.body.classList.add('modal-open');
        requestAnimationFrame(() => {
          fteInput.focus();
          fteInput.select();
        });
      };
    });

    saveButton.onclick = () => {
      const assignment = state.assignments.find(a => a.id === modal.dataset.assignmentId);
      if (!assignment) {
        closeModal();
        return;
      }

      const nextFte = numberValue(fteInput.value);
      const nextNotes = notesInput.value;

      if (nextFte < 0 || nextFte > 1000) {
        alert('Please enter a valid FTE percentage.');
        fteInput.focus();
        return;
      }

      if (nextFte !== numberValue(assignment.ftePercent) || nextNotes !== String(assignment.notes || '')) {
        snapshot();
        assignment.ftePercent = nextFte;
        assignment.notes = nextNotes;
        markDirty();
      }

      closeModal();
      renderAll();
    };
  }

  // ─── Assignment Resize / Delete Drag ───

  // Pointer-based drag: dragging left/right edges resizes the assignment;
  // dragging the bar body off its project row deletes the assignment
  function bindAssignmentDrag(min) {
    $$('[data-assignment-bar]').forEach(bar => bar.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;

      const assignment = state.assignments.find(x => x.id === bar.dataset.assignmentBar);
      if (!assignment) return;
      const person = getPerson(assignment.personId);
      const project = getProject(assignment.projectId);
      if (!person || !project) return;

      const handle = e.target.closest('.assignment-handle');
      const edge = handle?.dataset.edge;
      const isResize = edge === 'left' || edge === 'right';
      const isDeleteDrag = !handle && bar.dataset.mode === 'project';
      if (!isResize && !isDeleteDrag) return;

      e.preventDefault();
      e.stopPropagation();

      scrollMemory.project = $('#projectTimeline')?.scrollLeft || 0;
      scrollMemory.person = $('#personTimeline')?.scrollLeft || 0;

      const currentRow = bar.closest('[data-drop-project]');
      const oldStart = assignment.start;
      const oldEnd = assignment.end;
      const startX = e.clientX;
      const startY = e.clientY;
      let changed = false;
      let deleteDragActivated = false;

      // Earliest allowed start is the later of the person's contract start and project start
      const sourceStart = project.start || '';
      const validStart = [person.contractStart, sourceStart]
        .filter(validDateString)
        .sort()
        .at(-1) || '';

      const clearPreview = () => {
        currentRow?.querySelectorAll('.contract-preview, .valid-drop-preview').forEach(el => el.remove());
      };

      snapshot();
      clearPreview();
      bar.classList.add('dragging');
      if (isDeleteDrag) bar.classList.add('delete-dragging');
      bar.setPointerCapture(e.pointerId);

      // Floating tooltip showing current dates during resize
      const dragTip = document.createElement('div');
      dragTip.className = 'drag-date-tooltip';
      dragTip.hidden = true;
      document.body.appendChild(dragTip);

      const updateTip = ev => {
        if (isDeleteDrag) {
          const rowUnderPointer = document.elementsFromPoint(ev.clientX, ev.clientY)
            .find(el => el.matches?.('[data-drop-project]'));
          const overOriginalRow = rowUnderPointer?.dataset.dropProject === assignment.projectId;
          dragTip.hidden = false;
          dragTip.textContent = overOriginalRow
            ? 'Release here to keep assignment'
            : 'Release to delete assignment';
          dragTip.classList.toggle('delete-ready', !overOriginalRow);
        } else if (ev.altKey) {
          dragTip.hidden = false;
          dragTip.textContent = `${assignment.start} → ${assignment.end}`;
          dragTip.classList.remove('delete-ready');
        } else {
          dragTip.hidden = true;
        }

        if (!dragTip.hidden) {
          dragTip.style.left = `${Math.min(window.innerWidth - 260, ev.clientX + 14)}px`;
          dragTip.style.top = `${Math.max(8, ev.clientY - 38)}px`;
        }
      };

      const move = ev => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;

        // Delete drag: move the bar visually, show delete hint
        if (isDeleteDrag) {
          if (!deleteDragActivated && Math.hypot(dx, dy) < 6) return;
          deleteDragActivated = true;
          bar.style.transform = `translate(${dx}px, ${dy}px)`;
          updateTip(ev);
          return;
        }

        // Resize: convert mouse delta to date, clamped to valid bounds
        const dayPrecision = ev.altKey;
        if (edge === 'left') {
          let nextStart = xToDate(dateToX(oldStart, min) + dx, min, dayPrecision);
          if (validStart && nextStart < validStart) nextStart = validStart;
          if (nextStart > assignment.end) nextStart = assignment.end;
          assignment.start = nextStart;
        } else {
          const oldEndX = dateToX(addDays(oldEnd, 1), min);
          let nextEnd = addDays(xToDate(oldEndX + dx, min, dayPrecision), -1);

          if (nextEnd < assignment.start) nextEnd = assignment.start;
          assignment.end = nextEnd;
        }

        changed = assignment.start !== oldStart || assignment.end !== oldEnd;
        const left = dateToX(assignment.start, min);
        const right = dateToX(addDays(assignment.end, 1), min);
        bar.style.left = `${left}px`;
        bar.style.width = `${Math.max(8, right - left)}px`;
        updateTip(ev);
      };

      const cleanup = () => {
        clearPreview();
        dragTip.remove();
        bar.classList.remove('dragging', 'delete-dragging');
        bar.style.transform = '';
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', finish);
        bar.removeEventListener('pointercancel', cancel);
      };

      const finish = ev => {
        if (isDeleteDrag) {
          if (!deleteDragActivated) {
            cleanup();
            history.pop();
            updateUndoButtons();
            return;
          }

          const rowUnderPointer = document.elementsFromPoint(ev.clientX, ev.clientY)
            .find(el => el.matches?.('[data-drop-project]'));
          const overOriginalRow = rowUnderPointer?.dataset.dropProject === assignment.projectId;

          cleanup();
          if (!overOriginalRow) {
            state.assignments = state.assignments.filter(a => a.id !== assignment.id);
            markDirty();
          } else {
            history.pop();
            updateUndoButtons();
          }
          renderAll();
          return;
        }

        cleanup();
        if (!changed) {
          history.pop();
          updateUndoButtons();
        } else {
          markDirty();
        }
        renderAll();
      };

      const cancel = () => {
        assignment.start = oldStart;
        assignment.end = oldEnd;
        cleanup();
        history.pop();
        updateUndoButtons();
        renderAll();
      };

      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', finish);
      bar.addEventListener('pointercancel', cancel);
    }));
  }

  // ─── Person Drag-and-Drop onto Timeline ───

  // Handles dragging person chips from the palette onto project timeline
  // rows to create new assignments, with contract/project preview overlays
  function bindPersonDrop(min) {
    let draggedPersonId = '';
    let dragPreviewTip = null;

    const clearContractPreview = () => {
      $$('.contract-preview, .valid-drop-preview').forEach(el => el.remove());
      $$('.timeline-row.drop-hover').forEach(row => row.classList.remove('drop-hover'));
      dragPreviewTip?.remove();
      dragPreviewTip = null;
      draggedPersonId = '';
    };

    const ensureTip = () => {
      if (dragPreviewTip) return dragPreviewTip;
      dragPreviewTip = document.createElement('div');
      dragPreviewTip.className = 'contract-drag-tooltip';
      document.body.appendChild(dragPreviewTip);
      return dragPreviewTip;
    };

    // Show contract and valid-drop preview strips on every project row
    const addPreviewToRows = personId => {
      const person = getPerson(personId);
      if (!person || !validDateString(person.contractStart) || !validDateString(person.contractEnd)) return;

      $$('[data-drop-project]').forEach(row => {
        const project = getProject(row.dataset.dropProject);
        if (!project) return;

        const contractLeft = dateToX(person.contractStart, min);
        const contractRight = dateToX(addDays(person.contractEnd, 1), min);
        const contract = document.createElement('div');
        contract.className = 'contract-preview';
        contract.style.left = `${contractLeft}px`;
        contract.style.width = `${Math.max(1, contractRight - contractLeft)}px`;
        row.appendChild(contract);

        const sourceStart = project.start || '';
        const sourceEnd = project.end || '';
        if (validDateString(sourceStart) && validDateString(sourceEnd)) {
          const validLeft = dateToX(sourceStart, min);
          const validRight = dateToX(addDays(sourceEnd, 1), min);
          const valid = document.createElement('div');
          valid.className = 'valid-drop-preview';
          valid.style.left = `${validLeft}px`;
          valid.style.width = `${Math.max(1, validRight - validLeft)}px`;
          row.appendChild(valid);
        }
      });
    };

    $$('[data-drag-person]').forEach(chip => {
      chip.addEventListener('dragstart', e => {
        draggedPersonId = chip.dataset.dragPerson;
        e.dataTransfer.setData('text/person-id', draggedPersonId);
        e.dataTransfer.effectAllowed = 'copy';
        addPreviewToRows(draggedPersonId);
      });
      chip.addEventListener('dragend', clearContractPreview);
    });

    $$('[data-drop-project]').forEach(row => {

      row.addEventListener('dragover', e => {
        if (!e.dataTransfer.types.includes('text/person-id')) return;
        e.preventDefault();
        row.classList.add('drop-hover');

        // Show contextual tooltip with contract/project dates
        const personId = draggedPersonId || e.dataTransfer.getData('text/person-id');
        const person = getPerson(personId);
        const project = getProject(row.dataset.dropProject);
        if (!person || !project) return;

        const tip = ensureTip();
        tip.innerHTML = `<strong>${esc(personName(person))}</strong><br>` +
          `Contract: ${esc(person.contractStart)} – ${esc(person.contractEnd)}<br>` +
          `Project: ${esc(project.start)} – ${esc(project.end)}<br>` +
          `After ${esc(person.contractEnd)}: planned employment`;
        tip.style.left = `${e.clientX + 14}px`;
        tip.style.top = `${e.clientY + 14}px`;
      });

      row.addEventListener('dragleave', e => {
        if (!row.contains(e.relatedTarget)) row.classList.remove('drop-hover');
      });

      // On drop: compute start/end from the drop X position, clamp to
      // contract and project bounds, then create the assignment
      row.addEventListener('drop', e => {
        e.preventDefault();
        row.classList.remove('drop-hover');
        const personId = e.dataTransfer.getData('text/person-id');
        const projectId = row.dataset.dropProject;
        const rect = row.getBoundingClientRect();
        const x = e.clientX - rect.left;
        let start = xToDate(x, min, e.altKey);
        let end = e.altKey ? start : formatDate(monthEndFor(parseDate(start)));
        const person = getPerson(personId), project = getProject(projectId);
        if (person?.contractStart && start < person.contractStart) start = person.contractStart;
        if (project?.start && start < project.start) start = project.start;
        if (project?.end && end > project.end) end = project.end;
        if (start > end) {
          clearContractPreview();
          alert('The drop date is outside the project duration or before the contract starts.');
          return;
        }
        scrollMemory.project = $('#projectTimeline')?.scrollLeft || 0;
        scrollMemory.person = $('#personTimeline')?.scrollLeft || 0;
        clearContractPreview();
        addAssignment({ personId, projectId, start, end, ftePercent: 100 });
        markDirty();
        renderDerived();
      });
    });
  }

  // ─── Top-Level Render & Tab Switching ───

  function renderAll() {
    renderPersons(); renderProjects(); renderExpenses(); renderTimeline(); renderDashboard(); switchTab(activeTab); updateUndoButtons();
  }

  function switchTab(name) {
    activeTab = name; $$('.header-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name)); $$('.tab').forEach(t => t.classList.toggle('active', t.id === `tab-${name}`)); if (name === 'timeline') renderTimeline();
  }

  // ─── Dirty State & File Status ───

  function confirmDiscardChanges(actionText = 'continue') {
    if (!isDirty) return true;
    return confirm(`You have unsaved changes. They will be lost if you ${actionText}. Continue?`);
  }

  function markDirty() {
    isDirty = true;
    $('#fileStatus').textContent = currentFileName
      ? `${currentFileName} • modified`
      : 'Unsaved project • modified';
  }
  function markSaved() {
    isDirty = false;
    $('#fileStatus').textContent = currentFileName || 'Unsaved project';
  }
  function markUnsaved() {
    isDirty = false;
    $('#fileStatus').textContent = 'Unsaved project';
  }

  // ─── File I/O ───

  // Open a JSON project file using the File System Access API when available,
  // falling back to a hidden <input type="file"> element
  async function openFile() {
    if (!confirmDiscardChanges('open another project')) return;
    try {
      if ('showOpenFilePicker' in window) {
        const [handle] = await window.showOpenFilePicker({ types: [{ description: 'JSON files', accept: { 'application/json': ['.json'] } }], multiple: false });
        const file = await handle.getFile(); const raw = JSON.parse(await file.text()); fileHandle = handle; currentFileName = file.name; state = normalizeState(raw);
      } else {
        const raw = await pickJsonFallback(); state = normalizeState(raw.data); currentFileName = raw.name; fileHandle = null;
      }
      history = []; future = []; pendingEditSnapshot = null; pendingEditElement = null; renderAll(); markSaved();
    } catch (err) { if (err?.name !== 'AbortError') alert(`Could not open file: ${err.message}`); }
  }

  // Fallback file picker for browsers without File System Access API
  function pickJsonFallback() {
    return new Promise((resolve, reject) => { const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json'; inp.onchange = async () => { try { const file = inp.files[0]; if (!file) return reject(new DOMException('Cancelled', 'AbortError')); resolve({ data: JSON.parse(await file.text()), name: file.name }); } catch (e) { reject(e); } }; inp.click(); });
  }

  // Save to the existing file handle, or prompt for a new location.
  // Falls back to a download blob in unsupported browsers.
  async function saveFile(saveAs = false) {
    const text = JSON.stringify(serializableState(), null, 2);
    try {
      if ('showSaveFilePicker' in window) {
        if (saveAs || !fileHandle) fileHandle = await window.showSaveFilePicker({ suggestedName: currentFileName || 'research-group-planner.json', types: [{ description: 'JSON files', accept: { 'application/json': ['.json'] } }] });
        const writable = await fileHandle.createWritable(); await writable.write(text); await writable.close(); currentFileName = (await fileHandle.getFile()).name;
      } else {
        const blob = new Blob([text], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = currentFileName || 'research-group-planner.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }
      markSaved();
    } catch (err) { if (err?.name !== 'AbortError') alert(`Could not save file: ${err.message}`); }
  }

  // Load sample data from a bundled JSON file
  async function loadTestData() {
    const hasCurrentData =
      Boolean(currentFileName) ||
      state.persons.length > 0 ||
      state.projects.length > 0 ||
      state.assignments.length > 0 ||
      state.expenses.length > 0;

    if (isDirty) {
      if (!confirmDiscardChanges('load the test data')) return;
    } else if (hasCurrentData) {
      const proceed = confirm(
        'Loading the test data will replace the currently open project. Continue?'
      );
      if (!proceed) return;
    }

    try {
      const response = await fetch('research-group-planner-testdata.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const raw = await response.json();
      snapshot();
      state = normalizeState(raw);
      fileHandle = null;
      currentFileName = 'research-group-planner-testdata.json';
      history = [];
      future = [];
      pendingEditSnapshot = null;
      pendingEditElement = null;
      renderAll();
      markSaved();
    } catch (err) {
      alert(
        'Could not load test data file.\n\n' +
        'When running locally, please open research-group-planner-testdata.json via Open....'
      );
    }
  }

  function newProject() {
    if (!confirmDiscardChanges('create a new project')) return;
    if (!confirm('Start a new empty project? Unsaved changes will be lost.')) return;
    state = emptyState(); fileHandle = null; currentFileName = ''; history = []; future = []; pendingEditSnapshot = null; pendingEditElement = null; renderAll(); markUnsaved();
  }

  // ─── Resizable Table Columns ───

  const COLUMN_WIDTH_STORAGE_KEY = 'research-group-planner-column-widths-v1';

  function loadColumnWidths() {
    try { return JSON.parse(localStorage.getItem(COLUMN_WIDTH_STORAGE_KEY) || '{}'); }
    catch (_) { return {}; }
  }

  function saveColumnWidths(widths) {
    try { localStorage.setItem(COLUMN_WIDTH_STORAGE_KEY, JSON.stringify(widths)); }
    catch (_) {}
  }

  // Attach resize handles to every <th> in resizable tables; persist
  // widths to localStorage keyed by table ID and column index
  function bindResizableTables(root = document) {
    const stored = loadColumnWidths();
    root.querySelectorAll('table.resizable-table').forEach(table => {
      if (table.dataset.resizableBound === 'true') return;
      table.dataset.resizableBound = 'true';
      const tableKey = table.id || 'table';
      const headers = [...table.querySelectorAll('thead tr:first-child > th')];
      headers.forEach((th, index) => {
        const savedWidth = stored[tableKey]?.[index];
        if (Number.isFinite(savedWidth) && savedWidth >= 60) {
          th.style.width = `${savedWidth}px`;
          th.style.minWidth = `${savedWidth}px`;
          th.style.maxWidth = `${savedWidth}px`;
        }
        th.classList.add('resizable-column-header');
        const handle = document.createElement('span');
        handle.className = 'column-resize-handle';
        handle.setAttribute('aria-hidden', 'true');
        th.appendChild(handle);
        handle.addEventListener('pointerdown', event => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          const startX = event.clientX;
          const startWidth = th.getBoundingClientRect().width;
          handle.setPointerCapture(event.pointerId);
          document.body.classList.add('resizing-column');
          const move = moveEvent => {
            const nextWidth = Math.max(60, Math.round(startWidth + moveEvent.clientX - startX));
            th.style.width = `${nextWidth}px`;
            th.style.minWidth = `${nextWidth}px`;
            th.style.maxWidth = `${nextWidth}px`;
          };
          const stop = stopEvent => {
            const finalWidth = Math.round(th.getBoundingClientRect().width);
            stored[tableKey] = stored[tableKey] || {};
            stored[tableKey][index] = finalWidth;
            saveColumnWidths(stored);
            document.body.classList.remove('resizing-column');
            try { handle.releasePointerCapture(stopEvent.pointerId); } catch (_) {}
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', stop);
            handle.removeEventListener('pointercancel', stop);
          };
          handle.addEventListener('pointermove', move);
          handle.addEventListener('pointerup', stop);
          handle.addEventListener('pointercancel', stop);
        });
      });
    });
  }

  // ─── Global Event Binding ───

  function bindGlobal() {
    $('#newBtn').onclick = newProject; $('#openBtn').onclick = openFile; $('#loadTestDataBtn').onclick = loadTestData; $('#saveBtn').onclick = () => saveFile(false); $('#saveAsBtn').onclick = () => saveFile(true); $('#undoBtn').onclick = undo; $('#redoBtn').onclick = redo;
    $$('.header-tabs button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
    // Keyboard shortcuts: Ctrl/Cmd+S to save, Ctrl/Cmd+Z to undo, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y to redo
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(false); }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); }
    });
  }

  // Warn before the browser unloads the page if there are unsaved changes
  window.addEventListener('beforeunload', event => {
    if (!isDirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  // ─── Bootstrap ───
  bindGlobal(); renderAll(); markUnsaved();
})();
