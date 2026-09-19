import { useEffect, useState } from 'react';
import { api } from './adminApi.js';
import { useAuth } from './AuthContext.jsx';
import { Avatar, Empty } from './ui.jsx';

function senderName(m) {
  const n = `${m.first_name || ''} ${m.last_name || ''}`.trim();
  return n || `#${m.sender_id}`;
}

function MessageList({ messages, meId }) {
  if (!messages || messages.length === 0) return <Empty>No messages yet. Say hello.</Empty>;
  return (
    <ul className="chat-messages">
      {messages.map((m) => {
        const mine = Number(m.sender_id) === Number(meId);
        return (
          <li key={m.id} className={mine ? 'chat-msg mine' : 'chat-msg theirs'}>
            <div className="chat-meta">
              <strong>{mine ? 'You' : senderName(m)}</strong>
              <small className="muted"> · {new Date(m.created_at).toLocaleString()}</small>
            </div>
            <div className="chat-body">{m.body}</div>
          </li>
        );
      })}
    </ul>
  );
}

// ProjectChat — per-project messaging: whole-project room + 1-1 DMs +
// custom subgroups. Members-only (backend 404s outsiders).
export default function ProjectChat({ projectId, members }) {
  const { user, sessionExpired, policyDays } = useAuth();
  const [tab, setTab] = useState('project');
  const [err, setErr] = useState('');

  const [roomMessages, setRoomMessages] = useState(null);
  const [roomDraft, setRoomDraft] = useState('');

  const [threads, setThreads] = useState([]);
  const [peerId, setPeerId] = useState('');
  const [groupTitle, setGroupTitle] = useState('');
  const [groupPicks, setGroupPicks] = useState({});
  const [activeThread, setActiveThread] = useState(null);
  const [threadMessages, setThreadMessages] = useState(null);
  const [threadDraft, setThreadDraft] = useState('');

  const meId = user?.id;
  const others = (members || []).filter((m) => Number(m.employee_id) !== Number(meId));

  function fail(e) {
    if (e.status === 401) sessionExpired(policyDays);
    else setErr(e.message);
  }

  async function loadRoom(signal) {
    try {
      const d = await api(`/api/projects/${projectId}/chat?limit=50`, { signal });
      setRoomMessages(d.messages || []);
      setErr('');
    } catch (e) {
      if (e.name === 'AbortError') return;
      fail(e);
    }
  }

  async function loadThreads(signal) {
    try {
      const rows = await api(`/api/projects/${projectId}/threads`, { signal });
      setThreads(Array.isArray(rows) ? rows : []);
      setErr('');
    } catch (e) {
      if (e.name === 'AbortError') return;
      fail(e);
    }
  }

  async function loadThreadMessages(tid, signal) {
    try {
      const d = await api(`/api/projects/${projectId}/threads/${tid}/messages?limit=50`, { signal });
      setThreadMessages(d.messages || []);
      setErr('');
    } catch (e) {
      if (e.name === 'AbortError') return;
      fail(e);
    }
  }

  // (Re)load on project switch; poll the visible conversation for liveness.
  useEffect(() => {
    setRoomMessages(null);
    setThreads([]);
    setActiveThread(null);
    setThreadMessages(null);
    setErr('');
    if (!projectId) return;
    const c1 = new AbortController();
    const c2 = new AbortController();
    loadRoom(c1.signal);
    loadThreads(c2.signal);
    return () => { c1.abort(); c2.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    const t = setInterval(() => {
      if (tab === 'project') loadRoom();
      else if (activeThread) loadThreadMessages(activeThread);
      else loadThreads();
    }, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, tab, activeThread]);

  useEffect(() => {
    if (!activeThread) {
      setThreadMessages(null);
      return;
    }
    const c = new AbortController();
    loadThreadMessages(activeThread, c.signal);
    return () => c.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThread]);

  async function sendRoom(e) {
    e.preventDefault();
    if (!roomDraft.trim()) return;
    try {
      const m = await api(`/api/projects/${projectId}/chat`, { method: 'POST', body: { body: roomDraft.trim() } });
      setRoomMessages((prev) => [...(prev || []), m]);
      setRoomDraft('');
    } catch (e2) { fail(e2); }
  }

  async function startDirect(e) {
    e?.preventDefault();
    if (!peerId) return;
    try {
      const t = await api(`/api/projects/${projectId}/threads`, {
        method: 'POST',
        body: { type: 'direct', member_ids: [Number(peerId)] },
      });
      await loadThreads();
      setActiveThread(Number(t.id));
      setPeerId('');
    } catch (e2) { fail(e2); }
  }

  async function createGroup(e) {
    e.preventDefault();
    const ids = Object.entries(groupPicks).filter(([, v]) => v).map(([k]) => Number(k));
    if (!groupTitle.trim() || ids.length === 0) {
      setErr('Group needs a title and at least one other member.');
      return;
    }
    try {
      const t = await api(`/api/projects/${projectId}/threads`, {
        method: 'POST',
        body: { type: 'group', title: groupTitle.trim(), member_ids: ids },
      });
      setGroupTitle('');
      setGroupPicks({});
      await loadThreads();
      setActiveThread(Number(t.id));
    } catch (e2) { fail(e2); }
  }

  async function sendThread(e) {
    e.preventDefault();
    if (!threadDraft.trim() || !activeThread) return;
    try {
      const m = await api(`/api/projects/${projectId}/threads/${activeThread}/messages`, {
        method: 'POST',
        body: { body: threadDraft.trim() },
      });
      setThreadMessages((prev) => [...(prev || []), m]);
      setThreadDraft('');
      loadThreads();
    } catch (e2) { fail(e2); }
  }

  const directs = threads.filter((t) => t.type === 'direct');
  const groups = threads.filter((t) => t.type === 'group');
  const active = threads.find((t) => Number(t.id) === Number(activeThread));
  const shownThreads = tab === 'direct' ? directs : groups;

  return (
    <div className="section-gap">
      <h4>Project chat</h4>
      {err && <p className="muted" style={{ color: 'var(--bad)' }}>{err}</p>}
      <div className="tabs">
        <button className={tab === 'project' ? 'tab active' : 'tab'} onClick={() => setTab('project')}>Project group</button>
        <button className={tab === 'direct' ? 'tab active' : 'tab'} onClick={() => setTab('direct')}>Direct</button>
        <button className={tab === 'group' ? 'tab active' : 'tab'} onClick={() => setTab('group')}>Groups</button>
      </div>

      {tab === 'project' && (
        <div className="chat-box">
          {roomMessages === null ? (
            <p className="loading">Loading chat</p>
          ) : (
            <MessageList messages={roomMessages} meId={meId} />
          )}
          <form onSubmit={sendRoom} className="chat-input">
            <input
              placeholder="Message the whole project…"
              value={roomDraft}
              onChange={(e) => setRoomDraft(e.target.value)}
              style={{ flex: 1 }}
            />
            <button className="btn btn-primary btn-sm" type="submit">Send</button>
            <button className="btn btn-sm" type="button" onClick={() => loadRoom()}>Refresh</button>
          </form>
        </div>
      )}

      {tab !== 'project' && (
        <div className="chat-grid">
          <div className="chat-side">
            {tab === 'direct' ? (
              <form onSubmit={startDirect}>
                <div className="field">
                  <span>Message teammate 1-1</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <select value={peerId} onChange={(e) => setPeerId(e.target.value)} style={{ flex: 1 }}>
                      <option value="">Pick a member…</option>
                      {others.map((m) => (
                        <option key={m.employee_id} value={m.employee_id}>
                          {m.first_name} {m.last_name}
                        </option>
                      ))}
                    </select>
                    <button className="btn btn-sm btn-primary" type="submit" disabled={!peerId}>Chat</button>
                  </div>
                </div>
              </form>
            ) : (
              <form onSubmit={createGroup}>
                <div className="field">
                  <span>New subgroup</span>
                  <input
                    placeholder="e.g. frontend crew"
                    value={groupTitle}
                    onChange={(e) => setGroupTitle(e.target.value)}
                  />
                </div>
                <div className="chat-picks">
                  {others.map((m) => (
                    <label key={m.employee_id} className="check">
                      <input
                        type="checkbox"
                        checked={!!groupPicks[m.employee_id]}
                        onChange={(e) => setGroupPicks((p) => ({ ...p, [m.employee_id]: e.target.checked }))}
                      />
                      <Avatar first={m.first_name} last={m.last_name} />
                      <span>{m.first_name} {m.last_name}</span>
                    </label>
                  ))}
                </div>
                <button className="btn btn-sm btn-primary" type="submit" style={{ marginTop: 6 }}>Create group</button>
              </form>
            )}

            <h4 className="section-gap">{tab === 'direct' ? 'My DMs' : 'My groups'}</h4>
            {shownThreads.length === 0 ? (
              <Empty>{tab === 'direct' ? 'No 1-1 chats yet.' : 'No subgroups yet.'}</Empty>
            ) : (
              <ul className="rows">
                {shownThreads.map((t) => {
                  const label = t.type === 'direct'
                    ? (t.members || []).filter((x) => Number(x.id) !== Number(meId)).map((x) => `${x.first_name} ${x.last_name}`).join(', ') || 'DM'
                    : t.title;
                  return (
                    <li key={t.id} style={Number(activeThread) === Number(t.id) ? { background: 'var(--brand-soft)', borderRadius: 8 } : undefined}>
                      <div className="grow">
                        <button className="link-btn" onClick={() => setActiveThread(Number(t.id))}>{label}</button>
                        {t.last_message && (
                          <div><small className="muted">{String(t.last_message.body).slice(0, 60)}</small></div>
                        )}
                      </div>
                      <small className="muted">{t.message_count ?? 0}</small>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="chat-main">
            {!active ? (
              <Empty>Pick a conversation on the left to read and reply.</Empty>
            ) : (
              <div className="chat-box">
                {threadMessages === null ? (
                  <p className="loading">Loading messages</p>
                ) : (
                  <MessageList messages={threadMessages} meId={meId} />
                )}
                <form onSubmit={sendThread} className="chat-input">
                  <input
                    placeholder="Write a message…"
                    value={threadDraft}
                    onChange={(e) => setThreadDraft(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button className="btn btn-primary btn-sm" type="submit">Send</button>
                </form>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
