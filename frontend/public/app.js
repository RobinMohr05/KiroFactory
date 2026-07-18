// ===== State =====
let boards = [];
let tasks = [];
let boardSessions = [];
let boardAgents = [];
let currentBoardId = null;
let pendingOps = new Set();
let ws = null;
let reconnectTimer = null;
let pollTimer = null;
let reconcileTimer = null;
let lastTasksJson = '';

// ===== DOM References =====
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const boardSelector = document.getElementById('boardSelector');
const newBoardBtn = document.getElementById('newBoardBtn');
const newTaskBtn = document.getElementById('newTaskBtn');
const taskModal = document.getElementById('taskModal');
const taskForm = document.getElementById('taskForm');
const cancelTaskBtn = document.getElementById('cancelTaskBtn');
const deleteTaskBtn = document.getElementById('deleteTaskBtn');
const modalTitle = document.getElementById('modalTitle');
const submitTaskBtn = document.getElementById('submitTaskBtn');

// Tabs
const tabBoards = document.getElementById('tab-boards');
const tabSessions = document.getElementById('tab-sessions');
const tabAgents = document.getElementById('tab-agents');
const tabErrors = document.getElementById('tab-errors');
const panelBoards = document.getElementById('panel-boards');
const panelSessions = document.getElementById('panel-sessions');
const panelAgents = document.getElementById('panel-agents');
const panelErrors = document.getElementById('panel-errors');

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
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.addEventListener('open', () => {
    setConnectionStatus(true);
    stopPolling();
  });

  ws.addEventListener('close', () => {
    setConnectionStatus(false);
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
  if (connected) {
    statusDot.classList.add('connected');
    statusText.textContent = 'Connected';
  } else {
    statusDot.classList.remove('connected');
    statusText.textContent = 'Disconnected';
  }
}

function handleWsMessage(message) {
  const { type } = message;

  // Server sends: { type, task?, taskId?, board?, boardId? }
  // Extract the relevant data based on message type
  const task = message.task;
  const board = message.board;
  const taskId = message.taskId;
  const boardId = message.boardId;

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
        const belongsToBoard = task.boards?.some(b => b.id == currentBoardId);
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
          const belongsToBoard = task.boards?.some(b => b.id == currentBoardId);
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

    case 'board-created':
      if (board) {
        const boardExists = boards.find(b => b.id === board.id);
        if (!boardExists) {
          boards.push(board);
          renderBoardSelector();
        }
      }
      break;

    case 'board-updated':
      if (board) {
        const bIdx = boards.findIndex(b => b.id === board.id);
        if (bIdx !== -1) boards[bIdx] = board;
        renderBoardSelector();
      }
      break;

    case 'board-deleted':
      if (boardId) {
        boards = boards.filter(b => b.id !== boardId);
        renderBoardSelector();
        if (currentBoardId == boardId) {
          currentBoardId = boards.length > 0 ? boards[0].id : null;
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
    const res = await fetch('/api/boards');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    boards = await res.json();
    renderBoardSelector();
    if (boards.length > 0 && !currentBoardId) {
      currentBoardId = boards[0].id;
      boardSelector.value = currentBoardId;
      await fetchBoardTasks(currentBoardId);
    }
  } catch (e) {
    console.error('Failed to fetch boards:', e);
  }
}

async function fetchBoardTasks(boardId) {
  try {
    const res = await fetch(`/api/boards/${boardId}`);
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

async function createBoard(name) {
  try {
    const res = await fetch('/api/boards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
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
    boardSelector.value = board.id;
    tasks = [];
    boardSessions = [];
    boardAgents = [];
    lastTasksJson = '[]';
    renderBoard();
    renderBoardMembers();
    return board;
  } catch (e) {
    console.error('Failed to create board:', e);
  }
}

async function deleteBoard(id) {
  try {
    const res = await fetch(`/api/boards/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    pendingOps.add(`board-deleted-${id}`);
    boards = boards.filter(b => b.id !== id);
    renderBoardSelector();
    if (currentBoardId === id) {
      currentBoardId = boards.length > 0 ? boards[0].id : null;
      if (currentBoardId) {
        boardSelector.value = currentBoardId;
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
  boardSelector.innerHTML = '';
  boards.forEach(board => {
    const opt = document.createElement('option');
    opt.value = board.id;
    opt.textContent = board.name;
    boardSelector.appendChild(opt);
  });
  if (currentBoardId) {
    boardSelector.value = currentBoardId;
  }
}

function renderBoard() {
  const columns = ['todo', 'in-progress', 'developed'];

  columns.forEach(state => {
    const container = document.getElementById(`cards-${state}`);
    const countEl = document.getElementById(`count-${state}`);
    container.innerHTML = '';

    const columnTasks = tasks.filter(t => t.state === state);
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
        <span class="chip-detail">${escapeHtml(session.agent)} · ${session.status}</span>
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
  tabSessions.addEventListener('click', () => activateTab(tabSessions, panelSessions));
  tabAgents.addEventListener('click', () => {
    activateTab(tabAgents, panelAgents);
    fetchAgents();
  });
  tabErrors.addEventListener('click', () => {
    activateTab(tabErrors, panelErrors);
    fetchErrors();
  });
}

// ===== Event Listeners =====
function setupEventListeners() {
  // Board selector
  boardSelector.addEventListener('change', (e) => {
    currentBoardId = e.target.value;
    fetchBoardTasks(currentBoardId);
  });

  // New Board
  newBoardBtn.addEventListener('click', () => {
    const name = prompt('Enter board name:');
    if (name && name.trim()) {
      createBoard(name.trim());
    }
  });

  // New Task
  newTaskBtn.addEventListener('click', () => {
    showTaskForm();
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
        boardIds: currentBoardId ? [Number(currentBoardId)] : []
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
function init() {
  setupTabs();
  setupEventListeners();
  setupDragAndDrop();
  connectWebSocket();
  fetchBoards();
  startReconciliation();
  setupSessions();
  setupAgents();
  setupErrors();
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

function setupSessions() {
  fetchSessions();

  newSessionBtn.addEventListener('click', async () => {
    sessionModal.hidden = false;
    await populateAgentDropdown();
    populateSessionBoardsSelect();
    document.getElementById('sessionName').focus();
  });

  cancelSessionBtn.addEventListener('click', hideSessionForm);

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
}

function hideSessionForm() {
  sessionModal.hidden = true;
  sessionForm.reset();
}

async function populateAgentDropdown() {
  const select = document.getElementById('sessionAgent');
  select.innerHTML = '<option value="" disabled selected>Loading agents…</option>';
  try {
    const res = await fetch('/api/agents');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const agents = await res.json();
    select.innerHTML = '';
    if (agents.length === 0) {
      select.innerHTML = '<option value="" disabled>No agents found</option>';
      return;
    }
    agents.forEach(agent => {
      const opt = document.createElement('option');
      opt.value = agent.name;
      opt.textContent = agent.description ? `${agent.name} — ${agent.description}` : agent.name;
      select.appendChild(opt);
    });
    // Auto-select first agent
    select.selectedIndex = 0;
  } catch (e) {
    console.error('Failed to fetch agents:', e);
    select.innerHTML = '<option value="" disabled>Failed to load agents</option>';
  }
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

async function createAndStartSession() {
  const name = document.getElementById('sessionName').value.trim();
  const agent = document.getElementById('sessionAgent').value.trim();
  const prompt = document.getElementById('sessionPrompt').value.trim() || undefined;
  const cwd = document.getElementById('sessionCwd').value.trim() || undefined;
  const model = document.getElementById('sessionModel').value.trim() || undefined;
  const interactive = document.getElementById('sessionInteractive').checked;
  const runs = parseInt(document.getElementById('sessionRuns').value, 10) || 0;
  const intervalSeconds = parseInt(document.getElementById('sessionInterval').value, 10) || 10;

  // Collect selected board IDs from the multi-select
  const boardsSelect = document.getElementById('sessionBoards');
  const boardIds = Array.from(boardsSelect.selectedOptions).map(opt => Number(opt.value));

  if (!name || !agent) return;

  // If runs > 0 or runs === 0 (endless), enable loop mode
  const loop = true; // always loop — runs controls how many iterations

  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, agent, prompt, cwd, model, interactive, loop, runs, intervalSeconds, boardIds: boardIds.length > 0 ? boardIds : undefined })
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
    hideSessionForm();

    // Auto-start the session
    await startAgentSession(session.id);
  } catch (e) {
    console.error('Failed to create session:', e);
    alert('Failed to create session: ' + e.message);
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
  sessionDetailAgent.textContent = session.agent;
  updateSessionStatusUI(session.status);

  loadSessionOutput(id);
}

async function loadSessionOutput(id) {
  const entries = await fetchSessionOutput(id);
  outputPre.innerHTML = '';
  entries.forEach(entry => appendOutputEntry(entry));
  scrollOutputToBottom();
}

function showSessionEmpty() {
  sessionEmptyState.hidden = false;
  sessionDetail.hidden = true;
  outputPre.innerHTML = '';
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

function renderSessionList() {
  sessionList.innerHTML = '';
  sessions.forEach(session => {
    const li = document.createElement('li');
    li.className = 'session-item' + (session.id === activeSessionId ? ' active' : '');
    li.dataset.sessionId = session.id;

    const statusClass = 'status-dot-sm status-' + session.status;

    li.innerHTML = `
      <span class="${statusClass}" aria-hidden="true"></span>
      <div class="session-item-info">
        <span class="session-item-name">${escapeHtml(session.name)}</span>
        <span class="session-item-agent">${escapeHtml(session.agent)}</span>
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
      if (s && currentBoardId && s.boardIds && s.boardIds.includes(Number(currentBoardId))) {
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
          sessionDetailAgent.textContent = s.agent;
          updateSessionStatusUI(s.status);
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
