import { Hono } from 'hono';
import { db, registerMigration } from '../../db.js';
import { z } from 'zod';

// ─── Database migrations ────────────────────────────────────────────────────

// ─── Database migrations ────────────────────────────────────────────────────

// ─── Database migrations ────────────────────────────────────────────────────

const router = new Hono();

router.get('/', (c) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TaskFlow</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f0; color: #1a1a1a; min-height: 100vh; display: flex; }

  /* Layout */
  #sidebar { width: 240px; min-width: 240px; background: #2c2c2c; color: #e0e0e0; display: flex; flex-direction: column; padding: 16px 0; height: 100vh; position: sticky; top: 0; overflow-y: auto; }
  #main { flex: 1; overflow-y: auto; padding: 32px 24px; }
  #content { max-width: 800px; margin: 0 auto; }

  /* Sidebar */
  .sidebar-title { font-size: 18px; font-weight: 700; color: #fff; padding: 0 16px 16px; border-bottom: 1px solid #444; }
  .sidebar-section { padding: 12px 0; }
  .sidebar-section-label { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #888; padding: 0 16px 6px; }
  .sidebar-item { display: flex; align-items: center; gap: 8px; padding: 8px 16px; cursor: pointer; border-radius: 0; transition: background .15s; font-size: 14px; color: #ccc; user-select: none; }
  .sidebar-item:hover { background: #3a3a3a; color: #fff; }
  .sidebar-item.active { background: #4a4a4a; color: #fff; font-weight: 600; }
  .sidebar-item .count { margin-left: auto; background: #555; color: #ccc; border-radius: 10px; padding: 1px 7px; font-size: 11px; }
  .sidebar-item.active .count { background: #666; color: #fff; }
  .color-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .add-project-btn { display: flex; align-items: center; gap: 6px; padding: 6px 16px; font-size: 13px; color: #888; cursor: pointer; background: none; border: none; width: 100%; text-align: left; }
  .add-project-btn:hover { color: #ccc; }

  /* Header */
  .view-title { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
  .view-stats { font-size: 13px; color: #777; margin-bottom: 20px; }

  /* Add task form */
  #add-task-form { background: #fff; border-radius: 10px; border: 1.5px solid #e0e0e0; padding: 14px 16px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  #add-task-form input[type=text], #add-task-form textarea, #add-task-form select, #add-task-form input[type=date] {
    width: 100%; border: none; outline: none; font-family: inherit; font-size: 14px; color: #1a1a1a; background: transparent; resize: none;
  }
  #task-title-input { font-size: 15px; font-weight: 500; padding: 2px 0 8px; border-bottom: 1px solid #eee; margin-bottom: 8px; }
  #task-title-input::placeholder { color: #aaa; }
  #task-desc-toggle { font-size: 12px; color: #aaa; cursor: pointer; margin-bottom: 6px; display: inline-block; }
  #task-desc-toggle:hover { color: #666; }
  #task-desc-area { display: none; margin-bottom: 8px; }
  #task-desc-area textarea { border: 1px solid #e8e8e8; border-radius: 6px; padding: 6px 8px; min-height: 60px; font-size: 13px; }
  .form-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
  .form-row select, .form-row input[type=date] {
    border: 1px solid #e0e0e0; border-radius: 6px; padding: 5px 8px; font-size: 13px; background: #fafafa; cursor: pointer;
  }
  .form-row select:focus, .form-row input[type=date]:focus { border-color: #aaa; outline: none; }
  .btn { padding: 7px 16px; border-radius: 6px; border: none; cursor: pointer; font-family: inherit; font-size: 13px; font-weight: 600; transition: background .15s, opacity .15s; }
  .btn-primary { background: #db4035; color: #fff; }
  .btn-primary:hover { background: #c0392b; }
  .btn-secondary { background: #f0f0ee; color: #555; }
  .btn-secondary:hover { background: #e4e4e0; }
  .btn-sm { padding: 4px 10px; font-size: 12px; }
  .spacer { flex: 1; }

  /* Filters */
  .filter-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .filter-group { display: flex; gap: 2px; background: #e8e8e4; border-radius: 8px; padding: 3px; }
  .filter-btn { padding: 5px 12px; border-radius: 6px; border: none; font-family: inherit; font-size: 13px; cursor: pointer; background: transparent; color: #666; font-weight: 500; transition: background .15s; }
  .filter-btn.active { background: #fff; color: #1a1a1a; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  .filter-btn:hover:not(.active) { background: rgba(255,255,255,.5); }
  .priority-filter { border: 1px solid #ddd; border-radius: 6px; padding: 5px 10px; font-family: inherit; font-size: 13px; background: #fff; cursor: pointer; color: #555; }

  /* Task list */
  #task-list { display: flex; flex-direction: column; gap: 6px; }
  .task-card { background: #fff; border-radius: 8px; border: 1px solid #e8e8e4; padding: 10px 14px; display: flex; align-items: flex-start; gap: 10px; position: relative; transition: box-shadow .15s, border-color .15s; }
  .task-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,.08); border-color: #d4d4d0; }
  .task-card.overdue { border-left: 3px solid #e74c3c; }
  .task-card.completed-card { opacity: .6; }
  .task-checkbox { width: 18px; height: 18px; border-radius: 50%; border: 2px solid #ccc; flex-shrink: 0; cursor: pointer; margin-top: 2px; display: flex; align-items: center; justify-content: center; transition: border-color .15s, background .15s; }
  .task-checkbox:hover { border-color: #999; }
  .task-checkbox.checked { background: #27ae60; border-color: #27ae60; }
  .task-checkbox.checked::after { content: '✓'; color: #fff; font-size: 11px; line-height: 1; }
  .task-body { flex: 1; min-width: 0; }
  .task-title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .task-title { font-size: 14px; font-weight: 500; line-height: 1.4; cursor: pointer; }
  .task-title:hover { text-decoration: underline; }
  .completed-card .task-title { text-decoration: line-through; color: #aaa; }
  .priority-badge { font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; letter-spacing: .04em; flex-shrink: 0; }
  .priority-urgent { background: #fde8e8; color: #c0392b; }
  .priority-high { background: #fef0e0; color: #d35400; }
  .priority-normal { background: #e8f0fe; color: #2563eb; }
  .priority-low { background: #f0f0f0; color: #888; }
  .overdue-badge { font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 4px; background: #fde8e8; color: #c0392b; }
  .task-meta { display: flex; align-items: center; gap: 8px; margin-top: 4px; flex-wrap: wrap; }
  .task-meta-item { font-size: 12px; color: #999; display: flex; align-items: center; gap: 3px; }
  .task-meta-item .dot { width: 7px; height: 7px; border-radius: 50%; }
  .task-desc { font-size: 13px; color: #777; margin-top: 4px; line-height: 1.5; }
  .task-actions { display: flex; gap: 4px; align-items: center; opacity: 0; transition: opacity .15s; flex-shrink: 0; }
  .task-card:hover .task-actions { opacity: 1; }
  .action-btn { background: none; border: none; cursor: pointer; padding: 4px 6px; border-radius: 4px; font-size: 14px; color: #999; transition: background .12s, color .12s; }
  .action-btn:hover { background: #f0f0ee; color: #444; }
  .action-btn.delete-btn:hover { background: #fde8e8; color: #c0392b; }

  /* Edit form inline */
  .edit-form { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
  .edit-form input[type=text], .edit-form textarea, .edit-form select, .edit-form input[type=date] {
    border: 1px solid #ddd; border-radius: 6px; padding: 6px 8px; font-family: inherit; font-size: 13px; width: 100%;
  }
  .edit-form input:focus, .edit-form textarea:focus, .edit-form select:focus { border-color: #999; outline: none; }
  .edit-form .form-row { margin-top: 0; }

  /* Modal for project creation */
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 100; display: flex; align-items: center; justify-content: center; }
  .modal { background: #fff; border-radius: 12px; padding: 24px; width: 340px; box-shadow: 0 8px 32px rgba(0,0,0,.18); }
  .modal h3 { font-size: 17px; margin-bottom: 16px; }
  .modal label { font-size: 13px; color: #555; display: block; margin-bottom: 4px; }
  .modal input[type=text] { width: 100%; border: 1px solid #ddd; border-radius: 6px; padding: 8px 10px; font-family: inherit; font-size: 14px; margin-bottom: 12px; }
  .modal input:focus { border-color: #999; outline: none; }
  .color-picker { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .color-swatch { width: 26px; height: 26px; border-radius: 50%; cursor: pointer; border: 3px solid transparent; transition: border-color .12s; }
  .color-swatch.selected { border-color: #333; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; }

  /* Empty state */
  .empty-state { text-align: center; padding: 60px 20px; color: #aaa; }
  .empty-state .icon { font-size: 48px; margin-bottom: 12px; }
  .empty-state p { font-size: 15px; }

  /* Archived badge */
  .archived-badge { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: #f0f0f0; color: #999; }
</style>
</head>
<body>

<div id="sidebar">
  <div class="sidebar-title">TaskFlow</div>
  <div class="sidebar-section">
    <div class="sidebar-item active" data-project="inbox" onclick="selectProject('inbox', this)">
      <span>&#x1F4E5;</span> Inbox <span class="count" id="inbox-count">0</span>
    </div>
    <div class="sidebar-item" data-project="all" onclick="selectProject('all', this)">
      <span>&#x1F4CB;</span> All Tasks <span class="count" id="all-count">0</span>
    </div>
  </div>
  <div class="sidebar-section">
    <div class="sidebar-section-label">Projects</div>
    <div id="project-list"></div>
    <button class="add-project-btn" onclick="openAddProject()">+ Add project</button>
  </div>
</div>

<div id="main">
  <div id="content">
    <div class="view-title" id="view-title">Inbox</div>
    <div class="view-stats" id="view-stats"></div>

    <div id="add-task-form">
      <input type="text" id="task-title-input" placeholder="Add a task&#x2026;" autocomplete="off" />
      <span id="task-desc-toggle" onclick="toggleDesc()">&#xFF0B; Add description</span>
      <div id="task-desc-area">
        <textarea id="task-desc-input" placeholder="Description&#x2026;" rows="2"></textarea>
      </div>
      <div class="form-row">
        <select id="task-priority-select">
          <option value="normal">&#x1F535; Normal</option>
          <option value="urgent">&#x1F534; Urgent</option>
          <option value="high">&#x1F7E0; High</option>
          <option value="low">&#x26AA; Low</option>
        </select>
        <select id="task-project-select">
          <option value="">No project (Inbox)</option>
        </select>
        <input type="date" id="task-due-input" />
        <span class="spacer"></span>
        <button class="btn btn-secondary" onclick="cancelAddTask()">Cancel</button>
        <button class="btn btn-primary" onclick="submitAddTask()">Add Task</button>
      </div>
    </div>

    <div class="filter-bar">
      <div class="filter-group">
        <button class="filter-btn active" data-status="all" onclick="setStatusFilter('all', this)">All</button>
        <button class="filter-btn" data-status="active" onclick="setStatusFilter('active', this)">Active</button>
        <button class="filter-btn" data-status="completed" onclick="setStatusFilter('completed', this)">Completed</button>
      </div>
      <select class="priority-filter" id="priority-filter" onchange="setPriorityFilter(this.value)">
        <option value="">All priorities</option>
        <option value="urgent">Urgent</option>
        <option value="high">High</option>
        <option value="normal">Normal</option>
        <option value="low">Low</option>
      </select>
    </div>

    <div id="task-list"></div>
  </div>
</div>

<!-- Add project modal -->
<div id="modal-overlay" class="modal-overlay" style="display:none" onclick="closeModalOnOverlay(event)">
  <div class="modal">
    <h3>New Project</h3>
    <label>Name</label>
    <input type="text" id="proj-name-input" placeholder="Project name&#x2026;" />
    <label>Color</label>
    <div class="color-picker" id="color-picker"></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeAddProject()">Cancel</button>
      <button class="btn btn-primary" onclick="submitAddProject()">Create</button>
    </div>
  </div>
</div>

<script>
const PROJECT_COLORS = ['#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c','#3498db','#9b59b6','#e91e63','#795548','#607d8b'];
let selectedColor = PROJECT_COLORS[5];
let currentProject = 'inbox';
let statusFilter = 'all';
let priorityFilter = '';
let allProjects = [];
let allTasks = [];
let editingTaskId = null;

// Bootstrap
async function init() {
  buildColorPicker();
  await Promise.all([loadProjects(), loadTasks()]);
  renderSidebar();
  renderTasks();
}

// Projects
async function loadProjects() {
  try {
    const res = await fetch('/projects');
    allProjects = await res.json();
  } catch(e) { allProjects = []; }
}

async function loadTasks() {
  try {
    const res = await fetch('/tasks');
    allTasks = await res.json();
  } catch(e) { allTasks = []; }
}

function renderSidebar() {
  const activeTasks = allTasks.filter(t => !t.completed);
  const inboxCount = activeTasks.filter(t => !t.project_id).length;
  const allCount = activeTasks.length;
  document.getElementById('inbox-count').textContent = inboxCount;
  document.getElementById('all-count').textContent = allCount;

  const sel = document.getElementById('task-project-select');
  const curVal = sel.value;
  sel.innerHTML = '<option value="">No project (Inbox)</option>';
  allProjects.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
  sel.value = curVal;

  const container = document.getElementById('project-list');
  container.innerHTML = '';
  allProjects.forEach(p => {
    const count = activeTasks.filter(t => t.project_id === p.id).length;
    const div = document.createElement('div');
    div.className = 'sidebar-item' + (currentProject == p.id ? ' active' : '');
    div.dataset.project = p.id;
    div.onclick = () => selectProject(p.id, div);
    div.innerHTML =
      '<span class="color-dot" style="background:' + p.color + '"></span>' +
      '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(p.name) + '</span>' +
      '<span class="count">' + count + '</span>';
    container.appendChild(div);
  });
}

function selectProject(id, el) {
  currentProject = id;
  document.querySelectorAll('.sidebar-item').forEach(x => x.classList.remove('active'));
  el.classList.add('active');

  if (id === 'inbox') document.getElementById('view-title').textContent = 'Inbox';
  else if (id === 'all') document.getElementById('view-title').textContent = 'All Tasks';
  else {
    const p = allProjects.find(x => x.id == id);
    document.getElementById('view-title').textContent = p ? p.name : 'Project';
  }

  const sel = document.getElementById('task-project-select');
  if (id === 'inbox') sel.value = '';
  else if (id === 'all') sel.value = '';
  else sel.value = id;

  renderTasks();
}

// Filters
function setStatusFilter(val, el) {
  statusFilter = val;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  renderTasks();
}

function setPriorityFilter(val) {
  priorityFilter = val;
  renderTasks();
}

// Task rendering
function getFilteredTasks() {
  let tasks = [...allTasks];
  if (currentProject === 'inbox') tasks = tasks.filter(t => !t.project_id);
  else if (currentProject !== 'all') tasks = tasks.filter(t => t.project_id == currentProject);
  if (statusFilter === 'active') tasks = tasks.filter(t => !t.completed);
  else if (statusFilter === 'completed') tasks = tasks.filter(t => t.completed);
  if (priorityFilter) tasks = tasks.filter(t => t.priority === priorityFilter);
  return tasks;
}

function isOverdue(task) {
  if (!task.due_date || task.completed) return false;
  const today = new Date().toISOString().slice(0,10);
  return task.due_date < today;
}

function isArchived(task) {
  if (!task.due_date) return false;
  const today = new Date().toISOString().slice(0,10);
  return task.due_date < today && !task.completed;
}

const PRIORITY_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 };

function renderTasks() {
  const tasks = getFilteredTasks();

  tasks.sort((a, b) => {
    const ao = isOverdue(a) ? 0 : 1;
    const bo = isOverdue(b) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    const ap = PRIORITY_ORDER[a.priority] != null ? PRIORITY_ORDER[a.priority] : 2;
    const bp = PRIORITY_ORDER[b.priority] != null ? PRIORITY_ORDER[b.priority] : 2;
    if (ap !== bp) return ap - bp;
    if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date);
    if (a.due_date) return -1;
    if (b.due_date) return 1;
    return 0;
  });

  const active = tasks.filter(t => !t.completed).length;
  const completed = tasks.filter(t => t.completed).length;
  const overdue = tasks.filter(t => isOverdue(t)).length;
  let statsText = active + ' active, ' + completed + ' completed';
  if (overdue) statsText += ', ' + overdue + ' overdue';
  document.getElementById('view-stats').textContent = statsText;

  const container = document.getElementById('task-list');
  if (tasks.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="icon">&#x2705;</div><p>No tasks here. Add one above!</p></div>';
    return;
  }

  container.innerHTML = '';
  tasks.forEach(task => {
    const card = buildTaskCard(task);
    container.appendChild(card);
  });
}

function buildTaskCard(task) {
  const overdue = isOverdue(task);
  const project = allProjects.find(p => p.id === task.project_id);
  const card = document.createElement('div');
  card.className = 'task-card' + (task.completed ? ' completed-card' : '') + (overdue ? ' overdue' : '');
  card.dataset.id = task.id;

  const priorityClass = 'priority-' + (task.priority || 'normal');
  const priorityLabel = (task.priority || 'normal').charAt(0).toUpperCase() + (task.priority || 'normal').slice(1);

  let dueDateHtml = '';
  if (task.due_date) {
    const d = new Date(task.due_date + 'T00:00:00');
    const label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    dueDateHtml = '<span class="task-meta-item">' + (overdue ? '&#x26A0;&#xFE0F;' : '&#x1F4C5;') + ' ' + label + (overdue ? ' <span class="overdue-badge">Overdue</span>' : '') + '</span>';
  }

  let projectHtml = '';
  if (project) {
    projectHtml = '<span class="task-meta-item"><span class="dot" style="background:' + project.color + '"></span>' + escHtml(project.name) + '</span>';
  }

  const descHtml = task.description ? '<div class="task-desc">' + escHtml(task.description) + '</div>' : '';

  card.innerHTML =
    '<div class="task-checkbox ' + (task.completed ? 'checked' : '') + '" onclick="toggleTask(' + task.id + ')"></div>' +
    '<div class="task-body">' +
      '<div class="task-title-row">' +
        '<span class="task-title" onclick="startEdit(' + task.id + ')">' + escHtml(task.title) + '</span>' +
        '<span class="priority-badge ' + priorityClass + '">' + priorityLabel + '</span>' +
        (overdue ? '<span class="overdue-badge">Overdue</span>' : '') +
      '</div>' +
      descHtml +
      '<div class="task-meta">' +
        dueDateHtml +
        projectHtml +
      '</div>' +
      '<div class="edit-form" id="edit-' + task.id + '" style="display:none"></div>' +
    '</div>' +
    '<div class="task-actions">' +
      '<button class="action-btn" onclick="startEdit(' + task.id + ')" title="Edit">&#x270F;&#xFE0F;</button>' +
      '<button class="action-btn delete-btn" onclick="deleteTask(' + task.id + ')" title="Delete">&#x1F5D1;</button>' +
    '</div>';
  return card;
}

// Edit task
function startEdit(id) {
  if (editingTaskId === id) return;
  if (editingTaskId) cancelEdit(editingTaskId);
  editingTaskId = id;

  const task = allTasks.find(t => t.id === id);
  if (!task) return;

  const container = document.getElementById('edit-' + id);
  if (!container) return;

  const projectOptions = allProjects.map(p =>
    '<option value="' + p.id + '" ' + (task.project_id == p.id ? 'selected' : '') + '>' + escHtml(p.name) + '</option>'
  ).join('');

  container.innerHTML =
    '<input type="text" id="edit-title-' + id + '" value="' + escAttr(task.title) + '" placeholder="Task title" />' +
    '<textarea id="edit-desc-' + id + '" placeholder="Description&#x2026;" rows="2">' + escHtml(task.description || '') + '</textarea>' +
    '<div class="form-row">' +
      '<select id="edit-priority-' + id + '">' +
        '<option value="urgent" ' + (task.priority === 'urgent' ? 'selected' : '') + '>&#x1F534; Urgent</option>' +
        '<option value="high" ' + (task.priority === 'high' ? 'selected' : '') + '>&#x1F7E0; High</option>' +
        '<option value="normal" ' + (task.priority === 'normal' ? 'selected' : '') + '>&#x1F535; Normal</option>' +
        '<option value="low" ' + (task.priority === 'low' ? 'selected' : '') + '>&#x26AA; Low</option>' +
      '</select>' +
      '<select id="edit-project-' + id + '">' +
        '<option value="" ' + (!task.project_id ? 'selected' : '') + '>No project</option>' +
        projectOptions +
      '</select>' +
      '<input type="date" id="edit-due-' + id + '" value="' + (task.due_date || '') + '" />' +
      '<span class="spacer"></span>' +
      '<button class="btn btn-secondary btn-sm" onclick="cancelEdit(' + id + ')">Cancel</button>' +
      '<button class="btn btn-primary btn-sm" onclick="saveEdit(' + id + ')">Save</button>' +
    '</div>';
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  document.getElementById('edit-title-' + id).focus();
}

function cancelEdit(id) {
  const container = document.getElementById('edit-' + id);
  if (container) container.style.display = 'none';
  if (editingTaskId === id) editingTaskId = null;
}

async function saveEdit(id) {
  const title = document.getElementById('edit-title-' + id).value.trim();
  const description = document.getElementById('edit-desc-' + id).value.trim();
  const priority = document.getElementById('edit-priority-' + id).value;
  const projectVal = document.getElementById('edit-project-' + id).value;
  const due_date = document.getElementById('edit-due-' + id).value;

  if (!title) { alert('Title is required'); return; }

  const body = {
    title,
    description: description || null,
    priority,
    project_id: projectVal ? Number(projectVal) : null,
    due_date: due_date || null,
  };

  try {
    const res = await fetch('/tasks/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { const e = await res.json(); alert(e.error || 'Error'); return; }
    const updated = await res.json();
    const idx = allTasks.findIndex(t => t.id === id);
    if (idx >= 0) allTasks[idx] = updated;
    editingTaskId = null;
    renderSidebar();
    renderTasks();
  } catch(e) { alert('Network error'); }
}

// Toggle complete
async function toggleTask(id) {
  const task = allTasks.find(t => t.id === id);
  if (!task) return;
  try {
    const res = await fetch('/tasks/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ completed: !task.completed }),
    });
    if (!res.ok) return;
    const updated = await res.json();
    const idx = allTasks.findIndex(t => t.id === id);
    if (idx >= 0) allTasks[idx] = updated;
    renderSidebar();
    renderTasks();
  } catch(e) {}
}

// Delete task
async function deleteTask(id) {
  if (!confirm('Delete this task?')) return;
  try {
    const res = await fetch('/tasks/' + id, { method: 'DELETE' });
    if (res.status === 204 || res.ok) {
      allTasks = allTasks.filter(t => t.id !== id);
      renderSidebar();
      renderTasks();
    }
  } catch(e) {}
}

// Add task
function toggleDesc() {
  const area = document.getElementById('task-desc-area');
  const toggle = document.getElementById('task-desc-toggle');
  if (area.style.display === 'none' || !area.style.display) {
    area.style.display = 'block';
    toggle.textContent = '− Hide description';
  } else {
    area.style.display = 'none';
    toggle.textContent = '＋ Add description';
  }
}

function cancelAddTask() {
  document.getElementById('task-title-input').value = '';
  document.getElementById('task-desc-input').value = '';
  document.getElementById('task-priority-select').value = 'normal';
  document.getElementById('task-due-input').value = '';
  document.getElementById('task-desc-area').style.display = 'none';
  document.getElementById('task-desc-toggle').textContent = '＋ Add description';
}

async function submitAddTask() {
  const title = document.getElementById('task-title-input').value.trim();
  if (!title) { document.getElementById('task-title-input').focus(); return; }

  const description = document.getElementById('task-desc-input').value.trim();
  const priority = document.getElementById('task-priority-select').value;
  const projectVal = document.getElementById('task-project-select').value;
  const due_date = document.getElementById('task-due-input').value;

  const body = {
    title,
    description: description || null,
    priority,
    project_id: projectVal ? Number(projectVal) : null,
    due_date: due_date || null,
  };

  try {
    const res = await fetch('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { const e = await res.json(); alert(e.error || 'Error'); return; }
    const newTask = await res.json();
    allTasks.unshift(newTask);
    cancelAddTask();
    renderSidebar();
    renderTasks();
  } catch(e) { alert('Network error'); }
}

document.getElementById('task-title-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitAddTask();
});

// Add project modal
function buildColorPicker() {
  const container = document.getElementById('color-picker');
  PROJECT_COLORS.forEach(color => {
    const sw = document.createElement('div');
    sw.className = 'color-swatch' + (color === selectedColor ? ' selected' : '');
    sw.style.background = color;
    sw.onclick = () => {
      selectedColor = color;
      document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      sw.classList.add('selected');
    };
    container.appendChild(sw);
  });
}

function openAddProject() {
  document.getElementById('proj-name-input').value = '';
  document.getElementById('modal-overlay').style.display = 'flex';
  document.getElementById('proj-name-input').focus();
}

function closeAddProject() {
  document.getElementById('modal-overlay').style.display = 'none';
}

function closeModalOnOverlay(e) {
  if (e.target === document.getElementById('modal-overlay')) closeAddProject();
}

async function submitAddProject() {
  const name = document.getElementById('proj-name-input').value.trim();
  if (!name) { document.getElementById('proj-name-input').focus(); return; }

  try {
    const res = await fetch('/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color: selectedColor }),
    });
    if (!res.ok) { const e = await res.json(); alert(e.error || 'Error'); return; }
    const proj = await res.json();
    allProjects.push(proj);
    closeAddProject();
    renderSidebar();
  } catch(e) { alert('Network error'); }
}

// Helpers
function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) { return escHtml(s); }

// Start
init();
</script>
</body>
</html>`;
  return c.html(html);
});

/** @internal Phoenix VCS traceability — do not remove. */


/** @internal Phoenix VCS traceability — do not remove. */


export default router;

/** @internal Phoenix VCS traceability — do not remove. */
export const _phoenix = {
  iu_id: '808e5ed23004b8ceea01725ef3e45fe1f6712ff1855f86ecad3355c5bf4360d0',
  name: 'Web Experience',
  risk_tier: 'high',
  canon_ids: [5 as const],
} as const;
