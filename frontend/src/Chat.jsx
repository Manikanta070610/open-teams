import { useEffect, useState } from 'react';
import { api } from './adminApi.js';
import { useAuth } from './AuthContext.jsx';
import { Avatar, Badge, Card, Empty } from './ui.jsx';

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

function Unread({ n }) {
  if (!n) return null;
  return <span className="unread-pill">{n}</span>;
}

// Chat — company-wide messaging on the db/04 tables: open/department/
// private groups with member management, plus 1-1 DMs with anyone active.
export default function Chat() {
  const { user, sessionExpired, policyDays } = useAuth();
  const [tab, setTab] = useState('groups');
  const [err, setErr] = useState('');

  const [groups, setGroups] = useState(null);
  const [groupId, setGroupId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [groupMessages, setGroupMessages] = useState(null);
  const [groupDraft, setGroupDraft] = useState('');
  const [newName, setNewName] = useState('');
  const [newVis, setNewVis] = useState('private');
  const [addId, setAddId] = useState('');
  const [addRole, setAddRole] = useState('member');

  const [convs, setConvs] = useState([]);
  const [dmId, setDmId] = useState(null);
  const [dmMessages, setDmMessages] = useState(null);
  const [dmDraft, setDmDraft] = useState('');
  const [peerId, setPeerId] = useState('');

  const [employees, setEmployees] = useState([]);

  const meId = user?.id;
  const isManager = detail && (detail.my_role === 'owner' || detail.my_role === 'admin');
  const unreadByConv = Object.fromEntries((convs || []).map((c) => [Number(c.id), Number(c.unread_count) || 0]));
  const unreadByGroup = Object.fromEntries(
    (convs || []).filter((c) => c.type === 'group' && c.group_id).map((c) => [Number(c.group_id), Number(c.unread_count) || 0])
  );

  function fail(e) {
    if (e.name === 'AbortError') return;
    if (e.status === 401) sessionExpired(policyDays);
    else setErr(e.message);
  }

  async function loadGroups(signal) {
    try {
      const rows = await api('/api/chat/groups', { signal });
      setGroups(Array.isArray(rows) ? rows : []);
    } catch (e) { fail(e); }
  }

  async function loadConvs(signal) {
    try {
      const rows = await api('/api/chat/conversations', { signal });
      setConvs(Array.isArray(rows) ? rows : []);
    } catch (e) { fail(e); }
  }

  async function loadEmployees(signal) {
    try {
      setEmployees(await api('/api/employees', { signal }));
    } catch (e) { fail(e); }
  }

  async function loadDetail(id, signal) {
    try {
      setDetail(await api(`/api/chat/groups/${id}`, { signal }));
    } catch (e) { fail(e); }
  }

  async function loadGroupMessages(id, signal) {
    try {
      const d = await api(`/api/chat/groups/${id}/chat?limit=50`, { signal });
      setGroupMessages(d.messages || []);
      loadConvs();
    } catch (e) { fail(e); }
  }

  async function loadDmMessages(id, signal) {
    try {
      const d = await api(`/api/chat/conversations/${id}/messages?limit=50`, { signal });
      setDmMessages(d.messages || []);
      loadConvs();
    } catch (e) { fail(e); }
  }

  useEffect(() => {
    const a = new AbortController();
    const b = new AbortController();
    const c = new AbortController();
    loadGroups(a.signal);
    loadConvs(b.signal);
    loadEmployees(c.signal);
    return () => { a.abort(); b.abort(); c.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!groupId) {
      setDetail(null);
      setGroupMessages(null);
      return;
    }
    const a = new AbortController();
    const b = new AbortController();
    loadDetail(groupId, a.signal);
    loadGroupMessages(groupId, b.signal);
    return () => { a.abort(); b.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  useEffect(() => {
    if (!dmId) {
      setDmMessages(null);
      return;
    }
    const c = new AbortController();
    loadDmMessages(dmId, c.signal);
    return () => c.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dmId]);

  useEffect(() => {
    const t = setInterval(() => {
      if (tab === 'groups') {
        if (groupId) loadGroupMessages(groupId);
        else loadGroups();
      } else if (dmId) loadDmMessages(dmId);
      else loadConvs();
    }, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, groupId, dmId]);

  async function createGroup(e) {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      const g = await api('/api/chat/groups', {
        method: 'POST',
        body: { name: newName.trim(), visibility: newVis },
      });
      setNewName('');
      setGroups((prev) => (prev ? [g, ...prev] : [g]));
      setGroupId(Number(g.id));
      setTab('groups');
    } catch (e2) { fail(e2); }
  }

  async function joinGroup() {
    try {
      await api(`/api/chat/groups/${groupId}/join`, { method: 'POST' });
      loadDetail(groupId);
      loadGroupMessages(groupId);
      loadGroups();
    } catch (e2) { fail(e2); }
  }

  async function leaveGroup() {
    if (!window.confirm('Leave this group? You lose its chat history access.')) return;
    try {
      await api(`/api/chat/groups/${groupId}/members/${meId}`, { method: 'DELETE' });
      setGroupId(null);
      loadGroups();
      loadConvs();
    } catch (e2) { fail(e2); }
  }

  async function deleteGroup() {
    if (!window.confirm(`Delete "${detail?.name}" for everyone, including its chat?`)) return;
    try {
      await api(`/api/chat/groups/${groupId}`, { method: 'DELETE' });
      setGroupId(null);
      loadGroups();
      loadConvs();
    } catch (e2) { fail(e2); }
  }

  async function addMember(e) {
    e.preventDefault();
    if (!addId) return;
    try {
      await api(`/api/chat/groups/${groupId}/members`, {
        method: 'POST',
        body: { employee_ids: [Number(addId)], role: addRole },
      });
      setAddId('');
      loadDetail(groupId);
    } catch (e2) { fail(e2); }
  }

  async function removeMember(empId, label) {
    if (!window.confirm(`Remove ${label} from "${detail?.name}"?`)) return;
    try {
      await api(`/api/chat/groups/${groupId}/members/${empId}`, { method: 'DELETE' });
      loadDetail(groupId);
    } catch (e2) { fail(e2); }
  }

  async function sendGroup(e) {
    e.preventDefault();
    if (!groupDraft.trim()) return;
    try {
      const m = await api(`/api/chat/groups/${groupId}/chat`, {
        method: 'POST',
        body: { body: groupDraft.trim() },
      });
      setGroupMessages((prev) => [...(prev || []), m]);
      setGroupDraft('');
    } catch (e2) { fail(e2); }
  }

  async function startDm(e) {
    e?.preventDefault();
    if (!peerId) return;
    try {
      const c = await api('/api/chat/conversations/direct', {
        method: 'POST',
        body: { employee_id: Number(peerId) },
      });
      setPeerId('');
      await loadConvs();
      setDmId(Number(c.id));
    } catch (e2) { fail(e2); }
  }

  async function sendDm(e) {
    e.preventDefault();
    if (!dmDraft.trim()) return;
    try {
      const m = await api(`/api/chat/conversations/${dmId}/messages`, {
        method: 'POST',
        body: { body: dmDraft.trim() },
      });
      setDmMessages((prev) => [...(prev || []), m]);
      setDmDraft('');
    } catch (e2) { fail(e2); }
  }

  const dms = (convs || []).filter((c) => c.type === 'direct');
  const dmLabel = (c) =>
    (c.participants || []).filter((p) => Number(p.id) !== Number(meId))
      .map((p) => `${p.first_name} ${p.last_name}`).join(', ') || 'DM';
  const others = (employees || []).filter((x) => Number(x.id) !== Number(meId));
  const nonMembers = others.filter((x) => !(detail?.members || []).some((m) => Number(m.id) === Number(x.id)));

  return (
    <section>
      <div className="page-head">
        <h1>Chat</h1>
        <p className="page-sub">Company-wide groups and 1-1 direct messages.</p>
      </div>
      {err && <p className="muted" style={{ color: 'var(--bad)' }}>{err}</p>}
      <div className="tabs">
        <button className={tab === 'groups' ? 'tab active' : 'tab'} onClick={() => setTab('groups')}>Groups</button>
        <button className={tab === 'direct' ? 'tab active' : 'tab'} onClick={() => setTab('direct')}>Direct</button>
      </div>

      {tab === 'groups' && (
        <div className="chat-grid">
          <div className="chat-side">
            <form onSubmit={createGroup}>
              <div className="field">
                <span>New group</span>
                <input
                  placeholder="e.g. weekend football"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <select value={newVis} onChange={(e) => setNewVis(e.target.value)} style={{ flex: 1 }}>
                  <option value="private">Private (invite-only)</option>
                  <option value="public">Public (anyone can join)</option>
                  <option value="department">My department</option>
                </select>
                <button className="btn btn-sm btn-primary" type="submit">Create</button>
              </div>
            </form>

            <h4 className="section-gap">My groups</h4>
            {groups === null ? (
              <p className="loading">Loading groups</p>
            ) : groups.length === 0 ? (
              <Empty>No groups yet — create one above.</Empty>
            ) : (
              <ul className="rows">
                {groups.map((g) => (
                  <li key={g.id} style={Number(groupId) === Number(g.id) ? { background: 'var(--brand-soft)', borderRadius: 8 } : undefined}>
                    <div className="grow">
                      <button className="link-btn" onClick={() => setGroupId(Number(g.id))}>{g.name}</button>
                      <div>
                        <Badge kind="member">{g.visibility}</Badge>{' '}
                        <small className="muted">{g.member_count} members{g.my_role ? ` · ${g.my_role}` : ''}</small>
                      </div>
                    </div>
                    <Unread n={unreadByGroup[Number(g.id)]} />
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="chat-main">
            {!groupId || !detail ? (
              <Card title="Group chat"><Empty>Pick a group to read, manage members, and chat.</Empty></Card>
            ) : (
              <Card
                title={detail.name}
                action={<span><Badge kind="member">{detail.visibility}</Badge>{detail.my_role ? <> <Badge kind={detail.my_role}>{detail.my_role}</Badge></> : null}</span>}
              >
                {detail.description && <p className="muted">{detail.description}</p>}
                <h4>Members ({(detail.members || []).length})</h4>
                <ul className="rows">
                  {(detail.members || []).map((m) => (
                    <li key={m.id}>
                      <Avatar first={m.first_name} last={m.last_name} />
                      <div className="grow">
                        <strong>{m.first_name} {m.last_name}</strong>{' '}
                        <Badge kind={m.role}>{m.role}</Badge>
                      </div>
                      {isManager && Number(m.id) !== Number(meId) && (
                        <button className="btn btn-sm" onClick={() => removeMember(m.id, `${m.first_name} ${m.last_name}`)}>Remove</button>
                      )}
                    </li>
                  ))}
                </ul>
                {isManager && nonMembers.length > 0 && (
                  <form onSubmit={addMember} style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <select value={addId} onChange={(e) => setAddId(e.target.value)} style={{ flex: 1 }}>
                      <option value="">Add someone…</option>
                      {nonMembers.map((x) => (
                        <option key={x.id} value={x.id}>{x.first_name} {x.last_name}</option>
                      ))}
                    </select>
                    <select value={addRole} onChange={(e) => setAddRole(e.target.value)}>
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                    </select>
                    <button className="btn btn-sm btn-primary" type="submit" disabled={!addId}>Add</button>
                  </form>
                )}
                <div className="btn-row" style={{ marginTop: 10 }}>
                  {!detail.my_role && (
                    <button className="btn btn-sm btn-primary" onClick={joinGroup}>Join group</button>
                  )}
                  {detail.my_role && (
                    <button className="btn btn-sm" onClick={leaveGroup}>Leave</button>
                  )}
                  {(detail.my_role === 'owner') && (
                    <button className="btn btn-sm btn-danger" onClick={deleteGroup}>Delete group</button>
                  )}
                  <button className="btn btn-sm" onClick={() => { loadDetail(groupId); loadGroupMessages(groupId); }}>Refresh</button>
                </div>

                {detail.my_role ? (
                  <div className="section-gap">
                    <div className="chat-box">
                      {groupMessages === null ? (
                        <p className="loading">Loading messages</p>
                      ) : (
                        <MessageList messages={groupMessages} meId={meId} />
                      )}
                      <form onSubmit={sendGroup} className="chat-input">
                        <input
                          placeholder={`Message #${detail.name}…`}
                          value={groupDraft}
                          onChange={(e) => setGroupDraft(e.target.value)}
                          style={{ flex: 1 }}
                        />
                        <button className="btn btn-primary btn-sm" type="submit">Send</button>
                      </form>
                    </div>
                  </div>
                ) : (
                  <p className="muted section-gap">Join this group to read and post.</p>
                )}
              </Card>
            )}
          </div>
        </div>
      )}

      {tab === 'direct' && (
        <div className="chat-grid">
          <div className="chat-side">
            <form onSubmit={startDm}>
              <div className="field">
                <span>Message anyone 1-1</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <select value={peerId} onChange={(e) => setPeerId(e.target.value)} style={{ flex: 1 }}>
                    <option value="">Pick a person…</option>
                    {others.map((x) => (
                      <option key={x.id} value={x.id}>{x.first_name} {x.last_name}</option>
                    ))}
                  </select>
                  <button className="btn btn-sm btn-primary" type="submit" disabled={!peerId}>Chat</button>
                </div>
              </div>
            </form>
            <h4 className="section-gap">My DMs</h4>
            {dms.length === 0 ? (
              <Empty>No 1-1 chats yet.</Empty>
            ) : (
              <ul className="rows">
                {dms.map((c) => (
                  <li key={c.id} style={Number(dmId) === Number(c.id) ? { background: 'var(--brand-soft)', borderRadius: 8 } : undefined}>
                    <div className="grow">
                      <button className="link-btn" onClick={() => setDmId(Number(c.id))}>{dmLabel(c)}</button>
                      {c.last_message && (
                        <div><small className="muted">{String(c.last_message.body).slice(0, 60)}</small></div>
                      )}
                    </div>
                    <Unread n={unreadByConv[Number(c.id)]} />
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="chat-main">
            {!dmId ? (
              <Card title="Direct messages"><Empty>Pick a conversation — or start one with anyone in the company.</Empty></Card>
            ) : (
              <div className="chat-box">
                {dmMessages === null ? (
                  <p className="loading">Loading messages</p>
                ) : (
                  <MessageList messages={dmMessages} meId={meId} />
                )}
                <form onSubmit={sendDm} className="chat-input">
                  <input
                    placeholder="Write a message…"
                    value={dmDraft}
                    onChange={(e) => setDmDraft(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button className="btn btn-primary btn-sm" type="submit">Send</button>
                </form>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
