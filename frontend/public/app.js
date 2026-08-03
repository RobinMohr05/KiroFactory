// ===== Auth Gate =====
// Check authentication before rendering the app. Redirect to login if not authenticated.
let currentUser = null;

/**
 * Wrapper around fetch for all /api/* calls.
 * Automatically detects 401 responses (session expired or invalid) and redirects to login.
 * This ensures that no matter which API call triggers a session expiry, the user is redirected.
 */
async function apiFetch(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.location.href = '/login.html';
    // Return a never-resolving promise to halt the calling code
    return new Promise(() => {});
  }
  return res;
}

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' }); // raw fetch: we handle 401 manually here
    if (res.status === 401) {
      window.location.href = '/login.html';
      return false;
    }
    if (res.ok) {
      const data = await res.json();
      currentUser = data.user;
      return true;
    }
    // Other errors (e.g., 503 DB down) — allow through, app will show errors naturally
    return true;
  } catch {
    // Network error — allow through, app will show disconnected status
    return true;
  }
}

/**
 * Call this on any fetch response to detect session expiry and redirect to login.
 */
function handleAuthError(res) {
  if (res.status === 401) {
    window.location.href = '/login.html';
    return true;
  }
  return false;
}

/**
 * Logout: clear session and redirect to login.
 */
async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch { /* ignore */ }
  window.location.href = '/login.html';
}

// ===== State =====
let boards = [];
let tasks = [];
let boardSessions = [];
let boardAgents = [];
let currentBoardId = null;
let currentSort = 'priority'; // 'priority' | 'updated' | 'created'
let pendingOps = new Set();
let ws = null;
let reconnectTimer = null;
let pollTimer = null;
let reconcileTimer = null;
let lastTasksJson = '';

// ===== DOM References =====
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const boardList = document.getElementById('boardList');
const newBoardBtn = document.getElementById('newBoardBtn');
const newTaskBtn = document.getElementById('newTaskBtn');
const taskModal = document.getElementById('taskModal');
const taskForm = document.getElementById('taskForm');
const cancelTaskBtn = document.getElementById('cancelTaskBtn');
const deleteTaskBtn = document.getElementById('deleteTaskBtn');
const modalTitle = document.getElementById('modalTitle');
const submitTaskBtn = document.getElementById('submitTaskBtn');

// Tab Modal
const tabModal = document.getElementById('tabModal');
const tabForm = document.getElementById('tabForm');
const tabModalTitle = document.getElementById('tabModalTitle');
const tabFormId = document.getElementById('tabFormId');
const tabFormName = document.getElementById('tabFormName');
const tabFormRepo = document.getElementById('tabFormRepo');
const tabFormGitProvider = document.getElementById('tabFormGitProvider');
const cancelTabBtn = document.getElementById('cancelTabBtn');
const submitTabBtn = document.getElementById('submitTabBtn');

// MCP Config toggles (in tab modal)
const mcpAtlassian = document.getElementById('mcpAtlassian');
const mcpAzureDevops = document.getElementById('mcpAzureDevops');
const mcpAwsApi = document.getElementById('mcpAwsApi');
const mcpAwsDocs = document.getElementById('mcpAwsDocs');

// Tabs
const tabBoards = document.getElementById('tab-boards');
const tabSessions = document.getElementById('tab-sessions');
const tabAgents = document.getElementById('tab-agents');
const tabErrors = document.getElementById('tab-errors');
const panelBoards = document.getElementById('panel-boards');
const panelSessions = document.getElementById('panel-sessions');
const panelAgents = document.getElementById('panel-agents');
const panelErrors = document.getElementById('panel-errors');

// ===== Dark Mode Toggle =====
const themeToggle = document.getElementById('themeToggle');

function getPreferredTheme() {
  const stored = localStorage.getItem('vibecode-heaven-theme');
  if (stored) return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('vibecode-heaven-theme', theme);
}

// Apply theme immediately on load
applyTheme(getPreferredTheme());

themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// Respond to OS theme changes (if user hasn't manually set a preference)
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (!localStorage.getItem('vibecode-heaven-theme')) {
    applyTheme(e.matches ? 'dark' : 'light');
  }
});

// ===== Priority & Origin & Type Maps =====
const PRIORITY_COLORS = {
  1: '#D22630',  // Rapid Red
  2: '#FF8700',  // Ignition Mango
  3: '#007A87',  // Torque Teal
  4: '#9CA3AF'   // Neutral grey
};

const ORIGIN_ICONS = {
  user: '\u{1F464}',
  ai: '\u{1F916}',
  'user-assisted': '\u{1F91D}'
};

const TYPE_CLASSES = {
  improvement: 'badge-improvement',
  bug: 'badge-bug',
  feature: 'badge-feature'
};

// ===== WebSocket =====
const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);

// Hide connection status indicator on deployed (non-localhost) environments
if (!isLocalhost) {
  const connectionStatusEl = document.getElementById('connectionStatus');
  if (connectionStatusEl) connectionStatusEl.hidden = true;
}

function connectWebSocket() {
  // Skip WebSocket on non-localhost — use polling only
  if (!isLocalhost) {
    startPolling();
    return;
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.addEventListener('open', () => {
    setConnectionStatus(true);
    stopPolling();
  });

  ws.addEventListener('close', (event) => {
    setConnectionStatus(false);
    // If server rejected with auth error (4001), redirect to login immediately
    if (event.code === 4001) {
      window.location.href = '/login.html';
      return;
    }
    scheduleReconnect();
    startPolling();
  });

  ws.addEventListener('error', () => {
    ws.close();
  });

  ws.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      handleWsMessage(message);
    } catch (e) {
      console.error('Failed to parse WS message:', e);
    }
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, 3000);
}

function setConnectionStatus(connected) {
  const connectionStatus = document.getElementById('connectionStatus');
  if (connected) {
    statusDot.classList.add('connected');
    statusText.textContent = 'Connected';
    if (connectionStatus) connectionStatus.title = 'Connected';
  } else {
    statusDot.classList.remove('connected');
    statusText.textContent = 'Disconnected';
    if (connectionStatus) connectionStatus.title = 'Disconnected';
  }
}

function handleWsMessage(message) {
  const { type } = message;

  // Server sends: { type, task?, taskId?, board?, boardId? }
  // Extract the relevant data based on message type
  const task = message.task;
  const board = message.tab;
  const taskId = message.taskId;
  const boardId = message.tabId;

  // Deduplication: if we triggered this op, skip re-render
  const dedupId = task?.id || taskId || board?.id || boardId;
  if (dedupId && pendingOps.has(`${type}-${dedupId}`)) {
    pendingOps.delete(`${type}-${dedupId}`);
    return;
  }

  switch (type) {
    case 'task-created':
      if (task) {
        // Check if this task belongs to the current board
        const belongsToBoard = task.tabs?.some(b => b.id == currentBoardId);
        if (belongsToBoard) {
          const exists = tasks.find(t => t.id === task.id);
          if (!exists) {
            tasks.push(task);
            renderBoard();
          }
        }
      }
      break;

    case 'task-updated':
      if (task) {
        const idx = tasks.findIndex(t => t.id === task.id);
        if (idx !== -1) {
          tasks[idx] = task;
          renderBoard();
        } else {
          // Task might have been added to this board
          const belongsToBoard = task.tabs?.some(b => b.id == currentBoardId);
          if (belongsToBoard) {
            // Final guard: only push if not already present (prevents duplicates)
            const alreadyExists = tasks.find(t => t.id === task.id);
            if (!alreadyExists) {
              tasks.push(task);
              renderBoard();
            }
          }
        }
      }
      break;

    case 'task-deleted':
      if (taskId) {
        const before = tasks.length;
        tasks = tasks.filter(t => t.id !== taskId);
        if (tasks.length !== before) renderBoard();
      }
      break;

    case 'tab-created':
      if (board) {
        const boardExists = boards.find(b => b.id === board.id);
        if (!boardExists) {
          boards.push(board);
          renderBoardSelector();
        }
      }
      break;

    case 'tab-updated':
      if (board) {
        const bIdx = boards.findIndex(b => b.id === board.id);
        if (bIdx !== -1) boards[bIdx] = board;
        renderBoardSelector();
      }
      break;

    case 'tab-deleted':
      if (boardId) {
        boards = boards.filter(b => b.id !== boardId);
        renderBoardSelector();
        if (currentBoardId == boardId) {
          currentBoardId = boards.length > 0 ? boards[0].id : null;
          renderSessionList();
          if (currentBoardId) fetchBoardTasks(currentBoardId);
          else {
            tasks = [];
            boardSessions = [];
            boardAgents = [];
            renderBoard();
            renderBoardMembers();
          }
        }
      }
      break;

    case 'tabs-reordered':
      // Skip if we triggered this reorder (optimistic update already applied)
      if (pendingOps.has('tabs-reordered')) {
        pendingOps.delete('tabs-reordered');
      } else if (message.tabs && Array.isArray(message.tabs)) {
        boards = message.tabs;
        renderBoardSelector();
      }
      break;

    case 'connected':
      // Initial connection confirmation from server — no action needed
      break;

    default:
      // Delegate session-related messages
      if (type && type.startsWith('session-')) {
        handleSessionWsMessage(message);
      }
      // Handle error messages
      if (type === 'error-created') {
        handleErrorWsMessage(message);
      }
      break;
  }
}

// ===== Polling fallback =====
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (currentBoardId) fetchBoardTasks(currentBoardId);
  }, 3000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ===== REST API =====
async function fetchBoards() {
  try {
    const res = await apiFetch('/api/tabs');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    boards = await res.json();
    renderBoardSelector();
    if (boards.length > 0 && !currentBoardId) {
      currentBoardId = boards[0].id;
      renderBoardSelector();
      renderSessionList();
      await fetchBoardTasks(currentBoardId);
    }
  } catch (e) {
    console.error('Failed to fetch boards:', e);
  }
}

async function fetchBoardTasks(boardId) {
  try {
    const res = await fetch(`/api/tabs/${boardId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const newTasks = data.tasks || [];
    const newJson = JSON.stringify(newTasks);
    if (newJson !== lastTasksJson) {
      tasks = newTasks;
      lastTasksJson = newJson;
      renderBoard();
    }
    // Update board sessions and agents
    boardSessions = data.sessions || [];
    boardAgents = data.agents || [];
    renderBoardMembers();
    renderBoardRepoIndicator();
  } catch (e) {
    console.error('Failed to fetch board tasks:', e);
  }
}

async function createTask(data) {
  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const task = await res.json();
    pendingOps.add(`task-created-${task.id}`);
    // Guard against duplicate: WebSocket broadcast may have already added this task
    const exists = tasks.find(t => t.id === task.id);
    if (!exists) {
      tasks.push(task);
    } else {
      // Update in place with the authoritative REST response
      const idx = tasks.findIndex(t => t.id === task.id);
      tasks[idx] = task;
    }
    lastTasksJson = JSON.stringify(tasks);
    renderBoard();
    return task;
  } catch (e) {
    console.error('Failed to create task:', e);
  }
}

async function updateTask(id, data) {
  try {
    const res = await fetch(`/api/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const task = await res.json();
    pendingOps.add(`task-updated-${task.id}`);
    const idx = tasks.findIndex(t => t.id === id);
    if (idx !== -1) tasks[idx] = task;
    lastTasksJson = JSON.stringify(tasks);
    renderBoard();
    return task;
  } catch (e) {
    console.error('Failed to update task:', e);
  }
}

async function deleteTask(id) {
  try {
    const res = await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    pendingOps.add(`task-deleted-${id}`);
    tasks = tasks.filter(t => t.id !== id);
    lastTasksJson = JSON.stringify(tasks);
    renderBoard();
  } catch (e) {
    console.error('Failed to delete task:', e);
  }
}

async function createBoard(name, repositoryUrl = null, gitProvider = null) {
  try {
    const body = { name };
    if (repositoryUrl) body.repositoryUrl = repositoryUrl;
    if (gitProvider) body.gitProvider = gitProvider;
    const res = await fetch('/api/tabs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const board = await res.json();
    pendingOps.add(`board-created-${board.id}`);
    // Guard against duplicate: WebSocket broadcast may have already added this board
    const exists = boards.find(b => b.id === board.id);
    if (!exists) {
      boards.push(board);
    }
    renderBoardSelector();
    currentBoardId = board.id;
    renderBoardSelector();
    renderSessionList();
    tasks = [];
    boardSessions = [];
    boardAgents = [];
    lastTasksJson = '[]';
    renderBoard();
    renderBoardMembers();
    renderBoardRepoIndicator();
    return board;
  } catch (e) {
    console.error('Failed to create board:', e);
  }
}

async function deleteBoard(id) {
  try {
    const res = await fetch(`/api/tabs/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    pendingOps.add(`board-deleted-${id}`);
    boards = boards.filter(b => b.id !== id);
    renderBoardSelector();
    if (currentBoardId === id || currentBoardId == id) {
      currentBoardId = boards.length > 0 ? boards[0].id : null;
      renderBoardSelector();
      renderSessionList();
      if (currentBoardId) {
        await fetchBoardTasks(currentBoardId);
      } else {
        tasks = [];
        boardSessions = [];
        boardAgents = [];
        renderBoard();
        renderBoardMembers();
      }
    }
  } catch (e) {
    console.error('Failed to delete board:', e);
  }
}

// ===== Rendering =====
function renderBoardSelector() {
  boardList.innerHTML = '';
  boards.forEach(board => {
    const li = document.createElement('li');
    li.className = 'board-list-item' + (currentBoardId == board.id ? ' active' : '');
    li.dataset.boardId = board.id;
    li.draggable = true;
    li.setAttribute('role', 'tab');
    if (board.repositoryUrl) {
      li.title = board.repositoryUrl;
    }
    li.setAttribute('aria-selected', currentBoardId == board.id ? 'true' : 'false');
    li.innerHTML = `<span class="board-item-name">${escapeHtml(board.name)}</span><span class="board-item-actions"><button class="board-item-action board-item-edit" title="Rename tab" aria-label="Rename tab ${escapeHtml(board.name)}"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8.5 1.5l2 2-7 7H1.5V8.5l7-7z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button class="board-item-action board-item-delete" title="Delete tab" aria-label="Delete tab ${escapeHtml(board.name)}"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button></span>`;

    // Edit button — opens tab settings modal
    li.querySelector('.board-item-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      showTabModal(board);
    });

    // Delete button — confirm and delete
    li.querySelector('.board-item-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Delete tab "${board.name}"? Tasks will be unassigned from this tab.`)) {
        deleteBoard(board.id);
      }
    });

    // Drag-and-drop for reordering tabs
    li.addEventListener('dragstart', (e) => {
      li.classList.add('tab-dragging');
      e.dataTransfer.setData('application/x-tab-id', String(board.id));
      e.dataTransfer.effectAllowed = 'move';
    });

    li.addEventListener('dragend', () => {
      li.classList.remove('tab-dragging');
      // Remove any drop indicators
      boardList.querySelectorAll('.tab-drop-before, .tab-drop-after').forEach(el => {
        el.classList.remove('tab-drop-before', 'tab-drop-after');
      });
    });

    li.addEventListener('dragover', (e) => {
      // Only handle tab reorder drags (not task card drags)
      if (!e.dataTransfer.types.includes('application/x-tab-id')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // Show drop indicator based on cursor position
      const rect = li.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      li.classList.remove('tab-drop-before', 'tab-drop-after');
      if (e.clientX < midX) {
        li.classList.add('tab-drop-before');
      } else {
        li.classList.add('tab-drop-after');
      }
    });

    li.addEventListener('dragleave', () => {
      li.classList.remove('tab-drop-before', 'tab-drop-after');
    });

    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('tab-drop-before', 'tab-drop-after');
      const draggedId = Number(e.dataTransfer.getData('application/x-tab-id'));
      if (!draggedId || draggedId === board.id) return;

      // Determine drop position
      const rect = li.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const insertBefore = e.clientX < midX;

      // Reorder the boards array
      const draggedIdx = boards.findIndex(b => b.id === draggedId);
      if (draggedIdx === -1) return;
      const [dragged] = boards.splice(draggedIdx, 1);
      let targetIdx = boards.findIndex(b => b.id === board.id);
      if (!insertBefore) targetIdx++;
      boards.splice(targetIdx, 0, dragged);

      // Re-render immediately (optimistic)
      renderBoardSelector();

      // Persist new order to server
      const tabIds = boards.map(b => b.id);
      reorderTabsOnServer(tabIds);
    });

    // Click to select
    li.addEventListener('click', (e) => {
      if (li.querySelector('.board-edit-input')) return; // editing, don't switch
      if (e.target.closest('.board-item-action')) return; // action button clicked
      currentBoardId = board.id;
      renderBoardSelector();
      // Deselect active session if it doesn't belong to the new board
      if (activeSessionId) {
        const activeSession = sessions.find(s => s.id === activeSessionId);
        if (!activeSession || !activeSession.tabIds || !activeSession.tabIds.includes(Number(currentBoardId))) {
          activeSessionId = null;
          showSessionEmpty();
        }
      }
      renderSessionList();
      fetchBoardTasks(currentBoardId);
    });

    // Double-click to rename
    li.addEventListener('dblclick', (e) => {
      e.preventDefault();
      startBoardEdit(li, board);
    });

    // Right-click context menu
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showBoardContextMenu(e, board);
    });

    boardList.appendChild(li);
  });
}

/** Persist tab order to server */
async function reorderTabsOnServer(tabIds) {
  try {
    pendingOps.add('tabs-reordered');
    const res = await fetch('/api/tabs/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabIds }),
    });
    if (!res.ok) {
      console.error('Failed to reorder tabs:', res.status);
      // Refetch to restore server order
      await fetchBoards();
    }
  } catch (e) {
    console.error('Failed to reorder tabs:', e);
    await fetchBoards();
  }
}

/** Show a context menu for board rename/delete */
function showBoardContextMenu(event, board) {
  // Remove any existing context menu
  const existing = document.querySelector('.board-context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'board-context-menu';
  menu.innerHTML = `
    <button class="board-context-item" data-action="edit">⚙️ Edit Tab</button>
    <button class="board-context-item" data-action="rename">✏️ Rename</button>
    <button class="board-context-item board-context-danger" data-action="delete">🗑️ Delete</button>
  `;
  menu.style.left = event.clientX + 'px';
  menu.style.top = event.clientY + 'px';
  document.body.appendChild(menu);

  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    menu.remove();
    if (action === 'edit') {
      showTabModal(board);
    } else if (action === 'rename') {
      const li = boardList.querySelector(`[data-board-id="${board.id}"]`);
      if (li) startBoardEdit(li, board);
    } else if (action === 'delete') {
      if (confirm(`Delete tab "${board.name}"? Tasks will be unassigned from this tab.`)) {
        deleteBoard(board.id);
      }
    }
  });

  // Close on click outside
  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

/** Start inline editing of a board name */
function startBoardEdit(li, board) {
  const nameSpan = li.querySelector('.board-item-name');
  if (!nameSpan) return;

  // Hide action buttons during editing
  const actions = li.querySelector('.board-item-actions');
  if (actions) actions.style.display = 'none';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'board-edit-input';
  input.value = board.name;
  input.setAttribute('aria-label', 'Rename tab');

  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  const finishEdit = async () => {
    const newName = input.value.trim();
    if (newName && newName !== board.name) {
      await renameBoard(board.id, newName);
    }
    renderBoardSelector();
  };

  input.addEventListener('blur', finishEdit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = board.name; // revert
      input.blur();
    }
  });
}

/** Rename a board via REST API */
async function renameBoard(id, newName) {
  try {
    // Preserve existing repositoryUrl when just renaming
    const board = boards.find(b => b.id === id);
    const repositoryUrl = board ? board.repositoryUrl : null;
    const res = await fetch(`/api/tabs/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName, repositoryUrl })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const updated = await res.json();
    const idx = boards.findIndex(b => b.id === id);
    if (idx !== -1) boards[idx] = updated;
    renderBoardSelector();
  } catch (e) {
    console.error('Failed to rename board:', e);
  }
}

/** Show an inline input in the board list bar for creating a new tab */
function startInlineBoardCreate() {
  // Check if already creating
  if (boardList.querySelector('.board-edit-input')) return;

  const li = document.createElement('li');
  li.className = 'board-list-item active';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'board-edit-input';
  input.placeholder = 'Tab name…';
  input.setAttribute('aria-label', 'New tab name');
  li.appendChild(input);
  boardList.appendChild(li);
  input.focus();

  const finishCreate = async () => {
    const name = input.value.trim();
    if (name) {
      await createBoard(name);
    } else {
      li.remove();
    }
  };

  input.addEventListener('blur', finishCreate);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      input.removeEventListener('blur', finishCreate);
      li.remove();
    }
  });
}

// ===== Tab Modal (Create/Edit with Repository) =====

/**
 * Show the tab modal for creating a new tab or editing an existing one.
 * @param {object|null} board - existing board object to edit, or null for create
 */
function showTabModal(board = null) {
  tabModal.hidden = false;
  tabForm.reset();

  // Default MCP config
  const defaultMcp = { atlassian: true, azureDevops: true, awsApi: false, awsDocs: true };

  if (board) {
    tabModalTitle.textContent = 'Edit Tab';
    submitTabBtn.textContent = 'Save Changes';
    tabFormId.value = board.id;
    tabFormName.value = board.name || '';
    tabFormRepo.value = board.repositoryUrl || '';
    // '' = inherit the profile default
    tabFormGitProvider.value = board.gitProvider || '';
    // Populate MCP config from board
    const mcp = board.mcpConfig || defaultMcp;
    mcpAtlassian.checked = mcp.atlassian !== false;
    mcpAzureDevops.checked = mcp.azureDevops !== false;
    mcpAwsApi.checked = mcp.awsApi === true;
    mcpAwsDocs.checked = mcp.awsDocs !== false;
  } else {
    tabModalTitle.textContent = 'New Tab';
    submitTabBtn.textContent = 'Create Tab';
    tabFormId.value = '';
    tabFormName.value = '';
    tabFormRepo.value = '';
    tabFormGitProvider.value = '';
    // Set defaults for new tab
    mcpAtlassian.checked = defaultMcp.atlassian;
    mcpAzureDevops.checked = defaultMcp.azureDevops;
    mcpAwsApi.checked = defaultMcp.awsApi;
    mcpAwsDocs.checked = defaultMcp.awsDocs;
  }

  tabFormName.focus();
}

function hideTabModal() {
  tabModal.hidden = true;
  tabForm.reset();
}

async function handleTabFormSubmit() {
  const id = tabFormId.value;
  const name = tabFormName.value.trim();
  const repositoryUrl = tabFormRepo.value.trim() || null;
  // '' means "inherit the profile default" — sent as null.
  const gitProvider = tabFormGitProvider.value || null;
  const mcpConfig = {
    atlassian: mcpAtlassian.checked,
    azureDevops: mcpAzureDevops.checked,
    awsApi: mcpAwsApi.checked,
    awsDocs: mcpAwsDocs.checked,
  };

  if (!name) return;

  if (id) {
    // Update existing tab
    await updateBoard(Number(id), name, repositoryUrl, mcpConfig, gitProvider);
  } else {
    // Create new tab
    await createBoard(name, repositoryUrl, gitProvider);
  }

  hideTabModal();
}

/**
 * Update a board's name and repository URL.
 */
async function updateBoard(id, name, repositoryUrl, mcpConfig, gitProvider = null) {
  try {
    const body = { name, repositoryUrl, gitProvider };
    if (mcpConfig) body.mcpConfig = mcpConfig;
    const res = await apiFetch(`/api/tabs/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const updated = await res.json();
    const idx = boards.findIndex(b => b.id === id);
    if (idx !== -1) boards[idx] = updated;
    renderBoardSelector();
    renderBoardRepoIndicator();
  } catch (e) {
    console.error('Failed to update board:', e);
  }
}

/**
 * Render the repository URL indicator in the toolbar area when viewing a tab with a repo.
 */
function renderBoardRepoIndicator() {
  // Remove existing indicator
  const existing = document.querySelector('.board-repo-indicator');
  if (existing) existing.remove();

  const board = boards.find(b => b.id === currentBoardId);
  if (!board || !board.repositoryUrl) return;

  const toolbar = document.querySelector('#panel-boards .toolbar');
  if (!toolbar) return;

  const indicator = document.createElement('div');
  indicator.className = 'board-repo-indicator';
  indicator.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9z" fill="currentColor"/><path d="M6.25 1a.75.75 0 00-.75.75v5.5a.75.75 0 001.28.53L8 6.56l1.22 1.22a.75.75 0 001.28-.53v-5.5A.75.75 0 009.75 1h-3.5z" fill="currentColor"/></svg><a href="${escapeHtml(board.repositoryUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(board.repositoryUrl)}">${escapeHtml(truncateUrl(board.repositoryUrl))}</a>`;
  toolbar.appendChild(indicator);
}

function truncateUrl(url) {
  // Show just the path part for GitHub-like URLs, or truncate to 50 chars
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/^\//, '').replace(/\.git$/, '');
    if (path) return path;
    return url.length > 50 ? url.substring(0, 50) + '…' : url;
  } catch {
    return url.length > 50 ? url.substring(0, 50) + '…' : url;
  }
}

function renderBoard() {
  const columns = ['todo', 'in-progress', 'developed'];

  columns.forEach(state => {
    const container = document.getElementById(`cards-${state}`);
    const countEl = document.getElementById(`count-${state}`);
    container.innerHTML = '';

    const columnTasks = tasks.filter(t => t.state === state);

    // Sort based on current selection
    columnTasks.sort((a, b) => {
      switch (currentSort) {
        case 'updated':
          return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
        case 'created':
          return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
        case 'priority':
        default:
          return (a.priority || 4) - (b.priority || 4);
      }
    });

    countEl.textContent = columnTasks.length;

    columnTasks.forEach(task => {
      container.appendChild(renderTaskCard(task));
    });
  });
}

function renderBoardMembers() {
  const sessionsList = document.getElementById('board-sessions-list');
  const agentsList = document.getElementById('board-agents-list');
  const sessionsCount = document.getElementById('count-board-sessions');
  const agentsCount = document.getElementById('count-board-agents');

  // Guard: elements may not exist if the board-members panel isn't in the DOM
  if (!sessionsCount || !agentsCount || !sessionsList || !agentsList) return;

  // Render sessions
  sessionsCount.textContent = boardSessions.length;
  if (boardSessions.length === 0) {
    sessionsList.innerHTML = '<p class="board-members-empty">No sessions assigned to this board.</p>';
  } else {
    sessionsList.innerHTML = '';
    boardSessions.forEach(session => {
      const chip = document.createElement('div');
      chip.className = 'board-member-chip';
      chip.innerHTML = `
        <span class="chip-status status-${session.status}"></span>
        <span class="chip-name">${escapeHtml(session.name)}</span>
        <span class="chip-detail">${session.agent ? escapeHtml(session.agent) : 'Interactive'} · ${session.status}</span>
      `;
      chip.addEventListener('click', () => {
        // Switch to Sessions tab and select this session
        tabSessions.click();
        selectSession(session.id);
      });
      chip.style.cursor = 'pointer';
      sessionsList.appendChild(chip);
    });
  }

  // Render agents
  agentsCount.textContent = boardAgents.length;
  if (boardAgents.length === 0) {
    agentsList.innerHTML = '<p class="board-members-empty">No agents assigned to this board.</p>';
  } else {
    agentsList.innerHTML = '';
    boardAgents.forEach(agentName => {
      const chip = document.createElement('div');
      chip.className = 'board-member-chip';
      const initials = (agentName || '?').substring(0, 2).toUpperCase();
      chip.innerHTML = `
        <span class="agent-item-icon" style="width:24px;height:24px;font-size:0.6rem;line-height:24px;">${initials}</span>
        <span class="chip-name">${escapeHtml(agentName)}</span>
      `;
      chip.addEventListener('click', () => {
        // Switch to Agents tab and select this agent
        tabAgents.click();
        fetchAgents().then(() => selectAgent(agentName));
      });
      chip.style.cursor = 'pointer';
      agentsList.appendChild(chip);
    });
  }
}

function renderTaskCard(task) {
  const card = document.createElement('div');
  card.className = 'task-card';
  card.draggable = true;
  card.dataset.taskId = task.id;
  card.dataset.priority = task.priority || 4;
  card.setAttribute('role', 'article');
  card.setAttribute('aria-label', `Task: ${task.title}`);

  const typeClass = TYPE_CLASSES[task.type] || 'badge-improvement';
  const typeLabel = task.type ? task.type.charAt(0).toUpperCase() + task.type.slice(1) : 'Task';
  const originIcon = ORIGIN_ICONS[task.origin] || '\u{1F464}';
  const priority = task.priority || 4;

  card.innerHTML = `
    <div class="card-title">${escapeHtml(task.title)}</div>
    <div class="card-meta">
      <span class="badge ${typeClass}">${typeLabel}</span>
      <span class="card-priority">P${priority}</span>
      <span class="card-origin" title="${task.origin || 'user'}">${originIcon}</span>
    </div>
  `;

  // Drag events
  card.addEventListener('dragstart', (e) => {
    card.classList.add('dragging');
    card.dataset.wasDragged = 'true';
    e.dataTransfer.setData('text/plain', task.id);
    e.dataTransfer.effectAllowed = 'move';
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
  });

  // Single click to edit (skip if card was just dragged)
  card.addEventListener('click', () => {
    if (card.dataset.wasDragged === 'true') {
      card.dataset.wasDragged = '';
      return;
    }
    showTaskForm(task);
  });

  return card;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

// ===== Drag and Drop =====
function setupDragAndDrop() {
  const columns = document.querySelectorAll('.column');

  columns.forEach(column => {
    const cardsContainer = column.querySelector('.column-cards');

    cardsContainer.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      column.classList.add('drag-over');
    });

    cardsContainer.addEventListener('dragleave', (e) => {
      if (!column.contains(e.relatedTarget)) {
        column.classList.remove('drag-over');
      }
    });

    cardsContainer.addEventListener('drop', (e) => {
      e.preventDefault();
      column.classList.remove('drag-over');

      const taskId = e.dataTransfer.getData('text/plain');
      const newState = column.dataset.state;

      if (!taskId || !newState) return;

      const numericId = Number(taskId);
      const task = tasks.find(t => t.id === numericId);
      if (!task || task.state === newState) return;

      // Optimistic update
      task.state = newState;
      renderBoard();

      // Persist
      updateTask(numericId, { state: newState });
    });
  });
}

// ===== Task Form =====
function showTaskForm(task = null) {
  taskModal.hidden = false;

  if (task) {
    modalTitle.textContent = 'Edit Task';
    submitTaskBtn.textContent = 'Update Task';
    deleteTaskBtn.hidden = false;
    document.getElementById('taskId').value = task.id;
    document.getElementById('taskTitle').value = task.title || '';
    document.getElementById('taskDescription').value = task.description || '';
    document.getElementById('taskType').value = task.type || 'improvement';
    document.getElementById('taskPriority').value = task.priority || 4;
    document.getElementById('taskState').value = task.state || 'todo';
    document.getElementById('taskOrigin').value = task.origin || 'user';
    document.getElementById('taskStateGroup').hidden = false;
    document.getElementById('taskOrigin').closest('.form-group').hidden = false;
  } else {
    modalTitle.textContent = 'New Task';
    submitTaskBtn.textContent = 'Create Task';
    deleteTaskBtn.hidden = true;
    taskForm.reset();
    document.getElementById('taskId').value = '';
    document.getElementById('taskStateGroup').hidden = true;
    document.getElementById('taskOrigin').closest('.form-group').hidden = true;
  }

  document.getElementById('taskTitle').focus();
}

function hideTaskForm() {
  taskModal.hidden = true;
  taskForm.reset();
}

// ===== Tab Switching =====
function setupTabs() {
  const tabs = [tabBoards, tabSessions, tabAgents, tabErrors];
  const panels = [panelBoards, panelSessions, panelAgents, panelErrors];

  function activateTab(activeTab, activePanel) {
    tabs.forEach(t => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    panels.forEach(p => { p.hidden = true; });

    activeTab.classList.add('active');
    activeTab.setAttribute('aria-selected', 'true');
    activePanel.hidden = false;
  }

  tabBoards.addEventListener('click', () => activateTab(tabBoards, panelBoards));
  tabSessions.addEventListener('click', () => {
    activateTab(tabSessions, panelSessions);
    // Auto-select a session if none is currently active, so the detail panel
    // doesn't sit empty when there's something to show. Prefer an agentless
    // (interactive) session, otherwise fall back to the first visible one.
    if (!activeSessionId && sessions.length > 0) {
      const visible = currentBoardId
        ? sessions.filter(s => !s.agent || (s.tabIds && s.tabIds.includes(Number(currentBoardId))))
        : sessions;
      const preferred = visible.find(s => !s.agent) || visible[0];
      if (preferred) {
        selectSession(preferred.id);
      } else {
        showSessionEmpty();
      }
    } else if (!activeSessionId) {
      showSessionEmpty();
    }
  });
  tabAgents.addEventListener('click', () => {
    activateTab(tabAgents, panelAgents);
    fetchAgents().then(() => {
      // Auto-select the first agent if none is currently active, so the
      // detail panel doesn't sit empty when agents already exist.
      if (!activeAgentName && agents.length > 0) {
        selectAgent(agents[0].name);
      } else if (!activeAgentName) {
        showAgentEmpty();
      }
    });
  });
  tabErrors.addEventListener('click', () => {
    activateTab(tabErrors, panelErrors);
    fetchErrors();
  });
}

// ===== Event Listeners =====
function setupEventListeners() {
  // Logout button
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', logout);
  }

  // Board selection is handled by click events in renderBoardSelector

  // New Board — inline input for easy creation
  newBoardBtn.addEventListener('click', () => {
    showTabModal();
  });

  // Tab modal events
  cancelTabBtn.addEventListener('click', hideTabModal);
  tabModal.addEventListener('click', (e) => {
    if (e.target === tabModal) hideTabModal();
  });
  tabForm.addEventListener('submit', (e) => {
    e.preventDefault();
    handleTabFormSubmit();
  });

  // New Task
  newTaskBtn.addEventListener('click', () => {
    showTaskForm();
  });

  // Sort tasks
  document.getElementById('taskSortSelect').addEventListener('change', (e) => {
    currentSort = e.target.value;
    renderBoard();
  });

  // Refresh tasks
  const refreshBtn = document.getElementById('refreshTasksBtn');
  refreshBtn.addEventListener('click', async () => {
    if (!currentBoardId) return;
    refreshBtn.classList.add('spinning');
    refreshBtn.disabled = true;
    await fetchBoardTasks(currentBoardId);
    refreshBtn.classList.remove('spinning');
    refreshBtn.disabled = false;
  });

  // Cancel task form
  cancelTaskBtn.addEventListener('click', hideTaskForm);

  // Delete task from edit modal
  deleteTaskBtn.addEventListener('click', async () => {
    const id = document.getElementById('taskId').value;
    if (!id) return;
    if (!confirm('Delete this task? This cannot be undone.')) return;
    await deleteTask(id);
    hideTaskForm();
  });

  // Close modal on backdrop click
  taskModal.addEventListener('click', (e) => {
    if (e.target === taskModal) hideTaskForm();
  });

  // Close modal on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !taskModal.hidden) {
      hideTaskForm();
    }
    if (e.key === 'Escape' && !tabModal.hidden) {
      hideTabModal();
    }
  });

  // Task form submit
  taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const id = document.getElementById('taskId').value;
    const title = document.getElementById('taskTitle').value.trim();
    const description = document.getElementById('taskDescription').value.trim();
    const type = document.getElementById('taskType').value;
    const priority = parseInt(document.getElementById('taskPriority').value, 10);
    const state = document.getElementById('taskState').value;

    if (!title) {
      document.getElementById('taskTitle').focus();
      return;
    }

    if (id) {
      // Update existing task
      await updateTask(id, { title, description, type, priority, state });
    } else {
      // Create new task — origin defaults to 'user' on server
      await createTask({
        title,
        description,
        type,
        priority,
        tabIds: currentBoardId ? [Number(currentBoardId)] : []
      });
    }

    hideTaskForm();
  });
}

// ===== Periodic Reconciliation =====
function startReconciliation() {
  reconcileTimer = setInterval(() => {
    if (currentBoardId) {
      fetchBoardTasks(currentBoardId);
    }
  }, 30000);
}

// ===== Init =====
async function init() {
  // Auth gate: redirect to login if not authenticated
  const authenticated = await checkAuth();
  if (!authenticated) return;

  setupTabs();
  setupEventListeners();
  setupDragAndDrop();
  connectWebSocket();
  fetchBoards();
  startReconciliation();
  setupSessions();
  setupAgents();
  setupErrors();
  setupSettings();
}

document.addEventListener('DOMContentLoaded', init);

// =============================================================================
// ===== SESSIONS MODULE =======================================================
// =============================================================================

let sessions = [];
let activeSessionId = null;

// Session DOM refs
const sessionList = document.getElementById('sessionList');
const newSessionBtn = document.getElementById('newSessionBtn');
const sessionModal = document.getElementById('sessionModal');
const sessionForm = document.getElementById('sessionForm');
const cancelSessionBtn = document.getElementById('cancelSessionBtn');
const sessionDetailPanel = document.getElementById('sessionDetailPanel');
const sessionEmptyState = document.getElementById('sessionEmptyState');
const sessionDetail = document.getElementById('sessionDetail');
const sessionDetailName = document.getElementById('sessionDetailName');
const sessionDetailAgent = document.getElementById('sessionDetailAgent');
const sessionDetailStatus = document.getElementById('sessionDetailStatus');
const sessionStartBtn = document.getElementById('sessionStartBtn');
const sessionStopBtn = document.getElementById('sessionStopBtn');
const sessionDeleteBtn = document.getElementById('sessionDeleteBtn');
const activityDot = document.getElementById('activityDot');
const activityText = document.getElementById('activityText');
const outputPre = document.getElementById('outputPre');
const sessionPromptInput = document.getElementById('sessionPromptInput');
const sessionPromptSendBtn = document.getElementById('sessionPromptSendBtn');

// Quick-start (empty state) DOM refs
const quickStartForm = document.getElementById('quickStartForm');
const quickStartPrompt = document.getElementById('quickStartPrompt');
const quickStartAgent = document.getElementById('quickStartAgent');
const quickStartSendBtn = document.getElementById('quickStartSendBtn');
const quickStartAdvancedBtn = document.getElementById('quickStartAdvancedBtn');

// Session tabs editor DOM refs
const sessionTabsList = document.getElementById('sessionTabsList');
const sessionEditTabsBtn = document.getElementById('sessionEditTabsBtn');
const sessionTabsEditor = document.getElementById('sessionTabsEditor');
const sessionTabsSelect = document.getElementById('sessionTabsSelect');
const sessionTabsSaveBtn = document.getElementById('sessionTabsSaveBtn');
const sessionTabsCancelBtn = document.getElementById('sessionTabsCancelBtn');

// MCP override elements in session modal
const sessionMcpToggle = document.getElementById('sessionMcpToggle');
const sessionMcpSection = document.getElementById('sessionMcpSection');
const sessionMcpAtlassian = document.getElementById('sessionMcpAtlassian');
const sessionMcpAzureDevops = document.getElementById('sessionMcpAzureDevops');
const sessionMcpAwsApi = document.getElementById('sessionMcpAwsApi');
const sessionMcpAwsDocs = document.getElementById('sessionMcpAwsDocs');
let sessionMcpOverrideEnabled = false; // Track if user toggled any MCP checkbox

function setupSessions() {
  fetchSessions();

  newSessionBtn.addEventListener('click', async () => {
    sessionModal.hidden = false;
    await populateAgentDropdown();
    populateSessionBoardsSelect();
    prefillSessionMcpFromBoards();
    sessionMcpOverrideEnabled = false;
    document.getElementById('sessionName').focus();
  });

  cancelSessionBtn.addEventListener('click', hideSessionForm);

  // MCP Servers collapsible toggle
  sessionMcpToggle.addEventListener('click', () => {
    const expanded = sessionMcpToggle.getAttribute('aria-expanded') === 'true';
    sessionMcpToggle.setAttribute('aria-expanded', String(!expanded));
    sessionMcpSection.classList.toggle('expanded', !expanded);
  });

  // Re-fill MCP defaults when board selection changes
  document.getElementById('sessionBoards').addEventListener('change', () => {
    if (!sessionMcpOverrideEnabled) {
      prefillSessionMcpFromBoards();
    }
  });

  // Show agent description when selection changes
  document.getElementById('sessionAgent').addEventListener('change', (e) => {
    const descEl = document.getElementById('sessionAgentDescription');
    const selected = e.target.selectedOptions[0];
    const desc = selected ? selected.dataset.description : '';
    descEl.textContent = desc || '';
  });

  // Track if user manually changed any MCP toggle
  [sessionMcpAtlassian, sessionMcpAzureDevops, sessionMcpAwsApi, sessionMcpAwsDocs].forEach(el => {
    el.addEventListener('change', () => { sessionMcpOverrideEnabled = true; });
  });

  sessionModal.addEventListener('click', (e) => {
    if (e.target === sessionModal) hideSessionForm();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sessionModal.hidden) {
      hideSessionForm();
    }
  });

  sessionForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await createAndStartSession();
  });

  sessionStartBtn.addEventListener('click', () => {
    if (activeSessionId) startAgentSession(activeSessionId);
  });

  sessionStopBtn.addEventListener('click', () => {
    if (activeSessionId) stopAgentSession(activeSessionId);
  });

  sessionDeleteBtn.addEventListener('click', async () => {
    if (!activeSessionId) return;
    const session = sessions.find(s => s.id === activeSessionId);
    if (session?.pinned) return; // permanent Chat session — button is disabled anyway
    if (!confirm('Delete this session? This will stop the agent if running.')) return;
    await deleteAgentSession(activeSessionId);
  });

  sessionPromptSendBtn.addEventListener('click', sendFollowUpPrompt);
  sessionPromptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendFollowUpPrompt();
    }
  });

  // Allow Ctrl+A inside the output viewer to select only log content
  const sessionOutputEl = document.getElementById('sessionOutput');
  sessionOutputEl.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(outputPre);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  });

  // Session tabs editing
  sessionEditTabsBtn.addEventListener('click', () => {
    openSessionTabsEditor();
  });

  sessionTabsSaveBtn.addEventListener('click', async () => {
    await saveSessionTabs();
  });

  sessionTabsCancelBtn.addEventListener('click', () => {
    sessionTabsEditor.hidden = true;
  });

  // Quick-start form (shown in the empty state)
  quickStartForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await createQuickStartSession();
  });
  quickStartPrompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      createQuickStartSession();
    }
  });
  quickStartAdvancedBtn.addEventListener('click', async () => {
    sessionModal.hidden = false;
    await populateAgentDropdown();
    populateSessionBoardsSelect();
    prefillSessionMcpFromBoards();
    sessionMcpOverrideEnabled = false;
    // Carry over whatever the user already typed
    if (quickStartPrompt.value.trim()) {
      document.getElementById('sessionPrompt').value = quickStartPrompt.value.trim();
    }
    document.getElementById('sessionName').focus();
  });
}

async function populateQuickStartAgentDropdown() {
  quickStartAgent.innerHTML = '<option value="">No agent (chat)</option>';
  try {
    const res = await fetch('/api/agents');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const agentsList = await res.json();
    agentsList.forEach(agent => {
      const opt = document.createElement('option');
      opt.value = agent.name;
      opt.textContent = agent.name;
      quickStartAgent.appendChild(opt);
    });
  } catch (e) {
    console.error('Failed to fetch agents for quick-start:', e);
  }
}

function hideSessionForm() {
  sessionModal.hidden = true;
  sessionForm.reset();
  // Reset MCP override section
  sessionMcpToggle.setAttribute('aria-expanded', 'false');
  sessionMcpSection.classList.remove('expanded');
  sessionMcpOverrideEnabled = false;
  // Clear agent description hint
  document.getElementById('sessionAgentDescription').textContent = '';
}

async function populateAgentDropdown() {
  const select = document.getElementById('sessionAgent');
  select.innerHTML = '<option value="">None (interactive)</option><option value="" disabled>Loading agents…</option>';
  try {
    const res = await fetch('/api/agents');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const agents = await res.json();
    // Keep "None" as the first option, then append agents
    select.innerHTML = '<option value="">None (interactive)</option>';
    agents.forEach(agent => {
      const opt = document.createElement('option');
      opt.value = agent.name;
      opt.textContent = agent.name;
      opt.dataset.description = agent.description || '';
      select.appendChild(opt);
    });
    // Default selection is "None (interactive)"
    select.selectedIndex = 0;
    const descEl = document.getElementById('sessionAgentDescription');
    descEl.textContent = '';
  } catch (e) {
    console.error('Failed to fetch agents:', e);
    select.innerHTML = '<option value="">None (interactive)</option><option value="" disabled>Failed to load agents</option>';
  }
}

/**
 * Pre-fill session MCP toggles from the first selected board's mcpConfig.
 * Falls back to defaults if no board is selected.
 */
function prefillSessionMcpFromBoards() {
  const defaultMcp = { atlassian: true, azureDevops: true, awsApi: false, awsDocs: true };
  const boardsSelect = document.getElementById('sessionBoards');
  const selectedBoardIds = Array.from(boardsSelect.selectedOptions).map(opt => Number(opt.value));

  let mcp = { ...defaultMcp };
  if (selectedBoardIds.length > 0) {
    const board = boards.find(b => b.id === selectedBoardIds[0]);
    if (board && board.mcpConfig) {
      mcp = { ...defaultMcp, ...board.mcpConfig };
    }
  }

  sessionMcpAtlassian.checked = mcp.atlassian !== false;
  sessionMcpAzureDevops.checked = mcp.azureDevops !== false;
  sessionMcpAwsApi.checked = mcp.awsApi === true;
  sessionMcpAwsDocs.checked = mcp.awsDocs !== false;
}

function populateSessionBoardsSelect() {
  const select = document.getElementById('sessionBoards');
  select.innerHTML = '';
  boards.forEach(board => {
    const opt = document.createElement('option');
    opt.value = board.id;
    opt.textContent = board.name;
    // Pre-select the currently viewed board
    if (currentBoardId && Number(currentBoardId) === board.id) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });
}

// ===== Sessions REST API =====
async function fetchSessions() {
  try {
    const res = await fetch('/api/sessions');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    sessions = await res.json();
    renderSessionList();
  } catch (e) {
    console.error('Failed to fetch sessions:', e);
  }
}

/**
 * Core session creation logic shared by the full "New Session" modal and the
 * lightweight quick-start form shown in the empty state.
 */
async function createAndStartSessionCore({ name, agent, prompt, cwd, model, interactive, runs, intervalSeconds, boardIds, mcpConfigOverride }) {
  if (!name) return null;

  // Agentless sessions are always interactive and never loop
  const isAgentless = !agent;
  const loop = isAgentless ? false : true; // agent sessions always loop — runs controls iterations
  const effectiveInteractive = isAgentless ? true : interactive;

  try {
    const body = {
      name,
      prompt: prompt || undefined,
      cwd: cwd || undefined,
      model: model || undefined,
      interactive: effectiveInteractive,
      loop,
      runs: isAgentless ? 0 : (runs || 0),
      intervalSeconds: intervalSeconds || 10,
      tabIds: boardIds && boardIds.length > 0 ? boardIds : undefined,
      mcpConfigOverride,
    };
    if (agent) body.agent = agent;
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const session = await res.json();
    // Guard against duplicate: WebSocket broadcast may have already added this session
    const exists = sessions.find(x => x.id === session.id);
    if (!exists) {
      sessions.push(session);
    } else {
      const idx = sessions.findIndex(x => x.id === session.id);
      sessions[idx] = session;
    }
    renderSessionList();
    selectSession(session.id);

    // Auto-start the session
    await startAgentSession(session.id);
    return session;
  } catch (e) {
    console.error('Failed to create session:', e);
    alert('Failed to create session: ' + e.message);
    return null;
  }
}

async function createAndStartSession() {
  const name = document.getElementById('sessionName').value.trim();
  const agent = document.getElementById('sessionAgent').value.trim();
  const prompt = document.getElementById('sessionPrompt').value.trim();
  const cwd = document.getElementById('sessionCwd').value.trim();
  const model = document.getElementById('sessionModel').value.trim();
  const interactive = document.getElementById('sessionInteractive').checked;
  const runs = parseInt(document.getElementById('sessionRuns').value, 10) || 0;
  const intervalSeconds = parseInt(document.getElementById('sessionInterval').value, 10) || 10;

  // Collect selected board IDs from the multi-select
  const boardsSelect = document.getElementById('sessionBoards');
  const boardIds = Array.from(boardsSelect.selectedOptions).map(opt => Number(opt.value));

  // If no boards explicitly selected, default to the current board
  if (boardIds.length === 0 && currentBoardId) {
    boardIds.push(Number(currentBoardId));
  }

  // Collect MCP override if user expanded the section and toggled anything
  const mcpConfigOverride = sessionMcpOverrideEnabled ? {
    atlassian: sessionMcpAtlassian.checked,
    azureDevops: sessionMcpAzureDevops.checked,
    awsApi: sessionMcpAwsApi.checked,
    awsDocs: sessionMcpAwsDocs.checked,
  } : undefined;

  const session = await createAndStartSessionCore({ name, agent, prompt, cwd, model, interactive, runs, intervalSeconds, boardIds, mcpConfigOverride });
  if (session) hideSessionForm();
}

/**
 * Quick-start: create an interactive (or agent-driven) session directly from
 * the sessions empty state, without opening the full "New Session" modal.
 */
async function createQuickStartSession() {
  const prompt = quickStartPrompt.value.trim();
  const agent = quickStartAgent.value.trim();
  if (!prompt) {
    quickStartPrompt.focus();
    return;
  }

  const boardIds = currentBoardId ? [Number(currentBoardId)] : [];
  // Derive a short session name from the prompt itself
  const name = prompt.length > 48 ? prompt.slice(0, 45).trim() + '…' : prompt;

  quickStartSendBtn.disabled = true;
  try {
    await createAndStartSessionCore({ name, agent, prompt, interactive: true, boardIds });
    quickStartForm.reset();
  } finally {
    quickStartSendBtn.disabled = false;
  }
}

async function startAgentSession(id) {
  try {
    const res = await fetch(`/api/sessions/${id}/start`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error('Failed to start session:', e);
  }
}

async function stopAgentSession(id) {
  try {
    const res = await fetch(`/api/sessions/${id}/stop`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error('Failed to stop session:', e);
  }
}

async function deleteAgentSession(id) {
  try {
    const res = await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    sessions = sessions.filter(s => s.id !== id);
    renderSessionList();
    if (activeSessionId === id) {
      activeSessionId = null;
      showSessionEmpty();
    }
  } catch (e) {
    console.error('Failed to delete session:', e);
  }
}

async function fetchSessionOutput(id) {
  try {
    const res = await fetch(`/api/sessions/${id}/output`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error('Failed to fetch output:', e);
    return [];
  }
}

async function sendFollowUpPrompt() {
  const text = sessionPromptInput.value.trim();
  if (!text || !activeSessionId) return;

  try {
    const res = await fetch(`/api/sessions/${activeSessionId}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    sessionPromptInput.value = '';
  } catch (e) {
    console.error('Failed to send prompt:', e);
    alert('Failed to send prompt: ' + e.message);
  }
}

// ===== Session Selection & Rendering =====
function selectSession(id) {
  activeSessionId = id;
  const session = sessions.find(s => s.id === id);
  if (!session) return;

  document.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('active', el.dataset.sessionId === id);
  });

  sessionEmptyState.hidden = true;
  sessionDetail.hidden = false;

  sessionDetailName.textContent = session.name;
  sessionDetailAgent.textContent = session.agent || 'Interactive';
  updateSessionStatusUI(session.status);
  updateSessionTabsDisplay(session);
  updateSessionPinnedUI(session);

  // Hide tabs editor when switching sessions
  sessionTabsEditor.hidden = true;

  loadSessionOutput(id);
}

async function loadSessionOutput(id) {
  const entries = await fetchSessionOutput(id);
  outputPre.innerHTML = '';
  entries.forEach(entry => appendOutputEntry(entry));
  scrollOutputToBottom();
}

function updateSessionTabsDisplay(session) {
  if (!session.tabIds || session.tabIds.length === 0) {
    sessionTabsList.textContent = 'None';
  } else {
    const tabNames = session.tabIds
      .map(tid => { const tab = boards.find(b => b.id === tid); return tab ? tab.name : `#${tid}`; })
      .join(', ');
    sessionTabsList.textContent = tabNames;
  }
}

function openSessionTabsEditor() {
  const session = sessions.find(s => s.id === activeSessionId);
  if (!session) return;

  sessionTabsSelect.innerHTML = '';
  boards.forEach(board => {
    const opt = document.createElement('option');
    opt.value = board.id;
    opt.textContent = board.name;
    if (session.tabIds && session.tabIds.includes(board.id)) {
      opt.selected = true;
    }
    sessionTabsSelect.appendChild(opt);
  });

  sessionTabsEditor.hidden = false;
}

async function saveSessionTabs() {
  if (!activeSessionId) return;

  const tabIds = Array.from(sessionTabsSelect.selectedOptions).map(opt => Number(opt.value));
  try {
    const res = await fetch(`/api/sessions/${activeSessionId}/tabs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabIds }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Update local state
    const session = sessions.find(s => s.id === activeSessionId);
    if (session) {
      session.tabIds = tabIds.length > 0 ? tabIds : undefined;
      updateSessionTabsDisplay(session);
      renderSessionList();
    }

    sessionTabsEditor.hidden = true;
  } catch (e) {
    console.error('Failed to update session tabs:', e);
  }
}

function showSessionEmpty() {
  sessionEmptyState.hidden = false;
  sessionDetail.hidden = true;
  outputPre.innerHTML = '';
  populateQuickStartAgentDropdown();
  quickStartPrompt.focus();
}

function updateSessionStatusUI(status) {
  sessionDetailStatus.textContent = status;
  sessionDetailStatus.className = 'session-status-badge status-' + status;

  const session = sessions.find(s => s.id === activeSessionId);
  const isRunning = status === 'running';
  const isInteractive = session?.interactive !== false;
  const isLoop = session?.loop === true;

  sessionStartBtn.disabled = isRunning;
  sessionStopBtn.disabled = !isRunning;
  sessionPromptInput.disabled = !(isRunning && isInteractive && !isLoop);
  sessionPromptSendBtn.disabled = !(isRunning && isInteractive && !isLoop);

  if (isLoop) {
    const runsLabel = session.runs === 0 ? 'endless' : `${session.runs} run(s)`;
    sessionPromptInput.placeholder = `Autonomous — ${runsLabel}, ${session.intervalSeconds}s interval`;
  } else if (!isInteractive) {
    sessionPromptInput.placeholder = 'Non-interactive session';
  } else {
    sessionPromptInput.placeholder = 'Send a follow-up prompt...';
  }
}

/**
 * Disables delete for the permanent, pinned Chat session and shows a badge
 * next to its name in the detail header.
 */
function updateSessionPinnedUI(session) {
  sessionDeleteBtn.disabled = !!session.pinned;
  sessionDeleteBtn.title = session.pinned ? 'The pinned Chat session cannot be deleted' : 'Delete session';
  sessionDetailName.classList.toggle('session-detail-name-pinned', !!session.pinned);
}

function renderSessionList() {
  sessionList.innerHTML = '';

  // Filter sessions to only show those assigned to the current board/tab
  // Agentless sessions are always shown regardless of board filter
  let visibleSessions = currentBoardId
    ? sessions.filter(s => !s.agent || (s.tabIds && s.tabIds.includes(Number(currentBoardId))))
    : sessions;

  // Sort: pinned session always first, then agentless (interactive) sessions,
  // then everything else. Order within each group is preserved.
  visibleSessions = [...visibleSessions].sort((a, b) => {
    const aRank = a.pinned ? 0 : (!a.agent ? 1 : 2);
    const bRank = b.pinned ? 0 : (!b.agent ? 1 : 2);
    return aRank - bRank;
  });

  if (visibleSessions.length === 0) {
    sessionList.innerHTML = '<li class="session-empty-hint">No sessions for this tab. Create one with + New Session.</li>';
    return;
  }

  visibleSessions.forEach(session => {
    const li = document.createElement('li');
    li.className = 'session-item' + (session.id === activeSessionId ? ' active' : '') + (session.pinned ? ' session-item-pinned' : '');
    li.dataset.sessionId = session.id;

    const statusClass = 'status-dot-sm status-' + session.status;
    const activity = session.currentActivity;
    const activityDetail = activity && activity.detail ? activity.detail : '';
    const activityType = activity ? activity.type : '';
    // Build a short status line: show what the agent is working on
    let activityHtml = '';
    if (session.status === 'running' && activityDetail) {
      activityHtml = `<span class="session-item-activity">${escapeHtml(activityDetail)}</span>`;
    } else if (session.status === 'running' && activityType) {
      activityHtml = `<span class="session-item-activity">${escapeHtml(activityType)}</span>`;
    }

    const pinIconHtml = session.pinned ? '<span class="session-item-pin" title="Pinned">📌</span>' : '';

    li.innerHTML = `
      <span class="${statusClass}" aria-hidden="true"></span>
      <div class="session-item-info">
        <span class="session-item-name">${pinIconHtml}${escapeHtml(session.name)}</span>
        <span class="session-item-agent">${session.agent ? escapeHtml(session.agent) : '<em>Interactive</em>'}</span>
        ${activityHtml}
      </div>
    `;

    li.addEventListener('click', () => selectSession(session.id));
    sessionList.appendChild(li);
  });
}

function appendOutputEntry(entry) {
  const line = document.createElement('span');
  line.className = 'output-line output-' + entry.stream;

  const ts = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '';
  line.textContent = (ts ? `[${ts}] ` : '') + entry.text;
  outputPre.appendChild(line);
  outputPre.appendChild(document.createTextNode('\n'));
}

function scrollOutputToBottom() {
  const container = document.getElementById('sessionOutput');
  if (container) {
    container.scrollTop = container.scrollHeight;
  }
}

// ===== Session WebSocket Handlers =====
function handleSessionWsMessage(message) {
  const { type } = message;

  switch (type) {
    case 'session-created': {
      const s = message.session;
      if (s && !sessions.find(x => x.id === s.id)) {
        sessions.push(s);
        renderSessionList();
      }
      // Add to board members if this session belongs to the current board
      if (s && currentBoardId && s.tabIds && s.tabIds.includes(Number(currentBoardId))) {
        const exists = boardSessions.find(bs => bs.id === s.id);
        if (!exists) {
          boardSessions.push({ id: s.id, name: s.name, agent: s.agent, status: s.status });
          renderBoardMembers();
        }
      }
      break;
    }

    case 'session-updated': {
      const s = message.session;
      if (s) {
        const idx = sessions.findIndex(x => x.id === s.id);
        if (idx !== -1) sessions[idx] = { ...sessions[idx], ...s, output: sessions[idx].output || [] };
        else sessions.push(s);
        renderSessionList();

        if (s.id === activeSessionId) {
          sessionDetailName.textContent = s.name;
          sessionDetailAgent.textContent = s.agent || 'Interactive';
          updateSessionStatusUI(s.status);
          updateSessionTabsDisplay(s);
          updateSessionPinnedUI(s);
        }

        // Refresh board members if this session belongs to the current board
        if (currentBoardId && s.boardIds && s.boardIds.includes(Number(currentBoardId))) {
          const bsIdx = boardSessions.findIndex(bs => bs.id === s.id);
          const entry = { id: s.id, name: s.name, agent: s.agent, status: s.status };
          if (bsIdx !== -1) boardSessions[bsIdx] = entry;
          else boardSessions.push(entry);
          renderBoardMembers();
        }
      }
      break;
    }

    case 'session-deleted': {
      const sid = message.sessionId;
      sessions = sessions.filter(s => s.id !== sid);
      renderSessionList();
      if (activeSessionId === sid) {
        activeSessionId = null;
        showSessionEmpty();
      }
      // Remove from board members
      const bsBefore = boardSessions.length;
      boardSessions = boardSessions.filter(bs => bs.id !== sid);
      if (boardSessions.length !== bsBefore) {
        renderBoardMembers();
      }
      break;
    }

    case 'session-output': {
      const { sessionId, entry } = message;
      if (sessionId === activeSessionId && entry) {
        appendOutputEntry(entry);
        scrollOutputToBottom();
      }
      break;
    }

    case 'session-activity': {
      const { sessionId, activity } = message;
      // Update the session object with current activity
      const sIdx = sessions.findIndex(x => x.id === sessionId);
      if (sIdx !== -1) {
        sessions[sIdx].currentActivity = activity;
        renderSessionList();
      }
      if (sessionId === activeSessionId && activity) {
        updateActivityUI(activity);
      }
      break;
    }
  }
}

function updateActivityUI(activity) {
  activityDot.className = 'activity-dot activity-' + activity.type;
  activityText.textContent = activity.detail || activity.type || 'Idle';
}


// =============================================================================
// ===== AGENTS MODULE =========================================================
// =============================================================================

let agents = [];
let activeAgentName = null;

// Agent DOM refs
const agentList = document.getElementById('agentList');
const newAgentBtn = document.getElementById('newAgentBtn');
const agentModal = document.getElementById('agentModal');
const agentForm = document.getElementById('agentForm');
const cancelAgentBtn = document.getElementById('cancelAgentBtn');
const cancelAgentJsonBtn = document.getElementById('cancelAgentJsonBtn');
const agentEmptyState = document.getElementById('agentEmptyState');
const agentEmptyCreateBtn = document.getElementById('agentEmptyCreateBtn');
const agentDetail = document.getElementById('agentDetail');
const agentDetailName = document.getElementById('agentDetailName');
const agentDetailDesc = document.getElementById('agentDetailDesc');
const agentDetailPrompt = document.getElementById('agentDetailPrompt');
const agentDetailTools = document.getElementById('agentDetailTools');
const agentDetailAllowed = document.getElementById('agentDetailAllowed');
const agentDetailResources = document.getElementById('agentDetailResources');
const agentDetailSettings = document.getElementById('agentDetailSettings');
const agentEditBtn = document.getElementById('agentEditBtn');
const agentDeleteBtn = document.getElementById('agentDeleteBtn');
const agentExportBtn = document.getElementById('agentExportBtn');
const agentModeGuided = document.getElementById('agentModeGuided');
const agentModeJson = document.getElementById('agentModeJson');
const agentJsonSection = document.getElementById('agentJsonSection');
const agentJsonFile = document.getElementById('agentJsonFile');
const agentJsonRaw = document.getElementById('agentJsonRaw');
const agentJsonError = document.getElementById('agentJsonError');
const submitAgentJsonBtn = document.getElementById('submitAgentJsonBtn');
const agentModalTitle = document.getElementById('agentModalTitle');
const submitAgentBtn = document.getElementById('submitAgentBtn');

function setupAgents() {
  newAgentBtn.addEventListener('click', () => showAgentModal());
  agentEmptyCreateBtn.addEventListener('click', () => showAgentModal());

  cancelAgentBtn.addEventListener('click', hideAgentModal);
  cancelAgentJsonBtn.addEventListener('click', hideAgentModal);

  agentModal.addEventListener('click', (e) => {
    if (e.target === agentModal) hideAgentModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !agentModal.hidden) {
      hideAgentModal();
    }
  });

  // Mode toggle
  agentModeGuided.addEventListener('click', () => {
    agentModeGuided.classList.add('active');
    agentModeJson.classList.remove('active');
    agentForm.hidden = false;
    agentJsonSection.hidden = true;
  });

  agentModeJson.addEventListener('click', () => {
    agentModeJson.classList.add('active');
    agentModeGuided.classList.remove('active');
    agentForm.hidden = true;
    agentJsonSection.hidden = false;
  });

  // Guided form submit
  agentForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await submitAgentGuided();
  });

  // JSON upload / paste submit
  submitAgentJsonBtn.addEventListener('click', async () => {
    await submitAgentJson();
  });

  // File input: auto-populate textarea when file is selected
  agentJsonFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      agentJsonRaw.value = text;
    } catch (err) {
      console.error('Failed to read file:', err);
    }
  });

  // Detail actions
  agentEditBtn.addEventListener('click', () => {
    const agent = agents.find(a => a.name === activeAgentName);
    if (agent) showAgentModal(agent);
  });

  agentDeleteBtn.addEventListener('click', async () => {
    if (!activeAgentName) return;
    if (!confirm(`Delete agent "${activeAgentName}"? This cannot be undone.`)) return;
    await deleteAgent(activeAgentName);
  });

  agentExportBtn.addEventListener('click', () => {
    const agent = agents.find(a => a.name === activeAgentName);
    if (agent) exportAgentAsJson(agent);
  });
}

// ===== Agents REST API =====
async function fetchAgents() {
  try {
    const res = await fetch('/api/agents');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    agents = await res.json();
    renderAgentList();
  } catch (e) {
    console.error('Failed to fetch agents:', e);
  }
}

async function createAgent(data) {
  try {
    const res = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const agent = await res.json();
    agents.push(agent);
    renderAgentList();
    selectAgent(agent.name);
    return agent;
  } catch (e) {
    alert('Failed to create agent: ' + e.message);
    throw e;
  }
}

async function updateAgent(name, data) {
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const agent = await res.json();
    const idx = agents.findIndex(a => a.name === name);
    if (idx !== -1) agents[idx] = agent;
    else agents.push(agent);
    renderAgentList();
    selectAgent(agent.name);
    return agent;
  } catch (e) {
    alert('Failed to update agent: ' + e.message);
    throw e;
  }
}

async function deleteAgent(name) {
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    agents = agents.filter(a => a.name !== name);
    renderAgentList();
    if (activeAgentName === name) {
      activeAgentName = null;
      showAgentEmpty();
    }
  } catch (e) {
    console.error('Failed to delete agent:', e);
    alert('Failed to delete agent: ' + e.message);
  }
}

function exportAgentAsJson(agent) {
  // Build a clean export object (exclude internal metadata)
  const exportData = {
    name: agent.name,
    description: agent.description || '',
    prompt: agent.prompt || '',
    tools: agent.tools || [],
    allowedTools: agent.allowedTools || [],
    toolsSettings: agent.toolsSettings || {},
    resources: agent.resources || [],
  };

  const json = JSON.stringify(exportData, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `${agent.name}.agent.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ===== Agent Modal =====
function showAgentModal(agent = null) {
  agentModal.hidden = false;
  agentJsonError.hidden = true;
  agentJsonRaw.value = '';
  agentJsonFile.value = '';

  // Default to guided mode
  agentModeGuided.classList.add('active');
  agentModeJson.classList.remove('active');
  agentForm.hidden = false;
  agentJsonSection.hidden = true;

  if (agent) {
    agentModalTitle.textContent = 'Edit Agent';
    submitAgentBtn.textContent = 'Update Agent';
    document.getElementById('agentFormOriginalName').value = agent.name;
    document.getElementById('agentFormName').value = agent.name || '';
    document.getElementById('agentFormDescription').value = agent.description || '';
    document.getElementById('agentFormPrompt').value = agent.prompt || '';
    document.getElementById('agentFormTools').value = (agent.tools || []).join(', ');
    document.getElementById('agentFormAllowed').value = (agent.allowedTools || []).join(', ');
    document.getElementById('agentFormResources').value = (agent.resources || []).join('\n');
    document.getElementById('agentFormSettings').value = agent.toolsSettings
      ? JSON.stringify(agent.toolsSettings, null, 2)
      : '';
  } else {
    agentModalTitle.textContent = 'New Agent';
    submitAgentBtn.textContent = 'Create Agent';
    agentForm.reset();
    document.getElementById('agentFormOriginalName').value = '';
  }

  document.getElementById('agentFormName').focus();
}

function hideAgentModal() {
  agentModal.hidden = true;
  agentForm.reset();
  agentJsonRaw.value = '';
  agentJsonFile.value = '';
  agentJsonError.hidden = true;
}

// ===== Submit Handlers =====
async function submitAgentGuided() {
  const originalName = document.getElementById('agentFormOriginalName').value;
  const name = document.getElementById('agentFormName').value.trim();
  const description = document.getElementById('agentFormDescription').value.trim();
  const prompt = document.getElementById('agentFormPrompt').value.trim();
  const toolsStr = document.getElementById('agentFormTools').value.trim();
  const allowedStr = document.getElementById('agentFormAllowed').value.trim();
  const resourcesStr = document.getElementById('agentFormResources').value.trim();
  const settingsStr = document.getElementById('agentFormSettings').value.trim();

  if (!name || !prompt) return;

  const tools = toolsStr ? toolsStr.split(',').map(s => s.trim()).filter(Boolean) : [];
  const allowedTools = allowedStr ? allowedStr.split(',').map(s => s.trim()).filter(Boolean) : [];
  const resources = resourcesStr ? resourcesStr.split('\n').map(s => s.trim()).filter(Boolean) : [];

  let toolsSettings = {};
  if (settingsStr) {
    try {
      toolsSettings = JSON.parse(settingsStr);
    } catch {
      alert('Tools Settings must be valid JSON');
      return;
    }
  }

  const data = { name, description, prompt, tools, allowedTools, toolsSettings, resources };

  try {
    if (originalName) {
      await updateAgent(originalName, data);
    } else {
      await createAgent(data);
    }
    hideAgentModal();
  } catch {
    // Error already shown by createAgent/updateAgent
  }
}

async function submitAgentJson() {
  agentJsonError.hidden = true;
  const raw = agentJsonRaw.value.trim();

  if (!raw) {
    showJsonError('Please upload a file or paste JSON content.');
    return;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    showJsonError('Invalid JSON: ' + e.message);
    return;
  }

  if (!data.name) {
    showJsonError('The JSON must contain a "name" field.');
    return;
  }

  if (!data.prompt) {
    showJsonError('The JSON must contain a "prompt" field.');
    return;
  }

  try {
    await createAgent(data);
    hideAgentModal();
  } catch {
    // Error already shown
  }
}

function showJsonError(msg) {
  agentJsonError.textContent = msg;
  agentJsonError.hidden = false;
}

// ===== Agent Selection & Rendering =====
function selectAgent(name) {
  activeAgentName = name;
  const agent = agents.find(a => a.name === name);
  if (!agent) return;

  document.querySelectorAll('.agent-item').forEach(el => {
    el.classList.toggle('active', el.dataset.agentName === name);
  });

  agentEmptyState.hidden = true;
  agentDetail.hidden = false;

  agentDetailName.textContent = agent.name;
  agentDetailDesc.textContent = agent.description || '(no description)';
  agentDetailPrompt.textContent = agent.prompt || '(no prompt)';

  renderAgentTags(agentDetailTools, agent.tools || []);
  renderAgentTags(agentDetailAllowed, agent.allowedTools || []);
  renderAgentTags(agentDetailResources, agent.resources || []);

  agentDetailSettings.textContent = agent.toolsSettings && Object.keys(agent.toolsSettings).length > 0
    ? JSON.stringify(agent.toolsSettings, null, 2)
    : '(none)';
}

function showAgentEmpty() {
  agentEmptyState.hidden = false;
  agentDetail.hidden = true;
}

function renderAgentList() {
  agentList.innerHTML = '';
  agents.forEach(agent => {
    const li = document.createElement('li');
    li.className = 'agent-item' + (agent.name === activeAgentName ? ' active' : '');
    li.dataset.agentName = agent.name;

    const initials = (agent.name || '?').substring(0, 2).toUpperCase();

    li.innerHTML = `
      <span class="agent-item-icon">${initials}</span>
      <div class="agent-item-info">
        <span class="agent-item-name">${escapeHtml(agent.name)}</span>
        <span class="agent-item-desc">${escapeHtml(agent.description || '')}</span>
      </div>
    `;

    li.addEventListener('click', () => selectAgent(agent.name));
    agentList.appendChild(li);
  });
}

function renderAgentTags(container, items) {
  container.innerHTML = '';
  if (items.length === 0) {
    container.innerHTML = '<span class="agent-tag">(none)</span>';
    return;
  }
  items.forEach(item => {
    const tag = document.createElement('span');
    tag.className = 'agent-tag';
    tag.textContent = item;
    container.appendChild(tag);
  });
}


// =============================================================================
// ===== ERRORS MODULE =========================================================
// =============================================================================

let agentErrors = [];

// Errors DOM refs
const errorsList = document.getElementById('errorsList');
const errorsEmpty = document.getElementById('errorsEmpty');
const clearErrorsBtn = document.getElementById('clearErrorsBtn');
const errorBadge = document.getElementById('errorBadge');

function setupErrors() {
  clearErrorsBtn.addEventListener('click', async () => {
    if (!confirm('Clear all agent errors? This cannot be undone.')) return;
    try {
      const res = await fetch('/api/errors', { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      agentErrors = [];
      renderErrors();
      updateErrorBadge();
    } catch (e) {
      console.error('Failed to clear errors:', e);
    }
  });

  // Fetch initial error count for badge
  fetchErrorCount();
}

async function fetchErrorCount() {
  try {
    const res = await fetch('/api/errors');
    if (!res.ok) return;
    const errors = await res.json();
    agentErrors = errors;
    updateErrorBadge();
  } catch {
    // Silently ignore — not critical for initial load
  }
}

async function fetchErrors() {
  try {
    const res = await fetch('/api/errors');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    agentErrors = await res.json();
    renderErrors();
    updateErrorBadge();
  } catch (e) {
    console.error('Failed to fetch errors:', e);
  }
}

function handleErrorWsMessage(message) {
  const { error } = message;
  if (!error) return;

  // Add to local state (newest first)
  const exists = agentErrors.find(e => e.id === error.id);
  if (!exists) {
    agentErrors.unshift(error);
  }

  updateErrorBadge();

  // If the errors panel is visible, re-render
  if (!panelErrors.hidden) {
    renderErrors();
  }
}

function updateErrorBadge() {
  const count = agentErrors.filter(e => !e.taskCreated).length;
  if (count > 0) {
    errorBadge.textContent = count > 99 ? '99+' : String(count);
    errorBadge.hidden = false;
  } else {
    errorBadge.hidden = true;
  }
}

function renderErrors() {
  if (agentErrors.length === 0) {
    errorsEmpty.hidden = false;
    // Remove all error cards but keep empty message
    const cards = errorsList.querySelectorAll('.error-card');
    cards.forEach(c => c.remove());
    return;
  }

  errorsEmpty.hidden = true;

  // Rebuild the list
  const fragment = document.createDocumentFragment();
  for (const error of agentErrors) {
    fragment.appendChild(createErrorCard(error));
  }

  // Clear old cards and append new
  errorsList.innerHTML = '';
  errorsList.appendChild(fragment);
}

function createErrorCard(error) {
  const card = document.createElement('div');
  card.className = 'error-card';
  card.dataset.errorId = error.id;

  const timeStr = formatErrorTime(error.timestamp);

  let actionsHtml;
  if (error.taskCreated) {
    actionsHtml = `<span class="error-task-created">✓ Bug task #${error.createdTaskId || '?'} created</span>`;
  } else {
    actionsHtml = `<button class="btn btn-primary btn-sm error-create-task-btn" data-error-id="${error.id}">🐛 Create Bug Task</button>`;
  }

  let taskMeta = '';
  if (error.taskTitle) {
    taskMeta = `<span class="error-meta-item">📋 Task #${error.taskId}: ${escapeHtml(error.taskTitle)}</span>`;
  }

  card.innerHTML = `
    <div class="error-card-header">
      <span class="error-card-message">${escapeHtml(error.message)}</span>
      <span class="error-card-time">${timeStr}</span>
    </div>
    <div class="error-card-meta">
      <span class="error-meta-item">🤖 ${escapeHtml(error.agent)}</span>
      <span class="error-meta-item">📡 ${escapeHtml(error.sessionName)}</span>
      ${taskMeta}
    </div>
    <div class="error-card-context">${escapeHtml(error.context)}</div>
    <div class="error-card-actions">${actionsHtml}</div>
  `;

  // Attach event listener for "Create Bug Task" button
  const btn = card.querySelector('.error-create-task-btn');
  if (btn) {
    btn.addEventListener('click', () => createBugTaskFromError(error.id));
  }

  return card;
}

async function createBugTaskFromError(errorId) {
  try {
    const res = await fetch(`/api/errors/${errorId}/create-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    if (res.status === 409) {
      // Already created
      const data = await res.json();
      alert(data.error || 'Bug task already created for this error.');
      return;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const { task, errorId: eid } = await res.json();

    // Update local state
    const err = agentErrors.find(e => e.id === eid);
    if (err) {
      err.taskCreated = true;
      err.createdTaskId = task.id;
    }

    renderErrors();
    updateErrorBadge();
  } catch (e) {
    console.error('Failed to create bug task:', e);
    alert('Failed to create bug task. See console for details.');
  }
}

function formatErrorTime(isoStr) {
  try {
    const d = new Date(isoStr);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);

    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDays = Math.floor(diffHr / 24);
    if (diffDays < 7) return `${diffDays}d ago`;

    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return isoStr;
  }
}


// =============================================================================
// ===== SETTINGS MODULE =======================================================
// =============================================================================

const settingsModal = document.getElementById('settingsModal');
const settingsBtn = document.getElementById('settingsBtn');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const settingsProfileInfo = document.getElementById('settingsProfileInfo');
const changePasswordForm = document.getElementById('changePasswordForm');
const changeApiKeyForm = document.getElementById('changeApiKeyForm');
const passwordMsg = document.getElementById('passwordMsg');
const apiKeyMsg = document.getElementById('apiKeyMsg');

function setupSettings() {
  // Open settings modal
  settingsBtn.addEventListener('click', () => {
    openSettingsModal();
  });

  // Close settings modal
  closeSettingsBtn.addEventListener('click', () => {
    closeSettingsModal();
  });

  // Close on backdrop click
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettingsModal();
  });

  // Change password form
  changePasswordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await handleChangePassword();
  });

  // Change API key form
  changeApiKeyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await handleChangeApiKey();
  });

  // Delete account form
  const deleteAccountForm = document.getElementById('deleteAccountForm');
  deleteAccountForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await handleDeleteAccount();
  });

  // Credential management
  setupCredentialHandlers();

  // Default git provider
  const saveGitProviderBtn = document.getElementById('saveGitProviderBtn');
  if (saveGitProviderBtn) {
    saveGitProviderBtn.addEventListener('click', async () => {
      await handleSaveDefaultGitProvider();
    });
  }
}

/**
 * Persist the profile-level default git provider.
 * 'auto' clears it, restoring detection from the repository URL.
 */
async function handleSaveDefaultGitProvider() {
  const select = document.getElementById('settingsDefaultGitProvider');
  const msg = document.getElementById('gitProviderMsg');
  if (!select) return;

  const value = select.value === 'auto' ? null : select.value;

  try {
    const res = await apiFetch('/api/auth/me/default-git-provider', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ defaultGitProvider: value })
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showMessage(msg, data.error || 'Failed to save default provider.', 'error');
      return;
    }

    const data = await res.json();
    if (data.user) currentUser = data.user;
    showMessage(
      msg,
      value ? `Default provider set to ${value}.` : 'Default provider cleared — detecting from repository URL.',
      'success'
    );
  } catch (err) {
    console.error('Save default git provider error:', err);
    showMessage(msg, 'Network error. Please try again.', 'error');
  }
}

function openSettingsModal() {
  // Populate profile info
  if (currentUser) {
    const createdDate = new Date(currentUser.createdAt).toLocaleDateString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric'
    });
    settingsProfileInfo.innerHTML = `
      <p><strong>Email:</strong> ${escapeHtml(currentUser.email)}</p>
      <p><strong>Member since:</strong> ${createdDate}</p>
    `;
  } else {
    settingsProfileInfo.innerHTML = '<p>Not logged in</p>';
  }

  // Reset forms and messages
  changePasswordForm.reset();
  changeApiKeyForm.reset();
  hideMessage(passwordMsg);
  hideMessage(apiKeyMsg);

  // Reset delete account form
  const deleteAccountForm = document.getElementById('deleteAccountForm');
  const deleteAccountMsg = document.getElementById('deleteAccountMsg');
  deleteAccountForm.reset();
  hideMessage(deleteAccountMsg);

  // Default git provider
  const gitProviderSelect = document.getElementById('settingsDefaultGitProvider');
  const gitProviderMsg = document.getElementById('gitProviderMsg');
  if (gitProviderSelect) {
    gitProviderSelect.value = currentUser?.defaultGitProvider || 'auto';
  }
  if (gitProviderMsg) hideMessage(gitProviderMsg);

  // Load credential status
  loadCredentialStatus();

  settingsModal.hidden = false;
}

function closeSettingsModal() {
  settingsModal.hidden = true;
}

async function handleChangePassword() {
  const currentPw = document.getElementById('settingsCurrentPw').value;
  const newPw = document.getElementById('settingsNewPw').value;

  if (!currentPw || !newPw) {
    showMessage(passwordMsg, 'Both fields are required.', 'error');
    return;
  }

  if (newPw.length < 8) {
    showMessage(passwordMsg, 'New password must be at least 8 characters.', 'error');
    return;
  }

  try {
    const res = await apiFetch('/api/auth/me/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw })
    });

    if (res.status === 401) {
      showMessage(passwordMsg, 'Current password is incorrect.', 'error');
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showMessage(passwordMsg, data.error || 'Failed to update password.', 'error');
      return;
    }

    showMessage(passwordMsg, 'Password updated successfully.', 'success');
    changePasswordForm.reset();
  } catch (err) {
    console.error('Change password error:', err);
    showMessage(passwordMsg, 'Network error. Please try again.', 'error');
  }
}

async function handleChangeApiKey() {
  const currentPw = document.getElementById('settingsApiKeyPw').value;
  const newApiKey = document.getElementById('settingsNewApiKey').value;

  if (!currentPw || !newApiKey) {
    showMessage(apiKeyMsg, 'Both fields are required.', 'error');
    return;
  }

  try {
    const res = await apiFetch('/api/auth/me/api-key', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ currentPassword: currentPw, kiroApiKey: newApiKey })
    });

    if (res.status === 401) {
      showMessage(apiKeyMsg, 'Current password is incorrect.', 'error');
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showMessage(apiKeyMsg, data.error || 'Failed to update API key.', 'error');
      return;
    }

    showMessage(apiKeyMsg, 'Kiro API key updated successfully.', 'success');
    changeApiKeyForm.reset();
  } catch (err) {
    console.error('Change API key error:', err);
    showMessage(apiKeyMsg, 'Network error. Please try again.', 'error');
  }
}

async function handleDeleteAccount() {
  const deleteAccountPw = document.getElementById('deleteAccountPw').value;
  const deleteAccountMsg = document.getElementById('deleteAccountMsg');

  if (!deleteAccountPw) {
    showMessage(deleteAccountMsg, 'Password is required to confirm deletion.', 'error');
    return;
  }

  // Double-confirm with user
  const confirmed = window.confirm(
    'Are you sure you want to permanently delete your account? This action cannot be undone.'
  );
  if (!confirmed) return;

  try {
    const res = await apiFetch('/api/auth/me', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password: deleteAccountPw })
    });

    if (res.status === 401) {
      showMessage(deleteAccountMsg, 'Password is incorrect.', 'error');
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showMessage(deleteAccountMsg, data.error || 'Failed to delete account.', 'error');
      return;
    }

    // Account deleted — redirect to login
    window.location.href = '/login.html';
  } catch (err) {
    console.error('Delete account error:', err);
    showMessage(deleteAccountMsg, 'Network error. Please try again.', 'error');
  }
}

function showMessage(el, text, type) {
  if (!el) return;
  el.textContent = text;
  el.className = 'form-message ' + type;
  el.hidden = false;
}

function hideMessage(el) {
  if (!el) return;
  el.hidden = true;
  el.textContent = '';
  el.className = 'form-message';
}

// ─── Credential Management ───────────────────────────────────────────────────

/**
 * Shows/hides the "database unavailable" banner in the credentials panel and
 * locks or unlocks the credential inputs and buttons to match.
 */
function setCredentialDbUnavailable(unavailable) {
  const banner = document.getElementById('credentialDbBanner');
  if (banner) banner.hidden = !unavailable;

  document.querySelectorAll('.credential-row').forEach(row => {
    const input = row.querySelector('input');
    const updateBtn = row.querySelector('.btn-primary');
    const clearBtn = row.querySelector('.credential-clear-btn');
    if (input) input.disabled = unavailable;
    if (updateBtn) updateBtn.disabled = unavailable;
    if (clearBtn) clearBtn.disabled = unavailable;
  });
}

/**
 * Loads credential status from the API and updates the UI indicators.
 */
async function loadCredentialStatus() {
  try {
    const res = await apiFetch('/api/users/me/credentials');
    if (res.status === 503) {
      // Database is down — surface the banner and lock the controls.
      setCredentialDbUnavailable(true);
      return;
    }
    if (!res.ok) return;
    // DB reachable — clear any previous "unavailable" state.
    setCredentialDbUnavailable(false);
    const status = await res.json();

    const rows = document.querySelectorAll('.credential-row');
    rows.forEach(row => {
      const key = row.dataset.key;
      const statusEl = row.querySelector('.credential-status');
      const input = row.querySelector('input');
      const isSet = status[key] === true;

      statusEl.textContent = isSet ? '●' : '○';
      statusEl.className = 'credential-status ' + (isSet ? 'is-set' : 'not-set');
      statusEl.title = isSet ? 'Set' : 'Not set';
      input.value = '';
      input.placeholder = isSet ? '••••••••' : input.getAttribute('placeholder') || 'Enter value...';

      // Hide credential message
      const msg = row.querySelector('.credential-msg');
      if (msg) hideMessage(msg);
    });
  } catch (err) {
    console.error('Failed to load credential status:', err);
  }
}

/**
 * Sets up event listeners for credential Update and Clear buttons.
 */
function setupCredentialHandlers() {
  const credSection = document.getElementById('credentialsSection');
  if (!credSection) return;

  credSection.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;

    const row = btn.closest('.credential-row');
    if (!row) return;

    const key = row.dataset.key;
    const input = row.querySelector('input');
    const msg = row.querySelector('.credential-msg');

    if (btn.classList.contains('credential-clear-btn')) {
      // Clear credential
      await saveCredential(key, null, row, msg);
    } else if (btn.classList.contains('btn-primary')) {
      // Update credential
      const value = input.value.trim();
      if (!value) {
        showMessage(msg, 'Please enter a value.', 'error');
        return;
      }
      await saveCredential(key, value, row, msg);
    }
  });
}

/**
 * Saves a single credential (or clears it if value is null).
 */
async function saveCredential(key, value, row, msgEl) {
  const input = row.querySelector('input');
  const updateBtn = row.querySelector('.btn-primary');
  const clearBtn = row.querySelector('.credential-clear-btn');

  // Disable buttons during save
  updateBtn.disabled = true;
  clearBtn.disabled = true;

  hideMessage(msgEl);

  try {
    const body = {};
    body[key] = value;

    const res = await apiFetch('/api/users/me/credentials', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));

      // Handle validation errors (422)
      if (res.status === 422 && data.validationErrors) {
        const errorMsg = data.validationErrors[key] || 'Validation failed';
        showMessage(msgEl, errorMsg, 'error');
        return;
      }

      // Database unavailable (503) — show the banner and a clear per-field message.
      if (res.status === 503) {
        setCredentialDbUnavailable(true);
        showMessage(msgEl, data.error || 'Database unavailable — your change was not saved.', 'error');
        return;
      }

      showMessage(msgEl, data.error || 'Failed to save credential.', 'error');
      return;
    }

    // Success — the credential was saved. Validation may still return a non-blocking
    // warning (e.g. the token couldn't be verified remotely); surface it without treating
    // the save as a failure.
    const data = await res.json().catch(() => ({}));
    const warning = data && data.warnings ? data.warnings[key] : null;
    const statusEl = row.querySelector('.credential-status');
    if (value === null) {
      showMessage(msgEl, 'Cleared.', 'success');
      statusEl.textContent = '○';
      statusEl.className = 'credential-status not-set';
      statusEl.title = 'Not set';
    } else {
      if (warning) {
        showMessage(msgEl, warning, 'warning');
      } else {
        showMessage(msgEl, 'Saved & validated.', 'success');
      }
      statusEl.textContent = '●';
      statusEl.className = 'credential-status is-set';
      statusEl.title = 'Set';
      input.value = '';
      input.placeholder = '••••••••';
    }
  } catch (err) {
    console.error(`Save credential ${key} error:`, err);
    showMessage(msgEl, 'Network error. Please try again.', 'error');
  } finally {
    // Keep the row locked while the DB is unavailable; otherwise re-enable.
    const dbBanner = document.getElementById('credentialDbBanner');
    const dbDown = dbBanner ? !dbBanner.hidden : false;
    updateBtn.disabled = dbDown;
    clearBtn.disabled = dbDown;
  }
}
