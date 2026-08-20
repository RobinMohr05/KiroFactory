import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../utils/api';
import { useConfirmAction } from '../hooks/useConfirmAction';
import { useMobileBreakpoint } from '../hooks/useMobileBreakpoint';
import { AgentModal } from './AgentModal';
import type { Agent } from '../types';

export function AgentsPanel() {
  const { agents, setAgents, fetchAgents, activeAgentId, setActiveAgentId } = useApp();
  const navigate = useNavigate();
  const { id: routeId } = useParams<{ id?: string }>();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const isMobile = useMobileBreakpoint();
  const [mobileShowDetail, setMobileShowDetail] = useState(false);
  const scrollTopRef = useRef<number>(0);
  const listPanelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  // Sync route param to active agent
  useEffect(() => {
    if (routeId) {
      const id = Number(routeId);
      if (!isNaN(id) && id !== activeAgentId) {
        setActiveAgentId(id);
      }
    }
  }, [routeId, activeAgentId, setActiveAgentId]);

  useEffect(() => {
    if (!activeAgentId && agents.length > 0) {
      setActiveAgentId(agents[0].id);
    }
  }, [agents, activeAgentId, setActiveAgentId]);

  const activeAgent = agents.find(a => a.id === activeAgentId);

  const handleDelete = async () => {
    if (!activeAgent) return;
    try {
      const res = await apiFetch(`/api/agents/${activeAgent.id}`, { method: 'DELETE' });
      if (!res.ok) return;
      setAgents(prev => prev.filter(a => a.id !== activeAgent.id));
      setActiveAgentId(null);
    } catch (e) {
      console.error('Failed to delete agent:', e);
    }
  };

  const { isPending: deleteConfirmPending, handleClick: handleDeleteClick } = useConfirmAction(handleDelete);

  const handleExport = () => {
    if (!activeAgent) return;
    const data = JSON.stringify(activeAgent, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeAgent.name}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Mobile drill-down: when an agent is tapped on mobile, transition to detail view
  const handleMobileAgentClick = (agentId: number) => {
    setActiveAgentId(agentId);
    navigate(`/agents/${agentId}`, { replace: true });
    if (isMobile) {
      if (listPanelRef.current) {
        scrollTopRef.current = listPanelRef.current.scrollTop;
      }
      setMobileShowDetail(true);
    }
  };

  const handleMobileBack = () => {
    setMobileShowDetail(false);
    navigate('/agents', { replace: true });
    requestAnimationFrame(() => {
      if (listPanelRef.current) {
        listPanelRef.current.scrollTop = scrollTopRef.current;
      }
    });
  };

  // Reset mobile detail state when viewport becomes desktop
  useEffect(() => {
    if (!isMobile) {
      setMobileShowDetail(false);
    }
  }, [isMobile]);

  const listHidden = isMobile && mobileShowDetail;
  const detailHidden = isMobile && !mobileShowDetail;

  return (
    <section id="panel-agents" role="tabpanel" aria-labelledby="tab-agents">
      <div className="agents-layout">
        <aside className={`agent-list-panel${listHidden ? ' mobile-hidden' : ''}`} ref={listPanelRef}>
          <div className="toolbar" role="toolbar" aria-label="Agent actions">
            <button id="newAgentBtn" className="btn btn-primary" onClick={() => setShowCreateModal(true)}>+ New Agent</button>
          </div>
          <ul className="agent-list" id="agentList" aria-label="Configured agents">
            {agents.map(agent => {
              const initials = (agent.name || '?').substring(0, 2).toUpperCase();
              return (
                <li
                  key={agent.id}
                  className={`agent-item${agent.id === activeAgentId ? ' active' : ''}`}
                  data-agent-id={agent.id}
                  onClick={() => handleMobileAgentClick(agent.id)}
                >
                  <span className="agent-item-icon">{initials}</span>
                  <div className="agent-item-info">
                    <span className="agent-item-name">{agent.name}</span>
                    <span className="agent-item-desc">{agent.description || ''}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </aside>
        <div className={`agent-detail-panel${detailHidden ? ' mobile-hidden' : ''}`} id="agentDetailPanel">
          {!activeAgent ? (
            <div className="agent-empty-state" id="agentEmptyState">
              {isMobile && mobileShowDetail && (
                <button className="mobile-back-btn" onClick={handleMobileBack} aria-label="Back to agent list">
                  ←
                </button>
              )}
              <div className="quick-start">
                <h3>No agents yet</h3>
                <p className="quick-start-hint">Agents are reusable prompt + tool presets you can launch sessions with. Create one to get started, or select one from the list.</p>
                <button type="button" className="btn btn-primary" onClick={() => setShowCreateModal(true)}>+ New Agent</button>
              </div>
            </div>
          ) : (
            <div className="agent-detail" id="agentDetail">
              <div className="agent-detail-header">
                <div className="agent-info">
                  {isMobile && (
                    <button className="mobile-back-btn" onClick={handleMobileBack} aria-label="Back to agent list">
                      ←
                    </button>
                  )}
                  <h3 id="agentDetailName">{activeAgent.name}</h3>
                  <span className="agent-desc-text">{activeAgent.description || '(no description)'}</span>
                </div>
                <div className="agent-controls">
                  <button className="btn btn-secondary btn-sm" onClick={handleExport}>Export</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setEditingAgent(activeAgent)}>Edit</button>
                  <button className={`btn btn-danger btn-sm${deleteConfirmPending ? ' btn-confirm-pending' : ''}`} onClick={handleDeleteClick}>{deleteConfirmPending ? 'Confirm?' : 'Delete'}</button>
                </div>
              </div>
              <div className="agent-detail-body">
                <div className="agent-section">
                  <h4>Prompt</h4>
                  <pre className="agent-prompt-pre">{activeAgent.prompt || '(no prompt)'}</pre>
                </div>
                <div className="agent-section">
                  <h4>Tools</h4>
                  <div className="agent-tags">
                    {(activeAgent.tools?.length ? activeAgent.tools : ['(none)']).map((t, i) => (
                      <span key={i} className="agent-tag">{t}</span>
                    ))}
                  </div>
                </div>
                <div className="agent-section">
                  <h4>Allowed Tools</h4>
                  <div className="agent-tags">
                    {(activeAgent.allowedTools?.length ? activeAgent.allowedTools : ['(none)']).map((t, i) => (
                      <span key={i} className="agent-tag">{t}</span>
                    ))}
                  </div>
                </div>
                <div className="agent-section">
                  <h4>Resources</h4>
                  <div className="agent-tags">
                    {(activeAgent.resources?.length ? activeAgent.resources : ['(none)']).map((t, i) => (
                      <span key={i} className="agent-tag">{t}</span>
                    ))}
                  </div>
                </div>
                <div className="agent-section">
                  <h4>Kind & Pipeline</h4>
                  <div className="agent-pipeline-info">
                    <div className="agent-pipeline-row"><span className="agent-pipeline-label">Kind:</span> <span className="agent-tag">{activeAgent.kind === 'inspector' ? 'Inspector (reviews only)' : 'Editor (changes code)'}</span></div>
                    <div className="agent-pipeline-row"><span className="agent-pipeline-label">Requires task:</span> <span className="agent-tag">{activeAgent.requiresTask === false ? 'No (standalone prompt loop)' : 'Yes'}</span></div>
                    <div className="agent-pipeline-row"><span className="agent-pipeline-label">Claim from:</span> <span className="agent-tag">{activeAgent.claimState || '—'}</span></div>
                    <div className="agent-pipeline-row"><span className="agent-pipeline-label">Working state:</span> <span className="agent-tag">{activeAgent.workingState || '—'}</span></div>
                    <div className="agent-pipeline-row"><span className="agent-pipeline-label">Resolve to:</span> <span className="agent-tag">{activeAgent.resolveState || '—'}</span></div>
                  </div>
                </div>
                <div className="agent-section">
                  <h4>Tools Settings (JSON)</h4>
                  <pre className="agent-json-pre">
                    {activeAgent.toolsSettings && Object.keys(activeAgent.toolsSettings).length > 0
                      ? JSON.stringify(activeAgent.toolsSettings, null, 2)
                      : '(none)'}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {(showCreateModal || editingAgent) && (
        <AgentModal
          agent={editingAgent}
          onClose={() => { setShowCreateModal(false); setEditingAgent(null); }}
        />
      )}
    </section>
  );
}
